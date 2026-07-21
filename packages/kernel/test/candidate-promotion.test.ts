import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	CandidateArtifactProjection,
	CandidatePromotionDecisionPort,
	CandidatePromotionIntent,
	CandidatePromotionIntentInput,
	CandidatePromotionOutcome,
	PromotionGitBindingV1,
	RecordCandidatePromotionInput,
} from "@buildplane/kernel";
import {
	CandidatePromotionValidationError,
	createBuildplaneOrchestrator,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

const ROOT = "/tmp/buildplane-candidate-promotion-test";
const RUN_ID = "01919000-0000-7000-8000-0000000000ca";
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const RAW_CANDIDATE_DIGEST = "c".repeat(64);
const CANDIDATE_DIGEST = `sha256:${RAW_CANDIDATE_DIGEST}`;
const ENVELOPE_DIGEST = `sha256:${"d".repeat(64)}`;
const ACTION_RECEIPT_DIGEST = `sha256:${"e".repeat(64)}`;
const ACTION_RECEIPT_SET_DIGEST = `sha256:${"1".repeat(64)}`;
const ACCEPTANCE_CONTRACT_DIGEST = `sha256:${"6".repeat(64)}`;
const REVIEWER_MANIFEST_DIGEST = `sha256:${"f".repeat(64)}`;
const MERGED_SHA = "9".repeat(40);
const MERGED_TREE_SHA = "7".repeat(40);
const TARGET_REF = "refs/heads/main";
const TREE_DIGEST = "2".repeat(64);

function promotionGitBinding(
	overrides: Partial<PromotionGitBindingV1> = {},
): PromotionGitBindingV1 {
	return {
		targetRef: TARGET_REF,
		targetHeadBeforeSha: BASE_SHA,
		targetHeadAfterSha: MERGED_SHA,
		mergedHeadSha: MERGED_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		mergeParentShas: [BASE_SHA, CANDIDATE_SHA],
		mergedTreeSha: MERGED_TREE_SHA,
		mergedTreeDigest: TREE_DIGEST,
		promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run/1",
		worktreeSyncState: "pending_reconciliation",
		...overrides,
	};
}

function candidate(): CandidateArtifactProjection {
	return {
		schemaVersion: 1,
		candidateId: "candidate-1",
		runId: RUN_ID,
		unitId: "implement",
		attempt: 1,
		candidateKey: "candidate-1/run/1",
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		baseSha: BASE_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		commitDigest: "1".repeat(64),
		treeDigest: "2".repeat(64),
		patchDigest: "3".repeat(64),
		changedFilesDigest: "4".repeat(64),
		candidateDigest: RAW_CANDIDATE_DIGEST,
		workflowId: "workflow-1",
		provenanceRef: "event://admission/1",
		envelopeDigest: ENVELOPE_DIGEST,
		acceptanceContractDigest: ACCEPTANCE_CONTRACT_DIGEST,
		actionReceiptDigest: ACTION_RECEIPT_DIGEST,
		createdAt: "2026-07-17T12:00:00Z",
	};
}

function candidateV2(
	overrides: Partial<CandidateArtifactProjection> = {},
): CandidateArtifactProjection {
	return {
		schemaVersion: 2,
		candidateId: "candidate-1",
		runId: RUN_ID,
		unitId: "implement",
		attempt: 1,
		candidateKey: "candidate-1/run/1",
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		baseSha: BASE_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		commitDigest: "1".repeat(64),
		treeDigest: "2".repeat(64),
		patchDigest: "3".repeat(64),
		changedFilesDigest: "4".repeat(64),
		candidateDigest: RAW_CANDIDATE_DIGEST,
		workflowId: "workflow-1",
		provenanceRef: "event://admission/1",
		envelopeDigest: ENVELOPE_DIGEST,
		acceptanceContractDigest: ACCEPTANCE_CONTRACT_DIGEST,
		actionEvidenceVersion: "sealed-v2",
		actionReceiptSetRef: "event://action-receipt-set/1",
		actionReceiptSetDigest: ACTION_RECEIPT_SET_DIGEST,
		candidateCreatedRef: "event://candidate-created/1",
		createdAt: "2026-07-17T12:00:00Z",
		...overrides,
	};
}

function promotionInput(
	overrides: Partial<RecordCandidatePromotionInput> = {},
): RecordCandidatePromotionInput {
	const reviewRef = "event://review/1";
	const acceptanceRef = "event://acceptance/1";
	return {
		runId: RUN_ID,
		decision: {
			schemaVersion: 1,
			candidateDigest: CANDIDATE_DIGEST,
			baseCommitSha: BASE_SHA,
			targetRef: TARGET_REF,
			envelopeDigest: ENVELOPE_DIGEST,
			acceptanceRef,
			reviewRefs: [reviewRef],
			decision: "promote",
			authority: "operator@example.test",
			decidedBy: "operator@example.test",
			decidedAt: "2026-07-17T12:01:00Z",
			idempotencyKey: "promotion-1",
		},
		acceptance: {
			candidateDigest: CANDIDATE_DIGEST,
			candidateCommitSha: CANDIDATE_SHA,
			acceptanceContractDigest: ACCEPTANCE_CONTRACT_DIGEST,
			acceptanceRef,
			outcome: "passed",
		},
		review: {
			candidateDigest: CANDIDATE_DIGEST,
			candidateCommitSha: CANDIDATE_SHA,
			reviewRef,
			verdict: {
				schemaVersion: 1,
				candidateDigest: CANDIDATE_DIGEST,
				decision: "approve",
				findings: [],
				confidence: 0.99,
				reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
			},
		},
		...overrides,
	};
}

interface Harness {
	orchestrator: ReturnType<typeof createBuildplaneOrchestrator>;
	order: string[];
	decisionEvents: CandidatePromotionIntentInput[];
	resultEvents: Array<{
		runId: string;
		candidateDigest: string;
		idempotencyKey: string;
		outcome: CandidatePromotionOutcome;
		promotionDecisionRef: string;
		mergedHeadSha?: string;
		promotionGitBinding?: ReturnType<typeof promotionGitBinding>;
	}>;
	promotionCalls: number;
	governedPromotionCalls: number;
	inspectionCalls: number;
	governedInspectionCalls: number;
	rootMutations: number;
	intents: Map<string, CandidatePromotionIntent>;
	allowResult: { value: boolean };
	allowClaim: { value: boolean };
	executionLeaseTokens: string[];
}

function makeHarness(
	options: {
		omitPort?: boolean;
		promotionDigest?: string;
		promotionHeadSha?: string;
		targetHeadAfterPromotion?: string;
		targetHeadBeforeAlreadyPromoted?: string;
		promotionStatus?: "promoted" | "reconciliation_required";
		promotionBindingOverrides?: Partial<PromotionGitBindingV1>;
		emptyDecisionRef?: boolean;
		candidateProjection?: CandidateArtifactProjection;
		governedPromotion?: boolean;
		/** Exposes the governed boundary without granting a target-ref mutation port. */
		governedBoundary?: boolean;
		/** Models the real governed adapter, which has no generic promotion method. */
		omitGenericPromotion?: boolean;
		/** Simulates whether an immutable candidate-keyed receipt exists. */
		inspectPromotionReceipt?: boolean;
		/** V3 receipt inspection must use the governed read-only boundary. */
		inspectGovernedPromotionReceipt?: boolean;
		/** Explicit raw-only compatibility lane for pre-sealed-V3 promotion tests. */
		unsafeLegacyCandidatePromotionMode?: boolean;
		/**
		 * Test-only constructor control for the explicit raw compatibility lane.
		 * `null` deliberately omits it to prove unsafe switches fail closed.
		 */
		unsafeLegacyExecutionLane?: "raw-legacy" | null;
	} = {},
): Harness {
	const order: string[] = [];
	const intents = new Map<string, CandidatePromotionIntent>();
	const decisionEvents: CandidatePromotionIntentInput[] = [];
	const resultEvents: Harness["resultEvents"] = [];
	const allowResult = { value: true };
	const allowClaim = { value: true };
	const executionLeaseToken = "promotion-execution-lease-test";
	const executionLeaseTokens: string[] = [];
	let promotionCalls = 0;
	let governedPromotionCalls = 0;
	let inspectionCalls = 0;
	let governedInspectionCalls = 0;
	let rootMutations = 0;
	let targetHead = BASE_SHA;

	function intentKey(input: CandidatePromotionIntentInput): string {
		return `${input.decision.candidateDigest}\u0000${input.decision.idempotencyKey}`;
	}

	const candidateProjection = options.candidateProjection ?? candidate();
	const storage: BuildplaneStoragePort = {
		initializeProject() {
			return {
				created: true,
				projectRoot: ROOT,
				stateDbPath: `${ROOT}/state.db`,
			};
		},
		createRun() {
			return { id: RUN_ID, unitId: "implement", status: "pending" };
		},
		getChildRuns() {
			return [];
		},
		markRunRunning() {},
		recordExecutionEvidence() {},
		recordDecision() {},
		completeRun() {
			return { id: RUN_ID, unitId: "implement", status: "passed" };
		},
		recordWorkspacePrepared() {},
		commitRunFailureOutcome() {
			return { id: RUN_ID, unitId: "implement", status: "failed" };
		},
		commitRunSuccessOutcome() {
			return { id: RUN_ID, unitId: "implement", status: "passed" };
		},
		getCandidateArtifact(runId) {
			return runId === RUN_ID ? candidateProjection : null;
		},
		prepareCandidatePromotion(input) {
			order.push("prepare");
			const key = intentKey(input);
			const existing = intents.get(key);
			if (existing) {
				if (
					existing.runId !== input.runId ||
					existing.decision.candidateDigest !==
						input.decision.candidateDigest ||
					existing.decision.baseCommitSha !== input.decision.baseCommitSha ||
					existing.decision.envelopeDigest !== input.decision.envelopeDigest
				) {
					throw new Error("conflicting duplicate promotion intent");
				}
				return existing;
			}
			for (const intent of intents.values()) {
				if (
					intent.decision.candidateDigest === input.decision.candidateDigest
				) {
					throw new Error("conflicting promotion for candidate");
				}
			}
			const intent: CandidatePromotionIntent = { ...input, state: "prepared" };
			intents.set(key, intent);
			return intent;
		},
		markCandidatePromotionRecorded(candidateDigest, idempotencyKey) {
			order.push("recorded");
			const key = `${candidateDigest}\u0000${idempotencyKey}`;
			const intent = intents.get(key);
			if (!intent) throw new Error("missing intent");
			if (intent.state === "prepared") {
				intents.set(key, { ...intent, state: "recorded" });
			}
		},
		claimCandidatePromotionExecution(candidateDigest, idempotencyKey) {
			order.push("claim");
			if (!allowClaim.value) {
				throw new Error("candidate promotion claim is no longer active");
			}
			const intent = intents.get(`${candidateDigest}\u0000${idempotencyKey}`);
			if (!intent || intent.state !== "recorded") {
				throw new Error("candidate promotion is not actively claimed");
			}
			return {
				schemaVersion: 1 as const,
				state: "active" as const,
				candidateDigest,
				idempotencyKey,
				leaseToken: executionLeaseToken,
				claimedAt: "2026-07-17T12:00:00.000Z",
				leaseExpiresAt: "2099-07-17T12:05:00.000Z",
				claimEpoch: 1,
			};
		},
		markCandidatePromotionExecuted(
			candidateDigest,
			idempotencyKey,
			outcome,
			claimedLeaseToken,
		) {
			order.push("executed");
			if (claimedLeaseToken !== executionLeaseToken) {
				throw new Error("candidate promotion execution lease token mismatch");
			}
			executionLeaseTokens.push(claimedLeaseToken);
			const key = `${candidateDigest}\u0000${idempotencyKey}`;
			const intent = intents.get(key);
			if (!intent) throw new Error("missing intent");
			intents.set(key, {
				...intent,
				state: "executed",
				executedOutcome: outcome.outcome,
				...(outcome.mergedHeadSha
					? { mergedHeadSha: outcome.mergedHeadSha }
					: {}),
				...(outcome.promotionGitBinding
					? { promotionGitBinding: outcome.promotionGitBinding }
					: {}),
			});
		},
		listPendingCandidatePromotions() {
			return [...intents.values()].filter(
				(intent) => intent.state !== "executed",
			);
		},
		recordWorkspaceDeleted() {},
		recordWorkspaceCleanupFailed() {},
		suspendRun() {
			return { id: RUN_ID, unitId: "implement", status: "suspended" };
		},
		approveRun() {
			return { id: RUN_ID, unitId: "implement", status: "pending" };
		},
		rejectSuspendedRun() {
			return { id: RUN_ID, unitId: "implement", status: "failed" };
		},
		rejectMergeDecision() {
			return { id: RUN_ID, unitId: "implement", status: "failed" };
		},
		getStatusSnapshot() {
			return {
				initialized: true,
				latestRunUsedWorkspace: false,
				actionableWorkspaces: [],
				runCounts: {
					pending: 0,
					running: 0,
					passed: 1,
					failed: 0,
					cancelled: 0,
				},
			};
		},
		inspectTarget() {
			throw new Error("unused");
		},
	} as unknown as BuildplaneStoragePort;

	const runtime: BuildplaneRuntimePort = {
		executePacket() {
			throw new Error("unused");
		},
	};
	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			return { kind: "advance-run", outcome: "approved", reasons: [] };
		},
	};
	const promote = (
		input: { readonly targetRef?: string },
		orderEntry: "promote" | "promote-governed",
	) => {
		order.push(orderEntry);
		promotionCalls += 1;
		if (rootMutations > 0) {
			targetHead = options.targetHeadBeforeAlreadyPromoted ?? targetHead;
			const mergedHeadSha = options.promotionHeadSha ?? MERGED_SHA;
			const status =
				targetHead === mergedHeadSha
					? ("already_promoted" as const)
					: ("reconciliation_required" as const);
			return {
				status,
				mergedHeadSha,
				candidateDigest: options.promotionDigest ?? RAW_CANDIDATE_DIGEST,
				promotionGitBinding: promotionGitBinding({
					...(input.targetRef ? { targetRef: input.targetRef } : {}),
					targetHeadAfterSha: targetHead,
					mergedHeadSha,
					worktreeSyncState:
						status === "reconciliation_required"
							? "target_advanced"
							: "pending_reconciliation",
					...(options.promotionBindingOverrides ?? {}),
				}),
			};
		}
		rootMutations += 1;
		const mergedHeadSha = options.promotionHeadSha ?? MERGED_SHA;
		targetHead = options.targetHeadAfterPromotion ?? mergedHeadSha;
		const status = options.promotionStatus ?? "promoted";
		return {
			status,
			mergedHeadSha,
			candidateDigest: options.promotionDigest ?? RAW_CANDIDATE_DIGEST,
			promotionGitBinding: promotionGitBinding({
				...(input.targetRef ? { targetRef: input.targetRef } : {}),
				targetHeadAfterSha: targetHead,
				mergedHeadSha,
				worktreeSyncState:
					status === "reconciliation_required"
						? "target_advanced"
						: "pending_reconciliation",
				...(options.promotionBindingOverrides ?? {}),
			}),
		};
	};
	const inspectPromotionReceipt = (
		input: { readonly targetRef?: string },
		orderEntry: "inspect" | "inspect-governed",
		present: boolean,
	) => {
		order.push(orderEntry);
		if (orderEntry === "inspect-governed") {
			governedInspectionCalls += 1;
		} else {
			inspectionCalls += 1;
		}
		if (!present || rootMutations === 0) return null;
		if (options.targetHeadBeforeAlreadyPromoted) {
			// Simulate another actor replacing the target between the completed CAS
			// and the crash-recovery receipt probe.
			targetHead = options.targetHeadBeforeAlreadyPromoted;
		}
		const mergedHeadSha = options.promotionHeadSha ?? MERGED_SHA;
		const status =
			targetHead === mergedHeadSha
				? ("already_promoted" as const)
				: ("reconciliation_required" as const);
		return {
			status,
			mergedHeadSha,
			candidateDigest: options.promotionDigest ?? RAW_CANDIDATE_DIGEST,
			promotionGitBinding: promotionGitBinding({
				...(input.targetRef ? { targetRef: input.targetRef } : {}),
				targetHeadAfterSha: targetHead,
				mergedHeadSha,
				worktreeSyncState:
					status === "reconciliation_required"
						? "target_advanced"
						: "pending_reconciliation",
				...(options.promotionBindingOverrides ?? {}),
			}),
		};
	};

	type WorkspaceWithPromotionInspection = BuildplaneWorkspacePort & {
		inspectWorkspaceCandidatePromotion?: (input: {
			readonly targetRef?: string;
		}) => ReturnType<typeof inspectPromotionReceipt>;
		inspectGovernedWorkspaceCandidatePromotion?: (input: {
			readonly targetRef?: string;
		}) => ReturnType<typeof inspectPromotionReceipt>;
	};
	const workspace: WorkspaceWithPromotionInspection = {
		assertRunnableRepository() {
			return { headSha: targetHead };
		},
		checkWorktreeClean: () => true,
		prepareWorkspace(_root, _runId, headSha) {
			return { path: `${ROOT}/workspace`, headSha };
		},
		deleteWorkspace() {
			return { deleted: true };
		},
		...(options.omitGenericPromotion
			? {}
			: {
					promoteWorkspaceCandidate(input: { readonly targetRef?: string }) {
						return promote(input, "promote");
					},
				}),
		...(options.inspectPromotionReceipt === undefined
			? {}
			: {
					inspectWorkspaceCandidatePromotion(input: {
						readonly targetRef?: string;
					}) {
						return inspectPromotionReceipt(
							input,
							"inspect",
							options.inspectPromotionReceipt === true,
						);
					},
				}),
		...(options.governedPromotion || options.governedBoundary
			? {
					governedWorkspaceBoundary: "pinned-governed-git-v1" as const,
					...(options.governedPromotion
						? {
								promoteGovernedWorkspaceCandidate(input: {
									readonly targetRef?: string;
								}) {
									governedPromotionCalls += 1;
									return promote(input, "promote-governed");
								},
							}
						: {}),
					...(options.inspectGovernedPromotionReceipt === undefined
						? {}
						: {
								inspectGovernedWorkspaceCandidatePromotion(input: {
									readonly targetRef?: string;
								}) {
									return inspectPromotionReceipt(
										input,
										"inspect-governed",
										options.inspectGovernedPromotionReceipt === true,
									);
								},
							}),
				}
			: {}),
	};

	const promotionPort: CandidatePromotionDecisionPort = {
		async recordPromotionDecision({ intent }) {
			const decisionRef = options.emptyDecisionRef
				? ""
				: `decision:${intent.runId}:${intent.decision.idempotencyKey}`;
			const existing = decisionEvents.find(
				(event) =>
					event.decision.idempotencyKey === intent.decision.idempotencyKey,
			);
			if (existing) {
				if (
					existing.decision.candidateDigest !==
						intent.decision.candidateDigest ||
					existing.decision.baseCommitSha !== intent.decision.baseCommitSha
				) {
					throw new Error("signed decision idempotency conflict");
				}
				return decisionRef;
			}
			order.push("tape-decision");
			decisionEvents.push(intent);
			return decisionRef;
		},
		async recordPromotionResult(result) {
			order.push("tape-result");
			if (!allowResult.value) throw new Error("simulated result-tape crash");
			resultEvents.push(result);
		},
	};

	const unsafeLegacyCandidatePromotionMode =
		options.unsafeLegacyCandidatePromotionMode ??
		!(options.governedPromotion || options.governedBoundary);
	const orchestrator = createBuildplaneOrchestrator({
		projectRoot: ROOT,
		storage,
		runtime,
		policy,
		workspace,
		admissionStore: null,
		...(options.omitPort
			? {}
			: { candidatePromotionDecisionPort: promotionPort }),
		// This fixture exercises the explicitly unsafe compatibility lane. Production
		// callers omit this flag and must not be able to mutate a target from V1 or
		// sealed-v2 candidate lineage.
		unsafeLegacyCandidatePromotionMode,
		...(unsafeLegacyCandidatePromotionMode &&
		options.unsafeLegacyExecutionLane !== null
			? {
					unsafeLegacyExecutionLane:
						options.unsafeLegacyExecutionLane ?? "raw-legacy",
				}
			: {}),
	});

	return {
		orchestrator,
		order,
		decisionEvents,
		resultEvents,
		get promotionCalls() {
			return promotionCalls;
		},
		get governedPromotionCalls() {
			return governedPromotionCalls;
		},
		get inspectionCalls() {
			return inspectionCalls;
		},
		get governedInspectionCalls() {
			return governedInspectionCalls;
		},
		get rootMutations() {
			return rootMutations;
		},
		intents,
		allowResult,
		allowClaim,
		executionLeaseTokens,
	};
}

function makeGovernedHarness(
	options: Parameters<typeof makeHarness>[0] = {},
): Harness {
	return makeHarness({ ...options, unsafeLegacyCandidatePromotionMode: false });
}

describe("candidate-bound promotion transaction", () => {
	it("requires an explicit raw construction before enabling pre-V3 compatibility promotion", () => {
		expect(() =>
			makeHarness({
				unsafeLegacyCandidatePromotionMode: true,
				unsafeLegacyExecutionLane: null,
			}),
		).toThrow(/unsafe legacy.*explicit raw-legacy/i);
	});

	it("refuses to construct a raw compatibility promotion lane with a governed workspace boundary", () => {
		expect(() =>
			makeHarness({
				governedBoundary: true,
				unsafeLegacyCandidatePromotionMode: true,
				unsafeLegacyExecutionLane: "raw-legacy",
			}),
		).toThrow(/unsafe legacy.*governed/i);
	});

	it.each([
		["V1", candidate()],
		["sealed-v2 V2", candidateV2()],
	] as const)("keeps %s candidate promotion replay-only outside the explicit raw compatibility lane", async (_lineage, candidateProjection) => {
		const harness = makeGovernedHarness({ candidateProjection });

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/pre-sealed V3 candidate promotion is replay-only/i);

		expect(harness.order).toEqual([]);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("does not recover a recorded pre-sealed-V3 promotion through the generic Git adapter", async () => {
		const harness = makeGovernedHarness();
		const input = promotionInput();
		harness.intents.set(`${CANDIDATE_DIGEST}\u0000promotion-1`, {
			runId: input.runId,
			candidate: candidate(),
			decision: input.decision,
			acceptance: input.acceptance,
			review: input.review,
			preparedAt: "2026-07-17T12:00:00Z",
			state: "recorded",
		});

		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery).toEqual({
			recovered: 0,
			failed: [
				expect.objectContaining({
					candidateDigest: CANDIDATE_DIGEST,
					error: expect.stringMatching(
						/pre-sealed V3 candidate promotion is replay-only/i,
					),
				}),
			],
		});
		expect(harness.order).toEqual([]);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("suspends a post-CAS promotion when the root checkout remains stale", async () => {
		const harness = makeHarness();

		const result = await harness.orchestrator.recordCandidatePromotion(
			promotionInput(),
		);

		expect(result).toMatchObject({
			candidateDigest: CANDIDATE_DIGEST,
			outcome: "reconciliation_required",
			mergedHeadSha: MERGED_SHA,
			promotionGitBinding: {
				targetHeadAfterSha: MERGED_SHA,
				mergedHeadSha: MERGED_SHA,
				worktreeSyncState: "root_checkout_stale",
			},
		});
		expect(harness.resultEvents).toMatchObject([
			{
				outcome: "reconciliation_required",
				promotionGitBinding: {
					worktreeSyncState: "root_checkout_stale",
				},
			},
		]);
		expect(
			harness.intents.get(`${CANDIDATE_DIGEST}\u0000promotion-1`),
		).toMatchObject({
			state: "executed",
			executedOutcome: "reconciliation_required",
		});
	});

	it("writes a signed decision before exactly one frozen-candidate promotion", async () => {
		const harness = makeHarness();

		const result = await harness.orchestrator.recordCandidatePromotion(
			promotionInput(),
		);

		expect(result).toEqual({
			candidateDigest: CANDIDATE_DIGEST,
			outcome: "reconciliation_required",
			mergedHeadSha: MERGED_SHA,
			promotionGitBinding: {
				targetRef: TARGET_REF,
				targetHeadBeforeSha: BASE_SHA,
				targetHeadAfterSha: MERGED_SHA,
				mergedHeadSha: MERGED_SHA,
				candidateCommitSha: CANDIDATE_SHA,
				mergeParentShas: [BASE_SHA, CANDIDATE_SHA],
				mergedTreeSha: MERGED_TREE_SHA,
				mergedTreeDigest: `sha256:${TREE_DIGEST}`,
				promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run/1",
				worktreeSyncState: "root_checkout_stale",
			},
			replayed: false,
		});
		expect(harness.order).toEqual([
			"prepare",
			"tape-decision",
			"recorded",
			"claim",
			"promote",
			"tape-result",
			"executed",
		]);
		expect(harness.decisionEvents[0]?.candidate.candidateDigest).toBe(
			RAW_CANDIDATE_DIGEST,
		);
		expect(harness.resultEvents).toEqual([
			{
				runId: RUN_ID,
				candidateDigest: CANDIDATE_DIGEST,
				idempotencyKey: "promotion-1",
				promotionDecisionRef: `decision:${RUN_ID}:promotion-1`,
				outcome: "reconciliation_required",
				mergedHeadSha: MERGED_SHA,
				promotionGitBinding: {
					targetRef: TARGET_REF,
					targetHeadBeforeSha: BASE_SHA,
					targetHeadAfterSha: MERGED_SHA,
					mergedHeadSha: MERGED_SHA,
					candidateCommitSha: CANDIDATE_SHA,
					mergeParentShas: [BASE_SHA, CANDIDATE_SHA],
					mergedTreeSha: MERGED_TREE_SHA,
					mergedTreeDigest: `sha256:${TREE_DIGEST}`,
					promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run/1",
					worktreeSyncState: "root_checkout_stale",
				},
			},
		]);
		expect(harness.rootMutations).toBe(1);
		expect(harness.executionLeaseTokens).toEqual([
			"promotion-execution-lease-test",
		]);

		const replay = await harness.orchestrator.recordCandidatePromotion(
			promotionInput(),
		);
		expect(replay.replayed).toBe(true);
		expect(harness.rootMutations).toBe(1);
		expect(harness.promotionCalls).toBe(1);
	});

	it("keeps a legacy sealed-v2 V2 candidate promotion-readable when its receipt-set lineage is complete", async () => {
		const harness = makeHarness({ candidateProjection: candidateV2() });

		const result = await harness.orchestrator.recordCandidatePromotion(
			promotionInput(),
		);

		expect(result.outcome).toBe("reconciliation_required");
		expect(harness.decisionEvents[0]?.candidate).toMatchObject({
			schemaVersion: 2,
			actionEvidenceVersion: "sealed-v2",
			actionReceiptSetRef: "event://action-receipt-set/1",
			actionReceiptSetDigest: ACTION_RECEIPT_SET_DIGEST,
			candidateCreatedRef: "event://candidate-created/1",
		});
		expect(harness.rootMutations).toBe(1);
	});

	it("does not fall back to ambient promotion for a sealed V3 candidate", async () => {
		const harness = makeHarness({
			candidateProjection: candidateV2({ actionEvidenceVersion: "sealed_v3" }),
			unsafeLegacyCandidatePromotionMode: false,
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/pinned governed Git workspace boundary/i);
		expect(harness.order).toEqual([]);
		expect(harness.intents.size).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.resultEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
	});

	it("rejects an explicitly raw candidate promotion switch for sealed V3 lineage before target mutation", async () => {
		const harness = makeHarness({
			candidateProjection: candidateV2({ actionEvidenceVersion: "sealed_v3" }),
			unsafeLegacyCandidatePromotionMode: true,
			unsafeLegacyExecutionLane: "raw-legacy",
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/unsafe legacy.*sealed V3/i);

		expect(harness.order).toEqual([]);
		expect(harness.intents.size).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.resultEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
	});

	it("does not invoke a generic workspace promotion operation for a sealed V3 candidate", async () => {
		const harness = makeHarness({
			candidateProjection: candidateV2({ actionEvidenceVersion: "sealed_v3" }),
			governedPromotion: true,
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/native decision-bound promotion executor/i);

		expect(harness.order).toEqual([]);
		expect(harness.intents.size).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.resultEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("reaches the native sealed-V3 promotion gate with the mutation-free governed adapter surface", async () => {
		const harness = makeHarness({
			candidateProjection: candidateV2({ actionEvidenceVersion: "sealed_v3" }),
			governedBoundary: true,
			omitGenericPromotion: true,
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/native decision-bound promotion executor/i);

		expect(harness.order).toEqual([]);
		expect(harness.intents.size).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.resultEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("records a sealed V3 rejection without requiring the native promotion executor", async () => {
		const harness = makeGovernedHarness({
			candidateProjection: candidateV2({ actionEvidenceVersion: "sealed_v3" }),
		});
		const input = promotionInput({
			decision: {
				...promotionInput().decision,
				decision: "reject",
			},
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(input),
		).resolves.toMatchObject({
			candidateDigest: CANDIDATE_DIGEST,
			outcome: "rejected",
		});

		expect(harness.order).toEqual([
			"prepare",
			"tape-decision",
			"recorded",
			"claim",
			"tape-result",
			"executed",
		]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("rejects a non-signable promotion actor binding before preparing local state", async () => {
		const harness = makeHarness();
		const input = promotionInput({
			decision: {
				...promotionInput().decision,
				authority: "operator",
				decidedBy: "operator@example.test",
			},
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(input),
		).rejects.toThrow(
			"promotionDecision.authority must equal promotionDecision.decidedBy for a signable promotion decision",
		);

		expect(harness.order).toEqual([]);
		expect(harness.intents.size).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.resultEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
	});

	it("rejects V2 candidate promotion when legacy receipt lineage is mixed in", async () => {
		const harness = makeHarness({
			candidateProjection: candidateV2({
				actionReceiptDigest: ACTION_RECEIPT_DIGEST,
			}),
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/V2 candidate lineage must not carry/i);
		expect(harness.order).toEqual([]);
		expect(harness.rootMutations).toBe(0);
	});

	it("fails closed before a tape write or root mutation on evidence mismatch", async () => {
		const harness = makeHarness();
		const invalid = promotionInput({
			decision: {
				...promotionInput().decision,
				baseCommitSha: "0".repeat(40),
			},
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(invalid),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.order).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
	});

	it("requires a signed canonical targetRef before a governed promotion is prepared", async () => {
		const harness = makeHarness();
		const invalid = promotionInput({
			decision: {
				...promotionInput().decision,
				targetRef: undefined,
			},
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(invalid),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.order).toEqual([]);
		expect(harness.rootMutations).toBe(0);
	});

	it("rejects a noncanonical candidate ref before a promotion decision or target mutation", async () => {
		const harness = makeHarness({
			candidateProjection: {
				...candidate(),
				candidateRef: "refs/buildplane/candidates/candidate-1/@{forged}/1",
			},
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/canonical immutable candidate ref/i);

		expect(harness.order).toEqual([]);
		expect(harness.decisionEvents).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});

	it("fails closed before a tape write or root mutation when acceptance used a different contract", async () => {
		const harness = makeHarness();
		const invalid = promotionInput({
			acceptance: {
				...promotionInput().acceptance,
				acceptanceContractDigest: `sha256:${"7".repeat(64)}`,
			} as unknown as RecordCandidatePromotionInput["acceptance"],
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(invalid),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.order).toEqual([]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.decisionEvents).toEqual([]);
	});

	it("requires the signed promotion port even when all local evidence matches", async () => {
		const harness = makeHarness({ omitPort: true });

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.order).toEqual([]);
		expect(harness.rootMutations).toBe(0);
	});

	it("fails closed when the signed decision port returns an empty reference", async () => {
		const harness = makeHarness({ emptyDecisionRef: true });

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.rootMutations).toBe(0);
		expect(harness.resultEvents).toEqual([]);
	});

	it("binds a rejected promotion result to the returned decision reference", async () => {
		const harness = makeHarness();
		const input = promotionInput({
			decision: {
				...promotionInput().decision,
				decision: "reject",
			},
		});

		const result = await harness.orchestrator.recordCandidatePromotion(input);

		expect(result).toEqual({
			candidateDigest: CANDIDATE_DIGEST,
			outcome: "rejected",
			replayed: false,
		});
		expect(harness.rootMutations).toBe(0);
		expect(harness.order).toEqual([
			"prepare",
			"tape-decision",
			"recorded",
			"claim",
			"tape-result",
			"executed",
		]);
		expect(harness.executionLeaseTokens).toEqual([
			"promotion-execution-lease-test",
		]);
		expect(harness.resultEvents).toEqual([
			{
				runId: RUN_ID,
				candidateDigest: CANDIDATE_DIGEST,
				idempotencyKey: "promotion-1",
				promotionDecisionRef: `decision:${RUN_ID}:promotion-1`,
				outcome: "rejected",
			},
		]);
	});

	it("rejects a promotion adapter result for another candidate before recording a result", async () => {
		const harness = makeHarness({ promotionDigest: "0".repeat(64) });

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.rootMutations).toBe(1);
		expect(harness.resultEvents).toEqual([]);
	});

	it("records a target-advanced effect for operator reconciliation without rereading the stale root checkout", async () => {
		const harness = makeHarness({
			promotionHeadSha: MERGED_SHA,
			targetHeadAfterPromotion: "8".repeat(40),
			promotionStatus: "reconciliation_required",
		});

		const result = await harness.orchestrator.recordCandidatePromotion(
			promotionInput(),
		);
		expect(result).toMatchObject({
			candidateDigest: CANDIDATE_DIGEST,
			outcome: "reconciliation_required",
			mergedHeadSha: MERGED_SHA,
			promotionGitBinding: {
				targetHeadAfterSha: "8".repeat(40),
				mergedHeadSha: MERGED_SHA,
				worktreeSyncState: "target_advanced",
			},
		});
		expect(harness.rootMutations).toBe(1);
		expect(harness.resultEvents[0]?.outcome).toBe("reconciliation_required");
	});

	it("rejects a pending-root report when the target no longer equals the merge", async () => {
		const harness = makeHarness({
			targetHeadAfterPromotion: "8".repeat(40),
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.rootMutations).toBe(1);
		expect(harness.resultEvents).toEqual([]);
	});

	it("rejects a syntactically valid result SHA that differs from the adapter's bound merge evidence", async () => {
		const harness = makeHarness({
			promotionBindingOverrides: { mergedHeadSha: "8".repeat(40) },
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.rootMutations).toBe(1);
		expect(harness.resultEvents).toEqual([]);
	});

	it("rejects adapter Git evidence that does not bind the signed target or candidate", async () => {
		const harness = makeHarness({
			promotionBindingOverrides: { targetRef: "refs/heads/other" },
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toBeInstanceOf(CandidatePromotionValidationError);
		expect(harness.rootMutations).toBe(1);
		expect(harness.resultEvents).toEqual([]);
	});

	it("reconciles a crash after Git promotion without a second target mutation", async () => {
		const harness = makeHarness({ inspectPromotionReceipt: true });
		harness.allowResult.value = false;

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/result-tape crash/i);
		expect(harness.rootMutations).toBe(1);
		expect(harness.promotionCalls).toBe(1);
		expect(harness.decisionEvents).toHaveLength(1);

		harness.allowResult.value = true;
		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery).toEqual({ recovered: 1, failed: [] });
		expect(harness.rootMutations).toBe(1);
		expect(harness.promotionCalls).toBe(1);
		expect(harness.inspectionCalls).toBe(1);
		expect(harness.decisionEvents).toHaveLength(1);
		expect(harness.resultEvents).toEqual([
			{
				runId: RUN_ID,
				candidateDigest: CANDIDATE_DIGEST,
				idempotencyKey: "promotion-1",
				promotionDecisionRef: `decision:${RUN_ID}:promotion-1`,
				outcome: "reconciliation_required",
				mergedHeadSha: MERGED_SHA,
				promotionGitBinding: {
					targetRef: TARGET_REF,
					targetHeadBeforeSha: BASE_SHA,
					targetHeadAfterSha: MERGED_SHA,
					mergedHeadSha: MERGED_SHA,
					candidateCommitSha: CANDIDATE_SHA,
					mergeParentShas: [BASE_SHA, CANDIDATE_SHA],
					mergedTreeSha: MERGED_TREE_SHA,
					mergedTreeDigest: `sha256:${TREE_DIGEST}`,
					promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run/1",
					worktreeSyncState: "root_checkout_stale",
				},
			},
		]);
	});

	it("keeps promotion exactly once across 100 deterministic post-CAS crash schedules", async () => {
		for (let seed = 0; seed < 100; seed += 1) {
			// A deterministic LCG gives this suite schedule diversity without a
			// flaky clock or random source. Each schedule independently varies a
			// crash after the Git CAS and whether the target advances before the
			// read-only recovery probe.
			const schedule = (seed * 1_103_515_245 + 12_345) >>> 0;
			const crashAfterCas = (schedule & 1) === 0;
			const targetAdvancesBeforeRecovery = (schedule & 0b100) !== 0;
			// A target CAS never reports a completed root-worktree handoff. Both
			// normal and target-advanced schedules remain reconciliation-required
			// until an explicit root reconciliation exists.
			const expectedOutcome = "reconciliation_required";
			const harness = makeHarness({
				inspectPromotionReceipt: true,
				...(targetAdvancesBeforeRecovery
					? { targetHeadBeforeAlreadyPromoted: "8".repeat(40) }
					: {}),
			});

			if (crashAfterCas) {
				harness.allowResult.value = false;
				await expect(
					harness.orchestrator.recordCandidatePromotion(promotionInput()),
				).rejects.toThrow(/result-tape crash/i);
				harness.allowResult.value = true;
				await expect(
					harness.orchestrator.recoverPendingCandidatePromotions(),
				).resolves.toEqual({ recovered: 1, failed: [] });
			} else {
				await expect(
					harness.orchestrator.recordCandidatePromotion(promotionInput()),
				).resolves.toMatchObject({
					candidateDigest: CANDIDATE_DIGEST,
					outcome: expectedOutcome,
				});
				await expect(
					harness.orchestrator.recoverPendingCandidatePromotions(),
				).resolves.toEqual({ recovered: 0, failed: [] });
			}

			expect(harness.rootMutations, `seed ${seed}`).toBe(1);
			expect(harness.promotionCalls, `seed ${seed}`).toBe(1);
			expect(harness.decisionEvents, `seed ${seed}`).toHaveLength(1);
			expect(harness.resultEvents, `seed ${seed}`).toHaveLength(1);
			expect(
				harness.intents.get(`${CANDIDATE_DIGEST}\u0000promotion-1`),
				`seed ${seed}`,
			).toMatchObject({ state: "executed" });
			if (crashAfterCas) {
				expect(harness.inspectionCalls, `seed ${seed}`).toBe(1);
			} else {
				expect(harness.inspectionCalls, `seed ${seed}`).toBe(0);
			}
			expect(harness.resultEvents[0]?.outcome, `seed ${seed}`).toBe(
				expectedOutcome,
			);
		}
	});

	it("records receipt recovery as reconciliation_required after another actor replaces the target", async () => {
		const replacementHead = "8".repeat(40);
		const harness = makeHarness({
			targetHeadBeforeAlreadyPromoted: replacementHead,
			inspectPromotionReceipt: true,
		});
		harness.allowResult.value = false;

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/result-tape crash/i);
		expect(harness.rootMutations).toBe(1);

		harness.allowResult.value = true;
		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery).toEqual({ recovered: 1, failed: [] });
		expect(harness.rootMutations).toBe(1);
		expect(harness.promotionCalls).toBe(1);
		expect(harness.inspectionCalls).toBe(1);
		expect(harness.resultEvents).toMatchObject([
			{
				outcome: "reconciliation_required",
				mergedHeadSha: MERGED_SHA,
				promotionGitBinding: {
					targetHeadAfterSha: replacementHead,
					mergedHeadSha: MERGED_SHA,
					worktreeSyncState: "target_advanced",
				},
			},
		]);
		expect(
			harness.intents.get(`${CANDIDATE_DIGEST}\u0000promotion-1`),
		).toMatchObject({
			state: "executed",
			executedOutcome: "reconciliation_required",
		});
	});

	it("fails closed during sealed V3 recovery when the governed receipt inspector is unavailable", async () => {
		const candidateProjection = candidateV2({
			actionEvidenceVersion: "sealed_v3",
		});
		const harness = makeHarness({
			candidateProjection,
			governedPromotion: true,
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/native decision-bound promotion executor/i);
		expect(harness.rootMutations).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		const input = promotionInput();
		harness.intents.set(`${CANDIDATE_DIGEST}\u0000promotion-1`, {
			runId: input.runId,
			candidate: candidateProjection,
			decision: input.decision,
			acceptance: input.acceptance,
			review: input.review,
			preparedAt: "2026-07-17T12:00:00Z",
			state: "recorded",
		});

		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery.recovered).toBe(0);
		expect(recovery.failed).toEqual([
			expect.objectContaining({
				error: expect.stringMatching(
					/inspectGovernedWorkspaceCandidatePromotion/i,
				),
			}),
		]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		expect(harness.governedInspectionCalls).toBe(0);
	});

	it("fails closed during sealed V3 recovery when its immutable receipt is missing", async () => {
		const candidateProjection = candidateV2({
			actionEvidenceVersion: "sealed_v3",
		});
		const harness = makeHarness({
			candidateProjection,
			governedPromotion: true,
			inspectGovernedPromotionReceipt: false,
		});

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/native decision-bound promotion executor/i);
		expect(harness.rootMutations).toBe(0);
		const input = promotionInput();
		harness.intents.set(`${CANDIDATE_DIGEST}\u0000promotion-1`, {
			runId: input.runId,
			candidate: candidateProjection,
			decision: input.decision,
			acceptance: input.acceptance,
			review: input.review,
			preparedAt: "2026-07-17T12:00:00Z",
			state: "recorded",
		});

		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery.recovered).toBe(0);
		expect(recovery.failed).toEqual([
			expect.objectContaining({
				error: expect.stringMatching(/immutable promotion receipt/i),
			}),
		]);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
		expect(harness.governedPromotionCalls).toBe(0);
		expect(harness.governedInspectionCalls).toBe(1);
	});

	it("revalidates a recorded intent at the signed boundary before recovery can touch Git", async () => {
		const harness = makeHarness();
		harness.allowResult.value = false;
		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/result-tape crash/i);

		const key = `${CANDIDATE_DIGEST}\u0000promotion-1`;
		const recorded = harness.intents.get(key);
		if (!recorded)
			throw new Error("test setup did not retain promotion intent");
		harness.intents.set(key, {
			...recorded,
			decision: { ...recorded.decision, baseCommitSha: "0".repeat(40) },
		});
		harness.allowResult.value = true;

		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();

		expect(recovery.recovered).toBe(0);
		expect(recovery.failed).toHaveLength(1);
		expect(harness.rootMutations).toBe(1);
		expect(harness.promotionCalls).toBe(1);
	});

	it("blocks direct and recovered promotion before Git when the recorded claim becomes inactive", async () => {
		const harness = makeHarness();
		harness.allowClaim.value = false;

		await expect(
			harness.orchestrator.recordCandidatePromotion(promotionInput()),
		).rejects.toThrow(/claim is no longer active/i);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);

		const recovery =
			await harness.orchestrator.recoverPendingCandidatePromotions();
		expect(recovery.recovered).toBe(0);
		expect(recovery.failed).toHaveLength(1);
		expect(harness.rootMutations).toBe(0);
		expect(harness.promotionCalls).toBe(0);
	});
});
