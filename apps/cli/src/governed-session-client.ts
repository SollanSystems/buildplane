import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const INSTALLED_GOVERNED_SESSION_CLIENT =
	"/usr/libexec/buildplane/buildplane-governed-session-client";
const PROTOCOL = "buildplane-governed-session";
const MAX_PACKET_SOURCE_BYTES = 512 * 1024;
const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type GovernedSessionOperationV1 =
	| "probe"
	| "open_candidate_session"
	| "open_recovery_session"
	| "run_candidate_session"
	| "open_reviewer_session"
	| "run_reviewer_session";

interface GovernedSessionRequestBaseV1 {
	readonly schema_version: 1;
	readonly protocol: typeof PROTOCOL;
	readonly request_id: string;
	readonly operation: GovernedSessionOperationV1;
}

export interface OpenCandidateSessionClientInputV1 {
	readonly kind: "new-candidate";
	readonly packetSource: string;
	readonly projectRoot: string;
	readonly approval:
		| "operator-requested"
		| { readonly preauthorizationRef: string }
		| { readonly preauthorizedEnvelopeSource: string };
}

export interface OpenRecoverySessionClientInputV1 {
	readonly projectRoot: string;
	readonly recoveryReference: string;
	readonly approval: "operator-requested";
}

export interface OpenReviewerSessionClientInputV1 {
	readonly kind: "governed-reviewer-session-open-v1";
	readonly schemaVersion: 1;
	readonly projectRoot: string;
	readonly recoveryReference: string;
}

export interface RunGovernedSessionClientInputV1 {
	readonly operation: "run_candidate_session" | "run_reviewer_session";
	readonly recoveryReference: string;
	readonly sessionReference: string;
}

export interface OpenedGovernedSessionClientResponseV1 {
	readonly recoveryReference: string;
	readonly sessionReference: string;
}

export interface CompletedGovernedSessionClientResponseV1 {
	readonly recoveryReference: string;
	readonly sessionReference: string;
	readonly result: Readonly<Record<string, unknown>>;
}

const SUPPORTED_SESSION_OPERATIONS = Object.freeze([
	"open_candidate_session",
	"open_recovery_session",
	"run_candidate_session",
	"open_reviewer_session",
	"run_reviewer_session",
] as const);

/** Verify that the fixed native client is connected to the protected host. */
export async function probeProtectedGovernedSessionHostV1(): Promise<boolean> {
	const request: GovernedSessionRequestBaseV1 = {
		schema_version: 1,
		protocol: PROTOCOL,
		request_id: randomUUID(),
		operation: "probe",
	};
	const value = invokeNative(request);
	const record = readClosedRecord(value, [
		"schema_version",
		"protocol",
		"request_id",
		"operation",
		"status",
		"recovery_ref",
		"session_ref",
		"result",
	]);
	if (
		!record ||
		record.schema_version !== 1 ||
		record.protocol !== PROTOCOL ||
		record.request_id !== request.request_id ||
		record.operation !== "probe" ||
		record.status !== "ready" ||
		record.recovery_ref !== null ||
		record.session_ref !== null
	) {
		return false;
	}
	const result = readClosedRecord(record.result, ["operations"]);
	if (!result || !Array.isArray(result.operations)) return false;
	return (
		result.operations.length === SUPPORTED_SESSION_OPERATIONS.length &&
		result.operations.every(
			(operation, index) => operation === SUPPORTED_SESSION_OPERATIONS[index],
		)
	);
}

/**
 * Open a fresh candidate-only session through the installed native verifier.
 *
 * The native client owns executable/config/socket identity checks and verifies
 * the protected host response before writing its display-safe projection.
 */
export async function openProtectedCandidateSessionV1(
	input: OpenCandidateSessionClientInputV1,
): Promise<OpenedGovernedSessionClientResponseV1 | undefined> {
	const record = readClosedRecord(input, [
		"kind",
		"packetSource",
		"projectRoot",
		"approval",
	]);
	if (!record || record.kind !== "new-candidate") return undefined;
	const packetSource = readBoundedSource(record.packetSource);
	const projectRoot = readProjectRoot(record.projectRoot);
	const approval = encodeCandidateApproval(
		record.approval as OpenCandidateSessionClientInputV1["approval"],
	);
	if (!packetSource || !projectRoot || !approval) return undefined;
	return invokeOpen({
		schema_version: 1,
		protocol: PROTOCOL,
		request_id: randomUUID(),
		operation: "open_candidate_session",
		packet_source: packetSource,
		project_root: projectRoot,
		approval,
	});
}

export async function openProtectedRecoverySessionV1(
	input: OpenRecoverySessionClientInputV1,
): Promise<OpenedGovernedSessionClientResponseV1 | undefined> {
	const record = readClosedRecord(input, [
		"projectRoot",
		"recoveryReference",
		"approval",
	]);
	if (!record || record.approval !== "operator-requested") return undefined;
	const projectRoot = readProjectRoot(record.projectRoot);
	const recoveryReference = readOpaqueReference(record.recoveryReference);
	if (!projectRoot || !recoveryReference) return undefined;
	return invokeOpen(
		{
			schema_version: 1,
			protocol: PROTOCOL,
			request_id: randomUUID(),
			operation: "open_recovery_session",
			project_root: projectRoot,
			recovery_ref: recoveryReference,
			approval: { kind: "operator_requested" },
		},
		recoveryReference,
	);
}

/**
 * The reviewer lookup carries only the host-issued recovery reference. The
 * candidate, dispatch, action, model, mounts, and role are resolved by trusted
 * replay inside the protected host.
 */
export async function openProtectedReviewerSessionV1(
	input: OpenReviewerSessionClientInputV1,
): Promise<OpenedGovernedSessionClientResponseV1 | undefined> {
	const record = readClosedRecord(input, [
		"kind",
		"schemaVersion",
		"projectRoot",
		"recoveryReference",
	]);
	if (
		!record ||
		record.kind !== "governed-reviewer-session-open-v1" ||
		record.schemaVersion !== 1
	) {
		return undefined;
	}
	const projectRoot = readProjectRoot(record.projectRoot);
	const recoveryReference = readOpaqueReference(record.recoveryReference);
	if (!projectRoot || !recoveryReference) return undefined;
	return invokeOpen(
		{
			schema_version: 1,
			protocol: PROTOCOL,
			request_id: randomUUID(),
			operation: "open_reviewer_session",
			project_root: projectRoot,
			recovery_ref: recoveryReference,
		},
		recoveryReference,
	);
}

export async function runProtectedGovernedSessionV1(
	input: RunGovernedSessionClientInputV1,
): Promise<CompletedGovernedSessionClientResponseV1 | undefined> {
	const record = readClosedRecord(input, [
		"operation",
		"recoveryReference",
		"sessionReference",
	]);
	if (!record) return undefined;
	const recoveryReference = readOpaqueReference(record.recoveryReference);
	const sessionReference = readOpaqueReference(record.sessionReference);
	if (
		(record.operation !== "run_candidate_session" &&
			record.operation !== "run_reviewer_session") ||
		!recoveryReference ||
		!sessionReference
	) {
		return undefined;
	}
	const request: GovernedSessionRequestBaseV1 &
		Readonly<{
			recovery_ref: string;
			session_ref: string;
		}> = {
		schema_version: 1,
		protocol: PROTOCOL,
		request_id: randomUUID(),
		operation: record.operation,
		recovery_ref: recoveryReference,
		session_ref: sessionReference,
	};
	const response = invokeNative(request);
	if (!response) return undefined;
	return parseCompletedResponse(
		response,
		request,
		recoveryReference,
		sessionReference,
	);
}

function invokeOpen<Request extends GovernedSessionRequestBaseV1>(
	request: Request,
	expectedRecoveryReference?: string,
): OpenedGovernedSessionClientResponseV1 | undefined {
	const response = invokeNative(request);
	if (!response) return undefined;
	return parseOpenedResponse(response, request, expectedRecoveryReference);
}

function invokeNative<Request extends GovernedSessionRequestBaseV1>(
	request: Request,
): unknown {
	if (process.platform !== "linux" || !UUID.test(request.request_id)) {
		return undefined;
	}
	try {
		const result = spawnSync(INSTALLED_GOVERNED_SESSION_CLIENT, [], {
			input: JSON.stringify(request),
			encoding: "utf8",
			env: {},
			shell: false,
			timeout: 10_000,
			maxBuffer: MAX_NATIVE_RESPONSE_BYTES,
			windowsHide: true,
		});
		if (
			result.error !== undefined ||
			result.signal !== null ||
			result.status !== 0 ||
			result.stderr !== "" ||
			typeof result.stdout !== "string" ||
			result.stdout.length === 0 ||
			Buffer.byteLength(result.stdout, "utf8") > MAX_NATIVE_RESPONSE_BYTES
		) {
			return undefined;
		}
		return JSON.parse(result.stdout);
	} catch {
		return undefined;
	}
}

function parseOpenedResponse(
	value: unknown,
	request: GovernedSessionRequestBaseV1,
	expectedRecoveryReference?: string,
): OpenedGovernedSessionClientResponseV1 | undefined {
	const record = readClosedRecord(value, [
		"schema_version",
		"protocol",
		"request_id",
		"operation",
		"status",
		"recovery_ref",
		"session_ref",
		"result",
	]);
	if (
		!record ||
		record.schema_version !== 1 ||
		record.protocol !== PROTOCOL ||
		record.request_id !== request.request_id ||
		record.operation !== request.operation ||
		record.status !== "opened" ||
		record.result !== null
	) {
		return undefined;
	}
	const recoveryReference = readOpaqueReference(record.recovery_ref);
	const sessionReference = readOpaqueReference(record.session_ref);
	if (
		!recoveryReference ||
		!sessionReference ||
		(expectedRecoveryReference !== undefined &&
			recoveryReference !== expectedRecoveryReference)
	) {
		return undefined;
	}
	return Object.freeze({ recoveryReference, sessionReference });
}

function parseCompletedResponse(
	value: unknown,
	request: GovernedSessionRequestBaseV1,
	expectedRecoveryReference: string,
	expectedSessionReference: string,
): CompletedGovernedSessionClientResponseV1 | undefined {
	const record = readClosedRecord(value, [
		"schema_version",
		"protocol",
		"request_id",
		"operation",
		"status",
		"recovery_ref",
		"session_ref",
		"result",
	]);
	if (
		!record ||
		record.schema_version !== 1 ||
		record.protocol !== PROTOCOL ||
		record.request_id !== request.request_id ||
		record.operation !== request.operation ||
		record.status !== "completed" ||
		record.recovery_ref !== expectedRecoveryReference ||
		record.session_ref !== expectedSessionReference
	) {
		return undefined;
	}
	const result = readClosedDataRecord(record.result);
	if (!result) return undefined;
	return Object.freeze({
		recoveryReference: expectedRecoveryReference,
		sessionReference: expectedSessionReference,
		result,
	});
}

function encodeCandidateApproval(
	value: OpenCandidateSessionClientInputV1["approval"],
):
	| { readonly kind: "operator_requested" }
	| {
			readonly kind: "preauthorization_ref";
			readonly preauthorization_ref: string;
	  }
	| {
			readonly kind: "preauthorized_envelope_source";
			readonly preauthorized_envelope_source: string;
	  }
	| undefined {
	if (value === "operator-requested") {
		return Object.freeze({ kind: "operator_requested" as const });
	}
	const record = readClosedDataRecord(value);
	if (!record) return undefined;
	if (Object.keys(record).length !== 1) return undefined;
	if ("preauthorizationRef" in record) {
		const reference = readOpaqueReference(record.preauthorizationRef);
		return reference
			? Object.freeze({
					kind: "preauthorization_ref" as const,
					preauthorization_ref: reference,
				})
			: undefined;
	}
	if ("preauthorizedEnvelopeSource" in record) {
		const source = readBoundedSource(record.preauthorizedEnvelopeSource);
		return source
			? Object.freeze({
					kind: "preauthorized_envelope_source" as const,
					preauthorized_envelope_source: source,
				})
			: undefined;
	}
	return undefined;
}

function readBoundedSource(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= MAX_PACKET_SOURCE_BYTES
		? value
		: undefined;
}

function readProjectRoot(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.length > 4096 ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.includes("//")
	) {
		return undefined;
	}
	const segments = value.split("/");
	return segments.some((segment) => segment === "." || segment === "..")
		? undefined
		: value;
}

function readOpaqueReference(value: unknown): string | undefined {
	return typeof value === "string" &&
		OPAQUE_REFERENCE.test(value) &&
		!value.includes("..") &&
		!value.includes("//") &&
		!value.includes("@{")
		? value
		: undefined;
}

function readClosedRecord(
	value: unknown,
	fields: readonly string[],
): Record<string, unknown> | undefined {
	const record = readClosedDataRecord(value);
	if (!record) return undefined;
	const keys = Object.keys(record).sort();
	const expected = [...fields].sort();
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== expected[index])
	) {
		return undefined;
	}
	return record;
}

function readClosedDataRecord(
	value: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.getOwnPropertySymbols(value).length > 0
	) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !("value" in descriptor)) return undefined;
	}
	return Object.freeze({ ...record });
}
