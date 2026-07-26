import { spawnSync } from "node:child_process";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

const INSTALLED_V5_ADMISSION_CLIENT =
	"/usr/libexec/buildplane/buildplane-v5-dispatch-admission-client";
const RESPONSE_FIELDS = [
	"schema_version",
	"protocol",
	"domain",
	"request_id",
	"run_id",
	"v5_envelope_digest",
	"status",
	"evidence",
	"signature",
] as const;
const EVIDENCE_FIELDS = [
	"run_id",
	"source_dispatch_event_id",
	"source_dispatch_event_digest",
	"admission_event_id",
	"admission_event_digest",
	"v5_envelope_digest",
	"witness_evidence_digest",
	"semantic_identity_digest",
	"idempotency_key",
	"checkpoint_event_id",
	"checkpoint_event_digest",
] as const;

export interface GovernedV5AdmissionRequestV1 {
	readonly requestId: string;
	readonly runId: string;
	readonly v5EnvelopeDigest: string;
}

export interface GovernedV5AdmissionEvidenceV1 {
	readonly run_id: string;
	readonly source_dispatch_event_id: string;
	readonly source_dispatch_event_digest: string;
	readonly admission_event_id: string;
	readonly admission_event_digest: string;
	readonly v5_envelope_digest: string;
	readonly witness_evidence_digest: string;
	readonly semantic_identity_digest: string;
	readonly idempotency_key: string;
	readonly checkpoint_event_id: string;
	readonly checkpoint_event_digest: string;
}

export interface GovernedV5AdmissionResponseV1 {
	readonly schema_version: 1;
	readonly protocol: "buildplane-v5-dispatch-admission";
	readonly domain: "protected-authority-response";
	readonly request_id: string;
	readonly run_id: string;
	readonly v5_envelope_digest: string;
	readonly status: "sealed" | "reconciliation_required";
	readonly evidence: GovernedV5AdmissionEvidenceV1 | null;
	readonly signature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
	record: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	const actual = Object.keys(record).sort();
	const expected = [...fields].sort();
	return (
		actual.length === expected.length &&
		actual.every((field, index) => field === expected[index])
	);
}

function isCanonicalUuid(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return stringifyUuid(parseUuid(value)) === value;
	} catch {
		return false;
	}
}

function isCanonicalDigest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function containsControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});
}

function parseEvidence(
	value: unknown,
	expected: GovernedV5AdmissionRequestV1,
): GovernedV5AdmissionEvidenceV1 | undefined {
	if (!isRecord(value) || !hasExactFields(value, EVIDENCE_FIELDS)) {
		return undefined;
	}
	if (
		value.run_id !== expected.runId ||
		value.v5_envelope_digest !== expected.v5EnvelopeDigest ||
		!isCanonicalUuid(value.source_dispatch_event_id) ||
		!isCanonicalUuid(value.admission_event_id) ||
		!isCanonicalUuid(value.checkpoint_event_id) ||
		!isCanonicalDigest(value.source_dispatch_event_digest) ||
		!isCanonicalDigest(value.admission_event_digest) ||
		!isCanonicalDigest(value.witness_evidence_digest) ||
		!isCanonicalDigest(value.semantic_identity_digest) ||
		!isCanonicalDigest(value.checkpoint_event_digest) ||
		typeof value.idempotency_key !== "string" ||
		value.idempotency_key.length === 0 ||
		value.idempotency_key.length > 1_024 ||
		containsControlCharacter(value.idempotency_key)
	) {
		return undefined;
	}
	return Object.freeze({
		run_id: expected.runId,
		source_dispatch_event_id: value.source_dispatch_event_id,
		source_dispatch_event_digest: value.source_dispatch_event_digest,
		admission_event_id: value.admission_event_id,
		admission_event_digest: value.admission_event_digest,
		v5_envelope_digest: expected.v5EnvelopeDigest,
		witness_evidence_digest: value.witness_evidence_digest,
		semantic_identity_digest: value.semantic_identity_digest,
		idempotency_key: value.idempotency_key,
		checkpoint_event_id: value.checkpoint_event_id,
		checkpoint_event_digest: value.checkpoint_event_digest,
	});
}

function parseResponse(
	value: unknown,
	expected: GovernedV5AdmissionRequestV1,
): GovernedV5AdmissionResponseV1 | undefined {
	if (!isRecord(value) || !hasExactFields(value, RESPONSE_FIELDS)) {
		return undefined;
	}
	if (
		value.schema_version !== 1 ||
		value.protocol !== "buildplane-v5-dispatch-admission" ||
		value.domain !== "protected-authority-response" ||
		value.request_id !== expected.requestId ||
		value.run_id !== expected.runId ||
		value.v5_envelope_digest !== expected.v5EnvelopeDigest ||
		typeof value.signature !== "string" ||
		!/^[0-9a-f]{128}$/.test(value.signature)
	) {
		return undefined;
	}
	if (value.status === "reconciliation_required") {
		if (value.evidence !== null) return undefined;
		return Object.freeze({
			schema_version: 1,
			protocol: "buildplane-v5-dispatch-admission",
			domain: "protected-authority-response",
			request_id: expected.requestId,
			run_id: expected.runId,
			v5_envelope_digest: expected.v5EnvelopeDigest,
			status: "reconciliation_required",
			evidence: null,
			signature: value.signature,
		});
	}
	if (value.status !== "sealed") return undefined;
	const evidence = parseEvidence(value.evidence, expected);
	if (evidence === undefined) return undefined;
	return Object.freeze({
		schema_version: 1,
		protocol: "buildplane-v5-dispatch-admission",
		domain: "protected-authority-response",
		request_id: expected.requestId,
		run_id: expected.runId,
		v5_envelope_digest: expected.v5EnvelopeDigest,
		status: "sealed",
		evidence,
		signature: value.signature,
	});
}

/**
 * Ask the fixed, protected native client for a read-only V5 admission result.
 *
 * The native executable verifies the protected peer and response signature.
 * This adapter independently keeps the process boundary and returned
 * projection closed. `undefined` is fail-closed and never opens local
 * authority or a fallback execution path.
 */
export async function requestGovernedV5Admission(
	input: GovernedV5AdmissionRequestV1,
): Promise<GovernedV5AdmissionResponseV1 | undefined> {
	if (
		process.platform !== "linux" ||
		!isCanonicalUuid(input.requestId) ||
		!isCanonicalUuid(input.runId) ||
		!isCanonicalDigest(input.v5EnvelopeDigest)
	) {
		return undefined;
	}
	try {
		const result = spawnSync(INSTALLED_V5_ADMISSION_CLIENT, [], {
			input: JSON.stringify({
				request_id: input.requestId,
				run_id: input.runId,
				v5_envelope_digest: input.v5EnvelopeDigest,
			}),
			encoding: "utf8",
			env: {},
			shell: false,
			timeout: 10_000,
			maxBuffer: 16 * 1024,
			windowsHide: true,
		});
		if (
			result.error !== undefined ||
			result.signal !== null ||
			result.status !== 0 ||
			result.stderr !== "" ||
			typeof result.stdout !== "string" ||
			result.stdout.length === 0 ||
			result.stdout.length > 16 * 1024
		) {
			return undefined;
		}
		return parseResponse(JSON.parse(result.stdout), input);
	} catch {
		return undefined;
	}
}
