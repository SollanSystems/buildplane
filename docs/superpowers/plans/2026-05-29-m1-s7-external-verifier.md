# M1-S7 — External Verifier Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dependency-free, operator-runnable external verifier that proves a Buildplane signed tape is authentic — every event signature valid, every tape-root checkpoint reproducible — and fails loudly on tampered payloads, bad signatures, missing keys, and bad checkpoint roots.

**Architecture:** A deterministic Rust generator (`bp-ledger-gen-signed-tape`) emits real signed-tape fixtures (valid + deliberately-broken variants) to `test/fixtures/signed-tape/`. A standalone Node script (`scripts/verify-signed-tape.mjs`) re-derives each event's `sha256` over the **stored canonical bytes** (never re-serializing — so it is immune to JS↔Rust JSON drift), verifies the detached Ed25519 signature with `node:crypto` (no third-party deps), and recomputes each `TapeCheckpointV1.tape_root_hash`. Vitest workflow tests exercise the pass path and all four failure modes; `docs/ledger.md` documents the operator command.

**Tech Stack:** Rust (`bp-ledger` crate: `ed25519-dalek`, `sha2`, `serde_json`, `base64`), Node 24.13.1 built-ins (`node:crypto` Ed25519 via JWK import, `node:fs`, `node:path`), Vitest, pnpm workspace.

---

## Context the implementer must hold

This is an **L0 trust-surface slice.** It writes no production runtime code — it adds a *checker* and the fixtures it checks. The cryptographic contracts it must mirror are already shipped and frozen; read these first and do not re-derive them:

- **Canonical event hash** (`native/crates/bp-ledger/src/canonicalize.rs:30`): `canonical_event_hash(event) = "sha256:" + hex(sha256(serde_json::to_vec(&event)))`. The hashed bytes are the compact JSON of the `Event` envelope (field order `id, run_id, parent_event_id, schema_version, kind, occurred_at, payload`; `parent_event_id` is `null` when absent; `kind` is the snake_case wire string; `payload` is externally tagged, e.g. `{"RunCompletedV1":{…}}`).
- **Detached signature** (`native/crates/bp-ledger/src/signing.rs`): `EventSignatureV1 { event_id, canonical_event_hash, signer{actor_id,key_id,public_key_hash}, algorithm:"ed25519", signature, signed_at }`. The 64-byte Ed25519 signature is over the **same canonical bytes** that are hashed, encoded **base64url-no-pad**. `signer.public_key_hash = "sha256:" + hex(sha256(<32 raw pubkey bytes>))`.
- **Verify semantics** (`signing.rs:145` `verify_event_signature`): bind `signature.event_id == event.id`; recompute hash and compare to `signature.canonical_event_hash`; look the public key up by `public_key_hash`; **bind the looked-up key to its claimed hash** (if `sha256(keybytes) != public_key_hash`, treat as `missing_key`); decode + Ed25519-verify. Statuses: `verified | unsigned | missing_key | hash_mismatch | bad_signature | unsupported_algorithm`.
- **Tape root** (`native/crates/bp-ledger/src/payload/checkpoint.rs:82` `tape_root_hash`, and its doc-comment "Checkpoint root contract (M1-S7 load-bearing)"): `tape_root_hash = "sha256:" + hex(sha256(join("\n", H)))` where `H` is the ordered list of stored `canonical_event_hash` **strings** of the run's **signed, non-`tape_checkpoint`** events, ordered by event `id` ascending (UUIDv7 = tape order), joined by a single `\n` with **no trailing newline**. `through_event_count` = `len(H)` covered. Empty `H` hashes the empty byte string. The verifier must use the stored hash *strings*, not re-hash bytes, for the join.

**Design decision (load-bearing — do not "simplify" away):** the verifier hashes the **stored canonical bytes** carried in the fixture, and never reconstructs them from a parsed object. This is what makes it a meaningful external check of *real Rust-produced tapes* and immune to serializer drift. Fixtures therefore carry each event's exact `serde_json::to_vec` bytes (base64). Negative fixtures that need a *valid signature over wrong data* (the bad-root case) MUST be produced by the Rust generator — they cannot be hand-authored, because a real Ed25519 signature is required.

**Out of scope (record, do not silently drop):** exporting a *live* `.buildplane/ledger/events.db` into this fixture JSON format (a `buildplane ledger export-signed-tape` CLI). S7 ships the verifier + fixtures + docs per the M1 spec §M1-S7 file list; the live-DB export is the natural M1-followup and is noted in `docs/ledger.md` and the slice receipt as a known gap, not implemented here.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `native/crates/bp-ledger/src/bin/gen_signed_tape.rs` | Deterministic generator: builds a reference signed tape (fixed key/ids/timestamps), emits `valid/`, `tampered/`, `bad-root/` fixtures | Create |
| `native/crates/bp-ledger/Cargo.toml` | Register the new `[[bin]]` | Modify (`:43`, after the existing bin block) |
| `native/crates/bp-ledger/tests/signed_tape_fixture.rs` | Integration test: run the bin, assert every event in `valid/` verifies via the crate API and the checkpoint root recomputes | Create |
| `scripts/ledger/gen-fixtures.sh` | Also build+run the signed-tape generator so `pnpm ledger:gen-fixtures` regenerates all fixtures (CI freshness gate) | Modify |
| `test/fixtures/signed-tape/{valid,tampered,bad-root}/tape.json` | Generated fixtures (committed) | Create (generated) |
| `scripts/verify-signed-tape.mjs` | The external verifier (dependency-free Node) | Create |
| `test/workflow/verify-signed-tape.test.ts` | Behavior tests: valid passes; tampered/bad-signature/missing-key/bad-root fail | Create |
| `docs/ledger.md` | Operator "Verifying a signed tape" section + command | Modify |
| `test/workflow/ledger-doc-contract.test.ts` | Assert the doc documents the verify command | Modify (`:21`, add an `it`) |

**Fixture JSON format** (`buildplane.signed-tape.v1`) — the contract between generator and verifier:

```json
{
  "format": "buildplane.signed-tape.v1",
  "run_id": "01919000-0000-7000-8000-0000000000ff",
  "trusted_keys": [
    { "public_key_hash": "sha256:<hex>", "public_key_b64": "<std-base64 of 32 raw pubkey bytes>" }
  ],
  "events": [
    { "canonical_event_b64": "<std-base64 of serde_json::to_vec(&event)>", "signature": { /* EventSignatureV1 */ } }
  ]
}
```

`events` are in tape order. A `tape_checkpoint`-kind event appears in the same array (its payload is `{"TapeCheckpointV1":{…}}`). The verifier derives `id`, `kind`, and `payload` by base64-decoding `canonical_event_b64` and `JSON.parse`-ing it; it hashes the raw decoded bytes for the hash/signature checks.

---

## Task 1: Rust reference signed-tape generator + self-verifying integration test

**Files:**
- Create: `native/crates/bp-ledger/src/bin/gen_signed_tape.rs`
- Modify: `native/crates/bp-ledger/Cargo.toml` (add `[[bin]]`)
- Create: `native/crates/bp-ledger/tests/signed_tape_fixture.rs`

- [ ] **Step 1: Register the bin so the test harness can resolve `CARGO_BIN_EXE_*`**

In `native/crates/bp-ledger/Cargo.toml`, immediately after the existing bin block (`:41-43`), add:

```toml
[[bin]]
name = "bp-ledger-gen-signed-tape"
path = "src/bin/gen_signed_tape.rs"
```

- [ ] **Step 2: Create a minimal compiling stub for the new bin**

Create `native/crates/bp-ledger/src/bin/gen_signed_tape.rs`:

```rust
fn main() {
    // Implemented in Step 4. Stub exists so the integration test compiles
    // (Cargo only sets CARGO_BIN_EXE_<name> when the bin target builds).
    eprintln!("gen_signed_tape: not yet implemented");
    std::process::exit(2);
}
```

- [ ] **Step 3: Write the failing integration test**

Create `native/crates/bp-ledger/tests/signed_tape_fixture.rs`:

```rust
//! M1-S7: the generated `valid/` fixture must be a real signed tape — every
//! event verifies against the crate's own verifier and the checkpoint's
//! tape_root_hash recomputes from the covered events' stored hash strings.

use bp_ledger::event::Event;
use bp_ledger::payload::checkpoint::tape_root_hash;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{
    verify_event_signature, ActorKeyRef, EventSignatureV1, TrustedPublicKeys, VerificationStatus,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use std::process::Command;

fn run_generator(out_dir: &std::path::Path) {
    let bin = env!("CARGO_BIN_EXE_bp-ledger-gen-signed-tape");
    let status = Command::new(bin)
        .arg(out_dir)
        .status()
        .expect("generator runs");
    assert!(status.success(), "generator exited non-zero");
}

fn load_tape(path: &std::path::Path) -> Value {
    let bytes = std::fs::read(path).expect("read tape.json");
    serde_json::from_slice(&bytes).expect("tape.json parses")
}

#[test]
fn valid_fixture_is_a_real_signed_tape() {
    let tmp = tempfile::tempdir().unwrap();
    run_generator(tmp.path());
    let tape = load_tape(&tmp.path().join("valid").join("tape.json"));

    assert_eq!(tape["format"], "buildplane.signed-tape.v1");

    // Build the trusted-key registry from the fixture, binding each key to its hash.
    let mut keys = TrustedPublicKeys::default();
    for k in tape["trusted_keys"].as_array().unwrap() {
        let hash = k["public_key_hash"].as_str().unwrap().to_string();
        let raw = STANDARD.decode(k["public_key_b64"].as_str().unwrap()).unwrap();
        keys.insert_public_key(hash, raw);
    }

    let events = tape["events"].as_array().unwrap();
    let mut covered_hashes: Vec<(String, String)> = Vec::new(); // (event_id, canonical_event_hash)
    let mut checkpoints: Vec<(Event, EventSignatureV1)> = Vec::new();

    for entry in events {
        let bytes = STANDARD.decode(entry["canonical_event_b64"].as_str().unwrap()).unwrap();
        let event: Event = serde_json::from_slice(&bytes).expect("event deserializes");
        let sig: EventSignatureV1 =
            serde_json::from_value(entry["signature"].clone()).expect("signature deserializes");

        // Every event must verify.
        assert_eq!(
            verify_event_signature(&event, &sig, &keys),
            VerificationStatus::Verified,
            "event {} should verify",
            event.id
        );

        if matches!(event.payload, Payload::TapeCheckpointV1(_)) {
            checkpoints.push((event, sig));
        } else {
            covered_hashes.push((event.id.to_string(), sig.canonical_event_hash.clone()));
        }
    }

    // There must be at least one checkpoint, and its stored root must recompute.
    assert!(!checkpoints.is_empty(), "fixture must contain a checkpoint");
    covered_hashes.sort_by(|a, b| a.0.cmp(&b.0));
    let ordered: Vec<String> = covered_hashes.iter().map(|(_, h)| h.clone()).collect();
    let recomputed = tape_root_hash(&ordered);

    for (event, _) in &checkpoints {
        if let Payload::TapeCheckpointV1(cp) = &event.payload {
            assert_eq!(cp.tape_root_hash, recomputed, "checkpoint root recomputes");
            assert_eq!(cp.through_event_count as usize, ordered.len());
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger --test signed_tape_fixture`
Expected: FAIL — the stub generator exits 2, so `run_generator` panics on the assertion.

- [ ] **Step 5: Implement the generator**

Replace `native/crates/bp-ledger/src/bin/gen_signed_tape.rs` with:

```rust
//! M1-S7: emit deterministic signed-tape fixtures consumed by the external
//! verifier (`scripts/verify-signed-tape.mjs`). Deterministic by construction:
//! fixed signing key, fixed UUIDv7 event ids (ascending = tape order), fixed
//! timestamps. No EventId::new()/Utc::now(). Emits three variants:
//!   valid/      — every signature valid, checkpoint root correct
//!   tampered/   — one event's payload mutated AFTER signing (hash_mismatch)
//!   bad-root/   — checkpoint validly signed over a deliberately wrong root
//!
//! Usage: bp-ledger-gen-signed-tape <out-dir>
//! Writes <out-dir>/{valid,tampered,bad-root}/tape.json.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::{UnitOutcome, UnitStartedV1};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, sign_event, ActorKeyRef, EventSignatureV1};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn fixed_event_id(n: u8) -> EventId {
    EventId::from_uuid(uuid::Uuid::parse_str(&format!("01919000-0000-7000-8000-{:012}", n)).unwrap())
}
fn fixed_run_id() -> RunId {
    RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap())
}
fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

/// Build the three covered (non-checkpoint) events in tape order.
fn covered_events() -> Vec<Event> {
    let run_id = fixed_run_id();
    vec![
        Event {
            id: fixed_event_id(1),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: at("2026-05-29T00:00:00Z"),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        },
        Event {
            id: fixed_event_id(2),
            run_id,
            parent_event_id: Some(fixed_event_id(1)),
            schema_version: 1,
            kind: EventKind::UnitStarted,
            occurred_at: at("2026-05-29T00:00:01Z"),
            payload: Payload::UnitStartedV1(UnitStartedV1 {
                unit_id: "u-1".into(),
                parent_unit_id: None,
                unit_kind: "command".into(),
                policy: json!({}),
            }),
        },
        Event {
            id: fixed_event_id(3),
            run_id,
            parent_event_id: Some(fixed_event_id(2)),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: at("2026-05-29T00:00:02Z"),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 2,
                event_count: 3,
                unit_count: 1,
            }),
        },
    ]
}

fn checkpoint_event(tape_root: String) -> Event {
    Event {
        id: fixed_event_id(10),
        run_id: fixed_run_id(),
        parent_event_id: Some(fixed_event_id(3)),
        schema_version: 1,
        kind: EventKind::TapeCheckpoint,
        occurred_at: at("2026-05-29T00:00:03Z"),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(3),
            through_event_count: 3,
            previous_checkpoint_event_id: None,
            tape_root_hash: tape_root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}

fn signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

/// Serialize one (event, signature) into a fixture entry.
fn entry(event: &Event, sig: &EventSignatureV1) -> Value {
    let bytes = serde_json::to_vec(event).unwrap();
    json!({
        "canonical_event_b64": STANDARD.encode(&bytes),
        "signature": serde_json::to_value(sig).unwrap(),
    })
}

/// Same as `entry`, but emit DIFFERENT canonical bytes than what was signed
/// (post-signing payload tamper) — keeps the original signature.
fn tampered_entry(event: &Event, sig: &EventSignatureV1) -> Value {
    let mut tampered = event.clone();
    if let Payload::UnitStartedV1(u) = &mut tampered.payload {
        u.unit_id = "u-TAMPERED".into();
    }
    let bytes = serde_json::to_vec(&tampered).unwrap();
    json!({
        "canonical_event_b64": STANDARD.encode(&bytes),
        "signature": serde_json::to_value(sig).unwrap(),
    })
}

fn write_tape(out_dir: &Path, variant: &str, key: &SigningKey, entries: Vec<Value>) {
    let trusted = json!([{
        "public_key_hash": public_key_hash(&key.verifying_key()),
        "public_key_b64": STANDARD.encode(key.verifying_key().to_bytes()),
    }]);
    let tape = json!({
        "format": "buildplane.signed-tape.v1",
        "run_id": fixed_run_id().to_string(),
        "trusted_keys": trusted,
        "events": entries,
    });
    let dir = out_dir.join(variant);
    std::fs::create_dir_all(&dir).unwrap();
    let mut content = serde_json::to_string_pretty(&tape).unwrap();
    content.push('\n');
    std::fs::write(dir.join("tape.json"), content).unwrap();
}

fn main() {
    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("test/fixtures/signed-tape"));

    let key = SigningKey::from_bytes(&[7u8; 32]);
    let signed_at = at("2026-05-29T00:00:05Z");

    let covered = covered_events();
    let covered_sigs: Vec<EventSignatureV1> = covered
        .iter()
        .map(|e| sign_event(e, &key, &signer(), signed_at).unwrap())
        .collect();

    // Correct root over the covered events' canonical hash strings, id-ascending
    // (covered_events() is already id-ascending).
    let ordered: Vec<String> = covered_sigs.iter().map(|s| s.canonical_event_hash.clone()).collect();
    let correct_root = tape_root_hash(&ordered);

    // --- valid ---
    {
        let cp = checkpoint_event(correct_root.clone());
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = covered.iter().zip(&covered_sigs).map(|(e, s)| entry(e, s)).collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "valid", &key, entries);
    }

    // --- tampered: event #2 payload changed AFTER signing (hash_mismatch) ---
    {
        let cp = checkpoint_event(correct_root.clone());
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = Vec::new();
        entries.push(entry(&covered[0], &covered_sigs[0]));
        entries.push(tampered_entry(&covered[1], &covered_sigs[1]));
        entries.push(entry(&covered[2], &covered_sigs[2]));
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "tampered", &key, entries);
    }

    // --- bad-root: checkpoint validly signed over a WRONG root ---
    {
        let wrong_root = format!("sha256:{}", "0".repeat(64));
        let cp = checkpoint_event(wrong_root);
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = covered.iter().zip(&covered_sigs).map(|(e, s)| entry(e, s)).collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "bad-root", &key, entries);
    }

    eprintln!("wrote signed-tape fixtures to {}", out_dir.display());
}
```

> If a referenced payload field name (e.g. `UnitStartedV1.parent_unit_id`, `RunStartedV1.config`) does not match the current struct, read the struct in `native/crates/bp-ledger/src/payload/` and use the real field — the generator must compile against the live types. The field set above mirrors `src/bin/gen_fixtures.rs:43-154`.

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger --test signed_tape_fixture`
Expected: PASS — every event verifies and the checkpoint root recomputes.

- [ ] **Step 7: Commit**

```bash
git add native/crates/bp-ledger/Cargo.toml native/crates/bp-ledger/src/bin/gen_signed_tape.rs native/crates/bp-ledger/tests/signed_tape_fixture.rs
git commit -m "feat(ledger): M1-S7 reference signed-tape fixture generator"
```

---

## Task 2: Wire the generator into `ledger:gen-fixtures` and commit generated fixtures

**Files:**
- Modify: `scripts/ledger/gen-fixtures.sh`
- Create (generated): `test/fixtures/signed-tape/{valid,tampered,bad-root}/tape.json`

- [ ] **Step 1: Extend the fixtures script**

Replace `scripts/ledger/gen-fixtures.sh` with (adds the second generator; keeps the existing payload-variants generation byte-for-byte):

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/native/target/debug/bp-ledger-gen-fixtures"
OUT="$ROOT/packages/ledger-client/fixtures/payload-variants.json"

if [[ ! -x "$BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-fixtures --quiet
fi
"$BIN" "$OUT"
# Normalise indentation to match Biome project style (tabs).
"$ROOT/node_modules/.bin/biome" format --write "$OUT" 2>/dev/null || true

# M1-S7: signed-tape fixtures for the external verifier.
TAPE_BIN="$ROOT/native/target/debug/bp-ledger-gen-signed-tape"
TAPE_OUT="$ROOT/test/fixtures/signed-tape"
if [[ ! -x "$TAPE_BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-signed-tape --quiet
fi
"$TAPE_BIN" "$TAPE_OUT"
# Match Biome JSON style (tabs) so the committed fixtures pass `biome check`.
"$ROOT/node_modules/.bin/biome" format --write "$TAPE_OUT" 2>/dev/null || true
```

- [ ] **Step 2: Generate the fixtures**

Run: `pnpm ledger:gen-fixtures`
Expected: writes `test/fixtures/signed-tape/{valid,tampered,bad-root}/tape.json` (and regenerates `payload-variants.json` unchanged).

- [ ] **Step 3: Verify idempotency (the CI freshness gate)**

Run: `pnpm ledger:gen-fixtures && git status --porcelain test/fixtures/signed-tape packages/ledger-client/fixtures`
Expected: after the first commit (next step), a second run produces **no diff**. For now, confirm only the three new `tape.json` files are listed as additions and `payload-variants.json` is unchanged.

- [ ] **Step 4: Sanity-check a fixture shape**

Run: `node -e "const t=require('./test/fixtures/signed-tape/valid/tape.json'); console.log(t.format, t.events.length, t.trusted_keys.length)"`
Expected: `buildplane.signed-tape.v1 4 1`

- [ ] **Step 5: Commit**

```bash
git add scripts/ledger/gen-fixtures.sh test/fixtures/signed-tape
git commit -m "feat(ledger): M1-S7 generate signed-tape fixtures via ledger:gen-fixtures"
```

---

## Task 3: The external verifier script

**Files:**
- Create: `scripts/verify-signed-tape.mjs`

- [ ] **Step 1: Write the verifier**

Create `scripts/verify-signed-tape.mjs`:

```js
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

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
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
		key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw32).toString("base64url") },
		format: "jwk",
	});
}

// Returns one of: verified | unsigned | missing_key | hash_mismatch | bad_signature | unsupported_algorithm
function verifyEvent(canonicalBytes, parsed, signature, trustedKeys) {
	if (!signature) return "unsigned";
	if (signature.algorithm !== "ed25519") return "unsupported_algorithm";

	if (signature.event_id !== parsed.id) return "hash_mismatch";
	if (sha256Hex(canonicalBytes) !== signature.canonical_event_hash) return "hash_mismatch";

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
		const ok = cryptoVerify(null, canonicalBytes, ed25519PublicKeyFromRaw(keyBytes), sigBytes);
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
	const signedCovered = []; // { id, hash } for verified, non-checkpoint events
	const checkpoints = []; // { eventId, payload }

	for (const entry of tape.events) {
		const { bytes, parsed } = decodeEvent(entry);
		const status = verifyEvent(bytes, parsed, entry.signature, trustedKeys);
		eventResults.push({ id: parsed.id, kind: parsed.kind, status });

		if (parsed.kind === "tape_checkpoint") {
			checkpoints.push({ eventId: parsed.id, payload: parsed.payload.TapeCheckpointV1 });
		} else if (status === "verified") {
			signedCovered.push({ id: parsed.id, hash: entry.signature.canonical_event_hash });
		}
	}

	signedCovered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const checkpointResults = [];
	for (const cp of checkpoints) {
		const covered = signedCovered.filter((e) => e.id <= cp.payload.through_event_id);
		const recomputed = sha256Hex(Buffer.from(covered.map((e) => e.hash).join("\n"), "utf8"));
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
	return { ok: allEventsVerified && allRootsOk, events: eventResults, checkpoints: checkpointResults };
}

function main() {
	const { fixture, jsonOut } = parseArgs(process.argv.slice(2));
	if (!fixture) {
		console.error("usage: node scripts/verify-signed-tape.mjs --fixture <dir> [--json]");
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
					(c.status === "root_ok" ? "" : ` (expected ${c.expectedRoot} got ${c.actualRoot})`),
			);
		}
		console.log(report.ok ? "OK: signed tape verified" : "FAIL: signed tape did not verify");
	}
	process.exit(report.ok ? 0 : 1);
}

main();
```

- [ ] **Step 2: Smoke-run against the valid fixture**

Run: `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/valid`
Expected: four `-> verified` / `-> root_ok` lines then `OK: signed tape verified`; `echo $?` → `0`.

- [ ] **Step 3: Smoke-run against the broken fixtures**

Run:
```bash
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/tampered; echo "exit=$?"
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/bad-root; echo "exit=$?"
```
Expected: tampered → a `hash_mismatch` event line, `FAIL`, `exit=1`. bad-root → all events verified but a `root_mismatch` checkpoint line, `FAIL`, `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-signed-tape.mjs
git commit -m "feat(ledger): M1-S7 external signed-tape verifier script"
```

---

## Task 4: Vitest behavior tests (pass path + four failure modes)

**Files:**
- Create: `test/workflow/verify-signed-tape.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workflow/verify-signed-tape.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "verify-signed-tape.mjs");
const VALID = join(ROOT, "test", "fixtures", "signed-tape", "valid");

interface ExecResult {
	status: number;
	stdout: string;
}

function runVerifier(fixtureDir: string): ExecResult {
	try {
		const stdout = execFileSync("node", [SCRIPT, "--fixture", fixtureDir], {
			encoding: "utf8",
		});
		return { status: 0, stdout };
	} catch (err) {
		const e = err as { status?: number; stdout?: Buffer | string };
		return {
			status: typeof e.status === "number" ? e.status : 1,
			stdout: e.stdout ? e.stdout.toString() : "",
		};
	}
}

// biome-ignore lint/suspicious/noExplicitAny: tape fixture is structural JSON
function loadValidTape(): any {
	return JSON.parse(readFileSync(join(VALID, "tape.json"), "utf8"));
}

// biome-ignore lint/suspicious/noExplicitAny: see above
function writeTempFixture(tape: any): string {
	const dir = mkdtempSync(join(tmpdir(), "signed-tape-"));
	writeFileSync(join(dir, "tape.json"), JSON.stringify(tape));
	return dir;
}

describe("verify-signed-tape", () => {
	it("verifies a valid signed tape (exit 0)", () => {
		const result = runVerifier(VALID);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK: signed tape verified");
	});

	it("rejects a tampered event payload (exit 1, hash_mismatch)", () => {
		const result = runVerifier(
			join(ROOT, "test", "fixtures", "signed-tape", "tampered"),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("hash_mismatch");
	});

	it("rejects a checkpoint with a bad tape root (exit 1, root_mismatch)", () => {
		const result = runVerifier(
			join(ROOT, "test", "fixtures", "signed-tape", "bad-root"),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("root_mismatch");
	});

	it("rejects a bad signature (exit 1, bad_signature)", () => {
		const tape = loadValidTape();
		// Flip the first character class of the first non-checkpoint signature,
		// keeping it base64url-decodable to 64 bytes so it fails crypto, not decode.
		const sig: string = tape.events[0].signature.signature;
		tape.events[0].signature.signature = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
		const result = runVerifier(writeTempFixture(tape));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("bad_signature");
	});

	it("rejects a tape with no trusted key (exit 1, missing_key)", () => {
		const tape = loadValidTape();
		tape.trusted_keys = [];
		const result = runVerifier(writeTempFixture(tape));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("missing_key");
	});
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run test/workflow/verify-signed-tape.test.ts`
Expected: PASS (5/5). If `bad_signature` flips into `hash_mismatch` or decode error, adjust the corruption to keep 64-byte base64url validity — the goal is a well-formed-but-wrong signature.

- [ ] **Step 3: Commit**

```bash
git add test/workflow/verify-signed-tape.test.ts
git commit -m "test(ledger): M1-S7 verifier behavior — valid + four failure modes"
```

---

## Task 5: Operator documentation + doc contract

**Files:**
- Modify: `docs/ledger.md` (append a section)
- Modify: `test/workflow/ledger-doc-contract.test.ts` (add an `it`)

- [ ] **Step 1: Add the failing doc-contract assertion**

In `test/workflow/ledger-doc-contract.test.ts`, add this `it` inside the existing `describe` block (after `:21`):

```ts
	it("documents the external signed-tape verifier command", () => {
		expect(ledgerDoc).toContain("Verifying a signed tape");
		expect(ledgerDoc).toContain(
			"node scripts/verify-signed-tape.mjs --fixture <dir>",
		);
	});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/workflow/ledger-doc-contract.test.ts`
Expected: FAIL — `docs/ledger.md` does not yet contain those strings.

- [ ] **Step 3: Append the operator section to `docs/ledger.md`**

Append to the end of `docs/ledger.md`:

```markdown
## Verifying a signed tape

Every event on the tape is recorded with a detached Ed25519 signature, and
periodic `tape_checkpoint` events pin a `tape_root_hash` over the run's signed
events. An operator can verify a tape's authenticity independently of the
kernel with a dependency-free Node script:

```bash
node scripts/verify-signed-tape.mjs --fixture <dir>
```

`<dir>` contains a `tape.json` in the `buildplane.signed-tape.v1` export format
(a list of events with their exact canonical bytes, each event's detached
signature, and the trusted public keys). The verifier:

- recomputes each event's `sha256` over its **stored canonical bytes** and
  checks it against the signature's `canonical_event_hash`;
- verifies the detached Ed25519 signature against the trusted public key,
  binding the key to its claimed `public_key_hash`;
- recomputes each `tape_checkpoint`'s `tape_root_hash` from the covered events'
  canonical hash strings and compares it to the stored root.

It exits `0` only if every event is `verified` and every checkpoint root
recomputes; otherwise it prints the failing event/checkpoint and exits `1`.
Add `--json` for a machine-readable report.

Reference fixtures live under `test/fixtures/signed-tape/` and are regenerated
by `pnpm ledger:gen-fixtures`: `valid/` verifies; `tampered/` (mutated payload),
`bad-root/` (checkpoint signed over a wrong root) are expected to fail.

> Not yet implemented: exporting a live `.buildplane/ledger/events.db` into the
> `buildplane.signed-tape.v1` format (`buildplane ledger export-signed-tape`).
> Until that lands, the verifier runs against exported/fixture tapes only.
```
````

(Note: the surrounding fenced block above is illustrative — when editing the real file, paste the section starting at `## Verifying a signed tape` and ending before this note; the inner ```bash fence stays intact.)

- [ ] **Step 4: Run the doc-contract test to verify it passes**

Run: `pnpm exec vitest run test/workflow/ledger-doc-contract.test.ts`
Expected: PASS (both the original replay assertion and the new verifier assertion).

- [ ] **Step 5: Commit**

```bash
git add docs/ledger.md test/workflow/ledger-doc-contract.test.ts
git commit -m "docs(ledger): M1-S7 document the external signed-tape verifier"
```

---

## Task 6: Full M1 gate + slice receipt

**Files:**
- Create: `docs/operations/2026-05-29-m1-s7-external-verifier-receipt.md`

- [ ] **Step 1: Run the M1-S7 targeted verification (per M1 spec §M1-S7)**

```bash
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/valid
node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/tampered && exit 1 || true
pnpm exec vitest run test/workflow/verify-signed-tape.test.ts test/workflow/ledger-doc-contract.test.ts
```
Expected: valid exits 0; tampered exits 1 (so the `&& exit 1 || true` short-circuits to true); both vitest files PASS.

- [ ] **Step 2: Run the full M1 gate (per M1 spec §"Full M1 gate")**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen-fixtures
git diff --exit-code   # fixtures must be byte-stable on regeneration
```
Expected: all green; the final `git diff --exit-code` shows **no changes** (idempotent fixtures). Record each exit code in the receipt. A partial run that omits `cargo test` is `BLOCKED_INSUFFICIENT_EVIDENCE`.

> **Changeset:** none required. S7 changes only a repo-root script, Rust crate-internal fixtures/tests, repo `test/`/`docs/`, and `scripts/` — no published `packages/*` or `apps/*` surface changes. (Operating-model gate §6.1: changeset required only if package-visible.) Do not add a `.changeset/*.md`.

- [ ] **Step 3: Write the slice receipt**

Create `docs/operations/2026-05-29-m1-s7-external-verifier-receipt.md` using `docs/operations/slice-receipt-template.md`. Fill: slice id `M1-S7`; the verification commands above with their exit codes; files changed; the "no changeset" rationale; the recorded out-of-scope follow-up (live-DB `export-signed-tape`); and the review/side-effect boundaries below.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/2026-05-29-m1-s7-external-verifier-receipt.md
git commit -m "docs(ops): M1-S7 slice receipt"
```

---

## Review & side-effect boundaries (M1 — L0 trust surface)

- **Independent Reviewer (Opus, fresh session)** verdict `PASS` required — different context than the implementer.
- **Adversarial Reviewer (Codex)** required — S7 adds verification semantics over signatures, keys, and checkpoint roots. Codex targets: (a) does the verifier hash stored bytes vs. re-serialize (drift immunity)? (b) is the key→claimed-hash binding enforced (no false `verified` from a poisoned registry)? (c) does `bad-root` keep all event signatures valid while only the root fails? (d) are all four failure modes genuinely exercised, not collapsed into one? (e) is the `<=` tape-order filter / `\n`-join (no trailing newline) faithful to `checkpoint.rs`?
- **No** push, PR open, merge, branch-protection/label edits, or `.github/`/release-plumbing changes from inside this slice — operator clicks merge.
- **Not auto-merge eligible** (L0 trust surface). Do not apply `buildplane:auto-merge`.
- Reviewed SHA must equal PR head SHA at merge.

## Self-review (completed against M1 spec §M1-S7)

- **Spec coverage:** ✅ `scripts/verify-signed-tape.mjs` (Task 3); ✅ verifier tests under `test/workflow/` (Task 4) — note the spec named `test/workflow/` or `packages/ledger-client/test/`; this plan uses `test/workflow/`; ✅ `docs/ledger.md` update + one operator command (Task 5); ✅ "succeeds on valid, fails on tampered payload / bad signature / missing key / bad checkpoint root" — all four are explicit test cases (Task 4) and the spec's two literal example commands work verbatim against `valid/` and `tampered/` (Task 6 Step 1).
- **Added beyond the spec's 3-file sketch, with rationale:** the Rust fixture generator (Task 1-2). A valid Ed25519 signature over real Rust canonical bytes cannot be hand-authored; generating fixtures from the crate is the only honest way to verify *real* tapes, and it slots into the existing `pnpm ledger:gen-fixtures` freshness gate.
- **Placeholder scan:** none — every step carries complete code or an exact command + expected output.
- **Type/Name consistency:** fixture keys (`format`, `trusted_keys`, `public_key_hash`, `public_key_b64`, `canonical_event_b64`, `signature`) are identical across the Rust generator (Task 1), the Rust test (Task 1), the JS verifier (Task 3), and the JS tests (Task 4). Status strings match `signing.rs` (`verified`/`hash_mismatch`/`missing_key`/`bad_signature`/`unsupported_algorithm`) and the checkpoint statuses (`root_ok`/`root_mismatch`) are verifier-local and used consistently.
