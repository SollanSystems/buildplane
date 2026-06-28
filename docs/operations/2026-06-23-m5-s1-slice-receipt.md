# Buildplane slice receipt — M5-S1 (ratify-in-place)

> Evidence packet for M5-S1. This slice's code was **already merged to `main`** (it rode in on the
> #200 squash); this receipt records the **retroactive L0 4-role ceremony + verification** that
> ratifies it in place. No new PR/merge was produced — re-building would collide on a duplicate
> `EventKind` variant.

## Slice identity

- **Slice id:** M5-S1
- **Milestone:** M5 (Web Mission Control)
- **Goal:** `operator_decision_recorded` signed L0 ledger event kind — the 9-file Rust+TS derivation
  so every operator approve/reject (merge/resume) lands on the signed tape (M5 spec Decision A).
- **Non-goals:** the `OperatorDecisionPort` / `orchestrator.recordOperatorDecision` writer + crash-recovery
  reconciler (that is **M5-S4**, also L0 4-role); the server/UI (S5–S8).
- **Operator approval scope:** "Ratify-in-place" — chosen 2026-06-23 via AskUserQuestion over the
  re-baseline finding that the deliverable already landed on `main`.
- **Steward / agent:** supervised loop (`buildplane-supervised-v05-loop`), principal-driven.
- **Started at:** 2026-06-23
- **Completed at:** 2026-06-23

## Source of truth

- **Base branch:** `main`
- **Base SHA (origin/main at ratification):** `a5de446d9dd415a361b6cfaf5dcddc15207ef2d0`
- **Source docs / specs read:** `docs/superpowers/specs/2026-06-21-m5-mission-control-design.md`
  §4 / §4.1 (`operator_decision_recorded` wire shape), the "L0 derivation discipline (M5-S1)"
  paragraph, the M5-S1 slice-table row; CLAUDE.md §"Adding a new event kind" + §"L0 trust surface".
- **Related task:** `.loop/TASKS.json` → `M5-S1`.
- **Prior prerequisite PRs verified on `origin/main`:** the kind's derivation landed inside **PR #200**
  (`feat(cli): gap-7 supervisor loop`, squash) merged 2026-06-23T05:08:06Z as `a5de446`.

## Workspace

- **Worktree path:** `/mnt/c/Dev/projects/buildplane` (no isolated worktree — review-only ratify)
- **Branch reviewed:** `origin/main`
- **Local HEAD reviewed:** `c2bce28` (working tree, byte-identical to `origin/main` for all 11 surface files)
- **Git identity verified:** n/a — no commit produced by this slice
- **Clean status before/after:** the M5-S1 surface (`native/**`, `packages/ledger-client/**`) is clean
  with **0 diff** between `origin/main` and working HEAD (all 11 files `SAME`).

## Scope

- **Files (the 11-file M5-S1 surface, all already on `main`):**
  `native/crates/bp-ledger/src/{kind.rs, payload/operator_decision.rs, payload/mod.rs, canonicalize.rs,
  bin/gen_fixtures.rs}`, `native/crates/bp-ledger/tests/operator_decision.rs`,
  `native/crates/bp-replay/src/transitions.rs`,
  `packages/ledger-client/src/{generated/index.ts, payload.ts}`,
  `packages/ledger-client/fixtures/payload-variants.json`,
  `packages/ledger-client/test/operator-decision-payload.test.ts`.
- **Diff stat:** 0 (review-only; code pre-existing on `main`).
- **Added dependencies / migrations / permission changes / publish side effects:** none.
- **Secret-shaped added lines scan:** n/a — no added lines.

## Verification

All three legs of the M5-S1 `verify` command, re-run independently by the acceptance verifier
**and** the adversarial Codex pass:

- **`cargo test --manifest-path native/Cargo.toml`** (WHOLE workspace, no `-p`): **287 passed /
  67 suites / exit 0** — the mandatory exhaustive-match gate (PR #163 lesson). `bp-ledger`
  operator_decision suite = **10 passed** incl. `signed_operator_decision_recorded_appends_and_verifies`
  (real Ed25519 `SigningKey` → `VerificationStatus::Verified`). `bp-replay` exhaustive transition
  matches green.
- **`pnpm -C <repo> exec vitest run packages/ledger-client/test`:** **10 files / 35 tests passed, exit 0.**
- **`git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures`:** **exit 0 (clean).**

### Cross-language / digest (L0)

- **u64 → TS string boundary:** PASS — every field is `String`/`Option<String>`; GAP-10 integers
  (`max_iterations`, `token_budget`) live inside the escaped canonical-JSON `envelope` string, never
  as a typeshared numeric field.
- **Canonical digest byte-stability (Rust ↔ TS):** PASS — signing is Rust-only via
  `canonical_event_bytes` → `serde_json::to_vec(&Payload)` (frozen field order; serde_json 1.0.149 has
  no `preserve_order`); the TS client never re-serializes for signing (`verify-signed-tape.mjs` hashes
  the stored `canonical_event_hash`). `operator_decision_recorded_canonical_bytes_are_stable` confirms.
- **Ledger fixture freshness:** PASS — `git diff --exit-code` clean; regeneration byte-matches committed fixture.
- **Whole-workspace `cargo test` (no `-p`):** PASS — 287 passed, exit 0.

## Review gate

### Ceremony tier

- **Tier:** **L0** (tape / signing / replay / digest — **full 4-role**).
- **Tier justification:** adds a new **signed** L0 event kind to the append-only tape — the highest
  trust surface; the un-retrofittable foundation.
- **Roles satisfied:**
  - **Implementer TDD self-verify** — the kind shipped TDD with round-trip / canonicalize / mismatch-
    rejection / stable-bytes / signed-append-and-verify Rust tests + TS drift/union tests (on `main`);
    the three deterministic verify legs re-confirmed green at ratification.
  - **Independent Opus reviewer** (fresh session) — **PASS** (11/11 criteria). `.loop/approvals/M5-S1-reviewer.md`.
  - **Adversarial Codex** (real Codex CLI v0.141.0 / gpt-5.5, two passes) — **PASS**.
    `.loop/approvals/M5-S1-adversarial.md`.
  - **Independent acceptance-criteria verifier** (Sonnet) — **PASS** (8/8 AC).
    `.loop/approvals/M5-S1-acceptance.md`.
- **Reviewed commit SHA:** `a5de446` (== current `origin/main`; surface byte-identical on working HEAD).
- **Verdict:** **PASS** (unanimous; no CRITICAL/HIGH findings).
- **Significant issues found:** none blocking. 3 convergent LOW notes (below).

### LOW findings carried forward (non-blocking)

1. **Subject-specific verification (action — adversarial + acceptance):** `operator_decision_recorded`
   folds two domains onto one signed kind — M5 merge/resume governance **and** GAP-10 `authorize-envelope`
   grants. Any policy/verifier consuming `decision == approved` **MUST branch on `subject`**; `envelope`
   is opaque signed bytes (never TS-recomputed). Mitigated in-shape (semantics keyed on `subject`;
   `envelope` None for merge/resume serializes byte-identically; replay no-ops all subjects).
   → Record in `docs/architecture/acceptance-contract.md` and consume correctly in **M5-S4**.
2. **Spec §4.1 superset debt:** §4.1 documents `subject: "merge" | "resume"` only; the live kind also
   accepts `authorize-envelope` + the optional `envelope` field. → add a §4.1 / architecture footnote.
3. **GAP-10 envelope replay semantics deferred:** the no-op replay arm is correct for M5 audit metadata;
   if a future GAP-10 makes `authorize-envelope` an **active** admission authority it needs its own
   replay/projection. → M5-GATE deferred-items list.

## PR / merge gate

- **PR:** #200 (`feat(cli): gap-7 supervisor loop — wire runaway guards into live dispatch`) — the squash
  that carried the M5-S1 derivation onto `main`. **No new PR for this ratification.**
- **Merge commit SHA:** `a5de446`. **Merge method:** squash. **Base:** `main`.
- **`origin/main` contains merge commit:** yes (it is the tip).
- **Required checks observed on `a5de446`:** `verify` ✅ success · `Analyze (javascript-typescript)` ✅
  success · `verify-wrong-node` ✅ · `release` ✅ (Dependabot queued — irrelevant).

## Exceptions / caveats

- **Retroactive ceremony (the one honest caveat):** M5-S1's code merged inside a PR **titled for the
  supervisor loop**, so it did not receive its own M5-titled PR or L0 ceremony *at merge time*. This
  receipt + the three `.loop/approvals/M5-S1-*.md` verdicts supply that L0 ceremony **after the fact**.
  SC4 ("every merge verified — CI green + review-ceremony PASS at the required tier") is satisfied:
  CI was green on `a5de446` and the L0 4-role ceremony PASSed here.
- **Receipt landing:** this file will be committed to `main` as part of the **M5-GATE** docs batch
  (path-scoped `git add docs/operations`), per the M2/M3/M4 GATE-receipt precedent — not as a noise PR.

## Next gate

- **Next allowed action:** select **M5-S2** (storage read surface; L2, 2-role ceremony) — re-baseline
  by FF-ing local `main` (`252f7c5`, stale) to `origin/main` `a5de446`, cut a fresh worktree, TDD build.
- **Actions explicitly not authorized:** reverting/re-landing the operator_decision_recorded kind;
  editing branch protection/rulesets; unfreezing the memory program; license change.
