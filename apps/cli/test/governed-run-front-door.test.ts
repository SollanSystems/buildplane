import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import {
	canonicalDispatchEnvelopeV3Digest,
	canonicalGovernedUnitPacketV1Digest,
} from "@buildplane/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	HostOwnedCandidateRunResultV1,
	HostOwnedCandidateRunResultV2,
	HostOwnedCandidateSessionOpenInputV1,
	HostOwnedGovernedBrokerV1,
	HostOwnedRecoverySessionOpenInputV1,
} from "../src/governed-authority-broker-host.js";
import type { RunCliDependencies } from "../src/run-cli.js";

const hostResolver = vi.hoisted(() => ({
	resolve: vi.fn(),
}));

vi.mock("../src/governed-authority-broker-host.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/governed-authority-broker-host.js")
	>("../src/governed-authority-broker-host.js");
	return {
		...actual,
		resolveHostOwnedGovernedBroker: hostResolver.resolve,
	};
});

const { runCli } = await import("../src/run-cli.js");

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
	});
}

function createGitProject(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-governed-front-door-"));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "tracked.txt"]);
	git(root, ["commit", "-m", "baseline"]);
	const stateDirectory = join(root, ".buildplane");
	mkdirSync(stateDirectory, { recursive: true });
	writeFileSync(join(stateDirectory, "project.json"), "{}\n");
	writeFileSync(join(stateDirectory, "state.db"), "");
	return root;
}

function createGovernedPacket(unitId: string): Record<string, unknown> {
	const capabilityBundle = {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: `front-door-${unitId}`,
		fsRead: ["**"],
		fsWrite: ["tmp/**"],
		tools: { run_command: { allowlist: ["node"] } },
	};
	return {
		unit: {
			id: unitId,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["tmp/out.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: { command: "node", args: ["-e", "process.exit(0)"] },
		verification: { requiredOutputs: ["tmp/out.txt"] },
		execution_role: "implementer",
		provenance_ref: `ledger://admission/${unitId}`,
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
		acceptance_contract: {
			schemaVersion: 1,
			contract_version: "v0",
			diff_scope: { allowed_globs: ["tmp/**"] },
			checks: [{ command: "node --version" }],
		},
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "front-door-test",
			scope: `unit:${unitId}`,
		},
	};
}

function writePacket(root: string, packet: Record<string, unknown>): string {
	const packetPath = join(root, "governed-packet.json");
	writeFileSync(packetPath, JSON.stringify(packet), "utf8");
	return packetPath;
}

function createPreauthorizedEnvelope(
	root: string,
	packet: Record<string, unknown>,
	overrides: {
		readonly unitId?: string;
		readonly provenanceRef?: string;
		readonly executionRole?: string;
		readonly baseCommitSha?: string;
		readonly issuedAt?: string;
		readonly expiresAt?: string;
		readonly governedPacketDigest?: string;
	} = {},
): Record<string, unknown> {
	const unitId =
		overrides.unitId ??
		String(packet.unit && (packet.unit as { id: string }).id);
	const provenanceRef =
		overrides.provenanceRef ?? String(packet.provenance_ref);
	const body = {
		workflowId: `workflow-${unitId}`,
		workflowRevision: "r1",
		unitId,
		attempt: 1,
		executionRole: overrides.executionRole ?? String(packet.execution_role),
		commitMode: "atomic",
		provenanceRef,
		baseCommitSha:
			overrides.baseCommitSha ?? git(root, ["rev-parse", "HEAD"]).trim(),
		capabilityBundleDigest: String(packet.capability_bundle_digest),
		acceptanceContractDigest: digest("a"),
		contextManifestDigest: digest("b"),
		workerManifestDigest: digest("c"),
		sandboxProfileDigest: digest("d"),
		budget: { maxTokens: 10_000, maxComputeTimeMs: 60_000 },
		trustTier: "governed",
		idempotencyKey: `dispatch:${unitId}:1`,
		issuedAt: overrides.issuedAt ?? "2026-07-20T12:00:00Z",
		expiresAt: overrides.expiresAt ?? "2099-07-20T12:15:00Z",
	} as const;
	const governedPacketDigest =
		overrides.governedPacketDigest ??
		canonicalGovernedUnitPacketV1Digest(packet);
	const envelope = {
		schemaVersion: 3,
		body,
		actionEvidenceVersion: "sealed_v3" as const,
		repositoryBindingDigest: digest("e"),
		ledgerAuthorityRealmDigest: digest("f"),
		governedPacketDigest,
	};
	return {
		...envelope,
		envelopeDigest: canonicalDispatchEnvelopeV3Digest(envelope),
	};
}

function writeEnvelope(
	root: string,
	envelope: Record<string, unknown>,
): string {
	const envelopePath = join(root, "governed-envelope.json");
	writeFileSync(envelopePath, JSON.stringify(envelope), "utf8");
	return envelopePath;
}

async function runCliCapture(
	root: string,
	argv: readonly string[],
	dependencies?: RunCliDependencies,
): Promise<{
	readonly exitCode: number;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
}> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli([...argv], {
		cwd: root,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		...(dependencies === undefined ? {} : { dependencies }),
	});
	return { exitCode, stdout, stderr };
}

function legacyBundleMustNotBeConstructed(): RunCliDependencies {
	return {
		createOrchestrator: () => {
			throw new Error("legacy orchestrator must not be constructed");
		},
	};
}

function snapshotRoot(root: string): {
	readonly head: string;
	readonly status: string;
	readonly refs: string;
} {
	return {
		head: git(root, ["rev-parse", "HEAD"]).trim(),
		status: git(root, ["status", "--porcelain"]),
		refs: git(root, ["show-ref", "--head"]),
	};
}

function expectRootUnchanged(
	root: string,
	before: ReturnType<typeof snapshotRoot>,
): void {
	expect(snapshotRoot(root)).toEqual(before);
}

function digest(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

function createHostCandidateRunResult(
	root: string,
	unitId: string,
	recoveryRef: string,
	overrides: Record<string, unknown> = {},
	candidateEnvelopeDigest = digest("f"),
	governedPacketDigest = canonicalGovernedUnitPacketV1Digest(
		createGovernedPacket(unitId),
	),
): HostOwnedCandidateRunResultV2 {
	const head = git(root, ["rev-parse", "HEAD"]).trim();
	const targetRef = git(root, ["symbolic-ref", "--quiet", "HEAD"]).trim();
	return {
		kind: "host-owned-governed-candidate-run-result-v1",
		recoveryRef,
		candidateReceipt: {
			schemaVersion: 2,
			recoveryRef,
			targetRef,
			candidate: {
				runId: "01900000-0000-7000-8000-000000000001",
				candidateId: `candidate-${unitId}`,
				candidateRef: `refs/buildplane/candidates/candidate-${unitId}/run-host/1`,
				workflowId: `workflow-${unitId}`,
				unitId,
				attempt: 1,
				provenanceRef: `ledger://admission/${unitId}`,
				candidateDigest: digest("a"),
				baseCommitSha: head,
				candidateCommitSha: "b".repeat(40),
				commitDigest: digest("b"),
				treeDigest: digest("c"),
				patchDigest: digest("d"),
				changedFilesDigest: digest("e"),
				envelopeDigest: candidateEnvelopeDigest,
				actionReceiptSetRef: `receipt-set:${unitId}`,
				actionReceiptSetDigest: digest("1"),
			},
			candidateCreatedEventRef: "01900000-0000-7000-8000-000000000002",
			candidateCompletionEventRef: "01900000-0000-7000-8000-000000000003",
			candidateCompletionDigest: digest("4"),
			tapeRootDigest: digest("2"),
			nativeReceiptRef: `native-receipt/${unitId}`,
			nativeReceiptDigest: digest("3"),
			governedPacketDigest,
		},
		...overrides,
	} as HostOwnedCandidateRunResultV2;
}

afterEach(() => {
	hostResolver.resolve.mockReset();
	vi.restoreAllMocks();
});

describe("governed run front door", () => {
	it("renders the fail-closed preview without constructing the legacy worker router", async () => {
		const root = createGitProject();
		const packetPath = writePacket(root, createGovernedPacket("no-host"));
		const before = snapshotRoot(root);

		hostResolver.resolve.mockResolvedValue(undefined);
		const result = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			executionStarted: false,
		});
		expectRootUnchanged(root, before);
	});

	it("fails closed before passing the target checkout to a legacy host candidate session", async () => {
		const root = createGitProject();
		const packetPath = writePacket(root, createGovernedPacket("host-success"));
		const packetSource = readFileSync(packetPath, "utf8");
		const before = snapshotRoot(root);
		const received: HostOwnedCandidateSessionOpenInputV1[] = [];
		const recoveryRef = "host-recovery/host-success";
		const run = vi
			.fn()
			.mockResolvedValue(
				createHostCandidateRunResult(root, "host-success", recoveryRef),
			);
		const broker = {
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async (
				input: HostOwnedCandidateSessionOpenInputV1,
			) => {
				received.push(input);
				return {
					kind: "host-owned-governed-candidate-session-v1",
					recoveryRef,
					run,
				};
			},
		} as unknown as HostOwnedGovernedBrokerV1;
		hostResolver.resolve.mockResolvedValue(broker);

		const result = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toEqual([]);
		expect(packetSource).toContain("host-success");
		expect(received).toEqual([]);
		expect(run).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: {
				action: "contact-host",
				retry: "blocked",
			},
		});
		expectRootUnchanged(root, before);
	});

	it("requires a fresh host receipt to bind the exact governed packet digest", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-packet-binding");
		const packetPath = writePacket(root, packet);
		const before = snapshotRoot(root);
		const recoveryRef = "host-recovery/host-packet-binding";
		const valid = createHostCandidateRunResult(
			root,
			"host-packet-binding",
			recoveryRef,
		);
		const result = {
			...valid,
			candidateReceipt: {
				...valid.candidateReceipt,
				schemaVersion: 2,
				governedPacketDigest: digest("0"),
			},
		} as unknown as HostOwnedCandidateRunResultV1;
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async () => ({
				kind: "host-owned-governed-candidate-session-v1",
				recoveryRef,
				run: async () => result,
			}),
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
			recovery: {
				retry: "blocked",
			},
		});
		expectRootUnchanged(root, before);
	});

	it("rejects an extensible generic host candidate-session wrapper before it can run", async () => {
		const root = createGitProject();
		const packetPath = writePacket(root, createGovernedPacket("host-extra"));
		const before = snapshotRoot(root);
		const run = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async () => ({
				kind: "host-owned-governed-candidate-session-v1",
				recoveryRef: "host-recovery/host-extra",
				run,
				extra: "must-not-cross-host-boundary",
			}),
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(run).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
		});
		expectRootUnchanged(root, before);
	});

	it("fails closed before passing a preauthorized target checkout to a legacy host session", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-preauthorized");
		const packetPath = writePacket(root, packet);
		const envelope = createPreauthorizedEnvelope(root, packet);
		const envelopePath = writeEnvelope(root, envelope);
		const packetSource = readFileSync(packetPath, "utf8");
		const envelopeSource = readFileSync(envelopePath, "utf8");
		const before = snapshotRoot(root);
		const received: HostOwnedCandidateSessionOpenInputV1[] = [];
		const recoveryRef = "host-recovery/host-preauthorized";
		const broker = {
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async (
				input: HostOwnedCandidateSessionOpenInputV1,
			) => {
				received.push(input);
				return {
					kind: "host-owned-governed-candidate-session-v1",
					recoveryRef,
					run: async () =>
						createHostCandidateRunResult(
							root,
							"host-preauthorized",
							recoveryRef,
							{},
							String(envelope.envelopeDigest),
						),
				};
			},
		} as unknown as HostOwnedGovernedBrokerV1;
		hostResolver.resolve.mockResolvedValue(broker);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(packetSource).toContain("host-preauthorized");
		expect(envelopeSource).toContain("governedPacketDigest");
		expect(received).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
		});
		expectRootUnchanged(root, before);
	});

	it("does not report success for a preauthorized candidate receipt bound to another envelope", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-preauthorized-envelope-mismatch");
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createPreauthorizedEnvelope(root, packet),
		);
		const before = snapshotRoot(root);
		const recoveryRef = "host-recovery/host-preauthorized-envelope-mismatch";
		const run = vi
			.fn()
			.mockResolvedValue(
				createHostCandidateRunResult(
					root,
					"host-preauthorized-envelope-mismatch",
					recoveryRef,
				),
			);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async () => ({
				kind: "host-owned-governed-candidate-session-v1",
				recoveryRef,
				run,
			}),
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
		});
		expect(run).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("rejects a non-implementer preauthorized envelope before host resolution", async () => {
		const root = createGitProject();
		const packet = {
			...createGovernedPacket("host-preauthorized-reviewer"),
			execution_role: "reviewer",
		};
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createPreauthorizedEnvelope(root, packet, {
				executionRole: "reviewer",
			}),
		);
		const openCandidateSession = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);
		const before = snapshotRoot(root);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			blockers: expect.arrayContaining([
				expect.stringContaining("implementer dispatch envelope"),
			]),
		});
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(openCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("blocks preauthorized envelope failures before resolving a host or opening any candidate session", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-preauthorization-rejected");
		const packetPath = writePacket(root, packet);
		const openCandidateSession = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const invalidDigest = createPreauthorizedEnvelope(root, packet, {
			governedPacketDigest: digest("0"),
		});
		const expired = createPreauthorizedEnvelope(root, packet, {
			issuedAt: "2019-07-20T12:00:00Z",
			expiresAt: "2020-07-20T12:15:00Z",
		});
		const mismatched = createPreauthorizedEnvelope(root, packet, {
			unitId: "different-unit",
		});
		const cases: readonly {
			readonly name: string;
			readonly path: string;
			readonly envelope: Record<string, unknown> | "{malformed";
		}[] = [
			{
				name: "malformed",
				path: join(root, "invalid-malformed.json"),
				envelope: "{malformed",
			},
			{
				name: "packet-digest mismatch",
				path: join(root, "invalid-packet-digest-mismatch.json"),
				envelope: invalidDigest,
			},
			{
				name: "expired",
				path: join(root, "invalid-expired.json"),
				envelope: expired,
			},
			{
				name: "packet-identity mismatch",
				path: join(root, "invalid-packet-identity-mismatch.json"),
				envelope: mismatched,
			},
		];

		for (const testCase of cases) {
			writeFileSync(
				testCase.path,
				typeof testCase.envelope === "string"
					? testCase.envelope
					: JSON.stringify(testCase.envelope),
				"utf8",
			);
		}
		const before = snapshotRoot(root);

		for (const testCase of cases) {
			const result = await runCliCapture(
				root,
				["run", "--packet", packetPath, "--envelope", testCase.path, "--json"],
				legacyBundleMustNotBeConstructed(),
			);
			expect(result.exitCode, testCase.name).not.toBe(0);
		}

		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(openCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it.each([
		[
			"an unknown top-level packet field",
			(packet: Record<string, unknown>) => ({ ...packet, injected: true }),
		],
		[
			"an unknown nested acceptance-contract field",
			(packet: Record<string, unknown>) => ({
				...packet,
				acceptance_contract: {
					...(packet.acceptance_contract as Record<string, unknown>),
					injected: true,
				},
			}),
		],
		[
			"an omitted explicit execution role",
			(packet: Record<string, unknown>) => {
				const { execution_role: _executionRole, ...withoutRole } = packet;
				return withoutRole;
			},
		],
		[
			"a raw trust scope",
			(packet: Record<string, unknown>) => ({
				...packet,
				trust_scope: {
					...(packet.trust_scope as Record<string, unknown>),
					lane: "raw",
				},
			}),
		],
	] as const)("blocks a preauthorized packet with %s before host resolution or session opening", async (_label, mutatePacket) => {
		const root = createGitProject();
		const packet = mutatePacket(createGovernedPacket("strict-source"));
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createPreauthorizedEnvelope(root, packet, {
				executionRole: "implementer",
			}),
		);
		const openCandidateSession = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);
		const before = snapshotRoot(root);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			blockers: expect.arrayContaining([
				"Governed packet source must pass strict admission before authority resolution.",
			]),
		});
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(openCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it.each([
		[
			"an unknown top-level packet field",
			(packet: Record<string, unknown>) => ({ ...packet, injected: true }),
		],
		[
			"an unknown nested acceptance-contract field",
			(packet: Record<string, unknown>) => ({
				...packet,
				acceptance_contract: {
					...(packet.acceptance_contract as Record<string, unknown>),
					injected: true,
				},
			}),
		],
		[
			"an omitted explicit execution role",
			(packet: Record<string, unknown>) => {
				const { execution_role: _executionRole, ...withoutRole } = packet;
				return withoutRole;
			},
		],
		[
			"a raw trust scope",
			(packet: Record<string, unknown>) => ({
				...packet,
				trust_scope: {
					...(packet.trust_scope as Record<string, unknown>),
					lane: "raw",
				},
			}),
		],
	] as const)("blocks an operator-approved packet with %s before host resolution or session opening", async (_label, mutatePacket) => {
		const root = createGitProject();
		const packet = mutatePacket(createGovernedPacket("strict-operator-source"));
		const packetPath = writePacket(root, packet);
		const openCandidateSession = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);
		const before = snapshotRoot(root);

		const result = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			blockers: expect.arrayContaining([
				"Governed packet source must pass strict admission before authority resolution.",
			]),
		});
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(openCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("keeps a valid preauthorized envelope blocked when the privileged host is unavailable", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-preauthorization-no-broker");
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createPreauthorizedEnvelope(root, packet),
		);
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue(undefined);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			executionStarted: false,
		});
		expectRootUnchanged(root, before);
	});

	it("requires host recovery for malformed sessions and failed candidate runs without falling through to raw execution", async () => {
		const root = createGitProject();
		const packetPath = writePacket(root, createGovernedPacket("host-blocked"));
		const before = snapshotRoot(root);
		const recoveryRef = "host-recovery/host-blocked";
		const openCandidateSession = vi
			.fn()
			.mockResolvedValueOnce({ kind: "wrong-session" })
			.mockResolvedValueOnce({
				kind: "host-owned-governed-candidate-session-v1",
				recoveryRef,
				run: async () => {
					throw new Error("simulated host candidate failure");
				},
			});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const malformed = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);
		expect(malformed.exitCode).toBe(2);
		expect(malformed.stderr).toEqual([]);
		expect(JSON.parse(malformed.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: {
				action: "contact-host",
				retry: "blocked",
			},
		});

		const failed = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);
		expect(failed.exitCode).toBe(2);
		expect(failed.stderr).toEqual([]);
		expect(JSON.parse(failed.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: {
				action: "contact-host",
				retry: "blocked",
			},
		});
		expectRootUnchanged(root, before);
		expect(existsSync(packetPath)).toBe(true);
		expect(openCandidateSession).not.toHaveBeenCalled();
	});

	it("requires a candidate receipt bound to the durable recovery identity and immutable root", async () => {
		const root = createGitProject();
		const packetPath = writePacket(root, createGovernedPacket("host-receipt"));
		const before = snapshotRoot(root);
		const recoveryRef = "host-recovery/host-receipt";
		const result = createHostCandidateRunResult(
			root,
			"host-receipt",
			recoveryRef,
			{
				candidateReceipt: {
					...createHostCandidateRunResult(root, "host-receipt", recoveryRef)
						.candidateReceipt,
					recoveryRef: "host-recovery/mismatched",
				},
			},
		);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async () => ({
				kind: "host-owned-governed-candidate-session-v1",
				recoveryRef,
				run: async () => result,
			}),
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			status: "recovery-required",
			recovery: { retry: "blocked" },
		});
		expectRootUnchanged(root, before);
	});

	it("does not open a legacy candidate session whose run could mutate the target", async () => {
		const root = createGitProject();
		const packetPath = writePacket(
			root,
			createGovernedPacket("host-root-mutation"),
		);
		const before = snapshotRoot(root);
		const recoveryRef = "host-recovery/host-root-mutation";
		const result = createHostCandidateRunResult(
			root,
			"host-root-mutation",
			recoveryRef,
		);
		const run = vi.fn(async () => {
			writeFileSync(join(root, "tracked.txt"), "mutated by invalid host\n");
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid host target mutation"]);
			return result;
		});
		const openCandidateSession = vi.fn(async () => ({
			kind: "host-owned-governed-candidate-session-v1",
			recoveryRef,
			run,
		}));
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			status: "recovery-required",
			recovery: { retry: "blocked" },
		});
		expect(openCandidateSession).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("does not open a legacy host session that could mutate the target before failing", async () => {
		const root = createGitProject();
		const packetPath = writePacket(
			root,
			createGovernedPacket("host-open-failure-root-mutation"),
		);
		const before = snapshotRoot(root);
		const openCandidateSession = vi.fn(async () => {
			writeFileSync(join(root, "tracked.txt"), "mutated before host failure\n");
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid host failure mutation"]);
			throw new Error("host failed after an invalid target mutation");
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			["run", "--approve", "--packet", packetPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: {
				action: "contact-host",
				retry: "blocked",
			},
		});
		expect(openCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("does not open a legacy PlanForge candidate session that could mutate the target", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const openPlanForgeCandidateSession = vi.fn(async () => {
			writeFileSync(
				join(root, "tracked.txt"),
				"mutated by invalid PlanForge host\n",
			);
			git(root, ["add", "tracked.txt"]);
			git(root, ["commit", "-m", "invalid PlanForge host target mutation"]);
			return {
				kind: "host-owned-planforge-candidate-session-v1",
				schemaVersion: 1,
				recoveryRef: "host-recovery/planforge-target-mutation",
				run: async () => {
					throw new Error("unreachable legacy PlanForge candidate run");
				},
			};
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openPlanForgeCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			[
				"planforge",
				"dispatch",
				"--admission-ref",
				"host-admission/plan-123",
				"--task-ref",
				"host-task/one",
				"--json",
			],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			governance: "governed",
			status: "recovery-required",
			promotion: { state: "not-authorized" },
		});
		expect(openPlanForgeCandidateSession).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("does not pass a recovered target checkout to a legacy host session", async () => {
		const root = createGitProject();
		const recoveryRef = "host-recovery/host-resume";
		const v2Result = createHostCandidateRunResult(
			root,
			"host-resume",
			recoveryRef,
		);
		const { governedPacketDigest: _governedPacketDigest, ...v1Receipt } =
			v2Result.candidateReceipt;
		const v1RecoveryResult = {
			...v2Result,
			candidateReceipt: { ...v1Receipt, schemaVersion: 1 },
		} as unknown as HostOwnedCandidateRunResultV1;
		const received: HostOwnedRecoverySessionOpenInputV1[] = [];
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession: async () => {
				throw new Error("resume must not open a fresh candidate session");
			},
			openRecoverySession: async (
				input: HostOwnedRecoverySessionOpenInputV1,
			) => {
				received.push(input);
				return {
					kind: "host-owned-governed-candidate-session-v1",
					recoveryRef,
					run: async () => v1RecoveryResult,
				};
			},
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			["run", "--resume", recoveryRef, "--approve", "--json"],
			{
				...legacyBundleMustNotBeConstructed(),
				parsePacket: () => {
					throw new Error(
						"resume must not parse caller-provided packet source",
					);
				},
			},
		);

		expect(response.exitCode).toBe(2);
		expect(received).toEqual([]);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			status: "recovery-required",
			promotion: { state: "not-authorized" },
		});
	});

	it("keeps a host-only resume blocked when the privileged broker is unavailable", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue(undefined);

		const response = await runCliCapture(
			root,
			["run", "--resume", "host-recovery/unavailable", "--approve", "--json"],
			{
				...legacyBundleMustNotBeConstructed(),
				parsePacket: () => {
					throw new Error(
						"resume must not parse caller-provided packet source",
					);
				},
			},
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			promotion: { state: "not-authorized" },
			recovery: { action: "contact-host", retry: "blocked" },
		});
		expectRootUnchanged(root, before);
	});

	it("rejects resume combinations that could replace recovered authority before a host or legacy router is touched", async () => {
		const root = createGitProject();
		const packetPath = writePacket(
			root,
			createGovernedPacket("host-resume-reject"),
		);
		const recoveryRef = "host-recovery/host-resume-reject";
		const host = vi.fn();
		hostResolver.resolve.mockImplementation(host);

		for (const args of [
			["run", "--resume", recoveryRef],
			["run", "--resume", "host-recovery/../replacement", "--approve"],
			["run", "--resume", recoveryRef, "--approve", "--packet", packetPath],
			[
				"run",
				"--resume",
				recoveryRef,
				"--approve",
				"--envelope",
				"proposal.json",
			],
			["run", "--resume", recoveryRef, "--approve", "--raw"],
		]) {
			const result = await runCliCapture(
				root,
				args,
				legacyBundleMustNotBeConstructed(),
			);
			expect(result.exitCode).toBe(1);
		}
		expect(host).not.toHaveBeenCalled();
	});
});
