import { createHash } from "node:crypto";

/**
 * Immutable observations are stored before any durable memory claim. The
 * contract intentionally keeps external content tainted: a worker narrative
 * or remote tool response cannot become a routing fact by asserting that it
 * is true.
 */
export type MemoryEvidenceKindV1 =
	| "observation"
	| "verification"
	| "operator-decision"
	| "external-content";

export type MemoryEvidenceTrustV1 = "governed" | "external-tainted";

export type MemoryEvidenceStatusV1 = "active" | "quarantined" | "revoked";

export interface MemoryEvidenceV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: MemoryEvidenceKindV1;
	readonly trust: MemoryEvidenceTrustV1;
	readonly status: MemoryEvidenceStatusV1;
	/** Immutable ledger/CAS/action reference; never a model-authored summary. */
	readonly sourceRef: string;
	readonly contentDigest: string;
	readonly capturedAt: string;
	readonly digest: string;
}

export type MemoryClaimKindV1 = "fact" | "hypothesis" | "procedure" | "outcome";

export type MemoryClaimStatusV1 =
	| "draft"
	| "verified"
	| "quarantined"
	| "revoked"
	| "superseded";

export interface MemoryClaimV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: MemoryClaimKindV1;
	readonly status: MemoryClaimStatusV1;
	readonly statement: string;
	/** Canonical digests of immutable supporting observations. */
	readonly evidenceRefs: readonly string[];
	/** Canonical digests of independently collected verification observations. */
	readonly verificationRefs: readonly string[];
	/** A promoted, independently verified governed outcome. */
	readonly promotedOutcomeRef: string;
	readonly digest: string;
}

export type MemoryClaimLinkRelationV1 =
	| "supports"
	| "contradicts"
	| "supersedes"
	| "revokes";

export interface MemoryClaimLinkV1 {
	readonly schemaVersion: 1;
	readonly fromClaimDigest: string;
	readonly toClaimDigest: string;
	readonly relation: MemoryClaimLinkRelationV1;
	readonly createdAt: string;
	readonly digest: string;
}

export type MemoryRoutingIneligibilityReasonV1 =
	| "invalid-claim"
	/**
	 * V1 can only inspect caller-supplied memory records. A signature-verified
	 * native tape projection is required before any claim can influence routing.
	 */
	| "verified-tape-projection-required"
	| "claim-not-verified"
	| "missing-promotion"
	| "missing-supporting-evidence"
	| "tainted-evidence"
	| "missing-independent-verification"
	| "contradicted"
	| "superseded"
	| "revoked";

export type MemoryRoutingEligibilityV1 =
	| { readonly eligible: true }
	| {
			readonly eligible: false;
			readonly reason: MemoryRoutingIneligibilityReasonV1;
	  };

export interface CreateMemoryEvidenceV1Input {
	readonly id: string;
	readonly kind: MemoryEvidenceKindV1;
	readonly trust: MemoryEvidenceTrustV1;
	readonly sourceRef: string;
	readonly contentDigest: string;
	readonly capturedAt: string;
	readonly status?: MemoryEvidenceStatusV1;
}

export interface CreateMemoryClaimV1Input {
	readonly id: string;
	readonly kind: MemoryClaimKindV1;
	readonly status: MemoryClaimStatusV1;
	readonly statement: string;
	readonly evidenceRefs: readonly string[];
	readonly verificationRefs: readonly string[];
	readonly promotedOutcomeRef: string;
}

export interface CreateMemoryClaimLinkV1Input {
	readonly fromClaimDigest: string;
	readonly toClaimDigest: string;
	readonly relation: MemoryClaimLinkRelationV1;
	readonly createdAt: string;
}

const EVIDENCE_KINDS = new Set<MemoryEvidenceKindV1>([
	"observation",
	"verification",
	"operator-decision",
	"external-content",
]);
const EVIDENCE_TRUSTS = new Set<MemoryEvidenceTrustV1>([
	"governed",
	"external-tainted",
]);
const EVIDENCE_STATUSES = new Set<MemoryEvidenceStatusV1>([
	"active",
	"quarantined",
	"revoked",
]);
const CLAIM_KINDS = new Set<MemoryClaimKindV1>([
	"fact",
	"hypothesis",
	"procedure",
	"outcome",
]);
const CLAIM_STATUSES = new Set<MemoryClaimStatusV1>([
	"draft",
	"verified",
	"quarantined",
	"revoked",
	"superseded",
]);
const CLAIM_LINK_RELATIONS = new Set<MemoryClaimLinkRelationV1>([
	"supports",
	"contradicts",
	"supersedes",
	"revokes",
]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/**
 * Create a closed, content-addressed immutable observation for storage.
 *
 * This factory is deliberately non-authoritative: a caller can construct a
 * digest-consistent record, but only a future signature-verified native tape
 * projection may make that record eligible for routing.
 */
export function createMemoryEvidenceV1(
	input: CreateMemoryEvidenceV1Input,
): MemoryEvidenceV1 {
	const status =
		input.status ??
		(input.trust === "external-tainted" ? "quarantined" : "active");
	const body = parseMemoryEvidenceBody({ ...input, status });
	return Object.freeze({
		...body,
		digest: canonicalMemoryEvidenceV1Digest(body),
	});
}

/**
 * Create a claim for storage. V1 claim construction is non-authoritative and
 * remains shadow-only until a signature-verified tape projection exists.
 */
export function createMemoryClaimV1(
	input: CreateMemoryClaimV1Input,
): MemoryClaimV1 {
	const body = parseMemoryClaimBody(input);
	return Object.freeze({
		...body,
		digest: canonicalMemoryClaimV1Digest(body),
	});
}

/**
 * Create a claim relation for storage. Like evidence and claims, links are
 * non-authoritative until they arrive through a verified tape projection.
 */
export function createMemoryClaimLinkV1(
	input: CreateMemoryClaimLinkV1Input,
): MemoryClaimLinkV1 {
	const body = parseMemoryClaimLinkBody(input);
	return Object.freeze({
		...body,
		digest: canonicalMemoryClaimLinkV1Digest(body),
	});
}

/** Strictly parse an evidence record; unknown fields and digest drift block it. */
export function parseMemoryEvidenceV1(input: unknown): MemoryEvidenceV1 {
	const record = readClosedRecord(input, [
		"schemaVersion",
		"id",
		"kind",
		"trust",
		"status",
		"sourceRef",
		"contentDigest",
		"capturedAt",
		"digest",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError("MemoryEvidenceV1 schemaVersion is unsupported.");
	}
	const body = parseMemoryEvidenceBody(
		selectFields(record, [
			"id",
			"kind",
			"trust",
			"status",
			"sourceRef",
			"contentDigest",
			"capturedAt",
		]),
	);
	const digest = readDigest(record.digest, "digest");
	const expected = canonicalMemoryEvidenceV1Digest(body);
	if (digest !== expected) {
		throw new TypeError("MemoryEvidenceV1 digest mismatch.");
	}
	return Object.freeze({ ...body, digest });
}

/** Strictly parse a claim record; its digest never authorizes a routing fact. */
export function parseMemoryClaimV1(input: unknown): MemoryClaimV1 {
	const record = readClosedRecord(input, [
		"schemaVersion",
		"id",
		"kind",
		"status",
		"statement",
		"evidenceRefs",
		"verificationRefs",
		"promotedOutcomeRef",
		"digest",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError("MemoryClaimV1 schemaVersion is unsupported.");
	}
	const body = parseMemoryClaimBody(
		selectFields(record, [
			"id",
			"kind",
			"status",
			"statement",
			"evidenceRefs",
			"verificationRefs",
			"promotedOutcomeRef",
		]),
	);
	const digest = readDigest(record.digest, "digest");
	const expected = canonicalMemoryClaimV1Digest(body);
	if (digest !== expected) {
		throw new TypeError("MemoryClaimV1 digest mismatch.");
	}
	return Object.freeze({ ...body, digest });
}

export function parseMemoryClaimLinkV1(input: unknown): MemoryClaimLinkV1 {
	const record = readClosedRecord(input, [
		"schemaVersion",
		"fromClaimDigest",
		"toClaimDigest",
		"relation",
		"createdAt",
		"digest",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError("MemoryClaimLinkV1 schemaVersion is unsupported.");
	}
	const body = parseMemoryClaimLinkBody(
		selectFields(record, [
			"fromClaimDigest",
			"toClaimDigest",
			"relation",
			"createdAt",
		]),
	);
	const digest = readDigest(record.digest, "digest");
	const expected = canonicalMemoryClaimLinkV1Digest(body);
	if (digest !== expected) {
		throw new TypeError("MemoryClaimLinkV1 digest mismatch.");
	}
	return Object.freeze({ ...body, digest });
}

export function canonicalMemoryEvidenceV1Digest(
	input: Omit<MemoryEvidenceV1, "digest">,
): string {
	return digest("buildplane.memory-evidence.v1", input);
}

export function canonicalMemoryClaimV1Digest(
	input: Omit<MemoryClaimV1, "digest">,
): string {
	return digest("buildplane.memory-claim.v1", input);
}

export function canonicalMemoryClaimLinkV1Digest(
	input: Omit<MemoryClaimLinkV1, "digest">,
): string {
	return digest("buildplane.memory-claim-link.v1", input);
}

/**
 * Evaluate stored memory records for shadow diagnostics only.
 *
 * A routing decision never upgrades external metadata, a model statement, or
 * caller-supplied "governed" evidence into authority. V1 has no
 * signature-verified native tape projection, so even a self-consistent claim,
 * evidence set, and link graph must fail closed. The existing checks retain
 * useful ineligibility diagnostics; the final success branch is intentionally
 * replaced by `verified-tape-projection-required`.
 */
export function evaluateMemoryRoutingEligibility(input: {
	readonly claim: MemoryClaimV1;
	readonly evidence: readonly MemoryEvidenceV1[];
	readonly links: readonly MemoryClaimLinkV1[];
}): MemoryRoutingEligibilityV1 {
	let claim: MemoryClaimV1;
	try {
		claim = parseMemoryClaimV1(input.claim);
	} catch {
		return { eligible: false, reason: "invalid-claim" };
	}
	if (claim.status !== "verified") {
		return { eligible: false, reason: "claim-not-verified" };
	}
	if (!isNonEmptyString(claim.promotedOutcomeRef)) {
		return { eligible: false, reason: "missing-promotion" };
	}

	const evidenceByDigest = new Map<string, MemoryEvidenceV1>();
	try {
		for (const entry of input.evidence) {
			const parsed = parseMemoryEvidenceV1(entry);
			evidenceByDigest.set(parsed.digest, parsed);
		}
	} catch {
		return { eligible: false, reason: "missing-supporting-evidence" };
	}

	const supporting = claim.evidenceRefs.map((reference) =>
		evidenceByDigest.get(reference),
	);
	if (
		supporting.length === 0 ||
		supporting.some((entry) => entry === undefined)
	) {
		return { eligible: false, reason: "missing-supporting-evidence" };
	}
	if (
		supporting.some(
			(entry) => entry?.trust !== "governed" || entry.status !== "active",
		)
	) {
		return { eligible: false, reason: "tainted-evidence" };
	}

	const verification = claim.verificationRefs.map((reference) =>
		evidenceByDigest.get(reference),
	);
	if (
		verification.length === 0 ||
		verification.some(
			(entry) =>
				entry === undefined ||
				entry.kind !== "verification" ||
				entry.trust !== "governed" ||
				entry.status !== "active" ||
				supporting.some((support) => support?.sourceRef === entry.sourceRef),
		)
	) {
		return { eligible: false, reason: "missing-independent-verification" };
	}

	try {
		for (const rawLink of input.links) {
			const link = parseMemoryClaimLinkV1(rawLink);
			if (link.relation === "revokes" && link.toClaimDigest === claim.digest) {
				return { eligible: false, reason: "revoked" };
			}
			if (
				link.relation === "supersedes" &&
				link.toClaimDigest === claim.digest
			) {
				return { eligible: false, reason: "superseded" };
			}
			if (
				link.relation === "contradicts" &&
				(link.fromClaimDigest === claim.digest ||
					link.toClaimDigest === claim.digest)
			) {
				return { eligible: false, reason: "contradicted" };
			}
		}
	} catch {
		return { eligible: false, reason: "invalid-claim" };
	}

	return { eligible: false, reason: "verified-tape-projection-required" };
}

function parseMemoryEvidenceBody(
	input: unknown,
): Omit<MemoryEvidenceV1, "digest"> {
	const record = readClosedRecord(input, [
		"id",
		"kind",
		"trust",
		"status",
		"sourceRef",
		"contentDigest",
		"capturedAt",
	]);
	return Object.freeze({
		schemaVersion: 1 as const,
		id: readNonEmptyString(record.id, "id"),
		kind: readEnum(record.kind, EVIDENCE_KINDS, "kind"),
		trust: readEnum(record.trust, EVIDENCE_TRUSTS, "trust"),
		status: readEnum(record.status, EVIDENCE_STATUSES, "status"),
		sourceRef: readNonEmptyString(record.sourceRef, "sourceRef"),
		contentDigest: readDigest(record.contentDigest, "contentDigest"),
		capturedAt: readIsoTimestamp(record.capturedAt, "capturedAt"),
	});
}

function parseMemoryClaimBody(input: unknown): Omit<MemoryClaimV1, "digest"> {
	const record = readClosedRecord(input, [
		"id",
		"kind",
		"status",
		"statement",
		"evidenceRefs",
		"verificationRefs",
		"promotedOutcomeRef",
	]);
	return Object.freeze({
		schemaVersion: 1 as const,
		id: readNonEmptyString(record.id, "id"),
		kind: readEnum(record.kind, CLAIM_KINDS, "kind"),
		status: readEnum(record.status, CLAIM_STATUSES, "status"),
		statement: readNonEmptyString(record.statement, "statement"),
		evidenceRefs: readDigestArray(record.evidenceRefs, "evidenceRefs"),
		verificationRefs: readDigestArray(
			record.verificationRefs,
			"verificationRefs",
		),
		promotedOutcomeRef: readNonEmptyString(
			record.promotedOutcomeRef,
			"promotedOutcomeRef",
		),
	});
}

function parseMemoryClaimLinkBody(
	input: unknown,
): Omit<MemoryClaimLinkV1, "digest"> {
	const record = readClosedRecord(input, [
		"fromClaimDigest",
		"toClaimDigest",
		"relation",
		"createdAt",
	]);
	return Object.freeze({
		schemaVersion: 1 as const,
		fromClaimDigest: readDigest(record.fromClaimDigest, "fromClaimDigest"),
		toClaimDigest: readDigest(record.toClaimDigest, "toClaimDigest"),
		relation: readEnum(record.relation, CLAIM_LINK_RELATIONS, "relation"),
		createdAt: readIsoTimestamp(record.createdAt, "createdAt"),
	});
}

function readClosedRecord(
	input: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	if (!isPlainDataRecord(input)) {
		throw new TypeError("Memory record must be a plain data object.");
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Reflect.ownKeys(descriptors);
	if (
		keys.some((key) => typeof key !== "string") ||
		keys.length !== expectedKeys.length ||
		expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
	) {
		throw new TypeError("Memory record must use the closed V1 schema.");
	}
	const record: Record<string, unknown> = {};
	for (const key of expectedKeys) {
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError("Memory record cannot contain accessor fields.");
		}
		record[key] = descriptor.value;
	}
	return record;
}

function readNonEmptyString(value: unknown, field: string): string {
	if (!isNonEmptyString(value)) {
		throw new TypeError(`Memory record ${field} must be a non-empty string.`);
	}
	return value;
}

function selectFields(
	record: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): Record<string, unknown> {
	const selected: Record<string, unknown> = {};
	for (const field of fields) {
		selected[field] = record[field];
	}
	return selected;
}

function readDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256.test(value)) {
		throw new TypeError(`Memory record ${field} must be a sha256 digest.`);
	}
	return value;
}

function readEnum<T extends string>(
	value: unknown,
	allowed: ReadonlySet<T>,
	field: string,
): T {
	if (typeof value !== "string" || !allowed.has(value as T)) {
		throw new TypeError(`Memory record ${field} is unsupported.`);
	}
	return value as T;
}

function readIsoTimestamp(value: unknown, field: string): string {
	const parsed = readNonEmptyString(value, field);
	if (!Number.isFinite(Date.parse(parsed))) {
		throw new TypeError(`Memory record ${field} must be an ISO timestamp.`);
	}
	return parsed;
}

function readDigestArray(value: unknown, field: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		throw new TypeError(`Memory record ${field} must be a dense array.`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0
	) {
		throw new TypeError(`Memory record ${field} must be a dense array.`);
	}
	const entries: string[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`Memory record ${field} must be a dense array.`);
		}
		entries.push(readDigest(descriptor.value, `${field}[${index}]`));
	}
	if (
		Reflect.ownKeys(descriptors).some(
			(key) =>
				typeof key !== "string" ||
				(key !== "length" && !isArrayIndex(key, length)),
		)
	) {
		throw new TypeError(`Memory record ${field} must be a dense array.`);
	}
	if (new Set(entries).size !== entries.length) {
		throw new TypeError(`Memory record ${field} cannot contain duplicates.`);
	}
	return Object.freeze(entries);
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function isPlainDataRecord(value: unknown): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function digest(domain: string, value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(`${domain}\0${canonicalJson(value)}`)
		.digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(
				"Canonical memory JSON cannot contain a non-finite number.",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (!isPlainDataRecord(value)) {
		throw new TypeError("Canonical memory JSON must contain plain data.");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some((key) => typeof key !== "string")) {
		throw new TypeError("Canonical memory JSON cannot contain symbol fields.");
	}
	return `{${(keys as string[])
		.sort()
		.map((key) => {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor)) {
				throw new TypeError(
					"Canonical memory JSON cannot contain accessor fields.",
				);
			}
			return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
		})
		.join(",")}}`;
}
