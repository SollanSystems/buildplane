import { createHash } from "node:crypto";

/**
 * A content-addressed skill declaration. The declaration is deliberately
 * quarantine metadata, not an authorization grant: it cannot add a tool,
 * process, role, network route, or capability to a governed worker.
 */
export interface SkillManifestV1 {
	readonly schemaVersion: 1;
	readonly skillId: string;
	readonly publisherId: string;
	readonly contentDigest: string;
	/** Digest of a separately stored publisher-signature artifact. */
	readonly signatureDigest: string;
	readonly declaredCapabilities: readonly string[];
	readonly compatibility: SkillCompatibilityV1;
	readonly deterministicTestDigest: string;
	readonly utilityReportDigest: string;
	readonly status: "quarantined";
	readonly digest: string;
}

export interface SkillCompatibilityV1 {
	readonly repositoryVersions: readonly string[];
	readonly toolVersions: readonly string[];
	readonly modelVersions: readonly string[];
}

export interface CreateSkillManifestV1Input {
	readonly skillId: string;
	readonly publisherId: string;
	readonly contentDigest: string;
	readonly signatureDigest: string;
	readonly declaredCapabilities: readonly string[];
	readonly compatibility: SkillCompatibilityV1;
	readonly deterministicTestDigest: string;
	readonly utilityReportDigest: string;
}

export interface SkillScanEvidenceV1 {
	readonly scannerId: string;
	readonly scanDigest: string;
	readonly outcome: "clean" | "malicious" | "inconclusive";
}

export type SkillActivationIneligibilityReasonV1 =
	| "invalid-manifest"
	| "revoked"
	| "scan-not-clean"
	| "repository-incompatible"
	| "tool-incompatible"
	| "model-incompatible"
	| "verified-tape-projection-required";

/**
 * V1 has no trusted tape-backed skill admission, so it never activates a
 * skill. The positive structural checks remain useful to explain why a later
 * native authority must deny or quarantine a declaration.
 */
export type SkillActivationEligibilityV1 = {
	readonly eligible: false;
	readonly reason: SkillActivationIneligibilityReasonV1;
	readonly authority: "none";
	readonly activation: "shadow-only";
};

export interface EvaluateSkillActivationInputV1 {
	readonly manifest: SkillManifestV1;
	readonly scan: SkillScanEvidenceV1;
	readonly revokedManifestDigests: readonly string[];
	readonly repositoryVersion: string;
	readonly toolVersion: string;
	readonly modelVersion: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Build a closed, immutable quarantine record for an untrusted skill. */
export function createSkillManifestV1(
	input: CreateSkillManifestV1Input,
): SkillManifestV1 {
	const body = parseSkillManifestBody(input);
	return Object.freeze({
		...body,
		status: "quarantined" as const,
		digest: canonicalSkillManifestV1Digest({
			...body,
			status: "quarantined",
		}),
	});
}

/** Strictly parse a stored manifest; unknown fields and digest drift fail closed. */
export function parseSkillManifestV1(input: unknown): SkillManifestV1 {
	const record = readClosedRecord(input, [
		"schemaVersion",
		"skillId",
		"publisherId",
		"contentDigest",
		"signatureDigest",
		"declaredCapabilities",
		"compatibility",
		"deterministicTestDigest",
		"utilityReportDigest",
		"status",
		"digest",
	]);
	if (record.schemaVersion !== 1 || record.status !== "quarantined") {
		throw new TypeError("SkillManifestV1 has an unsupported schema or status.");
	}
	const body = parseSkillManifestBody(
		selectFields(record, [
			"skillId",
			"publisherId",
			"contentDigest",
			"signatureDigest",
			"declaredCapabilities",
			"compatibility",
			"deterministicTestDigest",
			"utilityReportDigest",
		]),
	);
	const digest = readDigest(record.digest, "digest");
	const expected = canonicalSkillManifestV1Digest({
		...body,
		status: "quarantined",
	});
	if (digest !== expected) {
		throw new TypeError("SkillManifestV1 digest mismatch.");
	}
	return Object.freeze({ ...body, status: "quarantined", digest });
}

export function canonicalSkillManifestV1Digest(
	input: Omit<SkillManifestV1, "digest">,
): string {
	return digest("buildplane.skill-manifest.v1", input);
}

/**
 * Test only compatibility and independent scan/revocation evidence. Even a
 * clean compatible declaration stays shadow-only until a signature-verified
 * tape projection makes a later native activation decision.
 */
export function evaluateSkillActivationEligibility(
	input: EvaluateSkillActivationInputV1,
): SkillActivationEligibilityV1 {
	let manifest: SkillManifestV1;
	try {
		manifest = parseSkillManifestV1(input.manifest);
	} catch {
		return ineligible("invalid-manifest");
	}
	if (
		readDigestArray(
			input.revokedManifestDigests,
			"revokedManifestDigests",
		).includes(manifest.digest)
	) {
		return ineligible("revoked");
	}
	if (!isCleanScanEvidence(input.scan)) {
		return ineligible("scan-not-clean");
	}
	if (
		!manifest.compatibility.repositoryVersions.includes(input.repositoryVersion)
	) {
		return ineligible("repository-incompatible");
	}
	if (!manifest.compatibility.toolVersions.includes(input.toolVersion)) {
		return ineligible("tool-incompatible");
	}
	if (!manifest.compatibility.modelVersions.includes(input.modelVersion)) {
		return ineligible("model-incompatible");
	}
	return ineligible("verified-tape-projection-required");
}

function ineligible(
	reason: SkillActivationIneligibilityReasonV1,
): SkillActivationEligibilityV1 {
	return Object.freeze({
		eligible: false as const,
		reason,
		authority: "none" as const,
		activation: "shadow-only" as const,
	});
}

function parseSkillManifestBody(input: unknown): Omit<
	SkillManifestV1,
	"status" | "digest" | "schemaVersion"
> & {
	readonly schemaVersion: 1;
} {
	const record = readClosedRecord(input, [
		"skillId",
		"publisherId",
		"contentDigest",
		"signatureDigest",
		"declaredCapabilities",
		"compatibility",
		"deterministicTestDigest",
		"utilityReportDigest",
	]);
	return Object.freeze({
		schemaVersion: 1 as const,
		skillId: readIdentifier(record.skillId, "skillId"),
		publisherId: readIdentifier(record.publisherId, "publisherId"),
		contentDigest: readDigest(record.contentDigest, "contentDigest"),
		signatureDigest: readDigest(record.signatureDigest, "signatureDigest"),
		declaredCapabilities: readIdentifierArray(
			record.declaredCapabilities,
			"declaredCapabilities",
		),
		compatibility: parseCompatibility(record.compatibility),
		deterministicTestDigest: readDigest(
			record.deterministicTestDigest,
			"deterministicTestDigest",
		),
		utilityReportDigest: readDigest(
			record.utilityReportDigest,
			"utilityReportDigest",
		),
	});
}

function parseCompatibility(input: unknown): SkillCompatibilityV1 {
	const record = readClosedRecord(input, [
		"repositoryVersions",
		"toolVersions",
		"modelVersions",
	]);
	return Object.freeze({
		repositoryVersions: readIdentifierArray(
			record.repositoryVersions,
			"compatibility.repositoryVersions",
		),
		toolVersions: readIdentifierArray(
			record.toolVersions,
			"compatibility.toolVersions",
		),
		modelVersions: readIdentifierArray(
			record.modelVersions,
			"compatibility.modelVersions",
		),
	});
}

function isCleanScanEvidence(input: unknown): input is SkillScanEvidenceV1 {
	try {
		const record = readClosedRecord(input, [
			"scannerId",
			"scanDigest",
			"outcome",
		]);
		return (
			readIdentifier(record.scannerId, "scannerId").length > 0 &&
			readDigest(record.scanDigest, "scanDigest").length > 0 &&
			record.outcome === "clean"
		);
	} catch {
		return false;
	}
}

function readClosedRecord(
	input: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError("Skill record must be a plain data object.");
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Skill record must be a plain data object.");
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Reflect.ownKeys(descriptors);
	if (
		keys.some((key) => typeof key !== "string") ||
		keys.length !== expectedKeys.length ||
		expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
	) {
		throw new TypeError("Skill record must use the closed V1 schema.");
	}
	const record: Record<string, unknown> = {};
	for (const key of expectedKeys) {
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError("Skill record cannot contain accessor fields.");
		}
		record[key] = descriptor.value;
	}
	return record;
}

function readIdentifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		throw new TypeError(
			`Skill record ${field} must be a canonical identifier.`,
		);
	}
	return value;
}

function readIdentifierArray(value: unknown, field: string): readonly string[] {
	const values = readDenseDataArray(value, field).map((entry, index) =>
		readIdentifier(entry, `${field}[${index}]`),
	);
	if (values.length === 0 || new Set(values).size !== values.length) {
		throw new TypeError(`Skill record ${field} must be non-empty and unique.`);
	}
	return Object.freeze(values);
}

function readDigestArray(value: unknown, field: string): readonly string[] {
	const values = readDenseDataArray(value, field);
	return Object.freeze(
		values.map((entry, index) => readDigest(entry, `${field}[${index}]`)),
	);
}

function readDenseDataArray(input: unknown, field: string): readonly unknown[] {
	if (
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype
	) {
		throw new TypeError(`Skill record ${field} must be a dense array.`);
	}

	const descriptors = Object.getOwnPropertyDescriptors(input);
	const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0) {
		throw new TypeError(`Skill record ${field} must be a dense array.`);
	}

	const values: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`Skill record ${field} must be a dense array.`);
		}
		values.push(descriptor.value);
	}

	for (const key of Reflect.ownKeys(descriptors)) {
		if (
			typeof key !== "string" ||
			(key !== "length" && !isArrayIndex(key, length))
		) {
			throw new TypeError(`Skill record ${field} must be a dense array.`);
		}
	}
	return values;
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9]\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readDigest(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256.test(value)) {
		throw new TypeError(`Skill record ${field} must be a sha256 digest.`);
	}
	return value;
}

function selectFields(
	record: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): Record<string, unknown> {
	const selected: Record<string, unknown> = {};
	for (const field of fields) selected[field] = record[field];
	return selected;
}

function digest(domain: string, value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(`${domain}\0${canonicalJson(value)}`)
		.digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(
				"Skill canonical JSON cannot contain a non-finite number.",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Skill canonical JSON must contain plain data.");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some((key) => typeof key !== "string")) {
		throw new TypeError("Skill canonical JSON cannot contain symbol fields.");
	}
	return `{${(keys as string[])
		.sort()
		.map((key) => {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor)) {
				throw new TypeError(
					"Skill canonical JSON cannot contain accessor fields.",
				);
			}
			return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
		})
		.join(",")}}`;
}
