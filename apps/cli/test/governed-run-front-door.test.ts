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
import type {
	DispatchEnvelopeV4,
	DispatchEnvelopeV5,
} from "@buildplane/kernel";
import {
	canonicalDispatchEnvelopeV3Digest,
	canonicalDispatchEnvelopeV4Digest,
	canonicalDispatchEnvelopeV5Digest,
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
		readonly maxComputeTimeMs?: number;
		readonly governedPacketDigest?: string;
	} = {},
): Record<string, unknown> {
	const now = Date.now();
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
		budget: {
			maxTokens: 10_000,
			maxComputeTimeMs: overrides.maxComputeTimeMs ?? 60_000,
		},
		trustTier: "governed",
		idempotencyKey: `dispatch:${unitId}:1`,
		issuedAt: overrides.issuedAt ?? new Date(now - 1_000).toISOString(),
		expiresAt: overrides.expiresAt ?? new Date(now + 15 * 60_000).toISOString(),
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

function createNativeV5Envelope(
	root: string,
	packet: Record<string, unknown>,
): Record<string, unknown> {
	const dispatchV3 = createPreauthorizedEnvelope(
		root,
		packet,
	) as unknown as DispatchEnvelopeV4["dispatchV3"];
	const dispatchV4Draft: Omit<DispatchEnvelopeV4, "envelopeDigest"> = {
		schemaVersion: 4,
		dispatchV3,
		workflowGraphDigest: digest("0"),
		workflowGraphDeclarationEventRef: "01919000-0000-7000-8000-000000000070",
	};
	const dispatchV4: DispatchEnvelopeV4 = {
		...dispatchV4Draft,
		envelopeDigest: canonicalDispatchEnvelopeV4Digest(dispatchV4Draft),
	};
	const dispatchV5Draft: Omit<DispatchEnvelopeV5, "envelopeDigest"> = {
		dispatchV4,
		contextManifestDeclarationEventRef: "01919000-0000-7000-8000-000000000071",
		contextManifestDigest: dispatchV3.body.contextManifestDigest,
		workerManifestDeclarationEventRef: "01919000-0000-7000-8000-000000000072",
		workerManifestDigest: dispatchV3.body.workerManifestDigest,
		sandboxProfileDeclarationEventRef: "01919000-0000-7000-8000-000000000073",
		sandboxProfileDigest: dispatchV3.body.sandboxProfileDigest,
	};
	const dispatchV5: DispatchEnvelopeV5 = {
		...dispatchV5Draft,
		envelopeDigest: canonicalDispatchEnvelopeV5Digest(dispatchV5Draft),
	};
	const body = dispatchV5.dispatchV4.dispatchV3.body;
	const dispatchV3Native = {
		body: {
			workflow_id: body.workflowId,
			workflow_revision: body.workflowRevision,
			unit_id: body.unitId,
			attempt: body.attempt,
			execution_role: body.executionRole,
			commit_mode: body.commitMode,
			provenance_ref: body.provenanceRef,
			base_commit_sha: body.baseCommitSha,
			capability_bundle_digest: body.capabilityBundleDigest,
			acceptance_contract_digest: body.acceptanceContractDigest,
			context_manifest_digest: body.contextManifestDigest,
			worker_manifest_digest: body.workerManifestDigest,
			sandbox_profile_digest: body.sandboxProfileDigest,
			budget: {
				max_tokens: body.budget.maxTokens,
				max_compute_time_ms: body.budget.maxComputeTimeMs,
			},
			trust_tier: body.trustTier,
			idempotency_key: body.idempotencyKey,
			issued_at: body.issuedAt,
			expires_at: body.expiresAt,
		},
		action_evidence_version:
			dispatchV5.dispatchV4.dispatchV3.actionEvidenceVersion,
		repository_binding_digest:
			dispatchV5.dispatchV4.dispatchV3.repositoryBindingDigest,
		ledger_authority_realm_digest:
			dispatchV5.dispatchV4.dispatchV3.ledgerAuthorityRealmDigest,
		...(dispatchV5.dispatchV4.dispatchV3.governedPacketDigest === undefined
			? {}
			: {
					governed_packet_digest:
						dispatchV5.dispatchV4.dispatchV3.governedPacketDigest,
				}),
		envelope_digest: dispatchV5.dispatchV4.dispatchV3.envelopeDigest,
	};
	return {
		DispatchEnvelopeV5: {
			dispatch_v4: {
				dispatch_v3: dispatchV3Native,
				workflow_graph_digest: dispatchV5.dispatchV4.workflowGraphDigest,
				workflow_graph_declaration_event_ref:
					dispatchV5.dispatchV4.workflowGraphDeclarationEventRef,
				envelope_digest: dispatchV5.dispatchV4.envelopeDigest,
			},
			context_manifest_declaration_event_ref:
				dispatchV5.contextManifestDeclarationEventRef,
			context_manifest_digest: dispatchV5.contextManifestDigest,
			worker_manifest_declaration_event_ref:
				dispatchV5.workerManifestDeclarationEventRef,
			worker_manifest_digest: dispatchV5.workerManifestDigest,
			sandbox_profile_declaration_event_ref:
				dispatchV5.sandboxProfileDeclarationEventRef,
			sandbox_profile_digest: dispatchV5.sandboxProfileDigest,
			envelope_digest: dispatchV5.envelopeDigest,
		},
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
	readonly tree: string;
	readonly commitCount: string;
	readonly status: string;
	readonly refs: string;
} {
	return {
		head: git(root, ["rev-parse", "HEAD"]).trim(),
		tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
		commitCount: git(root, ["rev-list", "--count", "HEAD"]).trim(),
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

function expectGovernedLedgerAbsent(root: string): void {
	const ledgerDirectory = join(root, ".buildplane", "ledger");
	expect(existsSync(ledgerDirectory)).toBe(false);
	expect(existsSync(join(ledgerDirectory, "events.db"))).toBe(false);
	expect(existsSync(join(ledgerDirectory, "events.db-wal"))).toBe(false);
	expect(existsSync(join(ledgerDirectory, "events.db-shm"))).toBe(false);
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

	it("renders a valid native V5 envelope only as a host-owned structural preview", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("native-v5-preview");
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createNativeV5Envelope(root, packet),
		);
		const before = snapshotRoot(root);
		const stateBefore = readFileSync(
			join(root, ".buildplane", "state.db"),
			"utf8",
		);
		const openCandidateSession = vi.fn();
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openCandidateSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toEqual([]);
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(openCandidateSession).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			executionStarted: false,
			envelope: {
				schemaVersion: 5,
				verification: "structural_only",
				workflowId: "workflow-native-v5-preview",
				unitId: "native-v5-preview",
				manifestDeclarations: {
					context: {
						eventRef: "01919000-0000-7000-8000-000000000071",
						digest: digest("b"),
					},
					worker: {
						eventRef: "01919000-0000-7000-8000-000000000072",
						digest: digest("c"),
					},
					sandboxProfile: {
						eventRef: "01919000-0000-7000-8000-000000000073",
						digest: digest("d"),
					},
				},
			},
			blockers: expect.arrayContaining([
				expect.stringMatching(
					/V5 admission.*tape.*capability.*OCI.*host-owned/i,
				),
			]),
		});
		expectRootUnchanged(root, before);
		expect(readFileSync(join(root, ".buildplane", "state.db"), "utf8")).toBe(
			stateBefore,
		);
		expectGovernedLedgerAbsent(root);
	});

	it("rejects malformed native V5 envelopes before host resolution", async () => {
		const cases: readonly {
			readonly id: string;
			readonly name: string;
			readonly mutate: (
				payload: Record<string, unknown>,
			) => Record<string, unknown>;
		}[] = [
			{
				id: "unknown",
				name: "an unknown V5 field",
				mutate: (payload) => ({ ...payload, injected: true }),
			},
			{
				id: "digest-mismatch",
				name: "a canonical V5 digest mismatch",
				mutate: (payload) => ({ ...payload, envelope_digest: digest("0") }),
			},
			{
				id: "manifest-mismatch",
				name: "a nested manifest binding mismatch",
				mutate: (payload) => ({
					...payload,
					context_manifest_digest: digest("e"),
				}),
			},
			{
				id: "retry-context",
				name: "incomplete retry context",
				mutate: (payload) => ({
					...payload,
					attempt_context_declaration_event_ref:
						"01919000-0000-7000-8000-000000000074",
				}),
			},
		];

		for (const testCase of cases) {
			const root = createGitProject();
			const packet = createGovernedPacket(`native-v5-${testCase.id}`);
			const packetPath = writePacket(root, packet);
			const nativeEnvelope = createNativeV5Envelope(root, packet);
			const payload = nativeEnvelope.DispatchEnvelopeV5 as Record<
				string,
				unknown
			>;
			const envelopePath = writeEnvelope(root, {
				DispatchEnvelopeV5: testCase.mutate(payload),
			});
			const before = snapshotRoot(root);
			const stateBefore = readFileSync(
				join(root, ".buildplane", "state.db"),
				"utf8",
			);
			const openCandidateSession = vi.fn();
			hostResolver.resolve.mockResolvedValue({
				kind: "host-owned-governed-broker-v1",
				openCandidateSession,
			} as unknown as HostOwnedGovernedBrokerV1);

			const result = await runCliCapture(
				root,
				["run", "--packet", packetPath, "--envelope", envelopePath, "--json"],
				legacyBundleMustNotBeConstructed(),
			);

			expect(result.exitCode, testCase.name).toBe(1);
			expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
				error: { code: "CLI_ERROR" },
			});
			expect(hostResolver.resolve, testCase.name).not.toHaveBeenCalled();
			expect(openCandidateSession, testCase.name).not.toHaveBeenCalled();
			expectRootUnchanged(root, before);
			expect(readFileSync(join(root, ".buildplane", "state.db"), "utf8")).toBe(
				stateBefore,
			);
			expectGovernedLedgerAbsent(root);
		}
	});

	it("rejects an unsafe raw request combined with a V5 envelope before any host boundary", async () => {
		const root = createGitProject();
		const packet = createGovernedPacket("native-v5-raw-rejected");
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createNativeV5Envelope(root, packet),
		);
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			[
				"run",
				"--raw",
				"--packet",
				packetPath,
				"--envelope",
				envelopePath,
				"--json",
			],
			{
				...legacyBundleMustNotBeConstructed(),
				parsePacket: () => {
					throw new Error("raw/envelope rejection must not parse a packet");
				},
			},
		);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				code: "CLI_ERROR",
				message: expect.stringMatching(/--raw cannot be combined.*--envelope/i),
			},
		});
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("compiles a governed graph into a blocked declaration preview without contacting a host or legacy worker", async () => {
		const root = createGitProject();
		const graphPath = join(root, "governed-graph.json");
		writeFileSync(
			graphPath,
			JSON.stringify({
				maxConcurrent: 1,
				nodes: [
					createGovernedPacket("graph-preview-implement"),
					{
						...createGovernedPacket("graph-preview-review"),
						execution_role: "reviewer",
						dependsOn: ["graph-preview-implement"],
					},
				],
			}),
			"utf8",
		);
		const before = snapshotRoot(root);
		const stateBefore = readFileSync(
			join(root, ".buildplane", "state.db"),
			"utf8",
		);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			["run", "--approve", "--graph", graphPath, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toEqual([]);
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			status: "blocked",
			executionStarted: false,
			approval: { requested: true, state: "not-recorded" },
			graph: {
				nodeCount: 2,
				maxConcurrent: 1,
				declaration: {
					nodes: [
						{
							unitId: "graph-preview-implement",
							executionRole: "implementer",
						},
						{
							unitId: "graph-preview-review",
							executionRole: "reviewer",
							dependsOn: ["graph-preview-implement"],
						},
					],
				},
			},
		});
		expectRootUnchanged(root, before);
		expect(readFileSync(join(root, ".buildplane", "state.db"), "utf8")).toBe(
			stateBefore,
		);
		expect(existsSync(join(root, ".buildplane", "events.db"))).toBe(false);
	});

	it.each([
		["raw", ["--raw"]],
		["envelope", ["--envelope", "forbidden-envelope.json"]],
		["packet", ["--packet", "forbidden-packet.json"]],
		["tui", ["--tui"]],
		["resume", ["--resume", "host-recovery/graph", "--approve"]],
	] as const)("rejects a governed graph preview combined with %s before any host or worker boundary", async (_label, incompatibleArguments) => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			[
				"run",
				"--graph",
				"nonexistent-governed-graph.json",
				...incompatibleArguments,
				"--json",
			],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(1);
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { code: "CLI_ERROR" },
		});
		expectRootUnchanged(root, before);
	});

	it.each([
		[
			"operator approval before a preauthorized envelope",
			[
				"--approve",
				"--packet",
				"packet-that-must-not-be-read.json",
				"--envelope",
				"envelope-that-must-not-be-read.json",
			],
		],
		[
			"a preauthorized envelope before operator approval",
			[
				"--packet",
				"packet-that-must-not-be-read.json",
				"--envelope",
				"envelope-that-must-not-be-read.json",
				"--approve",
			],
		],
	] as const)("rejects %s before a broker, packet, or legacy worker boundary", async (_label, argumentsAfterRun) => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
		} as unknown as HostOwnedGovernedBrokerV1);

		const result = await runCliCapture(
			root,
			["run", ...argumentsAfterRun, "--json"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				code: "CLI_ERROR",
				message: expect.stringMatching(
					/--approve.*--envelope.*mutually exclusive/i,
				),
			},
		});
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("returns help for a graph/raw request before the legacy bundle can be constructed", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);

		const result = await runCliCapture(
			root,
			["run", "--graph", "nonexistent-governed-graph.json", "--raw", "--help"],
			legacyBundleMustNotBeConstructed(),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain(
			"buildplane run --packet <path> [options]",
		);
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it.each([
		["without an operator approval", []],
		["with an operator approval", ["--approve"]],
	] as const)("builds the governed preview from the source snapshot %s without invoking an injected path parser", async (_label, approvalArguments) => {
		const root = createGitProject();
		const packetPath = writePacket(
			root,
			createGovernedPacket("source-snapshot"),
		);
		const before = snapshotRoot(root);
		const parsePacket = vi.fn(() => {
			throw new Error(
				"governed preview must not re-parse the packet path after snapshotting its source",
			);
		});
		hostResolver.resolve.mockResolvedValue(undefined);

		const result = await runCliCapture(
			root,
			["run", ...approvalArguments, "--packet", packetPath, "--json"],
			{
				...legacyBundleMustNotBeConstructed(),
				parsePacket,
			},
		);

		expect(result.exitCode).toBe(2);
		expect(parsePacket).not.toHaveBeenCalled();
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			governance: "preview",
			packet: {
				unitId: "source-snapshot",
				executionRole: "implementer",
				executionRoleExplicit: true,
			},
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

	it.each([
		[
			"not yet active",
			{
				issuedAt: "2099-07-20T12:00:00Z",
				expiresAt: "2099-07-20T12:15:00Z",
			},
			"not yet active",
		],
		[
			"past its compute deadline",
			{
				issuedAt: "2020-07-20T12:00:00Z",
				expiresAt: "2099-07-20T12:15:00Z",
				maxComputeTimeMs: 60_000,
			},
			"compute deadline",
		],
	] as const)("renders a preview without resolving a host when preauthorized authority is %s", async (_label, overrides, blocker) => {
		const root = createGitProject();
		const packet = createGovernedPacket("host-preauthorization-window");
		const packetPath = writePacket(root, packet);
		const envelopePath = writeEnvelope(
			root,
			createPreauthorizedEnvelope(root, packet, overrides),
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
			executionStarted: false,
			blockers: expect.arrayContaining([expect.stringContaining(blocker)]),
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

	it.each([
		"promote",
		"reject",
	] as const)("keeps the recovered %s decision blocked when no privileged host is installed without changing the target root", async (decision) => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		hostResolver.resolve.mockResolvedValue(undefined);

		const response = await runCliCapture(
			root,
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				decision,
				"--json",
			],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			decision: { requested: decision, state: "blocked" },
			promotion: { state: "not-executed" },
			recovery: { action: "contact-host", retry: "blocked" },
		});
		expectRootUnchanged(root, before);
	});

	it("rejects decision forms that could select a fresh packet, graph, raw lane, alternate input, or malformed decision before host resolution", async () => {
		const root = createGitProject();
		const packetPath = writePacket(
			root,
			createGovernedPacket("promotion-decision-arguments"),
		);
		const before = snapshotRoot(root);
		const host = vi.fn();
		hostResolver.resolve.mockImplementation(host);

		for (const args of [
			["run", "--approve", "--packet", packetPath, "--decision", "promote"],
			[
				"run",
				"--approve",
				"--graph",
				"untrusted-graph.json",
				"--decision",
				"reject",
			],
			["run", "--raw", "--packet", packetPath, "--decision", "promote"],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--decision",
				"promote",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"unexpected",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--decision",
				"reject",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--packet",
				packetPath,
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--graph",
				"untrusted-graph.json",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--envelope",
				"replacement-envelope.json",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--raw",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"promote",
				"--tui",
			],
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
			],
		] as const) {
			const response = await runCliCapture(
				root,
				args,
				legacyBundleMustNotBeConstructed(),
			);
			expect(response.exitCode).toBe(1);
		}

		expect(host).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});

	it("does not invoke legacy recovery or forged promotion-decision callbacks before the native host contract exists", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const run = vi.fn(async () => ({
			kind: "host-owned-governed-promotion-decision-run-result-v1",
			schemaVersion: 1,
			recoveryRef: "host-recovery/promotion-decision",
			decision: "reject",
			promotionDecisionRef: "host-evidence/promotion-decision",
			promotionDecisionDigest: digest("a"),
			tapeRootDigest: digest("b"),
			nativeReceiptRef: "native-receipt/promotion-decision",
			nativeReceiptDigest: digest("c"),
			targetRef: "refs/heads/main",
			promote() {
				throw new Error("forged promotion callable must never execute");
			},
		}));
		const openPromotionDecisionSession = vi.fn(async () => ({
			kind: "host-owned-governed-promotion-decision-session-v1",
			schemaVersion: 1,
			recoveryRef: "host-recovery/promotion-decision",
			run,
			targetRef: "refs/heads/main",
		}));
		const openRecoverySession = vi.fn(async () => {
			throw new Error("legacy recovery callback must never execute");
		});
		hostResolver.resolve.mockResolvedValue({
			kind: "host-owned-governed-broker-v1",
			openRecoverySession,
			openPromotionDecisionSession,
		} as unknown as HostOwnedGovernedBrokerV1);

		const response = await runCliCapture(
			root,
			[
				"run",
				"--resume",
				"host-recovery/promotion-decision",
				"--approve",
				"--decision",
				"reject",
				"--json",
			],
			legacyBundleMustNotBeConstructed(),
		);

		expect(response.exitCode).toBe(2);
		expect(JSON.parse(response.stdout.join("\n"))).toMatchObject({
			status: "recovery-required",
			decision: { requested: "reject", state: "blocked" },
			promotion: { state: "not-executed" },
		});
		expect(openRecoverySession).not.toHaveBeenCalled();
		expect(openPromotionDecisionSession).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(hostResolver.resolve).not.toHaveBeenCalled();
		expectRootUnchanged(root, before);
	});
});
