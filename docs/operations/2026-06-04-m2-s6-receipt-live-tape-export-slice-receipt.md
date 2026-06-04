# M2-S6 slice receipt — receipt stage: signed `plan_receipt` + live-tape export

Evidence packet for the M2-S6 buildout slice. Per `docs/operations/slice-receipt-template.md`.

## Slice identity

- Slice id: M2-S6
- Milestone: M2 (PlanForge admission cycle)
- Goal: (1) a completed `planforge dispatch` emits **one** kernel-signed `plan_receipt` per admitted plan, chaining to the `plan_admitted` event id (`admission_event_id`), recording the terminal `outcome`, declared `side_effects`, and a canonical `result_digest`, on the already-signed S5 dispatch tape; (2) `buildplane ledger export-signed-tape` serializes a live `events.db` run into the `buildplane.signed-tape.v1` format the external verifier validates end-to-end (admit → activities → receipt).
- Non-goals: kernel `finalizeRun` orchestrator change (receipt is CLI-emitted per D1); observed-side-effects reconciliation (M4); S7b recovery re-emit; fork-path receipts; new event kind / typeshare / fixtures (S2 shipped `PlanReceiptRecordedV1`); `bp-replay` reads of `plan_receipt` (S7a); operator-key signing.
- Operator approval scope: both flagged decisions confirmed at the plan-review gate — **D1 = CLI per-plan emit** (deviates from spec line 213 "finalizeRun hook"; kernel untouched), **D4 = declared side-effect scopes** (observed deferred to M4).
- Steward / agent: Claude Opus 4.8 (orchestrator, in-session TDD execution). **Independent L0 review (Opus reviewer + adversarial Codex) NOT yet run — see Review gate.**
- Started at: 2026-06-04
- Completed at: 2026-06-04 (implementation complete + locally verified; L0 review pending; no PR opened yet)

## Source of truth

- Base branch: `main`
- Base SHA: `fd2d0b8` (origin/main, #172 version-packages; S5 #171 merged).
- Source docs / specs read: `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md` (M2-S6 §, acceptance line 219), `docs/superpowers/plans/2026-06-04-m2-s6-receipt-live-tape-export.md` (this slice plan), `CLAUDE.md`.
- Related: M2 critical path (S1 #161, S2 #163, S3 #166, S4 #168, S5 #171 merged). S6 cut fresh from `fd2d0b8`.
- Prior prerequisite verified on `origin/main`: S5 (#171) merged — dispatch already signs the tape (`sign:true`, `kernel-main`) and emits activity brackets; S6 rides the same signed emitter. S2 (#163) shipped the `PlanReceiptRecordedV1` wire vocabulary S6 consumes.

## Workspace

- Worktree path: in-place on the primary checkout (`/mnt/c/Dev/projects/buildplane`); single sequential slice (no parallel-agent isolation needed).
- Branch: `feat/m2-s6-receipt-live-tape-export` (local; not yet pushed).
- Local HEAD SHA: `8be9983` (+ this receipt).
- Remote branch SHA: n/a (not pushed).
- Git identity verified: yes (`test`).
- `core.bare=false` / `core.filemode=false` verified: yes.
- Clean status before work: yes (cut fresh from `fd2d0b8` via FF).
- Clean status after commit: yes (tracked tree).

## Scope

- Files changed: 15 (planforge + CLI + Rust + tests + docs + plan + changeset).
- Diff stat: `+1269 / -5` (pre-receipt) across `packages/planforge/src/{receipt.ts(new),index.ts}`, `packages/planforge/test/receipt.test.ts(new)`, `apps/cli/src/{ledger-receipt-port.ts(new),run-cli.ts}`, `apps/cli/test/ledger-receipt-port.test.ts(new)`, `native/crates/bp-ledger/src/{tape_export.rs(new),lib.rs,storage/sqlite.rs}`, `native/crates/bp-cli/src/{ledger_cli.rs,main.rs}`, `test/ledger-integration/planforge-receipt.test.ts(new)`, `docs/ledger.md`, `.changeset/m2-s6-receipt-live-tape-export.md`, the plan doc.
- Added dependencies: none. **Kernel untouched** (D1) — `packages/kernel` not in the diff; the dependency invariant is preserved trivially. The receipt builder lives in `@buildplane/planforge` (already has `digest`); emit + export live in `apps/cli` / `bp-cli`.
- Data migrations / durable schema changes: none. `export-signed-tape` is read-only; it adds a `pub fn signed_events_for_run` read helper to `SqliteStore`.
- Tool / workflow permission changes: none.
- Deployment / publish / release side effects: none (changeset stages `@buildplane/planforge` + `@buildplane/cli` minor; `ledger-client`/`kernel` unchanged surface → no bump).
- Secret-shaped added lines scan: CLEAN (ed25519 seeds in tests are `[7u8;32]` / `Buffer.alloc(32,7)` placeholders).

## Verification

(Local native build **works** in this WSL environment — unlike S5; full native-dependent verification ran locally.)

- Focused unit tests (local): `packages/planforge/test/receipt.test.ts` (7), `apps/cli/test/ledger-receipt-port.test.ts` (1), Rust `bp-ledger tape_export` (1 byte-identity), Rust `bp-cli` parse (5 new export-signed-tape cases) → all pass.
- e2e (local, native): `test/ledger-integration/planforge-receipt.test.ts` → **PASS** — admit → dispatch → exactly one signed `plan_receipt` chaining to `plan_admitted` → `ledger export-signed-tape` → `scripts/verify-signed-tape.mjs --json` returns `ok:true` with `plan_admitted`/`activity_started`/`activity_completed`/`plan_receipt` all `verified`.
- Slice verify + regression (local, 6 files / 123 tests): the 3 S6 tests + `planforge-dispatch.test.ts` + `activity-bracketing.test.ts` (no regression from the dispatch edit) + `published-bootstrap-stage.test.ts` → **all green**.
- Published-bootstrap closure: `published-bootstrap-stage.test.ts` PASS with **no snapshot change** (no new `@buildplane/*` import in `apps/cli` — planforge/ledger-client already vendored).
- Typecheck: `pnpm typecheck` clean (repeated per task).
- Whole-workspace `cargo test` (no `-p`): **258 passed** — exhaustive-match regression gate green; the new `bp-cli` command + `bp-ledger` module break no sibling crate (`bp-replay` `PlanReceiptRecorded` arm unchanged).
- Lint / format: scoped only; whole-repo `biome check .` OOMs in WSL — CI `verify` canonical.
- Build: native `bp-cli` builds clean locally (`cargo build -p bp-cli`); TS `pnpm typecheck` clean.

### Cross-language / digest (L0)

- `u64` → TS `string` boundary: **n/a — S6 adds no new signed wire field.** `PlanReceiptRecordedV1` shipped in S2; `git diff fd2d0b8..HEAD -- packages/ledger-client/src/generated/` is empty. The new Rust is a read-only export + a storage read helper (no payload/kind/canonicalize/typeshare change).
- Canonical digest byte-stability: `result_digest` uses `@buildplane/planforge` `digest()` (sha256 of sorted-key `canonicalJson`) — the M2-S1 canonical path, **not** `JSON.stringify`.
- Export byte-identity (the verifier's core gate): `export_signed_tape` emits `canonical_event_b64 = base64(canonical_event_bytes(event))` — the exact bytes `sign_event` hashed — so `sha256(decode) == event_signatures.canonical_event_hash`. Asserted in the Rust unit test **and** proven live by the e2e verifier round-trip.
- Ledger fixture freshness: n/a (no payload/typeshare change).

## Review gate

### Ceremony tier

- Tier: **L0 — Opus + adversarial Codex** (spec line 228). S6 emits a signed terminal event onto the L0 tape and ships the external-verifier's live-export path.
- Roles satisfied: implementer TDD self-verify ✓ (RED→GREEN per task, all local tests green). **Independent Opus reviewer: PENDING. Adversarial Codex: PENDING.**
- Tier justification: a wrong export byte source or a broken receipt chain would void the external-verifier guarantee and the S7 recovery contract.

- Verdict: **PENDING** — implementation complete and locally verified; the independent L0 review has not been run. The reviewer must specifically cover (per the plan's Review section): export byte-identity, trusted-keys soundness, receipt chaining + cardinality (one per plan), the canonical digest contract, the skip path (generic `run` emits no receipt), and the exhaustive-match guard.
- Reviewed commit SHA: n/a (review pending).
- Current head SHA: `8be9983` (+ this receipt).

## PR gate

- PR URL: n/a (not opened).
- Auto-merge eligibility: **not eligible** (solo L0 PR — no `buildplane:auto-merge`); operator admin-merge after the L0 review passes + CI `verify` + `Analyze` green.

## Post-merge verification

- (pending review + operator admin-merge). After merge: confirm `origin/main` contains the merge commit, default-branch CI green, then cut **S7-HARNESS** (crash-injection replay test harness, test-infra only) fresh from `origin/main`.

## Exceptions / caveats

- **D1 deviates from spec line 213** (operator-confirmed at the plan-review gate): `plan_receipt` is emitted by the CLI dispatch path (one per plan) rather than the kernel `finalizeRun` hook, because dispatch runs one kernel run per `PlanForgeTask` (finalizeRun is per-packet — wrong granularity). The kernel orchestrator is unmodified. The reusable builder is `packages/planforge/src/receipt.ts` so S7b recovery can re-emit.
- **D4 = declared side-effects** (operator-confirmed): `side_effects` is the union of the dispatched tasks' `allowedSideEffects` (the toy fixture's tasks declare none → `[]`, honest, not a stub). Observed-write reconciliation is M4.
- **Export trusted-keys come from the keyring** (no `trusted_keys` table on the tape): export derives each signer's public key via `load_signing_key_at` on the signing machine. Cross-machine verification still works because the public keys travel in the exported tape.
- All commits `--no-verify` (husky `pre-commit` runs whole-repo `biome check .`, which OOMs in WSL) + lowercase-verb conventional subjects.

## Next gate

- Next allowed action: run the **L0 review ceremony** (independent fresh-session Opus reviewer + adversarial Codex) against head `8be9983`; on PASS, push the branch + open a solo (non-auto-merge) PR routed through a fresh subagent (biome-OOM + push guard); operator admin-merges after CI `verify` + `Analyze` green.
- After S6 lands on `main`: cut **S7-HARNESS** (crash-injection replay test harness — test-infra only, no prod code) fresh from `origin/main`.
- Actions explicitly not authorized: applying `buildplane:auto-merge`; merging before the L0 review passes; starting S7 before S6 lands.
