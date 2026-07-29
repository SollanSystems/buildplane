import { isAbsolute } from "node:path";
import {
	canonicalActionRequestedV2Digest,
	canonicalSha256Digest,
	type DurableActionRequestV2,
	type GovernedDispatchLineageV3,
} from "@buildplane/kernel";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED } from "./governed-ledger-authority.js";
import type { GovernedActivityClaimReferenceResolver } from "./ledger-activity-claim-port.js";
import {
	deriveLedgerSpawnCwd,
	type TrustedGovernedLedgerBinary,
} from "./ledger-emit.js";
import type { NativeGovernedDispatchCommandResult } from "./ledger-governed-dispatch-resolver.js";

const EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** The one native operation set safe for a fixed, read-only reviewer lane. */
export interface NativeGovernedVerifierLeasePort {
	/**
	 * Claim the exact signed `process` action recovered from a reviewer
	 * dispatch. Neither action text nor a workspace path is caller-selectable.
	 */
	claim(
		input: NativeGovernedVerifierClaimInput,
	): Promise<NativeGovernedVerifierClaimDisposition>;
	/**
	 * Record a terminal outcome for the opaque lease. The native side derives
	 * the action identity from its signed claim projection rather than trusting
	 * an activity id supplied by this caller.
	 */
	recordResult(
		input: NativeGovernedVerifierResultInput,
	): Promise<NativeGovernedVerifierResultDisposition>;
}

export interface NativeGovernedVerifierClaimInput {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly durableRequest: DurableActionRequestV2;
	readonly leaseDurationMs: number;
}

export interface NativeGovernedVerifierResultInput {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly claim: Extract<
		NativeGovernedVerifierClaimDisposition,
		{ readonly state: "granted" }
	>;
	readonly outcome: "succeeded" | "failed" | "unknown";
	readonly resultDigest: string | null;
	readonly resultRef: string | null;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
}

export type NativeGovernedVerifierClaimDisposition =
	| {
			readonly state: "granted";
			readonly claimEventId: string;
			readonly claimEventDigest: string;
			readonly leaseId: string;
			readonly leaseExpiresAt: string;
	  }
	| {
			readonly state: "pending" | "lease_expired";
			readonly claimEventId: string;
			readonly leaseExpiresAt: string;
	  }
	| {
			readonly state: "recorded";
			readonly claimEventId: string;
			readonly resultEventId: string;
			readonly resultEventDigest: string;
			readonly resultOutcome: "succeeded" | "failed" | "unknown";
	  };

export type NativeGovernedVerifierResultDisposition =
	| {
			readonly state: "recorded";
			readonly resultEventId: string;
			readonly resultEventDigest: string;
			readonly resultOutcome: "succeeded" | "failed" | "unknown";
	  }
	| {
			readonly state: "lease_expired";
			readonly claimEventId: string;
			readonly leaseExpiresAt: string;
	  };

/**
 * The reference resolver is host-owned and returns only UUIDs discovered from
 * signature-verified replay. The native verifier independently repeats that
 * verification before minting a lease, so this TypeScript object is never the
 * final authority.
 */
export interface CreateNativeGovernedVerifierPortOptions {
	readonly projectRoot: string;
	readonly references: GovernedActivityClaimReferenceResolver;
	readonly trustedBinary?: TrustedGovernedLedgerBinary;
}

/** Test-only injected binary/runner seam; never use this for governed work. */
export interface TestOnlyNativeGovernedVerifierPortOptions
	extends Omit<CreateNativeGovernedVerifierPortOptions, "trustedBinary"> {
	readonly binary: string;
	readonly runner: NativeGovernedVerifierCommandRunner;
}

export interface NativeGovernedVerifierCommandResult
	extends NativeGovernedDispatchCommandResult {}

export type NativeGovernedVerifierCommandRunner = (
	binary: string,
	args: readonly string[],
	options: { readonly cwd: string },
) => NativeGovernedVerifierCommandResult;

interface Invocation {
	readonly binary: string;
	readonly cwd: string;
}

interface Runtime {
	readonly projectRoot: string;
	readonly references: GovernedActivityClaimReferenceResolver;
	readonly runner: NativeGovernedVerifierCommandRunner;
	resolveInvocation(): Invocation;
}

/**
 * A fixed-verifier result is meaningful only for the exact lease disposition
 * minted by this port instance. The native command owns the ultimate lease
 * authorization, while this local binding prevents a caller from relabeling a
 * same-run lease as the outcome of another reviewer dispatch before it reaches
 * the native boundary.
 */
interface GrantedClaimBinding {
	readonly runId: string;
	readonly dispatchEventRef: string;
	readonly envelopeDigest: string;
}

/**
 * Construct the production fixed-verifier authority port. It deliberately
 * fails before any same-UID native subprocess can be spawned; an isolated
 * authority broker must own this mutable lease operation.
 */
export function createNativeGovernedVerifierPort(
	options: CreateNativeGovernedVerifierPortOptions,
): NativeGovernedVerifierLeasePort {
	assertClosedOptions(options, "createNativeGovernedVerifierPort", [
		"projectRoot",
		"references",
		"trustedBinary",
	]);
	requireAbsolutePath(options.projectRoot, "projectRoot");
	captureReferences(options.references);
	throw new Error(GOVERNED_AUTHORITY_BROKER_REQUIRED);
}

/**
 * @internal Test-only native verifier seam. It keeps the production factory
 * free of arbitrary executable and runner injection while allowing contract
 * tests to exercise the closed response parser and argv construction.
 */
export function __testOnlyCreateNativeGovernedVerifierPort(
	options: TestOnlyNativeGovernedVerifierPortOptions,
): NativeGovernedVerifierLeasePort {
	assertClosedOptions(options, "__testOnlyCreateNativeGovernedVerifierPort", [
		"projectRoot",
		"references",
		"binary",
		"runner",
	]);
	const projectRoot = requireAbsolutePath(options.projectRoot, "projectRoot");
	const references = captureReferences(options.references);
	if (
		typeof options.binary !== "string" ||
		options.binary.trim().length === 0
	) {
		throw new TypeError(
			"test native governed verifier binary must be a non-empty fixture label.",
		);
	}
	if (typeof options.runner !== "function") {
		throw new TypeError(
			"test native governed verifier runner must be a function.",
		);
	}
	return createPortFromRuntime({
		projectRoot,
		references,
		runner: options.runner,
		resolveInvocation() {
			return Object.freeze({
				binary: options.binary,
				cwd: deriveLedgerSpawnCwd(options.binary, projectRoot),
			});
		},
	});
}

function createPortFromRuntime(
	runtime: Runtime,
): NativeGovernedVerifierLeasePort {
	const mintedClaims = new WeakMap<object, GrantedClaimBinding>();

	return Object.freeze({
		async claim(input: NativeGovernedVerifierClaimInput) {
			assertClaimInput(input);
			assertReviewerClaim(input);
			const dispatchEventRef = requireEventId(
				await runtime.references.resolveDispatchEventId({
					dispatch: input.dispatch,
				}),
				"resolved signed dispatch event",
			);
			const actionRequestEventRef = requireEventId(
				await runtime.references.resolveActionRequestEventId({
					dispatch: input.dispatch,
					durableRequest: input.durableRequest,
				}),
				"resolved signed reviewer action request event",
			);
			const invocation = runtime.resolveInvocation();
			const result = runtime.runner(
				invocation.binary,
				[
					"ledger",
					"governed-verifier-v1",
					"claim",
					"--run-id",
					input.dispatch.runId,
					"--project-root",
					runtime.projectRoot,
					"--dispatch-event-ref",
					dispatchEventRef,
					"--action-request-event-ref",
					actionRequestEventRef,
					"--lease-duration-ms",
					String(input.leaseDurationMs),
				],
				{ cwd: invocation.cwd },
			);
			const disposition = parseClaimResponse(
				requireSuccessfulNativeResult(result),
			);
			if (disposition.state === "granted") {
				mintedClaims.set(
					disposition,
					Object.freeze({
						runId: input.dispatch.runId,
						dispatchEventRef,
						envelopeDigest: canonicalDigest(
							input.dispatch.envelopeDigest,
							"native governed verifier dispatch envelopeDigest",
						),
					}),
				);
			}
			return disposition;
		},

		async recordResult(input: NativeGovernedVerifierResultInput) {
			assertResultInput(input);
			const binding = mintedClaims.get(input.claim);
			if (!binding) {
				throw new TypeError(
					"native governed verifier result requires the exact granted lease minted by this port instance.",
				);
			}
			const dispatchEventRef = requireEventId(
				await runtime.references.resolveDispatchEventId({
					dispatch: input.dispatch,
				}),
				"resolved signed dispatch event",
			);
			if (
				binding.runId !== input.dispatch.runId ||
				binding.dispatchEventRef !== dispatchEventRef ||
				binding.envelopeDigest !==
					canonicalDigest(
						input.dispatch.envelopeDigest,
						"native governed verifier dispatch envelopeDigest",
					)
			) {
				throw new TypeError(
					"native governed verifier lease is bound to a different signed reviewer dispatch.",
				);
			}
			const invocation = runtime.resolveInvocation();
			const result = runtime.runner(
				invocation.binary,
				[
					"ledger",
					"governed-verifier-v1",
					"result",
					"--run-id",
					input.dispatch.runId,
					"--lease-id",
					input.claim.leaseId,
					"--outcome",
					input.outcome,
					...(input.resultDigest === null
						? []
						: [
								"--result-digest",
								input.resultDigest,
								"--result-ref",
								input.resultRef ?? "",
							]),
					"--evidence-digest",
					input.evidenceDigest,
					"--evidence-ref",
					input.evidenceRef,
				],
				{ cwd: invocation.cwd },
			);
			return parseResultResponse(requireSuccessfulNativeResult(result));
		},
	});
}

function captureReferences(
	input: GovernedActivityClaimReferenceResolver,
): GovernedActivityClaimReferenceResolver {
	if (
		!input ||
		typeof input.resolveDispatchEventId !== "function" ||
		typeof input.resolveActionRequestEventId !== "function"
	) {
		throw new TypeError(
			"native governed verifier requires a signed dispatch/action-request reference resolver.",
		);
	}
	return Object.freeze({
		resolveDispatchEventId: input.resolveDispatchEventId.bind(input),
		resolveActionRequestEventId: input.resolveActionRequestEventId.bind(input),
	});
}

function assertClaimInput(input: NativeGovernedVerifierClaimInput): void {
	assertExactDataFields(input, "native governed verifier claim", [
		"dispatch",
		"durableRequest",
		"leaseDurationMs",
	]);
	if (
		!Number.isSafeInteger(input.leaseDurationMs) ||
		input.leaseDurationMs < 1_000 ||
		input.leaseDurationMs > 900_000
	) {
		throw new RangeError(
			"native governed verifier leaseDurationMs must be an integer from 1000 through 900000.",
		);
	}
}

function assertResultInput(input: NativeGovernedVerifierResultInput): void {
	assertExactDataFields(input, "native governed verifier result", [
		"dispatch",
		"claim",
		"outcome",
		"resultDigest",
		"resultRef",
		"evidenceDigest",
		"evidenceRef",
	]);
	assertReviewerDispatch(input.dispatch);
	assertGrantedClaim(input.claim);
	if (
		input.outcome !== "succeeded" &&
		input.outcome !== "failed" &&
		input.outcome !== "unknown"
	) {
		throw new TypeError(
			"native governed verifier outcome must be succeeded, failed, or unknown.",
		);
	}
	if ((input.resultDigest === null) !== (input.resultRef === null)) {
		throw new TypeError(
			"native governed verifier resultDigest and resultRef must be present together or both null.",
		);
	}
	if (input.outcome === "succeeded" && input.resultDigest === null) {
		throw new TypeError(
			"successful native governed verifier results require a digest and reference.",
		);
	}
	if (input.outcome === "unknown" && input.resultDigest !== null) {
		throw new TypeError(
			"unknown native governed verifier results must not assert a result.",
		);
	}
	if (input.resultDigest !== null) {
		canonicalDigest(
			input.resultDigest,
			"native governed verifier resultDigest",
		);
		requireNonEmpty(input.resultRef, "native governed verifier resultRef");
	}
	canonicalDigest(
		input.evidenceDigest,
		"native governed verifier evidenceDigest",
	);
	requireNonEmpty(input.evidenceRef, "native governed verifier evidenceRef");
}

function assertReviewerClaim(input: NativeGovernedVerifierClaimInput): void {
	const dispatch = input.dispatch;
	assertReviewerDispatch(dispatch);
	assertExactDataFields(
		input.durableRequest,
		"native governed verifier durable request",
		["actionRequest", "actionRequestRef", "actionRequestDigest"],
	);
	const request = input.durableRequest.actionRequest;
	const expectedDigest = canonicalActionRequestedV2Digest(request);
	requireNonEmpty(input.durableRequest.actionRequestRef, "actionRequestRef");
	if (
		expectedDigest !== input.durableRequest.actionRequestDigest ||
		request.runId !== dispatch.runId ||
		request.workflowId !== dispatch.workflowId ||
		request.unitId !== dispatch.unitId ||
		request.attempt !== dispatch.attempt ||
		request.provenanceRef !== dispatch.provenanceRef ||
		request.dispatchEnvelopeDigest !== dispatch.envelopeDigest ||
		request.capabilityBundleDigest !== dispatch.capabilityBundleDigest ||
		request.policyDigest !== dispatch.policyDigest ||
		request.contextManifestDigest !== dispatch.contextManifestDigest ||
		request.workerManifestDigest !== dispatch.workerManifestDigest ||
		request.sandboxProfileDigest !== dispatch.sandboxProfileDigest ||
		request.repositoryBindingDigest !== dispatch.repositoryBindingDigest ||
		request.ledgerAuthorityRealmDigest !==
			dispatch.ledgerAuthorityRealmDigest ||
		request.governedPacketDigest !== dispatch.governedPacketDigest ||
		request.authorityActor !== dispatch.authorityActor ||
		request.executionRole !== "reviewer" ||
		request.actionKind !== "process"
	) {
		throw new TypeError(
			"native governed verifier request must exactly bind the signed reviewer dispatch and use a process action.",
		);
	}
}

function assertReviewerDispatch(dispatch: GovernedDispatchLineageV3): void {
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3" ||
		dispatch.executionRole !== "reviewer"
	) {
		throw new TypeError(
			"native governed verifier requires a governed atomic sealed_v3 reviewer dispatch.",
		);
	}
}

function assertGrantedClaim(
	claim: NativeGovernedVerifierResultInput["claim"],
): void {
	assertExactDataFields(claim, "native governed verifier claim", [
		"state",
		"claimEventId",
		"claimEventDigest",
		"leaseId",
		"leaseExpiresAt",
	]);
	if (claim.state !== "granted") {
		throw new TypeError(
			"native governed verifier result requires a granted verifier lease.",
		);
	}
	requireEventId(claim.claimEventId, "native governed verifier claimEventId");
	canonicalDigest(
		claim.claimEventDigest,
		"native governed verifier claimEventDigest",
	);
	requireNonEmpty(claim.leaseId, "native governed verifier leaseId");
	requireTimestamp(
		claim.leaseExpiresAt,
		"native governed verifier leaseExpiresAt",
	);
}

function requireSuccessfulNativeResult(
	result: NativeGovernedVerifierCommandResult,
): string {
	if (result.error || result.status !== 0) {
		const detail = [result.error, result.stderr, result.stdout]
			.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
			.join("\n")
			.slice(0, 8_192);
		throw new Error(
			`trusted governed verifier native command failed${
				detail ? `: ${detail}` : ""
			}`,
		);
	}
	return result.stdout;
}

function parseClaimResponse(
	text: string,
): NativeGovernedVerifierClaimDisposition {
	const root = parseNativeObject(text, "governed verifier claim response");
	const status = requireString(root.status, "governed verifier claim status");
	switch (status) {
		case "granted":
			assertExactDataFields(root, "governed verifier granted response", [
				"schema_version",
				"status",
				"claim_event_ref",
				"claim_event_digest",
				"lease_id",
				"lease_expires_at",
			]);
			assertSchemaVersion(root);
			return Object.freeze({
				state: "granted",
				claimEventId: requireEventId(root.claim_event_ref, "claim_event_ref"),
				claimEventDigest: canonicalDigest(
					root.claim_event_digest,
					"claim_event_digest",
				),
				leaseId: requireNonEmpty(root.lease_id, "lease_id"),
				leaseExpiresAt: requireTimestamp(
					root.lease_expires_at,
					"lease_expires_at",
				),
			});
		case "pending":
		case "lease_expired":
			assertExactDataFields(root, `governed verifier ${status} response`, [
				"schema_version",
				"status",
				"claim_event_ref",
				"lease_expires_at",
			]);
			assertSchemaVersion(root);
			return Object.freeze({
				state: status,
				claimEventId: requireEventId(root.claim_event_ref, "claim_event_ref"),
				leaseExpiresAt: requireTimestamp(
					root.lease_expires_at,
					"lease_expires_at",
				),
			});
		case "recorded":
			assertExactDataFields(root, "governed verifier recorded claim response", [
				"schema_version",
				"status",
				"claim_event_ref",
				"result_event_ref",
				"result_event_digest",
				"outcome",
			]);
			assertSchemaVersion(root);
			return Object.freeze({
				state: "recorded",
				claimEventId: requireEventId(root.claim_event_ref, "claim_event_ref"),
				resultEventId: requireEventId(
					root.result_event_ref,
					"result_event_ref",
				),
				resultEventDigest: canonicalDigest(
					root.result_event_digest,
					"result_event_digest",
				),
				resultOutcome: requireOutcome(root.outcome),
			});
		default:
			throw new TypeError(
				"governed verifier claim response contains an unsupported status.",
			);
	}
}

function parseResultResponse(
	text: string,
): NativeGovernedVerifierResultDisposition {
	const root = parseNativeObject(text, "governed verifier result response");
	const status = requireString(root.status, "governed verifier result status");
	switch (status) {
		case "recorded":
			assertExactDataFields(
				root,
				"governed verifier recorded result response",
				[
					"schema_version",
					"status",
					"result_event_ref",
					"result_event_digest",
					"outcome",
				],
			);
			assertSchemaVersion(root);
			return Object.freeze({
				state: "recorded",
				resultEventId: requireEventId(
					root.result_event_ref,
					"result_event_ref",
				),
				resultEventDigest: canonicalDigest(
					root.result_event_digest,
					"result_event_digest",
				),
				resultOutcome: requireOutcome(root.outcome),
			});
		case "lease_expired":
			assertExactDataFields(
				root,
				"governed verifier lease_expired result response",
				["schema_version", "status", "claim_event_ref", "lease_expires_at"],
			);
			assertSchemaVersion(root);
			return Object.freeze({
				state: "lease_expired",
				claimEventId: requireEventId(root.claim_event_ref, "claim_event_ref"),
				leaseExpiresAt: requireTimestamp(
					root.lease_expires_at,
					"lease_expires_at",
				),
			});
		default:
			throw new TypeError(
				"governed verifier result response contains an unsupported status.",
			);
	}
}

function parseNativeObject(
	text: string,
	label: string,
): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new TypeError(
			`${label} returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError(`${label} must be an object.`);
	}
	return raw as Record<string, unknown>;
}

function assertSchemaVersion(record: Record<string, unknown>): void {
	if (record.schema_version !== 1) {
		throw new TypeError("governed verifier response schema_version must be 1.");
	}
}

function assertClosedOptions(
	value: unknown,
	label: string,
	fields: readonly string[],
): void {
	assertExactDataFields(value, label, fields);
}

function assertExactDataFields(
	value: unknown,
	label: string,
	fields: readonly string[],
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const allowed = new Set(fields);
	const actual = Object.getOwnPropertyNames(value);
	for (const key of actual) {
		if (!allowed.has(key)) {
			throw new TypeError(`${label} contains unsupported field ${key}.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be an own data property.`);
		}
	}
	for (const field of fields) {
		if (!Object.hasOwn(value, field)) {
			throw new TypeError(`${label} is missing required field ${field}.`);
		}
	}
}

function canonicalDigest(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a canonical sha256 digest.`);
	}
	try {
		return canonicalSha256Digest(value);
	} catch (error) {
		throw new TypeError(
			`${label} must be a canonical sha256 digest: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function requireEventId(value: unknown, label: string): string {
	if (typeof value !== "string" || !EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a native event UUID.`);
	}
	return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!isAbsolute(value)
	) {
		throw new TypeError(`${label} must be a non-empty absolute path.`);
	}
	return value;
}

function requireNonEmpty(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0")
	) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string.`);
	}
	return value;
}

function requireTimestamp(value: unknown, label: string): string {
	const timestamp = requireNonEmpty(value, label);
	if (!RFC3339_UTC.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
		throw new TypeError(`${label} must be an RFC3339 timestamp.`);
	}
	return timestamp;
}

function requireOutcome(value: unknown): "succeeded" | "failed" | "unknown" {
	if (value === "succeeded" || value === "failed" || value === "unknown") {
		return value;
	}
	throw new TypeError(
		"governed verifier response outcome must be succeeded, failed, or unknown.",
	);
}
