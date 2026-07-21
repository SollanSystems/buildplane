import type { EventBus } from "./events.js";
import type { GraphResult, UnitGraph } from "./graph.js";
import { carriesGovernanceFields } from "./packet.js";
import type {
	CandidateAcceptanceRecord,
	CandidateReviewEvidenceInput,
	CandidateReviewRecord,
	GovernedDispatchLineageV3,
	RunPacketOptions,
} from "./ports.js";
import type {
	PolicyDecision,
	RunPacketResult,
	UnitPacket,
	WorkspaceCandidateArtifact,
} from "./run-loop.js";
import {
	canonicalSha256Digest,
	parseReviewVerdictV1,
	type ReviewVerdictV1,
} from "./trust-spine.js";
import type { MergeDecision, StrategyPacket, StrategyResult } from "./types.js";

/**
 * A governed reviewer may return a parsed closed verdict directly. The
 * text receipt remains a compatibility projection for older read-only review
 * ports, never the authoritative source when this typed value is present.
 */
export interface ReadOnlyCandidateReviewResult extends RunPacketResult {
	readonly reviewVerdict?: ReviewVerdictV1;
}

export interface StrategyOrchestrator {
	runPacketAsync(
		packet: UnitPacket,
		eventBus?: EventBus,
		runOptions?: RunPacketOptions,
	): Promise<RunPacketResult>;
	/**
	 * Present only when the kernel can freeze isolated output without merging it.
	 * Its absence makes governed candidate execution fail closed.
	 */
	runCandidatePacketAsync?(
		packet: UnitPacket,
		candidateIdentity: {
			readonly candidateId: string;
			readonly attempt: number;
		},
		eventBus?: EventBus,
		governedDispatch?: GovernedDispatchLineageV3,
	): Promise<RunPacketResult>;
	/**
	 * Compatibility seam for the eventual native-verified governed reviewer
	 * dispatch. It is deliberately not authority-bearing today: governed
	 * candidate strategies fail closed before invoking it until the kernel can
	 * bind a signed reviewer dispatch, immutable candidate view, and recorded
	 * review evidence in one verified transaction. The kernel deliberately has
	 * no fallback to `runPacketAsync` for this role.
	 */
	runReadOnlyCandidateReviewAsync?(
		packet: UnitPacket,
		candidate: WorkspaceCandidateArtifact,
		eventBus?: EventBus,
	): Promise<ReadOnlyCandidateReviewResult>;
	recordCandidateReview?(
		input: CandidateReviewEvidenceInput,
	): Promise<CandidateReviewRecord>;
	runGraphAsync(
		graph: UnitGraph,
		eventBus?: EventBus,
		options?: { readonly lane?: "raw-legacy" },
	): Promise<GraphResult>;
}

/**
 * Strategy execution is intentionally lane-explicit. The raw lane remains an
 * acknowledged unsafe compatibility route for single strategies, but raw
 * review strategies fail closed because graph execution cannot guarantee
 * pre-promotion review. The governed lane refuses to fall back to graph
 * auto-merge if its candidate transaction/evidence seams are unavailable. A
 * governed strategy must carry the V3 facts produced by a verified dispatch
 * envelope; it cannot accept a V1 candidate lineage because that let callers
 * invent an actionReceiptDigest before any action existed.
 */
export type StrategyExecutionOptions =
	| {
			readonly lane?: undefined;
			readonly governedDispatch?: never;
	  }
	| {
			readonly lane: "raw-legacy";
			readonly governedDispatch?: never;
	  }
	| {
			readonly lane: "governed-candidate";
			readonly governedDispatch: GovernedDispatchLineageV3;
	  };

const GOVERNED_DISPATCH_V3_KEYS = new Set<string>([
	"schemaVersion",
	"runId",
	"workflowId",
	"workflowRevision",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeRef",
	"envelopeDigest",
	"baseCommitSha",
	"repositoryBindingDigest",
	"ledgerAuthorityRealmDigest",
	"governedPacketDigest",
	"executionRole",
	"commitMode",
	"trustTier",
	"capabilityBundleDigest",
	"acceptanceContractDigest",
	"policyDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"budget",
	"idempotencyKey",
	"authorityActor",
	"actionEvidenceVersion",
	"issuedAt",
	"expiresAt",
]);

function governedDispatchV3Failure(
	lineage: GovernedDispatchLineageV3 | undefined,
): string | null {
	if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
		return "governed candidate strategy requires a verified GovernedDispatchLineageV3";
	}
	const record = lineage as unknown as Record<string, unknown>;
	if (
		Object.hasOwn(record, "actionReceiptDigest") ||
		Object.keys(record).some((key) => !GOVERNED_DISPATCH_V3_KEYS.has(key)) ||
		Object.keys(record).length !== GOVERNED_DISPATCH_V3_KEYS.size
	) {
		return "governed candidate strategy requires a closed V3 dispatch and rejects caller-provided action receipt evidence";
	}
	if (
		lineage.schemaVersion !== 3 ||
		lineage.executionRole !== "implementer" ||
		lineage.commitMode !== "atomic" ||
		lineage.trustTier !== "governed" ||
		lineage.actionEvidenceVersion !== "sealed_v3"
	) {
		return "governed candidate strategy requires an implementer atomic GovernedDispatchLineageV3 with sealed_v3 activity-claim action evidence";
	}
	if (!Number.isSafeInteger(lineage.attempt) || lineage.attempt < 1) {
		return "governed candidate strategy requires a positive V3 dispatch attempt";
	}
	for (const [field, value] of [
		["runId", lineage.runId],
		["workflowId", lineage.workflowId],
		["workflowRevision", lineage.workflowRevision],
		["unitId", lineage.unitId],
		["provenanceRef", lineage.provenanceRef],
		["dispatchEnvelopeRef", lineage.dispatchEnvelopeRef],
		["baseCommitSha", lineage.baseCommitSha],
		["idempotencyKey", lineage.idempotencyKey],
		["authorityActor", lineage.authorityActor],
		["issuedAt", lineage.issuedAt],
		["expiresAt", lineage.expiresAt],
	] as const) {
		if (typeof value !== "string" || value.trim().length === 0) {
			return `governed candidate strategy requires V3 dispatch ${field}`;
		}
	}
	try {
		canonicalSha256Digest(lineage.envelopeDigest);
		canonicalSha256Digest(lineage.repositoryBindingDigest);
		canonicalSha256Digest(lineage.ledgerAuthorityRealmDigest);
		canonicalSha256Digest(lineage.governedPacketDigest);
		canonicalSha256Digest(lineage.capabilityBundleDigest);
		canonicalSha256Digest(lineage.acceptanceContractDigest);
		canonicalSha256Digest(lineage.policyDigest);
		canonicalSha256Digest(lineage.contextManifestDigest);
		canonicalSha256Digest(lineage.workerManifestDigest);
		canonicalSha256Digest(lineage.sandboxProfileDigest);
	} catch {
		return "governed candidate strategy requires canonical V3 dispatch digests";
	}
	return null;
}

function governedStrategyLineageFailure(
	options: StrategyExecutionOptions,
): string | null {
	const untrustedOptions = options as {
		readonly candidateGovernance?: unknown;
		readonly actionReceiptDigest?: unknown;
	};
	const legacyLineage = untrustedOptions.candidateGovernance;
	if (legacyLineage !== undefined) {
		return "governed candidate strategy rejects legacy CandidateGovernanceLineage and caller-provided actionReceiptDigest; use a verified GovernedDispatchLineageV3";
	}
	if (untrustedOptions.actionReceiptDigest !== undefined) {
		return "governed candidate strategy rejects a caller-provided action-receipt digest (actionReceiptDigest); V3 action evidence is sealed only after the kernel records effects";
	}
	return governedDispatchV3Failure(options.governedDispatch);
}

/**
 * Execute a StrategyPacket using the provided orchestrator.
 *
 * Supports "single" and "implement-then-review" modes. Other modes
 * are not yet implemented and will throw.
 */
export async function runStrategy(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
	options: StrategyExecutionOptions = {},
): Promise<StrategyResult> {
	if (options.lane !== "raw-legacy" && options.lane !== "governed-candidate") {
		return failedCandidateStrategy(
			strategy,
			"strategy execution requires an explicit lane; use raw-legacy only for acknowledged unsafe execution or governed-candidate for the immutable candidate transaction",
		);
	}
	if (
		options.lane === "raw-legacy" &&
		strategy.children.some((child) => carriesGovernanceFields(child.packet))
	) {
		return failedCandidateStrategy(
			strategy,
			"strategy packets carrying governance fields cannot execute in the raw-legacy lane; use the immutable candidate transaction",
		);
	}
	switch (strategy.mode) {
		case "single":
			if (options.lane === "governed-candidate") {
				return {
					strategyId: strategy.id,
					mode: strategy.mode,
					outcome: "failed",
					childResults: new Map(),
					mergeDecision: {
						policy: strategy.mergePolicy,
						outcome: "rejected",
						reasons: [
							"single strategy cannot execute in the governed candidate lane until it has a candidate transaction path",
						],
					},
				};
			}
			return runSingleMode(strategy, orchestrator, eventBus);
		case "implement-then-review":
			return runImplementThenReviewMode(
				strategy,
				orchestrator,
				eventBus,
				options,
			);
		default:
			throw new Error(
				`Strategy mode '${strategy.mode}' is not yet implemented`,
			);
	}
}

async function runSingleMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
): Promise<StrategyResult> {
	if (strategy.children.length !== 1) {
		throw new Error(
			`Strategy mode 'single' requires exactly 1 child, got ${strategy.children.length}`,
		);
	}

	const child = strategy.children[0];
	const packetResult = await orchestrator.runPacketAsync(
		child.packet,
		eventBus,
		{ trustLane: "unsafe" },
	);

	const childResults = new Map<string, RunPacketResult>();
	childResults.set(child.packet.unit.id, packetResult);

	const accepted = packetResult.run.status === "passed";

	const mergeDecision: MergeDecision = {
		policy: "direct",
		outcome: accepted ? "accepted" : "rejected",
		reasons: accepted ? ["single child passed"] : ["single child did not pass"],
	};

	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: accepted ? "passed" : "failed",
		childResults,
		winnerRunId: accepted ? packetResult.run.id : undefined,
		mergeDecision,
	};
}

const MAX_REVIEW_ROUNDS = 2;

/**
 * A structural callback cannot prove who dispatched the reviewer, what
 * candidate view it received, or that its evidence was atomically recorded
 * by the signed tape. Keep the candidate transaction non-promotable until a
 * native authority-bearing reviewer-dispatch activity replaces this seam.
 *
 * The explicit nullable return preserves the dormant, already-validated review
 * flow below for that future integration without treating an arbitrary callback
 * or persistence port as an authorization boundary today.
 */
function governedReviewerAuthorityFailure(): string | null {
	return "governed candidate review is blocked until a native-verified reviewer dispatch, immutable candidate-view, and review-evidence binding are configured";
}

function syntheticResult(
	graphResult: GraphResult,
	unitId: string,
): RunPacketResult {
	const node = graphResult.nodes.find((n) => n.unitId === unitId);
	const runId = node?.runId ?? "unknown";
	const status = node?.status === "passed" ? "passed" : "failed";

	const decision: PolicyDecision | undefined =
		node?.decisionReasons && node.decisionReasons.length > 0
			? status === "passed"
				? {
						kind: "advance-run" as const,
						outcome: "approved" as const,
						reasons: [...node.decisionReasons],
					}
				: {
						kind: "reject-run" as const,
						outcome: "rejected" as const,
						reasons: [...node.decisionReasons],
					}
			: undefined;

	return {
		run: { id: runId, unitId, status },
		decision,
	};
}

async function runImplementThenReviewMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
	options: StrategyExecutionOptions = {},
): Promise<StrategyResult> {
	if (options.lane === "raw-legacy") {
		return failedCandidateStrategy(
			strategy,
			"raw review strategies are blocked because they cannot guarantee pre-promotion review",
		);
	}
	const runCandidatePacketAsync = orchestrator.runCandidatePacketAsync;
	if (options.lane === "governed-candidate") {
		const lineageFailure = governedStrategyLineageFailure(options);
		if (lineageFailure) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(),
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [lineageFailure],
				},
			};
		}
		if (!runCandidatePacketAsync) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(),
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [
						"governed candidate strategy is unavailable: immutable candidate execution was not configured",
					],
				},
			};
		}
		return runCandidateImplementThenReviewMode(
			strategy,
			orchestrator,
			runCandidatePacketAsync,
			eventBus,
			options.governedDispatch,
		);
	}
	// The raw lane is deliberate and never selected merely because an adapter
	// happens to expose candidate primitives.
	return runLegacyImplementThenReviewMode(strategy, orchestrator, eventBus);
}

function validateCandidateAcceptance(
	candidate: import("./run-loop.js").WorkspaceCandidateArtifact,
	acceptance: CandidateAcceptanceRecord | undefined,
): string | null {
	if (!acceptance) {
		return "candidate has no persisted deterministic acceptance record";
	}
	let candidateDigest: string;
	let acceptanceDigest: string;
	try {
		candidateDigest = canonicalSha256Digest(candidate.candidateDigest);
		acceptanceDigest = canonicalSha256Digest(acceptance.candidateDigest);
	} catch {
		return "candidate acceptance does not carry a canonical candidate digest";
	}
	if (candidateDigest !== acceptanceDigest) {
		return "candidate acceptance digest does not match the immutable candidate";
	}
	if (
		typeof acceptance.candidateCommitSha !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(acceptance.candidateCommitSha) ||
		acceptance.candidateCommitSha.toLowerCase() !==
			candidate.candidateCommitSha.toLowerCase()
	) {
		return "candidate acceptance commit does not match the immutable candidate";
	}
	if (
		typeof acceptance.acceptanceRef !== "string" ||
		acceptance.acceptanceRef.trim().length === 0
	) {
		return "candidate acceptance record has no durable reference";
	}
	if (acceptance.outcome !== "passed") {
		return "candidate deterministic acceptance did not pass";
	}
	return null;
}

function validateCandidateReviewRecord(
	candidate: import("./run-loop.js").WorkspaceCandidateArtifact,
	expectedVerdict: ReviewVerdictV1,
	record: CandidateReviewRecord,
): string | null {
	let candidateDigest: string;
	let recordDigest: string;
	try {
		candidateDigest = canonicalSha256Digest(candidate.candidateDigest);
		recordDigest = canonicalSha256Digest(record.candidateDigest);
	} catch {
		return "persisted review record does not carry a canonical candidate digest";
	}
	if (recordDigest !== candidateDigest) {
		return "persisted review record candidate digest does not match the immutable candidate";
	}
	if (
		typeof record.candidateCommitSha !== "string" ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(record.candidateCommitSha) ||
		record.candidateCommitSha.toLowerCase() !==
			candidate.candidateCommitSha.toLowerCase()
	) {
		return "persisted review record commit does not match the immutable candidate";
	}
	if (
		typeof record.reviewRef !== "string" ||
		record.reviewRef.trim().length === 0
	) {
		return "persisted review record has no durable reference";
	}
	let persistedVerdict: ReviewVerdictV1;
	try {
		persistedVerdict = parseReviewVerdictV1(record.verdict);
	} catch {
		return "persisted review record does not contain a valid ReviewVerdictV1";
	}
	if (JSON.stringify(persistedVerdict) !== JSON.stringify(expectedVerdict)) {
		return "persisted review record verdict does not match the reviewed candidate verdict";
	}
	return null;
}

function parseCandidateBoundReviewVerdict(
	result: ReadOnlyCandidateReviewResult,
	candidateDigest: string,
):
	| { readonly verdict: ReviewVerdictV1; readonly reason?: never }
	| { readonly verdict?: never; readonly reason: string } {
	let raw: unknown;
	if (result.reviewVerdict !== undefined) {
		raw = result.reviewVerdict;
	} else {
		const stdout = result.receipt?.stdout.trim();
		if (!stdout) {
			return {
				reason:
					"reviewer produced no ReviewVerdictV1 JSON; semantic approval is required",
			};
		}
		try {
			raw = JSON.parse(stdout);
		} catch {
			return {
				reason:
					"reviewer output is not a complete ReviewVerdictV1 JSON document",
			};
		}
	}

	let verdict: ReviewVerdictV1;
	try {
		verdict = parseReviewVerdictV1(raw);
	} catch (error) {
		return {
			reason: `reviewer verdict is not a valid ReviewVerdictV1: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let canonicalCandidateDigest: string;
	try {
		canonicalCandidateDigest = canonicalSha256Digest(candidateDigest);
	} catch {
		return {
			reason: "candidate does not carry a canonical SHA-256 digest",
		};
	}

	if (verdict.candidateDigest !== canonicalCandidateDigest) {
		return {
			reason:
				"review verdict candidateDigest does not match the immutable candidate",
		};
	}
	if (verdict.decision !== "approve") {
		return {
			reason: `review verdict decision '${verdict.decision}' is not promotion-eligible`,
		};
	}

	return { verdict };
}

function failedCandidateStrategy(
	strategy: StrategyPacket,
	reason: string,
): StrategyResult {
	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: "failed",
		childResults: new Map(),
		mergeDecision: {
			policy: strategy.mergePolicy,
			outcome: "rejected",
			reasons: [reason],
		},
	};
}

async function runCandidateImplementThenReviewMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	runCandidatePacketAsync: NonNullable<
		StrategyOrchestrator["runCandidatePacketAsync"]
	>,
	eventBus?: EventBus,
	governedDispatch?: GovernedDispatchLineageV3,
): Promise<StrategyResult> {
	const implementer = strategy.children.find((c) => c.role === "implementer");
	const reviewer = strategy.children.find((c) => c.role === "reviewer");

	if (!implementer || !reviewer || strategy.children.length !== 2) {
		throw new Error(
			"Strategy mode 'implement-then-review' requires exactly 2 children: one 'implementer' and one 'reviewer'",
		);
	}
	if (implementer.packet.execution_role !== "implementer") {
		return failedCandidateStrategy(
			strategy,
			"governed implementer child must carry execution_role 'implementer'",
		);
	}
	if (reviewer.packet.execution_role !== "reviewer") {
		return failedCandidateStrategy(
			strategy,
			"governed reviewer child must carry execution_role 'reviewer'",
		);
	}
	const runReadOnlyCandidateReviewAsync =
		orchestrator.runReadOnlyCandidateReviewAsync;
	if (!runReadOnlyCandidateReviewAsync) {
		return failedCandidateStrategy(
			strategy,
			"governed review requires a read-only candidate review executor; ambient worker execution is not permitted",
		);
	}

	const allRoundResults: Array<Map<string, RunPacketResult>> = [];
	let currentImplementerPacket = implementer.packet;

	for (let round = 0; round < MAX_REVIEW_ROUNDS; round += 1) {
		const implementerResult = await runCandidatePacketAsync(
			currentImplementerPacket,
			{ candidateId: strategy.id, attempt: round + 1 },
			eventBus,
			governedDispatch,
		);
		const roundResults = new Map<string, RunPacketResult>();
		roundResults.set(implementer.packet.unit.id, implementerResult);

		if (
			implementerResult.run.status !== "passed" ||
			implementerResult.candidate === undefined
		) {
			allRoundResults.push(roundResults);
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(roundResults),
				rounds: allRoundResults,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [
						implementerResult.run.status === "passed"
							? "implementer did not produce an immutable candidate"
							: "implementer did not pass",
					],
				},
			};
		}

		const candidate = implementerResult.candidate;
		// Deterministic acceptance gates the semantic reviewer. A candidate that
		// failed checks must never consume a reviewer/model action or make its
		// way to a semantic approval path.
		const acceptanceReason = validateCandidateAcceptance(
			candidate,
			implementerResult.candidateAcceptance,
		);
		if (acceptanceReason) {
			allRoundResults.push(roundResults);
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(roundResults),
				rounds: allRoundResults,
				candidate,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [acceptanceReason],
				},
			};
		}

		// A candidate and passed deterministic acceptance are safe to retain for
		// diagnostics, but cannot authorize an unbound reviewer callback. In
		// particular, do not let a callback or its persistence companion mutate a
		// target, manufacture review evidence, or produce awaiting-promotion.
		const reviewerAuthorityFailure = governedReviewerAuthorityFailure();
		if (reviewerAuthorityFailure) {
			allRoundResults.push(roundResults);
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(roundResults),
				rounds: allRoundResults,
				candidate,
				candidateAcceptance: implementerResult.candidateAcceptance,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [reviewerAuthorityFailure],
				},
			};
		}

		const reviewerResult = await runReadOnlyCandidateReviewAsync(
			reviewer.packet,
			candidate,
			eventBus,
		);
		roundResults.set(reviewer.packet.unit.id, reviewerResult);
		allRoundResults.push(roundResults);

		let verdict =
			reviewerResult.run.status === "passed"
				? parseCandidateBoundReviewVerdict(
						reviewerResult,
						candidate.candidateDigest,
					)
				: {
						reason: "reviewer execution did not pass",
					};

		if (verdict.verdict) {
			const recordCandidateReview = orchestrator.recordCandidateReview;
			if (!recordCandidateReview) {
				verdict = {
					reason:
						"candidate review approval is not persisted: no signed review evidence recorder is configured",
				};
			} else {
				try {
					const reviewRecord = await recordCandidateReview({
						candidate,
						acceptance:
							implementerResult.candidateAcceptance as CandidateAcceptanceRecord,
						reviewerRunId: reviewerResult.run.id,
						verdict: verdict.verdict,
						reviewedAt: new Date().toISOString(),
					});
					const reviewRecordReason = validateCandidateReviewRecord(
						candidate,
						verdict.verdict,
						reviewRecord,
					);
					if (reviewRecordReason) {
						verdict = { reason: reviewRecordReason };
					} else {
						return {
							strategyId: strategy.id,
							mode: strategy.mode,
							outcome: "awaiting-promotion",
							childResults: new Map(roundResults),
							rounds: allRoundResults,
							winnerRunId: implementerResult.run.id,
							candidate,
							candidateAcceptance: implementerResult.candidateAcceptance,
							reviewVerdict: verdict.verdict,
							reviewRecord,
							mergeDecision: {
								policy: strategy.mergePolicy,
								outcome: "escalated",
								reasons: [
									"deterministic candidate acceptance and a persisted candidate-bound review approved; a signed promotion decision is required",
								],
								selectedCandidateId: canonicalSha256Digest(
									candidate.candidateDigest,
								),
							},
						};
					}
				} catch (error) {
					verdict = {
						reason: `candidate review evidence could not be persisted: ${
							error instanceof Error ? error.message : String(error)
						}`,
					};
				}
			}
		}

		if (round + 1 >= MAX_REVIEW_ROUNDS) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults: new Map(roundResults),
				rounds: allRoundResults,
				candidate,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [`${verdict.reason} after ${MAX_REVIEW_ROUNDS} round(s)`],
				},
			};
		}

		if (currentImplementerPacket.model) {
			currentImplementerPacket = {
				...currentImplementerPacket,
				model: {
					...currentImplementerPacket.model,
					systemPrompt:
						(currentImplementerPacket.model.systemPrompt ?? "") +
						`\n\nReviewer feedback from round ${round + 1}:\n${verdict.reason}\n\nPlease address the reviewer's concerns and try again.`,
				},
			};
		}
	}

	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: "failed",
		childResults:
			allRoundResults.length > 0
				? allRoundResults[allRoundResults.length - 1]
				: new Map(),
		rounds: allRoundResults,
		mergeDecision: {
			policy: strategy.mergePolicy,
			outcome: "rejected",
			reasons: ["maximum review rounds exhausted"],
		},
	};
}

async function runLegacyImplementThenReviewMode(
	strategy: StrategyPacket,
	orchestrator: StrategyOrchestrator,
	eventBus?: EventBus,
): Promise<StrategyResult> {
	const implementer = strategy.children.find((c) => c.role === "implementer");
	const reviewer = strategy.children.find((c) => c.role === "reviewer");

	if (!implementer || !reviewer || strategy.children.length !== 2) {
		throw new Error(
			"Strategy mode 'implement-then-review' requires exactly 2 children: one 'implementer' and one 'reviewer'",
		);
	}

	// Track results per round so earlier rounds are not overwritten
	const allRoundResults: Array<Map<string, RunPacketResult>> = [];

	// The implementer packet is mutated between rounds to inject reviewer feedback
	let currentImplementerPacket = implementer.packet;

	for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
		// Build a dependency graph: reviewer depends on implementer
		const graph: UnitGraph = {
			nodes: [
				{ ...currentImplementerPacket },
				{
					...reviewer.packet,
					dependsOn: [implementer.packet.unit.id],
				},
			],
			maxConcurrent: 1,
		};

		const graphResult = await orchestrator.runGraphAsync(graph, eventBus, {
			lane: "raw-legacy",
		});

		const implNode = graphResult.nodes.find(
			(n) => n.unitId === implementer.packet.unit.id,
		);
		const reviewNode = graphResult.nodes.find(
			(n) => n.unitId === reviewer.packet.unit.id,
		);

		// Store this round's results without overwriting previous rounds
		const roundResults = new Map<string, RunPacketResult>();
		roundResults.set(
			implementer.packet.unit.id,
			syntheticResult(graphResult, implementer.packet.unit.id),
		);
		roundResults.set(
			reviewer.packet.unit.id,
			syntheticResult(graphResult, reviewer.packet.unit.id),
		);
		allRoundResults.push(roundResults);

		// The final childResults always reflect the latest round
		const childResults = new Map(roundResults);

		const implPassed = implNode?.status === "passed";
		const reviewPassed = reviewNode?.status === "passed";

		if (!implPassed) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults,
				rounds: allRoundResults,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: ["implementer did not pass"],
				},
			};
		}

		if (reviewPassed) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "passed",
				childResults,
				rounds: allRoundResults,
				winnerRunId: implNode?.runId,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "accepted",
					reasons: ["implementer passed and reviewer approved"],
				},
			};
		}

		// Implementer passed, reviewer rejected — retry if rounds remain
		if (round + 1 >= MAX_REVIEW_ROUNDS) {
			return {
				strategyId: strategy.id,
				mode: strategy.mode,
				outcome: "failed",
				childResults,
				rounds: allRoundResults,
				mergeDecision: {
					policy: strategy.mergePolicy,
					outcome: "rejected",
					reasons: [`reviewer rejected after ${MAX_REVIEW_ROUNDS} round(s)`],
				},
			};
		}

		// Extract reviewer rejection reasons and feed them back to the implementer
		const reviewerResult = roundResults.get(reviewer.packet.unit.id);
		const rejectionReasons: string[] = [];
		if (reviewerResult?.decision?.reasons) {
			rejectionReasons.push(...reviewerResult.decision.reasons);
		}
		if (reviewNode?.runId) {
			rejectionReasons.push(
				`reviewer run ${reviewNode.runId} did not approve (round ${round + 1})`,
			);
		}

		const feedbackSuffix =
			rejectionReasons.length > 0
				? `\n\nReviewer feedback from round ${round + 1}:\n${rejectionReasons.join("\n")}\n\nPlease address the reviewer's concerns and try again.`
				: "";

		if (feedbackSuffix && currentImplementerPacket.model) {
			currentImplementerPacket = {
				...currentImplementerPacket,
				model: {
					...currentImplementerPacket.model,
					systemPrompt:
						(currentImplementerPacket.model.systemPrompt ?? "") +
						feedbackSuffix,
				},
			};
		}
	}

	// Should not be reachable
	return {
		strategyId: strategy.id,
		mode: strategy.mode,
		outcome: "failed",
		childResults:
			allRoundResults.length > 0
				? allRoundResults[allRoundResults.length - 1]
				: new Map(),
		rounds: allRoundResults,
		mergeDecision: {
			policy: strategy.mergePolicy,
			outcome: "rejected",
			reasons: ["maximum review rounds exhausted"],
		},
	};
}
