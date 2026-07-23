import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBuildplaneOrchestrator } from "../src/orchestrator.js";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	CandidateAcceptanceRecord,
	CandidateArtifactProjection,
	CandidatePromotionDecisionPort,
	GovernedDispatchLineageV3,
	RecordCandidatePromotionInput,
} from "../src/ports.js";
import type {
	RunPacketResult,
	UnitPacket,
	WorkspaceCandidateArtifact,
} from "../src/run-loop.js";
import {
	type ReadOnlyCandidateReviewResult,
	runStrategy,
	type StrategyOrchestrator,
} from "../src/strategy-executor.js";
import type { ReviewDecisionV1, ReviewVerdictV1 } from "../src/trust-spine.js";
import type { StrategyPacket } from "../src/types.js";

const DIGEST = (value: string) =>
	`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

interface RootSnapshot {
	readonly head: string;
	readonly tree: string;
	readonly commitCount: string;
	readonly status: string;
}

interface Fixture {
	readonly root: string;
	readonly baseSha: string;
	readonly rootRef: string;
	readonly candidate: WorkspaceCandidateArtifact;
}

type Scenario = {
	readonly label: string;
	readonly kind:
		| "review-reject"
		| "review-request-changes"
		| "review-abstain"
		| "review-malformed"
		| "failed-acceptance"
		| "cancelled"
		| "provider-failure";
	readonly reviewDecision?: "reject" | "request_changes" | "abstain";
};

const SCENARIOS: readonly Scenario[] = [
	{
		label: "reject review output",
		kind: "review-reject",
		reviewDecision: "reject",
	},
	{
		label: "request_changes review output",
		kind: "review-request-changes",
		reviewDecision: "request_changes",
	},
	{
		label: "abstain review output",
		kind: "review-abstain",
		reviewDecision: "abstain",
	},
	{
		label: "malformed review output",
		kind: "review-malformed",
	},
	{ label: "failed deterministic acceptance", kind: "failed-acceptance" },
	{ label: "cancelled implementer", kind: "cancelled" },
	{
		label: "failed implementer provider execution",
		kind: "provider-failure",
	},
];

function git(cwd: string, args: readonly string[], input?: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		input,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function rootSnapshot(root: string): RootSnapshot {
	return {
		head: git(root, ["rev-parse", "HEAD"]),
		tree: git(root, ["rev-parse", "HEAD^{tree}"]),
		commitCount: git(root, ["rev-list", "--count", "HEAD"]),
		status: git(root, ["status", "--porcelain"]),
	};
}

function expectRootUnchanged(root: string, baseline: RootSnapshot): void {
	expect(rootSnapshot(root)).toEqual(baseline);
}

function candidateArtifact(
	baseSha: string,
	candidateCommitSha: string,
	candidateRef: string,
	candidateTreeSha: string,
): WorkspaceCandidateArtifact {
	const candidateDigest = DIGEST(`candidate:${candidateCommitSha}`);
	return {
		schemaVersion: 1,
		candidateId: "root-invariant-candidate",
		runId: "root-invariant-implementer",
		attempt: 1,
		candidateKey: "root-invariant-candidate:root-invariant-implementer:1",
		candidateRef,
		baseSha,
		candidateCommitSha,
		commitDigest: DIGEST(`commit:${candidateCommitSha}`),
		treeDigest: DIGEST(`tree:${candidateTreeSha}`),
		patchDigest: DIGEST(`patch:${candidateCommitSha}`),
		changedFilesDigest: DIGEST("candidate.txt"),
		candidateDigest,
	};
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "buildplane-root-invariant-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "root-invariant@test.invalid"]);
	git(root, ["config", "user.name", "Root Invariant Test"]);
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["add", "base.txt"]);
	git(root, ["commit", "-qm", "base"]);

	const baseSha = git(root, ["rev-parse", "HEAD"]);
	const rootRef = git(root, ["symbolic-ref", "HEAD"]);
	const candidateBlobSha = git(
		root,
		["hash-object", "-w", "--stdin"],
		"candidate\n",
	);
	const baseTreeEntries = git(root, ["ls-tree", baseSha]);
	const candidateTreeSha = git(
		root,
		["mktree"],
		`${baseTreeEntries}\n100644 blob ${candidateBlobSha}\tcandidate.txt\n`,
	);
	const candidateCommitSha = git(
		root,
		["commit-tree", candidateTreeSha, "-p", baseSha],
		"candidate\n",
	);
	const candidateRef =
		"refs/buildplane/candidates/root-invariant-candidate/root-invariant-implementer/1";
	git(root, ["update-ref", candidateRef, candidateCommitSha]);

	return {
		root,
		baseSha,
		rootRef,
		candidate: candidateArtifact(
			baseSha,
			candidateCommitSha,
			candidateRef,
			candidateTreeSha,
		),
	};
}

function packet(id: string, role: UnitPacket["execution_role"]): UnitPacket {
	return {
		unit: {
			id,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "governed",
		},
		execution: { command: "true", args: [] },
		execution_role: role,
		verification: { requiredOutputs: [] },
		provenance_ref: "event://admission/root-invariant",
	};
}

function strategy(): StrategyPacket {
	return {
		id: "root-invariant-strategy",
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

function governedDispatch(baseSha: string): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: "root-invariant-implementer",
		workflowId: "root-invariant-workflow",
		workflowRevision: "root-invariant-revision",
		unitId: "implement",
		attempt: 1,
		provenanceRef: "event://admission/root-invariant",
		dispatchEnvelopeRef: "event://dispatch/root-invariant",
		envelopeDigest: DIGEST("envelope"),
		baseCommitSha: baseSha,
		repositoryBindingDigest: DIGEST("repository-binding"),
		ledgerAuthorityRealmDigest: DIGEST("ledger-authority-realm"),
		governedPacketDigest: DIGEST("governed-packet"),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: DIGEST("capability-bundle"),
		acceptanceContractDigest: DIGEST("acceptance-contract"),
		policyDigest: DIGEST("policy"),
		contextManifestDigest: DIGEST("context"),
		workerManifestDigest: DIGEST("worker"),
		sandboxProfileDigest: DIGEST("sandbox"),
		budget: {},
		idempotencyKey: "dispatch:root-invariant:1",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2099-07-17T12:00:00Z",
		expiresAt: "2099-07-17T12:15:00Z",
	};
}

function acceptance(
	candidate: WorkspaceCandidateArtifact,
	outcome: CandidateAcceptanceRecord["outcome"],
): CandidateAcceptanceRecord {
	return {
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		acceptanceContractDigest: DIGEST("acceptance-contract"),
		acceptanceRef: "event://candidate-acceptance/root-invariant",
		outcome,
	};
}

function reviewerResult(output: string): ReadOnlyCandidateReviewResult {
	return {
		run: { id: "root-invariant-reviewer", unitId: "review", status: "passed" },
		receipt: {
			command: "review",
			args: [],
			cwd: "/read-only/candidate",
			startedAt: "2099-07-17T12:00:00Z",
			completedAt: "2099-07-17T12:00:01Z",
			exitCode: 0,
			stdout: output,
			stderr: "",
			outputChecks: [],
		},
	};
}

function reviewOutputForScenario(
	scenario: Scenario,
	candidate: WorkspaceCandidateArtifact,
): string {
	if (scenario.kind === "review-malformed") {
		return JSON.stringify({ decision: "approve" });
	}
	if (!scenario.reviewDecision) {
		return "{}";
	}
	return JSON.stringify({
		schemaVersion: 1,
		candidateDigest: candidate.candidateDigest,
		decision: scenario.reviewDecision,
		findings: [],
		confidence: 0.9,
		reviewerManifestDigest: DIGEST("reviewer"),
	});
}

function promotionCandidate(fixture: Fixture): CandidateArtifactProjection {
	return {
		...fixture.candidate,
		schemaVersion: 2,
		unitId: "implement",
		workflowId: "root-invariant-workflow",
		provenanceRef: "event://admission/root-invariant",
		envelopeDigest: DIGEST("envelope"),
		acceptanceContractDigest: DIGEST("acceptance-contract"),
		actionEvidenceVersion: "sealed_v3",
		actionReceiptSetRef: "event://action-receipt-set/root-invariant",
		actionReceiptSetDigest: DIGEST("action-receipt-set"),
		candidateCreatedRef: "event://candidate-created/root-invariant",
		createdAt: "2099-07-17T12:00:00Z",
	};
}

function promotionVerdict(
	candidate: CandidateArtifactProjection,
	decision: ReviewDecisionV1,
): ReviewVerdictV1 {
	return {
		schemaVersion: 1,
		candidateDigest: candidate.candidateDigest,
		decision,
		findings: [],
		confidence: 0.9,
		reviewerManifestDigest: DIGEST("reviewer"),
	};
}

function regeneratedPromotionCandidate(
	fixture: Fixture,
	candidate: CandidateArtifactProjection,
): CandidateArtifactProjection {
	const regeneratedBlobSha = git(
		fixture.root,
		["hash-object", "-w", "--stdin"],
		"candidate regenerated after review evidence\n",
	);
	const baseTreeEntries = git(fixture.root, ["ls-tree", fixture.baseSha]);
	const regeneratedTreeSha = git(
		fixture.root,
		["mktree"],
		`${baseTreeEntries}\n100644 blob ${regeneratedBlobSha}\tcandidate.txt\n`,
	);
	const regeneratedCommitSha = git(
		fixture.root,
		["commit-tree", regeneratedTreeSha, "-p", fixture.baseSha],
		"candidate regenerated after review evidence\n",
	);
	const regeneratedRef =
		"refs/buildplane/candidates/root-invariant-candidate/root-invariant-implementer/2";
	git(fixture.root, ["update-ref", regeneratedRef, regeneratedCommitSha]);

	return {
		...candidate,
		candidateId: "root-invariant-candidate-regenerated",
		attempt: 2,
		candidateKey:
			"root-invariant-candidate-regenerated:root-invariant-implementer:2",
		candidateRef: regeneratedRef,
		candidateCommitSha: regeneratedCommitSha,
		commitDigest: DIGEST(`commit:${regeneratedCommitSha}`),
		treeDigest: DIGEST(`tree:${regeneratedTreeSha}`),
		patchDigest: DIGEST(`patch:${regeneratedCommitSha}`),
		changedFilesDigest: DIGEST("candidate.txt:regenerated"),
		candidateDigest: DIGEST(`candidate:${regeneratedCommitSha}`),
		candidateCreatedRef: "event://candidate-created/root-invariant-regenerated",
	};
}

interface PromotionGateScenario {
	readonly label: string;
	readonly reviewDecision?: ReviewDecisionV1;
	readonly malformedReview?: boolean;
	readonly acceptanceOutcome?: CandidateAcceptanceRecord["outcome"];
	readonly candidateRecorded?: boolean;
	readonly candidateRegenerated?: boolean;
	readonly expectedError: RegExp;
}

const PROMOTION_GATE_SCENARIOS: readonly PromotionGateScenario[] = [
	{
		label: "a reject ReviewVerdictV1",
		reviewDecision: "reject",
		expectedError: /affirmative structured review verdict/i,
	},
	{
		label: "a request_changes ReviewVerdictV1",
		reviewDecision: "request_changes",
		expectedError: /affirmative structured review verdict/i,
	},
	{
		label: "an abstain ReviewVerdictV1",
		reviewDecision: "abstain",
		expectedError: /affirmative structured review verdict/i,
	},
	{
		label: "a malformed review output",
		malformedReview: true,
		expectedError: /candidate promotion contract is invalid/i,
	},
	{
		label: "a failed deterministic acceptance",
		acceptanceOutcome: "rejected",
		expectedError: /deterministic candidate acceptance/i,
	},
	{
		label: "a cancelled candidate run with no candidate artifact",
		candidateRecorded: false,
		expectedError: /no immutable candidate artifact/i,
	},
	{
		label:
			"a candidate regenerated after deterministic acceptance, review, and promotion evidence",
		candidateRegenerated: true,
		expectedError: /same immutable candidate/i,
	},
];

function promotionInput(
	fixture: Fixture,
	candidate: CandidateArtifactProjection,
	scenario: PromotionGateScenario,
): RecordCandidatePromotionInput {
	const acceptanceRef = "event://candidate-acceptance/root-invariant";
	const reviewRef = "event://candidate-review/root-invariant";
	return {
		runId: candidate.runId,
		decision: {
			schemaVersion: 1,
			candidateDigest: candidate.candidateDigest,
			baseCommitSha: candidate.baseSha,
			targetRef: fixture.rootRef,
			envelopeDigest: candidate.envelopeDigest ?? "",
			acceptanceRef,
			reviewRefs: [reviewRef],
			decision: "promote",
			authority: "operator@example.test",
			decidedBy: "operator@example.test",
			decidedAt: "2099-07-17T12:01:00Z",
			idempotencyKey: "promotion:root-invariant:1",
		},
		acceptance: {
			candidateDigest: candidate.candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			acceptanceContractDigest: candidate.acceptanceContractDigest,
			acceptanceRef,
			outcome: scenario.acceptanceOutcome ?? "passed",
		},
		review: {
			candidateDigest: candidate.candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			reviewRef,
			verdict: scenario.malformedReview
				? ({ decision: "approve" } as unknown as ReviewVerdictV1)
				: promotionVerdict(candidate, scenario.reviewDecision ?? "approve"),
		},
	};
}

function createPromotionGateHarness(
	fixture: Fixture,
	candidate: CandidateArtifactProjection | null,
): {
	readonly orchestrator: ReturnType<typeof createBuildplaneOrchestrator>;
	readonly targetMutationCalls: () => number;
	readonly decisionWrites: () => number;
} {
	let targetMutationCalls = 0;
	let decisionWrites = 0;
	const attemptTargetMutation = () => {
		targetMutationCalls += 1;
		git(fixture.root, [
			"update-ref",
			fixture.rootRef,
			fixture.candidate.candidateCommitSha,
			fixture.baseSha,
		]);
	};
	const workspace: BuildplaneWorkspacePort = {
		governedWorkspaceBoundary: "pinned-governed-git-v1",
		assertRunnableRepository: () => ({
			headSha: git(fixture.root, ["rev-parse", "HEAD"]),
		}),
		checkWorktreeClean: () => true,
		prepareWorkspace: () => ({ path: fixture.root, headSha: fixture.baseSha }),
		deleteWorkspace: () => ({ deleted: true }),
		promoteWorkspaceCandidate: () => {
			attemptTargetMutation();
			throw new Error("unexpected generic candidate promotion");
		},
		promoteGovernedWorkspaceCandidate: () => {
			attemptTargetMutation();
			throw new Error("unexpected governed candidate promotion");
		},
	};
	const promotionDecisionPort: CandidatePromotionDecisionPort = {
		async recordPromotionDecision() {
			decisionWrites += 1;
			return "event://promotion-decision/root-invariant";
		},
		async recordPromotionResult() {
			throw new Error("invalid promotion must not record a terminal result");
		},
	};
	const storage = {
		getCandidateArtifact: () => candidate,
	} as unknown as BuildplaneStoragePort;
	const orchestrator = createBuildplaneOrchestrator({
		projectRoot: fixture.root,
		storage,
		runtime: {} as BuildplaneRuntimePort,
		policy: {} as BuildplanePolicyPort,
		workspace,
		admissionStore: null,
		candidatePromotionDecisionPort: promotionDecisionPort,
	});
	return {
		orchestrator,
		targetMutationCalls: () => targetMutationCalls,
		decisionWrites: () => decisionWrites,
	};
}

describe("governed candidate root invariants", () => {
	it.each(
		SCENARIOS,
	)("leaves HEAD, tree, commit count, and worktree unchanged for $label", async (scenario) => {
		const fixture = createFixture();
		try {
			const baseline = rootSnapshot(fixture.root);
			const reviewerAttempt = vi.fn(
				async (): Promise<ReadOnlyCandidateReviewResult> => {
					// If an untrusted callback ever becomes reachable before the
					// native reviewer/evidence binding exists, it could advance the
					// target ref. The governed strategy must reject before this runs.
					git(fixture.root, [
						"update-ref",
						fixture.rootRef,
						fixture.candidate.candidateCommitSha,
						fixture.baseSha,
					]);
					return reviewerResult(
						reviewOutputForScenario(scenario, fixture.candidate),
					);
				},
			);
			const candidateResult = vi.fn(async (): Promise<RunPacketResult> => {
				if (scenario.kind === "cancelled") {
					return {
						run: {
							id: "root-invariant-implementer",
							unitId: "implement",
							status: "cancelled",
						},
					};
				}
				if (scenario.kind === "provider-failure") {
					// A provider failure has no immutable candidate and therefore cannot
					// reach review or promotion. The root snapshot below guards against
					// accidental target mutation while the failed result is handled.
					return {
						run: {
							id: "root-invariant-implementer",
							unitId: "implement",
							status: "failed",
						},
					};
				}
				return {
					run: {
						id: "root-invariant-implementer",
						unitId: "implement",
						status: "passed",
					},
					candidate: fixture.candidate,
					candidateAcceptance: acceptance(
						fixture.candidate,
						scenario.kind === "failed-acceptance" ? "rejected" : "passed",
					),
				};
			});
			const orchestrator: StrategyOrchestrator = {
				runPacketAsync: async () => {
					throw new Error("governed strategy must not use ambient execution");
				},
				runCandidatePacketAsync: candidateResult,
				runReadOnlyCandidateReviewAsync: reviewerAttempt,
				runGraphAsync: async () => {
					throw new Error("governed strategy must not dispatch a graph");
				},
			};

			const result = await runStrategy(strategy(), orchestrator, undefined, {
				lane: "governed-candidate",
				governedDispatch: governedDispatch(fixture.baseSha),
			});

			expect(result.outcome).toBe("failed");
			expect(result.mergeDecision.outcome).toBe("rejected");
			expect(candidateResult).toHaveBeenCalledTimes(1);
			expect(reviewerAttempt).not.toHaveBeenCalled();
			if (scenario.kind === "provider-failure") {
				expect(result.candidate).toBeUndefined();
				expect(result.candidateAcceptance).toBeUndefined();
				expect(result.reviewVerdict).toBeUndefined();
				expect(result.reviewRecord).toBeUndefined();
			}
			if (scenario.kind === "failed-acceptance") {
				expect(result.mergeDecision.reasons.join(" ")).toMatch(
					/deterministic acceptance/i,
				);
			} else if (
				scenario.kind === "cancelled" ||
				scenario.kind === "provider-failure"
			) {
				expect(result.mergeDecision.reasons.join(" ")).toMatch(
					/implementer did not pass/i,
				);
			} else {
				expect(result.mergeDecision.reasons.join(" ")).toMatch(
					/native-verified reviewer dispatch/i,
				);
			}
			expectRootUnchanged(fixture.root, baseline);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("candidate-promotion semantic root invariants", () => {
	it.each(
		PROMOTION_GATE_SCENARIOS,
	)("does not select a promotion effect for $label", async (scenario) => {
		const fixture = createFixture();
		try {
			const candidate = promotionCandidate(fixture);
			const recordedCandidate = scenario.candidateRegenerated
				? regeneratedPromotionCandidate(fixture, candidate)
				: candidate;
			const harness = createPromotionGateHarness(
				fixture,
				scenario.candidateRecorded === false ? null : recordedCandidate,
			);
			const baseline = rootSnapshot(fixture.root);
			const input = promotionInput(fixture, candidate, scenario);
			if (scenario.candidateRegenerated) {
				expect(recordedCandidate.candidateDigest).not.toBe(
					input.decision.candidateDigest,
				);
				expect(recordedCandidate.candidateDigest).not.toBe(
					input.acceptance.candidateDigest,
				);
				expect(recordedCandidate.candidateDigest).not.toBe(
					input.review.candidateDigest,
				);
				expect(recordedCandidate.candidateDigest).not.toBe(
					input.review.verdict.candidateDigest,
				);
			}

			await expect(
				harness.orchestrator.recordCandidatePromotion(input),
			).rejects.toThrow(scenario.expectedError);

			expect(harness.decisionWrites()).toBe(0);
			expect(harness.targetMutationCalls()).toBe(0);
			expectRootUnchanged(fixture.root, baseline);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
