import {
	canonicalDispatchEnvelopeV3Digest,
	canonicalGovernedAcceptanceContractV1Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalSha256Digest,
	type DispatchBudgetV1,
	type GovernedDispatchLineageV3,
	type DispatchEnvelopeV3 as KernelDispatchEnvelopeV3,
	parseDispatchEnvelopeV3,
	parseGovernedUnitPacket,
} from "@buildplane/kernel";
import type {
	DispatchEnvelopeV3 as NativeDispatchEnvelopeV3,
	TapeEmitter,
} from "@buildplane/ledger-client";
import {
	GOVERNED_AUTHORITY_BROKER_REQUIRED,
	type TrustedGovernedLedgerAuthorityRealmV1,
} from "./governed-ledger-authority.js";
import { deriveGovernedDispatchPolicyDigestV1 } from "./governed-policy-binding.js";

export {
	deriveGovernedDispatchPolicyDigestV1,
	GOVERNED_DISPATCH_POLICY_DIGEST_DOMAIN_V1,
} from "./governed-policy-binding.js";

const SIGNED_DISPATCH_AUTHORITY = "ledger-signed-v1";
const DISPATCH_ENVELOPE_V3_EVENT_KIND = "dispatch_envelope_v3";
const EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

const ADMISSION_FIELDS = new Set([
	"emitter",
	"sourcePacket",
	"runId",
	"workflowId",
	"workflowRevision",
	"attempt",
	"commitMode",
	"trustTier",
	"actionEvidenceVersion",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"repositoryBindingDigest",
	"ledgerAuthorityRealm",
	"budget",
	"idempotencyKey",
	"issuedAt",
	"expiresAt",
	"readCurrentBaseSha",
	"now",
	"generateEventId",
]);

const SOURCE_PACKET_FIELDS = new Set([
	"unit",
	"execution_role",
	"execution",
	"model",
	"intent",
	"verification",
	"routingHints",
	"provenance_ref",
	"capability_bundle",
	"capability_bundle_digest",
	"acceptance_contract",
	"trust_scope",
]);

const BUDGET_FIELDS = new Set(["maxTokens", "maxComputeTimeMs"]);
const LEDGER_AUTHORITY_REALM_FIELDS = new Set([
	"kind",
	"realmDigest",
	"ledgerWorkspace",
	"kernelActorId",
	"kernelKeyId",
	"kernelPublicKeyHash",
]);
const SIGNED_EMITTER_FIELDS = new Set([
	"signedDispatchAuthority",
	"runId",
	"authorityActor",
	"emit",
	"flush",
]);

/**
 * Test-only shape for a local fixture emitter.
 *
 * A structural TypeScript emitter cannot prove possession of a separate
 * authority identity. Production issuance is therefore blocked below until an
 * external authority broker provides the signed dispatch and protected tape
 * inclusion proof. This interface remains only to test canonical envelope
 * construction without granting it execution authority.
 */
export interface SignedDispatchTapeEmitter
	extends Pick<TapeEmitter, "emit" | "flush"> {
	readonly signedDispatchAuthority: typeof SIGNED_DISPATCH_AUTHORITY;
	readonly runId: string;
	readonly authorityActor: string;
}

/**
 * Test-only data and callbacks for canonical implementer V3 envelope fixtures.
 *
 * `policyDigest` and `acceptanceContractDigest` are intentionally absent: the
 * former is derived from the latter, and the latter is derived from the
 * governed packet's acceptance contract. Neither may be claimed by a caller.
 */
export interface GovernedDispatchAdmissionInputV3 {
	readonly emitter: SignedDispatchTapeEmitter;
	readonly sourcePacket: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly attempt: number;
	readonly commitMode: "atomic";
	readonly trustTier: "governed";
	readonly actionEvidenceVersion: "sealed_v3";
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	/**
	 * Canonical binding of the exact target repository and branch. It is read
	 * immediately before signing; a legacy packet can never infer it.
	 */
	readonly repositoryBindingDigest: string;
	/** Opaque projection obtained from the package-pinned native authority. */
	readonly ledgerAuthorityRealm: TrustedGovernedLedgerAuthorityRealmV1;
	readonly budget: DispatchBudgetV1;
	readonly idempotencyKey: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	/** Reads the currently observed base SHA immediately before issuance. */
	readonly readCurrentBaseSha: () => string | Promise<string>;
	/** Injectable wall clock, primarily for deterministic tests. */
	readonly now?: () => Date;
	/** Injectable native-ledger event id generator, primarily for tests. */
	readonly generateEventId?: () => string;
}

interface CapturedEmitter {
	readonly emit: TapeEmitter["emit"];
	readonly flush: TapeEmitter["flush"];
	readonly runId: string;
	readonly authorityActor: string;
}

interface PreparedAdmission {
	readonly emitter: CapturedEmitter;
	readonly sourcePacket: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly attempt: number;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly repositoryBindingDigest: string;
	readonly ledgerAuthorityRealmDigest: string;
	readonly budget: DispatchBudgetV1;
	readonly idempotencyKey: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly readCurrentBaseSha: () => string | Promise<string>;
	readonly now: () => Date;
	readonly generateEventId: () => string | Promise<string>;
}

/**
 * Production admission is broker-owned. A same-process structural emitter is
 * not a signature authority and must never append execution authority to a
 * tape, even if it presents the right fields. Callers receive a stable
 * fail-closed error before source-packet parsing or emitter interaction.
 */
export async function issueGovernedDispatchAdmissionV3(
	_input: GovernedDispatchAdmissionInputV3,
): Promise<never> {
	throw new Error(GOVERNED_AUTHORITY_BROKER_REQUIRED);
}

/**
 * Test-only fixture implementation for canonical sealed-V3 envelope shape.
 *
 * This is intentionally not a production admission path. Its structural local
 * emitter is useful for serialization and parser coverage only; it cannot
 * establish external authority identity, protected tape inclusion, or worker
 * execution permission.
 */
export async function __testOnlyIssueGovernedDispatchAdmissionV3(
	input: GovernedDispatchAdmissionInputV3,
): Promise<GovernedDispatchLineageV3> {
	const prepared = prepareAdmission(input);
	parseGovernedSourcePacket(prepared.sourcePacket);
	const packet = parseGovernedUnitPacket(prepared.sourcePacket);
	const governedPacketDigest = canonicalGovernedUnitPacketV1Digest(packet);

	if (packet.execution_role !== "implementer") {
		throw new TypeError(
			"initial governed dispatch issuance supports only the explicit implementer role.",
		);
	}
	if (
		packet.capability_bundle_digest === undefined ||
		packet.acceptance_contract === undefined ||
		packet.trust_scope === undefined
	) {
		throw new TypeError(
			"governed dispatch issuance requires packet capability, acceptance, and trust-scope governance.",
		);
	}

	const acceptanceContractDigest = canonicalGovernedAcceptanceContractV1Digest(
		packet.acceptance_contract,
	);
	const policyDigest = deriveGovernedDispatchPolicyDigestV1(
		acceptanceContractDigest,
	);
	const baseCommitSha = requireOpaqueString(
		await prepared.readCurrentBaseSha(),
		"current base SHA",
	);
	const eventId = await prepared.generateEventId();
	assertEventId(eventId);

	const envelope = createCanonicalEnvelope({
		workflowId: prepared.workflowId,
		workflowRevision: prepared.workflowRevision,
		unitId: packet.unit.id,
		attempt: prepared.attempt,
		executionRole: packet.execution_role,
		provenanceRef: packet.provenance_ref,
		baseCommitSha,
		capabilityBundleDigest: packet.capability_bundle_digest,
		acceptanceContractDigest,
		contextManifestDigest: prepared.contextManifestDigest,
		workerManifestDigest: prepared.workerManifestDigest,
		sandboxProfileDigest: prepared.sandboxProfileDigest,
		repositoryBindingDigest: prepared.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: prepared.ledgerAuthorityRealmDigest,
		governedPacketDigest,
		budget: prepared.budget,
		idempotencyKey: prepared.idempotencyKey,
		issuedAt: prepared.issuedAt,
		expiresAt: prepared.expiresAt,
	});
	assertValidAtCurrentTime(envelope, prepared.now());

	const nativeEnvelope = toNativeSnakeCaseEnvelope(envelope);
	const payload = Object.freeze({ DispatchEnvelopeV3: nativeEnvelope });
	prepared.emitter.emit(DISPATCH_ENVELOPE_V3_EVENT_KIND, payload, {
		id: eventId,
		occurredAt: envelope.body.issuedAt,
	});
	await prepared.emitter.flush();

	return Object.freeze({
		schemaVersion: 3,
		runId: prepared.runId,
		workflowId: envelope.body.workflowId,
		workflowRevision: envelope.body.workflowRevision,
		unitId: envelope.body.unitId,
		attempt: envelope.body.attempt,
		provenanceRef: envelope.body.provenanceRef,
		dispatchEnvelopeRef: eventId,
		envelopeDigest: envelope.envelopeDigest,
		baseCommitSha: envelope.body.baseCommitSha,
		executionRole: envelope.body.executionRole,
		// The envelope was checked above, but preserve the governed literals in
		// the returned authority shape rather than widening them back to the
		// general protocol unions.
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: envelope.body.capabilityBundleDigest,
		acceptanceContractDigest: envelope.body.acceptanceContractDigest,
		policyDigest,
		contextManifestDigest: envelope.body.contextManifestDigest,
		workerManifestDigest: envelope.body.workerManifestDigest,
		sandboxProfileDigest: envelope.body.sandboxProfileDigest,
		repositoryBindingDigest: envelope.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: envelope.ledgerAuthorityRealmDigest,
		governedPacketDigest,
		budget: Object.freeze({ ...envelope.body.budget }),
		idempotencyKey: envelope.body.idempotencyKey,
		authorityActor: prepared.emitter.authorityActor,
		actionEvidenceVersion: envelope.actionEvidenceVersion,
		issuedAt: envelope.body.issuedAt,
		expiresAt: envelope.body.expiresAt,
	});
}

function prepareAdmission(input: unknown): PreparedAdmission {
	const record = readClosedRecord(
		input,
		"governed dispatch admission",
		ADMISSION_FIELDS,
	);
	const runId = requireOpaqueString(record.runId, "runId");
	const emitter = captureSignedEmitter(record.emitter, runId);
	const sourcePacket = requireOpaqueString(record.sourcePacket, "sourcePacket");
	const workflowId = requireOpaqueString(record.workflowId, "workflowId");
	const workflowRevision = requireOpaqueString(
		record.workflowRevision,
		"workflowRevision",
	);
	const attempt = requirePositiveSafeInteger(record.attempt, "attempt");
	if (record.commitMode !== "atomic") {
		throw new TypeError(
			'governed dispatch admission supports only commitMode "atomic".',
		);
	}
	if (record.trustTier !== "governed") {
		throw new TypeError(
			'governed dispatch admission requires trustTier "governed".',
		);
	}
	if (record.actionEvidenceVersion !== "sealed_v3") {
		throw new TypeError(
			'governed dispatch admission requires actionEvidenceVersion "sealed_v3".',
		);
	}
	const budget = readBudget(record.budget);
	const contextManifestDigest = requireCanonicalDigest(
		record.contextManifestDigest,
		"contextManifestDigest",
	);
	const workerManifestDigest = requireCanonicalDigest(
		record.workerManifestDigest,
		"workerManifestDigest",
	);
	const sandboxProfileDigest = requireCanonicalDigest(
		record.sandboxProfileDigest,
		"sandboxProfileDigest",
	);
	const repositoryBindingDigest = requireCanonicalDigest(
		record.repositoryBindingDigest,
		"repositoryBindingDigest",
	);
	const ledgerAuthorityRealm = captureLedgerAuthorityRealm(
		record.ledgerAuthorityRealm,
	);
	if (emitter.authorityActor !== ledgerAuthorityRealm.kernelActorId) {
		throw new TypeError(
			"governed dispatch emitter actor must match the host ledger authority realm kernel signer.",
		);
	}
	const ledgerAuthorityRealmDigest = ledgerAuthorityRealm.realmDigest;
	const idempotencyKey = requireOpaqueString(
		record.idempotencyKey,
		"idempotencyKey",
	);
	const issuedAt = requireOpaqueString(record.issuedAt, "issuedAt");
	const expiresAt = requireOpaqueString(record.expiresAt, "expiresAt");
	if (typeof record.readCurrentBaseSha !== "function") {
		throw new TypeError("readCurrentBaseSha must be a function.");
	}
	if (record.now !== undefined && typeof record.now !== "function") {
		throw new TypeError("now must be a function when supplied.");
	}
	if (
		record.generateEventId !== undefined &&
		typeof record.generateEventId !== "function"
	) {
		throw new TypeError("generateEventId must be a function when supplied.");
	}

	return Object.freeze({
		emitter,
		sourcePacket,
		runId,
		workflowId,
		workflowRevision,
		attempt,
		contextManifestDigest,
		workerManifestDigest,
		sandboxProfileDigest,
		repositoryBindingDigest,
		ledgerAuthorityRealmDigest,
		budget,
		idempotencyKey,
		issuedAt,
		expiresAt,
		readCurrentBaseSha: record.readCurrentBaseSha as () =>
			| string
			| Promise<string>,
		now: (record.now as (() => Date) | undefined) ?? (() => new Date()),
		generateEventId:
			(record.generateEventId as
				| (() => string | Promise<string>)
				| undefined) ?? generateLedgerEventId,
	});
}

function captureLedgerAuthorityRealm(
	input: unknown,
): TrustedGovernedLedgerAuthorityRealmV1 {
	const realm = readClosedRecord(
		input,
		"ledgerAuthorityRealm",
		LEDGER_AUTHORITY_REALM_FIELDS,
	) as Partial<TrustedGovernedLedgerAuthorityRealmV1>;
	if (realm.kind !== "host-governed-ledger-authority-v1") {
		throw new TypeError(
			"governed dispatch admission requires a host-governed-ledger-authority-v1 realm.",
		);
	}
	const realmDigest = requireCanonicalDigest(
		realm.realmDigest,
		"ledgerAuthorityRealm.realmDigest",
	);
	if (
		typeof realm.ledgerWorkspace !== "string" ||
		realm.ledgerWorkspace.length === 0 ||
		realm.ledgerWorkspace.includes("\0") ||
		typeof realm.kernelActorId !== "string" ||
		realm.kernelActorId.trim().length === 0 ||
		typeof realm.kernelKeyId !== "string" ||
		realm.kernelKeyId.trim().length === 0 ||
		!SHA256_DIGEST.test(realm.kernelPublicKeyHash ?? "")
	) {
		throw new TypeError(
			"governed dispatch admission received a malformed host ledger authority realm projection.",
		);
	}
	return Object.freeze({
		kind: "host-governed-ledger-authority-v1" as const,
		realmDigest,
		ledgerWorkspace: realm.ledgerWorkspace,
		kernelActorId: realm.kernelActorId,
		kernelKeyId: realm.kernelKeyId,
		kernelPublicKeyHash: realm.kernelPublicKeyHash as string,
	});
}

function captureSignedEmitter(input: unknown, runId: string): CapturedEmitter {
	const emitter = readClosedRecord(
		input,
		"signed tape emitter",
		SIGNED_EMITTER_FIELDS,
	) as Partial<SignedDispatchTapeEmitter>;
	if (emitter.signedDispatchAuthority !== SIGNED_DISPATCH_AUTHORITY) {
		throw new TypeError(
			"governed dispatch admission requires a ledger-signed dispatch emitter.",
		);
	}
	if (
		typeof emitter.emit !== "function" ||
		typeof emitter.flush !== "function"
	) {
		throw new TypeError(
			"governed dispatch admission requires a tape emitter with emit and flush controls.",
		);
	}
	const emitterRunId = requireOpaqueString(emitter.runId, "emitter.runId");
	if (emitterRunId !== runId) {
		throw new TypeError(
			"signed tape emitter runId must exactly match the dispatch runId.",
		);
	}
	return Object.freeze({
		emit: emitter.emit.bind(input),
		flush: emitter.flush.bind(input),
		runId: emitterRunId,
		authorityActor: requireOpaqueString(
			emitter.authorityActor,
			"emitter.authorityActor",
		),
	});
}

function parseGovernedSourcePacket(
	sourcePacket: string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(sourcePacket);
	} catch {
		throw new TypeError(
			"sourcePacket must be valid JSON for governed admission.",
		);
	}
	return readClosedRecord(parsed, "sourcePacket", SOURCE_PACKET_FIELDS);
}

function readBudget(input: unknown): DispatchBudgetV1 {
	const record = readClosedRecord(input, "budget", BUDGET_FIELDS);
	return Object.freeze({
		...(record.maxTokens === undefined
			? {}
			: {
					maxTokens: requirePositiveSafeInteger(
						record.maxTokens,
						"budget.maxTokens",
					),
				}),
		...(record.maxComputeTimeMs === undefined
			? {}
			: {
					maxComputeTimeMs: requirePositiveSafeInteger(
						record.maxComputeTimeMs,
						"budget.maxComputeTimeMs",
					),
				}),
	});
}

function createCanonicalEnvelope(input: {
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly executionRole: "implementer";
	readonly provenanceRef: string;
	readonly baseCommitSha: string;
	readonly capabilityBundleDigest: string;
	readonly acceptanceContractDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly repositoryBindingDigest: string;
	readonly ledgerAuthorityRealmDigest: string;
	readonly governedPacketDigest: string;
	readonly budget: DispatchBudgetV1;
	readonly idempotencyKey: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
}): KernelDispatchEnvelopeV3 {
	const draft = {
		schemaVersion: 3 as const,
		body: {
			workflowId: input.workflowId,
			workflowRevision: input.workflowRevision,
			unitId: input.unitId,
			attempt: input.attempt,
			executionRole: input.executionRole,
			commitMode: "atomic" as const,
			provenanceRef: input.provenanceRef,
			baseCommitSha: input.baseCommitSha,
			capabilityBundleDigest: input.capabilityBundleDigest,
			acceptanceContractDigest: input.acceptanceContractDigest,
			contextManifestDigest: input.contextManifestDigest,
			workerManifestDigest: input.workerManifestDigest,
			sandboxProfileDigest: input.sandboxProfileDigest,
			budget: input.budget,
			trustTier: "governed" as const,
			idempotencyKey: input.idempotencyKey,
			issuedAt: input.issuedAt,
			expiresAt: input.expiresAt,
		},
		actionEvidenceVersion: "sealed_v3" as const,
		repositoryBindingDigest: input.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: input.ledgerAuthorityRealmDigest,
		governedPacketDigest: input.governedPacketDigest,
	};
	const envelopeDigest = canonicalDispatchEnvelopeV3Digest(draft);
	const envelope = parseDispatchEnvelopeV3({ ...draft, envelopeDigest });
	if (
		envelope.actionEvidenceVersion !== "sealed_v3" ||
		envelope.body.commitMode !== "atomic" ||
		envelope.body.trustTier !== "governed" ||
		envelope.body.executionRole !== "implementer"
	) {
		throw new TypeError(
			"governed dispatch issuance produced an unsupported V3 envelope shape.",
		);
	}
	return envelope;
}

function assertValidAtCurrentTime(
	envelope: KernelDispatchEnvelopeV3,
	now: Date,
): void {
	if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	const issuedAt = Date.parse(envelope.body.issuedAt);
	const expiresAt = Date.parse(envelope.body.expiresAt);
	if (issuedAt > now.getTime()) {
		throw new TypeError(
			"governed dispatch issuedAt must not be in the future.",
		);
	}
	if (expiresAt <= now.getTime()) {
		throw new TypeError("governed dispatch is expired.");
	}
}

function toNativeSnakeCaseEnvelope(
	envelope: KernelDispatchEnvelopeV3,
): NativeDispatchEnvelopeV3 {
	const body = envelope.body;
	return Object.freeze({
		body: Object.freeze({
			workflow_id: body.workflowId,
			workflow_revision: body.workflowRevision,
			unit_id: body.unitId,
			attempt: body.attempt,
			execution_role: body.executionRole,
			commit_mode: body.commitMode,
			provenance_ref: body.provenanceRef,
			base_commit_sha: body.baseCommitSha,
			capability_bundle_digest: body.capabilityBundleDigest,
			acceptance_contract_digest: body.acceptanceContractDigest,
			context_manifest_digest: body.contextManifestDigest,
			worker_manifest_digest: body.workerManifestDigest,
			sandbox_profile_digest: body.sandboxProfileDigest,
			budget: Object.freeze({
				...(body.budget.maxTokens === undefined
					? {}
					: { max_tokens: body.budget.maxTokens }),
				...(body.budget.maxComputeTimeMs === undefined
					? {}
					: { max_compute_time_ms: body.budget.maxComputeTimeMs }),
			}),
			trust_tier: body.trustTier,
			idempotency_key: body.idempotencyKey,
			issued_at: body.issuedAt,
			expires_at: body.expiresAt,
		}),
		action_evidence_version: envelope.actionEvidenceVersion,
		repository_binding_digest: envelope.repositoryBindingDigest,
		ledger_authority_realm_digest: envelope.ledgerAuthorityRealmDigest,
		governed_packet_digest: envelope.governedPacketDigest,
		envelope_digest: envelope.envelopeDigest,
	}) as NativeDispatchEnvelopeV3;
}

/**
 * Compatibility alias for the now-closed governed acceptance contract digest.
 *
 * This function intentionally no longer hashes arbitrary JSON: callers must
 * supply a parseable `GovernedAcceptanceContractV1` or admission fails before
 * an envelope can be written.
 */
export function canonicalGovernanceRecordDigestV1(input: unknown): string {
	return canonicalGovernedAcceptanceContractV1Digest(input);
}

function readClosedRecord(
	input: unknown,
	label: string,
	allowedFields: ReadonlySet<string>,
): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object.`);
	}
	let symbols: symbol[];
	let keys: string[];
	try {
		symbols = Object.getOwnPropertySymbols(input);
		keys = Object.getOwnPropertyNames(input);
	} catch {
		throw new TypeError(`${label} must be a closed data object.`);
	}
	if (symbols.length > 0) {
		throw new TypeError(`${label} must not contain symbol fields.`);
	}
	const record = input as Record<string, unknown>;
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (!allowedFields.has(key)) {
			throw new TypeError(`${label} contains unknown field ${key}.`);
		}
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(record, key);
		} catch {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		// Treat descriptor values as the admitted bytes. Reading `record[key]`
		// after validation could invoke a Proxy get trap and substitute a value
		// after its closed-schema check.
		snapshot[key] = descriptor.value;
	}
	return Object.freeze(snapshot);
}

function requireOpaqueString(input: unknown, label: string): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.trim() !== input
	) {
		throw new TypeError(`${label} must be a non-empty, trimmed string.`);
	}
	if (input.includes("\0")) {
		throw new TypeError(`${label} must not contain a NUL byte.`);
	}
	return input;
}

function requireCanonicalDigest(input: unknown, label: string): string {
	const value = requireOpaqueString(input, label);
	const canonical = canonicalSha256Digest(value);
	if (canonical !== value) {
		throw new TypeError(`${label} must be a canonical sha256: digest.`);
	}
	return canonical;
}

function requirePositiveSafeInteger(input: unknown, label: string): number {
	if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return input;
}

function assertEventId(input: unknown): asserts input is string {
	if (typeof input !== "string" || !EVENT_ID.test(input)) {
		throw new TypeError("generateEventId must return a UUIDv7 event id.");
	}
}

async function generateLedgerEventId(): Promise<string> {
	const { newEventId } = await import("@buildplane/ledger-client");
	return newEventId();
}
