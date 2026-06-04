# M2-S6 — Receipt stage: signed `plan_receipt` + live-tape export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the PlanForge admission cycle's terminal stage. Two halves:

1. **Receipt (TS):** a completed `planforge dispatch` emits **one** kernel-signed `plan_receipt` per admitted plan, chaining to the `plan_admitted` event id (`admission_event_id`), recording the terminal `outcome`, real `side_effects`, and a canonical `result_digest`. The reusable receipt builder lives in `packages/planforge/src/receipt.ts`; emission rides the **already-signed** dispatch tape (S5 flipped dispatch to `sign:true`).
2. **Export (Rust):** `buildplane ledger export-signed-tape --run-id <id> --workspace <path> --out <dir>` serializes a live `.buildplane/ledger/events.db` run into the `buildplane.signed-tape.v1` format the external verifier (`scripts/verify-signed-tape.mjs`) already validates — the M1 follow-up the verifier needs to run against real tapes (`docs/ledger.md:72` "Not yet implemented").

**Architecture:** S6 adds **no new event kind / canonicalize / typeshare / fixtures** — `PlanReceiptRecordedV1` shipped complete in S2 (#163). The TS half is pure CLI + `@buildplane/planforge` integration (**the kernel orchestrator is NOT touched** — see D1). The Rust half is a new read-only `bp-cli` subcommand + a unit-testable `bp-ledger` export function that reuses the existing storage read helpers (`events_for_run`, `signature_for_event`), the exact `canonical_event_bytes()` the signer hashed, and the keyring (`load_signing_key` → `verifying_key`) to materialize `trusted_keys`. Export is read-only and has no side effects beyond writing the out-dir.

**Tech Stack:** TypeScript (`@buildplane/{planforge,ledger-client}` + `apps/cli`, vitest 4) and Rust (`bp-cli`, `bp-ledger`, cargo). The signed tape is read/exported only — no append-path or wire-shape change.

---

## Resolved design decisions

Locked before planning (the S6 equivalent of S5's D1–E4). **Do not silently change these — they are the spec of this slice.** Items marked **⚠ FLAG** are surfaced for operator sign-off at the plan-review gate (they deviate from, or under-specify in, the M2 spec).

| # | Decision | Resolution | Why |
|---|----------|-----------|-----|
| **D1 ⚠ FLAG** | Where is `plan_receipt` emitted? | **CLI dispatch path, ONCE per plan, after the packet loop** — NOT the kernel `orchestrator.ts` `finalizeRun` hook. The reusable payload builder is `packages/planforge/src/receipt.ts`; the CLI signed-emitter adapter `createLedgerReceiptPort` emits it. | `planforge dispatch` runs **one kernel run per `PlanForgeTask`** (PF1, PF2 — `run-cli.ts:3625` loops `runPacketAsync`), so `finalizeRun` fires **per-packet** — the wrong granularity for a plan-terminal receipt that chains to a *single* `plan_admitted`. The CLI already owns `admittedEventId` (`:3570`), `plan.id`, the aggregate outcome, and the signed `emitter` (`:3599`). Keeping the builder pure in `planforge` lets S7b recovery re-emit it. **This deviates from spec line 213 ("`finalizeRun` hook").** Alternative (per-packet kernel receipts via a port) rejected: a "plan receipt" is per-admission, not per-task, and would emit N receipts for one admission. |
| **D2** | Outcome mapping | `allPassed` (every task `passed`, `runs.length === packets.length`) → `completed`; any task non-`passed` / chain broke → `failed`. `aborted` is reserved for interrupt/crash recovery (S7b), not the S6 happy/fail path. Emit the receipt on **any terminal outcome**, not only success (a terminal `failed` receipt belongs on the tape). | Matches the `PlanReceiptOutcome` enum (`completed`/`failed`/`aborted`, `plan_lifecycle.rs:50`) and the dispatch's existing `allPassed` (`:3649`). |
| **D3** | What does `result_digest` bind? | The aggregate dispatch result object `{ status, plan_id, admitted_event_id, runs:[{task,run_id,status}] }` (the same shape the CLI already emits as `--json`, `:3653`), digested with `@buildplane/planforge`'s canonical `digest()`. `PlanReceiptRecordedV1` has **no inline `result` field** (unlike `activity_completed`) — only `result_digest` + `side_effects` — so there is no CAS/inline-result decision to make here. | Respects the M2-S1 canonical-digest contract (`digest()` = `sha256:` of sorted-key `canonicalJson`); same helper S3/S4/S5 use. |
| **D4 ⚠ FLAG** | `side_effects` source | **Declared scopes** aggregated from the dispatched packets (deterministic, available without re-reading the tape). If the toy fixture's packets declare none, `[]` is honest (NOT a hardcoded stub like the dry-run's). | The spec wants "real `sideEffects`" (vs the dry-run's hardcoded `[]`, spec line 24). **Observed** side-effects (reconciling actual `workspace_write` tape events) is richer but belongs to **M4 acceptance gating**; declared scopes are the defensible S6 grain. _Flag: confirm declared-vs-observed is acceptable for S6._ |
| **D5** | Export `trusted_keys` source | Collect the distinct `(actor_id, key_id)` from the run's `event_signatures`; for each, `load_signing_key(KeyringRef::new(actor_id, key_id))` (`keyring.rs:99`) → `verifying_key().to_bytes()` (base64) + `public_key_hash(&verifying_key)` (`signing.rs:99`). Emit `{ public_key_hash, public_key_b64 }`. | **There is no `trusted_keys` table** — `event_signatures` stores only `public_key_hash`. Export runs on the signing machine, which has both `events.db` and the keyring. This mirrors `gen_signed_tape.rs:242` deriving trusted keys from the signing key's verifying key. |
| **D6** | Export `canonical_event_b64` source | `canonical_event_bytes(event)` (`canonicalize.rs:42`) — the **exact** function `sign_event` hashes (`signing.rs:124` `canonical_event_hash` → `canonical_event_bytes`) — base64-encoded. Guarantees `sha256(decode(canonical_event_b64)) == event_signatures.canonical_event_hash`, so the external verifier's hash check (`verify-signed-tape.mjs:54`) passes. | The verifier hashes the **stored** bytes; export must emit the same bytes that were signed, not a fresh re-serialization that might differ. |
| **D7** | Export command home | Parse in `bp-cli/src/ledger_cli.rs` (new `LedgerCommand::ExportSignedTape(ExportSignedTapeArgs { run_id, workspace, out })`, mirroring `ReplayArgs`); the serialization logic in a new **unit-testable `bp-ledger`** function (`src/tape_export.rs`, `export_signed_tape(store, run_id, keyring_root) -> Result<serde_json::Value>`). The TS CLI forwards `ledger export-signed-tape` to `buildplane-native` (mirror how `ledger replay` is forwarded). | Keeps the byte-level export logic in `bp-ledger` (testable without spawning the CLI); `bp-cli` stays a thin arg-parse + I/O shell, exactly like `run_replay`. |
| **E1** | Receipt port optional | The `plan_receipt` emit is **only** wired on the `planforge dispatch` path. The generic `buildplane run` path has no `plan_admitted` and emits **no** receipt — byte-unchanged. | Mirrors S5's optional-port skip path; a generic run has no admission to chain to. |
| **E2** | Receipt durability | Emit `plan_receipt` then `await emitter.flush()` **before** the `finally` `emitter.close()`. | The receipt is terminal; it must be durable on the tape before the subprocess closes (and before S7b can read it back). `close()` flushes anyway, but an explicit flush makes the ordering assertion clean. |

### Spec-deviation summary (for the plan-review gate)

- **D1** moves `plan_receipt` emission out of the kernel `finalizeRun` hook (spec line 213) into the CLI dispatch path, because dispatch is per-packet and the receipt is per-plan. Net effect: **the kernel orchestrator is not modified in S6** (lower-risk L0 change; trivially preserves the kernel dependency invariant).
- **D4** scopes `side_effects` to **declared** scopes for S6; **observed**-write reconciliation defers to M4.

## Out of scope / deferred (do NOT build in S6)

- **Kernel `finalizeRun` orchestrator changes** — per D1, the receipt is CLI-emitted. No `packages/kernel` change.
- **New event kind / canonicalize / typeshare / fixtures** — `PlanReceiptRecordedV1` shipped in S2 (Rust+TS+fixtures, `gen_signed_tape.rs` plan-cycle already emits it). S6 only *emits* (TS) and *exports* (Rust) it.
- **S7b recovery re-emit** of `plan_receipt` (executed-but-no-receipt → re-emit) and the kernel startup scan — S7b. S6 emits only on the live dispatch path; the reusable `receipt.ts` builder is the seam S7b will call.
- **Observed side-effects** (reconcile `workspace_write` tape events) — M4 acceptance gating (D4).
- **Fork-path receipts** (`executeForkRun`) — deferred with fork-path signing (S5 note).
- **Operator-key signing** — M2 signs all events with the kernel key (`actor_id="kernel"`, `key_id="kernel-main"`); operator identity is a payload field. Unchanged.
- **`bp-replay` reads of `plan_receipt`** — S7a. The `transitions.rs` no-op arm stays; emitting/exporting does not break the exhaustive match (verified — Task 5 whole-workspace `cargo test` is the regression gate).
- **Export of cross-run lineage / fork chains** — export is single-run (`--run-id`), mirroring `replay`.

## Preconditions / invariants

- `PlanReceiptRecordedV1 { plan_id, admission_event_id: EventId, outcome, side_effects: Vec<String>, result_digest, decided_at }` is **complete** in Rust (`plan_lifecycle.rs:33`) and TS (`payload.ts:15` union member). `admission_event_id` typeshares to a TS `string`; `findExistingPlanAdmitted` (`run-cli.ts:3393`) already returns it as a string. **S6 adds nothing here.**
- The `buildplane.signed-tape.v1` shape is fixed by `verify-signed-tape.mjs` + `gen_signed_tape.rs:246`: `{ format, run_id, trusted_keys:[{public_key_hash, public_key_b64}], events:[{canonical_event_b64, signature:EventSignatureV1}] }`. Export MUST match it byte-for-structure.
- Dispatch already signs the tape (S5, `run-cli.ts:3595` `sign:true`, `kernel-main`). The receipt rides the **same** signed emitter — no new signing wiring.
- `planforge` already exports canonical `digest()` (`packages/planforge/src/index.ts`); `apps/cli` already depends on `@buildplane/planforge` + `@buildplane/ledger-client` (no new `published-bootstrap` entry expected — confirm in Task 6).
- The export reuses **existing** storage API: `SqliteStore::events_for_run` (`sqlite.rs:548`), `signature_for_event` (private — may need a `pub` accessor or a new `signed_events_for_run` helper), `StoredEventRow::to_event()`, `canonical_event_bytes` (`canonicalize.rs:42`), `keyring::load_signing_key` + `signing::public_key_hash`.
- Native binary built before ledger-integration tests: `pnpm native:build` (`cargo build -p bp-cli`). Whole-workspace cargo test (NO `-p`) is the exhaustive-match regression gate.
- Slice verify (from the worktree root): `pnpm -C <worktree> exec vitest run <paths>`. **Never** `pnpm --filter buildplane test`.

---

## File structure

**Create:**
- `packages/planforge/src/receipt.ts` — `buildPlanReceiptPayload(input)` (pure: maps outcome, computes `result_digest = digest(result)`, assembles `side_effects`, stamps `decided_at`). Returns a `PlanReceiptRecordedV1`-shaped plain object (planforge stays free of `@buildplane/ledger-client`).
- `packages/planforge/test/receipt.test.ts` — unit: outcome mapping, `result_digest === digest(result)` of `sha256:` form, `admission_event_id` passthrough, `side_effects` aggregation.
- `apps/cli/src/ledger-receipt-port.ts` — `createLedgerReceiptPort(emitter)` exposing `emitPlanReceipt(payload): Promise<void>` (emit `"plan_receipt"` + `await emitter.flush()`).
- `apps/cli/test/ledger-receipt-port.test.ts` — unit vs a fake `TapeEmitter` (records emit + flush order).
- `native/crates/bp-ledger/src/tape_export.rs` — `export_signed_tape(store, run_id, keyring_root) -> Result<serde_json::Value>` (the `buildplane.signed-tape.v1` serializer over live rows) + module unit tests.
- `test/ledger-integration/planforge-receipt.test.ts` — e2e: admit → dispatch → assert signed `plan_receipt` chaining to `admittedEventId`; run `export-signed-tape`; feed the out-dir to `scripts/verify-signed-tape.mjs` → exit 0 (admit → activities → receipt verified end-to-end).

**Modify:**
- `packages/planforge/src/index.ts` — export `buildPlanReceiptPayload` + its input/output types.
- `apps/cli/src/run-cli.ts` — (a) import `createLedgerReceiptPort` + `buildPlanReceiptPayload`; (b) in `runPlanForgeDispatchCommand` (`:3554`), after the packet loop and **before** the `finally` `emitter.close()`, build the receipt (D2/D3/D4) and emit it on the signed `emitter`; (c) extend the TS `ledger` subcommand forwarder so `ledger export-signed-tape …` reaches `buildplane-native` (mirror `ledger replay`), and add it to the `ledger` usage/help text (`:682`,`:731`).
- `native/crates/bp-ledger/src/lib.rs` — `pub mod tape_export;` (+ re-export if the crate uses a prelude).
- `native/crates/bp-ledger/src/storage/sqlite.rs` — if `signature_for_event` (`:605`) must be reachable from `tape_export`, add a `pub` read helper (e.g. `pub fn signed_events_for_run(&self, run_id) -> Result<Vec<(StoredEventRow, Option<EventSignatureV1>)>>`) rather than widening the private fn unnecessarily.
- `native/crates/bp-cli/src/ledger_cli.rs` — add `LedgerCommand::ExportSignedTape(ExportSignedTapeArgs)`, `parse_export_signed_tape`, route it in `parse_ledger_command` (`:50`), `run_export_signed_tape`, and the `usage_text()` block (`:454`).
- `native/crates/bp-cli/src/main.rs` (or wherever `LedgerCommand` is dispatched to `run_*`) — wire `ExportSignedTape => run_export_signed_tape(args)`.
- `docs/ledger.md` — remove the "Not yet implemented" note (`:72`); document `export-signed-tape` (flags, output, the verifier round-trip).

---

## Task 1: `buildPlanReceiptPayload` (planforge — pure builder)

**Files:** Create `packages/planforge/src/receipt.ts`, `packages/planforge/test/receipt.test.ts`; modify `packages/planforge/src/index.ts`.

- [ ] **Step 1: Write the failing test** (`receipt.test.ts`):
  - `buildPlanReceiptPayload({ planId, admissionEventId, outcome:"completed", sideEffects:["fs.write:scope"], result:{...} })` returns `{ plan_id, admission_event_id, outcome:"completed", side_effects:["fs.write:scope"], result_digest, decided_at }`.
  - `result_digest === digest(result)` (import `digest` from `../src/digest.js`) and matches `/^sha256:/`.
  - outcome passthrough for `"failed"`/`"aborted"`; `decided_at` is a passed-in RFC3339 string (inject it — keep the builder pure/deterministic, no `new Date()` inside).
- [ ] **Step 2: Run to verify failure** — `pnpm -C <wt> exec vitest run packages/planforge/test/receipt.test.ts` → FAIL (module absent).
- [ ] **Step 3: Implement** `receipt.ts`:
```ts
import { digest } from "./digest.js";

export type PlanReceiptOutcome = "completed" | "failed" | "aborted";

export interface BuildPlanReceiptInput {
	readonly planId: string;
	readonly admissionEventId: string;
	readonly outcome: PlanReceiptOutcome;
	readonly sideEffects: readonly string[];
	/** Recorded plan result; digested into result_digest (not stored inline). */
	readonly result: unknown;
	readonly decidedAt: string; // RFC3339, injected by the caller
}

/** Shape matches the S2 `PlanReceiptRecordedV1` wire payload (snake_case). */
export interface PlanReceiptPayload {
	readonly plan_id: string;
	readonly admission_event_id: string;
	readonly outcome: PlanReceiptOutcome;
	readonly side_effects: string[];
	readonly result_digest: string;
	readonly decided_at: string;
}

export function buildPlanReceiptPayload(i: BuildPlanReceiptInput): PlanReceiptPayload {
	return {
		plan_id: i.planId,
		admission_event_id: i.admissionEventId,
		outcome: i.outcome,
		side_effects: [...i.sideEffects],
		result_digest: digest(i.result),
		decided_at: i.decidedAt,
	};
}
```
- [ ] **Step 4: Export** from `packages/planforge/src/index.ts`: `export { buildPlanReceiptPayload } from "./receipt.js"; export type { PlanReceiptOutcome, BuildPlanReceiptInput, PlanReceiptPayload } from "./receipt.js";`
- [ ] **Step 5: Typecheck + run** → PASS. **Step 6: Commit** — `git commit -m "feat(planforge): add buildPlanReceiptPayload canonical receipt builder (M2-S6)"`

---

## Task 2: `createLedgerReceiptPort` (CLI signed-emitter adapter)

**Files:** Create `apps/cli/src/ledger-receipt-port.ts`, `apps/cli/test/ledger-receipt-port.test.ts`.

- [ ] **Step 1: Write the failing test** vs a fake `TapeEmitter` (records `emit` calls + `flush` count, mirroring `apps/cli/test/ledger-activity-port.test.ts`):
  - `emitPlanReceipt(payload)` calls `emit("plan_receipt", { PlanReceiptRecordedV1: payload })` then `await flush()` (flush called exactly once, after the emit, before the returned promise resolves).
- [ ] **Step 2: Run to verify failure** — module absent.
- [ ] **Step 3: Implement** `apps/cli/src/ledger-receipt-port.ts`:
```ts
import type { TapeEmitter } from "@buildplane/ledger-client";
import type { PlanReceiptPayload } from "@buildplane/planforge";

/**
 * CLI-layer adapter: emits the terminal signed `plan_receipt` onto a signed
 * ledger TapeEmitter and flushes so it is durable before the subprocess closes.
 */
export function createLedgerReceiptPort(emitter: TapeEmitter) {
	return {
		async emitPlanReceipt(payload: PlanReceiptPayload): Promise<void> {
			emitter.emit("plan_receipt", { PlanReceiptRecordedV1: payload });
			await emitter.flush();
		},
	};
}
```
> Confirm `"plan_receipt"` / `PlanReceiptRecordedV1` are accepted by `TapeEmitter.emit`'s payload union (S2 added them to `payload.ts`). If `emit`'s kind arg is a typed union, `"plan_receipt"` is already valid.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(cli): add createLedgerReceiptPort signed-emitter adapter (M2-S6)"`

---

## Task 3: emit `plan_receipt` on `planforge dispatch`

**Files:** `apps/cli/src/run-cli.ts` (`runPlanForgeDispatchCommand`, `:3554`).

- [ ] **Step 1** — Import `createLedgerReceiptPort` (from `./ledger-receipt-port.js`) and `buildPlanReceiptPayload` (from `@buildplane/planforge`).
- [ ] **Step 2** — In `runPlanForgeDispatchCommand`, **after** the `for (const packet …)` loop (`:3638`) and **before** the `finally` closes the emitter, compute the terminal outcome and emit the receipt:
```ts
		const allPassed =
			runs.length === packets.length && runs.every((r) => r.status === "passed");
		const receiptPort = createLedgerReceiptPort(emitter);
		await receiptPort.emitPlanReceipt(
			buildPlanReceiptPayload({
				planId: plan.id,
				admissionEventId: String(admittedEventId),
				outcome: allPassed ? "completed" : "failed",
				sideEffects: collectDeclaredSideEffects(packets), // D4: declared scopes; [] if none
				result: { status: allPassed ? "dispatched" : "failed", plan_id: plan.id, admitted_event_id: String(admittedEventId), runs },
				decidedAt: new Date().toISOString(),
			}),
		);
```
  Place this **inside the existing `try`** (so the `finally` still closes the emitter on success/throw) and after the loop. The current `const allPassed` at `:3649` is *after* the `try/finally`; move/duplicate the computation inside the `try` so the receipt sees it (then reuse it for the stdout line, or recompute — keep one source of truth).
- [ ] **Step 3 — `collectDeclaredSideEffects(packets)` (D4).** Add a small local helper that aggregates declared side-effect scopes from the dispatched packets/plan (dedup, stable order). If the `PlanForgeTask`/packet schema carries no declared side-effects, return `[]` (honest empty — verify against `dispatchAdmittedPlan`'s packet shape; **do not** hardcode a stub). _If declared scopes are unavailable on the packet, this becomes `[]` and the D4 flag's "observed-side-effects deferred" note governs._
- [ ] **Step 4** — Typecheck. Confirm the receipt emit is **inside** the `try` (durable before `finally` close) and that a dispatch failure still emits a `failed` receipt (D2). **Step 5: Commit** — `git commit -m "feat(cli): emit signed plan_receipt on completed planforge dispatch (M2-S6)"`

---

## Task 4: `export_signed_tape` (bp-ledger serializer)

**Files:** Create `native/crates/bp-ledger/src/tape_export.rs`; modify `native/crates/bp-ledger/src/lib.rs`, `native/crates/bp-ledger/src/storage/sqlite.rs` (read helper if needed).

- [ ] **Step 1: Write the failing Rust test** (`tape_export.rs` `#[cfg(test)]`): open an in-memory/temp `SqliteStore`, append a tiny signed run (reuse the `serve`/`sign`-in-transaction path or `gen_signed_tape`-style helpers), then `export_signed_tape(&store, run_id, &keyring_root)` and assert:
  - top-level `format == "buildplane.signed-tape.v1"`, `run_id` present, `trusted_keys` is non-empty and each entry's `sha256(decode(public_key_b64)) == public_key_hash`.
  - `events` length == events in the run; each entry has `canonical_event_b64` + `signature`; and `sha256(decode(canonical_event_b64)) == signature.canonical_event_hash` (the verifier's core check — **byte-identity gate**).
- [ ] **Step 2: Run to verify failure** — function absent.
- [ ] **Step 3: Implement** `export_signed_tape(store: &SqliteStore, run_id: &str, keyring_root: &Path) -> Result<serde_json::Value>`:
  1. `let rows = store.events_for_run(run_id)?;` (ordered `id ASC`).
  2. For each row: `let event = row.to_event()?;`, fetch its signature (via the `pub` read helper added in Step 4), build the entry `{ "canonical_event_b64": base64(canonical_event_bytes(&event)?), "signature": to_value(sig) }` (D6). An unsigned event → `"signature": null` (verifier will flag it; a fully-signed dispatch run has none).
  3. Collect distinct `(actor_id, key_id)` from the signatures; for each, `load_signing_key_at(keyring_root, &KeyringRef::new(actor_id, key_id))` → `verifying_key()`; push `{ public_key_hash: public_key_hash(&vk), public_key_b64: STANDARD.encode(vk.to_bytes()) }` (D5; dedup by hash).
  4. Assemble `json!({ "format":"buildplane.signed-tape.v1", "run_id":run_id, "trusted_keys":trusted, "events":entries })`.
- [ ] **Step 4: Add the storage read helper** — `signature_for_event` is private (`sqlite.rs:605`). Add `pub fn signed_events_for_run(&self, run_id: &str) -> Result<Vec<(StoredEventRow, Option<StoredEventSignatureRow>)>>` (or expose `signature_for_event` as `pub`) so `tape_export` can pair events with signatures without re-implementing the query. Prefer the paired helper (one statement-prepare per call).
- [ ] **Step 5: `lib.rs`** — `pub mod tape_export;`. **Step 6: Run** `cargo test --manifest-path native/Cargo.toml -p bp-ledger tape_export` → PASS. **Step 7: Commit** — `git commit -m "feat(ledger): export live events.db to buildplane.signed-tape.v1 (M2-S6)"`

---

## Task 5: `ledger export-signed-tape` subcommand (bp-cli) + TS forwarder + Rust regression

**Files:** `native/crates/bp-cli/src/ledger_cli.rs`, `native/crates/bp-cli/src/main.rs`, `apps/cli/src/run-cli.ts` (forwarder + help).

- [ ] **Step 1: Write the failing parse test** (`ledger_cli.rs` `#[cfg(test)]`, mirror `parse_replay` tests): `parse_ledger_command(["export-signed-tape","--run-id","r","--workspace","/tmp/ws","--out","/tmp/out"])` → `ExportSignedTape(ExportSignedTapeArgs { run_id:"r", workspace:"/tmp/ws", out:"/tmp/out" })`; rejects relative `--workspace`; routes `export-signed-tape --help` to `Help`.
- [ ] **Step 2: Implement** `ExportSignedTapeArgs { run_id: String, workspace: PathBuf, out: PathBuf }`, `parse_export_signed_tape`, the `Some("export-signed-tape") => …` arm in `parse_ledger_command` (`:50`), and `run_export_signed_tape(args)`:
  - `let db_path = args.workspace.join(".buildplane").join("ledger").join("events.db");`
  - `let store = SqliteStore::open(&db_path)?;`
  - `let keyring_root = bp_ledger::keyring::default_keyring_root()?;` (HOME-based)
  - `let tape = bp_ledger::tape_export::export_signed_tape(&store, &args.run_id, &keyring_root)?;`
  - `std::fs::create_dir_all(&args.out)?; std::fs::write(args.out.join("tape.json"), serde_json::to_string_pretty(&tape)? + "\n")?;`
  - print the written path. Wire `ExportSignedTape => run_export_signed_tape(args)` in the dispatcher (`main.rs`) and extend `usage_text()`.
- [ ] **Step 3: TS forwarder** — extend the `apps/cli` `ledger` subcommand handling so `buildplane ledger export-signed-tape …` spawns `buildplane-native ledger export-signed-tape …` (mirror exactly how `ledger replay` is forwarded; confirm the forwarder around the native-binary spawn — `run-cli.ts` resolves `buildplane-native` and the ledger binary is the same, per the `:2024` note). Add it to the two `ledger` help/usage strings (`:682`,`:731`).
- [ ] **Step 4: Rust regression** — `cargo test --manifest-path native/Cargo.toml -p bp-cli` (parse tests) **and** the whole-workspace gate `cargo test --manifest-path native/Cargo.toml` (NO `-p`) — proves the new `bp-cli` command + `bp-ledger` module don't break sibling crates' exhaustive matches (`bp-replay`). S6 adds no event kind, so this is a no-op exhaustive-match check, but it's the #163-class guard.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): add buildplane ledger export-signed-tape command (M2-S6)"`

---

## Task 6: e2e integration test + slice verification + docs + changeset

**Files:** Create `test/ledger-integration/planforge-receipt.test.ts`; modify `docs/ledger.md`; create `.changeset/m2-s6-receipt-live-tape-export.md`.

- [ ] **Step 1: Write the e2e** — **mirror `test/ledger-integration/activity-bracketing.test.ts` EXACTLY** (its `makeDispatchEnv()` → `{ dir, home, eventsDbPath, cleanup }`, `GOAL_INPUT` constant, `process.env.HOME`/`BUILDPLANE_NATIVE_BIN` in `beforeEach`/`afterEach`, local `readEvents`/`signatureFor` helpers, kernel-seed provisioning). Steps:
  - `runCli(["init"], { cwd: env.dir })` + git setup (mirror the dispatch test's init/commit).
  - `runCli(["planforge","admit","--input",GOAL_INPUT,"--approve","--operator","op1","--json"])`.
  - `runCli(["planforge","dispatch","--input",GOAL_INPUT,"--json"])` → expect code 0.
  - **Receipt assertions:** exactly **one** `plan_receipt` row; its `PlanReceiptRecordedV1.admission_event_id` equals the `plan_admitted` event's `id`; `outcome === "completed"`; `result_digest` matches `/^sha256:/`; the receipt row is **signed** (`signatureFor(receipt.id)` matchObject `{ actor_id:"kernel", key_id:"kernel-main", algorithm:"ed25519" }`); the receipt's `id` is greater than the last `activity_completed` id (terminal ordering).
  - **Export + verify (the spec's end-to-end acceptance):** resolve the dispatch run id (`planAdmitRunId(plan.idempotencyKey)` — recompute, or read it from the dispatch `--json`'s `runs[].run_id`/derive); run `export-signed-tape --run-id <id> --workspace <env.dir> --out <tmp>` (via `runCli(["ledger","export-signed-tape",…])` or direct native spawn); then exec `node scripts/verify-signed-tape.mjs --fixture <tmp> --json` and assert the parsed report `ok === true` and that the event kinds include `plan_admitted`, `activity_started`, `activity_completed`, `plan_receipt`, each `verified`.
- [ ] **Step 2: Build native, run** — `pnpm -C <wt> native:build`; `pnpm -C <wt> exec vitest run test/ledger-integration/planforge-receipt.test.ts` → PASS. Also re-run `test/ledger-integration/activity-bracketing.test.ts` + `planforge-dispatch.test.ts` to confirm the dispatch-path edit didn't regress.
- [ ] **Step 3: Canonical slice verify** —
```bash
pnpm -C <wt> native:build
pnpm -C <wt> exec vitest run test/ledger-integration/planforge-receipt.test.ts packages/planforge/test/receipt.test.ts apps/cli/test/ledger-receipt-port.test.ts
```
- [ ] **Step 4: Published-bootstrap closure** — `pnpm -C <wt> exec vitest run test/workflow/published-bootstrap-stage.test.ts` → PASS, no snapshot change (no new `@buildplane/*` import in `apps/cli` — planforge/ledger-client already vendored).
- [ ] **Step 5: Docs** — in `docs/ledger.md`: delete the "Not yet implemented: … `buildplane ledger export-signed-tape`" note (`:72`); add a short section documenting the command (flags `--run-id`/`--workspace`/`--out`, the `tape.json` output, and the `verify-signed-tape.mjs` round-trip).
- [ ] **Step 6: Changeset** — `.changeset/m2-s6-receipt-live-tape-export.md`:
```md
---
"@buildplane/planforge": minor
"@buildplane/cli": minor
---

M2-S6: receipt stage — completed planforge dispatch emits one kernel-signed
plan_receipt (chaining to the plan_admitted event id, canonical result_digest,
declared side_effects); `buildplane ledger export-signed-tape` serializes a live
events.db run into buildplane.signed-tape.v1 for the external verifier.
```
> `@buildplane/ledger-client` / `@buildplane/kernel` surfaces are unchanged (kernel untouched per D1; ledger-client only consumed) — no bump. Rust crates aren't changeset-versioned.
- [ ] **Step 7: Commit** — `git commit -m "test(ledger): e2e cover signed plan_receipt + export-signed-tape verify (M2-S6)"` and `git commit -m "docs(ledger): document export-signed-tape + M2-S6 changeset"` (or fold docs+changeset into one chore commit).

---

## Review & merge (L0 ceremony)

- **Review tier: L0 — Opus + adversarial Codex** (spec line 228). S6 emits a **signed terminal event** onto the L0 tape and ships the external-verifier's live-export path. The adversarial Codex pass must specifically cover:
  1. **Byte-identity (D6)** — `canonical_event_b64` is `canonical_event_bytes(event)` (what was signed), so `sha256(decode) == signature.canonical_event_hash`; the e2e proves it via `verify-signed-tape.mjs --json` `ok:true` on a **live-exported** tape (not a fixture).
  2. **Trusted-keys soundness (D5)** — export derives `public_key_b64`/`public_key_hash` from the keyring per signer; a key whose bytes don't hash to its claimed `public_key_hash` must not appear as `verified` (the verifier already drops mismatches — confirm export never emits a poisoned entry).
  3. **Receipt chaining + cardinality (D1/D2)** — exactly **one** `plan_receipt` per admitted plan, `admission_event_id` == the real `plan_admitted` id, outcome correct for pass/fail, emitted **after** all activities, durable before emitter close (E2).
  4. **Digest contract (D3)** — `result_digest` uses `@buildplane/planforge` canonical `digest()` (NOT `JSON.stringify`).
  5. **Skip path (E1)** — generic `buildplane run` emits **no** `plan_receipt` (no admission to chain to); behaviour byte-unchanged.
  6. **Exhaustive-match guard** — whole-workspace `cargo test` green; `bp-replay`'s `PlanReceiptRecorded` arm unchanged; export is read-only (no append/mutation of `events.db`).
- The Reviewer verdict must cite the reviewed SHA (== PR head), confirm the **kernel orchestrator is unmodified** (D1), and confirm `export-signed-tape` opens `events.db` read-only / writes only the out-dir.
- **Solo L0 PR — not auto-merge eligible** (no `buildplane:auto-merge`); operator admin-merge once CI `verify` + `Analyze` green.
- Route every push/PR through a fresh subagent (biome-OOM guard). Lead commit subjects with a lowercase verb. Record the slice against `docs/operations/slice-receipt-template.md`.

---

## Self-review

**Spec coverage** (S6 acceptance, spec line 219):
- "a completed dispatch emits a signed `plan_receipt` chaining to the admission event and recording actual side effects" → Task 1 (builder) + Task 2 (port) + Task 3 (dispatch emit, `admission_event_id` from `findExistingPlanAdmitted`) + Task 6 (e2e signed-row + chaining assertion). `side_effects` = declared scopes (**D4 ⚠ flag**: observed deferred to M4). ✔
- "`export-signed-tape` produces a tape the external verifier validates end-to-end (admit → activities → receipt)" → Task 4 (serializer) + Task 5 (command + TS forwarder) + Task 6 (live export → `verify-signed-tape.mjs --json` `ok:true`). ✔
- Verification commands (spec lines 223-226) → Task 6 (the `pnpm … vitest` line + the `export-signed-tape … && verify-signed-tape.mjs` round-trip). ✔ Review tier (spec line 228) → Review section. ✔

**No new wire shape:** `PlanReceiptRecordedV1` shipped in S2 (Rust `plan_lifecycle.rs:33`, TS `payload.ts:15`, `gen_signed_tape.rs` plan-cycle fixture emits it). S6 touches no `kind.rs`/`canonicalize.rs`/typeshare/fixtures. Whole-workspace `cargo test` (Task 5) is the no-op exhaustive-match gate.

**Kernel dependency invariant:** trivially preserved — **the kernel is not modified** (D1). The receipt builder lives in `planforge` (already has `digest`, no `ledger-client` dep); the emit lives in `apps/cli`.

**Type consistency:** `PlanReceiptPayload` (planforge) snake_case fields (`plan_id`/`admission_event_id`/`outcome`/`side_effects`/`result_digest`/`decided_at`) match the S2 TS union member `PlanReceiptRecordedV1` exactly; `admission_event_id` is a string (typeshared `EventId`), sourced from `findExistingPlanAdmitted` (returns string). Export's tape JSON keys match `verify-signed-tape.mjs` (`format`/`trusted_keys[{public_key_hash,public_key_b64}]`/`events[{canonical_event_b64,signature}]`) and `gen_signed_tape.rs:246`.

**Placeholder scan:** real symbols referenced — `findExistingPlanAdmitted`/`createTapeEmitter`/`PLANFORGE_KERNEL_SIGNING_KEY_ID`/`createLedgerActivityPort` (existing `run-cli.ts`), `digest` (`@buildplane/planforge`), `events_for_run`/`canonical_event_bytes`/`load_signing_key`/`public_key_hash` (existing Rust), `parse_replay`/`run_replay`/`usage_text` (mirror for `export-signed-tape`). Open confirmations the implementer must resolve in-task (not hidden gaps): (a) the exact TS `ledger` forwarder shape for the native spawn (Task 5 Step 3); (b) whether the dispatched packet schema carries declared side-effects or S6 emits `[]` (Task 3 Step 3, governed by the D4 flag); (c) whether `signature_for_event` is exposed `pub` or a paired helper is added (Task 4 Step 4). The two ⚠-flagged decisions (D1 emit-site deviation; D4 side-effects grain) are explicit operator-sign-off points.
