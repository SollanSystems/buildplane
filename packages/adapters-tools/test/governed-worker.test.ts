import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleDigest } from "@buildplane/capability-broker";
import type {
	CandidateGovernanceLineage,
	GovernedActionEvidencePort,
	GovernedDispatchLineageV3,
	UnitPacket,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalGovernedUnitPacketV1Digest,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import type { GovernedActionExecutor } from "../src/action-gateway.js";
import {
	type CreateGovernedCommandWorkerExecutionPortOptions,
	createGovernedCommandWorkerExecutionPort,
	type GovernedActivityClaimPort,
	type GovernedCommandEvidenceStore,
} from "../src/governed-worker.js";
import { createTrustedTestGovernedActionExecutor } from "./helpers/trusted-governed-executor.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;
const DIGEST_E = `sha256:${"e".repeat(64)}`;
const DIGEST_F = `sha256:${"f".repeat(64)}`;
const DIGEST_G = `sha256:${"0".repeat(64)}`;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const governance: CandidateGovernanceLineage = {
	workflowId: "workflow-governed-worker",
	provenanceRef: "event://admission/governed-worker",
	envelopeDigest: DIGEST_A,
	acceptanceContractDigest: DIGEST_B,
	actionReceiptDigest: DIGEST_C,
};

function packet(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit: {
			id: "governed-command",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
		},
		execution_role: "implementer",
		execution: { command: "git", args: ["status"] },
		verification: { requiredOutputs: [] },
		provenance_ref: governance.provenanceRef,
		acceptance_contract: { schemaVersion: 1, check: "exit-0" },
		trust_scope: { schemaVersion: 1, lane: "governed" },
		capability_bundle: {
			schemaVersion: "buildplane.capability_bundle.v0",
			bundleId: "governed-worker-test",
			fsWrite: ["src/**"],
			tools: {
				write_file: { enabled: true },
				run_command: { allowlist: ["git"] },
			},
		},
		capability_bundle_digest: bundleDigest({
			schemaVersion: "buildplane.capability_bundle.v0",
			bundleId: "governed-worker-test",
			fsWrite: ["src/**"],
			tools: {
				write_file: { enabled: true },
				run_command: { allowlist: ["git"] },
			},
		}),
		...overrides,
	};
}

function executor(
	overrides: Partial<GovernedActionExecutor> = {},
): GovernedActionExecutor {
	return createTrustedTestGovernedActionExecutor({
		sandbox: {
			schemaVersion: 1,
			runtime: "rootless-oci",
			rootless: true,
			readOnlyBase: true,
			writableOverlay: true,
			network: "none",
			hostFallback: false,
			profileDigest: `sha256:${"d".repeat(64)}`,
		},
		...overrides,
	});
}

function request(projectRoot: string, inputPacket = packet()) {
	return {
		runId: "run-governed-worker",
		packet: inputPacket,
		projectRoot,
		eventBus: { emit: vi.fn() } as never,
		signal: new AbortController().signal,
	};
}

function governedDispatch(
	capabilityBundleDigest: string,
	overrides: Partial<GovernedDispatchLineageV3> = {},
	boundPacket: UnitPacket = packet(),
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: "run-governed-worker",
		workflowId: "workflow-governed-worker",
		workflowRevision: "revision-governed-worker",
		unitId: "governed-command",
		attempt: 1,
		provenanceRef: governance.provenanceRef,
		dispatchEnvelopeRef: "event://dispatch/governed-worker",
		envelopeDigest: DIGEST_A,
		baseCommitSha: "1".repeat(40),
		repositoryBindingDigest: DIGEST_B,
		ledgerAuthorityRealmDigest: DIGEST_C,
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(boundPacket),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest,
		acceptanceContractDigest: DIGEST_B,
		policyDigest: DIGEST_C,
		contextManifestDigest: DIGEST_D,
		workerManifestDigest: DIGEST_E,
		sandboxProfileDigest: DIGEST_D,
		budget: {},
		idempotencyKey: "dispatch:governed-worker:1",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2026-07-18T00:00:00.000Z",
		expiresAt: "2099-07-18T01:00:00.000Z",
		...overrides,
	};
}

function actionEvidencePort(order: string[]): GovernedActionEvidencePort {
	return {
		recordActionRequested: vi.fn(async (actionRequest) => {
			order.push("request");
			return {
				actionRequest,
				actionRequestRef: "event://action-request/governed-worker",
				actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
			};
		}),
		recordActionReceipt: vi.fn(async (receipt) => {
			order.push("receipt");
			const durableReceipt = {
				...receipt,
				actionReceiptRef: "event://action-receipt/governed-worker",
			};
			return {
				receipt: durableReceipt,
				actionReceiptDigest:
					canonicalActionReceiptRecordedV2Digest(durableReceipt),
			};
		}),
		sealActionReceiptSet: vi.fn(),
		recordCandidateCreatedV2: vi.fn(),
	};
}

function evidenceStore(
	order: string[],
	overrides: Partial<GovernedCommandEvidenceStore> = {},
): GovernedCommandEvidenceStore {
	return {
		persistCanonicalInput: async () => {
			order.push("input");
			return {
				canonicalInputDigest: DIGEST_E,
				canonicalInputRef: "cas://command-input/governed-worker",
				redactions: [],
			};
		},
		persistActionResult: async () => {
			order.push("result");
			return {
				resultDigest: DIGEST_F,
				resultRef: "cas://command-result/governed-worker",
				evidenceDigest: DIGEST_G,
				evidenceRef: "cas://command-evidence/governed-worker",
				redactions: [],
			};
		},
		...overrides,
	};
}

function activityClaimPort(
	order: string[],
	overrides: Partial<GovernedActivityClaimPort> = {},
): GovernedActivityClaimPort {
	return {
		claim: vi.fn(async () => {
			order.push("claim");
			return {
				state: "granted" as const,
				claimEventId: "event://activity-claim/governed-worker",
				claimEventDigest: DIGEST_A,
				leaseId: "lease://activity-claim/governed-worker",
				leaseExpiresAt: "2099-07-18T01:00:00.000Z",
			};
		}),
		recordResult: vi.fn(async (input) => {
			order.push(`activity:${input.outcome}`);
			return {
				state: "recorded" as const,
				resultEventId: "event://activity-result/governed-worker",
				resultEventDigest: DIGEST_B,
				resultOutcome: input.outcome,
			};
		}),
		...overrides,
	};
}

function v3CommandFixture(
	actionExecutor: GovernedActionExecutor,
	order: string[] = [],
) {
	const evidence = actionEvidencePort(order);
	return {
		evidence,
		port: createGovernedCommandWorkerExecutionPort({
			actionExecutor,
			evidenceStore: evidenceStore(order),
			activityClaimPort: activityClaimPort(order),
			now: () => "2026-07-18T00:00:00.000Z",
		}),
	};
}

function v3Request(
	projectRoot: string,
	inputPacket: UnitPacket,
	evidence: GovernedActionEvidencePort,
) {
	return {
		...request(projectRoot, inputPacket),
		governedDispatch: governedDispatch(
			inputPacket.capability_bundle_digest!,
			{},
			inputPacket,
		),
		actionEvidencePort: evidence,
	};
}

describe("governed command worker execution port", () => {
	it("rejects a structural executor before a governed worker can retain it", () => {
		const trusted = executor();
		const forged: GovernedActionExecutor = {
			sandbox: trusted.sandbox,
			runCommand: vi.fn(trusted.runCommand),
			writeFile: vi.fn(trusted.writeFile),
		};

		expect(() =>
			createGovernedCommandWorkerExecutionPort({ actionExecutor: forged }),
		).toThrow(/trusted rootless OCI executor factory/i);
	});

	it("claims the exact V3 action after write-ahead intent and before OCI execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const runCommand = vi.fn(() => {
				order.push("oci");
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const inputPacket = packet();
			const dispatch = governedDispatch(inputPacket.capability_bundle_digest!);
			const claims = activityClaimPort(order);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				now: () => "2026-07-18T00:00:00.000Z",
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
			});
			const evidence = actionEvidencePort(order);
			const result = await port.executeCandidatePacketAsync({
				...request(root, inputPacket),
				governedDispatch: dispatch,
				actionEvidencePort: evidence,
			});

			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"result",
				"activity:succeeded",
				"receipt",
			]);
			const claimInput = vi.mocked(claims.claim).mock.calls[0]?.[0];
			expect(claimInput).toEqual({
				dispatch,
				durableRequest: expect.objectContaining({
					actionRequestRef: "event://action-request/governed-worker",
					actionRequestDigest: expect.any(String),
					actionRequest: expect.objectContaining({
						runId: "run-governed-worker",
						workflowId: dispatch.workflowId,
						unitId: dispatch.unitId,
						idempotencyKey: "dispatch:governed-worker:1:command",
					}),
				}),
				activityId: result.actionReceipts[0]?.actionId,
				idempotencyKey: "dispatch:governed-worker:1:command",
				leaseDurationMs: 300_000,
			});
			const recordedInput = vi.mocked(claims.recordResult).mock.calls[0]?.[0];
			expect(recordedInput).toMatchObject({
				dispatch,
				durableRequest: claimInput?.durableRequest,
				claim: expect.objectContaining({
					claimEventId: "event://activity-claim/governed-worker",
				}),
				outcome: "succeeded",
				resultDigest: DIGEST_F,
				resultRef: "cas://command-result/governed-worker",
				evidenceDigest: DIGEST_G,
				evidenceRef: "cas://command-evidence/governed-worker",
			});
			expect(result).toMatchObject({
				executionReceipt: { exitCode: 0 },
				actionReceipts: [
					{
						actionId: expect.any(String),
						actionReceiptRef: "event://action-receipt/governed-worker",
					},
				],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("mints one immutable compute deadline from the signed dispatch budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const issuedAtMs = Date.parse("2026-07-18T00:00:00.000Z");
			const executionContexts: unknown[] = [];
			const inputPacket = packet();
			const dispatch = governedDispatch(
				inputPacket.capability_bundle_digest!,
				{
					budget: { maxComputeTimeMs: 97 },
					expiresAt: "2026-07-18T00:00:00.500Z",
				},
				inputPacket,
			);
			const order: string[] = [];
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({
					runCommand: vi.fn((_input, executionContext) => {
						executionContexts.push(executionContext);
						return { success: true, exitCode: 0, stdout: "", stderr: "" };
					}),
				}),
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
				now: () => "2026-07-18T00:00:00.000Z",
				nowMs: () => issuedAtMs + 1,
			});
			const evidence = actionEvidencePort(order);

			await port.executeCandidatePacketAsync({
				...request(root, inputPacket),
				governedDispatch: dispatch,
				actionEvidencePort: evidence,
			});

			expect(executionContexts).toEqual([
				expect.objectContaining({
					deadlineAtMs: issuedAtMs + 97,
				}),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"a non-positive compute budget",
			{ maxComputeTimeMs: 0 } as never,
			/positive safe integer/i,
		],
		[
			"an unknown budget field",
			{ maxComputeTimeMs: 10, untrusted: true } as never,
			/closed V1 schema/i,
		],
		[
			"an overflowing compute budget",
			{ maxComputeTimeMs: Number.MAX_SAFE_INTEGER },
			/overflows the absolute compute deadline/i,
		],
	])("fails closed before evidence or OCI for %s", async (_label, budget, error) => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const issuedAt = "2026-07-18T00:00:00.000Z";
			const issuedAtMs = Date.parse(issuedAt);
			const order: string[] = [];
			const runCommand = vi.fn(executor().runCommand);
			const inputPacket = packet();
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
				now: () => issuedAt,
				nowMs: () => issuedAtMs,
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
						{ budget },
						inputPacket,
					),
					actionEvidencePort: actionEvidencePort(order),
				}),
			).rejects.toThrow(error);
			expect(order).toEqual([]);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("denies an expired signed compute budget before action evidence or OCI", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const issuedAt = "2026-07-18T00:00:00.000Z";
			const issuedAtMs = Date.parse(issuedAt);
			const order: string[] = [];
			const runCommand = vi.fn(executor().runCommand);
			const inputPacket = packet();
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
				now: () => issuedAt,
				nowMs: () => issuedAtMs + 10,
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
						{ budget: { maxComputeTimeMs: 10 } },
						inputPacket,
					),
					actionEvidencePort: actionEvidencePort(order),
				}),
			).rejects.toThrow(/compute deadline is exhausted/i);
			expect(order).toEqual([]);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("derives collision-resistant activity ids from distinct sealed dispatch digests", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const oldTruncatedPrefix = "0123456789ab";
			const envelopeDigest = (suffix: string) =>
				`sha256:${oldTruncatedPrefix}${suffix.repeat(52)}`;
			const firstEnvelopeDigest = envelopeDigest("c");
			const secondEnvelopeDigest = envelopeDigest("d");
			const claimedActivityIds = new Set<string>();
			const claims = activityClaimPort(order, {
				claim: vi.fn(async (input) => {
					if (claimedActivityIds.has(input.activityId)) {
						return {
							state: "rejected" as const,
							code: "ACTIVITY_ID_CONFLICT",
							message: `activity ${input.activityId} is already claimed`,
						};
					}
					claimedActivityIds.add(input.activityId);
					order.push("claim");
					return {
						state: "granted" as const,
						claimEventId: `event://activity-claim/${claimedActivityIds.size}`,
						claimEventDigest: DIGEST_A,
						leaseId: `lease://activity-claim/${claimedActivityIds.size}`,
						leaseExpiresAt: "2099-07-18T01:00:00.000Z",
					};
				}),
			});
			const runCommand = vi.fn(() => ({
				success: true,
				exitCode: 0,
				stdout: "",
				stderr: "",
			}));
			const inputPacket = packet();
			const firstDispatch = governedDispatch(
				inputPacket.capability_bundle_digest!,
				{
					envelopeDigest: firstEnvelopeDigest,
					dispatchEnvelopeRef: "event://dispatch/governed-worker/first",
					idempotencyKey: "dispatch:governed-worker:first",
				},
				inputPacket,
			);
			const secondDispatch = governedDispatch(
				inputPacket.capability_bundle_digest!,
				{
					envelopeDigest: secondEnvelopeDigest,
					dispatchEnvelopeRef: "event://dispatch/governed-worker/second",
					idempotencyKey: "dispatch:governed-worker:second",
				},
				inputPacket,
			);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				now: () => "2026-07-18T00:00:00.000Z",
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
			});
			const evidence = actionEvidencePort(order);

			expect(firstEnvelopeDigest.slice("sha256:".length, 19)).toBe(
				secondEnvelopeDigest.slice("sha256:".length, 19),
			);

			const firstResult = await port.executeCandidatePacketAsync({
				...request(root, inputPacket),
				governedDispatch: firstDispatch,
				actionEvidencePort: evidence,
			});
			const secondResult = await port.executeCandidatePacketAsync({
				...request(root, inputPacket),
				governedDispatch: secondDispatch,
				actionEvidencePort: evidence,
			});
			const actionIds = [
				firstResult.actionReceipts[0]?.actionId,
				secondResult.actionReceipts[0]?.actionId,
			];

			expect(actionIds).toEqual([
				`governed:run-governed-worker:${firstEnvelopeDigest.slice("sha256:".length)}`,
				`governed:run-governed-worker:${secondEnvelopeDigest.slice("sha256:".length)}`,
			]);
			expect(new Set(actionIds)).toHaveLength(2);
			expect(runCommand).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures durable evidence and activity authorities instead of following later option swaps", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const inputPacket = packet();
			const options: CreateGovernedCommandWorkerExecutionPortOptions = {
				actionExecutor: executor({
					runCommand: () => {
						order.push("oci");
						return { success: true, exitCode: 0, stdout: "", stderr: "" };
					},
				}),
				now: () => "2026-07-18T00:00:00.000Z",
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
			};
			const port = createGovernedCommandWorkerExecutionPort(options);
			options.evidenceStore = {
				persistCanonicalInput: async () => {
					order.push("forged-input");
					throw new Error("forged evidence store must never run");
				},
				persistActionResult: async () => {
					order.push("forged-result");
					throw new Error("forged evidence store must never run");
				},
			};
			options.activityClaimPort = {
				claim: async () => {
					order.push("forged-claim");
					throw new Error("forged activity authority must never run");
				},
				recordResult: async () => {
					order.push("forged-result-authority");
					throw new Error("forged activity authority must never run");
				},
			};

			await port.executeCandidatePacketAsync({
				...request(root, inputPacket),
				governedDispatch: governedDispatch(
					inputPacket.capability_bundle_digest!,
				),
				actionEvidencePort: actionEvidencePort(order),
			});
			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"result",
				"activity:succeeded",
				"receipt",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains the admitted invocation values after write-ahead evidence yields", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		const replacementRoot = mkdtempSync(
			join(tmpdir(), "buildplane-governed-worker-replacement-"),
		);
		try {
			writeFileSync(join(root, "original.txt"), "original", "utf8");
			const order: string[] = [];
			const runCommand = vi.fn(() => {
				order.push("oci");
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const inputPacket = packet({
				verification: { requiredOutputs: ["original.txt"] },
			});
			const dispatch = governedDispatch(
				inputPacket.capability_bundle_digest!,
				{},
				inputPacket,
			);
			const originalDispatch = {
				workflowId: dispatch.workflowId,
				envelopeDigest: dispatch.envelopeDigest,
				capabilityBundleDigest: dispatch.capabilityBundleDigest,
				idempotencyKey: dispatch.idempotencyKey,
			};
			const delayedInput = {
				canonicalInputDigest: DIGEST_E,
				canonicalInputRef: "cas://command-input/governed-worker",
				redactions: [] as const,
			};
			const inputPersistence = deferred<typeof delayedInput>();
			const store = evidenceStore(order, {
				persistCanonicalInput: vi.fn(async () => {
					order.push("input");
					return inputPersistence.promise;
				}),
			});
			const evidence = actionEvidencePort(order);
			const recordActionRequested = evidence.recordActionRequested;
			const recordActionReceipt = evidence.recordActionReceipt;
			const forgedRecordActionRequested = vi.fn(async () => {
				throw new Error("mutated action request writer must not run");
			});
			const forgedRecordActionReceipt = vi.fn(async () => {
				throw new Error("mutated action receipt writer must not run");
			});
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: store,
				activityClaimPort: activityClaimPort(order),
				now: () => "2026-07-18T00:00:00.000Z",
			});
			const invocation = {
				...request(root, inputPacket),
				governedDispatch: dispatch,
				actionEvidencePort: evidence,
			};
			const resultPromise = port.executeCandidatePacketAsync(invocation);
			expect(store.persistCanonicalInput).toHaveBeenCalledOnce();

			const replacementBundle = {
				schemaVersion: "buildplane.capability_bundle.v0" as const,
				bundleId: "mutated-governed-worker-test",
				fsWrite: ["src/**"],
				tools: {
					write_file: { enabled: true },
					run_command: { allowlist: ["curl"] },
				},
			};
			Object.assign(inputPacket.execution!, {
				command: "curl",
				args: ["https://example.invalid"],
			});
			inputPacket.capability_bundle = replacementBundle;
			inputPacket.capability_bundle_digest = bundleDigest(replacementBundle);
			inputPacket.verification = { requiredOutputs: ["mutated.txt"] };
			Object.assign(dispatch, {
				workflowId: "forged-workflow",
				envelopeDigest: DIGEST_F,
				capabilityBundleDigest: DIGEST_G,
				idempotencyKey: "forged-idempotency-key",
			});
			Object.assign(invocation, { projectRoot: replacementRoot });
			Object.assign(evidence, {
				recordActionRequested: forgedRecordActionRequested,
				recordActionReceipt: forgedRecordActionReceipt,
			});
			inputPersistence.resolve(delayedInput);

			const result = await resultPromise;
			expect(recordActionRequested).toHaveBeenCalledWith(
				expect.objectContaining({
					workflowId: originalDispatch.workflowId,
					dispatchEnvelopeDigest: originalDispatch.envelopeDigest,
					capabilityBundleDigest: originalDispatch.capabilityBundleDigest,
					idempotencyKey: `${originalDispatch.idempotencyKey}:command`,
				}),
			);
			expect(forgedRecordActionRequested).not.toHaveBeenCalled();
			expect(forgedRecordActionReceipt).not.toHaveBeenCalled();
			expect(recordActionReceipt).toHaveBeenCalledOnce();
			expect(runCommand).toHaveBeenCalledWith(
				{ command: "git", args: ["status"] },
				expect.objectContaining({ worktreeRoot: root }),
			);
			expect(result.executionReceipt).toMatchObject({
				command: "git",
				args: ["status"],
				cwd: root,
				outputChecks: [{ path: "original.txt", exists: true }],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(replacementRoot, { recursive: true, force: true });
		}
	});

	it.each([
		{
			label: "pending",
			disposition: {
				state: "pending" as const,
				claimEventId: "event://activity-claim/governed-worker",
				leaseExpiresAt: "2099-07-18T01:00:00.000Z",
			},
			expectedError: /claim is pending/i,
		},
		{
			label: "already recorded",
			disposition: {
				state: "recorded" as const,
				claimEventId: "event://activity-claim/governed-worker",
				resultEventId: "event://activity-result/governed-worker",
				resultEventDigest: DIGEST_A,
				resultOutcome: "succeeded" as const,
			},
			expectedError: /already has a terminal native result/i,
		},
		{
			label: "expired",
			disposition: {
				state: "lease_expired" as const,
				claimEventId: "event://activity-claim/governed-worker",
				leaseExpiresAt: "2026-07-18T00:00:00.000Z",
			},
			expectedError: /claim lease expired/i,
		},
		{
			label: "rejected",
			disposition: {
				state: "rejected" as const,
				code: "CLAIM_DENIED",
				message: "policy denied activity claim",
			},
			expectedError: /claim was rejected/i,
		},
	])("blocks a $label native activity claim before OCI and action receipt persistence", async ({
		disposition,
		expectedError,
	}) => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const runCommand = vi.fn(() => {
				order.push("oci");
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const inputPacket = packet();
			const claims = activityClaimPort(order, {
				claim: vi.fn(async () => {
					order.push("claim");
					return disposition;
				}),
			});
			const evidence = actionEvidencePort(order);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
				now: () => "2026-07-18T00:00:00.000Z",
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: evidence,
				}),
			).rejects.toThrow(expectedError);
			expect(order).toEqual(["input", "request", "claim"]);
			expect(runCommand).not.toHaveBeenCalled();
			expect(claims.recordResult).not.toHaveBeenCalled();
			expect(evidence.recordActionReceipt).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rechecks dispatch expiry after write-ahead evidence and before the OCI action", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const runCommand = vi.fn(() => ({
				success: true,
				exitCode: 0,
				stdout: "",
				stderr: "",
			}));
			const inputPacket = packet();
			const now = vi
				.fn<() => string>()
				.mockReturnValueOnce("2026-07-18T00:00:00.000Z")
				.mockReturnValueOnce("2026-07-18T00:00:00.000Z")
				.mockReturnValue("2026-07-18T00:16:00.000Z");
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
				now,
				nowMs: () => Date.parse("2026-07-18T00:00:00.000Z"),
			});
			const evidence = actionEvidencePort(order);

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
						{
							issuedAt: "2026-07-18T00:00:00.000Z",
							expiresAt: "2026-07-18T00:15:00.000Z",
						},
					),
					actionEvidencePort: evidence,
				}),
			).rejects.toThrow(/dispatch is expired/i);
			expect(runCommand).not.toHaveBeenCalled();
			expect(order).toEqual(["input", "request", "receipt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks V3 command execution before OCI when no host-owned evidence store exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const runCommand = vi.fn(() => {
				order.push("oci");
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const inputPacket = packet();
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
			});
			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: actionEvidencePort(order),
				}),
			).rejects.toThrow(/host-owned evidence store/i);
			expect(order).toEqual([]);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks V3 command execution before OCI when governed acceptance is absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const inputPacket = packet({ acceptance_contract: undefined });
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore([]),
			});
			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: actionEvidencePort([]),
				}),
			).rejects.toThrow(/acceptance_contract/i);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks an expired V3 dispatch before OCI is invoked", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const inputPacket = packet();
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore([]),
				now: () => "2026-07-18T00:00:00.000Z",
			});
			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
						{
							issuedAt: "2020-01-01T00:00:00.000Z",
							expiresAt: "2020-01-01T00:15:00.000Z",
						},
					),
					actionEvidencePort: actionEvidencePort([]),
				}),
			).rejects.toThrow(/expired/i);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records an unknown terminal receipt when result evidence becomes uncertain after OCI execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const recordActionReceipt = vi.fn(
				actionEvidencePort(order).recordActionReceipt,
			);
			const evidence = actionEvidencePort(order);
			const inputPacket = packet();
			const claims = activityClaimPort(order);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({
					runCommand: () => {
						order.push("oci");
						return { success: true, exitCode: 0, stdout: "", stderr: "" };
					},
				}),
				evidenceStore: evidenceStore(order, {
					persistActionResult: async () => {
						order.push("result-failed");
						throw new Error("result evidence unavailable");
					},
				}),
				activityClaimPort: claims,
			});
			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: {
						...evidence,
						recordActionReceipt,
					},
				}),
			).rejects.toThrow("result evidence unavailable");
			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"result-failed",
				"activity:unknown",
				"receipt",
			]);
			expect(claims.recordResult).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "unknown",
					resultDigest: null,
					resultRef: null,
					evidenceDigest: expect.any(String),
					evidenceRef: "event://action-request/governed-worker",
				}),
			);
			expect(recordActionReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "unknown",
					failure: expect.objectContaining({
						code: "ACTION_RESULT_PERSISTENCE_UNCERTAIN",
					}),
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records native unknown before the unknown receipt when the OCI gateway throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const evidence = actionEvidencePort(order);
			const claims = activityClaimPort(order);
			const inputPacket = packet();
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({
					runCommand: () => {
						order.push("oci");
						throw new Error("OCI executor stopped unexpectedly");
					},
				}),
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
				now: () => "2026-07-18T00:00:00.000Z",
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: evidence,
				}),
			).rejects.toThrow("OCI executor stopped unexpectedly");
			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"activity:unknown",
				"receipt",
			]);
			expect(claims.recordResult).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "unknown",
					resultDigest: null,
					resultRef: null,
					evidenceDigest: expect.any(String),
					evidenceRef: "event://action-request/governed-worker",
				}),
			);
			expect(evidence.recordActionReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "unknown",
					failure: expect.objectContaining({
						code: "ACTION_GATEWAY_UNCERTAIN",
					}),
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records unknown after a terminal lease expiry instead of persisting a successful action receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const evidence = actionEvidencePort(order);
			const inputPacket = packet();
			const claims = activityClaimPort(order, {
				recordResult: vi.fn(async (input) => {
					order.push(`activity:${input.outcome}`);
					if (input.outcome === "succeeded") {
						return {
							state: "lease_expired" as const,
							claimEventId: "event://activity-claim/governed-worker",
							leaseExpiresAt: "2026-07-18T00:00:00.000Z",
						};
					}
					return {
						state: "recorded" as const,
						resultEventId: "event://activity-result/governed-worker",
						resultEventDigest: DIGEST_B,
						resultOutcome: input.outcome,
					};
				}),
			});
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({
					runCommand: () => {
						order.push("oci");
						return { success: true, exitCode: 0, stdout: "", stderr: "" };
					},
				}),
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
				now: () => "2026-07-18T00:00:00.000Z",
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: evidence,
				}),
			).rejects.toThrow(/lease expired after the OCI action/i);
			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"result",
				"activity:succeeded",
				"activity:unknown",
				"receipt",
			]);
			expect(claims.recordResult).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ outcome: "succeeded" }),
			);
			expect(claims.recordResult).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					outcome: "unknown",
					resultDigest: null,
					resultRef: null,
				}),
			);
			expect(evidence.recordActionReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "unknown",
					failure: expect.objectContaining({
						code: "ACTIVITY_LEASE_EXPIRED_AFTER_OCI_ACTION",
					}),
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not persist an action receipt when native terminal-result recording fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const evidence = actionEvidencePort(order);
			const inputPacket = packet();
			const claims = activityClaimPort(order, {
				recordResult: vi.fn(async (input) => {
					order.push(`activity:${input.outcome}`);
					throw new Error("native activity result write failed");
				}),
			});
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({
					runCommand: () => {
						order.push("oci");
						return { success: true, exitCode: 0, stdout: "", stderr: "" };
					},
				}),
				evidenceStore: evidenceStore(order),
				activityClaimPort: claims,
				now: () => "2026-07-18T00:00:00.000Z",
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, inputPacket),
					governedDispatch: governedDispatch(
						inputPacket.capability_bundle_digest!,
					),
					actionEvidencePort: evidence,
				}),
			).rejects.toThrow("native activity result write failed");
			expect(order).toEqual([
				"input",
				"request",
				"claim",
				"oci",
				"result",
				"activity:succeeded",
			]);
			expect(evidence.recordActionReceipt).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not re-execute an OCI command across 100 deterministic post-intent crash schedules", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			for (let seed = 0; seed < 100; seed += 1) {
				// Deterministic pseudo-random schedules cover an OCI throw, result
				// persistence loss after a successful OCI effect, and lease expiry
				// between the effect and native terminal-result recording.
				const schedule = (seed * 1_103_515_245 + 12_345) >>> 0;
				const crashBoundary = schedule % 3;
				const order: string[] = [];
				const inputPacket = packet();
				const runCommand = vi.fn(() => {
					order.push("oci");
					if (crashBoundary === 0) {
						throw new Error("simulated OCI crash");
					}
					return { success: true, exitCode: 0, stdout: "", stderr: "" };
				});
				let claimAttempts = 0;
				const claims = activityClaimPort(order, {
					claim: vi.fn(async () => {
						claimAttempts += 1;
						if (claimAttempts > 1) return { state: "recorded" as const };
						return {
							state: "granted" as const,
							claimEventId: "event://activity-claim/governed-worker",
							claimEventDigest: DIGEST_A,
							leaseId: "lease://activity-claim/governed-worker",
							leaseExpiresAt: "2099-07-18T01:00:00.000Z",
						};
					}),
					recordResult: vi.fn(async (input) => {
						order.push(`activity:${input.outcome}`);
						if (crashBoundary === 2 && input.outcome === "succeeded") {
							return {
								state: "lease_expired" as const,
								claimEventId: "event://activity-claim/governed-worker",
								leaseExpiresAt: "2026-07-18T00:00:00.000Z",
							};
						}
						return {
							state: "recorded" as const,
							resultEventId: "event://activity-result/governed-worker",
							resultEventDigest: DIGEST_B,
							resultOutcome: input.outcome,
						};
					}),
				});
				const port = createGovernedCommandWorkerExecutionPort({
					actionExecutor: executor({ runCommand }),
					evidenceStore: evidenceStore(order, {
						persistActionResult: async () => {
							order.push("result");
							if (crashBoundary === 1) {
								throw new Error("simulated result-persistence crash");
							}
							return {
								resultDigest: DIGEST_F,
								resultRef: "cas://command-result/governed-worker",
								evidenceDigest: DIGEST_G,
								evidenceRef: "cas://command-evidence/governed-worker",
								redactions: [],
							};
						},
					}),
					activityClaimPort: claims,
					now: () => "2026-07-18T00:00:00.000Z",
				});
				const evidence = actionEvidencePort(order);
				const invocation = v3Request(root, inputPacket, evidence);

				await expect(
					port.executeCandidatePacketAsync(invocation),
				).rejects.toThrow(
					crashBoundary === 0
						? /simulated OCI crash/
						: crashBoundary === 1
							? /simulated result-persistence crash/
							: /lease expired after the OCI action/,
				);
				await expect(
					port.executeCandidatePacketAsync(invocation),
				).rejects.toThrow(/already has a terminal native result/i);

				expect(runCommand, `seed ${seed}`).toHaveBeenCalledOnce();
				expect(claims.claim, `seed ${seed}`).toHaveBeenCalledTimes(2);
				expect(
					vi
						.mocked(claims.recordResult)
						.mock.calls.some(([input]) => input?.outcome === "unknown"),
					`seed ${seed}`,
				).toBe(true);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects legacy candidate governance before an OCI action can be authorized", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
			});
			await expect(
				port.executeCandidatePacketAsync({
					...request(root),
					candidateGovernance: governance,
				}),
			).rejects.toThrow(/sealed_v3 dispatch.*replay-only/i);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes a command packet through the supplied OCI action executor, never an ambient runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, packet(), evidence),
				)
			).executionReceipt;
			expect(receipt).toMatchObject({
				command: "git",
				exitCode: 0,
				stdout: "",
				stderr: "",
			});
			expect(runCommand).toHaveBeenCalledOnce();
			expect(runCommand).toHaveBeenCalledWith(
				{ command: "git", args: ["status"] },
				expect.objectContaining({
					runId: "run-governed-worker",
					worktreeRoot: root,
					role: "implementer",
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("denies a command outside the capability bundle before the OCI executor observes it", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const inputPacket = packet({
				execution: { command: "curl", args: ["https://example.invalid"] },
			});
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, inputPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.exitCode).toBe(1);
			expect(receipt.stderr).toContain(
				"command is not in run_command allowlist",
			);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a packet whose claimed capability digest does not bind its bundle", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const inputPacket = packet({ capability_bundle_digest: DIGEST_A });
			await expect(
				port.executeCandidatePacketAsync(
					v3Request(root, inputPacket, evidence),
				),
			).rejects.toThrow(/capability bundle digest must bind/i);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"unit definition",
			(base: UnitPacket) =>
				packet({
					...base,
					unit: { ...base.unit, expectedOutputs: ["changed-output"] },
				}),
		],
		[
			"execution request",
			(base: UnitPacket) =>
				packet({
					...base,
					execution: { command: "git", args: ["diff", "--stat"] },
				}),
		],
		[
			"verification contract",
			(base: UnitPacket) =>
				packet({
					...base,
					verification: { requiredOutputs: ["changed-output"] },
				}),
		],
		[
			"provenance reference",
			(base: UnitPacket) =>
				packet({ ...base, provenance_ref: "event://admission/substituted" }),
		],
		[
			"capability bundle",
			(base: UnitPacket) => {
				const capabilityBundle = {
					schemaVersion: "buildplane.capability_bundle.v0" as const,
					bundleId: "governed-worker-substituted",
					fsWrite: ["lib/**"],
					tools: { run_command: { allowlist: ["git"] } },
				};
				return packet({
					...base,
					capability_bundle: capabilityBundle,
					capability_bundle_digest: bundleDigest(capabilityBundle),
				});
			},
		],
		[
			"acceptance contract",
			(base: UnitPacket) =>
				packet({
					...base,
					acceptance_contract: { schemaVersion: 1, check: "different-check" },
				}),
		],
		[
			"trust scope",
			(base: UnitPacket) =>
				packet({
					...base,
					trust_scope: {
						schemaVersion: 1,
						lane: "governed",
						scope: "substituted",
					},
				}),
		],
	] as const)("rejects a substituted %s packet surface before evidence or OCI execution", async (_label, mutate) => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const order: string[] = [];
			const runCommand = vi.fn(executor().runCommand);
			const admittedPacket = packet();
			const substitutedPacket = mutate(admittedPacket);
			const port = createGovernedCommandWorkerExecutionPort({
				actionExecutor: executor({ runCommand }),
				evidenceStore: evidenceStore(order),
				activityClaimPort: activityClaimPort(order),
				now: () => "2026-07-18T00:00:00.000Z",
			});

			await expect(
				port.executeCandidatePacketAsync({
					...request(root, substitutedPacket),
					governedDispatch: governedDispatch(
						admittedPacket.capability_bundle_digest!,
						{},
						admittedPacket,
					),
					actionEvidencePort: actionEvidencePort(order),
				}),
			).rejects.toThrow(
				/packet does not match the exact packet digest|run, packet unit, provenance, and capability authority|only an implementer/i,
			);
			expect(order).toEqual([]);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks model packets instead of routing them to an ambient model adapter", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const modelPacket = packet({
				model: { provider: "openai", model: "test", prompt: "test" },
			});
			delete modelPacket.execution;
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, modelPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.exitCode).toBe(1);
			expect(receipt.stderr).toContain(
				"API/SDK model workers are not configured",
			);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks hybrid model and command packets before OCI execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const hybridPacket = packet({
				model: { provider: "openai", model: "test", prompt: "test" },
			});
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, hybridPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.exitCode).toBe(1);
			expect(receipt.stderr).toContain(
				"cannot combine a model packet with command execution",
			);
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks a candidate path escape before an OCI action is authorized", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(executor().runCommand);
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const inputPacket = packet({
				execution: { command: "git", args: ["status"], cwd: "../outside" },
			});
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, inputPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.exitCode).toBe(1);
			expect(receipt.stderr).toContain("outside the workspace root");
			expect(runCommand).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures required outputs only after the OCI action completes", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			const runCommand = vi.fn(() => {
				writeFileSync(join(root, "result.txt"), "result", "utf8");
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const inputPacket = packet({
				verification: { requiredOutputs: ["result.txt"] },
			});
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, inputPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.outputChecks).toEqual([
				{ path: "result.txt", exists: true },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not accept a worker-created required-output symlink", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-governed-worker-"));
		try {
			writeFileSync(join(root, "outside.txt"), "not an output", "utf8");
			const runCommand = vi.fn(() => {
				symlinkSync(
					join(root, "outside.txt"),
					join(root, "result.txt"),
					"file",
				);
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const { port, evidence } = v3CommandFixture(executor({ runCommand }));
			const inputPacket = packet({
				verification: { requiredOutputs: ["result.txt"] },
			});
			const receipt = (
				await port.executeCandidatePacketAsync(
					v3Request(root, inputPacket, evidence),
				)
			).executionReceipt;
			expect(receipt.outputChecks).toEqual([
				{ path: "result.txt", exists: false },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
