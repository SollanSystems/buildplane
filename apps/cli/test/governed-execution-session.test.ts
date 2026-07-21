import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PodmanGovernedSandboxProfileV1,
	podmanGovernedSandboxProfileDigest,
} from "@buildplane/adapters-tools";
import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import type {
	CandidateEvidencePort,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedDispatchLineageV3,
	GovernedLedgerAuthorityRealmPort,
	GovernedRepositoryBindingPort,
	RunPacketResult,
	UnitPacket,
} from "@buildplane/kernel";
import { canonicalGovernedUnitPacketV1Digest } from "@buildplane/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPodmanGovernedActionExecutorForTest,
	type PodmanCommandRunner,
} from "../../../packages/adapters-tools/src/podman-governed-executor.js";
import { candidateIdForDispatch } from "../src/governed-candidate-session.js";
import * as governedExecutionAuthority from "../src/governed-execution-authority.js";
import {
	type GovernedExecutionSessionOrchestratorInput,
	runGovernedExecutionSession,
} from "../src/governed-execution-session.js";
import type { ResolvedGovernedDispatchSnapshot } from "../src/ledger-governed-dispatch-resolver.js";
import { governedPolicyDigestForAcceptanceContract } from "../src/ledger-governed-dispatch-resolver.js";
import {
	captureGovernedExecutionAuthorityFixture,
	type GovernedExecutionAuthorityFixtureInput,
} from "./helpers/governed-execution-authority-fixture.js";

const RUN_ID = "00000000-0000-7000-8000-000000000071";
const BASE_SHA = "a".repeat(40);
const IMAGE = `registry.example.test/buildplane/worker@sha256:${"b".repeat(64)}`;
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function projectRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-governed-session-"));
	roots.push(root);
	return root;
}

function profile(): PodmanGovernedSandboxProfileV1 {
	const unsigned = {
		schemaVersion: 1 as const,
		profileId: "podman-rootless-v1" as const,
		cpuCores: 1,
		memoryBytes: 256 * 1024 * 1024,
		pidsLimit: 64,
		tmpfsBytes: 32 * 1024 * 1024,
	};
	return {
		...unsigned,
		profileDigest: podmanGovernedSandboxProfileDigest({
			image: IMAGE,
			...unsigned,
		}),
	};
}

const podmanRunner: PodmanCommandRunner = (_binary, args) => {
	if (args[0] === "--version") {
		return { status: 0, stdout: "podman version 5.0.0", stderr: "" };
	}
	if (args[0] === "info") {
		return {
			status: 0,
			stdout: JSON.stringify({ host: { security: { rootless: true } } }),
			stderr: "",
		};
	}
	if (args[0] === "unshare") {
		return { status: 0, stdout: "", stderr: "" };
	}
	if (args[0] === "run" && args[1] === "--help") {
		return {
			status: 0,
			stdout:
				"--read-only --network --http-proxy --no-hosts --no-hostname --userns --cap-drop --security-opt --entrypoint",
			stderr: "",
		};
	}
	throw new Error(`unexpected Podman invocation: ${args.join(" ")}`);
};

function executor(sandboxProfile = profile()) {
	return createPodmanGovernedActionExecutorForTest(
		{ image: IMAGE, profile: sandboxProfile, runner: podmanRunner },
		{ platform: "linux" },
	);
}

function packet(overrides: Record<string, unknown> = {}): UnitPacket {
	const capabilityBundle = {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "governed-execution-session",
		fsWrite: ["src/**"],
		tools: { run_command: { allowlist: ["node"] } },
	};
	return {
		unit: {
			id: "unit-governed-execution-session",
			kind: "implementation",
			scope: "src",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "node --version",
			policyProfile: "governed",
		},
		execution_role: "implementer",
		execution: { command: "node", args: ["--version"] },
		verification: { requiredOutputs: [] },
		provenance_ref: "plan-admitted:fixture",
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
		acceptance_contract: {
			schemaVersion: 1,
			contract_version: "v0",
			diff_scope: { allowed_globs: ["src/**"] },
			checks: [{ command: "node --version" }],
		},
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "kernel",
			scope: "execution-session",
		},
		...overrides,
	} as UnitPacket;
}

function dispatch(
	source = packet(),
	sandboxProfile = profile(),
	overrides: Partial<GovernedDispatchLineageV3> = {},
): GovernedDispatchLineageV3 {
	const acceptanceContractDigest = DIGEST("c");
	return {
		schemaVersion: 3,
		runId: RUN_ID,
		workflowId: "workflow-governed-execution-session",
		workflowRevision: "1",
		unitId: source.unit.id,
		attempt: 1,
		provenanceRef: source.provenance_ref,
		dispatchEnvelopeRef: "00000000-0000-7000-8000-000000000072",
		envelopeDigest: DIGEST("d"),
		baseCommitSha: BASE_SHA,
		repositoryBindingDigest: DIGEST("e"),
		ledgerAuthorityRealmDigest: DIGEST("f"),
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(source),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: source.capability_bundle_digest ?? "",
		acceptanceContractDigest,
		policyDigest: governedPolicyDigestForAcceptanceContract(
			acceptanceContractDigest,
		),
		contextManifestDigest: DIGEST("1"),
		workerManifestDigest: DIGEST("2"),
		sandboxProfileDigest: sandboxProfile.profileDigest,
		budget: { maxTokens: 100, maxComputeTimeMs: 30_000 },
		idempotencyKey: "dispatch:governed-execution-session",
		authorityActor: "kernel",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2026-07-18T12:00:00Z",
		expiresAt: "2099-07-18T12:00:00Z",
		...overrides,
	};
}

function resolution(
	dispatched: GovernedDispatchLineageV3,
): ResolvedGovernedDispatchSnapshot {
	return {
		dispatch: dispatched,
		recovery: { requests: [], receipts: [], candidates: [] },
		phase: "dispatched",
		lifecycle: { timers: [] },
		pendingActionIds: [],
		unknownActionIds: [],
		failedActionIds: [],
	};
}

function ports(
	overrides: Partial<{
		readonly actionEvidencePort: GovernedActionEvidencePort;
		readonly activityClaimPort: GovernedActivityClaimPort;
		readonly candidateEvidencePort: CandidateEvidencePort;
		readonly repositoryBindingPort: GovernedRepositoryBindingPort;
		readonly ledgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
	}> = {},
): {
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly candidateEvidencePort: CandidateEvidencePort;
	readonly repositoryBindingPort: GovernedRepositoryBindingPort;
	readonly ledgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
} {
	return {
		actionEvidencePort: {
			async recordActionRequested() {
				throw new Error("not invoked by composition test");
			},
			async recordActionReceipt() {
				throw new Error("not invoked by composition test");
			},
			async sealActionReceiptSet() {
				throw new Error("not invoked by composition test");
			},
			async recordCandidateCreatedV2() {
				throw new Error("not invoked by composition test");
			},
		} as GovernedActionEvidencePort,
		activityClaimPort: {
			async claim() {
				throw new Error("not invoked by composition test");
			},
			async recordResult() {
				throw new Error("not invoked by composition test");
			},
		} as GovernedActivityClaimPort,
		candidateEvidencePort: {
			async recordCandidateAcceptance() {
				throw new Error("not invoked by composition test");
			},
			async recordCandidateReview() {
				throw new Error("not invoked by composition test");
			},
		} as CandidateEvidencePort,
		repositoryBindingPort: {
			assertDispatchRepositoryBinding() {},
		},
		ledgerAuthorityRealmPort: {
			assertDispatchLedgerAuthorityRealm() {},
		},
		...overrides,
	};
}

function candidateResult(
	dispatched: GovernedDispatchLineageV3,
): RunPacketResult {
	return {
		run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
		candidate: {
			schemaVersion: 1,
			candidateId: candidateIdForDispatch(dispatched),
			runId: RUN_ID,
			attempt: 1,
			candidateKey: "candidate-key",
			candidateRef: "refs/buildplane/candidates/candidate-key",
			baseSha: BASE_SHA,
			candidateCommitSha: "f".repeat(40),
			commitDigest: DIGEST("3"),
			treeDigest: DIGEST("4"),
			patchDigest: DIGEST("5"),
			changedFilesDigest: DIGEST("6"),
			candidateDigest: DIGEST("7"),
		},
	};
}

async function runWithMockAuthority(
	fixture: GovernedExecutionAuthorityFixtureInput,
): Promise<Awaited<ReturnType<typeof runGovernedExecutionSession>>> {
	const opaqueHandle = Object.freeze({});
	const resolveAuthority = vi
		.spyOn(
			governedExecutionAuthority,
			"resolveHostOwnedGovernedExecutionAuthority",
		)
		.mockResolvedValue(opaqueHandle as never);
	const readAuthority = vi
		.spyOn(
			governedExecutionAuthority,
			"readHostOwnedGovernedExecutionAuthority",
		)
		.mockReturnValue(
			captureGovernedExecutionAuthorityFixture(fixture) as never,
		);
	try {
		return await runGovernedExecutionSession({});
	} finally {
		readAuthority.mockRestore();
		resolveAuthority.mockRestore();
	}
}

describe("governed execution session", () => {
	it("fails closed when no privileged host authority resolver is installed", async () => {
		await expect(runGovernedExecutionSession({})).resolves.toEqual({
			state: "unavailable",
			code: "AUTHORITY_UNAVAILABLE",
			reason:
				"governed execution requires a host-owned verified execution authority.",
		});
	});

	it("rejects a structural authority lookalike before it can compose an orchestrator", async () => {
		const resolveAuthority = vi
			.spyOn(
				governedExecutionAuthority,
				"resolveHostOwnedGovernedExecutionAuthority",
			)
			.mockResolvedValue({
				kind: "host-owned-governed-execution-authority-v1",
			} as never);
		try {
			const result = await runGovernedExecutionSession({} as never);

			expect(result).toEqual({
				state: "unavailable",
				code: "AUTHORITY_UNAVAILABLE",
				reason:
					"governed execution requires a host-owned verified execution authority.",
			});
		} finally {
			resolveAuthority.mockRestore();
		}
	});

	it("composes only governed ports and returns a candidate awaiting review", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		const prerequisitePorts = ports();
		let composed: GovernedExecutionSessionOrchestratorInput | undefined;

		const result = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...prerequisitePorts,
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator(input) {
				composed = input;
				return {
					async runPacketAsync() {
						return candidateResult(dispatched);
					},
				};
			},
		});

		expect(result).toMatchObject({
			state: "candidate-awaiting-review",
			candidate: { candidateDigest: DIGEST("7") },
			run: { id: RUN_ID },
		});
		expect(result).not.toHaveProperty("promotion");
		expect(result).not.toHaveProperty("mergedHeadSha");
		expect(composed?.workspace.governedWorkspaceBoundary).toBe(
			"pinned-governed-git-v1",
		);
		expect(composed?.governedWorkerExecutionPort).toBeDefined();
		expect(composed?.governedActionEvidencePort).not.toBe(
			prerequisitePorts.actionEvidencePort,
		);
		expect(composed?.governedActivityClaimPort).not.toBe(
			prerequisitePorts.activityClaimPort,
		);
		expect(composed?.candidateEvidencePort).not.toBe(
			prerequisitePorts.candidateEvidencePort,
		);
		expect(composed?.governedDispatch).toEqual(dispatched);
		expect(composed?.governedDispatch).not.toBe(dispatched);
		expect(Object.isFrozen(composed?.governedDispatch)).toBe(true);
	});

	it("uses only immutable authority state captured before the session begins", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		const expectedDispatch = structuredClone(dispatched);
		const resolved = resolution(dispatched);
		const rootBeforeAcquisition = projectRoot();
		const rootAfterAcquisition = projectRoot();
		let originalRepositoryChecks = 0;
		let replacementRepositoryChecks = 0;
		let originalFactoryCalls = 0;
		let replacementFactoryCalls = 0;
		let composed: GovernedExecutionSessionOrchestratorInput | undefined;
		const prerequisitePorts = ports({
			repositoryBindingPort: {
				assertDispatchRepositoryBinding() {
					originalRepositoryChecks += 1;
				},
			},
		});
		const fixture: GovernedExecutionAuthorityFixtureInput = {
			packet: source,
			projectRoot: rootBeforeAcquisition,
			dispatch: dispatched,
			resolution: resolved,
			...prerequisitePorts,
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator(input) {
				originalFactoryCalls += 1;
				composed = input;
				return {
					async runPacketAsync() {
						return candidateResult(expectedDispatch);
					},
				};
			},
		};
		const captured = captureGovernedExecutionAuthorityFixture(fixture);
		(source as unknown as Record<string, unknown>).execution = {
			command: "curl",
			args: ["https://example.invalid"],
		};
		(dispatched as unknown as { workflowId: string }).workflowId =
			"mutated-workflow";
		(
			dispatched as unknown as {
				budget: { maxTokens: number; maxComputeTimeMs: number };
			}
		).budget.maxTokens = 1;
		(resolved as unknown as { phase: string }).phase = "recovery";
		(sandboxProfile as unknown as { profileDigest: string }).profileDigest =
			DIGEST("9");
		(
			prerequisitePorts.repositoryBindingPort as unknown as {
				assertDispatchRepositoryBinding: () => void;
			}
		).assertDispatchRepositoryBinding = () => {
			replacementRepositoryChecks += 1;
		};
		(
			fixture as unknown as {
				projectRoot: string;
				createOrchestrator: GovernedExecutionAuthorityFixtureInput["createOrchestrator"];
			}
		).projectRoot = rootAfterAcquisition;
		(
			fixture as unknown as {
				createOrchestrator: GovernedExecutionAuthorityFixtureInput["createOrchestrator"];
			}
		).createOrchestrator = () => {
			replacementFactoryCalls += 1;
			throw new Error("replacement factory must not be used");
		};
		const opaqueHandle = Object.freeze({});
		const resolveAuthority = vi
			.spyOn(
				governedExecutionAuthority,
				"resolveHostOwnedGovernedExecutionAuthority",
			)
			.mockResolvedValue(opaqueHandle as never);
		const readAuthority = vi
			.spyOn(
				governedExecutionAuthority,
				"readHostOwnedGovernedExecutionAuthority",
			)
			.mockReturnValue(captured as never);
		try {
			const result = await runGovernedExecutionSession({});

			expect(result).toMatchObject({
				state: "candidate-awaiting-review",
				run: { id: RUN_ID },
			});
			expect(originalFactoryCalls).toBe(1);
			expect(replacementFactoryCalls).toBe(0);
			expect(originalRepositoryChecks).toBe(2);
			expect(replacementRepositoryChecks).toBe(0);
			expect(composed?.projectRoot).toBe(rootBeforeAcquisition);
			expect(composed?.governedDispatch).toEqual(expectedDispatch);
			expect(Object.isFrozen(composed?.governedDispatch)).toBe(true);
		} finally {
			readAuthority.mockRestore();
			resolveAuthority.mockRestore();
		}
	});

	it("rejects a candidate or run identity that does not bind the sealed dispatch", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		const invalidResults: readonly RunPacketResult[] = [
			{
				...candidateResult(dispatched),
				candidate: {
					...candidateResult(dispatched).candidate!,
					candidateId: "candidate-substituted",
				},
			},
			{
				...candidateResult(dispatched),
				run: {
					...candidateResult(dispatched).run,
					id: "00000000-0000-7000-8000-000000000079",
					unitId: "unit-substituted",
				},
			},
		];

		for (const invalidResult of invalidResults) {
			const result = await runWithMockAuthority({
				packet: source,
				projectRoot: projectRoot(),
				dispatch: dispatched,
				resolution: resolution(dispatched),
				...ports(),
				oci: {
					image: IMAGE,
					profile: sandboxProfile,
					executor: executor(sandboxProfile),
				},
				createOrchestrator() {
					return {
						async runPacketAsync() {
							return invalidResult;
						},
					};
				},
			});
			expect(result).toMatchObject({
				state: "unavailable",
				code: "CANDIDATE_EXECUTION_FAILED",
			});
		}
	});

	it("blocks reversed or malformed dispatch authority windows before composition", async () => {
		const source = packet();
		const sandboxProfile = profile();
		let factoryCalls = 0;
		const createOrchestrator = () => {
			factoryCalls += 1;
			throw new Error("must not compose an orchestrator");
		};

		for (const authorityWindow of [
			{
				issuedAt: "2099-07-18T12:00:00Z",
				expiresAt: "2098-07-18T12:00:00Z",
			},
			{
				issuedAt: "not-a-timestamp",
				expiresAt: "2099-07-18T12:00:00Z",
			},
		]) {
			const dispatched = dispatch(source, sandboxProfile, authorityWindow);
			const result = await runWithMockAuthority({
				packet: source,
				projectRoot: projectRoot(),
				dispatch: dispatched,
				resolution: resolution(dispatched),
				...ports(),
				oci: {
					image: IMAGE,
					profile: sandboxProfile,
					executor: executor(sandboxProfile),
				},
				createOrchestrator,
			});
			expect(result).toMatchObject({
				state: "unavailable",
				code: "DISPATCH_EXPIRED",
			});
		}
		expect(factoryCalls).toBe(0);
	});

	it("returns unavailable before worker, worktree, or raw execution when OCI proof is missing or mismatched", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		let factoryCalls = 0;
		const prerequisitePorts = ports();
		const createOrchestrator = () => {
			factoryCalls += 1;
			throw new Error("must not compose an orchestrator");
		};

		const missing = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...prerequisitePorts,
			oci: undefined,
			createOrchestrator,
		});
		expect(missing).toMatchObject({
			state: "unavailable",
			code: "SANDBOX_UNAVAILABLE",
		});

		const mismatched = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...prerequisitePorts,
			oci: {
				image: IMAGE,
				profile: { ...sandboxProfile, profileDigest: DIGEST("8") },
				executor: executor(sandboxProfile),
			},
			createOrchestrator,
		});
		expect(mismatched).toMatchObject({
			state: "unavailable",
			code: "SANDBOX_PROFILE_MISMATCH",
		});
		expect(factoryCalls).toBe(0);
	});

	it("fails closed before composition when repository or ledger authority rejects the dispatch", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		let factoryCalls = 0;
		let repositoryChecks = 0;
		let realmChecks = 0;
		const createOrchestrator = () => {
			factoryCalls += 1;
			throw new Error("must not compose an orchestrator");
		};

		const repositoryRejected = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...ports({
				repositoryBindingPort: {
					assertDispatchRepositoryBinding() {
						repositoryChecks += 1;
						throw new Error(
							"repository binding rejected credential=super-secret",
						);
					},
				},
			}),
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator,
		});
		expect(repositoryRejected).toEqual({
			state: "unavailable",
			code: "REPOSITORY_BINDING_REJECTED",
			reason: "repository binding rejected the sealed dispatch.",
		});
		expect(JSON.stringify(repositoryRejected)).not.toContain("super-secret");
		expect(repositoryChecks).toBe(1);
		expect(factoryCalls).toBe(0);

		const realmRejected = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...ports({
				ledgerAuthorityRealmPort: {
					assertDispatchLedgerAuthorityRealm() {
						realmChecks += 1;
						throw new Error("ledger realm rejected token=super-secret");
					},
				},
			}),
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator,
		});
		expect(realmRejected).toEqual({
			state: "unavailable",
			code: "LEDGER_AUTHORITY_REJECTED",
			reason: "ledger authority realm rejected the sealed dispatch.",
		});
		expect(JSON.stringify(realmRejected)).not.toContain("super-secret");
		expect(realmChecks).toBe(1);
		expect(factoryCalls).toBe(0);
	});

	it("rejects a serialized authority and ignores caller-supplied legacy authority fields", async () => {
		let legacyPrerequisiteReads = 0;
		let factoryCalls = 0;
		const resolveAuthority = vi
			.spyOn(
				governedExecutionAuthority,
				"resolveHostOwnedGovernedExecutionAuthority",
			)
			.mockResolvedValue(
				JSON.parse(
					JSON.stringify({
						kind: "host-owned-governed-execution-authority-v1",
					}),
				) as never,
			);
		try {
			const result = await runGovernedExecutionSession({
				packet: packet(),
				projectRoot: projectRoot(),
				get prerequisites() {
					legacyPrerequisiteReads += 1;
					throw new Error("legacy prerequisites must not be read");
				},
				createOrchestrator() {
					factoryCalls += 1;
					throw new Error("legacy orchestrator must not be called");
				},
			} as never);

			expect(result).toEqual({
				state: "unavailable",
				code: "AUTHORITY_UNAVAILABLE",
				reason:
					"governed execution requires a host-owned verified execution authority.",
			});
			expect(legacyPrerequisiteReads).toBe(0);
			expect(factoryCalls).toBe(0);
		} finally {
			resolveAuthority.mockRestore();
		}
	});

	it("blocks a model packet before composing a worker or candidate worktree", async () => {
		const original = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(original, sandboxProfile);
		let factoryCalls = 0;

		const result = await runWithMockAuthority({
			packet: packet({
				execution: undefined,
				model: { provider: "openai", model: "gpt-test", prompt: "write code" },
			}),
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...ports(),
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator() {
				factoryCalls += 1;
				throw new Error("must not compose an orchestrator");
			},
		});

		expect(result).toMatchObject({
			state: "unavailable",
			code: "UNSUPPORTED_WORKER",
		});
		expect(factoryCalls).toBe(0);
	});

	it("blocks a dispatched snapshot with an unresolved lifecycle timer", async () => {
		const source = packet();
		const sandboxProfile = profile();
		const dispatched = dispatch(source, sandboxProfile);
		let factoryCalls = 0;

		const result = await runWithMockAuthority({
			packet: source,
			projectRoot: projectRoot(),
			dispatch: dispatched,
			resolution: {
				...resolution(dispatched),
				lifecycle: {
					timers: [
						{
							eventRef: "01919000-0000-7000-8000-000000000081",
							eventDigest: DIGEST("a"),
							timerId: "deadline:active",
							timerKind: "workflow_deadline",
							dueAt: "2099-07-18T12:00:01Z",
							idempotencyKey: "timer:deadline:active",
							scheduledBy: "kernel",
							scheduledAt: "2099-07-18T12:00:00Z",
						},
					],
				},
			},
			...ports(),
			oci: {
				image: IMAGE,
				profile: sandboxProfile,
				executor: executor(sandboxProfile),
			},
			createOrchestrator() {
				factoryCalls += 1;
				throw new Error("must not compose an orchestrator");
			},
		});

		expect(result).toEqual({
			state: "unavailable",
			code: "RECOVERY_REQUIRED",
			reason:
				"the governed workflow has existing action, lifecycle, candidate, or recovery state and must reconcile before a new effect.",
		});
		expect(factoryCalls).toBe(0);
	});
});
