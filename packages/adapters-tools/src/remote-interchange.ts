import { createHash } from "node:crypto";

/** The only remote interchange labels accepted by this local read-only boundary. */
export type RemoteInterchangeProtocol = "mcp" | "a2a";

/**
 * A local, data-only snapshot of a remote artifact. Its text is not executable
 * and remains both tainted and quarantined after validation.
 */
export interface QuarantinedRemoteArtifact {
	readonly artifactId: string;
	readonly mediaType: string;
	readonly content: string;
	readonly contentDigest: string;
	readonly tainted: true;
	readonly quarantined: true;
}

/** Closed, non-authoritative remote metadata retained by this boundary. */
export interface QuarantinedRemoteMetadata {
	readonly sourceId: string;
	readonly subject?: string;
}

/** A remote request is still inert data until local verification approves it. */
export interface QuarantinedRemoteActionDraft {
	readonly actionId: string;
	readonly summary: string;
	readonly tainted: true;
	readonly quarantined: true;
}

/**
 * Opaque local wrapper for untrusted MCP/A2A interchange data. This contract
 * intentionally has no endpoint, network handle, tool command, role, or
 * capability field.
 */
export interface QuarantinedRemoteInterchange {
	readonly schemaVersion: 1;
	readonly protocol: RemoteInterchangeProtocol;
	readonly metadata: QuarantinedRemoteMetadata;
	readonly artifacts: readonly QuarantinedRemoteArtifact[];
	readonly proposedAction?: QuarantinedRemoteActionDraft;
	readonly tainted: true;
	readonly quarantined: true;
}

/**
 * A locally minted candidate for review. It carries no authority and cannot be
 * constructed by merely matching this public TypeScript shape.
 */
export interface RemoteActionProposal {
	readonly schemaVersion: 1;
	readonly protocol: RemoteInterchangeProtocol;
	readonly sourceId: string;
	readonly actionId: string;
	readonly summary: string;
	readonly artifactDigests: readonly string[];
	readonly tainted: true;
	readonly quarantined: true;
}

/**
 * A verified remote proposal is still only a description for a later local
 * authority path. It contains no role, capability, executable, or endpoint.
 */
export interface ActionDefinition {
	readonly schemaVersion: 1;
	readonly sourceId: string;
	readonly actionId: string;
	readonly summary: string;
	readonly protocol: RemoteInterchangeProtocol;
	readonly artifactDigests: readonly string[];
	readonly tainted: true;
	readonly quarantined: true;
	readonly authority: "none";
	readonly status: "non-authoritative";
}

/** The verifier is local policy code and must return the literal boolean `true`. */
export type LocalRemoteActionVerifier = (
	proposal: RemoteActionProposal,
) => boolean;

const quarantinedInterchanges = new WeakSet<object>();
/**
 * The locally minted snapshot is retained independently of the public object.
 * Approval reparses the object and requires an exact match so provenance cannot
 * be dropped or substituted between local review and action definition output.
 */
const remoteActionProposals = new WeakMap<object, RemoteActionProposal>();

const INTERCHANGE_FIELDS = [
	"protocol",
	"metadata",
	"artifacts",
	"proposedAction",
] as const;
const METADATA_FIELDS = ["sourceId", "subject"] as const;
const ARTIFACT_FIELDS = ["artifactId", "mediaType", "content"] as const;
const ACTION_DRAFT_FIELDS = ["actionId", "summary"] as const;
const REMOTE_ACTION_PROPOSAL_FIELDS = [
	"schemaVersion",
	"protocol",
	"sourceId",
	"actionId",
	"summary",
	"artifactDigests",
	"tainted",
	"quarantined",
] as const;

/**
 * Wrap unknown remote MCP/A2A data as immutable local quarantine data.
 *
 * Validation deliberately accepts only data properties in a closed schema.
 * A rejected value has not crossed the boundary, and neither this function nor
 * any other export performs HTTP, opens a transport, or executes a tool.
 */
export function quarantineRemoteInterchange(
	input: unknown,
): QuarantinedRemoteInterchange {
	const record = readClosedRecord(
		input,
		"remote interchange",
		INTERCHANGE_FIELDS,
	);
	const protocol = readProtocol(record.protocol);
	const metadata = readMetadata(record.metadata);
	const artifacts = readArtifacts(record.artifacts);
	const proposedAction = Object.hasOwn(record, "proposedAction")
		? readActionDraft(record.proposedAction)
		: undefined;

	const interchange = Object.freeze({
		schemaVersion: 1 as const,
		protocol,
		metadata,
		artifacts,
		...(proposedAction === undefined ? {} : { proposedAction }),
		tainted: true as const,
		quarantined: true as const,
	});
	quarantinedInterchanges.add(interchange);
	return interchange;
}

/**
 * Return a locally minted, inert proposal for a quarantined remote action.
 * Missing remote action drafts and structurally forged wrappers fail closed.
 */
export function createRemoteActionProposal(
	interchange: QuarantinedRemoteInterchange,
): RemoteActionProposal | undefined {
	if (
		!isQuarantinedRemoteInterchange(interchange) ||
		!interchange.proposedAction
	) {
		return undefined;
	}

	const proposal = Object.freeze({
		schemaVersion: 1 as const,
		protocol: interchange.protocol,
		sourceId: interchange.metadata.sourceId,
		actionId: interchange.proposedAction.actionId,
		summary: interchange.proposedAction.summary,
		artifactDigests: Object.freeze(
			interchange.artifacts.map((artifact) => artifact.contentDigest),
		),
		tainted: true as const,
		quarantined: true as const,
	});
	remoteActionProposals.set(proposal, snapshotRemoteActionProposal(proposal));
	return proposal;
}

/**
 * Promote a locally minted proposal only when a local verifier explicitly
 * returns `true`. Any other result, exception, bad callback, or forged input
 * leaves the proposal quarantined and produces no action definition.
 */
export function approveRemoteActionProposal(
	proposal: RemoteActionProposal | undefined,
	verify: LocalRemoteActionVerifier,
): ActionDefinition | undefined {
	const parsedProposal = parseBrandedRemoteActionProposal(proposal);
	if (
		parsedProposal === undefined ||
		proposal === undefined ||
		typeof verify !== "function"
	) {
		return undefined;
	}

	let approved = false;
	try {
		approved = verify(proposal) === true;
	} catch {
		return undefined;
	}
	if (!approved) {
		return undefined;
	}

	const action = Object.freeze({
		schemaVersion: 1 as const,
		sourceId: parsedProposal.sourceId,
		actionId: parsedProposal.actionId,
		summary: parsedProposal.summary,
		protocol: parsedProposal.protocol,
		artifactDigests: Object.freeze([...parsedProposal.artifactDigests]),
		tainted: parsedProposal.tainted,
		quarantined: parsedProposal.quarantined,
		authority: "none" as const,
		status: "non-authoritative" as const,
	});
	return action;
}

/** Return whether a value was created by this module's quarantine wrapper. */
function isQuarantinedRemoteInterchange(
	value: unknown,
): value is QuarantinedRemoteInterchange {
	return (
		typeof value === "object" &&
		value !== null &&
		quarantinedInterchanges.has(value)
	);
}

/**
 * Reparse a locally branded proposal as closed data and require it to be
 * byte-for-byte equivalent in the security-relevant fields to the local mint.
 */
function parseBrandedRemoteActionProposal(
	value: unknown,
): RemoteActionProposal | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const minted = remoteActionProposals.get(value);
	if (minted === undefined) {
		return undefined;
	}

	try {
		const parsed = readRemoteActionProposal(value);
		return remoteActionProposalsMatch(parsed, minted) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function snapshotRemoteActionProposal(
	proposal: RemoteActionProposal,
): RemoteActionProposal {
	return Object.freeze({
		schemaVersion: proposal.schemaVersion,
		protocol: proposal.protocol,
		sourceId: proposal.sourceId,
		actionId: proposal.actionId,
		summary: proposal.summary,
		artifactDigests: Object.freeze([...proposal.artifactDigests]),
		tainted: proposal.tainted,
		quarantined: proposal.quarantined,
	});
}

function readRemoteActionProposal(input: unknown): RemoteActionProposal {
	const record = readClosedRecord(
		input,
		"remote action proposal",
		REMOTE_ACTION_PROPOSAL_FIELDS,
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError("remote action proposal schemaVersion must be 1.");
	}
	if (record.tainted !== true || record.quarantined !== true) {
		throw new TypeError(
			"remote action proposal must remain tainted and quarantined.",
		);
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		protocol: readProtocol(record.protocol),
		sourceId: readRequiredString(record, "sourceId", "remote action proposal"),
		actionId: readRequiredString(record, "actionId", "remote action proposal"),
		summary: readRequiredString(record, "summary", "remote action proposal"),
		artifactDigests: readStringArray(
			record.artifactDigests,
			"remote action proposal artifactDigests",
		),
		tainted: true as const,
		quarantined: true as const,
	});
}

function remoteActionProposalsMatch(
	left: RemoteActionProposal,
	right: RemoteActionProposal,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.protocol === right.protocol &&
		left.sourceId === right.sourceId &&
		left.actionId === right.actionId &&
		left.summary === right.summary &&
		left.tainted === right.tainted &&
		left.quarantined === right.quarantined &&
		left.artifactDigests.length === right.artifactDigests.length &&
		left.artifactDigests.every(
			(digest, index) => digest === right.artifactDigests[index],
		)
	);
}

/**
 * SHA-256 for the exact UTF-8 text content supplied to the local wrapper. No
 * normalization, parsing, or execution is performed before hashing.
 */
export function canonicalRemoteContentDigest(content: string): string {
	if (typeof content !== "string") {
		throw new TypeError("remote artifact content must be a string.");
	}
	return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function readMetadata(input: unknown): QuarantinedRemoteMetadata {
	const record = readClosedRecord(input, "remote metadata", METADATA_FIELDS);
	const sourceId = readRequiredString(record, "sourceId", "remote metadata");
	const subject = readOptionalString(record, "subject", "remote metadata");
	return Object.freeze({
		sourceId,
		...(subject === undefined ? {} : { subject }),
	});
}

function readArtifacts(input: unknown): readonly QuarantinedRemoteArtifact[] {
	const values = readDenseDataArray(input, "remote artifacts");
	return Object.freeze(
		values.map((value, index) =>
			readArtifact(value, `remote artifacts[${index}]`),
		),
	);
}

function readArtifact(
	input: unknown,
	label: string,
): QuarantinedRemoteArtifact {
	const record = readClosedRecord(input, label, ARTIFACT_FIELDS);
	const artifactId = readRequiredString(record, "artifactId", label);
	const mediaType = readRequiredString(record, "mediaType", label);
	const content = readString(record, "content", label);
	return Object.freeze({
		artifactId,
		mediaType,
		content,
		contentDigest: canonicalRemoteContentDigest(content),
		tainted: true as const,
		quarantined: true as const,
	});
}

function readActionDraft(input: unknown): QuarantinedRemoteActionDraft {
	const record = readClosedRecord(
		input,
		"remote proposed action",
		ACTION_DRAFT_FIELDS,
	);
	return Object.freeze({
		actionId: readRequiredString(record, "actionId", "remote proposed action"),
		summary: readRequiredString(record, "summary", "remote proposed action"),
		tainted: true as const,
		quarantined: true as const,
	});
}

function readProtocol(value: unknown): RemoteInterchangeProtocol {
	if (value !== "mcp" && value !== "a2a") {
		throw new TypeError("remote interchange protocol must be 'mcp' or 'a2a'.");
	}
	return value;
}

function readClosedRecord(
	input: unknown,
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> {
	const record = readOwnDataRecord(input, label);
	for (const key of Object.keys(record)) {
		if (!allowedFields.includes(key)) {
			throw new TypeError(`${label} must use the closed schema.`);
		}
	}
	return record;
}

function readOwnDataRecord(
	input: unknown,
	label: string,
): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError(`${label} must be a plain data object.`);
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain data object.`);
	}

	const descriptors = Object.getOwnPropertyDescriptors(input);
	const record: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string") {
			throw new TypeError(`${label} cannot contain symbol fields.`);
		}
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label} cannot contain accessor fields.`);
		}
		record[key] = descriptor.value;
	}
	return record;
}

function readDenseDataArray(input: unknown, label: string): readonly unknown[] {
	if (
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype
	) {
		throw new TypeError(`${label} must be a dense data array.`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
	const lengthValue = lengthDescriptor?.value;
	if (
		typeof lengthValue !== "number" ||
		!Number.isSafeInteger(lengthValue) ||
		lengthValue < 0
	) {
		throw new TypeError(`${label} must be a dense data array.`);
	}

	const values: unknown[] = [];
	for (let index = 0; index < lengthValue; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label} must be a dense data array.`);
		}
		values.push(descriptor.value);
	}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (
			typeof key !== "string" ||
			(key !== "length" && !isArrayIndex(key, lengthValue))
		) {
			throw new TypeError(`${label} must be a dense data array.`);
		}
	}
	return values;
}

function readStringArray(input: unknown, label: string): readonly string[] {
	const values = readDenseDataArray(input, label);
	return Object.freeze(
		values.map((value, index) => {
			if (
				typeof value !== "string" ||
				value.length === 0 ||
				value.includes("\0")
			) {
				throw new TypeError(
					`${label}[${index}] must be a non-empty string without NUL bytes.`,
				);
			}
			return value;
		}),
	);
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) {
		return false;
	}
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readRequiredString(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = readString(record, field, label);
	if (value.length === 0) {
		throw new TypeError(`${label} ${field} must be a non-empty string.`);
	}
	return value;
}

function readOptionalString(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(record, field)) {
		return undefined;
	}
	return readRequiredString(record, field, label);
}

function readString(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = record[field];
	if (typeof value !== "string" || value.includes("\0")) {
		throw new TypeError(
			`${label} ${field} must be a string without NUL bytes.`,
		);
	}
	return value;
}
