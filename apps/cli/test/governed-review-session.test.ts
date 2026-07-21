import {
	type CandidateAcceptanceRecord,
	canonicalCandidateViewV1Digest,
	type GovernedCandidateReviewExecutionPort,
	type GovernedCandidateReviewerDispatchV1,
	type GovernedReviewCandidateContextV1,
	type ImmutableCandidateIdentityV1,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import * as hostBroker from "../src/governed-authority-broker-host.js";
import {
	runGovernedReviewSession,
	runHostOwnedGovernedReviewSession,
} from "../src/governed-review-session.js";

const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
const CANDIDATE_DIGEST = DIGEST("a");
const TREE_DIGEST = DIGEST("b");
const CONTEXT_DIGEST = DIGEST("c");
const SANDBOX_DIGEST = DIGEST("d");
const REVIEWER_MANIFEST_DIGEST = DIGEST("e");
const RECOVERY_REFERENCE = "recovery://governed-review/1";

function candidate(
	overrides: Partial<ImmutableCandidateIdentityV1> = {},
): ImmutableCandidateIdentityV1 {
	return {
		candidateDigest: CANDIDATE_DIGEST,
		candidateCommitSha: "1".repeat(40),
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		treeDigest: TREE_DIGEST,
		...overrides,
	};
}

function candidateView(
	identity = candidate(),
	overrides: Partial<GovernedReviewCandidateContextV1> = {},
): GovernedReviewCandidateContextV1 {
	const viewWithoutDigest = {
		schemaVersion: 1 as const,
		candidateDigest: identity.candidateDigest,
		candidateCommitSha: identity.candidateCommitSha,
		candidateRef: identity.candidateRef,
		candidateTreeDigest: identity.treeDigest,
		candidateViewRef: "event://candidate-view/1",
		readOnlyMount: {
			mode: "read-only" as const,
			mountPath: "/workspace/candidate",
			mountDigest: DIGEST("f"),
		},
		context: {
			contextRef: "event://review-context/1",
			contextManifestDigest: CONTEXT_DIGEST,
		},
		...overrides,
	};
	return {
		...viewWithoutDigest,
		candidateViewDigest:
			overrides.candidateViewDigest ??
			canonicalCandidateViewV1Digest({
				candidateRef: viewWithoutDigest.candidateRef,
				candidateDigest: viewWithoutDigest.candidateDigest,
				candidateCommitSha: viewWithoutDigest.candidateCommitSha,
				treeDigest: viewWithoutDigest.candidateTreeDigest,
				reviewerContextManifestDigest:
					viewWithoutDigest.context.contextManifestDigest,
				reviewerSandboxProfileDigest: SANDBOX_DIGEST,
				mountPathDigest: viewWithoutDigest.readOnlyMount.mountDigest,
				readOnly: true,
				networkDisabled: true,
			}),
	};
}

function reviewerDispatch(
	view: GovernedReviewCandidateContextV1,
	overrides: Partial<GovernedCandidateReviewerDispatchV1> = {},
): GovernedCandidateReviewerDispatchV1 {
	return {
		schemaVersion: 1,
		executionRole: "reviewer",
		reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
		reviewerContextManifestDigest: view.context.contextManifestDigest,
		reviewerSandboxProfileDigest: SANDBOX_DIGEST,
		candidateViewRef: view.candidateViewRef,
		candidateViewDigest: view.candidateViewDigest,
		sandbox: { mode: "read-only", network: "disabled", ambientTools: [] },
		...overrides,
	};
}

function acceptance(
	identity = candidate(),
	overrides: Partial<CandidateAcceptanceRecord> = {},
): CandidateAcceptanceRecord {
	return {
		candidateDigest: identity.candidateDigest,
		candidateCommitSha: identity.candidateCommitSha,
		acceptanceContractDigest: DIGEST("7"),
		acceptanceRef: "event://candidate-acceptance/1",
		outcome: "passed",
		...overrides,
	};
}

function port() {
	const executeCandidateReviewAsync = vi.fn(async () => {
		throw new Error("arbitrary review callback must never run");
	});
	return {
		executeCandidateReviewAsync,
		port: {
			executeCandidateReviewAsync,
		} as GovernedCandidateReviewExecutionPort,
	};
}

function input(overrides: Record<string, unknown> = {}) {
	const identity = candidate();
	const view = candidateView(identity);
	const review = port();
	return {
		candidate: identity,
		candidateView: view,
		acceptance: acceptance(identity),
		reviewerDispatch: reviewerDispatch(view),
		reviewPort: review.port,
		...overrides,
	};
}

function run(value: unknown) {
	return runGovernedReviewSession(
		value as Parameters<typeof runGovernedReviewSession>[0],
	);
}

function hostInput(overrides: Record<string, unknown> = {}) {
	return {
		projectRoot: "C:/project",
		recoveryReference: RECOVERY_REFERENCE,
		...overrides,
	};
}

function hostReviewReceipt(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		recoveryRef: RECOVERY_REFERENCE,
		candidateCreatedEventRef: "event://candidate-created/1",
		candidateCompletionEventRef: "event://candidate-completion/1",
		candidateDigest: CANDIDATE_DIGEST,
		acceptanceEventRef: "event://candidate-acceptance/1",
		acceptanceDigest: DIGEST("7"),
		reviewerDispatchEventRef: "event://reviewer-dispatch/1",
		reviewerDispatchEnvelopeDigest: DIGEST("8"),
		reviewVerdictEventRef: "event://review-verdict/1",
		verdict: {
			schemaVersion: 1,
			candidateDigest: CANDIDATE_DIGEST,
			decision: "approve",
			findings: [],
			confidence: 0.99,
			reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
		},
		tapeRootDigest: DIGEST("9"),
		nativeReceiptRef: "native://receipt/review/1",
		nativeReceiptDigest: DIGEST("f"),
		...overrides,
	};
}

function hostReviewResult(overrides: Record<string, unknown> = {}) {
	return {
		kind: "host-owned-governed-reviewer-run-result-v1",
		recoveryRef: RECOVERY_REFERENCE,
		reviewReceipt: hostReviewReceipt(),
		...overrides,
	};
}

describe("governed review session", () => {
	it("blocks an arbitrary injected review port before invoking it", async () => {
		const review = port();

		const result = await run(input({ reviewPort: review.port }));

		expect(result).toEqual({
			state: "unavailable",
			code: "REVIEW_PORT_UNAVAILABLE",
			reason:
				"native OS-attested read-only candidate-view authority is required; injected in-process review ports are not governed review authority.",
		});
		expect(review.executeCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("does not inspect a hostile review port for a valid request", async () => {
		const ownKeys = vi.fn(() => {
			throw new Error("hostile review port reflection");
		});
		const get = vi.fn(() => {
			throw new Error("hostile review port property access");
		});
		const hostilePort = new Proxy({}, { ownKeys, get });

		const result = await run(input({ reviewPort: hostilePort }));

		expect(result).toMatchObject({
			state: "unavailable",
			code: "REVIEW_PORT_UNAVAILABLE",
		});
		expect(ownKeys).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it.each([
		["a missing candidate", () => input({ candidate: undefined })],
		[
			"failed acceptance",
			() =>
				input({ acceptance: acceptance(candidate(), { outcome: "rejected" }) }),
		],
		[
			"an ambient tool grant",
			() => {
				const identity = candidate();
				const view = candidateView(identity);
				return input({
					candidate: identity,
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						sandbox: {
							mode: "read-only",
							network: "disabled",
							ambientTools: ["shell"],
						},
					}),
				});
			},
		],
		[
			"a candidate-view digest mismatch",
			() => {
				const identity = candidate();
				const view = candidateView(identity, {
					candidateViewDigest: DIGEST("0"),
				});
				return input({
					candidate: identity,
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view),
				});
			},
		],
	] as const)("blocks %s before it can invoke an injected review port", async (_label, buildInput) => {
		const review = port();
		const result = await run({ ...buildInput(), reviewPort: review.port });

		expect(result).toMatchObject({
			state: "unavailable",
			code: "REVIEW_REQUEST_INVALID",
		});
		expect(review.executeCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("does not read an accessor-backed top-level input before rejecting it", async () => {
		const review = port();
		const accessorInput = input({ reviewPort: review.port });
		const candidateGetter = vi.fn(() => candidate());
		Object.defineProperty(accessorInput, "candidate", {
			get: candidateGetter,
			enumerable: true,
		});

		const result = await run(accessorInput);

		expect(result).toMatchObject({
			state: "unavailable",
			code: "INVALID_INPUT",
		});
		expect(candidateGetter).not.toHaveBeenCalled();
		expect(review.executeCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("fails closed when a malformed input proxy throws during reflection", async () => {
		const review = port();
		const hostileInput = new Proxy(input({ reviewPort: review.port }), {
			ownKeys() {
				throw new Error("hostile input reflection");
			},
		});

		const result = await run(hostileInput);

		expect(result).toMatchObject({
			state: "unavailable",
			code: "INVALID_INPUT",
		});
		expect(review.executeCandidateReviewAsync).not.toHaveBeenCalled();
	});

	it("keeps the legacy reviewPort field non-authoritative when it is absent", async () => {
		const result = await run(input({ reviewPort: undefined }));

		expect(result).toMatchObject({
			state: "unavailable",
			code: "REVIEW_PORT_UNAVAILABLE",
		});
	});

	it("rejects an unexpected top-level authority field without touching the port", async () => {
		const review = port();
		const result = await run(
			input({
				reviewPort: review.port,
				promotionAuthority: "operator://unexpected",
			}),
		);

		expect(result).toMatchObject({
			state: "unavailable",
			code: "INVALID_INPUT",
		});
		expect(review.executeCandidateReviewAsync).not.toHaveBeenCalled();
	});
});

describe("host-owned governed review session", () => {
	it("fails closed when no OS-authenticated host reviewer authority is installed", async () => {
		await expect(
			runHostOwnedGovernedReviewSession(hostInput()),
		).resolves.toEqual({
			state: "unavailable",
			code: "HOST_AUTHORITY_UNAVAILABLE",
			reason: "governed review requires a host-owned reviewer authority.",
		});
	});

	it("does not resolve a host authority for malformed caller input", async () => {
		const resolve = vi.spyOn(hostBroker, "resolveHostOwnedGovernedBroker");
		try {
			const result = await runHostOwnedGovernedReviewSession(
				hostInput({ promotionDecision: "unexpected" }) as never,
			);

			expect(result).toMatchObject({
				state: "unavailable",
				code: "INVALID_INPUT",
			});
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			resolve.mockRestore();
		}
	});

	it("opens only the predeclared host reviewer activity and returns immutable non-promotable evidence", async () => {
		const run = vi.fn(async () => hostReviewResult());
		const openReviewerSession = vi.fn(async () => ({
			kind: "host-owned-governed-reviewer-session-v1",
			recoveryRef: RECOVERY_REFERENCE,
			run,
		}));
		const resolve = vi
			.spyOn(hostBroker, "resolveHostOwnedGovernedBroker")
			.mockResolvedValue({ openReviewerSession } as never);
		try {
			const result = await runHostOwnedGovernedReviewSession(hostInput());

			expect(openReviewerSession).toHaveBeenCalledWith({
				kind: "governed-reviewer-session-open-v1",
				schemaVersion: 1,
				projectRoot: "C:/project",
				recoveryReference: RECOVERY_REFERENCE,
			});
			expect(run).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				state: "reviewed-nonpromotable",
				verdict: { decision: "approve", candidateDigest: CANDIDATE_DIGEST },
				promotionEligible: false,
				promotionBlockedReason:
					"evidence-complete-v2-review-binding-not-verified",
				reviewReceipt: {
					recoveryRef: RECOVERY_REFERENCE,
					candidateDigest: CANDIDATE_DIGEST,
				},
			});
			if (result.state === "reviewed-nonpromotable") {
				expect(Object.isFrozen(result.reviewReceipt)).toBe(true);
				expect(Object.isFrozen(result.verdict)).toBe(true);
			}
		} finally {
			resolve.mockRestore();
		}
	});

	it("blocks mismatched host session identity before it can run a reviewer", async () => {
		const run = vi.fn(async () => hostReviewResult());
		const resolve = vi
			.spyOn(hostBroker, "resolveHostOwnedGovernedBroker")
			.mockResolvedValue({
				async openReviewerSession() {
					return {
						kind: "host-owned-governed-reviewer-session-v1",
						recoveryRef: "recovery://substituted",
						run,
					};
				},
			} as never);
		try {
			const result = await runHostOwnedGovernedReviewSession(hostInput());

			expect(result).toMatchObject({
				state: "unavailable",
				code: "HOST_REVIEW_SESSION_UNAVAILABLE",
			});
			expect(run).not.toHaveBeenCalled();
		} finally {
			resolve.mockRestore();
		}
	});

	it("rejects a host review result whose verdict is not bound to the reviewed candidate", async () => {
		const resolve = vi
			.spyOn(hostBroker, "resolveHostOwnedGovernedBroker")
			.mockResolvedValue({
				async openReviewerSession() {
					return {
						kind: "host-owned-governed-reviewer-session-v1",
						recoveryRef: RECOVERY_REFERENCE,
						async run() {
							return hostReviewResult({
								reviewReceipt: hostReviewReceipt({
									verdict: {
										schemaVersion: 1,
										candidateDigest: DIGEST("0"),
										decision: "approve",
										findings: [],
										confidence: 0.99,
										reviewerManifestDigest: REVIEWER_MANIFEST_DIGEST,
									},
								}),
							});
						},
					};
				},
			} as never);
		try {
			const result = await runHostOwnedGovernedReviewSession(hostInput());

			expect(result).toMatchObject({
				state: "unavailable",
				code: "REVIEW_RESULT_INVALID",
			});
		} finally {
			resolve.mockRestore();
		}
	});
});
