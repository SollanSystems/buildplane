import {
	type CandidateAcceptanceRecord,
	type GovernedCandidateReviewExecutionPort,
	type GovernedCandidateReviewerDispatchV1,
	type GovernedReviewCandidateContextV1,
	type ImmutableCandidateIdentityV1,
	parseReviewVerdictV1,
	REVIEW_PROMOTION_BLOCKED_REASON,
	type ReviewVerdictV1,
	validateGovernedCandidateReviewExecutionInput,
} from "@buildplane/kernel";
import {
	type HostVerifiedReviewReceiptV1,
	resolveHostOwnedGovernedBroker,
} from "./governed-authority-broker-host.js";

export type GovernedReviewSessionUnavailableCode =
	| "INVALID_INPUT"
	| "REVIEW_PORT_UNAVAILABLE"
	| "REVIEW_REQUEST_INVALID"
	| "REVIEW_EXECUTION_FAILED"
	| "REVIEW_RESULT_INVALID"
	| "HOST_AUTHORITY_UNAVAILABLE"
	| "HOST_REVIEW_SESSION_UNAVAILABLE";

export type GovernedReviewSessionResult =
	| {
			readonly state: "reviewed-nonpromotable";
			readonly verdict: ReviewVerdictV1;
			/**
			 * Display-safe evidence returned by the host after it has verified and
			 * recorded the read-only reviewer activity. It is not promotion
			 * authority: this CLI process cannot append, verify, or promote from it.
			 */
			readonly reviewReceipt?: HostVerifiedReviewReceiptV1;
			readonly promotionEligible: false;
			readonly promotionBlockedReason: typeof REVIEW_PROMOTION_BLOCKED_REASON;
	  }
	| {
			readonly state: "unavailable";
			readonly code: GovernedReviewSessionUnavailableCode;
			readonly reason: string;
	  };
type GovernedReviewSessionUnavailableResult = Extract<
	GovernedReviewSessionResult,
	{ state: "unavailable" }
>;

/**
 * Candidate-review input deliberately has no project root, worker callback,
 * action gateway, capability, secret, network, evidence, Git, or promotion
 * field. The compatibility `reviewPort` field is never inspected or invoked
 * by this process: a native OS-attested reviewer session must later authorize,
 * execute, and record V2 review activity as one operation.
 */
export interface RunGovernedReviewSessionInput {
	readonly candidate: ImmutableCandidateIdentityV1;
	readonly candidateView: GovernedReviewCandidateContextV1;
	readonly acceptance: CandidateAcceptanceRecord;
	readonly reviewerDispatch: GovernedCandidateReviewerDispatchV1;
	readonly reviewPort: GovernedCandidateReviewExecutionPort;
}

/**
 * The only input the CLI may send to the privileged reviewer host. The host
 * reconstructs the candidate, acceptance, independent reviewer dispatch,
 * read-only mount, model, and activity identity from protected recovery
 * state. In particular, callers cannot select a worker, candidate, sandbox,
 * context, tools, credentials, or promotion path.
 */
export interface RunHostOwnedGovernedReviewSessionInput {
	readonly projectRoot: string;
	readonly recoveryReference: string;
}

interface PreparedReviewSession {
	readonly validated: true;
}

const INPUT_FIELDS = [
	"candidate",
	"candidateView",
	"acceptance",
	"reviewerDispatch",
	"reviewPort",
] as const;
const HOST_INPUT_FIELDS = ["projectRoot", "recoveryReference"] as const;
const HOST_SESSION_FIELDS = ["kind", "recoveryRef", "run"] as const;
const HOST_RESULT_FIELDS = ["kind", "recoveryRef", "reviewReceipt"] as const;
const HOST_RECEIPT_FIELDS = [
	"schemaVersion",
	"recoveryRef",
	"candidateCreatedEventRef",
	"candidateCompletionEventRef",
	"candidateDigest",
	"acceptanceEventRef",
	"acceptanceDigest",
	"reviewerDispatchEventRef",
	"reviewerDispatchEnvelopeDigest",
	"reviewVerdictEventRef",
	"verdict",
	"tapeRootDigest",
	"nativeReceiptRef",
	"nativeReceiptDigest",
] as const;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Validates a candidate-review request, then fails closed until a native
 * OS-attested reviewer session exists. An injected JavaScript review port is
 * not proof of a sandboxed read-only candidate view and is never invoked.
 */
export async function runGovernedReviewSession(
	input: RunGovernedReviewSessionInput,
): Promise<GovernedReviewSessionResult> {
	const prepared = prepareReviewSession(input);
	if (isUnavailable(prepared)) return prepared;

	return unavailable(
		"REVIEW_PORT_UNAVAILABLE",
		"native OS-attested read-only candidate-view authority is required; injected in-process review ports are not governed review authority.",
	);
}

/**
 * Runs exactly the reviewer activity already declared by a privileged host.
 * This is deliberately separate from the legacy callback-shaped seam above:
 * no caller-supplied review port is read, and the host receives only the
 * opaque recovery identity it created. A valid review stays non-promotable in
 * the CLI; only the native broker can later bind it into promotion authority.
 */
export async function runHostOwnedGovernedReviewSession(
	input: RunHostOwnedGovernedReviewSessionInput,
): Promise<GovernedReviewSessionResult> {
	const prepared = prepareHostReviewSession(input);
	if (isUnavailable(prepared)) return prepared;

	let broker: Awaited<ReturnType<typeof resolveHostOwnedGovernedBroker>>;
	try {
		broker = await resolveHostOwnedGovernedBroker();
	} catch {
		return unavailable(
			"HOST_AUTHORITY_UNAVAILABLE",
			"governed review requires a host-owned reviewer authority.",
		);
	}
	if (!broker) {
		return unavailable(
			"HOST_AUTHORITY_UNAVAILABLE",
			"governed review requires a host-owned reviewer authority.",
		);
	}

	let session: unknown;
	try {
		session = await broker.openReviewerSession({
			kind: "governed-reviewer-session-open-v1",
			schemaVersion: 1,
			projectRoot: prepared.projectRoot,
			recoveryReference: prepared.recoveryReference,
		});
	} catch {
		return unavailable(
			"HOST_REVIEW_SESSION_UNAVAILABLE",
			"the host-owned reviewer session could not be opened.",
		);
	}
	const sessionRecord = readClosedDataRecord(session, HOST_SESSION_FIELDS);
	if (
		!sessionRecord ||
		sessionRecord.kind !== "host-owned-governed-reviewer-session-v1" ||
		sessionRecord.recoveryRef !== prepared.recoveryReference ||
		typeof sessionRecord.run !== "function"
	) {
		return unavailable(
			"HOST_REVIEW_SESSION_UNAVAILABLE",
			"the host-owned reviewer session is malformed or bound to another recovery identity.",
		);
	}

	let result: unknown;
	try {
		result = await sessionRecord.run();
	} catch {
		return unavailable(
			"REVIEW_EXECUTION_FAILED",
			"the host-owned reviewer activity did not complete.",
		);
	}
	const receipt = parseHostReviewReceipt(result, prepared.recoveryReference);
	if (!receipt) {
		return unavailable(
			"REVIEW_RESULT_INVALID",
			"the host-owned reviewer result is malformed or does not bind its recovery identity.",
		);
	}

	return Object.freeze({
		state: "reviewed-nonpromotable" as const,
		verdict: receipt.verdict,
		reviewReceipt: receipt,
		promotionEligible: false as const,
		promotionBlockedReason: REVIEW_PROMOTION_BLOCKED_REASON,
	});
}

function prepareReviewSession(
	input: unknown,
):
	| PreparedReviewSession
	| Extract<GovernedReviewSessionResult, { state: "unavailable" }> {
	const record = readClosedDataRecord(input, INPUT_FIELDS);
	if (!record) {
		return unavailable(
			"INVALID_INPUT",
			"governed review session requires exactly candidate, candidateView, acceptance, reviewerDispatch, and reviewPort.",
		);
	}

	try {
		validateGovernedCandidateReviewExecutionInput({
			candidate: record.candidate as ImmutableCandidateIdentityV1,
			candidateView: record.candidateView as GovernedReviewCandidateContextV1,
			acceptance: record.acceptance as CandidateAcceptanceRecord,
			reviewerDispatch:
				record.reviewerDispatch as GovernedCandidateReviewerDispatchV1,
		});
	} catch {
		return unavailable(
			"REVIEW_REQUEST_INVALID",
			"governed review request is not an immutable read-only candidate review.",
		);
	}

	// `reviewPort` remains part of the compatibility input shape but is
	// deliberately not read here. A caller-controlled object cannot attest a
	// read-only mount, worker identity, or native V2 evidence binding.
	return Object.freeze({ validated: true });
}

function prepareHostReviewSession(
	input: unknown,
):
	| { readonly projectRoot: string; readonly recoveryReference: string }
	| Extract<GovernedReviewSessionResult, { state: "unavailable" }> {
	const record = readClosedDataRecord(input, HOST_INPUT_FIELDS);
	if (!record) {
		return unavailable(
			"INVALID_INPUT",
			"host-owned governed review requires exactly projectRoot and recoveryReference.",
		);
	}
	const projectRoot = readNonBlankString(record.projectRoot);
	const recoveryReference = readNonBlankString(record.recoveryReference);
	if (!projectRoot || !recoveryReference) {
		return unavailable(
			"INVALID_INPUT",
			"host-owned governed review requires non-empty projectRoot and recoveryReference.",
		);
	}
	return Object.freeze({ projectRoot, recoveryReference });
}

function parseHostReviewReceipt(
	input: unknown,
	recoveryReference: string,
): HostVerifiedReviewReceiptV1 | undefined {
	const result = readClosedDataRecord(input, HOST_RESULT_FIELDS);
	if (
		!result ||
		result.kind !== "host-owned-governed-reviewer-run-result-v1" ||
		result.recoveryRef !== recoveryReference
	) {
		return undefined;
	}
	const receipt = readClosedDataRecord(
		result.reviewReceipt,
		HOST_RECEIPT_FIELDS,
	);
	if (
		!receipt ||
		receipt.schemaVersion !== 1 ||
		receipt.recoveryRef !== recoveryReference
	) {
		return undefined;
	}
	const candidateDigest = readCanonicalDigest(receipt.candidateDigest);
	const acceptanceDigest = readCanonicalDigest(receipt.acceptanceDigest);
	const reviewerDispatchEnvelopeDigest = readCanonicalDigest(
		receipt.reviewerDispatchEnvelopeDigest,
	);
	const tapeRootDigest = readCanonicalDigest(receipt.tapeRootDigest);
	const nativeReceiptDigest = readCanonicalDigest(receipt.nativeReceiptDigest);
	const candidateCreatedEventRef = readNonBlankString(
		receipt.candidateCreatedEventRef,
	);
	const candidateCompletionEventRef = readNonBlankString(
		receipt.candidateCompletionEventRef,
	);
	const acceptanceEventRef = readNonBlankString(receipt.acceptanceEventRef);
	const reviewerDispatchEventRef = readNonBlankString(
		receipt.reviewerDispatchEventRef,
	);
	const reviewVerdictEventRef = readNonBlankString(
		receipt.reviewVerdictEventRef,
	);
	const nativeReceiptRef = readNonBlankString(receipt.nativeReceiptRef);
	if (
		!candidateDigest ||
		!acceptanceDigest ||
		!reviewerDispatchEnvelopeDigest ||
		!tapeRootDigest ||
		!nativeReceiptDigest ||
		!candidateCreatedEventRef ||
		!candidateCompletionEventRef ||
		!acceptanceEventRef ||
		!reviewerDispatchEventRef ||
		!reviewVerdictEventRef ||
		!nativeReceiptRef
	) {
		return undefined;
	}
	let verdict: ReviewVerdictV1;
	try {
		verdict = freezeVerdict(parseReviewVerdictV1(receipt.verdict));
	} catch {
		return undefined;
	}
	if (verdict.candidateDigest !== candidateDigest) return undefined;

	return Object.freeze({
		schemaVersion: 1 as const,
		recoveryRef: recoveryReference,
		candidateCreatedEventRef,
		candidateCompletionEventRef,
		candidateDigest,
		acceptanceEventRef,
		acceptanceDigest,
		reviewerDispatchEventRef,
		reviewerDispatchEnvelopeDigest,
		reviewVerdictEventRef,
		verdict,
		tapeRootDigest,
		nativeReceiptRef,
		nativeReceiptDigest,
	});
}

function freezeVerdict(verdict: ReviewVerdictV1): ReviewVerdictV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		candidateDigest: verdict.candidateDigest,
		decision: verdict.decision,
		findings: Object.freeze(
			verdict.findings.map((finding) =>
				Object.freeze({
					severity: finding.severity,
					checkId: finding.checkId,
					file: finding.file,
					line: finding.line,
					explanation: finding.explanation,
					evidenceRefs: Object.freeze([...finding.evidenceRefs]),
				}),
			),
		),
		confidence: verdict.confidence,
		reviewerManifestDigest: verdict.reviewerManifestDigest,
	});
}

function readCanonicalDigest(value: unknown): string | undefined {
	return typeof value === "string" && SHA256_DIGEST.test(value)
		? value
		: undefined;
}

function readNonBlankString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function readClosedDataRecord(
	value: unknown,
	allowed: readonly string[],
): Record<string, unknown> | undefined {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return undefined;
		}
		const source = value as Record<string, unknown>;
		if (Object.getOwnPropertySymbols(source).length > 0) return undefined;
		const names = Object.getOwnPropertyNames(source);
		if (
			names.length !== allowed.length ||
			names.some((name) => !allowed.includes(name))
		) {
			return undefined;
		}
		const record = Object.create(null) as Record<string, unknown>;
		for (const name of allowed) {
			const descriptor = Object.getOwnPropertyDescriptor(source, name);
			if (!descriptor || !("value" in descriptor)) return undefined;
			record[name] = descriptor.value;
		}
		return record;
	} catch {
		return undefined;
	}
}

function unavailable(
	code: GovernedReviewSessionUnavailableCode,
	reason: string,
): GovernedReviewSessionUnavailableResult {
	return Object.freeze({ state: "unavailable" as const, code, reason });
}

function isUnavailable(
	value: unknown,
): value is GovernedReviewSessionUnavailableResult {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, "state") &&
		(value as { readonly state?: unknown }).state === "unavailable"
	);
}
