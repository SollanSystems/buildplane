# Buildplane slice receipt — M2-S2 — Admission-cycle + activity tape event vocabulary

Evidence packet for the M2-S2 buildout slice. Implementation only; review/PR/merge gates are downstream.

## Slice identity

- Slice id: M2-S2
- Milestone: M2 (PlanForge admit cycle)
- Goal: add four signed L0 tape event kinds — `plan_admitted`, `plan_receipt`, `activity_started`, `activity_completed` — to the `bp-ledger` Rust spine + its hand-maintained TS mirror, with round-trip / canonicalize / sign-on-append / external-verifier proofs; fold the three M2-S1 planforge review nits.
- Non-goals: no admit/dispatch/receipt/replay wiring (S3–S7); no kernel/CLI/emit-path code. Vocabulary only.
- Operator approval scope: implement + commit atomically; no push/PR/label/merge; no `.github/`/ruleset/release-plumbing edits.
- Steward / agent: slice-builder (Opus)
- Started at: 2026-05-30
- Completed at: 2026-05-30

## Source of truth

- Base branch: `feat/m2-s2-tape-event-vocabulary`
- Base SHA: `f24e728` (docs parent — `docs(planforge): add M2 admit-cycle spec + M2-S2 plan`)
- Source docs / specs read:
  - `docs/superpowers/plans/2026-05-30-m2-s2-tape-event-vocabulary.md` (executed task-by-task)
  - `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md` (§"Tape event vocabulary", §M2-S2, §"Review requirements")
- Related task: M2-S2
- Prior prerequisite verified: `@buildplane/planforge` (M2-S1) and `packages/ledger-client` present in worktree.

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane/.claude/worktrees/agent-ac315bd9496178d0b`
- Branch: `feat/m2-s2-tape-event-vocabulary` (checked out as `worktree-agent-ac315bd9496178d0b`)
- Local HEAD SHA: `8bfe684` (before the changeset+receipt commit; final HEAD after Task 6 Step 4 commit)
- Remote branch SHA: not pushed (boundary: no push from inside slice)
- Git identity verified: yes (`test`)
- `core.filemode=false` verified: yes (`core.bare=false`, `core.filemode=false`)
- Clean status before work: only untracked planning artifacts present (`.claude/`, `memory/`, etc.)
- Clean status after commit: only `.changeset/` + this receipt staged at receipt-write time

## Scope

- Files changed (20, +832 / -20):
  - Rust: `native/crates/bp-ledger/src/payload/plan_lifecycle.rs` (new), `.../payload/activity.rs` (new), `.../payload/mod.rs`, `.../kind.rs`, `.../canonicalize.rs`, `.../bin/gen_fixtures.rs`, `.../bin/gen_signed_tape.rs`
  - Rust tests: `native/crates/bp-ledger/tests/plan_lifecycle.rs` (new), `.../tests/activity.rs` (new), `.../tests/signed_tape_fixture.rs`
  - TS: `packages/ledger-client/src/payload.ts`, `.../src/generated/index.ts` (regenerated), `.../fixtures/payload-variants.json` (regenerated 16→20), `.../test/payload-drift.test.ts`
  - planforge (S1 nits): `packages/planforge/src/{index,preview,digest}.ts`, `.../test/surface.test.ts` (new), `.../test/digest.test.ts`
  - Fixtures: `test/fixtures/signed-tape/plan-cycle/tape.json` (new)
  - Changeset + this receipt
- Added dependencies: none
- Data migrations / durable schema changes: new wire event kinds (additive enum variants; no migration — versioning on the `Event` envelope)
- Tool / workflow permission changes: none
- Deployment / publish / release side effects: none (changeset is a patch bump for `@buildplane/ledger-client` + `@buildplane/planforge`, both `private`)
- Secret-shaped added lines scan: clean — `git diff f24e728 HEAD` piped through a token-pattern grep (GitHub PAT prefix, `api_key`, `secret`, `password`, PEM private-key header) returned no matches.

## New wire vocabulary

| Wire kind | Payload variant | Notes |
|---|---|---|
| `plan_admitted` | `PlanAdmittedV1` | serde default snake_case matches wire name |
| `plan_receipt` | `PlanReceiptRecordedV1` | `EventKind::PlanReceiptRecorded` carries `#[serde(rename = "plan_receipt")]` so serde output == `as_wire()` (default would be `plan_receipt_recorded`) |
| `activity_started` | `ActivityStartedV1` | derives `Eq` |
| `activity_completed` | `ActivityCompletedV1` | derives `PartialEq` only (NOT `Eq`) — `result: serde_json::Value` is not `Eq`, mirroring `UnitStartedV1.policy` |

Closed enums: `PlanReceiptOutcome {completed,failed,aborted}`, `ActivityType {model,tool,command}` — both `rename_all = "snake_case"`.

## Folded M2-S1 nits (Task 1)

1. Trimmed public surface — dropped `hasLine`/`listValue`/`sectionText`/`hasForbiddenPlanForgeGoalIntent` from `@buildplane/planforge` entrypoint re-exports (helpers stay `export function` in their source modules; direct-path imports keep working). Asserted by new `surface.test.ts`.
2. Commented the deliberate idempotencyKey `JSON.stringify` exception in `preview.ts`.
3. Hardened `canonicalJson` against top-level `undefined` (coerce to `"null"` so `digest(undefined)` no longer throws). Dry-run golden fixture `apps/cli/.../expected-plan.json` byte-unchanged (real inputs are never top-level `undefined`).

## Verification

All commands run from the worktree root. Exit codes captured per command.

- `pnpm typecheck` → EXIT 0
- `cargo test --manifest-path native/Cargo.toml -p bp-ledger` → EXIT 0 (137 passed, 16 suites)
- `pnpm -C packages/ledger-client exec vitest run` → EXIT 0 (30 passed)
- `pnpm -C packages/planforge exec vitest run` → EXIT 0 (16 passed)
- `pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge` → EXIT 0 (6 passed, 96 skipped) — golden fixture unchanged
- `pnpm ledger:gen && pnpm ledger:gen-fixtures` then `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures test/fixtures/signed-tape` → EXIT 0 (byte-stable regeneration post-commit)
- `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/plan-cycle` → EXIT 0 (all 6 events verified incl. the 4 new kinds; checkpoint root_ok)
- `pnpm build` → EXIT 0
- Forbidden literal / ambient-authority grep: clean

Per-task TDD red→green observed: surface test (FAIL: leaked `hasLine` → PASS), digest-coercion test (FAIL: `hash.update(undefined)` throws → PASS), `kind` test (FAIL: `plan_receipt_recorded` vs `plan_receipt` → PASS after serde rename).

## Lint / format

- Husky pre-commit runs `pnpm lint` = `biome check .` (whole repo), which OOMs in this WSL worktree (`[warn] Linter process terminated abnormally (possibly out of memory)`), as documented in project memory.
- Mitigation: scoped, memory-bounded biome (`node --max-old-space-size=2048 node_modules/@biomejs/biome/bin/biome check <files>`) used to validate each touched file. This caught one real lint error (import-organization on the trimmed `index.ts` re-export) which was fixed (`export { type PlanForgeValidateResult, validate }`) before the Task 1 commit.
- All commits landed WITHOUT `--no-verify`. The husky biome step passed on every commit (Rust-only commits emit warnings/infos but no errors; the planforge commit passed after the organize-imports fix).
- CI `verify` remains the canonical whole-repo lint gate.

## Deviations from the plan

1. **`#[serde(rename = "plan_receipt")]` on `EventKind::PlanReceiptRecorded`** (not in the plan text). Required: serde's default `rename_all="snake_case"` yields `plan_receipt_recorded`, but the spec wire name is `plan_receipt`, and the existing `as_wire_matches_serde_output` invariant asserts serde output == `as_wire()` for every kind. The plan's own `plan_kinds_use_wire_names` test also asserts `plan_receipt`. `plan_admitted`/`activity_started`/`activity_completed` need no rename (default snake_case already matches).
2. **Single `as_wire_matches_serde_output` test array**, not two — `kind.rs` has one array; the plan said "BOTH ... test array" (there is only one). Added the new kinds to the single array.
3. **Commit subject shortened** for Task 1: the plan's literal subject was 113 chars; commitlint caps headers at 100. Shortened to `fix(planforge): fold M2-S1 review nits — surface trim, idempotency note, canonicalJson guard`.
4. **Task 4 Step 7 byte-stability**: the literal `git diff --exit-code` against an uncommitted working tree returns 1 (the new content isn't committed yet). Confirmed true re-run idempotence by snapshotting the first generated output and diffing a second run against it (identical). Post-commit, the Task 6 gate `git diff --exit-code` returns 0.
5. **`signed_tape_fixture.rs`**: factored the shared validation body into `assert_tape_is_a_real_signed_tape(&tape)` and added a parallel `#[test] fn plan_cycle_fixture_is_a_real_signed_tape()` (the test file is not variant-list-driven), with an extra assertion that the plan-cycle tape contains all four new wire kinds.

## Review gate (L0 — NOT auto-merge eligible)

- **Two reviewers, both required** per spec §"Review requirements": independent read-only **Opus Reviewer** (fresh session, verdict `PASS` on PR head SHA) AND an **adversarial Codex reviewer**.
- **Not auto-merge eligible** — do NOT apply `buildplane:auto-merge`. Solo PR → admin-merge by the operator.
- Reviewer focus: four wire shapes correct/minimal per spec field lists; kind↔variant arms exhaustive both directions; TS union faithful; round-trip/canonicalize/sign-on-append/external-verifier all pass; byte-stable regen; S1 nits fixed without rotating the dry-run golden digest; the `plan_receipt` serde-rename divergence; `ActivityCompletedV1` `PartialEq`-not-`Eq`; determinism (no `EventId::new()`/`Utc::now()` in generators); `plan-cycle` does not perturb `valid`/`tampered`/`bad-root`.

## Exceptions / caveats

- Whole-repo `biome check .` OOMs locally (WSL) — see Lint section. Not a code defect; CI `verify` is canonical.
- Reviewed SHA must equal the PR head SHA at merge.

## Next gate

- Next allowed action: L0 two-reviewer gate (Opus Reviewer + adversarial Codex) on the PR head, then a fresh push subagent opens the PR.
- Actions explicitly NOT authorized from inside this slice: push, PR open, label, merge, branch-protection/ruleset edits, `.github/`/release-plumbing changes.
- Out-of-scope follow-ups (later slices): admit (S3), dispatch (S4), activity bracketing (S5), receipt (S6), replay (S7).
