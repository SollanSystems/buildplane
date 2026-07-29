import {
	createHash,
	createPublicKey,
	KeyObject,
	verify as verifyDetachedSignature,
} from "node:crypto";
import { existsSync } from "node:fs";

const KERNEL_ACTOR_ID = "kernel";
const KERNEL_KEY_ID = "kernel-main";
const ED25519 = "ed25519";
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_URL_NO_PAD = /^[A-Za-z0-9_-]+$/;
const UTC_TIMESTAMP =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/;

export interface AdmittedPlanRecord {
	readonly authorizedNextStep: string;
	readonly signedByKernel: boolean;
}

export interface AdmittedPlanReader {
	read(
		eventsDbPath: string,
		eventId: string,
	): Promise<AdmittedPlanRecord | undefined>;
}

/** Immutable, canonical input passed to an explicitly pinned verifier. */
export interface AdmittedPlanSignatureVerificationInput {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly canonicalEventHash: string;
	readonly canonicalEventB64: string;
	readonly signer: Readonly<{
		readonly actorId: string;
		readonly keyId: string;
		readonly publicKeyHash: string;
	}>;
	readonly algorithm: "ed25519";
	readonly signature: string;
}

/**
 * A verifier created by {@link createPinnedEd25519AdmittedPlanSignatureVerifier}.
 *
 * This interface is intentionally nominal at runtime: the reader accepts only
 * factory-created instances registered in its private weak map. That prevents a
 * caller from turning a structural `{ verify: () => true }` lookalike into
 * admission authority.
 */
export interface PinnedAdmittedPlanSignatureVerifier {
	readonly kind: "pinned-admitted-plan-signature-verifier-v1";
	verify(input: Readonly<AdmittedPlanSignatureVerificationInput>): boolean;
}

export interface PinnedEd25519AdmissionVerifierInput {
	/** A public Ed25519 key object or exactly 32 raw public-key bytes. */
	readonly publicKey: KeyObject | Uint8Array;
	/** Pin the key identity separately from the mutable SQLite signature row. */
	readonly publicKeyHash: string;
}

export interface AdmittedPlanReaderOptions {
	/**
	 * Explicit verifier provisioned from a privileged/native trust projection.
	 * Omitting it intentionally leaves every SQLite-only record untrusted.
	 */
	readonly signatureVerifier?: PinnedAdmittedPlanSignatureVerifier;
}

interface PinnedVerifierState {
	readonly publicKey: KeyObject;
	readonly publicKeyHash: string;
}

interface PlanAdmittedPayload {
	readonly planId: string;
	readonly planDigest: string;
	readonly inputDigest: string;
	readonly trustedBase: string;
	readonly decidedBy: string;
	readonly decidedAt: string;
	readonly idempotencyKey: string;
	readonly authorizedNextStep: string;
}

interface StoredAdmissionEvent {
	readonly id: string;
	readonly runId: string;
	readonly parentEventId: string | null;
	readonly occurredAt: string;
	readonly payload: PlanAdmittedPayload;
}

interface StoredEventSignature {
	readonly eventId: string;
	readonly canonicalEventHash: string;
	readonly actorId: string;
	readonly keyId: string;
	readonly publicKeyHash: string;
	readonly signature: string;
}

const pinnedVerifierStates = new WeakMap<object, PinnedVerifierState>();

/**
 * Build an Ed25519 verifier around an already-pinned public key. The caller is
 * responsible for obtaining this public key from a privileged/native authority
 * projection; this helper never discovers key material from the event tape.
 */
export function createPinnedEd25519AdmittedPlanSignatureVerifier(
	input: PinnedEd25519AdmissionVerifierInput,
): PinnedAdmittedPlanSignatureVerifier {
	const record = requireExactDataRecord(
		input,
		"pinned Ed25519 admission verifier input",
		["publicKey", "publicKeyHash"],
	);
	const publicKey = normalizeEd25519PublicKey(record.publicKey);
	if (!publicKey) {
		throw new TypeError(
			"pinned Ed25519 admission verifier requires a public Ed25519 key.",
		);
	}
	const publicKeyHash = requireCanonicalDigest(
		record.publicKeyHash,
		"pinned Ed25519 admission verifier publicKeyHash",
	);
	if (canonicalDigest(rawEd25519PublicKey(publicKey)) !== publicKeyHash) {
		throw new TypeError(
			"pinned Ed25519 admission verifier publicKeyHash does not match the supplied public key.",
		);
	}

	const state: PinnedVerifierState = Object.freeze({
		publicKey,
		publicKeyHash,
	});
	const verifier: PinnedAdmittedPlanSignatureVerifier = Object.freeze({
		kind: "pinned-admitted-plan-signature-verifier-v1",
		verify(
			verificationInput: Readonly<AdmittedPlanSignatureVerificationInput>,
		) {
			return verifyPinnedAdmissionSignature(verificationInput, state);
		},
	});
	pinnedVerifierStates.set(verifier, state);
	return verifier;
}

/**
 * Reads a `plan_admitted` event by its tape event id. SQLite metadata is never
 * authority by itself: a record is marked signed only after its canonical event
 * bytes, canonical hash, identity, algorithm, and detached signature all verify
 * against an explicitly pinned public key. Without that verifier the reader
 * deliberately fails closed while preserving the existing read result shape.
 */
export function createDefaultAdmittedPlanReader(
	options: AdmittedPlanReaderOptions = {},
): AdmittedPlanReader {
	const signatureVerifier = resolvePinnedVerifier(options);
	return {
		async read(eventsDbPath, eventId) {
			if (!existsSync(eventsDbPath)) {
				return undefined;
			}
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(eventsDbPath, { readOnly: true });
			try {
				const event = readAdmissionEvent(
					db
						.prepare(
							"SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload FROM events WHERE id = ? AND kind = 'plan_admitted'",
						)
						.get(eventId),
				);
				if (!event) {
					return undefined;
				}

				const unverified: AdmittedPlanRecord = {
					authorizedNextStep: event.payload.authorizedNextStep,
					signedByKernel: false,
				};
				if (!signatureVerifier) {
					return unverified;
				}

				const signature = readKernelSignature(
					db
						.prepare(
							"SELECT event_id, canonical_event_hash, actor_id, key_id, public_key_hash, algorithm, signature, signed_at FROM event_signatures WHERE event_id = ?",
						)
						.get(eventId),
					event.id,
				);
				if (!signature) {
					return unverified;
				}

				const canonicalEventBytes = canonicalAdmissionEventBytes(event);
				if (
					canonicalDigest(canonicalEventBytes) !== signature.canonicalEventHash
				) {
					return unverified;
				}

				const verificationInput = Object.freeze({
					schemaVersion: 1 as const,
					eventId: event.id,
					canonicalEventHash: signature.canonicalEventHash,
					canonicalEventB64: canonicalEventBytes.toString("base64url"),
					signer: Object.freeze({
						actorId: signature.actorId,
						keyId: signature.keyId,
						publicKeyHash: signature.publicKeyHash,
					}),
					algorithm: "ed25519" as const,
					signature: signature.signature,
				});
				return {
					...unverified,
					signedByKernel: signatureVerifier.verify(verificationInput) === true,
				};
			} catch {
				// A corrupt, incomplete, or incompatible tape must never become
				// admission authority through an exception path.
				return undefined;
			} finally {
				db.close();
			}
		},
	};
}

function resolvePinnedVerifier(
	options: AdmittedPlanReaderOptions,
): PinnedAdmittedPlanSignatureVerifier | undefined {
	const record = requireExactDataRecord(
		options,
		"admitted plan reader options",
		[],
		["signatureVerifier"],
	);
	const candidate = record.signatureVerifier;
	if (candidate === undefined) {
		return undefined;
	}
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!pinnedVerifierStates.has(candidate)
	) {
		throw new TypeError(
			"admitted plan reader signatureVerifier must be an explicitly pinned verifier.",
		);
	}
	return candidate as PinnedAdmittedPlanSignatureVerifier;
}

function readAdmissionEvent(value: unknown): StoredAdmissionEvent | undefined {
	const row = exactDataRecord(value, [
		"id",
		"run_id",
		"parent_event_id",
		"schema_version",
		"kind",
		"occurred_at",
		"payload",
	]);
	if (!row || row.kind !== "plan_admitted" || row.schema_version !== 1) {
		return undefined;
	}
	const id = canonicalUuid(row.id);
	const runId = canonicalUuid(row.run_id);
	const parentEventId = nullableCanonicalUuid(row.parent_event_id);
	const occurredAt = canonicalUtcTimestamp(row.occurred_at);
	if (!id || !runId || parentEventId === undefined || !occurredAt) {
		return undefined;
	}
	if (typeof row.payload !== "string") {
		return undefined;
	}
	const payload = parsePlanAdmittedPayload(row.payload);
	if (!payload) {
		return undefined;
	}
	return Object.freeze({ id, runId, parentEventId, occurredAt, payload });
}

function parsePlanAdmittedPayload(
	value: string,
): PlanAdmittedPayload | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	const outer = exactDataRecord(parsed, ["PlanAdmittedV1"]);
	if (!outer) {
		return undefined;
	}
	const payload = exactDataRecord(outer.PlanAdmittedV1, [
		"plan_id",
		"plan_digest",
		"input_digest",
		"trusted_base",
		"decided_by",
		"decided_at",
		"idempotency_key",
		"authorized_next_step",
	]);
	if (!payload) {
		return undefined;
	}
	const values = [
		payload.plan_id,
		payload.plan_digest,
		payload.input_digest,
		payload.trusted_base,
		payload.decided_by,
		payload.decided_at,
		payload.idempotency_key,
		payload.authorized_next_step,
	];
	if (values.some((field) => typeof field !== "string")) {
		return undefined;
	}
	return Object.freeze({
		planId: payload.plan_id as string,
		planDigest: payload.plan_digest as string,
		inputDigest: payload.input_digest as string,
		trustedBase: payload.trusted_base as string,
		decidedBy: payload.decided_by as string,
		decidedAt: payload.decided_at as string,
		idempotencyKey: payload.idempotency_key as string,
		authorizedNextStep: payload.authorized_next_step as string,
	});
}

function readKernelSignature(
	value: unknown,
	expectedEventId: string,
): StoredEventSignature | undefined {
	const row = exactDataRecord(value, [
		"event_id",
		"canonical_event_hash",
		"actor_id",
		"key_id",
		"public_key_hash",
		"algorithm",
		"signature",
		"signed_at",
	]);
	if (
		!row ||
		canonicalUuid(row.event_id) !== expectedEventId ||
		row.actor_id !== KERNEL_ACTOR_ID ||
		row.key_id !== KERNEL_KEY_ID ||
		row.algorithm !== ED25519 ||
		typeof row.signature !== "string" ||
		!decodeCanonicalBase64Url(row.signature, 64) ||
		!canonicalUtcTimestamp(row.signed_at)
	) {
		return undefined;
	}
	const canonicalEventHash = canonicalDigestValue(row.canonical_event_hash);
	const publicKeyHash = canonicalDigestValue(row.public_key_hash);
	if (!canonicalEventHash || !publicKeyHash) {
		return undefined;
	}
	return Object.freeze({
		eventId: expectedEventId,
		canonicalEventHash,
		actorId: KERNEL_ACTOR_ID,
		keyId: KERNEL_KEY_ID,
		publicKeyHash,
		signature: row.signature,
	});
}

function canonicalAdmissionEventBytes(event: StoredAdmissionEvent): Buffer {
	return Buffer.from(
		JSON.stringify({
			id: event.id,
			run_id: event.runId,
			parent_event_id: event.parentEventId,
			schema_version: 1,
			kind: "plan_admitted",
			occurred_at: event.occurredAt,
			payload: {
				PlanAdmittedV1: {
					plan_id: event.payload.planId,
					plan_digest: event.payload.planDigest,
					input_digest: event.payload.inputDigest,
					trusted_base: event.payload.trustedBase,
					decided_by: event.payload.decidedBy,
					decided_at: event.payload.decidedAt,
					idempotency_key: event.payload.idempotencyKey,
					authorized_next_step: event.payload.authorizedNextStep,
				},
			},
		}),
		"utf8",
	);
}

function verifyPinnedAdmissionSignature(
	value: unknown,
	state: PinnedVerifierState,
): boolean {
	const input = exactDataRecord(value, [
		"schemaVersion",
		"eventId",
		"canonicalEventHash",
		"canonicalEventB64",
		"signer",
		"algorithm",
		"signature",
	]);
	if (
		!input ||
		input.schemaVersion !== 1 ||
		!canonicalUuid(input.eventId) ||
		input.algorithm !== ED25519 ||
		typeof input.canonicalEventB64 !== "string" ||
		typeof input.signature !== "string"
	) {
		return false;
	}
	const canonicalEventHash = canonicalDigestValue(input.canonicalEventHash);
	const canonicalEventBytes = decodeCanonicalBase64Url(input.canonicalEventB64);
	const signature = decodeCanonicalBase64Url(input.signature, 64);
	const signer = exactDataRecord(input.signer, [
		"actorId",
		"keyId",
		"publicKeyHash",
	]);
	if (
		!canonicalEventHash ||
		!canonicalEventBytes ||
		!signature ||
		!signer ||
		signer.actorId !== KERNEL_ACTOR_ID ||
		signer.keyId !== KERNEL_KEY_ID
	) {
		return false;
	}
	const publicKeyHash = canonicalDigestValue(signer.publicKeyHash);
	if (
		!publicKeyHash ||
		canonicalDigest(canonicalEventBytes) !== canonicalEventHash
	) {
		return false;
	}
	if (publicKeyHash !== state.publicKeyHash) {
		return false;
	}
	try {
		return verifyDetachedSignature(
			null,
			canonicalEventBytes,
			state.publicKey,
			signature,
		);
	} catch {
		return false;
	}
}

function normalizeEd25519PublicKey(value: unknown): KeyObject | undefined {
	if (value instanceof KeyObject) {
		if (value.type !== "public" || value.asymmetricKeyType !== ED25519) {
			return undefined;
		}
		try {
			rawEd25519PublicKey(value);
			return value;
		} catch {
			return undefined;
		}
	}
	if (!(value instanceof Uint8Array)) {
		return undefined;
	}
	const raw = Buffer.from(value);
	if (raw.length !== 32) {
		return undefined;
	}
	try {
		return createPublicKey({
			key: {
				kty: "OKP",
				crv: "Ed25519",
				x: raw.toString("base64url"),
			},
			format: "jwk",
		});
	} catch {
		return undefined;
	}
}

function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
		throw new TypeError("public key is not an Ed25519 OKP key");
	}
	const raw = Buffer.from(jwk.x, "base64url");
	if (raw.length !== 32 || raw.toString("base64url") !== jwk.x) {
		throw new TypeError("public key is not a canonical 32-byte Ed25519 key");
	}
	return raw;
}

function canonicalUuid(value: unknown): string | undefined {
	return typeof value === "string" && UUID.test(value)
		? value.toLowerCase()
		: undefined;
}

function nullableCanonicalUuid(value: unknown): string | null | undefined {
	if (value === null) {
		return null;
	}
	return canonicalUuid(value);
}

function canonicalUtcTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const match = UTC_TIMESTAMP.exec(value);
	if (!match) {
		return undefined;
	}
	const base = match[1];
	const fraction = match[2] ?? "";
	const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
	const parsed = Date.parse(`${base}.${milliseconds}Z`);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString().slice(0, 19) !== base
	) {
		return undefined;
	}
	const normalizedFraction = fraction.replace(/0+$/, "");
	return `${base}${normalizedFraction.length > 0 ? `.${normalizedFraction}` : ""}Z`;
}

function canonicalDigest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalDigestValue(value: unknown): string | undefined {
	return typeof value === "string" && SHA256_DIGEST.test(value)
		? value
		: undefined;
}

function decodeCanonicalBase64Url(
	value: string,
	expectedLength?: number,
): Buffer | undefined {
	if (!BASE64_URL_NO_PAD.test(value)) {
		return undefined;
	}
	try {
		const decoded = Buffer.from(value, "base64url");
		if (
			decoded.length === 0 ||
			(expectedLength !== undefined && decoded.length !== expectedLength) ||
			decoded.toString("base64url") !== value
		) {
			return undefined;
		}
		return decoded;
	} catch {
		return undefined;
	}
}

function requireCanonicalDigest(value: unknown, name: string): string {
	const digest = canonicalDigestValue(value);
	if (!digest) {
		throw new TypeError(`${name} must be a canonical sha256 digest.`);
	}
	return digest;
}

function requireExactDataRecord(
	value: unknown,
	name: string,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
	const record = exactDataRecord(value, requiredKeys, optionalKeys);
	if (!record) {
		throw new TypeError(`${name} must be a closed data-only record.`);
	}
	return record;
}

function exactDataRecord(
	value: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) {
		return undefined;
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		return undefined;
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const allowed = new Set([...requiredKeys, ...optionalKeys]);
	const keys = Object.keys(descriptors);
	if (
		keys.some((key) => !allowed.has(key)) ||
		requiredKeys.some((key) => descriptors[key] === undefined) ||
		keys.some((key) => !Object.hasOwn(descriptors[key], "value"))
	) {
		return undefined;
	}
	const snapshot: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	for (const key of keys) {
		snapshot[key] = descriptors[key]?.value;
	}
	return Object.freeze(snapshot);
}
