import { createHash } from "node:crypto";
import {
	GovernedCandidateReviewValidationError,
	validateGovernedCandidateReviewExecutionInput,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import {
	type CreateGovernedCandidateReviewExecutionPortOptions,
	createGovernedCandidateReviewExecutionPort,
	type GovernedCandidateReviewExecutionInput,
	type GovernedCandidateReviewerDispatchV1,
	type ImmutableCandidateIdentityV1,
} from "../src/governed-candidate-review.js";
import type {
	CandidateAcceptanceRecord,
	GovernedReviewCandidateContextV1,
} from "../src/ports.js";

const CANDIDATE_SHA = "a".repeat(40);
const CANDIDATE_DIGEST = `sha256:${"b".repeat(64)}`;
const TREE_DIGEST = `sha256:${"c".repeat(64)}`;
const MOUNT_DIGEST = `sha256:${"e".repeat(64)}`;
const CONTEXT_DIGEST = `sha256:${"f".repeat(64)}`;
const REVIEWER_MANIFEST_DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const SANDBOX_PROFILE_DIGEST = `sha256:${"3".repeat(64)}`;

type CandidateIdentity = ImmutableCandidateIdentityV1;
type ReviewInput = GovernedCandidateReviewExecutionInput;

function createPort(worker: () => unknown) {
	return createGovernedCandidateReviewExecutionPort({
		readOnlyReviewerWorker: worker,
	});
}

function candidate(): CandidateIdentity {
	return {
		candidateDigest: CANDIDATE_DIGEST,
		candidateCommitSha: CANDIDATE_SHA,
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		treeDigest: TREE_DIGEST,
	};
}

function candidateViewDigest(
	view: Omit<GovernedReviewCandidateContextV1, "candidateViewDigest">,
	reviewerSandboxProfileDigest = SANDBOX_PROFILE_DIGEST,
): string {
	return `sha256:${createHash("sha256")
		.update("buildplane.candidate-view.v1\0", "utf8")
		.update(
			JSON.stringify({
				candidate_ref: view.candidateRef,
				candidate_digest: view.candidateDigest,
				candidate_commit_sha: view.candidateCommitSha,
				tree_digest: view.candidateTreeDigest,
				reviewer_context_manifest_digest: view.context.contextManifestDigest,
				reviewer_sandbox_profile_digest: reviewerSandboxProfileDigest,
				mount_path_digest: view.readOnlyMount.mountDigest,
				read_only: true,
				network_disabled: true,
			}),
			"utf8",
		)
		.digest("hex")}`;
}

function candidateView(
	overrides: Partial<GovernedReviewCandidateContextV1> = {},
): GovernedReviewCandidateContextV1 {
	const { candidateViewDigest: suppliedDigest, ...viewOverrides } = overrides;
	const view: Omit<GovernedReviewCandidateContextV1, "candidateViewDigest"> = {
		schemaVersion: 1,
		candidateDigest: CANDIDATE_DIGEST,
		candidateCommitSha: CANDIDATE_SHA,
		candidateRef: "refs/buildplane/candidates/candidate-1/run/1",
		candidateTreeDigest: TREE_DIGEST,
		candidateViewRef: "event://candidate-view/1",
		readOnlyMount: {
			mode: "read-only",
			mountPath: "/workspace/candidate",
			mountDigest: MOUNT_DIGEST,
		},
		context: {
			contextRef: "event://review-context/1",
			contextManifestDigest: CONTEXT_DIGEST,
		},
		...viewOverrides,
	};
	return {
		...view,
		candidateViewDigest:
			suppliedDigest ?? candidateViewDigest(view, SANDBOX_PROFILE_DIGEST),
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
		reviewerSandboxProfileDigest: SANDBOX_PROFILE_DIGEST,
		candidateViewRef: view.candidateViewRef,
		candidateViewDigest: view.candidateViewDigest,
		sandbox: { mode: "read-only", network: "disabled", ambientTools: [] },
		...overrides,
	};
}

function acceptance(
	overrides: Partial<CandidateAcceptanceRecord> = {},
): CandidateAcceptanceRecord {
	return {
		candidateDigest: CANDIDATE_DIGEST,
		candidateCommitSha: CANDIDATE_SHA,
		acceptanceContractDigest: CONTEXT_DIGEST,
		acceptanceRef: "event://candidate-acceptance/1",
		outcome: "passed",
		...overrides,
	};
}

function request(overrides: Partial<ReviewInput> = {}): ReviewInput {
	const view = overrides.candidateView ?? candidateView();
	return {
		candidate: candidate(),
		candidateView: view,
		reviewerDispatch: reviewerDispatch(view),
		acceptance: acceptance(),
		...overrides,
	};
}

describe("governed candidate review execution", () => {
	it("refuses an arbitrary in-process reviewer callback before it can run", () => {
		const worker = vi.fn(() => {
			throw new Error("arbitrary callback must never run");
		});

		expect(() => createPort(worker)).toThrow(
			/native OS-attested read-only candidate-view authority/i,
		);
		expect(worker).not.toHaveBeenCalled();
	});

	it("does not inspect hostile factory options while failing closed", () => {
		const hostileOptions = new Proxy(
			{},
			{
				get() {
					throw new Error("hostile callback option getter");
				},
			},
		) as CreateGovernedCandidateReviewExecutionPortOptions;

		expect(() =>
			createGovernedCandidateReviewExecutionPort(hostileOptions),
		).toThrow(/native OS-attested read-only candidate-view authority/i);
		expect(() =>
			createGovernedCandidateReviewExecutionPort(hostileOptions),
		).not.toThrow(/hostile callback option getter/i);
	});

	it("normalizes a valid candidate review request without granting execution authority", () => {
		const normalized = validateGovernedCandidateReviewExecutionInput(request());

		expect(Object.isFrozen(normalized)).toBe(true);
		expect(Object.isFrozen(normalized.candidate)).toBe(true);
		expect(Object.isFrozen(normalized.candidateView.readOnlyMount)).toBe(true);
		expect(normalized.reviewerDispatch.sandbox).toEqual({
			mode: "read-only",
			network: "disabled",
			ambientTools: [],
		});
	});

	it.each([
		[
			"a missing candidate view",
			() => request({ candidateView: undefined as never }),
		],
		[
			"a candidate view bound to another candidate digest",
			() =>
				request({
					candidateView: candidateView({ candidateDigest: OTHER_DIGEST }),
				}),
		],
		[
			"a reviewer dispatch with a mismatched candidate-view ref",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						candidateViewRef: "event://candidate-view/other",
					}),
				});
			},
		],
		[
			"a reviewer dispatch with a malformed candidate-view digest",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						candidateViewDigest: "not-a-digest",
					}),
				});
			},
		],
		[
			"a non-reviewer dispatch role",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						executionRole: "implementer",
					}),
				});
			},
		],
		[
			"a failed deterministic acceptance",
			() => request({ acceptance: acceptance({ outcome: "rejected" }) }),
		],
		[
			"acceptance carrying an unversioned authority field",
			() =>
				request({
					acceptance: {
						...acceptance(),
						promotionAuthority: "operator://unexpected",
					} as unknown as CandidateAcceptanceRecord,
				}),
		],
		[
			"a writable project root",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: {
						...reviewerDispatch(view),
						projectRoot: "/workspace/writable",
					} as unknown as GovernedCandidateReviewerDispatchV1,
				});
			},
		],
		[
			"an ambient tool grant",
			() => {
				const view = candidateView();
				return request({
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
			"a network-enabled reviewer sandbox",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						sandbox: {
							mode: "read-only",
							network: "enabled",
							ambientTools: [],
						} as unknown as GovernedCandidateReviewerDispatchV1["sandbox"],
					}),
				});
			},
		],
		[
			"a non-canonical candidate ref",
			() =>
				request({
					candidate: {
						...candidate(),
						candidateRef: "refs/heads/main",
					},
				}),
		],
		[
			"a traversal-shaped candidate ref",
			() => {
				const candidateRef = "refs/buildplane/candidates/foo/../main";
				const view = candidateView({ candidateRef });
				return request({
					candidate: { ...candidate(), candidateRef },
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view),
				});
			},
		],
	] as const)("fails closed at the public validator for %s", (_label, buildInput) => {
		expect(() =>
			validateGovernedCandidateReviewExecutionInput(buildInput()),
		).toThrow(/governed candidate review/i);
	});

	it("rejects inherited or accessor-backed review inputs before reading them", () => {
		const inheritedCandidate = Object.create(candidate()) as CandidateIdentity;
		const accessorCandidate = { ...candidate() } as CandidateIdentity;
		const candidateDigestGetter = vi.fn(() => CANDIDATE_DIGEST);
		Object.defineProperty(accessorCandidate, "candidateDigest", {
			get: candidateDigestGetter,
			enumerable: true,
		});

		expect(() =>
			validateGovernedCandidateReviewExecutionInput(
				request({ candidate: inheritedCandidate }),
			),
		).toThrow(/governed candidate review/i);
		expect(() =>
			validateGovernedCandidateReviewExecutionInput(
				request({ candidate: accessorCandidate }),
			),
		).toThrow(/governed candidate review/i);

		expect(candidateDigestGetter).not.toHaveBeenCalled();
	});

	it("rejects unknown top-level fields through the public validator export", () => {
		expect(() =>
			validateGovernedCandidateReviewExecutionInput({
				...request(),
				promotion: "operator://unexpected",
			} as ReviewInput),
		).toThrow(/unsupported field 'promotion'/i);
	});

	it("normalizes a public-validator proxy reflection failure", () => {
		const hostileRequest = new Proxy(request(), {
			ownKeys() {
				throw new Error("hostile proxy trap");
			},
		});

		expect(() =>
			validateGovernedCandidateReviewExecutionInput(
				hostileRequest as unknown as ReviewInput,
			),
		).toThrow(GovernedCandidateReviewValidationError);
		expect(() =>
			validateGovernedCandidateReviewExecutionInput(
				hostileRequest as unknown as ReviewInput,
			),
		).not.toThrow(/hostile proxy trap/i);
	});

	it("does not inspect a proxy value thrown by reflection", () => {
		const hostileThrownValue = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("nested hostile proxy trap");
				},
			},
		);
		const hostileRequest = new Proxy(request(), {
			ownKeys() {
				throw hostileThrownValue;
			},
		});

		expect(() =>
			validateGovernedCandidateReviewExecutionInput(
				hostileRequest as unknown as ReviewInput,
			),
		).toThrow(/could not be inspected safely/i);
	});

	it("normalizes a proxy-backed ambient-tools array at the public validator", () => {
		const hostileThrownValue = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("nested ambient-tools proxy trap");
				},
			},
		);
		const ambientTools = new Proxy([], {
			ownKeys() {
				throw hostileThrownValue;
			},
		});
		const view = candidateView();
		const unsafeRequest = request({
			candidateView: view,
			reviewerDispatch: reviewerDispatch(view, {
				sandbox: {
					mode: "read-only",
					network: "disabled",
					ambientTools,
				},
			}),
		});

		expect(() =>
			validateGovernedCandidateReviewExecutionInput(unsafeRequest),
		).toThrow(/ambientTools must be an empty data array/i);
	});

	it("rejects an empty ambient-tools array subclass at the reviewer boundary", () => {
		class AmbientToolsArray extends Array<string> {}
		const view = candidateView();
		const unsafeRequest = request({
			candidateView: view,
			reviewerDispatch: reviewerDispatch(view, {
				sandbox: {
					mode: "read-only",
					network: "disabled",
					ambientTools: new AmbientToolsArray(),
				},
			}),
		});

		expect(() =>
			validateGovernedCandidateReviewExecutionInput(unsafeRequest),
		).toThrow(/ambientTools must be an empty data array/i);
	});

	it.each([
		[
			"a substituted read-only mount digest",
			() => {
				const view = candidateView();
				const substituted = {
					...view,
					readOnlyMount: { ...view.readOnlyMount, mountDigest: OTHER_DIGEST },
				};
				return request({
					candidateView: substituted,
					reviewerDispatch: reviewerDispatch(substituted),
				});
			},
		],
		[
			"a substituted reviewer context digest",
			() => {
				const view = candidateView();
				const substituted = {
					...view,
					context: {
						...view.context,
						contextManifestDigest: OTHER_DIGEST,
					},
				};
				return request({
					candidateView: substituted,
					reviewerDispatch: reviewerDispatch(substituted),
				});
			},
		],
		[
			"a substituted reviewer sandbox digest",
			() => {
				const view = candidateView();
				return request({
					candidateView: view,
					reviewerDispatch: reviewerDispatch(view, {
						reviewerSandboxProfileDigest: OTHER_DIGEST,
					}),
				});
			},
		],
	] as const)("rejects a view digest substitution at the public validator for %s", (_label, buildInput) => {
		expect(() =>
			validateGovernedCandidateReviewExecutionInput(buildInput()),
		).toThrow(/candidateViewDigest/i);
	});
});
