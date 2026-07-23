import type {
	ActionReceiptRecordedV2,
	ActionRequestedV2,
	CandidateAcceptanceEvidenceInput,
	CandidateCompletionRecordedV1,
	CandidateCreatedV2,
	CandidatePromotionIntentInput,
	CandidateReviewEvidenceInput,
	DurableActionReceiptV2,
	DurableActionRequestV2,
	GovernedDispatchLineageV3,
	GovernedReviewCandidateContextV1,
	PromotionGitBindingV1,
	RecordActionReceiptV2Input,
	ReviewVerdictV1,
	SealActionReceiptSetV1Input,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionReceiptSetRecordedV1Digest,
	canonicalActionRequestedV2Digest,
	canonicalCandidateCompletionRecordedV1Digest,
	canonicalCandidateViewV1Digest,
	canonicalReviewVerdictOutputV1Digest,
} from "@buildplane/kernel";
import {
	CandidateAcceptanceOutcomeV1,
	PromotionDecisionKindV1,
	PromotionResultOutcomeV1,
	type TapeEmitter,
} from "@buildplane/ledger-client";
import { describe, expect, it } from "vitest";
import {
	type CreateReviewVerdictV2ProjectionInput,
	createCandidateEvidencePort,
	createCandidatePromotionDecisionPort,
	createGovernedActionEvidencePort,
	type GovernedActionEvidenceRecoverySnapshot,
	toActionRequestedV2WirePayload,
	toReviewVerdictV2WirePayloadFromProjection,
	type VerifiedPromotionIntent,
} from "../src/ledger-trust-spine-port.js";

const DIGEST = (fill: string) => `sha256:${fill.repeat(64)}`;
const SHA1 = (fill: string) => fill.repeat(40);
const SHA256 = (fill: string) => fill.repeat(64);

interface RecordedEmit {
	readonly kind: string;
	readonly payload: unknown;
	readonly id?: string;
	readonly parent?: string;
	readonly occurredAt?: string;
}

function createFakeEmitter(
	options: { readonly failFlush?: boolean; readonly failFlushAt?: number } = {},
): {
	readonly emitter: TapeEmitter;
	readonly emits: RecordedEmit[];
	readonly flushes: number[];
} {
	const emits: RecordedEmit[] = [];
	const flushes: number[] = [];
	return {
		emits,
		flushes,
		emitter: {
			emit(kind, payload, emitOptions) {
				emits.push({
					kind,
					payload,
					...(emitOptions?.id === undefined ? {} : { id: emitOptions.id }),
					...(emitOptions?.parent === undefined
						? {}
						: { parent: emitOptions.parent }),
					...(emitOptions?.occurredAt === undefined
						? {}
						: { occurredAt: emitOptions.occurredAt }),
				});
			},
			async flush() {
				flushes.push(emits.length);
				if (options.failFlush || options.failFlushAt === flushes.length) {
					throw new Error("ledger append failed");
				}
			},
			async close() {},
			onFailure() {},
			stats() {
				return {
					eventsEmitted: emits.length,
					lastAckedEventId: emits.at(-1)?.id ?? null,
					queueDepth: 0,
				};
			},
		},
	};
}

const candidate = {
	schemaVersion: 1 as const,
	candidateId: "candidate-1",
	runId: "run-1",
	attempt: 1,
	candidateKey: "candidate-1/run-1/1",
	candidateRef: "refs/buildplane/candidates/candidate-1/run-1/1",
	baseSha: SHA256("a"),
	candidateCommitSha: SHA256("b"),
	commitDigest: SHA256("c"),
	treeDigest: SHA256("d"),
	patchDigest: SHA256("e"),
	changedFilesDigest: SHA256("f"),
	candidateDigest: "0".repeat(64),
};

function acceptanceInput(): CandidateAcceptanceEvidenceInput {
	return {
		runId: "run-1",
		candidate,
		outcome: "passed",
		acceptanceContractDigest: DIGEST("4"),
		diffScopeStatus: "passed",
		outOfScopeFiles: [],
		checkResults: [{ command: "pnpm test", exitCode: 0 }],
		evaluatedAt: "2026-07-17T12:00:00.000Z",
		acceptanceEventId: "legacy-acceptance-1",
	};
}

function reviewInput(): CandidateReviewEvidenceInput {
	return {
		candidate,
		acceptance: {
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			acceptanceContractDigest: DIGEST("4"),
			acceptanceRef: "acceptance-ref",
			outcome: "passed",
		},
		reviewerRunId: "review-run-1",
		verdict: {
			schemaVersion: 1,
			candidateDigest: DIGEST("0"),
			decision: "approve",
			findings: [
				{
					severity: "info",
					checkId: "tests",
					file: "src/index.ts",
					line: 1,
					explanation: "All deterministic checks passed.",
					evidenceRefs: ["test-output"],
				},
			],
			confidence: 0.95,
			reviewerManifestDigest: DIGEST("1"),
		},
		reviewedAt: "2026-07-17T12:01:00.000Z",
	};
}

function promotionGitBinding(
	overrides: Partial<PromotionGitBindingV1> = {},
): PromotionGitBindingV1 {
	return {
		targetRef: "refs/heads/main",
		targetHeadBeforeSha: candidate.baseSha,
		targetHeadAfterSha: SHA1("9"),
		mergedHeadSha: SHA1("9"),
		candidateCommitSha: candidate.candidateCommitSha,
		mergeParentShas: [candidate.baseSha, candidate.candidateCommitSha],
		mergedTreeSha: SHA1("7"),
		mergedTreeDigest: DIGEST("d"),
		promotionReceiptRef: "refs/buildplane/promotions/candidate-1/run-1/1",
		worktreeSyncState: "root_checkout_stale",
		...overrides,
	};
}

function promotionIntent(): CandidatePromotionIntentInput {
	return {
		runId: "run-1",
		candidate: {
			...candidate,
			workflowId: "workflow-1",
			unitId: "unit-1",
			provenanceRef: "admission:1",
			envelopeDigest: DIGEST("2"),
			acceptanceContractDigest: DIGEST("4"),
			actionReceiptDigest: DIGEST("3"),
			createdAt: "2026-07-17T12:00:00.000Z",
		},
		decision: {
			schemaVersion: 1,
			candidateDigest: DIGEST("0"),
			baseCommitSha: candidate.baseSha,
			targetRef: "refs/heads/main",
			envelopeDigest: DIGEST("2"),
			acceptanceRef: "acceptance-ref",
			reviewRefs: ["review-ref"],
			decision: "promote",
			authority: "operator@example.test",
			decidedBy: "operator@example.test",
			decidedAt: "2026-07-17T12:02:00.000Z",
			idempotencyKey: "promotion-1",
		},
		acceptance: {
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			acceptanceContractDigest: DIGEST("4"),
			acceptanceRef: "acceptance-ref",
			outcome: "passed",
		},
		review: {
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			reviewRef: "review-ref",
			verdict: reviewInput().verdict,
		},
		preparedAt: "2026-07-17T12:02:01.000Z",
	};
}

function sealedV3PromotionIntent(): CandidatePromotionIntentInput {
	const intent = promotionIntent();
	const {
		actionReceiptDigest: _legacyActionReceiptDigest,
		...candidateWithoutV1
	} = intent.candidate;
	return {
		...intent,
		candidate: {
			...candidateWithoutV1,
			schemaVersion: 2,
			actionEvidenceVersion: "sealed_v3",
			candidateCreatedRef: "candidate-created-v3",
			actionReceiptSetRef: "candidate-receipt-set-v3",
			actionReceiptSetDigest: DIGEST("5"),
		},
	};
}

function verifiedReferences(options?: {
	readonly reject?: Error;
	readonly rejectResult?: Error;
	readonly onVerifyIntent?: (input: VerifiedPromotionIntent) => void;
	readonly onVerifyResult?: (input: unknown) => void;
	readonly decision?: {
		readonly reference: string;
		readonly payload: Record<string, unknown>;
	};
	readonly result?: {
		readonly reference: string;
		readonly payload: Record<string, unknown>;
	};
}) {
	return {
		async verifyPromotionIntent(input: VerifiedPromotionIntent) {
			options?.onVerifyIntent?.(input);
			if (options?.reject) throw options.reject;
		},
		async verifyPromotionResult(input: unknown) {
			options?.onVerifyResult?.(input);
			if (options?.rejectResult) throw options.rejectResult;
		},
		async findDecisionReference() {
			return options?.decision as never;
		},
		async findResultReference() {
			return options?.result as never;
		},
	};
}

describe("candidate evidence ledger port", () => {
	it("writes canonical immutable acceptance and review records before returning their tape references", async () => {
		const fake = createFakeEmitter();
		const port = createCandidateEvidencePort(fake.emitter);

		const acceptance = await port.recordCandidateAcceptance(acceptanceInput());
		const review = await port.recordCandidateReview(reviewInput());

		expect(acceptance).toMatchObject({
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			outcome: "passed",
		});
		expect(acceptance.acceptanceRef).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(review.reviewRef).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(fake.emits).toHaveLength(2);
		expect(fake.emits[0]).toEqual({
			kind: "candidate_acceptance_recorded",
			id: acceptance.acceptanceRef,
			payload: {
				CandidateAcceptanceRecordedV1: expect.objectContaining({
					candidate_digest: DIGEST("0"),
					candidate_commit_sha: candidate.candidateCommitSha,
					acceptance_contract_digest: DIGEST("4"),
					acceptance_ref: acceptance.acceptanceRef,
					outcome: "passed",
				}),
			},
		});
		expect(fake.emits[1]).toEqual({
			kind: "review_verdict_recorded",
			id: review.reviewRef,
			payload: {
				ReviewVerdictRecordedV1: expect.objectContaining({
					candidate_digest: DIGEST("0"),
					candidate_commit_sha: candidate.candidateCommitSha,
					review_ref: review.reviewRef,
					decision: "approve",
				}),
			},
		});
		// Each reference is returned only after its event has been flushed.
		expect(fake.flushes).toEqual([1, 2]);
	});

	it("fails closed rather than issuing an evidence reference when the append fails", async () => {
		const fake = createFakeEmitter({ failFlush: true });
		const port = createCandidateEvidencePort(fake.emitter);

		await expect(
			port.recordCandidateAcceptance(acceptanceInput()),
		).rejects.toThrow("ledger append failed");
		expect(fake.emits).toHaveLength(1);
	});
});

describe("candidate promotion ledger port", () => {
	it("retains V1 action receipt evidence for the verifier", async () => {
		const fake = createFakeEmitter();
		let verified: VerifiedPromotionIntent | undefined;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyIntent(input) {
					verified = input;
				},
			}),
		});

		await port.recordPromotionDecision({ intent: promotionIntent() });

		expect(verified?.candidate).toEqual({
			schemaVersion: 1,
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			baseCommitSha: candidate.baseSha,
			envelopeDigest: DIGEST("2"),
			acceptanceContractDigest: DIGEST("4"),
			actionReceiptDigest: DIGEST("3"),
		});
		expect(verified?.candidate).not.toHaveProperty("candidateCreatedRef");
		expect(fake.emits).toHaveLength(1);
	});

	it("sends sealed V3 rejection evidence to the verifier without legacy V1 receipt evidence", async () => {
		const fake = createFakeEmitter();
		let verified: VerifiedPromotionIntent | undefined;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyIntent(input) {
					verified = input;
				},
			}),
		});
		const intent = sealedV3PromotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					decision: { ...intent.decision, decision: "reject" },
					acceptance: { ...intent.acceptance, outcome: "rejected" },
					review: {
						...intent.review,
						verdict: { ...intent.review.verdict, decision: "reject" },
					},
				},
			}),
		).resolves.toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);

		expect(verified).toBeDefined();
		if (verified === undefined) {
			throw new Error("expected the sealed V3 intent to reach the verifier");
		}
		expect(verified.candidate).toEqual({
			schemaVersion: 2,
			candidateDigest: DIGEST("0"),
			candidateCommitSha: candidate.candidateCommitSha,
			baseCommitSha: candidate.baseSha,
			envelopeDigest: DIGEST("2"),
			acceptanceContractDigest: DIGEST("4"),
			actionEvidenceVersion: "sealed_v3",
			candidateCreatedRef: "candidate-created-v3",
			actionReceiptSetRef: "candidate-receipt-set-v3",
			actionReceiptSetDigest: DIGEST("5"),
		});
		expect(verified.candidate).not.toHaveProperty("actionReceiptDigest");
		expect(fake.emits).toHaveLength(1);
	});

	it("rejects V2 candidate evidence that carries a legacy V1 action receipt digest", async () => {
		const fake = createFakeEmitter();
		let verifierCalls = 0;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyIntent() {
					verifierCalls += 1;
				},
			}),
		});
		const intent = sealedV3PromotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					candidate: {
						...intent.candidate,
						actionReceiptDigest: DIGEST("3"),
					} as unknown as CandidatePromotionIntentInput["candidate"],
				},
			}),
		).rejects.toThrow(/V2 candidate.*legacy V1 action-receipt digest/i);
		expect(verifierCalls).toBe(0);
		expect(fake.emits).toHaveLength(0);
	});

	it("rejects a V2 candidate missing its candidate-created evidence reference", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const intent = sealedV3PromotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					candidate: {
						...intent.candidate,
						candidateCreatedRef: undefined,
					} as unknown as CandidatePromotionIntentInput["candidate"],
				},
			}),
		).rejects.toThrow(
			/candidate\.candidateCreatedRef must be a non-empty string/i,
		);
		expect(fake.emits).toHaveLength(0);
	});

	it("passes a tampered V2 receipt-set digest to the authoritative verifier and emits nothing when it rejects it", async () => {
		const fake = createFakeEmitter();
		let verified: VerifiedPromotionIntent | undefined;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyIntent(input) {
					verified = input;
				},
				reject: new Error(
					"sealed receipt set does not match candidate-created evidence",
				),
			}),
		});
		const intent = sealedV3PromotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					candidate: {
						...intent.candidate,
						actionReceiptSetDigest: DIGEST("9"),
					},
				},
			}),
		).rejects.toThrow(
			/sealed receipt set does not match candidate-created evidence/i,
		);
		expect(verified?.candidate).toMatchObject({
			schemaVersion: 2,
			actionReceiptSetDigest: DIGEST("9"),
		});
		expect(verified?.candidate).not.toHaveProperty("actionReceiptDigest");
		expect(fake.emits).toHaveLength(0);
	});

	it("writes the decision ahead of a reconciliation-required result bound to its signed decision reference", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			now: () => "2026-07-17T12:03:00.000Z",
			references: verifiedReferences(),
		});

		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});
		expect(promotionDecisionRef).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		await port.recordPromotionResult({
			runId: "run-1",
			candidateDigest: DIGEST("0"),
			idempotencyKey: "promotion-1",
			promotionDecisionRef,
			outcome: "reconciliation_required",
			mergedHeadSha: SHA1("9"),
			promotionGitBinding: promotionGitBinding(),
		});

		expect(fake.emits).toHaveLength(2);
		const decision = fake.emits[0];
		const result = fake.emits[1];
		expect(decision?.kind).toBe("promotion_decision_recorded");
		expect(decision?.payload).toEqual({
			PromotionDecisionRecordedV1: {
				candidate_digest: DIGEST("0"),
				base_commit_sha: candidate.baseSha,
				target_ref: "refs/heads/main",
				envelope_digest: DIGEST("2"),
				acceptance_ref: "acceptance-ref",
				review_refs: ["review-ref"],
				decision: "promote",
				authority: "operator@example.test",
				decided_by: "operator@example.test",
				decided_at: "2026-07-17T12:02:00.000Z",
				idempotency_key: "promotion-1",
			},
		});
		expect(result?.kind).toBe("promotion_result_recorded");
		expect(result?.payload).toEqual({
			PromotionResultRecordedV1: {
				candidate_digest: DIGEST("0"),
				idempotency_key: "promotion-1",
				promotion_decision_ref: promotionDecisionRef,
				outcome: "reconciliation_required",
				merged_head_sha: SHA1("9"),
				promotion_git_binding: {
					target_ref: "refs/heads/main",
					target_head_before_sha: candidate.baseSha,
					target_head_after_sha: SHA1("9"),
					merged_head_sha: SHA1("9"),
					candidate_commit_sha: candidate.candidateCommitSha,
					merge_parent_shas: [candidate.baseSha, candidate.candidateCommitSha],
					merged_tree_sha: SHA1("7"),
					merged_tree_digest: DIGEST("d"),
					promotion_receipt_ref:
						"refs/buildplane/promotions/candidate-1/run-1/1",
					worktree_sync_state: "root_checkout_stale",
				},
				completed_at: "2026-07-17T12:03:00.000Z",
			},
		});
		expect(fake.flushes).toEqual([1, 2]);
	});

	it("rejects a strict target-bound promoted result that leaves reconciliation pending", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "promoted",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					worktreeSyncState: "pending_reconciliation",
				}),
			}),
		).rejects.toThrow(
			/strict target-bound promotion results must record reconciliation_required/i,
		);
		expect(fake.emits).toHaveLength(1);
	});

	it("maps an optional promotion approval request reference into the decision payload", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const intent = promotionIntent();

		await port.recordPromotionDecision({
			intent: {
				...intent,
				decision: {
					...intent.decision,
					promotionApprovalRequestRef: "01919000-0000-7000-8000-000000000042",
				},
			},
		});

		expect(fake.emits).toHaveLength(1);
		expect(fake.emits[0]?.payload).toMatchObject({
			PromotionDecisionRecordedV1: {
				promotion_approval_request_ref: "01919000-0000-7000-8000-000000000042",
			},
		});
	});

	it("rejects a syntactically valid merge SHA that differs from the bound Git evidence before writing the result", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					mergedHeadSha: SHA1("8"),
				}),
			}),
		).rejects.toThrow(/must equal the promotion result mergedHeadSha/i);
		expect(fake.emits).toHaveLength(1);
	});

	it("records a root-checkout-stale promotion as reconciliation-required without claiming the target advanced", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			now: () => "2026-07-17T12:03:00.000Z",
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await port.recordPromotionResult({
			runId: "run-1",
			candidateDigest: DIGEST("0"),
			idempotencyKey: "promotion-1",
			promotionDecisionRef,
			outcome: "reconciliation_required",
			mergedHeadSha: SHA1("9"),
			promotionGitBinding: promotionGitBinding({
				worktreeSyncState: "root_checkout_stale",
			}),
		});

		expect(fake.emits[1]?.payload).toEqual({
			PromotionResultRecordedV1: expect.objectContaining({
				outcome: "reconciliation_required",
				promotion_git_binding: expect.objectContaining({
					worktree_sync_state: "root_checkout_stale",
					target_head_after_sha: SHA1("9"),
				}),
			}),
		});
	});

	it("rejects a root-checkout-stale result when the target no longer equals the merge", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					targetHeadAfterSha: SHA1("8"),
					worktreeSyncState: "root_checkout_stale",
				}),
			}),
		).rejects.toThrow(
			/must equal mergedHeadSha when the root checkout is stale/i,
		);
	});

	it("fails closed when a structurally valid promotion receipt does not resolve against authoritative Git evidence", async () => {
		const fake = createFakeEmitter();
		const verificationCalls: unknown[] = [];
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: {
				async verifyPromotionIntent() {},
				async verifyPromotionResult(input: unknown) {
					verificationCalls.push(input);
					throw new Error(
						"promotion receipt ref resolves to a different immutable candidate",
					);
				},
				async findDecisionReference() {
					return undefined;
				},
				async findResultReference() {
					return undefined;
				},
			},
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding(),
			}),
		).rejects.toThrow(
			/receipt ref resolves to a different immutable candidate/i,
		);
		expect(verificationCalls).toHaveLength(1);
		expect(fake.emits).toHaveLength(1);
	});

	it("rejects a promotion receipt whose derived candidate ref violates the canonical candidate grammar", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					promotionReceiptRef:
						"refs/buildplane/promotions/candidate.lock/run-1/1",
				}),
			}),
		).rejects.toThrow(/canonical Buildplane candidate ref/i);

		expect(fake.emits).toHaveLength(1);
	});

	it("accepts a promotion receipt that mirrors a canonical deeper candidate ref", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					promotionReceiptRef:
						"refs/buildplane/promotions/candidate-1/run-1/nested/1",
				}),
			}),
		).resolves.toBeUndefined();

		expect(fake.emits).toHaveLength(2);
	});

	it("re-verifies authoritative receipt evidence before accepting an in-memory duplicate result", async () => {
		const fake = createFakeEmitter();
		let verificationCalls = 0;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyResult() {
					verificationCalls += 1;
					if (verificationCalls === 2) {
						throw new Error("promotion receipt no longer resolves");
					}
				},
			}),
		});
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: promotionIntent(),
		});
		const result = {
			runId: "run-1",
			candidateDigest: DIGEST("0"),
			idempotencyKey: "promotion-1",
			promotionDecisionRef,
			outcome: "reconciliation_required" as const,
			mergedHeadSha: SHA1("9"),
			promotionGitBinding: promotionGitBinding(),
		};

		await port.recordPromotionResult(result);
		await expect(port.recordPromotionResult(result)).rejects.toThrow(
			/promotion receipt no longer resolves/i,
		);
		expect(verificationCalls).toBe(2);
		expect(fake.emits).toHaveLength(2);
	});

	it("does not fabricate a promotion result without a durably recorded decision", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef: "decision-ref-not-recorded",
				outcome: "rejected",
			}),
		).rejects.toThrow(/decision reference/i);
		expect(fake.emits).toHaveLength(0);
	});

	it("does not let a rejected promotion decision record a merge-producing result", async () => {
		const fake = createFakeEmitter();
		let resultVerificationCalls = 0;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				onVerifyResult() {
					resultVerificationCalls += 1;
				},
			}),
		});
		const intent = promotionIntent();
		const promotionDecisionRef = await port.recordPromotionDecision({
			intent: {
				...intent,
				decision: { ...intent.decision, decision: "reject" },
			},
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding(),
			}),
		).rejects.toThrow(
			/rejected promotion decision cannot record a merge-producing result/i,
		);
		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					targetHeadAfterSha: SHA1("8"),
					worktreeSyncState: "target_advanced",
				}),
			}),
		).rejects.toThrow(
			/rejected promotion decision cannot record a merge-producing result/i,
		);
		expect(resultVerificationCalls).toBe(0);
		expect(fake.emits).toHaveLength(1);
	});

	it("never creates a merge-producing result from a recovered legacy decision", async () => {
		const fake = createFakeEmitter();
		let resultVerificationCalls = 0;
		let resultLookupCalls = 0;
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: {
				async verifyPromotionIntent() {},
				async verifyPromotionResult() {
					resultVerificationCalls += 1;
				},
				async findDecisionReference() {
					return {
						reference: "legacy-decision:1",
						payload: {
							candidate_digest: DIGEST("0"),
							base_commit_sha: candidate.baseSha,
							envelope_digest: DIGEST("2"),
							acceptance_ref: "acceptance-ref",
							review_refs: ["review-ref"],
							decision: PromotionDecisionKindV1.Promote,
							authority: "operator",
							decided_by: "operator@example.test",
							decided_at: "2026-07-17T12:02:00.000Z",
							idempotency_key: "promotion-1",
						},
					};
				},
				async findResultReference() {
					resultLookupCalls += 1;
					return undefined;
				},
			},
		});

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef: "legacy-decision:1",
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding(),
			}),
		).rejects.toThrow(
			/recovered legacy promotion decision cannot create a merge-producing result/i,
		);
		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef: "legacy-decision:1",
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding({
					targetHeadAfterSha: SHA1("8"),
					worktreeSyncState: "target_advanced",
				}),
			}),
		).rejects.toThrow(
			/recovered legacy promotion decision cannot create a merge-producing result/i,
		);
		expect(resultVerificationCalls).toBe(0);
		expect(resultLookupCalls).toBe(0);
		expect(fake.emits).toHaveLength(0);
	});

	it("rejects a result whose supplied decision reference differs from the recorded decision", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		await port.recordPromotionDecision({ intent: promotionIntent() });

		await expect(
			port.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef: "different-decision-ref",
				outcome: "rejected",
			}),
		).rejects.toThrow(/does not match the recorded decision reference/i);
		expect(fake.emits).toHaveLength(1);
	});

	it("fails closed when the signed evidence/authority verifier rejects the intent", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences({
				reject: new Error("acceptance/review authority is not signed"),
			}),
		});

		await expect(
			port.recordPromotionDecision({ intent: promotionIntent() }),
		).rejects.toThrow("acceptance/review authority is not signed");
		expect(fake.emits).toHaveLength(0);
	});

	it("does not append a promotion decision when acceptance used a different contract", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const intent = promotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					acceptance: {
						...intent.acceptance,
						acceptanceContractDigest: DIGEST("9"),
					} as unknown as CandidatePromotionIntentInput["acceptance"],
				},
			}),
		).rejects.toThrow(/acceptance contract/i);
		expect(fake.emits).toHaveLength(0);
	});

	it("does not emit a promotion decision whose actor fields cannot bind one signer", async () => {
		const fake = createFakeEmitter();
		const port = createCandidatePromotionDecisionPort(fake.emitter, {
			references: verifiedReferences(),
		});
		const intent = promotionIntent();

		await expect(
			port.recordPromotionDecision({
				intent: {
					...intent,
					decision: {
						...intent.decision,
						authority: "operator",
						decidedBy: "operator@example.test",
					},
				},
			}),
		).rejects.toThrow(
			"promotionDecision.authority must equal promotionDecision.decidedBy for a signable promotion decision",
		);
		expect(fake.emits).toHaveLength(0);
	});

	it("rejects conflicting recovered decision and result payloads", async () => {
		const fake = createFakeEmitter();
		const conflictingDecisionPort = createCandidatePromotionDecisionPort(
			fake.emitter,
			{
				references: verifiedReferences({
					decision: {
						reference: "decision-from-tape",
						payload: {
							candidate_digest: DIGEST("0"),
							base_commit_sha: candidate.baseSha,
							target_ref: "refs/heads/main",
							envelope_digest: DIGEST("2"),
							acceptance_ref: "acceptance-ref",
							review_refs: ["review-ref"],
							decision: PromotionDecisionKindV1.Reject,
							authority: "operator",
							decided_by: "operator@example.test",
							decided_at: "2026-07-17T12:02:00.000Z",
							idempotency_key: "promotion-1",
						},
					},
				}),
			},
		);

		await expect(
			conflictingDecisionPort.recordPromotionDecision({
				intent: promotionIntent(),
			}),
		).rejects.toThrow(/recovered promotion decision conflicts/i);
		expect(fake.emits).toHaveLength(0);

		const localFake = createFakeEmitter();
		const resultPort = createCandidatePromotionDecisionPort(localFake.emitter, {
			references: verifiedReferences({
				result: {
					reference: "result-from-tape",
					payload: {
						candidate_digest: DIGEST("0"),
						idempotency_key: "promotion-1",
						promotion_decision_ref: "decision-will-be-local",
						outcome: PromotionResultOutcomeV1.Rejected,
						completed_at: "2026-07-17T12:03:00.000Z",
					},
				},
			}),
		});
		const decisionRef = await resultPort.recordPromotionDecision({
			intent: promotionIntent(),
		});
		await expect(
			resultPort.recordPromotionResult({
				runId: "run-1",
				candidateDigest: DIGEST("0"),
				idempotencyKey: "promotion-1",
				promotionDecisionRef: decisionRef,
				outcome: "reconciliation_required",
				mergedHeadSha: SHA1("9"),
				promotionGitBinding: promotionGitBinding(),
			}),
		).rejects.toThrow(/recovered promotion result conflicts/i);
	});
});

function governedActionRequest(
	overrides: Partial<ActionRequestedV2> = {},
): ActionRequestedV2 {
	return {
		schemaVersion: 2,
		runId: "run-v3",
		workflowId: "workflow-v3",
		unitId: "unit-v3",
		attempt: 1,
		provenanceRef: "admission:v3",
		actionId: "action-a",
		idempotencyKey: "action-a:1",
		actionKind: "process",
		canonicalInputDigest: DIGEST("1"),
		canonicalInputRef: "cas:input:v3",
		dispatchEnvelopeDigest: DIGEST("2"),
		repositoryBindingDigest: DIGEST("a"),
		ledgerAuthorityRealmDigest: DIGEST("b"),
		governedPacketDigest: DIGEST("c"),
		capabilityBundleDigest: DIGEST("3"),
		policyDigest: DIGEST("4"),
		contextManifestDigest: DIGEST("5"),
		workerManifestDigest: DIGEST("6"),
		sandboxProfileDigest: DIGEST("7"),
		authorityActor: "kernel:v3",
		executionRole: "implementer",
		requestedAt: "2026-07-18T12:00:00.000Z",
		...overrides,
	};
}

function governedActionReceipt(
	request: ActionRequestedV2,
	overrides: Partial<RecordActionReceiptV2Input> = {},
): RecordActionReceiptV2Input {
	return {
		schemaVersion: 2,
		runId: request.runId,
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		actionId: request.actionId,
		idempotencyKey: request.idempotencyKey,
		actionRequestDigest: canonicalActionRequestedV2Digest(request),
		dispatchEnvelopeDigest: request.dispatchEnvelopeDigest,
		capabilityBundleDigest: request.capabilityBundleDigest,
		policyDigest: request.policyDigest,
		contextManifestDigest: request.contextManifestDigest,
		workerManifestDigest: request.workerManifestDigest,
		sandboxProfileDigest: request.sandboxProfileDigest,
		authorityActor: request.authorityActor,
		executionRole: request.executionRole,
		outcome: "succeeded",
		resultDigest: DIGEST("8"),
		resultRef: "cas:result:v3",
		evidenceDigest: DIGEST("9"),
		evidenceRef: "cas:evidence:v3",
		resourceUsage: {
			wallTimeMs: 12,
			cpuTimeMs: 8,
			peakMemoryBytes: 1_024,
			inputBytes: 55,
			outputBytes: 34,
			inputTokens: 8,
			outputTokens: 13,
		},
		redactions: [
			{
				field: "stdout",
				reason: "secret",
				redactedDigest: DIGEST("a"),
			},
		],
		completedAt: "2026-07-18T12:00:01.000Z",
		...overrides,
	};
}

function receiptSetInput(
	request: ActionRequestedV2,
	receipts: readonly {
		readonly receipt: {
			readonly actionId: string;
			readonly actionReceiptRef: string;
		};
		readonly actionReceiptDigest: string;
	}[],
	sealedAt = "2026-07-18T12:00:02.000Z",
): SealActionReceiptSetV1Input {
	return {
		runId: request.runId,
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		dispatchEnvelopeDigest: request.dispatchEnvelopeDigest,
		receipts: receipts.map((receipt) => ({
			actionId: receipt.receipt.actionId,
			actionReceiptRef: receipt.receipt.actionReceiptRef,
			actionReceiptDigest: receipt.actionReceiptDigest,
		})),
		sealedAt,
	};
}

function recoveredActionEvidence(
	request: ActionRequestedV2,
	state: "completed" | "pending" | "unknown",
) {
	const actionRequestDigest = canonicalActionRequestedV2Digest(request);
	const requests = [
		{
			actionRequest: request,
			actionRequestRef: "recovered-request-ref",
			actionRequestDigest,
		},
	];
	if (state === "pending") {
		return {
			dispatchPolicyDigest: request.policyDigest,
			requests,
			receipts: [],
			candidates: [],
		};
	}
	const receipt: ActionReceiptRecordedV2 = {
		...governedActionReceipt(
			request,
			state === "unknown"
				? {
						outcome: "unknown",
						failure: {
							code: "EFFECT_UNCERTAIN",
							messageDigest: DIGEST("f"),
							retryable: false,
						},
					}
				: {},
		),
		actionReceiptRef: "recovered-receipt-ref",
	};
	return {
		dispatchPolicyDigest: request.policyDigest,
		requests,
		receipts: [
			{
				receipt,
				actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(receipt),
			},
		],
		candidates: [],
	};
}

function durableActionEvidenceOptions(
	snapshot: GovernedActionEvidenceRecoverySnapshot | undefined = {
		dispatchPolicyDigest: DIGEST("4"),
		requests: [],
		receipts: [],
		candidates: [],
	},
) {
	return {
		recoveryResolver: {
			async resolveDispatch() {
				return snapshot;
			},
		},
	};
}

function createFreshGovernedActionEvidencePort(emitter: TapeEmitter) {
	return createGovernedActionEvidencePort(
		emitter,
		durableActionEvidenceOptions(),
	);
}

function governedCandidateCreated(
	request: ActionRequestedV2,
	receiptSet: {
		readonly actionReceiptSetRef: string;
		readonly actionReceiptSetDigest: string;
	},
): CandidateCreatedV2 {
	return {
		runId: request.runId,
		candidateId: "candidate-v3",
		candidateRef: "refs/buildplane/candidates/candidate-v3/run-v3/1",
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		candidateDigest: DIGEST("b"),
		baseCommitSha: SHA1("1"),
		candidateCommitSha: SHA1("2"),
		commitDigest: DIGEST("c"),
		treeDigest: DIGEST("d"),
		patchDigest: DIGEST("e"),
		changedFilesDigest: DIGEST("f"),
		envelopeDigest: request.dispatchEnvelopeDigest,
		actionReceiptSetRef: receiptSet.actionReceiptSetRef,
		actionReceiptSetDigest: receiptSet.actionReceiptSetDigest,
	};
}

function candidateCompletion(
	candidate: CandidateCreatedV2,
	candidateCreatedEventRef: string,
	durableRequest: DurableActionRequestV2,
	durableReceipt: DurableActionReceiptV2,
): CandidateCompletionRecordedV1 {
	const completionWithoutDigest: Omit<
		CandidateCompletionRecordedV1,
		"completionDigest"
	> = {
		runId: candidate.runId,
		workflowId: candidate.workflowId,
		unitId: candidate.unitId,
		attempt: candidate.attempt,
		provenanceRef: candidate.provenanceRef,
		candidateCreatedEventRef,
		candidateDigest: candidate.candidateDigest,
		candidateCreateActionId: durableRequest.actionRequest.actionId,
		actionRequestRef: durableRequest.actionRequestRef,
		actionRequestDigest: durableRequest.actionRequestDigest,
		activityClaimEventRef: "01900000-0000-7000-8000-0000000000a1",
		activityClaimEventDigest: DIGEST("a"),
		activityResultEventRef: "01900000-0000-7000-8000-0000000000a2",
		activityResultEventDigest: DIGEST("b"),
		actionReceiptRef: durableReceipt.receipt.actionReceiptRef,
		actionReceiptDigest: durableReceipt.actionReceiptDigest,
		completedAt: "2026-07-18T12:00:02.000Z",
	};
	return {
		...completionWithoutDigest,
		completionDigest: canonicalCandidateCompletionRecordedV1Digest(
			completionWithoutDigest,
		),
	};
}

function governedDispatch(
	overrides: Partial<GovernedDispatchLineageV3> = {},
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: "run-v3",
		workflowId: "workflow-v3",
		workflowRevision: "revision-v3",
		unitId: "unit-v3",
		attempt: 1,
		provenanceRef: "admission:v3",
		dispatchEnvelopeRef: "dispatch-event-v3",
		envelopeDigest: DIGEST("2"),
		baseCommitSha: SHA1("1"),
		repositoryBindingDigest: DIGEST("a"),
		ledgerAuthorityRealmDigest: DIGEST("b"),
		governedPacketDigest: DIGEST("c"),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: DIGEST("3"),
		acceptanceContractDigest: DIGEST("4"),
		policyDigest: DIGEST("4"),
		contextManifestDigest: DIGEST("5"),
		workerManifestDigest: DIGEST("6"),
		sandboxProfileDigest: DIGEST("7"),
		budget: { maxTokens: 1_000, maxComputeTimeMs: 60_000 },
		idempotencyKey: "dispatch-v3",
		authorityActor: "kernel:v3",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2026-07-18T12:00:00.000Z",
		expiresAt: "2026-07-18T13:00:00.000Z",
		...overrides,
	};
}

function reviewVerdictProjection(): CreateReviewVerdictV2ProjectionInput {
	const candidateDispatch = governedDispatch();
	const candidate: CandidateCreatedV2 = {
		runId: candidateDispatch.runId,
		candidateId: "candidate-v3",
		candidateRef: "refs/buildplane/candidates/candidate-v3/run-v3/1",
		workflowId: candidateDispatch.workflowId,
		unitId: candidateDispatch.unitId,
		attempt: candidateDispatch.attempt,
		provenanceRef: candidateDispatch.provenanceRef,
		candidateDigest: DIGEST("b"),
		baseCommitSha: candidateDispatch.baseCommitSha,
		candidateCommitSha: SHA1("2"),
		commitDigest: DIGEST("c"),
		treeDigest: DIGEST("d"),
		patchDigest: DIGEST("e"),
		changedFilesDigest: DIGEST("f"),
		envelopeDigest: candidateDispatch.envelopeDigest,
		actionReceiptSetRef: "candidate-receipt-set-v3",
		actionReceiptSetDigest: DIGEST("0"),
	};
	const reviewerDispatch = governedDispatch({
		workflowId: "workflow-review-v3",
		unitId: "unit-review-v3",
		executionRole: "reviewer",
		dispatchEnvelopeRef: "dispatch-event-review-v3",
		envelopeDigest: DIGEST("8"),
		contextManifestDigest: DIGEST("9"),
		workerManifestDigest: DIGEST("a"),
		sandboxProfileDigest: DIGEST("b"),
		idempotencyKey: "dispatch-review-v3",
	});
	const viewBase = {
		schemaVersion: 1 as const,
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		candidateRef: candidate.candidateRef,
		candidateTreeDigest: candidate.treeDigest,
		candidateViewRef: "candidate-view-v3",
		readOnlyMount: {
			mode: "read-only" as const,
			mountPath: "/workspace/candidate",
			mountDigest: DIGEST("c"),
		},
		context: {
			contextRef: "cas:review-context-v3",
			contextManifestDigest: reviewerDispatch.contextManifestDigest,
		},
	};
	const candidateView: GovernedReviewCandidateContextV1 = {
		...viewBase,
		candidateViewDigest: canonicalCandidateViewV1Digest({
			candidateRef: viewBase.candidateRef,
			candidateDigest: viewBase.candidateDigest,
			candidateCommitSha: viewBase.candidateCommitSha,
			treeDigest: viewBase.candidateTreeDigest,
			reviewerContextManifestDigest: viewBase.context.contextManifestDigest,
			reviewerSandboxProfileDigest: reviewerDispatch.sandboxProfileDigest,
			mountPathDigest: viewBase.readOnlyMount.mountDigest,
			readOnly: true,
			networkDisabled: true,
		}),
	};
	const verdict: ReviewVerdictV1 = {
		schemaVersion: 1,
		candidateDigest: candidate.candidateDigest,
		decision: "approve",
		findings: [],
		confidence: 0.95,
		reviewerManifestDigest: reviewerDispatch.workerManifestDigest,
	};
	const reviewOutputDigest = canonicalReviewVerdictOutputV1Digest({
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		decision: verdict.decision,
		findings: verdict.findings,
		confidence: verdict.confidence,
		candidateViewDigest: candidateView.candidateViewDigest,
	});
	const actionRequest = governedActionRequest({
		runId: reviewerDispatch.runId,
		workflowId: reviewerDispatch.workflowId,
		unitId: reviewerDispatch.unitId,
		attempt: reviewerDispatch.attempt,
		provenanceRef: reviewerDispatch.provenanceRef,
		actionId: "review-action-v3",
		idempotencyKey: "review-action-v3:1",
		actionKind: "model",
		dispatchEnvelopeDigest: reviewerDispatch.envelopeDigest,
		repositoryBindingDigest: reviewerDispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: reviewerDispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: reviewerDispatch.governedPacketDigest,
		capabilityBundleDigest: reviewerDispatch.capabilityBundleDigest,
		policyDigest: reviewerDispatch.policyDigest,
		contextManifestDigest: reviewerDispatch.contextManifestDigest,
		workerManifestDigest: reviewerDispatch.workerManifestDigest,
		sandboxProfileDigest: reviewerDispatch.sandboxProfileDigest,
		authorityActor: reviewerDispatch.authorityActor,
		executionRole: reviewerDispatch.executionRole,
	});
	const durableRequest: DurableActionRequestV2 = {
		actionRequest,
		actionRequestRef: "review-action-request-v3",
		actionRequestDigest: canonicalActionRequestedV2Digest(actionRequest),
	};
	const receipt = {
		...governedActionReceipt(actionRequest, {
			resultDigest: reviewOutputDigest,
			resultRef: `cas:${reviewOutputDigest}`,
			authorizationRef: "model-action-authorization-v3",
		}),
		actionReceiptRef: "review-action-receipt-v3",
	};
	const durableReceipt: DurableActionReceiptV2 = {
		receipt,
		actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(receipt),
	};
	const receiptSetBase = {
		schemaVersion: 1 as const,
		runId: reviewerDispatch.runId,
		workflowId: reviewerDispatch.workflowId,
		unitId: reviewerDispatch.unitId,
		attempt: reviewerDispatch.attempt,
		provenanceRef: reviewerDispatch.provenanceRef,
		dispatchEnvelopeDigest: reviewerDispatch.envelopeDigest,
		actionReceiptSetRef: "review-receipt-set-v3",
		receipts: [
			{
				actionId: receipt.actionId,
				actionReceiptRef: receipt.actionReceiptRef,
				actionReceiptDigest: durableReceipt.actionReceiptDigest,
			},
		],
		sealedAt: "2026-07-18T12:00:02.000Z",
	};
	const receiptSet = {
		...receiptSetBase,
		actionReceiptSetDigest:
			canonicalActionReceiptSetRecordedV1Digest(receiptSetBase),
	};

	return {
		evidence: {
			candidate: {
				candidate,
				dispatch: candidateDispatch,
				acceptance: {
					candidate_digest: candidate.candidateDigest,
					candidate_commit_sha: candidate.candidateCommitSha,
					acceptance_ref: "candidate-acceptance-v3",
					acceptance_contract_digest:
						candidateDispatch.acceptanceContractDigest,
					acceptance_digest: DIGEST("d"),
					outcome: CandidateAcceptanceOutcomeV1.Passed,
					evaluated_at: "2026-07-18T12:00:01.000Z",
				},
			},
			reviewer: {
				dispatch: reviewerDispatch,
				actionRequest: durableRequest,
				actionReceipt: durableReceipt,
				actionReceiptSet: receiptSet,
				candidateViewRef: candidateView.candidateViewRef,
				candidateView,
				reviewerAuthority: "reviewer",
			},
		},
		verdict,
		reviewRef: "review-v3",
		reviewedAt: "2026-07-18T12:00:03.000Z",
	};
}

describe("V2 review projection serializer", () => {
	it("derives the closed V2 review wire record only from candidate and reviewer V3 evidence", () => {
		const input = reviewVerdictProjection();
		const payload = toReviewVerdictV2WirePayloadFromProjection(input);

		expect(payload).toMatchObject({
			run_id: "run-v3",
			workflow_id: "workflow-v3",
			unit_id: "unit-v3",
			candidate_digest: DIGEST("b"),
			candidate_commit_sha: SHA1("2"),
			review_ref: "review-v3",
			review_verdict_action_id: "review-action-v3",
			decision: "approve",
			acceptance_ref: "candidate-acceptance-v3",
			reviewer_workflow_id: "workflow-review-v3",
			reviewer_execution_role: "reviewer",
			candidate_view: {
				candidate_ref: "refs/buildplane/candidates/candidate-v3/run-v3/1",
				read_only: true,
				network_disabled: true,
			},
			reviewer_authority: "reviewer",
		});
		expect(payload.review_output_ref).toBe(
			`cas:${payload.review_output_digest}`,
		);
		expect(payload.review_action_receipt_digest).toBe(
			input.evidence.reviewer.actionReceipt.actionReceiptDigest,
		);
	});

	it("rejects a review receipt whose result is not the exact CAS-backed closed verdict", () => {
		const input = reviewVerdictProjection();
		const receipt = {
			...input.evidence.reviewer.actionReceipt.receipt,
			resultRef: "cas:unbound-review-output",
		};
		const actionReceipt = {
			receipt,
			actionReceiptDigest: canonicalActionReceiptRecordedV2Digest(receipt),
		};
		const receiptSetBase = {
			...input.evidence.reviewer.actionReceiptSet,
			receipts: input.evidence.reviewer.actionReceiptSet.receipts.map(
				(entry) => ({
					...entry,
					actionReceiptDigest:
						entry.actionId === receipt.actionId
							? actionReceipt.actionReceiptDigest
							: entry.actionReceiptDigest,
				}),
			),
		};
		const actionReceiptSet = {
			...receiptSetBase,
			actionReceiptSetDigest:
				canonicalActionReceiptSetRecordedV1Digest(receiptSetBase),
		};
		const altered: CreateReviewVerdictV2ProjectionInput = {
			...input,
			evidence: {
				...input.evidence,
				reviewer: {
					...input.evidence.reviewer,
					actionReceipt,
					actionReceiptSet,
				},
			},
		};

		expect(() => toReviewVerdictV2WirePayloadFromProjection(altered)).toThrow(
			/CAS-backed closed review output/i,
		);
	});

	it("rejects a reviewer path that attempts to reuse the candidate implementer dispatch", () => {
		const input = reviewVerdictProjection();
		const altered: CreateReviewVerdictV2ProjectionInput = {
			...input,
			evidence: {
				...input.evidence,
				reviewer: {
					...input.evidence.reviewer,
					dispatch: input.evidence.candidate.dispatch,
				},
			},
		};

		expect(() => toReviewVerdictV2WirePayloadFromProjection(altered)).toThrow(
			/allowed role/i,
		);
	});
});

describe("governed action evidence ledger port", () => {
	it("writes and flushes V3 action evidence in causal order with exact native wire payloads", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const request = governedActionRequest();

		const durableRequest = await port.recordActionRequested(request);
		const durableReceipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await port.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidateCreatedRef = await port.recordCandidateCreatedV2(
			governedCandidateCreated(request, receiptSet),
		);

		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_receipt_set_recorded_v1",
			"candidate_created_v2",
		]);
		expect(fake.flushes).toEqual([1, 2, 3, 4]);
		expect(fake.emits[0]).toEqual({
			kind: "action_requested_v2",
			id: durableRequest.actionRequestRef,
			payload: {
				ActionRequestedV2: {
					run_id: "run-v3",
					workflow_id: "workflow-v3",
					unit_id: "unit-v3",
					attempt: 1,
					provenance_ref: "admission:v3",
					action_id: "action-a",
					idempotency_key: "action-a:1",
					action_kind: "process",
					canonical_input_digest: DIGEST("1"),
					canonical_input_ref: "cas:input:v3",
					dispatch_envelope_digest: DIGEST("2"),
					repository_binding_digest: DIGEST("a"),
					ledger_authority_realm_digest: DIGEST("b"),
					governed_packet_digest: DIGEST("c"),
					capability_bundle_digest: DIGEST("3"),
					policy_digest: DIGEST("4"),
					context_manifest_digest: DIGEST("5"),
					worker_manifest_digest: DIGEST("6"),
					sandbox_profile_digest: DIGEST("7"),
					authority_actor: "kernel:v3",
					execution_role: "implementer",
					requested_at: "2026-07-18T12:00:00.000Z",
				},
			},
		});
		expect(fake.emits[1]).toEqual({
			kind: "action_receipt_recorded_v2",
			id: durableReceipt.receipt.actionReceiptRef,
			payload: {
				ActionReceiptRecordedV2: {
					run_id: "run-v3",
					workflow_id: "workflow-v3",
					unit_id: "unit-v3",
					attempt: 1,
					provenance_ref: "admission:v3",
					action_id: "action-a",
					idempotency_key: "action-a:1",
					action_request_digest: durableRequest.actionRequestDigest,
					dispatch_envelope_digest: DIGEST("2"),
					capability_bundle_digest: DIGEST("3"),
					policy_digest: DIGEST("4"),
					context_manifest_digest: DIGEST("5"),
					worker_manifest_digest: DIGEST("6"),
					sandbox_profile_digest: DIGEST("7"),
					authority_actor: "kernel:v3",
					execution_role: "implementer",
					outcome: "succeeded",
					result_digest: DIGEST("8"),
					result_ref: "cas:result:v3",
					evidence_digest: DIGEST("9"),
					evidence_ref: "cas:evidence:v3",
					resource_usage: {
						wall_time_ms: 12,
						cpu_time_ms: 8,
						peak_memory_bytes: 1_024,
						input_bytes: 55,
						output_bytes: 34,
						input_tokens: 8,
						output_tokens: 13,
					},
					redactions: [
						{
							field: "stdout",
							reason: "secret",
							redacted_digest: DIGEST("a"),
						},
					],
					action_receipt_ref: durableReceipt.receipt.actionReceiptRef,
					completed_at: "2026-07-18T12:00:01.000Z",
				},
			},
		});
		expect(fake.emits[2]).toEqual({
			kind: "action_receipt_set_recorded_v1",
			id: receiptSet.actionReceiptSetRef,
			payload: {
				ActionReceiptSetRecordedV1: {
					run_id: "run-v3",
					workflow_id: "workflow-v3",
					unit_id: "unit-v3",
					attempt: 1,
					provenance_ref: "admission:v3",
					dispatch_envelope_digest: DIGEST("2"),
					action_receipt_set_ref: receiptSet.actionReceiptSetRef,
					action_receipt_set_digest: receiptSet.actionReceiptSetDigest,
					receipts: [
						{
							action_id: "action-a",
							action_receipt_ref: durableReceipt.receipt.actionReceiptRef,
							action_receipt_digest: durableReceipt.actionReceiptDigest,
						},
					],
					sealed_at: "2026-07-18T12:00:02.000Z",
				},
			},
		});
		expect(fake.emits[3]).toEqual({
			kind: "candidate_created_v2",
			id: candidateCreatedRef,
			payload: {
				CandidateCreatedV2: {
					run_id: "run-v3",
					candidate_id: "candidate-v3",
					candidate_ref: "refs/buildplane/candidates/candidate-v3/run-v3/1",
					workflow_id: "workflow-v3",
					unit_id: "unit-v3",
					attempt: 1,
					provenance_ref: "admission:v3",
					candidate_digest: DIGEST("b"),
					base_commit_sha: SHA1("1"),
					candidate_commit_sha: SHA1("2"),
					commit_digest: DIGEST("c"),
					tree_digest: DIGEST("d"),
					patch_digest: DIGEST("e"),
					changed_files_digest: DIGEST("f"),
					envelope_digest: DIGEST("2"),
					action_receipt_set_ref: receiptSet.actionReceiptSetRef,
					action_receipt_set_digest: receiptSet.actionReceiptSetDigest,
				},
			},
		});
		expect(
			(fake.emits[0]?.payload as { readonly ActionRequestedV2: unknown })
				.ActionRequestedV2,
		).not.toHaveProperty("schema_version");
	});

	it("re-reads signed activity lineage before it records one candidate-completion proof", async () => {
		const fake = createFakeEmitter();
		let snapshot: GovernedActionEvidenceRecoverySnapshot = {
			dispatchPolicyDigest: DIGEST("4"),
			requests: [],
			receipts: [],
			candidates: [],
		};
		let resolveCalls = 0;
		const port = createGovernedActionEvidencePort(fake.emitter, {
			recoveryResolver: {
				async resolveDispatch() {
					resolveCalls += 1;
					return snapshot;
				},
			},
		});
		const request = governedActionRequest({
			actionId: "git-candidate-create:candidate-v3/run-v3/1",
			idempotencyKey: "git-candidate-create:candidate-v3/run-v3/1",
			actionKind: "git",
		});
		const durableRequest = await port.recordActionRequested(request);
		const durableReceipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await port.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const candidateCreatedRef = await port.recordCandidateCreatedV2(candidate);
		const completion = candidateCompletion(
			candidate,
			candidateCreatedRef,
			durableRequest,
			durableReceipt,
		);

		snapshot = {
			dispatchPolicyDigest: request.policyDigest,
			requests: [durableRequest],
			receipts: [durableReceipt],
			receiptSet,
			candidates: [{ candidate, candidateCreatedRef }],
			activityClaims: [
				{
					activityId: request.actionId,
					idempotencyKey: request.idempotencyKey,
					claimEventRef: completion.activityClaimEventRef,
					claimEventDigest: completion.activityClaimEventDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					leaseId: "candidate-create-lease",
					leaseExpiresAt: "2016-12-31t23:59:60.000000001123Z",
					result: {
						resultEventRef: completion.activityResultEventRef,
						resultEventDigest: completion.activityResultEventDigest,
						claimEventRef: completion.activityClaimEventRef,
						claimEventDigest: completion.activityClaimEventDigest,
						outcome: "succeeded",
					},
				},
			],
		};

		const recordCandidateCompletion = port.recordCandidateCompletion;
		expect(recordCandidateCompletion).toBeTypeOf("function");
		const recorded = await recordCandidateCompletion!.call(port, completion);

		expect(resolveCalls).toBe(2);
		expect(recorded.completionDigest).toBe(completion.completionDigest);
		expect(fake.emits.at(-1)).toEqual({
			kind: "candidate_completion_recorded_v1",
			id: recorded.candidateCompletionRef,
			parent: candidateCreatedRef,
			occurredAt: completion.completedAt,
			payload: {
				CandidateCompletionRecordedV1: {
					run_id: completion.runId,
					workflow_id: completion.workflowId,
					unit_id: completion.unitId,
					attempt: completion.attempt,
					provenance_ref: completion.provenanceRef,
					candidate_created_event_ref: completion.candidateCreatedEventRef,
					candidate_digest: completion.candidateDigest,
					candidate_create_action_id: completion.candidateCreateActionId,
					action_request_ref: completion.actionRequestRef,
					action_request_digest: completion.actionRequestDigest,
					activity_claim_event_ref: completion.activityClaimEventRef,
					activity_claim_event_digest: completion.activityClaimEventDigest,
					activity_result_event_ref: completion.activityResultEventRef,
					activity_result_event_digest: completion.activityResultEventDigest,
					action_receipt_ref: completion.actionReceiptRef,
					action_receipt_digest: completion.actionReceiptDigest,
					completion_digest: completion.completionDigest,
					completed_at: completion.completedAt,
				},
			},
		});
		await expect(
			recordCandidateCompletion!.call(port, completion),
		).resolves.toEqual(recorded);
		expect(fake.emits).toHaveLength(5);
	});

	it("reconciles an exact recovered candidate-completion proof without a second append", async () => {
		const source = createFakeEmitter();
		const sourcePort = createFreshGovernedActionEvidencePort(source.emitter);
		const request = governedActionRequest({
			actionId: "git-candidate-create:candidate-v3/run-v3/1",
			idempotencyKey: "git-candidate-create:candidate-v3/run-v3/1",
			actionKind: "git",
		});
		const durableRequest = await sourcePort.recordActionRequested(request);
		const durableReceipt = await sourcePort.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await sourcePort.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const candidateCreatedRef =
			await sourcePort.recordCandidateCreatedV2(candidate);
		const completion = candidateCompletion(
			candidate,
			candidateCreatedRef,
			durableRequest,
			durableReceipt,
		);
		const existingCompletionRef = "01900000-0000-7000-8000-0000000000a3";
		const snapshot: GovernedActionEvidenceRecoverySnapshot = {
			dispatchPolicyDigest: request.policyDigest,
			requests: [durableRequest],
			receipts: [durableReceipt],
			receiptSet,
			candidates: [{ candidate, candidateCreatedRef }],
			activityClaims: [
				{
					activityId: request.actionId,
					idempotencyKey: request.idempotencyKey,
					claimEventRef: completion.activityClaimEventRef,
					claimEventDigest: completion.activityClaimEventDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					leaseId: "candidate-create-lease",
					leaseExpiresAt: "2026-07-18T12:10:00.000Z",
					result: {
						resultEventRef: completion.activityResultEventRef,
						resultEventDigest: completion.activityResultEventDigest,
						claimEventRef: completion.activityClaimEventRef,
						claimEventDigest: completion.activityClaimEventDigest,
						outcome: "succeeded",
					},
				},
			],
			candidateCompletion: {
				candidateCompletionRef: existingCompletionRef,
				completion,
			},
		};
		let resolveCalls = 0;
		const recovered = createFakeEmitter();
		const recoveredPort = createGovernedActionEvidencePort(recovered.emitter, {
			recoveryScope: {
				runId: candidate.runId,
				workflowId: candidate.workflowId,
				unitId: candidate.unitId,
				attempt: candidate.attempt,
				provenanceRef: candidate.provenanceRef,
				dispatchEnvelopeDigest: candidate.envelopeDigest,
			},
			recoveryResolver: {
				async resolveDispatch() {
					resolveCalls += 1;
					return snapshot;
				},
			},
		});

		await expect(
			recoveredPort.recordCandidateCompletion?.(completion),
		).resolves.toEqual({
			candidateCompletionRef: existingCompletionRef,
			completionDigest: completion.completionDigest,
		});
		expect(resolveCalls).toBe(2);
		expect(recovered.emits).toEqual([]);
	});

	it("serializes concurrent ports so only one candidate-completion event is appended", async () => {
		const source = createFakeEmitter();
		const sourcePort = createFreshGovernedActionEvidencePort(source.emitter);
		const request = governedActionRequest({
			actionId: "git-candidate-create:candidate-v3/run-v3/1",
			idempotencyKey: "git-candidate-create:candidate-v3/run-v3/1",
			actionKind: "git",
		});
		const durableRequest = await sourcePort.recordActionRequested(request);
		const durableReceipt = await sourcePort.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await sourcePort.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const candidateCreatedRef =
			await sourcePort.recordCandidateCreatedV2(candidate);
		const completion = candidateCompletion(
			candidate,
			candidateCreatedRef,
			durableRequest,
			durableReceipt,
		);
		let snapshot: GovernedActionEvidenceRecoverySnapshot = {
			dispatchPolicyDigest: request.policyDigest,
			requests: [durableRequest],
			receipts: [durableReceipt],
			receiptSet,
			candidates: [{ candidate, candidateCreatedRef }],
			activityClaims: [
				{
					activityId: request.actionId,
					idempotencyKey: request.idempotencyKey,
					claimEventRef: completion.activityClaimEventRef,
					claimEventDigest: completion.activityClaimEventDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					leaseId: "candidate-create-lease",
					leaseExpiresAt: "2026-07-18T12:10:00.000Z",
					result: {
						resultEventRef: completion.activityResultEventRef,
						resultEventDigest: completion.activityResultEventDigest,
						claimEventRef: completion.activityClaimEventRef,
						claimEventDigest: completion.activityClaimEventDigest,
						outcome: "succeeded",
					},
				},
			],
		};
		const fake = createFakeEmitter();
		const sharedEmitter: TapeEmitter = {
			...fake.emitter,
			emit(kind, payload, options) {
				fake.emitter.emit(kind, payload, options);
				if (kind === "candidate_completion_recorded_v1") {
					snapshot = {
						...snapshot,
						candidateCompletion: {
							candidateCompletionRef: options?.id as string,
							completion,
						},
					};
				}
			},
		};
		const options = {
			recoveryScope: {
				runId: candidate.runId,
				workflowId: candidate.workflowId,
				unitId: candidate.unitId,
				attempt: candidate.attempt,
				provenanceRef: candidate.provenanceRef,
				dispatchEnvelopeDigest: candidate.envelopeDigest,
			},
			recoveryResolver: {
				async resolveDispatch() {
					const observed = snapshot;
					await Promise.resolve();
					return observed;
				},
			},
		};
		const firstPort = createGovernedActionEvidencePort(sharedEmitter, options);
		const secondPort = createGovernedActionEvidencePort(sharedEmitter, options);

		const [first, second] = await Promise.all([
			firstPort.recordCandidateCompletion?.(completion),
			secondPort.recordCandidateCompletion?.(completion),
		]);
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			completionDigest: completion.completionDigest,
		});
		expect(
			fake.emits.filter(
				({ kind }) => kind === "candidate_completion_recorded_v1",
			),
		).toHaveLength(1);
	});

	it("reconciles an indeterminate completion flush from fresh signed recovery", async () => {
		const fake = createFakeEmitter({ failFlushAt: 5 });
		let snapshot: GovernedActionEvidenceRecoverySnapshot = {
			dispatchPolicyDigest: DIGEST("4"),
			requests: [],
			receipts: [],
			candidates: [],
		};
		let completion: CandidateCompletionRecordedV1 | undefined;
		const emitter: TapeEmitter = {
			...fake.emitter,
			emit(kind, payload, options) {
				fake.emitter.emit(kind, payload, options);
				if (kind === "candidate_completion_recorded_v1" && completion) {
					snapshot = {
						...snapshot,
						candidateCompletion: {
							candidateCompletionRef: options?.id as string,
							completion,
						},
					};
				}
			},
		};
		const port = createGovernedActionEvidencePort(emitter, {
			recoveryResolver: {
				async resolveDispatch() {
					return snapshot;
				},
			},
		});
		const request = governedActionRequest({
			actionId: "git-candidate-create:candidate-v3/run-v3/1",
			idempotencyKey: "git-candidate-create:candidate-v3/run-v3/1",
			actionKind: "git",
		});
		const durableRequest = await port.recordActionRequested(request);
		const durableReceipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await port.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const candidateCreatedRef = await port.recordCandidateCreatedV2(candidate);
		completion = candidateCompletion(
			candidate,
			candidateCreatedRef,
			durableRequest,
			durableReceipt,
		);
		snapshot = {
			dispatchPolicyDigest: request.policyDigest,
			requests: [durableRequest],
			receipts: [durableReceipt],
			receiptSet,
			candidates: [{ candidate, candidateCreatedRef }],
			activityClaims: [
				{
					activityId: request.actionId,
					idempotencyKey: request.idempotencyKey,
					claimEventRef: completion.activityClaimEventRef,
					claimEventDigest: completion.activityClaimEventDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					leaseId: "candidate-create-lease",
					leaseExpiresAt: "2026-07-18T12:10:00.000Z",
					result: {
						resultEventRef: completion.activityResultEventRef,
						resultEventDigest: completion.activityResultEventDigest,
						claimEventRef: completion.activityClaimEventRef,
						claimEventDigest: completion.activityClaimEventDigest,
						outcome: "succeeded",
					},
				},
			],
		};

		await expect(port.recordCandidateCompletion?.(completion)).rejects.toThrow(
			/append outcome is indeterminate/i,
		);
		await expect(
			port.recordCandidateCompletion?.(completion),
		).resolves.toMatchObject({ completionDigest: completion.completionDigest });
		expect(
			fake.emits.filter(
				({ kind }) => kind === "candidate_completion_recorded_v1",
			),
		).toHaveLength(1);
	});

	it("rejects non-canonical native event references before completion recovery or append", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const candidate = governedCandidateCreated(
			governedActionRequest({
				actionId: "git-candidate-create:candidate-v3/run-v3/1",
				idempotencyKey: "git-candidate-create:candidate-v3/run-v3/1",
				actionKind: "git",
			}),
			{
				actionReceiptSetRef: "receipt-set:unused",
				actionReceiptSetDigest: DIGEST("a"),
			},
		);
		const completionWithoutDigest = {
			runId: candidate.runId,
			workflowId: candidate.workflowId,
			unitId: candidate.unitId,
			attempt: candidate.attempt,
			provenanceRef: candidate.provenanceRef,
			candidateCreatedEventRef: "not-an-event-id",
			candidateDigest: candidate.candidateDigest,
			candidateCreateActionId: "git-candidate-create:candidate-v3/run-v3/1",
			actionRequestRef: "01900000-0000-7000-8000-0000000000a1",
			actionRequestDigest: DIGEST("b"),
			activityClaimEventRef: "01900000-0000-7000-8000-0000000000a2",
			activityClaimEventDigest: DIGEST("c"),
			activityResultEventRef: "01900000-0000-7000-8000-0000000000a3",
			activityResultEventDigest: DIGEST("d"),
			actionReceiptRef: "receipt:unused",
			actionReceiptDigest: DIGEST("e"),
			completedAt: "2026-07-18T12:02:00.000Z",
		};
		const invalid = {
			...completionWithoutDigest,
			completionDigest: canonicalCandidateCompletionRecordedV1Digest(
				completionWithoutDigest,
			),
		};

		await expect(port.recordCandidateCompletion?.(invalid)).rejects.toThrow(
			/candidateCreatedEventRef must be a canonical lowercase UUID event id/i,
		);
		expect(fake.emits).toEqual([]);
	});

	it("is idempotent per run while rejecting conflicting records for the same identity", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const request = governedActionRequest();

		const firstRequest = await port.recordActionRequested(request);
		const repeatedRequest = await port.recordActionRequested(request);
		expect(repeatedRequest).toEqual(firstRequest);
		await expect(
			port.recordActionRequested({ ...request, policyDigest: DIGEST("0") }),
		).rejects.toThrow(/policyDigest does not match the policy binding/i);

		const firstReceipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		const repeatedReceipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		expect(repeatedReceipt).toEqual(firstReceipt);

		const receiptSet = await port.sealActionReceiptSet(
			receiptSetInput(request, [firstReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const firstCandidateRef = await port.recordCandidateCreatedV2(candidate);
		await expect(
			port.recordCandidateCreatedV2({
				...candidate,
				candidateDigest: DIGEST("0"),
			}),
		).rejects.toThrow(/conflicting CandidateCreatedV2/i);
		expect(await port.recordCandidateCreatedV2(candidate)).toBe(
			firstCandidateRef,
		);

		const otherRunRequest = await port.recordActionRequested({
			...request,
			runId: "run-v3-other",
		});
		expect(otherRunRequest.actionRequestRef).not.toBe(
			firstRequest.actionRequestRef,
		);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_receipt_set_recorded_v1",
			"candidate_created_v2",
			"action_requested_v2",
		]);
		expect(fake.flushes).toEqual([1, 2, 3, 4, 5]);
	});

	it("rejects a caller-selected policy digest before it writes a governed action request", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);

		await expect(
			port.recordActionRequested(
				governedActionRequest({ policyDigest: DIGEST("0") }),
			),
		).rejects.toThrow(/policyDigest does not match the policy binding/i);
		expect(fake.emits).toHaveLength(0);
		expect(fake.flushes).toEqual([]);
	});

	it("rejects an idempotency key rebound to a different action before a second request is emitted", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const request = governedActionRequest({
			idempotencyKey: "shared-action-effect:1",
		});
		await port.recordActionRequested(request);

		await expect(
			port.recordActionRequested({
				...request,
				actionId: "different-action-id",
			}),
		).rejects.toThrow(/idempotency.*different action/i);
		expect(fake.emits).toHaveLength(1);
		expect(fake.flushes).toEqual([1]);
	});

	it("fails closed on a flush failure before issuing durable request, receipt, or candidate references", async () => {
		const request = governedActionRequest();
		const requestFailure = createFakeEmitter({ failFlushAt: 1 });
		const requestPort = createFreshGovernedActionEvidencePort(
			requestFailure.emitter,
		);

		await expect(requestPort.recordActionRequested(request)).rejects.toThrow(
			"ledger append failed",
		);
		await expect(
			requestPort.recordActionReceipt(governedActionReceipt(request)),
		).rejects.toThrow(/previously flushed write-ahead action request/i);
		expect(requestFailure.emits).toHaveLength(1);
		expect(requestFailure.flushes).toEqual([1]);

		const candidateFailure = createFakeEmitter({ failFlushAt: 4 });
		const candidatePort = createFreshGovernedActionEvidencePort(
			candidateFailure.emitter,
		);
		const durableRequest = await candidatePort.recordActionRequested(request);
		const durableReceipt = await candidatePort.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await candidatePort.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		await expect(
			candidatePort.recordCandidateCreatedV2(
				governedCandidateCreated(request, receiptSet),
			),
		).rejects.toThrow("ledger append failed");
		expect(candidateFailure.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_receipt_set_recorded_v1",
			"candidate_created_v2",
		]);
		expect(candidateFailure.flushes).toEqual([1, 2, 3, 4]);
		expect(durableRequest.actionRequestRef).toBeTruthy();
	});

	it("rejects duplicate, unknown, and conflicting receipt references while making a seal deterministic and idempotent", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const requestA = governedActionRequest();
		const requestB = governedActionRequest({
			actionId: "action-b",
			idempotencyKey: "action-b:1",
		});
		await port.recordActionRequested(requestA);
		const receiptA = await port.recordActionReceipt(
			governedActionReceipt(requestA),
		);
		await port.recordActionRequested(requestB);
		const receiptB = await port.recordActionReceipt(
			governedActionReceipt(requestB),
		);
		const valid = receiptSetInput(requestA, [receiptB, receiptA]);
		const duplicate = receiptSetInput(requestA, [receiptA, receiptA]);

		await expect(port.sealActionReceiptSet(duplicate)).rejects.toThrow(
			/unique/i,
		);
		await expect(
			port.sealActionReceiptSet({
				...valid,
				receipts: [
					{
						actionId: "unknown-action",
						actionReceiptRef: "receipt:unknown",
						actionReceiptDigest: DIGEST("0"),
					},
				],
			}),
		).rejects.toThrow(/unknown or not-yet-durable/i);
		await expect(
			port.sealActionReceiptSet({
				...valid,
				receipts: [
					{
						actionId: receiptA.receipt.actionId,
						actionReceiptRef: receiptA.receipt.actionReceiptRef,
						actionReceiptDigest: DIGEST("0"),
					},
				],
			}),
		).rejects.toThrow(/conflicts with the durable receipt/i);

		const sealed = await port.sealActionReceiptSet(valid);
		const repeated = await port.sealActionReceiptSet({
			...valid,
			receipts: [...valid.receipts].reverse(),
			sealedAt: "2026-07-18T12:01:00.000Z",
		});
		expect(repeated).toEqual(sealed);
		expect(sealed.receipts.map((receipt) => receipt.actionId)).toEqual([
			"action-a",
			"action-b",
		]);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_receipt_set_recorded_v1",
		]);
		expect(fake.flushes).toEqual([1, 2, 3, 4, 5]);
	});

	it("refuses to seal a partial terminal receipt set for a governed dispatch", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const requestA = governedActionRequest();
		const requestB = governedActionRequest({
			actionId: "action-b",
			idempotencyKey: "action-b:1",
		});
		await port.recordActionRequested(requestA);
		const receiptA = await port.recordActionReceipt(
			governedActionReceipt(requestA),
		);
		await port.recordActionRequested(requestB);

		await expect(
			port.sealActionReceiptSet(receiptSetInput(requestA, [receiptA])),
		).rejects.toThrow(/every terminal action|pending/i);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_requested_v2",
		]);
	});

	it("refuses a receipt set that omits a known terminal action receipt", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const requestA = governedActionRequest();
		const requestB = governedActionRequest({
			actionId: "action-b",
			idempotencyKey: "action-b:1",
		});
		await port.recordActionRequested(requestA);
		const receiptA = await port.recordActionReceipt(
			governedActionReceipt(requestA),
		);
		await port.recordActionRequested(requestB);
		await port.recordActionReceipt(governedActionReceipt(requestB));

		await expect(
			port.sealActionReceiptSet(receiptSetInput(requestA, [receiptA])),
		).rejects.toThrow(/every terminal action|exactly bind/i);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_requested_v2",
			"action_receipt_recorded_v2",
		]);
	});

	it("does not emit a new action request after the dispatch receipt set is sealed", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const request = governedActionRequest();
		await port.recordActionRequested(request);
		const receipt = await port.recordActionReceipt(
			governedActionReceipt(request),
		);
		await port.sealActionReceiptSet(receiptSetInput(request, [receipt]));

		await expect(port.recordActionRequested(request)).rejects.toThrow(
			/sealed/i,
		);
		await expect(
			port.recordActionRequested(
				governedActionRequest({
					actionId: "post-seal-action",
					idempotencyKey: "post-seal-action:1",
				}),
			),
		).rejects.toThrow(/sealed/i);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_requested_v2",
			"action_receipt_recorded_v2",
			"action_receipt_set_recorded_v1",
		]);
	});

	it("orders sealed action receipts with ASCII byte order rather than locale collation", async () => {
		const fake = createFakeEmitter();
		const port = createFreshGovernedActionEvidencePort(fake.emitter);
		const upper = governedActionRequest({
			actionId: "Z-action",
			idempotencyKey: "Z-action:1",
		});
		const lower = governedActionRequest({
			actionId: "a-action",
			idempotencyKey: "a-action:1",
		});
		await port.recordActionRequested(upper);
		const upperReceipt = await port.recordActionReceipt(
			governedActionReceipt(upper),
		);
		await port.recordActionRequested(lower);
		const lowerReceipt = await port.recordActionReceipt(
			governedActionReceipt(lower),
		);

		const seal = await port.sealActionReceiptSet(
			receiptSetInput(upper, [lowerReceipt, upperReceipt]),
		);
		expect(seal.receipts.map((receipt) => receipt.actionId)).toEqual([
			"Z-action",
			"a-action",
		]);
	});

	it("rejects non-ASCII action IDs before a V3 action request reaches the tape", async () => {
		const fake = createFakeEmitter();
		const port = createGovernedActionEvidencePort(fake.emitter);

		await expect(
			port.recordActionRequested(
				governedActionRequest({ actionId: "é-action" }),
			),
		).rejects.toThrow(/ASCII/i);
		expect(fake.emits).toHaveLength(0);
	});

	it("rejects non-ASCII action IDs from the exported V3 wire conversion boundary", () => {
		expect(() =>
			toActionRequestedV2WirePayload(
				governedActionRequest({ actionId: "é-action" }),
			),
		).toThrow(/ASCII/i);
	});

	it("requires durable recovery lookup before issuing V3 action evidence", async () => {
		const fake = createFakeEmitter();
		const port = createGovernedActionEvidencePort(fake.emitter);

		await expect(
			port.recordActionRequested(governedActionRequest()),
		).rejects.toThrow(/durable recovery resolver/i);
		expect(fake.emits).toHaveLength(0);
	});

	it("snapshots the recovery resolver for the lifetime of a governed evidence port", async () => {
		const fake = createFakeEmitter();
		const options = durableActionEvidenceOptions();
		const port = createGovernedActionEvidencePort(fake.emitter, options);
		options.recoveryResolver = {
			async resolveDispatch() {
				throw new Error("mutated resolver must not be used");
			},
		};

		await expect(
			port.recordActionRequested(governedActionRequest()),
		).resolves.toMatchObject({ actionRequest: { actionId: "action-a" } });
		expect(fake.emits).toHaveLength(1);
	});

	it("binds the recovery lookup method at port construction", async () => {
		const fake = createFakeEmitter();
		const resolver = durableActionEvidenceOptions().recoveryResolver;
		const port = createGovernedActionEvidencePort(fake.emitter, {
			recoveryResolver: resolver,
		});
		resolver.resolveDispatch = async () => {
			throw new Error("mutated resolver method must not be used");
		};

		await expect(
			port.recordActionRequested(governedActionRequest()),
		).resolves.toMatchObject({ actionRequest: { actionId: "action-a" } });
		expect(fake.emits).toHaveLength(1);
	});

	it("rehydrates completed action evidence for sealing without reissuing its action", async () => {
		const fake = createFakeEmitter();
		const request = governedActionRequest();
		const recovered = recoveredActionEvidence(request, "completed");
		const port = createGovernedActionEvidencePort(
			fake.emitter,
			durableActionEvidenceOptions(recovered),
		);

		await expect(port.recordActionRequested(request)).rejects.toThrow(
			/already terminal/i,
		);
		const seal = await port.sealActionReceiptSet(
			receiptSetInput(request, [recovered.receipts[0]]),
		);
		expect(seal.receipts).toHaveLength(1);
		expect(fake.emits.map(({ kind }) => kind)).toEqual([
			"action_receipt_set_recorded_v1",
		]);
	});

	it("rehydrates a recorded candidate so a restarted port cannot append it twice", async () => {
		const bootstrapFake = createFakeEmitter();
		const bootstrap = createFreshGovernedActionEvidencePort(
			bootstrapFake.emitter,
		);
		const request = governedActionRequest();
		const durableRequest = await bootstrap.recordActionRequested(request);
		const durableReceipt = await bootstrap.recordActionReceipt(
			governedActionReceipt(request),
		);
		const receiptSet = await bootstrap.sealActionReceiptSet(
			receiptSetInput(request, [durableReceipt]),
		);
		const candidate = governedCandidateCreated(request, receiptSet);
		const restartedFake = createFakeEmitter();
		const restarted = createGovernedActionEvidencePort(
			restartedFake.emitter,
			durableActionEvidenceOptions({
				dispatchPolicyDigest: request.policyDigest,
				requests: [durableRequest],
				receipts: [durableReceipt],
				receiptSet,
				candidates: [
					{
						candidate,
						candidateCreatedRef: "recovered-candidate-created-ref",
					},
				],
			}),
		);

		expect(await restarted.recordCandidateCreatedV2(candidate)).toBe(
			"recovered-candidate-created-ref",
		);
		expect(restartedFake.emits).toHaveLength(0);
	});

	it("blocks a recovered pending action instead of reissuing its idempotency key", async () => {
		const fake = createFakeEmitter();
		const request = governedActionRequest();
		const port = createGovernedActionEvidencePort(
			fake.emitter,
			durableActionEvidenceOptions(recoveredActionEvidence(request, "pending")),
		);

		await expect(port.recordActionRequested(request)).rejects.toThrow(
			/pending/i,
		);
		expect(fake.emits).toHaveLength(0);
	});

	it("blocks a recovered unknown action instead of reissuing its idempotency key", async () => {
		const fake = createFakeEmitter();
		const request = governedActionRequest();
		const port = createGovernedActionEvidencePort(
			fake.emitter,
			durableActionEvidenceOptions(recoveredActionEvidence(request, "unknown")),
		);

		await expect(port.recordActionRequested(request)).rejects.toThrow(
			/unknown|reconciliation/i,
		);
		expect(fake.emits).toHaveLength(0);
	});

	it("rejects a receipt that does not bind its write-ahead request and blocks unknown outcomes from sealing", async () => {
		const bindingFake = createFakeEmitter();
		const bindingPort = createFreshGovernedActionEvidencePort(
			bindingFake.emitter,
		);
		const request = governedActionRequest();
		await bindingPort.recordActionRequested(request);
		await expect(
			bindingPort.recordActionReceipt(
				governedActionReceipt(request, { policyDigest: DIGEST("e") }),
			),
		).rejects.toThrow(/does not bind the exact previously flushed/i);
		expect(bindingFake.emits).toHaveLength(1);

		const unknownFake = createFakeEmitter();
		const unknownPort = createFreshGovernedActionEvidencePort(
			unknownFake.emitter,
		);
		const unknownRequest = governedActionRequest({
			actionId: "action-unknown",
			idempotencyKey: "action-unknown:1",
		});
		await unknownPort.recordActionRequested(unknownRequest);
		const unknownReceipt = await unknownPort.recordActionReceipt(
			governedActionReceipt(unknownRequest, {
				outcome: "unknown",
				failure: {
					code: "EFFECT_UNCERTAIN",
					messageDigest: DIGEST("f"),
					retryable: false,
				},
			}),
		);
		await expect(
			unknownPort.sealActionReceiptSet(
				receiptSetInput(unknownRequest, [unknownReceipt]),
			),
		).rejects.toThrow(/unknown action outcome/i);
	});
});
