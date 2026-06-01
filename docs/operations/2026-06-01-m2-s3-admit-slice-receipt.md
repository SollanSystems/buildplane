# M2-S3 slice receipt — PlanForge admit stage

Evidence packet for the M2-S3 buildout slice. Per `docs/operations/slice-receipt-template.md`.

## Slice identity

- Slice id: M2-S3
- Milestone: M2 (PlanForge admission cycle)
- Goal: operator approval → signed `plan_admitted` on the L0 tape via `buildplane planforge admit --input <file> --approve --operator <id>`.
- Non-goals: `run_admission_recorded` tape-mirror (→ S4), `export-signed-tape`/full external-verifier-of-live-tape (→ S6), dispatch/activity bracketing/receipt (→ S4–S6).
- Operator approval scope: build through S3 + run L0 ceremony + open PR; stop at admin-merge (operator). Pre-S3 lock = minimal; operator id = required `--operator` flag.
- Steward / agent: Claude Opus 4.8 (orchestrator) + independent Opus reviewer + adversarial Codex + acceptance-criteria verifier.
- Started at: 2026-06-01
- Completed at: 2026-06-01 (PR opened; awaiting admin-merge)

## Source of truth

- Base branch: `main`
- Base SHA: `9fef0a1` (origin/main, #164 version-packages)
- Source docs / specs read: `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md` (M2-S3 + canonical digest contract), `CLAUDE.md`, `docs/ledger.md` paths, `scripts/verify-signed-tape.mjs`.
- Related issue / task / board item: M2 critical path (S1 #161, S2 #163 merged).
- Prior prerequisite PRs verified on `origin/main`: S1 (#161), S2 (#163) both merged; FF confirmed before cutting worktree.

## Workspace

- Worktree path: `.claude/worktrees/m2-s3-admit`
- Branch: `worktree-m2-s3-admit`
- Local HEAD SHA: `597cb74`
- Remote branch SHA: `597cb74` (pushed)
- Git identity verified: yes (test)
- `core.filemode=false` verified: yes (`core.bare=false` also verified)
- Clean status before work: yes (cut fresh from origin/main)
- Clean status after commit: yes

## Scope

- Files changed: 10 (see diff stat)
- Diff stat: `+872 / -22` across `apps/cli/src/run-cli.ts`, `apps/cli/test/run-cli.test.ts`, `packages/planforge/src/{admit,index}.ts`, `packages/planforge/test/admit.test.ts`, `packages/ledger-client/test/m2-signed-identity-contract.test.ts`, `native/crates/bp-ledger/tests/m2_digest_contract.rs`, `test/ledger-integration/planforge-admit.test.ts`, `docs/architecture/canonical-digest-contract.md`, `.changeset/m2-s3-planforge-admit.md`.
- Added dependencies: none (planforge stays a zero-dep leaf; CLI uses existing `@buildplane/ledger-client` type-only).
- Data migrations / durable schema changes: none.
- Tool / workflow permission changes: none.
- Deployment / publish / release side effects: none (changeset stages a future minor bump only).
- Secret-shaped added lines scan: CLEAN (`git diff origin/main..HEAD | grep -iE secret-patterns` → empty).

## Verification

- Focused tests: `pnpm -C <wt> exec vitest run packages/planforge/test/admit.test.ts` → 4 passed; `test/ledger-integration/planforge-admit.test.ts` → 5 passed; `packages/ledger-client/test/m2-signed-identity-contract.test.ts` → 2 passed.
- Package / area tests: `pnpm -C <wt> exec vitest run packages/planforge` → 26 passed.
- Typecheck: `pnpm -C <wt> typecheck` → clean (exit 0).
- Lint / format: scoped `biome check` on all changed files → clean. Whole-repo `biome check .` OOMs in WSL — CI `verify` canonical.
- Build: `pnpm typecheck` (tsc --build) clean; native already built.
- Full-suite check, if run: broad TS regression `apps/cli/test/run-cli.test.ts` + `test/workflow/published-bootstrap-stage.test.ts` + `packages/ledger-client/test/payload-drift.test.ts` → 214 passed (exit 0).
- Isolated reruns for flaky / timeout failures: n/a (broad batch was slow, not flaky; completed exit 0).
- Direct CLI smoke / manual probe: covered by the integration test (real native `serve --sign`, temp-HOME kernel seed).
- Forbidden literal / ambient-authority grep: secret scan clean (above).

### Cross-language / digest (L0)

- `u64` → TS `string` boundary verified: **n/a — no `u64` exists in any M2 payload.** Verified: all four M2 payloads are `String`/enum/`Vec<String>`/opaque-`Value`; `EventId`/`RunId` are `#[serde(transparent)]` UUIDs → JSON strings. Locked by `native/crates/bp-ledger/tests/m2_digest_contract.rs` (5 tests) + `packages/ledger-client/test/m2-signed-identity-contract.test.ts` (2 tests).
- Canonical digest byte-stability: TS payload digests use sorted-key canonical JSON; the Rust event-envelope hash uses serde field-order `serde_json::to_vec`; disjoint (no object digested by both languages). Documented in `docs/architecture/canonical-digest-contract.md`. The signing path re-serializes via Rust serde, so TS field order/extras cannot affect the signed bytes.
- Ledger fixture freshness: `pnpm ledger:gen-fixtures` → `git diff --stat packages/ledger-client/{fixtures,src/generated} test/fixtures/signed-tape` clean (no payload change).
- Whole-workspace `cargo test` (no `-p`): **252 passed** (63 suites) — enum-variant exhaustive-match gate + the new digest guard.

## Review gate

### Ceremony tier

- Tier: **L0** (signs an admission identity onto the append-only tape).
- Roles satisfied: implementer TDD self-verify ✓ · independent Opus reviewer ✓ · adversarial Codex ✓ · independent acceptance-criteria verifier ✓ (full 4-role).
- Tier justification: produces a signed `plan_admitted` event — a load-bearing wire shape that, once in production, would force a tape migration if wrong.

- Review task id / reviewer:
  - Independent Opus reviewer (fresh session) — **PASS** at `27da2e9`; one MEDIUM (`--operator` integration coverage) reconciled by `c69dfd8`.
  - Adversarial Codex (`codex exec`, read-only, high effort) — **DO-NOT-SHIP** on [P1] concurrent-admit TOCTOU + two [P2]; see below.
  - Independent acceptance-criteria verifier — **PASS** (8/8) at `597cb74`.
- Reviewed commit SHA: `27da2e9` (Opus) → reconciled; `597cb74` (verifier, current head).
- Current PR head SHA: `597cb74`
- Verdict: **PASS** (Opus + verifier); Codex DO-NOT-SHIP adjudicated — see significant issues.
- Significant issues found:
  - **Codex [P1] — idempotency TOCTOU.** Two *concurrent* same-plan admits could both append. **Adjudication: single-writer-bounded.** The ledger's own `validate_external_append` documents the single-writer/single-operator model and treats multi-writer (DB-level uniqueness) as out of scope; the independent Opus reviewer rated the identical finding LOW on that basis. Sequential re-admit idempotency is tested (count stays 1). Severity (P1 vs LOW) is an **operator decision** at admin-merge. Comment qualified in `597cb74`.
  - **Codex [P2] — drift-guard comment over-claim** → corrected in `597cb74` (missing/mistyped fields fail typecheck; extra fields are dropped by the Rust serde round-trip before signing).
  - **Codex [P2] — `ActivityCompletedV1.result` precision** → forward-looking for **S5** (`activity_completed` not emitted by S3); already documented in the digest-contract doc.
- Issues reconciled by follow-up commit SHA: `c69dfd8` (Opus MEDIUM), `597cb74` (Codex P2s).
- Review notes / link: PR #166.

## PR gate

- PR URL: https://github.com/SollanSystems/buildplane/pull/166
- PR number: 166
- Draft state: ready
- Base branch: `main`
- Head branch: `worktree-m2-s3-admit`
- Head SHA: `597cb74`
- Merge state: awaiting CI `verify` + `Analyze`
- Review decision: L0 4-role satisfied (Opus PASS + verifier PASS; Codex P1 adjudicated to operator)
- Auto-merge opt-in label present: no
- Required auto-merge label: `buildplane:auto-merge` (intentionally NOT applied)
- Required checks observed: CI `verify`, `Analyze` (pending on PR)
- Advisory checks observed: unknown (pending)
- Deployment objects from GET-only probe: n/a
- Auto-merge eligibility result: **not eligible** (L0 solo PR)
- Auto-merge decision: none — operator admin-merge required.

## Post-merge verification

- (pending operator admin-merge) — n/a until merged.

## Exceptions / caveats

- Whole-repo `biome check .` OOMs in WSL; scoped lint clean; CI `verify` canonical.
- Broad `run-cli.test.ts` batch is slow (~minutes) but passes (214/214).
- Open operator decision: whether the single-writer-bounded concurrent-admit TOCTOU is acceptable for M2-S3 (recommended: yes — consistent with the ledger's documented model; multi-writer hardening would land with the rest of multi-writer if ever needed).

## Next gate

- Next allowed action: operator reviews PR #166, lets CI `verify` + `Analyze` go green, then admin-merges (gh OAuth cannot admin-merge L0 solo PRs — use web UI / PAT).
- Actions explicitly not authorized: auto-merge label, applying `buildplane:auto-merge`, starting S4 before S3 lands on `main`.
- Fresh context required before continuing: S4 (dispatch) should cut fresh from `origin/main` after S3 merges.
