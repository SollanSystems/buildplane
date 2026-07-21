import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDefaultAdmittedPlanReader,
	createPinnedEd25519AdmittedPlanSignatureVerifier,
} from "../src/admitted-plan-reader.js";

const EVENT_ID = "01919000-0000-7000-8000-000000000022";
const RUN_ID = "01919000-0000-7000-8000-0000000000ff";
const OCCURRED_AT = "2026-05-30T00:00:01Z";
const STORED_OCCURRED_AT = "2026-05-30T00:00:01+00:00";
const RUST_PLAN_CYCLE_TAPE = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../test/fixtures/signed-tape/plan-cycle/tape.json",
);
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

interface AdmissionFixture {
	readonly eventsDbPath: string;
	readonly eventId: string;
	readonly publicKey: KeyObject | Uint8Array;
	readonly publicKeyHash: string;
}

function canonicalDigest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
		throw new TypeError("fixture key is not an Ed25519 public key");
	}
	const raw = Buffer.from(jwk.x, "base64url");
	if (raw.length !== 32) {
		throw new TypeError("fixture public key must be 32 bytes");
	}
	return raw;
}

function canonicalPlanAdmittedEvent(
	authorizedNextStep = "dispatch_admitted_plan",
): Buffer {
	return Buffer.from(
		JSON.stringify({
			id: EVENT_ID,
			run_id: RUN_ID,
			parent_event_id: null,
			schema_version: 1,
			kind: "plan_admitted",
			occurred_at: OCCURRED_AT,
			payload: {
				PlanAdmittedV1: {
					plan_id: "pf-plan-fixture",
					plan_digest: `sha256:${"a".repeat(64)}`,
					input_digest: `sha256:${"b".repeat(64)}`,
					trusted_base: "deadbeef",
					decided_by: "operator:fixture",
					decided_at: OCCURRED_AT,
					idempotency_key: "planforge:v0:buildplane:deadbeef:fixture",
					authorized_next_step: authorizedNextStep,
				},
			},
		}),
		"utf8",
	);
}

function seedAdmission(
	options: {
		readonly signature?: string;
		readonly algorithm?: string;
		readonly publicKeyHash?: string | null;
		readonly omitSignature?: boolean;
	} = {},
): AdmissionFixture {
	const root = mkdtempSync(join(tmpdir(), "buildplane-admitted-plan-reader-"));
	tempDirs.push(root);
	const eventsDbPath = join(root, "events.db");
	const db = new DatabaseSync(eventsDbPath);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const canonicalBytes = canonicalPlanAdmittedEvent();
	const publicKeyHash = canonicalDigest(rawEd25519PublicKey(publicKey));
	const signature =
		options.signature ??
		sign(null, canonicalBytes, privateKey).toString("base64url");
	try {
		db.exec(
			"CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_event_id TEXT, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE event_signatures (event_id TEXT PRIMARY KEY, canonical_event_hash TEXT NOT NULL, actor_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key_hash TEXT, algorithm TEXT NOT NULL, signature TEXT NOT NULL, signed_at TEXT NOT NULL)",
		);
		db.prepare(
			"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			EVENT_ID,
			RUN_ID,
			null,
			1,
			"plan_admitted",
			STORED_OCCURRED_AT,
			JSON.stringify({
				PlanAdmittedV1: {
					plan_id: "pf-plan-fixture",
					plan_digest: `sha256:${"a".repeat(64)}`,
					input_digest: `sha256:${"b".repeat(64)}`,
					trusted_base: "deadbeef",
					decided_by: "operator:fixture",
					decided_at: OCCURRED_AT,
					idempotency_key: "planforge:v0:buildplane:deadbeef:fixture",
					authorized_next_step: "dispatch_admitted_plan",
				},
			}),
		);
		if (!options.omitSignature) {
			db.prepare(
				"INSERT INTO event_signatures (event_id, canonical_event_hash, actor_id, key_id, public_key_hash, algorithm, signature, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				EVENT_ID,
				canonicalDigest(canonicalBytes),
				"kernel",
				"kernel-main",
				options.publicKeyHash === undefined
					? publicKeyHash
					: options.publicKeyHash,
				options.algorithm ?? "ed25519",
				signature,
				"2026-05-30T00:00:02Z",
			);
		}
	} finally {
		db.close();
	}
	return { eventsDbPath, eventId: EVENT_ID, publicKey, publicKeyHash };
}

interface RustSignedTapeEntry {
	readonly canonical_event_b64: string;
	readonly signature: {
		readonly algorithm: string;
		readonly canonical_event_hash: string;
		readonly event_id: string;
		readonly signature: string;
		readonly signed_at: string;
		readonly signer: {
			readonly actor_id: string;
			readonly key_id: string;
			readonly public_key_hash: string;
		};
	};
}

interface RustPlanAdmittedEvent {
	readonly id: string;
	readonly run_id: string;
	readonly parent_event_id: string | null;
	readonly schema_version: number;
	readonly kind: "plan_admitted";
	readonly occurred_at: string;
	readonly payload: unknown;
}

function seedRustGeneratedAdmission(): AdmissionFixture {
	const tape = JSON.parse(readFileSync(RUST_PLAN_CYCLE_TAPE, "utf8")) as {
		readonly events: readonly RustSignedTapeEntry[];
		readonly trusted_keys: readonly {
			readonly public_key_b64: string;
			readonly public_key_hash: string;
		}[];
	};
	const planEntry = tape.events.find((entry) => {
		const event = JSON.parse(
			Buffer.from(entry.canonical_event_b64, "base64").toString("utf8"),
		) as { kind?: string };
		return event.kind === "plan_admitted";
	});
	if (!planEntry) {
		throw new Error("Rust signed-tape fixture lacks plan_admitted event");
	}
	const event = JSON.parse(
		Buffer.from(planEntry.canonical_event_b64, "base64").toString("utf8"),
	) as RustPlanAdmittedEvent;
	const trustedKey = tape.trusted_keys.find(
		(key) => key.public_key_hash === planEntry.signature.signer.public_key_hash,
	);
	if (!trustedKey) {
		throw new Error(
			"Rust signed-tape fixture lacks the plan signer public key",
		);
	}
	const publicKey = Buffer.from(trustedKey.public_key_b64, "base64");
	if (
		canonicalDigest(publicKey) !== trustedKey.public_key_hash ||
		trustedKey.public_key_hash !== planEntry.signature.signer.public_key_hash
	) {
		throw new Error(
			"Rust signed-tape fixture has an invalid public-key binding",
		);
	}

	const root = mkdtempSync(
		join(tmpdir(), "buildplane-rust-admitted-plan-reader-"),
	);
	tempDirs.push(root);
	const eventsDbPath = join(root, "events.db");
	const db = new DatabaseSync(eventsDbPath);
	try {
		db.exec(
			"CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_event_id TEXT, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE event_signatures (event_id TEXT PRIMARY KEY, canonical_event_hash TEXT NOT NULL, actor_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key_hash TEXT, algorithm TEXT NOT NULL, signature TEXT NOT NULL, signed_at TEXT NOT NULL)",
		);
		db.prepare(
			"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			event.id,
			event.run_id,
			event.parent_event_id,
			event.schema_version,
			event.kind,
			event.occurred_at.replace(/Z$/, "+00:00"),
			JSON.stringify(event.payload),
		);
		db.prepare(
			"INSERT INTO event_signatures (event_id, canonical_event_hash, actor_id, key_id, public_key_hash, algorithm, signature, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			planEntry.signature.event_id,
			planEntry.signature.canonical_event_hash,
			planEntry.signature.signer.actor_id,
			planEntry.signature.signer.key_id,
			planEntry.signature.signer.public_key_hash,
			planEntry.signature.algorithm,
			planEntry.signature.signature,
			planEntry.signature.signed_at,
		);
	} finally {
		db.close();
	}
	return {
		eventsDbPath,
		eventId: event.id,
		publicKey,
		publicKeyHash: trustedKey.public_key_hash,
	};
}

function trustedReader(fixture: AdmissionFixture) {
	return createDefaultAdmittedPlanReader({
		signatureVerifier: createPinnedEd25519AdmittedPlanSignatureVerifier({
			publicKey: fixture.publicKey,
			publicKeyHash: fixture.publicKeyHash,
		}),
	});
}

describe("default admitted-plan reader", () => {
	it("accepts the Rust-generated detached kernel Ed25519 PlanAdmitted event", async () => {
		const fixture = seedRustGeneratedAdmission();

		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, fixture.eventId),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: true,
		});
	});

	it("rejects kernel-labelled metadata with cryptographically invalid signature bytes", async () => {
		const fixture = seedAdmission({
			signature: Buffer.alloc(64, 0).toString("base64url"),
		});

		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: false,
		});
	});

	it.each([
		"missing",
		"malformed",
	])("fails closed for a %s detached signature row", async (label) => {
		const fixture =
			label === "missing"
				? seedAdmission({ omitSignature: true })
				: seedAdmission({ signature: "not-a-valid-ed25519-signature" });
		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: false,
		});
	});

	it("rejects an admission whose stored event content no longer matches the signed canonical hash", async () => {
		const fixture = seedAdmission();
		const db = new DatabaseSync(fixture.eventsDbPath);
		try {
			db.prepare("UPDATE events SET payload = ? WHERE id = ?").run(
				JSON.stringify({
					PlanAdmittedV1: {
						plan_id: "pf-plan-fixture",
						plan_digest: `sha256:${"a".repeat(64)}`,
						input_digest: `sha256:${"b".repeat(64)}`,
						trusted_base: "deadbeef",
						decided_by: "operator:fixture",
						decided_at: OCCURRED_AT,
						idempotency_key: "planforge:v0:buildplane:deadbeef:fixture",
						authorized_next_step: "different_step",
					},
				}),
				EVENT_ID,
			);
		} finally {
			db.close();
		}

		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "different_step",
			signedByKernel: false,
		});
	});

	it("rejects an unsupported signature algorithm before it can become admission authority", async () => {
		const fixture = seedAdmission({ algorithm: "rsa-sha256" });

		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: false,
		});
	});

	it("fails closed without an explicit pinned verifier even for a valid signature row", async () => {
		const fixture = seedAdmission();

		await expect(
			createDefaultAdmittedPlanReader().read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: false,
		});
	});

	it("fails closed when a signature row omits the public-key hash required by the pinned trust registry", async () => {
		const fixture = seedAdmission({ publicKeyHash: null });

		await expect(
			trustedReader(fixture).read(fixture.eventsDbPath, EVENT_ID),
		).resolves.toEqual({
			authorizedNextStep: "dispatch_admitted_plan",
			signedByKernel: false,
		});
	});

	it("rejects structural, accessor-backed, and prototype-backed verifier inputs", () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const publicKeyHash = canonicalDigest(rawEd25519PublicKey(publicKey));
		const accessorBackedInput: Record<string, unknown> = {
			publicKeyHash,
		};
		Object.defineProperty(accessorBackedInput, "publicKey", {
			enumerable: true,
			get: () => publicKey,
		});
		expect(() =>
			createPinnedEd25519AdmittedPlanSignatureVerifier(
				accessorBackedInput as never,
			),
		).toThrow(/closed data-only/i);

		const lookalike = {
			kind: "pinned-admitted-plan-signature-verifier-v1" as const,
			verify: () => true,
		};
		expect(() =>
			createDefaultAdmittedPlanReader({ signatureVerifier: lookalike }),
		).toThrow(/explicitly pinned/i);
		expect(() =>
			createDefaultAdmittedPlanReader(
				Object.create({ signatureVerifier: lookalike }) as never,
			),
		).toThrow(/closed data-only/i);
	});
});
