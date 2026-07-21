import { createHash, KeyObject, verify } from "node:crypto";
import {
	type DispatchEnvelopeV3,
	parseDispatchEnvelopeV3,
} from "@buildplane/kernel";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CANONICAL_BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPAQUE_REFERENCE_FRAGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const managedTransportBrand: unique symbol = Symbol(
	"managed-authority-broker-transport-v1",
);

/**
 * An opaque host-managed transport capability. This module intentionally does
 * not export a production factory: a future broker integration must adopt its
 * transport at a privileged host boundary, rather than allowing the CLI or a
 * workspace packet to manufacture one. Detached broker signatures remain the
 * authorization proof even after a transport has been provisioned.
 */
export interface ManagedAuthorityBrokerTransportV1 {
	readonly kind: "managed-authority-broker-transport-v1";
	readonly [managedTransportBrand]: true;
}

export type AuthorityBrokerOperationV1 = "admit" | "lookup_preauthorized";

export interface AuthorityBrokerAdmitRequestBodyV1 {
	readonly run_id: string;
	readonly workflow_id: string;
	readonly workflow_revision: string;
	readonly unit_id: string;
	readonly attempt: number;
	readonly idempotency_key: string;
	/** An opaque broker-registered repository target, never a local path. */
	readonly repository_target_ref: string;
	/** The caller's expected registered target identity, not a base SHA. */
	readonly expected_repository_binding_digest: string;
	readonly governed_packet_ref: string;
	readonly governed_packet_digest: string;
}

export interface AuthorityBrokerPreauthorizedLookupRequestBodyV1
	extends AuthorityBrokerAdmitRequestBodyV1 {
	readonly preauthorization_ref: string;
}

/** Closed V1 wire request emitted to the external authority broker. */
export interface AuthorityBrokerRequestV1 {
	readonly schema_version: 1;
	readonly operation: AuthorityBrokerOperationV1;
	readonly request_id: string;
	readonly request:
		| AuthorityBrokerAdmitRequestBodyV1
		| AuthorityBrokerPreauthorizedLookupRequestBodyV1;
	readonly request_digest: string;
}

export interface AuthorityBrokerAdmitInputV1 {
	readonly requestId: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly idempotencyKey: string;
	readonly repositoryTargetRef: string;
	readonly expectedRepositoryBindingDigest: string;
	readonly governedPacketRef: string;
	readonly governedPacketDigest: string;
}

export interface AuthorityBrokerPreauthorizedLookupInputV1
	extends AuthorityBrokerAdmitInputV1 {
	readonly preauthorizationRef: string;
}

export interface AuthorityBrokerRealmV1 {
	readonly schemaVersion: 1;
	readonly realmDigest: string;
	readonly brokerId: string;
}

export interface AuthorityBrokerDispatchEventV1 {
	readonly eventId: string;
	readonly runId: string;
	readonly eventKind: "dispatch_envelope_v3";
	readonly envelopeDigest: string;
	readonly realmDigest: string;
	readonly tapeId: string;
}

export interface AuthorityBrokerTapeV1 {
	readonly schemaVersion: 1;
	readonly tapeId: string;
	readonly runId: string;
	readonly eventId: string;
	readonly eventKind: "dispatch_envelope_v3";
	readonly envelopeDigest: string;
	readonly realmDigest: string;
	readonly tapeRootDigest: string;
}

/**
 * A detached broker-signed admission statement. It is deliberately not a
 * signed-tape proof: a future privileged composition must resolve this event
 * through the protected ledger/reducer before it can produce execution
 * authority. Both V1 operations return this exact immutable statement.
 */
export interface BrokerSignedDispatchAdmissionV1 {
	readonly responseId: string;
	readonly expiresAt: string;
	readonly envelope: DispatchEnvelopeV3;
	readonly authorityRealm: AuthorityBrokerRealmV1;
	readonly dispatchEvent: AuthorityBrokerDispatchEventV1;
	readonly tape: AuthorityBrokerTapeV1;
}

export interface AuthorityBrokerClientV1 {
	admit(
		input: AuthorityBrokerAdmitInputV1,
	): Promise<BrokerSignedDispatchAdmissionV1>;
	lookupPreauthorized(
		input: AuthorityBrokerPreauthorizedLookupInputV1,
	): Promise<BrokerSignedDispatchAdmissionV1>;
}

/**
 * Pure verification configuration for an already-received broker response.
 * This verifies detached evidence only; it cannot open a transport, invoke a
 * broker, or mint a managed authority capability.
 */
export interface AuthorityBrokerResponseVerificationOptionsV1 {
	readonly responseSigningKeyId: string;
	readonly responseSigningPublicKey: KeyObject;
	readonly responseSigningPublicKeyDigest: string;
}

interface AuthorityBrokerResponseVerificationState
	extends AuthorityBrokerResponseVerificationOptionsV1 {}

interface ManagedTransportState
	extends AuthorityBrokerResponseVerificationState {
	readonly invoke: (request: AuthorityBrokerRequestV1) => Promise<unknown>;
}

const managedTransportStates = new WeakMap<object, ManagedTransportState>();

/**
 * Construct a client from an opaque host-managed capability. A structural
 * lookalike, a local subprocess, and all caller-supplied authority material
 * are rejected before any request can leave this boundary.
 */
export function createAuthorityBrokerClient(
	transport: ManagedAuthorityBrokerTransportV1,
): AuthorityBrokerClientV1 {
	const state = managedTransportStates.get(transport as object);
	if (!state) {
		throw new TypeError(
			"managed authority broker transport provenance is not recognized.",
		);
	}

	return Object.freeze({
		async admit(input: AuthorityBrokerAdmitInputV1) {
			const request = createAuthorityBrokerAdmitRequestV1(input);
			return invokeAndVerify(state, request);
		},
		async lookupPreauthorized(
			input: AuthorityBrokerPreauthorizedLookupInputV1,
		) {
			const request = createAuthorityBrokerPreauthorizedLookupRequestV1(input);
			return invokeAndVerify(state, request);
		},
	});
}

/**
 * Build the exact closed request for a broker admission. This is pure request
 * canonicalization; it cannot discover, invoke, or register a broker.
 */
export function createAuthorityBrokerAdmitRequestV1(
	input: AuthorityBrokerAdmitInputV1,
): AuthorityBrokerRequestV1 {
	const record = assertClosedRecord(input, "authority broker admit input", [
		"requestId",
		"runId",
		"workflowId",
		"workflowRevision",
		"unitId",
		"attempt",
		"idempotencyKey",
		"repositoryTargetRef",
		"expectedRepositoryBindingDigest",
		"governedPacketRef",
		"governedPacketDigest",
	]);
	const request = Object.freeze({
		run_id: requireUuid(record.runId, "runId"),
		workflow_id: requireNonEmpty(record.workflowId, "workflowId"),
		workflow_revision: requireNonEmpty(
			record.workflowRevision,
			"workflowRevision",
		),
		unit_id: requireNonEmpty(record.unitId, "unitId"),
		attempt: requirePositiveSafeInteger(record.attempt, "attempt"),
		idempotency_key: requireNonEmpty(record.idempotencyKey, "idempotencyKey"),
		repository_target_ref: requireBrokerReference(
			record.repositoryTargetRef,
			"repositoryTargetRef",
		),
		expected_repository_binding_digest: requireDigest(
			record.expectedRepositoryBindingDigest,
			"expectedRepositoryBindingDigest",
		),
		governed_packet_ref: requireCasReference(
			record.governedPacketRef,
			"governedPacketRef",
		),
		governed_packet_digest: requireDigest(
			record.governedPacketDigest,
			"governedPacketDigest",
		),
	});
	return finalizeRequest({
		schema_version: 1,
		operation: "admit",
		request_id: requireUuid(record.requestId, "requestId"),
		request,
	});
}

/**
 * Build the exact closed request for a broker preauthorization lookup. This is
 * pure request canonicalization; it cannot discover, invoke, or register a
 * broker.
 */
export function createAuthorityBrokerPreauthorizedLookupRequestV1(
	input: AuthorityBrokerPreauthorizedLookupInputV1,
): AuthorityBrokerRequestV1 {
	const record = assertClosedRecord(
		input,
		"authority broker preauthorized lookup input",
		[
			"requestId",
			"runId",
			"workflowId",
			"workflowRevision",
			"unitId",
			"attempt",
			"idempotencyKey",
			"repositoryTargetRef",
			"expectedRepositoryBindingDigest",
			"preauthorizationRef",
			"governedPacketRef",
			"governedPacketDigest",
		],
	);
	const request = Object.freeze({
		run_id: requireUuid(record.runId, "runId"),
		workflow_id: requireNonEmpty(record.workflowId, "workflowId"),
		workflow_revision: requireNonEmpty(
			record.workflowRevision,
			"workflowRevision",
		),
		unit_id: requireNonEmpty(record.unitId, "unitId"),
		attempt: requirePositiveSafeInteger(record.attempt, "attempt"),
		idempotency_key: requireNonEmpty(record.idempotencyKey, "idempotencyKey"),
		repository_target_ref: requireBrokerReference(
			record.repositoryTargetRef,
			"repositoryTargetRef",
		),
		expected_repository_binding_digest: requireDigest(
			record.expectedRepositoryBindingDigest,
			"expectedRepositoryBindingDigest",
		),
		preauthorization_ref: requireBrokerReference(
			record.preauthorizationRef,
			"preauthorizationRef",
		),
		governed_packet_ref: requireCasReference(
			record.governedPacketRef,
			"governedPacketRef",
		),
		governed_packet_digest: requireDigest(
			record.governedPacketDigest,
			"governedPacketDigest",
		),
	});
	return finalizeRequest({
		schema_version: 1,
		operation: "lookup_preauthorized",
		request_id: requireUuid(record.requestId, "requestId"),
		request,
	});
}

/**
 * Verify a detached broker response against an exact request and pinned public
 * signing identity. This pure helper deliberately has no transport, callback,
 * managed-capability, or side-effect surface.
 */
export function verifyAuthorityBrokerResponseV1(
	value: unknown,
	request: AuthorityBrokerRequestV1,
	options: AuthorityBrokerResponseVerificationOptionsV1,
): BrokerSignedDispatchAdmissionV1 {
	return parseAndVerifyResponse(
		value,
		request,
		normalizeResponseVerificationOptions(options),
	);
}

function normalizeResponseVerificationOptions(
	options: AuthorityBrokerResponseVerificationOptionsV1,
): AuthorityBrokerResponseVerificationState {
	const record = assertClosedRecord(
		options,
		"authority broker response verification options",
		[
			"responseSigningKeyId",
			"responseSigningPublicKey",
			"responseSigningPublicKeyDigest",
		],
	);
	const responseSigningKeyId = requireNonEmpty(
		record.responseSigningKeyId,
		"responseSigningKeyId",
	);
	if (!(record.responseSigningPublicKey instanceof KeyObject)) {
		throw new TypeError(
			"responseSigningPublicKey must be a Node.js public KeyObject.",
		);
	}
	const responseSigningPublicKey = record.responseSigningPublicKey;
	if (
		responseSigningPublicKey.type !== "public" ||
		responseSigningPublicKey.asymmetricKeyType !== "ed25519"
	) {
		throw new TypeError(
			"responseSigningPublicKey must be an Ed25519 public key.",
		);
	}
	const responseSigningPublicKeyDigest = requireDigest(
		record.responseSigningPublicKeyDigest,
		"responseSigningPublicKeyDigest",
	);
	const actualPublicKeyDigest = digestPublicKey(responseSigningPublicKey);
	if (actualPublicKeyDigest !== responseSigningPublicKeyDigest) {
		throw new TypeError(
			"responseSigningPublicKeyDigest does not match the supplied Ed25519 public key.",
		);
	}
	return Object.freeze({
		responseSigningKeyId,
		responseSigningPublicKey,
		responseSigningPublicKeyDigest,
	});
}

function finalizeRequest(
	request: Omit<AuthorityBrokerRequestV1, "request_digest">,
): AuthorityBrokerRequestV1 {
	return Object.freeze({
		...request,
		request_digest: canonicalDigest(request),
	});
}

async function invokeAndVerify(
	state: ManagedTransportState,
	request: AuthorityBrokerRequestV1,
): Promise<BrokerSignedDispatchAdmissionV1> {
	let raw: unknown;
	try {
		raw = await state.invoke(request);
	} catch (error) {
		throw new Error(
			`managed authority broker transport failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return parseAndVerifyResponse(raw, request, state);
}

function parseAndVerifyResponse(
	value: unknown,
	request: AuthorityBrokerRequestV1,
	state: AuthorityBrokerResponseVerificationState,
): BrokerSignedDispatchAdmissionV1 {
	const record = assertClosedRecord(value, "authority broker response", [
		"schema_version",
		"operation",
		"request_id",
		"request_digest",
		"response_id",
		"expires_at",
		"envelope",
		"authority_realm",
		"dispatch_event",
		"tape",
		"response_signing_identity",
		"response_signature",
	]);
	if (record.schema_version !== 1) {
		throw new TypeError("authority broker response schema_version must be 1.");
	}
	const operation = requireOperation(record.operation, "response.operation");
	const requestId = requireUuid(record.request_id, "response.request_id");
	const requestDigest = requireDigest(
		record.request_digest,
		"response.request_digest",
	);
	if (
		operation !== request.operation ||
		requestId !== request.request_id ||
		requestDigest !== request.request_digest
	) {
		throw new TypeError(
			"authority broker response request ID, operation, or request digest does not match the exact request.",
		);
	}
	const responseId = requireUuid(record.response_id, "response.response_id");
	const expiresAt = requireFutureTimestamp(
		record.expires_at,
		"response.expires_at",
	);
	const envelope = parseDispatchEnvelopeV3(record.envelope);
	assertGovernedEnvelope(envelope, request, expiresAt);
	const authorityRealm = parseAuthorityRealm(record.authority_realm);
	const dispatchEvent = parseDispatchEvent(record.dispatch_event);
	const tape = parseTape(record.tape);
	assertEnvelopeRealmEventTapeAgreement(
		envelope,
		authorityRealm,
		dispatchEvent,
		tape,
		request,
	);
	const responseSigningIdentity = parseResponseSigningIdentity(
		record.response_signing_identity,
	);
	assertPinnedSigningIdentity(responseSigningIdentity, state);
	const responseSignature = parseBase64(
		record.response_signature,
		"response.response_signature",
	);
	const unsigned = canonicalResponseWithoutSignature({
		schemaVersion: 1,
		operation,
		requestId,
		requestDigest,
		responseId,
		expiresAt,
		envelope,
		authorityRealm,
		dispatchEvent,
		tape,
		responseSigningIdentity,
	});
	if (
		!verify(
			null,
			Buffer.from(canonicalJson(unsigned), "utf8"),
			state.responseSigningPublicKey,
			responseSignature,
		)
	) {
		throw new TypeError(
			"authority broker response detached Ed25519 signature is invalid.",
		);
	}

	return Object.freeze({
		responseId,
		expiresAt,
		envelope: deepFreeze(envelope),
		authorityRealm,
		dispatchEvent,
		tape,
	});
}

function assertGovernedEnvelope(
	envelope: DispatchEnvelopeV3,
	request: AuthorityBrokerRequestV1,
	responseExpiresAt: string,
): void {
	if (
		envelope.actionEvidenceVersion !== "sealed_v3" ||
		envelope.body.trustTier !== "governed" ||
		envelope.body.commitMode !== "atomic"
	) {
		throw new TypeError(
			"authority broker response envelope is not sealed_v3 governed atomic authority.",
		);
	}
	if (envelope.body.expiresAt !== responseExpiresAt) {
		throw new TypeError(
			"authority broker response expiry does not agree with the dispatch envelope expiry.",
		);
	}
	if (Date.parse(envelope.body.expiresAt) <= Date.now()) {
		throw new TypeError(
			"authority broker response envelope expiry is expired.",
		);
	}
	if (
		envelope.governedPacketDigest !== request.request.governed_packet_digest
	) {
		throw new TypeError(
			"authority broker response envelope is not bound to the requested governed packet digest.",
		);
	}
	if (
		envelope.body.workflowId !== request.request.workflow_id ||
		envelope.body.workflowRevision !== request.request.workflow_revision ||
		envelope.body.unitId !== request.request.unit_id ||
		envelope.body.attempt !== request.request.attempt ||
		envelope.body.idempotencyKey !== request.request.idempotency_key
	) {
		throw new TypeError(
			"authority broker response envelope does not match the requested workflow, unit, attempt, or idempotency identity.",
		);
	}
	if (
		envelope.repositoryBindingDigest !==
		request.request.expected_repository_binding_digest
	) {
		throw new TypeError(
			"authority broker response envelope is not bound to the requested registered repository target.",
		);
	}
}

function parseAuthorityRealm(value: unknown): AuthorityBrokerRealmV1 {
	const record = assertClosedRecord(
		value,
		"authority broker response authority_realm",
		["schema_version", "realm_digest", "broker_id"],
	);
	if (record.schema_version !== 1) {
		throw new TypeError("authority_realm.schema_version must be 1.");
	}
	return Object.freeze({
		schemaVersion: 1,
		realmDigest: requireDigest(
			record.realm_digest,
			"authority_realm.realm_digest",
		),
		brokerId: requireOpaqueIdentifier(
			record.broker_id,
			"authority_realm.broker_id",
		),
	});
}

function parseDispatchEvent(value: unknown): AuthorityBrokerDispatchEventV1 {
	const record = assertClosedRecord(
		value,
		"authority broker response dispatch_event",
		[
			"event_id",
			"run_id",
			"event_kind",
			"envelope_digest",
			"realm_digest",
			"tape_id",
		],
	);
	if (record.event_kind !== "dispatch_envelope_v3") {
		throw new TypeError(
			"authority broker response dispatch_event.event_kind must be dispatch_envelope_v3.",
		);
	}
	return Object.freeze({
		eventId: requireUuid(record.event_id, "dispatch_event.event_id"),
		runId: requireUuid(record.run_id, "dispatch_event.run_id"),
		eventKind: "dispatch_envelope_v3",
		envelopeDigest: requireDigest(
			record.envelope_digest,
			"dispatch_event.envelope_digest",
		),
		realmDigest: requireDigest(
			record.realm_digest,
			"dispatch_event.realm_digest",
		),
		tapeId: requireTapeReference(record.tape_id, "dispatch_event.tape_id"),
	});
}

function parseTape(value: unknown): AuthorityBrokerTapeV1 {
	const record = assertClosedRecord(value, "authority broker response tape", [
		"schema_version",
		"tape_id",
		"run_id",
		"event_id",
		"event_kind",
		"envelope_digest",
		"realm_digest",
		"tape_root_digest",
	]);
	if (record.schema_version !== 1) {
		throw new TypeError("tape.schema_version must be 1.");
	}
	if (record.event_kind !== "dispatch_envelope_v3") {
		throw new TypeError(
			"authority broker response tape.event_kind must be dispatch_envelope_v3.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		tapeId: requireTapeReference(record.tape_id, "tape.tape_id"),
		runId: requireUuid(record.run_id, "tape.run_id"),
		eventId: requireUuid(record.event_id, "tape.event_id"),
		eventKind: "dispatch_envelope_v3",
		envelopeDigest: requireDigest(
			record.envelope_digest,
			"tape.envelope_digest",
		),
		realmDigest: requireDigest(record.realm_digest, "tape.realm_digest"),
		tapeRootDigest: requireDigest(
			record.tape_root_digest,
			"tape.tape_root_digest",
		),
	});
}

interface ResponseSigningIdentityV1 {
	readonly algorithm: "ed25519";
	readonly keyId: string;
	readonly publicKeyDigest: string;
}

function parseResponseSigningIdentity(
	value: unknown,
): ResponseSigningIdentityV1 {
	const record = assertClosedRecord(
		value,
		"authority broker response response_signing_identity",
		["algorithm", "key_id", "public_key_digest"],
	);
	if (record.algorithm !== "ed25519") {
		throw new TypeError(
			"authority broker response signing identity algorithm must be ed25519.",
		);
	}
	return Object.freeze({
		algorithm: "ed25519",
		keyId: requireNonEmpty(record.key_id, "response_signing_identity.key_id"),
		publicKeyDigest: requireDigest(
			record.public_key_digest,
			"response_signing_identity.public_key_digest",
		),
	});
}

function assertPinnedSigningIdentity(
	identity: ResponseSigningIdentityV1,
	state: AuthorityBrokerResponseVerificationState,
): void {
	if (
		identity.keyId !== state.responseSigningKeyId ||
		identity.publicKeyDigest !== state.responseSigningPublicKeyDigest
	) {
		throw new TypeError(
			"authority broker response signing identity does not match the pinned verifier identity.",
		);
	}
}

function assertEnvelopeRealmEventTapeAgreement(
	envelope: DispatchEnvelopeV3,
	authorityRealm: AuthorityBrokerRealmV1,
	dispatchEvent: AuthorityBrokerDispatchEventV1,
	tape: AuthorityBrokerTapeV1,
	request: AuthorityBrokerRequestV1,
): void {
	if (
		envelope.envelopeDigest !== dispatchEvent.envelopeDigest ||
		envelope.envelopeDigest !== tape.envelopeDigest
	) {
		throw new TypeError(
			"authority broker response envelope digest does not agree with dispatch event and tape.",
		);
	}
	if (
		envelope.ledgerAuthorityRealmDigest !== authorityRealm.realmDigest ||
		envelope.ledgerAuthorityRealmDigest !== dispatchEvent.realmDigest ||
		envelope.ledgerAuthorityRealmDigest !== tape.realmDigest
	) {
		throw new TypeError(
			"authority broker response realm agreement failed across envelope, authority realm, dispatch event, and tape.",
		);
	}
	if (
		dispatchEvent.tapeId !== tape.tapeId ||
		dispatchEvent.runId !== tape.runId ||
		dispatchEvent.eventId !== tape.eventId ||
		dispatchEvent.eventKind !== tape.eventKind
	) {
		throw new TypeError(
			"authority broker response dispatch event and tape event agreement failed.",
		);
	}
	if (
		dispatchEvent.runId !== request.request.run_id ||
		tape.runId !== request.request.run_id
	) {
		throw new TypeError(
			"authority broker response run does not match the exact requested run identity.",
		);
	}
}

function canonicalResponseWithoutSignature(input: {
	readonly schemaVersion: 1;
	readonly operation: AuthorityBrokerOperationV1;
	readonly requestId: string;
	readonly requestDigest: string;
	readonly responseId: string;
	readonly expiresAt: string;
	readonly envelope: DispatchEnvelopeV3;
	readonly authorityRealm: AuthorityBrokerRealmV1;
	readonly dispatchEvent: AuthorityBrokerDispatchEventV1;
	readonly tape: AuthorityBrokerTapeV1;
	readonly responseSigningIdentity: ResponseSigningIdentityV1;
}): Record<string, unknown> {
	return {
		schema_version: input.schemaVersion,
		operation: input.operation,
		request_id: input.requestId,
		request_digest: input.requestDigest,
		response_id: input.responseId,
		expires_at: input.expiresAt,
		envelope: input.envelope,
		authority_realm: {
			schema_version: input.authorityRealm.schemaVersion,
			realm_digest: input.authorityRealm.realmDigest,
			broker_id: input.authorityRealm.brokerId,
		},
		dispatch_event: {
			event_id: input.dispatchEvent.eventId,
			run_id: input.dispatchEvent.runId,
			event_kind: input.dispatchEvent.eventKind,
			envelope_digest: input.dispatchEvent.envelopeDigest,
			realm_digest: input.dispatchEvent.realmDigest,
			tape_id: input.dispatchEvent.tapeId,
		},
		tape: {
			schema_version: input.tape.schemaVersion,
			tape_id: input.tape.tapeId,
			run_id: input.tape.runId,
			event_id: input.tape.eventId,
			event_kind: input.tape.eventKind,
			envelope_digest: input.tape.envelopeDigest,
			realm_digest: input.tape.realmDigest,
			tape_root_digest: input.tape.tapeRootDigest,
		},
		response_signing_identity: {
			algorithm: input.responseSigningIdentity.algorithm,
			key_id: input.responseSigningIdentity.keyId,
			public_key_digest: input.responseSigningIdentity.publicKeyDigest,
		},
	};
}

function canonicalDigest(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex")}`;
}

function digestPublicKey(key: KeyObject): string {
	return `sha256:${createHash("sha256")
		.update(key.export({ format: "der", type: "spki" }))
		.digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(
				"canonical broker JSON cannot contain a non-finite number.",
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("canonical broker JSON must contain only JSON values.");
}

function assertClosedRecord(
	value: unknown,
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(allowedFields);
	let fields: string[];
	let symbols: symbol[];
	try {
		fields = Object.getOwnPropertyNames(record);
		symbols = Object.getOwnPropertySymbols(record);
	} catch {
		throw new TypeError(`${label} must be a closed data object.`);
	}
	if (symbols.length > 0) {
		throw new TypeError(`${label} contains unsupported symbol fields.`);
	}
	for (const field of fields) {
		if (!allowed.has(field)) {
			throw new TypeError(`${label} contains unsupported field ${field}.`);
		}
	}
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const field of allowedFields) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(record, field);
		} catch {
			throw new TypeError(`${label}.${field} must be a data property.`);
		}
		if (!descriptor) {
			throw new TypeError(`${label} is missing required field ${field}.`);
		}
		if (!("value" in descriptor)) {
			throw new TypeError(`${label}.${field} must be a data property.`);
		}
		// The broker may return an object from a host boundary. Snapshot the
		// data descriptor rather than reading `record[field]`, which lets a
		// Proxy substitute a post-validation value through a `get` trap.
		snapshot[field] = descriptor.value;
	}
	return Object.freeze(snapshot);
}

function requireOperation(
	value: unknown,
	label: string,
): AuthorityBrokerOperationV1 {
	if (value !== "admit" && value !== "lookup_preauthorized") {
		throw new TypeError(`${label} must be admit or lookup_preauthorized.`);
	}
	return value;
}

function requireUuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) {
		throw new TypeError(`${label} must be a canonical UUID.`);
	}
	return value;
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new TypeError(`${label} must be a canonical SHA-256 digest.`);
	}
	return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return value as number;
}

function requireFutureTimestamp(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!RFC3339_UTC.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new TypeError(`${label} must be a RFC3339 UTC timestamp.`);
	}
	if (Date.parse(value) <= Date.now()) {
		throw new TypeError(`${label} expiry is expired.`);
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

function requireOpaqueIdentifier(value: unknown, label: string): string {
	const text = requireNonEmpty(value, label);
	if (text.includes("\\") || text.includes("/") || text.includes("..")) {
		throw new TypeError(`${label} must be an opaque non-path identifier.`);
	}
	return text;
}

function requireCasReference(value: unknown, label: string): string {
	return requireOpaqueReference(value, label, "cas://");
}

function requireBrokerReference(value: unknown, label: string): string {
	return requireOpaqueReference(value, label, "broker://");
}

function requireTapeReference(value: unknown, label: string): string {
	const text = requireNonEmpty(value, label);
	if (!text.startsWith("tape:") || text.includes("\\") || text.includes("..")) {
		throw new TypeError(`${label} must be a tape: opaque reference.`);
	}
	return text;
}

function requireOpaqueReference(
	value: unknown,
	label: string,
	prefix: string,
): string {
	const text = requireNonEmpty(value, label);
	if (
		!text.startsWith(prefix) ||
		text.length === prefix.length ||
		text.includes("\\") ||
		text.includes("..") ||
		!OPAQUE_REFERENCE_FRAGMENT.test(text.slice(prefix.length))
	) {
		throw new TypeError(`${label} must be an opaque ${prefix} reference.`);
	}
	return text;
}

function parseBase64(value: unknown, label: string): Buffer {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!CANONICAL_BASE64.test(value)
	) {
		throw new TypeError(`${label} must be canonical base64.`);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0 || decoded.toString("base64") !== value) {
		throw new TypeError(`${label} must be canonical base64.`);
	}
	return decoded;
}

/** Parsed envelopes are fresh plain data, so freeze the complete authority graph. */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) {
			deepFreeze(descriptor.value);
		}
	}
	return Object.freeze(value);
}
