import { describe, expect, it, vi } from "vitest";
import type {
	CandidateGovernanceLineage,
	GovernedDispatchLineageV3,
} from "../src/ports.js";
import type {
	RunPacketResult,
	UnitPacket,
	WorkspaceCandidateArtifact,
} from "../src/run-loop.js";
import {
	type ReadOnlyCandidateReviewResult,
	runStrategy,
	type StrategyExecutionOptions,
	type StrategyOrchestrator,
} from "../src/strategy-executor.js";
import type { ReviewVerdictV1 } from "../src/trust-spine.js";
import type { StrategyPacket } from "../src/types.js";

const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const CANDIDATE_DIGEST = `sha256:${"c".repeat(64)}`;
const REVIEWER_MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;
const GOVERNED_DISPATCH: GovernedDispatchLineageV3 = {
	schemaVersion: 3,
	runId: "run-implementer",
	workflowId: "workflow-strategy-candidate",
	workflowRevision: "revision-strategy-candidate",
	unitId: "implement",
	attempt: 1,
	provenanceRef: "event://admission/strategy-candidate",
	dispatchEnvelopeRef: "event://dispatch/strategy-candidate",
	envelopeDigest: `sha256:${"e".repeat(64)}`,
	baseCommitSha: BASE_SHA,
	repositoryBindingDigest: `sha256:${"6".repeat(64)}`,
	ledgerAuthorityRealmDigest: `sha256:${"7".repeat(64)}`,
	governedPacketDigest: `sha256:${"8".repeat(64)}`,
	executionRole: "implementer",
	commitMode: "atomic",
	trustTier: "governed",
	capabilityBundleDigest: `sha256:${"0".repeat(64)}`,
	acceptanceContractDigest: `sha256:${"1".repeat(64)}`,
	policyDigest: `sha256:${"2".repeat(64)}`,
	contextManifestDigest: `sha256:${"3".repeat(64)}`,
	workerManifestDigest: `sha256:${"4".repeat(64)}`,
	sandboxProfileDigest: `sha256:${"5".repeat(64)}`,
	budget: {},
	idempotencyKey: "dispatch:strategy-candidate:1",
	authorityActor: "kernel:test",
	actionEvidenceVersion: "sealed_v3",
	issuedAt: "2099-07-17T12:00:00Z",
	expiresAt: "2099-07-17T12:15:00Z",
};

function packet(id: string, role: UnitPacket["execution_role"]): UnitPacket {
	return {
		unit: {
			id,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
		},
		execution: { command: "true", args: [] },
		execution_role: role,
		verification: { requiredOutputs: [] },
		provenance_ref: "",
	};
}

function candidate(
	candidateDigest = CANDIDATE_DIGEST,
): WorkspaceCandidateArtifact {
	return {
		schemaVersion: 1,
		candidateId: "strategy-candidate",
		runId: "run-implementer",
		attempt: 1,
		candidateKey: "strategy-candidate:run-implementer:1",
		candidateRef:
			"refs/buildplane/candidates/strategy-candidate/run-implementer/1",
		baseSha: BASE_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		commitDigest: `sha256:${"e".repeat(64)}`,
		treeDigest: `sha256:${"f".repeat(64)}`,
		patchDigest: `sha256:${"1".repeat(64)}`,
		changedFilesDigest: `sha256:${"2".repeat(64)}`,
		candidateDigest,
	};
}

function candidateAcceptance(
	candidateDigest = CANDIDATE_DIGEST,
	outcome: "passed" | "rejected" = "passed",
) {
	return {
		candidateDigest: candidateDigest.startsWith("sha256:")
			? candidateDigest
			: `sha256:${candidateDigest}`,
		candidateCommitSha: CANDIDATE_SHA,
		acceptanceRef: "event://candidate-acceptance/1",
		acceptanceContractDigest: GOVERNED_DISPATCH.acceptanceContractDigest,
		outcome,
	};
}

function receipt(stdout: string) {
	return {
		command: "review",
		args: [],
		cwd: "/workspace",
		startedAt: "2026-07-17T12:00:00Z",
		completedAt: "2026-07-17T12:00:01Z",
		exitCode: 0,
		stdout,
		stderr: "",
		outputChecks: [],
	};
}

function approvedVerdict(): string {
	return JSON.stringify({
		schemaVersion: 1,
		candidateDigest: CANDIDATE_DIGEST,
		decision: "approve",
		findings: [],
		confidence: 0.99,
		reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
	});
}

function strategy(): StrategyPacket {
	return {
		id: "strategy-candidate",
		mode: "implement-then-review",
		mergePolicy: "reviewer-must-approve",
		children: [
			{ role: "implementer", packet: packet("implement", "implementer") },
			{
				role: "reviewer",
				dependsOn: ["implement"],
				packet: packet("review", "reviewer"),
			},
		],
	};
}

function singleStrategy(): StrategyPacket {
	return {
		id: "single-governed-strategy",
		mode: "single",
		mergePolicy: "direct",
		children: [
			{ role: "implementer", packet: packet("implement", "implementer") },
		],
	};
}

function candidateCapableOrchestrator(
	reviewerStdout: string,
	candidateDigest = CANDIDATE_DIGEST,
	options: {
		readonly persistReview?: boolean;
		readonly reviewRecordCandidateDigest?: string;
		readonly candidateAcceptanceOutcome?: "passed" | "rejected";
		readonly typedReviewVerdict?: ReviewVerdictV1;
		readonly reviewCallback?: NonNullable<
			StrategyOrchestrator["runReadOnlyCandidateReviewAsync"]
		>;
		readonly persistReviewCallback?: NonNullable<
			StrategyOrchestrator["recordCandidateReview"]
		>;
	} = {},
): StrategyOrchestrator & {
	runCandidatePacketAsync: NonNullable<
		StrategyOrchestrator["runCandidatePacketAsync"]
	>;
} {
	const runCandidatePacketAsync = vi.fn(
		async (): Promise<RunPacketResult> => ({
			run: { id: "run-implementer", unitId: "implement", status: "passed" },
			candidate: candidate(candidateDigest),
			candidateAcceptance: candidateAcceptance(
				candidateDigest,
				options.candidateAcceptanceOutcome,
			),
		}),
	);
	const runPacketAsync = vi.fn(
		async (): Promise<RunPacketResult> => ({
			run: { id: "run-reviewer", unitId: "review", status: "passed" },
			receipt: receipt(reviewerStdout),
		}),
	);
	const runReadOnlyCandidateReviewAsync =
		options.reviewCallback ??
		vi.fn(
			async (): Promise<ReadOnlyCandidateReviewResult> => ({
				run: { id: "run-reviewer", unitId: "review", status: "passed" },
				receipt: receipt(reviewerStdout),
				...(options.typedReviewVerdict === undefined
					? {}
					: { reviewVerdict: options.typedReviewVerdict }),
			}),
		);
	const runGraphAsync = vi.fn(async () => {
		throw new Error(
			"candidate-capable strategy execution must not dispatch a graph",
		);
	});
	const recordCandidateReview =
		options.persistReviewCallback ??
		vi.fn(async (input) => ({
			candidateDigest:
				options.reviewRecordCandidateDigest ??
				(input.candidate.candidateDigest.startsWith("sha256:")
					? input.candidate.candidateDigest
					: `sha256:${input.candidate.candidateDigest}`),
			candidateCommitSha: input.candidate.candidateCommitSha,
			reviewRef: "event://candidate-review/1",
			verdict: input.verdict,
		}));

	return {
		runCandidatePacketAsync,
		runPacketAsync,
		runReadOnlyCandidateReviewAsync,
		runGraphAsync,
		...(options.persistReview === false ? {} : { recordCandidateReview }),
	};
}

describe("candidate-backed implement-then-review strategies", () => {
	it("refuses to downgrade a governance-bearing single packet into the raw lane", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());
		const legacySingle = singleStrategy();
		const governedSingle: StrategyPacket = {
			...legacySingle,
			children: legacySingle.children.map((child) => ({
				...child,
				packet: {
					...child.packet,
					provenance_ref: "event://admission/governed-single",
				},
			})),
		};

		const result = await runStrategy(governedSingle, orchestrator, undefined, {
			lane: "raw-legacy",
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/governance fields.*raw-legacy/i,
		);
		expect(orchestrator.runPacketAsync).not.toHaveBeenCalled();
	});

	it("requires an explicit lane before a legacy strategy can execute", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());

		const result = await runStrategy(strategy(), orchestrator);

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(/explicit lane/i);
		expect(orchestrator.runPacketAsync).not.toHaveBeenCalled();
		expect(orchestrator.runCandidatePacketAsync).not.toHaveBeenCalled();
	});

	it("does not route a governed single strategy through legacy direct execution", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());

		const result = await runStrategy(
			singleStrategy(),
			orchestrator,
			undefined,
			{
				lane: "governed-candidate",
				governedDispatch: GOVERNED_DISPATCH,
			},
		);

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(/single.*governed/i);
		expect(orchestrator.runPacketAsync).not.toHaveBeenCalled();
	});

	it("fails closed before executing an implementer when governed lineage is absent", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
		} as unknown as StrategyExecutionOptions);

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(/lineage/i);
		expect(orchestrator.runCandidatePacketAsync).not.toHaveBeenCalled();
	});

	it("rejects a legacy sealed-v2 V3 lineage before executing an implementer", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());
		const legacyLineage: GovernedDispatchLineageV3 = {
			...GOVERNED_DISPATCH,
			actionEvidenceVersion: "sealed-v2",
		};

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: legacyLineage,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/sealed_v3 activity-claim action evidence/i,
		);
		expect(orchestrator.runCandidatePacketAsync).not.toHaveBeenCalled();
	});

	it("rejects a caller-provided V1 action receipt lineage before candidate execution", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());
		const legacyLineage: CandidateGovernanceLineage = {
			workflowId: GOVERNED_DISPATCH.workflowId,
			provenanceRef: GOVERNED_DISPATCH.provenanceRef,
			envelopeDigest: GOVERNED_DISPATCH.envelopeDigest,
			acceptanceContractDigest: GOVERNED_DISPATCH.acceptanceContractDigest,
			actionReceiptDigest: `sha256:${"a".repeat(64)}`,
		};

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			candidateGovernance: legacyLineage,
		} as unknown as StrategyExecutionOptions);

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/V1|V3|action receipt/i,
		);
		expect(orchestrator.runCandidatePacketAsync).not.toHaveBeenCalled();
	});

	it("rejects a top-level caller-provided action receipt digest in the V3 lane", async () => {
		const orchestrator = candidateCapableOrchestrator(approvedVerdict());

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
			actionReceiptDigest: `sha256:${"a".repeat(64)}`,
		} as unknown as StrategyExecutionOptions);

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/action(?:-|\s)receipt|actionReceipt/i,
		);
		expect(orchestrator.runCandidatePacketAsync).not.toHaveBeenCalled();
	});

	it("treats a missing review recorder as non-promotable while reviewer authority is blocked", async () => {
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			undefined,
			{
				persistReview: false,
			},
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("blocks an unbound reviewer callback and persistence callback before either can mutate the root", async () => {
		let rootHead = BASE_SHA;
		const reviewCallback = vi.fn(
			async (): Promise<ReadOnlyCandidateReviewResult> => {
				rootHead = CANDIDATE_SHA;
				return {
					run: { id: "run-reviewer", unitId: "review", status: "passed" },
					receipt: receipt(approvedVerdict()),
				};
			},
		);
		const persistReviewCallback = vi.fn(async (input) => {
			rootHead = CANDIDATE_SHA;
			return {
				candidateDigest: input.candidate.candidateDigest,
				candidateCommitSha: input.candidate.candidateCommitSha,
				reviewRef: "event://candidate-review/forged",
				verdict: input.verdict,
			};
		});
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			undefined,
			{
				reviewCallback,
				persistReviewCallback,
			},
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.candidate?.candidateDigest).toBe(CANDIDATE_DIGEST);
		expect(result.reviewVerdict).toBeUndefined();
		expect(result.reviewRecord).toBeUndefined();
		expect(result.mergeDecision).toMatchObject({
			outcome: "rejected",
		});
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.runCandidatePacketAsync).toHaveBeenCalledWith(
			expect.anything(),
			{ candidateId: "strategy-candidate", attempt: 1 },
			undefined,
			GOVERNED_DISPATCH,
		);
		expect(reviewCallback).not.toHaveBeenCalled();
		expect(persistReviewCallback).not.toHaveBeenCalled();
		expect(rootHead).toBe(BASE_SHA);
		expect(orchestrator.runGraphAsync).not.toHaveBeenCalled();
	});

	it("blocks raw legacy review strategies before graph dispatch", async () => {
		const runGraphAsync = vi.fn(async () => ({
			outcome: "passed" as const,
			nodes: [
				{
					unitId: "implement",
					runId: "run-implementer",
					status: "passed" as const,
				},
				{ unitId: "review", runId: "run-reviewer", status: "passed" as const },
			],
		}));
		const orchestrator = {
			runPacketAsync: vi.fn(
				async (): Promise<RunPacketResult> => ({
					run: { id: "unused", unitId: "unused", status: "passed" },
				}),
			),
			runGraphAsync,
		} satisfies StrategyOrchestrator;

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "raw-legacy",
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.outcome).toBe("rejected");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/raw review strategies are blocked.*pre-promotion review/i,
		);
		expect(runGraphAsync).not.toHaveBeenCalled();
	});

	it("does not invoke a reviewer before deterministic candidate acceptance passes", async () => {
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			undefined,
			{
				candidateAcceptanceOutcome: "rejected",
			},
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/deterministic acceptance/i,
		);
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
		expect(orchestrator.recordCandidateReview).not.toHaveBeenCalled();
	});

	it("does not consult forged persisted review evidence while reviewer authority is blocked", async () => {
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			CANDIDATE_DIGEST,
			{ reviewRecordCandidateDigest: `sha256:${"9".repeat(64)}` },
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.recordCandidateReview).not.toHaveBeenCalled();
	});

	it("retains an immutable raw-form candidate digest without promoting it", async () => {
		const rawCandidateDigest = "c".repeat(64);
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			rawCandidateDigest,
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.candidate?.candidateDigest).toBe(rawCandidateDigest);
		expect(result.mergeDecision.selectedCandidateId).toBeUndefined();
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("does not parse callback output before native reviewer authority exists", async () => {
		const orchestrator = candidateCapableOrchestrator("review complete");

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.outcome).toBe("rejected");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
		expect(orchestrator.runGraphAsync).not.toHaveBeenCalled();
	});

	it("does not treat a typed callback verdict as recorded review authority", async () => {
		const orchestrator = candidateCapableOrchestrator(
			approvedVerdict(),
			undefined,
			{
				typedReviewVerdict: {
					schemaVersion: 1,
					candidateDigest: CANDIDATE_DIGEST,
					decision: "request_changes",
					findings: [],
					confidence: 0.8,
					reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
				},
			},
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
		expect(orchestrator.recordCandidateReview).not.toHaveBeenCalled();
	});

	it("does not inspect a structurally valid callback approval before verified dispatch exists", async () => {
		const orchestrator = candidateCapableOrchestrator(
			JSON.stringify({
				schemaVersion: 1,
				candidateDigest: `sha256:${"9".repeat(64)}`,
				decision: "approve",
				findings: [],
				confidence: 0.99,
				reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
			}),
		);

		const result = await runStrategy(strategy(), orchestrator, undefined, {
			lane: "governed-candidate",
			governedDispatch: GOVERNED_DISPATCH,
		});

		expect(result.outcome).toBe("failed");
		expect(result.mergeDecision.reasons.join(" ")).toMatch(
			/native-verified reviewer dispatch|candidate-view|review evidence/i,
		);
		expect(orchestrator.runReadOnlyCandidateReviewAsync).not.toHaveBeenCalled();
	});
});
