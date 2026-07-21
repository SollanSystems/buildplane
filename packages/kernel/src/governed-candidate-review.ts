import type {
	CandidateAcceptanceRecord,
	CandidateArtifactProjection,
	GovernedReviewCandidateContextV1,
} from "./ports.js";
import {
	canonicalCandidateViewV1Digest,
	canonicalSha256Digest,
	type ExecutionRoleV1,
	isCanonicalBuildplaneCandidateRef,
	type ReviewVerdictV1,
} from "./trust-spine.js";

/** The immutable candidate fields a reviewer is permitted to observe. */
export type ImmutableCandidateIdentityV1 = Readonly<
	Pick<
		CandidateArtifactProjection,
		"candidateDigest" | "candidateCommitSha" | "candidateRef" | "treeDigest"
	>
>;

/**
 * A review-only dispatch descriptor. It intentionally carries neither a
 * writable project root nor any tool capability. The candidate view is the
 * only filesystem authority that reaches the worker, and it is read-only.
 */
export interface GovernedCandidateReviewerDispatchV1 {
	readonly schemaVersion: 1;
	readonly executionRole: ExecutionRoleV1;
	readonly reviewerManifestDigest: string;
	readonly reviewerContextManifestDigest: string;
	readonly reviewerSandboxProfileDigest: string;
	readonly candidateViewRef: string;
	readonly candidateViewDigest: string;
	readonly sandbox: {
		readonly mode: "read-only";
		readonly network: "disabled";
		readonly ambientTools: readonly string[];
		readonly projectRoot?: never;
		readonly writableProjectRoot?: never;
	};
	readonly projectRoot?: never;
	readonly writableProjectRoot?: never;
}

/**
 * Inputs required to run a semantic review over an already-frozen candidate.
 * The acceptance reference is a prerequisite for a review, not promotion
 * authority. This port neither writes evidence nor authorizes promotion.
 */
export interface GovernedCandidateReviewExecutionInput {
	readonly candidate: ImmutableCandidateIdentityV1;
	readonly candidateView: GovernedReviewCandidateContextV1;
	readonly reviewerDispatch: GovernedCandidateReviewerDispatchV1;
	readonly acceptance: CandidateAcceptanceRecord;
}

/**
 * The reviewer only receives frozen candidate data, its read-only view, and
 * passed acceptance data. It is not given a project root, action gateway,
 * persistence port, promotion port, or ambient tool handle.
 */
export type ReadOnlyCandidateReviewerWorker = (
	input: GovernedCandidateReviewExecutionInput,
) => Promise<unknown> | unknown;

export interface CreateGovernedCandidateReviewExecutionPortOptions {
	readonly readOnlyReviewerWorker: ReadOnlyCandidateReviewerWorker;
}

/**
 * The kernel does not currently carry an evidence-complete V2 review binding.
 * Until a caller supplies a native-verified V2 projection through a dedicated
 * authority-bearing seam, every locally parsed review remains non-promotable.
 */
export const REVIEW_PROMOTION_BLOCKED_REASON =
	"evidence-complete-v2-review-binding-not-verified" as const;

/**
 * A parsed review verdict plus an explicit statement that it conveys no
 * promotion authority. This is a review preflight result, not V2 evidence.
 */
export interface GovernedCandidateReviewExecutionResult {
	readonly verdict: ReviewVerdictV1;
	readonly promotionEligible: false;
	readonly promotionBlockedReason: typeof REVIEW_PROMOTION_BLOCKED_REASON;
}

/**
 * Narrow review-only execution seam. A successful result is a parsed semantic
 * verdict plus a permanent non-promotable preflight state. Callers must persist
 * evidence through independently verified V2 plumbing before any later
 * promotion policy can consider it.
 */
export interface GovernedCandidateReviewExecutionPort {
	executeCandidateReviewAsync(
		input: GovernedCandidateReviewExecutionInput,
	): Promise<GovernedCandidateReviewExecutionResult>;
}

/** Raised before a reviewer can run, or when its returned verdict is unsafe. */
export class GovernedCandidateReviewValidationError extends Error {
	constructor(message: string) {
		super(`governed candidate review: ${message}`);
		this.name = "GovernedCandidateReviewValidationError";
	}
}

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
function fail(message: string): never {
	throw new GovernedCandidateReviewValidationError(message);
}

function hasOwn(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		fail(`${label} must be an object.`);
	}

	// This is an untrusted runtime-schema boundary. Copy only own data
	// properties into a null-prototype record before any parser reads a field:
	// inherited values could otherwise satisfy a required field and accessors
	// could execute arbitrary code while the contract is being validated.
	try {
		if (Array.isArray(value)) {
			fail(`${label} must be an object.`);
		}
		const source = value as Record<string, unknown>;
		if (Object.getOwnPropertySymbols(source).length > 0) {
			fail(`${label} contains unsupported symbol field.`);
		}
		const record = Object.create(null) as Record<string, unknown>;
		for (const key of Object.getOwnPropertyNames(source)) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor || !("value" in descriptor)) {
				fail(`${label}.${key} must be a data property.`);
			}
			record[key] = descriptor.value;
		}
		return record;
	} catch {
		fail(`${label} could not be inspected safely.`);
	}
}

function requireOnlyFields(
	record: Record<string, unknown>,
	label: string,
	allowed: readonly string[],
): void {
	for (const key of Object.getOwnPropertyNames(record)) {
		if (!allowed.includes(key)) {
			fail(`${label} contains unsupported field '${key}'.`);
		}
	}
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(`${label} must be a non-empty string.`);
	}
	return value;
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string") {
		fail(`${label} must be a canonical SHA-256 digest.`);
	}
	try {
		return canonicalSha256Digest(value);
	} catch {
		fail(`${label} must be a canonical SHA-256 digest.`);
	}
}

function requireCommitSha(value: unknown, label: string): string {
	if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
		fail(`${label} must be a full Git commit SHA.`);
	}
	return value.toLowerCase();
}

function requireCandidateRef(value: unknown, label: string): string {
	const candidateRef = requireNonEmptyString(value, label);
	if (!isCanonicalBuildplaneCandidateRef(candidateRef)) {
		fail(`${label} must be a canonical Buildplane candidate ref.`);
	}
	return candidateRef;
}

/**
 * Review dispatches permit no ambient tools. Inspect the empty array through
 * descriptors only, then discard it, so a proxy/accessor cannot execute while
 * the reviewer boundary is being validated.
 */
function requireEmptyDataArray(value: unknown, label: string): void {
	try {
		if (
			!Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Array.prototype
		) {
			fail(`${label} must be an empty data array.`);
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			fail(`${label} must be an empty data array.`);
		}
		const names = Object.getOwnPropertyNames(value);
		const length = Object.getOwnPropertyDescriptor(value, "length");
		if (
			names.length !== 1 ||
			names[0] !== "length" ||
			!length ||
			!("value" in length) ||
			length.value !== 0
		) {
			fail(`${label} must be an empty data array.`);
		}
	} catch {
		fail(`${label} must be an empty data array.`);
	}
}

function canonicalCandidateViewDigest(input: {
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly candidateRef: string;
	readonly candidateTreeDigest: string;
	readonly reviewerContextManifestDigest: string;
	readonly reviewerSandboxProfileDigest: string;
	readonly mountDigest: string;
}): string {
	return canonicalCandidateViewV1Digest({
		candidateRef: input.candidateRef,
		candidateDigest: input.candidateDigest,
		candidateCommitSha: input.candidateCommitSha,
		treeDigest: input.candidateTreeDigest,
		reviewerContextManifestDigest: input.reviewerContextManifestDigest,
		reviewerSandboxProfileDigest: input.reviewerSandboxProfileDigest,
		mountPathDigest: input.mountDigest,
		readOnly: true,
		networkDisabled: true,
	});
}

function parseCandidateIdentity(input: unknown): ImmutableCandidateIdentityV1 {
	const candidate = requireRecord(input, "candidate");
	return Object.freeze({
		candidateDigest: requireDigest(
			candidate.candidateDigest,
			"candidate.candidateDigest",
		),
		candidateCommitSha: requireCommitSha(
			candidate.candidateCommitSha,
			"candidate.candidateCommitSha",
		),
		candidateRef: requireCandidateRef(
			candidate.candidateRef,
			"candidate.candidateRef",
		),
		treeDigest: requireDigest(candidate.treeDigest, "candidate.treeDigest"),
	});
}

function parseCandidateView(
	input: unknown,
	candidate: ImmutableCandidateIdentityV1,
): GovernedReviewCandidateContextV1 {
	const view = requireRecord(input, "candidateView");
	requireOnlyFields(view, "candidateView", [
		"schemaVersion",
		"candidateDigest",
		"candidateCommitSha",
		"candidateRef",
		"candidateTreeDigest",
		"candidateViewRef",
		"candidateViewDigest",
		"readOnlyMount",
		"context",
	]);
	if (view.schemaVersion !== 1) {
		fail("candidateView.schemaVersion must be 1.");
	}
	if (
		requireDigest(view.candidateDigest, "candidateView.candidateDigest") !==
		candidate.candidateDigest
	) {
		fail(
			"candidateView.candidateDigest does not match the immutable candidate.",
		);
	}
	if (
		requireCommitSha(
			view.candidateCommitSha,
			"candidateView.candidateCommitSha",
		) !== candidate.candidateCommitSha
	) {
		fail(
			"candidateView.candidateCommitSha does not match the immutable candidate.",
		);
	}
	if (
		requireCandidateRef(view.candidateRef, "candidateView.candidateRef") !==
		candidate.candidateRef
	) {
		fail("candidateView.candidateRef does not match the immutable candidate.");
	}
	if (
		requireDigest(
			view.candidateTreeDigest,
			"candidateView.candidateTreeDigest",
		) !== candidate.treeDigest
	) {
		fail(
			"candidateView.candidateTreeDigest does not match the immutable candidate.",
		);
	}

	const candidateViewRef = requireNonEmptyString(
		view.candidateViewRef,
		"candidateView.candidateViewRef",
	);
	const candidateViewDigest = requireDigest(
		view.candidateViewDigest,
		"candidateView.candidateViewDigest",
	);
	const mount = requireRecord(
		view.readOnlyMount,
		"candidateView.readOnlyMount",
	);
	requireOnlyFields(mount, "candidateView.readOnlyMount", [
		"mode",
		"mountPath",
		"mountDigest",
	]);
	if (mount.mode !== "read-only") {
		fail("candidateView.readOnlyMount.mode must be 'read-only'.");
	}
	const context = requireRecord(view.context, "candidateView.context");
	requireOnlyFields(context, "candidateView.context", [
		"contextRef",
		"contextManifestDigest",
	]);

	return Object.freeze({
		schemaVersion: 1,
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		candidateRef: candidate.candidateRef,
		candidateTreeDigest: candidate.treeDigest,
		candidateViewRef,
		candidateViewDigest,
		readOnlyMount: Object.freeze({
			mode: "read-only",
			mountPath: requireNonEmptyString(
				mount.mountPath,
				"candidateView.readOnlyMount.mountPath",
			),
			mountDigest: requireDigest(
				mount.mountDigest,
				"candidateView.readOnlyMount.mountDigest",
			),
		}),
		context: Object.freeze({
			contextRef: requireNonEmptyString(
				context.contextRef,
				"candidateView.context.contextRef",
			),
			contextManifestDigest: requireDigest(
				context.contextManifestDigest,
				"candidateView.context.contextManifestDigest",
			),
		}),
	});
}

function parseReviewerDispatch(
	input: unknown,
	candidateView: GovernedReviewCandidateContextV1,
): GovernedCandidateReviewerDispatchV1 {
	const dispatch = requireRecord(input, "reviewerDispatch");
	requireOnlyFields(dispatch, "reviewerDispatch", [
		"schemaVersion",
		"executionRole",
		"reviewerManifestDigest",
		"reviewerContextManifestDigest",
		"reviewerSandboxProfileDigest",
		"candidateViewRef",
		"candidateViewDigest",
		"sandbox",
	]);
	if (dispatch.schemaVersion !== 1) {
		fail("reviewerDispatch.schemaVersion must be 1.");
	}
	if (dispatch.executionRole !== "reviewer") {
		fail("reviewerDispatch.executionRole must be 'reviewer'.");
	}
	if (
		requireNonEmptyString(
			dispatch.candidateViewRef,
			"reviewerDispatch.candidateViewRef",
		) !== candidateView.candidateViewRef
	) {
		fail("reviewerDispatch.candidateViewRef does not match candidateView.");
	}
	if (
		requireDigest(
			dispatch.candidateViewDigest,
			"reviewerDispatch.candidateViewDigest",
		) !== candidateView.candidateViewDigest
	) {
		fail("reviewerDispatch.candidateViewDigest does not match candidateView.");
	}

	const sandbox = requireRecord(dispatch.sandbox, "reviewerDispatch.sandbox");
	requireOnlyFields(sandbox, "reviewerDispatch.sandbox", [
		"mode",
		"network",
		"ambientTools",
	]);
	if (sandbox.mode !== "read-only") {
		fail("reviewerDispatch.sandbox.mode must be 'read-only'.");
	}
	if (sandbox.network !== "disabled") {
		fail("reviewerDispatch.sandbox.network must be 'disabled'.");
	}
	requireEmptyDataArray(
		sandbox.ambientTools,
		"reviewerDispatch.sandbox.ambientTools",
	);
	const reviewerContextManifestDigest = requireDigest(
		dispatch.reviewerContextManifestDigest,
		"reviewerDispatch.reviewerContextManifestDigest",
	);
	if (
		reviewerContextManifestDigest !==
		candidateView.context.contextManifestDigest
	) {
		fail(
			"reviewerDispatch.reviewerContextManifestDigest does not match candidateView.context.",
		);
	}
	const reviewerSandboxProfileDigest = requireDigest(
		dispatch.reviewerSandboxProfileDigest,
		"reviewerDispatch.reviewerSandboxProfileDigest",
	);
	const expectedCandidateViewDigest = canonicalCandidateViewDigest({
		candidateDigest: candidateView.candidateDigest,
		candidateCommitSha: candidateView.candidateCommitSha,
		candidateRef: candidateView.candidateRef,
		candidateTreeDigest: candidateView.candidateTreeDigest,
		reviewerContextManifestDigest,
		reviewerSandboxProfileDigest,
		mountDigest: candidateView.readOnlyMount.mountDigest,
	});
	if (candidateView.candidateViewDigest !== expectedCandidateViewDigest) {
		fail(
			"candidateView.candidateViewDigest does not bind the immutable candidate, reviewer context, sandbox, and read-only mount.",
		);
	}

	return Object.freeze({
		schemaVersion: 1,
		executionRole: "reviewer",
		reviewerManifestDigest: requireDigest(
			dispatch.reviewerManifestDigest,
			"reviewerDispatch.reviewerManifestDigest",
		),
		reviewerContextManifestDigest,
		reviewerSandboxProfileDigest,
		candidateViewRef: candidateView.candidateViewRef,
		candidateViewDigest: candidateView.candidateViewDigest,
		sandbox: Object.freeze({
			mode: "read-only",
			network: "disabled",
			ambientTools: Object.freeze([]),
		}),
	});
}

function parseAcceptance(
	input: unknown,
	candidate: ImmutableCandidateIdentityV1,
): CandidateAcceptanceRecord {
	const acceptance = requireRecord(input, "acceptance");
	// Acceptance is evidence crossing into the reviewer boundary.  Do not let a
	// caller smuggle future authority, a writable view, or an alternate policy
	// binding through an otherwise well-formed legacy projection.  The explicit
	// optional contract digest preserves the raw-migration shape; every other
	// field must be introduced through a versioned contract instead.
	requireOnlyFields(acceptance, "acceptance", [
		"candidateDigest",
		"candidateCommitSha",
		"acceptanceContractDigest",
		"acceptanceRef",
		"outcome",
	]);
	if (acceptance.outcome !== "passed") {
		fail("acceptance.outcome must be 'passed' before review.");
	}
	if (
		requireDigest(acceptance.candidateDigest, "acceptance.candidateDigest") !==
		candidate.candidateDigest
	) {
		fail("acceptance.candidateDigest does not match the immutable candidate.");
	}
	if (
		requireCommitSha(
			acceptance.candidateCommitSha,
			"acceptance.candidateCommitSha",
		) !== candidate.candidateCommitSha
	) {
		fail(
			"acceptance.candidateCommitSha does not match the immutable candidate.",
		);
	}
	const acceptanceContractDigest = hasOwn(
		acceptance,
		"acceptanceContractDigest",
	)
		? requireDigest(
				acceptance.acceptanceContractDigest,
				"acceptance.acceptanceContractDigest",
			)
		: undefined;

	return Object.freeze({
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		acceptanceRef: requireNonEmptyString(
			acceptance.acceptanceRef,
			"acceptance.acceptanceRef",
		),
		outcome: "passed",
		...(acceptanceContractDigest === undefined
			? {}
			: { acceptanceContractDigest }),
	});
}

/**
 * Strictly normalizes the entire review request before any reviewer worker is
 * invoked. Composition roots may call this to reject malformed candidate-view
 * inputs before they delegate to an injected review port; it conveys no
 * evidence or promotion authority.
 */
export function validateGovernedCandidateReviewExecutionInput(
	input: GovernedCandidateReviewExecutionInput,
): GovernedCandidateReviewExecutionInput {
	const request = requireRecord(input, "review request");
	requireOnlyFields(request, "review request", [
		"candidate",
		"candidateView",
		"reviewerDispatch",
		"acceptance",
	]);
	const candidate = parseCandidateIdentity(request.candidate);
	const candidateView = parseCandidateView(request.candidateView, candidate);
	const reviewerDispatch = parseReviewerDispatch(
		request.reviewerDispatch,
		candidateView,
	);
	const acceptance = parseAcceptance(request.acceptance, candidate);

	return Object.freeze({
		candidate,
		candidateView,
		reviewerDispatch,
		acceptance,
	});
}

/**
 * Compatibility-only fail-closed stub.
 *
 * A TypeScript callback is neither an OS-attested worker nor proof of a
 * read-only candidate mount, so it must never be represented as governed
 * review authority. A future native authority must own that boundary.
 */
export function createGovernedCandidateReviewExecutionPort(
	_options: CreateGovernedCandidateReviewExecutionPortOptions,
): GovernedCandidateReviewExecutionPort {
	fail(
		"native OS-attested read-only candidate-view authority is required; arbitrary in-process reviewer callbacks cannot create a governed review execution port.",
	);
}
