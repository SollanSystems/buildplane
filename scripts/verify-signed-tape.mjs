#!/usr/bin/env node
// External verifier for a Buildplane signed tape (format buildplane.signed-tape.v1).
//
// Dependency-free: uses only node:crypto / node:fs / node:path. It hashes the
// STORED canonical bytes carried in the fixture (it never re-serializes an
// event), so it verifies real Rust-produced tapes regardless of any JS<->Rust
// JSON formatting differences.
//
// Usage:
//   node scripts/verify-signed-tape.mjs --fixture <dir> [--json]
// Reads <dir>/tape.json. Exit 0 iff every event is `verified` AND every
// tape_checkpoint's tape_root_hash recomputes. Exit 1 on any failure, 2 on
// usage/IO error.

import {
	createHash,
	createPublicKey,
	verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
	let fixture = null;
	let jsonOut = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--fixture") fixture = argv[++i];
		else if (argv[i] === "--json") jsonOut = true;
	}
	return { fixture, jsonOut };
}

function sha256Hex(buf) {
	return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function ed25519PublicKeyFromRaw(raw32) {
	return createPublicKey({
		key: {
			kty: "OKP",
			crv: "Ed25519",
			x: Buffer.from(raw32).toString("base64url"),
		},
		format: "jwk",
	});
}

// verified | unsigned | missing_key | hash_mismatch | bad_signature | unsupported_algorithm
function verifyEvent(canonicalBytes, parsed, signature, trustedKeys) {
	if (!signature) return "unsigned";
	if (signature.algorithm !== "ed25519") return "unsupported_algorithm";

	if (signature.event_id !== parsed.id) return "hash_mismatch";
	if (sha256Hex(canonicalBytes) !== signature.canonical_event_hash)
		return "hash_mismatch";

	const claimedHash = signature.signer?.public_key_hash;
	const keyBytes = claimedHash ? trustedKeys.get(claimedHash) : undefined;
	if (!keyBytes) return "missing_key";

	let sigBytes;
	try {
		sigBytes = Buffer.from(signature.signature, "base64url");
	} catch {
		return "bad_signature";
	}
	if (sigBytes.length !== 64) return "bad_signature";

	try {
		const ok = cryptoVerify(
			null,
			canonicalBytes,
			ed25519PublicKeyFromRaw(keyBytes),
			sigBytes,
		);
		return ok ? "verified" : "bad_signature";
	} catch {
		return "bad_signature";
	}
}

function loadTrustedKeys(tape) {
	// Bind each trusted key to its claimed hash (mirror the Rust verifier): a key
	// whose bytes don't hash to the claimed public_key_hash is dropped, so a
	// poisoned registry yields `missing_key` rather than a false `verified`.
	const map = new Map();
	for (const k of tape.trusted_keys ?? []) {
		const raw = Buffer.from(k.public_key_b64, "base64");
		if (raw.length === 32 && sha256Hex(raw) === k.public_key_hash) {
			map.set(k.public_key_hash, raw);
		}
	}
	return map;
}

function decodeEvent(entry) {
	const bytes = Buffer.from(entry.canonical_event_b64, "base64");
	return { bytes, parsed: JSON.parse(bytes.toString("utf8")) };
}

function run(fixtureDir) {
	const tape = JSON.parse(readFileSync(join(fixtureDir, "tape.json"), "utf8"));
	if (tape.format !== "buildplane.signed-tape.v1") {
		throw new Error(`unexpected tape format: ${tape.format}`);
	}
	const trustedKeys = loadTrustedKeys(tape);

	const eventResults = [];
	const signedCovered = [];
	const checkpoints = [];

	for (const entry of tape.events) {
		const { bytes, parsed } = decodeEvent(entry);
		const status = verifyEvent(bytes, parsed, entry.signature, trustedKeys);
		eventResults.push({ id: parsed.id, kind: parsed.kind, status });

		if (parsed.kind === "tape_checkpoint") {
			checkpoints.push({
				eventId: parsed.id,
				payload: parsed.payload.TapeCheckpointV1,
			});
		} else if (status === "verified") {
			signedCovered.push({
				id: parsed.id,
				hash: entry.signature.canonical_event_hash,
			});
		}
	}

	signedCovered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const checkpointResults = [];
	for (const cp of checkpoints) {
		const covered = signedCovered.filter(
			(e) => e.id <= cp.payload.through_event_id,
		);
		const recomputed = sha256Hex(
			Buffer.from(covered.map((e) => e.hash).join("\n"), "utf8"),
		);
		const rootOk = recomputed === cp.payload.tape_root_hash;
		const countOk = Number(cp.payload.through_event_count) === covered.length;
		checkpointResults.push({
			eventId: cp.eventId,
			status: rootOk && countOk ? "root_ok" : "root_mismatch",
			expectedRoot: cp.payload.tape_root_hash,
			actualRoot: recomputed,
			expectedCount: Number(cp.payload.through_event_count),
			actualCount: covered.length,
		});
	}

	const allEventsVerified = eventResults.every((e) => e.status === "verified");
	const allRootsOk = checkpointResults.every((c) => c.status === "root_ok");
	return {
		ok: allEventsVerified && allRootsOk,
		events: eventResults,
		checkpoints: checkpointResults,
	};
}

function main() {
	const { fixture, jsonOut } = parseArgs(process.argv.slice(2));
	if (!fixture) {
		console.error(
			"usage: node scripts/verify-signed-tape.mjs --fixture <dir> [--json]",
		);
		process.exit(2);
	}
	let report;
	try {
		report = run(fixture);
	} catch (err) {
		console.error(`verify-signed-tape: ${err.message}`);
		process.exit(2);
	}

	if (jsonOut) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		for (const e of report.events) {
			console.log(`event ${e.id} [${e.kind}] -> ${e.status}`);
		}
		for (const c of report.checkpoints) {
			console.log(
				`checkpoint ${c.eventId} -> ${c.status}` +
					(c.status === "root_ok"
						? ""
						: ` (expected ${c.expectedRoot} got ${c.actualRoot})`),
			);
		}
		console.log(
			report.ok
				? "OK: signed tape verified"
				: "FAIL: signed tape did not verify",
		);
	}
	process.exit(report.ok ? 0 : 1);
}

main();
