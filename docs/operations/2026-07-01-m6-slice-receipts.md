# M6 slice receipts — S1–S5, S8–S11 (consolidated)

**Date:** 2026-07-01
**Milestone:** M6 (v0.5 killer demo + MIT release)
**Plan:** `docs/superpowers/plans/2026-06-29-m6-v05-demo.md` (amended `docs/superpowers/plans/2026-07-01-m6-completion-and-improvements.md`)
**Spec:** `docs/superpowers/specs/2026-06-29-m6-v05-demo-design.md`
**Base at wave start:** `origin/main` `257c1cd` (M5-GATE). **Implementer:** opus (worktree-isolated). **Reviewer:** sonnet / orchestrator, scaled to tier.

This is a **back-filled evidence packet** authored at R6 for the nine already-merged M6 mechanical slices, so the per-slice evidence is not lost when `.superpowers/sdd/progress.md` (local scratch, now gitignored) is dropped. Each slice cites its PR number and squash-merge SHA from `git log --oneline` / `gh pr list --state merged`. Fields not recoverable from git + progress ledger are marked `unknown`; none blocks a gate (all nine are merged on `origin/main` and rode the CI `verify` + `Analyze` required checks).

Autonomous set (per the M6 plan): S1, S2, S3, S4, S5, S8, S9, S10, S11 — all built-then-reviewed-then-merged without an operator hold. S6 (live dogfood run), S7 (emit), S12-live, S13-publish are operator-gated and remain open. Several Wave-3a/3b slices (S2, S5, S9, S11) were interrupted by a WSL crash mid-workflow and **recovered by cherry-picking the committed slice commits cleanly onto post-merge `origin/main`**, then re-reviewed PASS before push.

---

## S1 — `riskClass` on validate + preview · PR #215 · merge `2ce5e9d`

- **Goal:** add a derived `riskClass` field to PlanForge `validate` and `preview` output.
- **Tier:** L2 (2-role: implementer self-review + independent sonnet review). **Verdict:** SPEC ✅ / QUALITY ✅.
- **Workspace:** worktree branch `worktree-agent-a31636241502e69ac` → `feat/m6-s1-risk-class` (`257c1cd..8d00b51`).
- **Scope / digest:** `planDigest` rotated `1804e391…`→`69973b53…`; golden `expected-plan.json` regenerated via the real CLI; `idempotencyKey` **unchanged** `…95d7132e`; signed `PlanReceiptPayload` untouched (no L0 wire change). Changeset `@buildplane/planforge` patch.
- **Verification:** `planforge/test` 93/93 + `apps/cli` planforge 12/12; typecheck clean.
- **Findings:** LOW **R-001** — dead `|| status===UNSAFE_TO_RUN` OR-branches (`status` already derived from those arrays; matches spec wording, harmless) → M6-GATE final-review triage.
- **Post-merge:** squash-merged to `origin/main` (direct gh-merge on green — Mergify had dequeued the clean PR after a hold→resume label cycle; merge-on-green is operator-authorized).

## S2 — `bp goal "<text>"` CLI · PR #222 · merge `c71628d`

- **Goal:** raw goal string → previewed plan JSON (renders preview fields incl. `riskClass`; `netEgress` display deferred to a later additive change since S9 was unmerged at cut time).
- **Tier:** L2 (2-role). **Verdict:** Reviewer PASS.
- **Workspace:** `feat/m6-s2-bp-goal`, tip `404ea76` (worktree `.worktrees/m6-s2-recover`). Cut from `f324145` (pre-S8); edits confined to router/help so `run-cli.ts` auto-merged. **Crash-recovered** by cherry-pick onto post-merge `origin/main`.
- **Findings reconciled:** one [P2] — no-`origin` remote coherence: `remote ?? ""` so `validate()` flags `repository_remote`; plus P3s (`--trusted-base` skip-loop guard, exact `riskClass` assertion, dropped a vacuous test, added a no-remote regression test).
- **Verification:** scoped `apps/cli` goal tests + typecheck (green in review); CI `verify` on merge.

## S3 — toy Express demo-repo fixture · PR #213 · merge `4b9671c`

- **Goal:** ship a toy Express demo repo fixture (`fixtures/demo-repo/`) with a RED-by-design `login.test.js` for the M6 demo path.
- **Tier:** L3 fixture (self + orchestrator review). **Verdict:** clean.
- **Workspace:** worktree branch `worktree-agent-acbb643593cc3c30a` → `feat/m6-s3-demo-repo-fixture`, tips `0464243`+`eb777df`.
- **Scope:** test-infra/fixtures only; no changeset.
- **Verification:** `test/workflow` meta-test 3/3; fixture `login.test.js` RED by design.
- **Caveat / lesson:** CI `verify` failed **twice** on biome **format** — the `HUSKY=0` commits (worktree had no `node_modules`) never ran biome locally, so the meta-test file and the three `fixtures/demo-repo/*` sources landed unformatted; both were reformatted. CI `verify` is the canonical lint gate.

## S4 — `code-edit` side-effect → `native/crates/**` globs · PR #214 · merge `18bccd0`

- **Goal:** map the `code-edit` PlanForge side-effect kind onto `native/crates/**` (Rust source) globs so an admitted plan can authorize native-crate edits.
- **Tier:** L2 (2-role). **Verdict:** clean.
- **Workspace:** worktree branch `worktree-agent-a35da2c38333fa953` → `feat/m6-s4-native-crates-globs` (`257c1cd..c71eada`). Changeset `@buildplane/planforge` patch.
- **Verification:** `planforge/test` 86/86.
- **Surfaced blocker:** the `globIsSubset` **wildcard-middle** admission bug — `globIsSubset('native/crates/bp-ledger/src/**' ⊆ 'native/crates/**/src/**')` returns `false` (the `/**`-suffix branch does literal prefix `startsWith`), so admission of a narrow child under a `**`-middle glob fails **closed** (safe direction) and pauses. Fix options A (zero-code envelope with `path_globs:["native/crates/**"]`) / B (root-cause minimatch fallback in `authorization-envelope.ts`) — **operator decision at S6-prep**, does not block mechanical slices.

## S5 — repoint `docs/roadmap.json` to the M6 `result_ready` slice · PR #225 · merge `1c15787`

- **Goal:** repoint `docs/roadmap.json` from M5-S2 to M6 + the single `M6-S6` `result_ready` slice (`dependsOn:[]`).
- **Tier:** L3 (roadmap/docs). **Verdict:** engineer-verified clean.
- **Workspace:** `feat/m6-s5-roadmap-m6`, tip `b0d2e6e` (worktree `.worktrees/m6-s5-recover`). **Rebuilt from scratch** during crash recovery (the pre-crash attempt was never actually done).
- **Scope:** the `M6-S6` slice compiles to **PASS** (no validator weakened); 4 consuming tests updated M5-S2→M6-S6.
- **Verification:** 17 tests + typecheck + biome clean.

## S8 — per-tool-call tape events from the claude stream · PR #220 · merge `96c866e`

- **Goal:** emit per-tool-call tape events (`ToolRequestStoredV1` / `ToolResultV1`) parsed from the claude executor stream; `onToolEvent` mirrors the `onCapabilityDenied` plumbing.
- **Tier:** L1/L2 (2-role). **Verdict:** SPEC ✅ / QUALITY approved. **Spike-gated** — spike PASSED before implementation.
- **Workspace:** worktree branch `worktree-agent-aa59049cef482cbeb` → `feat/m6-s8-tool-tape-events`, final `fabc0e2`. Changeset `@buildplane/adapters-models`.
- **Scope:** executor parses `tool_use`/`tool_result`; `apps/cli` maps to the two signed payloads. **Published-bootstrap closure UNCHANGED** — new `apps/cli`↔`adapters-models` imports are type-only; `newEventId` already in `INTERNAL_PACKAGE_ENTRYPOINTS`, `adapters-models` already in `OPTIONAL_INTERNAL_PACKAGES`.
- **Verification:** 54 tests, tsc green. Findings fixed: R-001 `working_directory` populated from the run workspace root; R-002 deduped `EMPTY_ENV_HASH`; R-003 orphan-drop tested.
- **Sequencing note:** touches `run-cli.ts` → S2/S11 were cut before S8 and rebased/cherry-picked over it during recovery (disjoint regions).

## S9 — declarative `netEgress` allowlist in bundle + plan mapping · PR #223 · merge `7c77a39`

- **Goal:** add a declarative `netEgress` allowlist to the capability bundle + plan mapping and surface it in preview. **Declarative-only — no enforcement added** (enforcement is spike-gated / post-v0.5).
- **Tier:** L2 (2-role). **Verdict:** Reviewer PASS.
- **Workspace:** `feat/m6-s9-net-egress`, tip `8d33be6` (worktree `.worktrees/m6-s9-recover`). **Crash-recovered.**
- **Scope / digest:** `netEgress` is digest-covered, but golden `planId` / `idempotencyKey` / `planDigest` **did not rotate** (additive optional field).
- **Findings:** 2× P3 → M6-GATE triage.

## S10 — `capability_denied` e2e + out-of-scope quarantine fixture · PR #218 · merge `f324145`

- **Goal:** end-to-end proof that an out-of-scope `write_file` (target `docs/out-of-scope.txt` against a bundle granting `src/**`,`test/**`) is **denied**, leaves no file on disk, and writes a kernel-signed `capability_denied` row.
- **Tier:** L2 test-infra (2-role). **Verdict:** clean. **No enforcement bug found.**
- **Workspace:** worktree branch `worktree-agent-a756eaf1c9bc85e60` → `feat/m6-s10-capability-denied-e2e` (`257c1cd..eadc368`). No changeset.
- **Verification:** real native binary, 1/1 green, 0 retries; real `createToolRegistry` denies the write; kernel-signed row verifies (`actor_id=kernel` / `key_id=kernel-main` / ed25519) carrying tool + target + `bundle_digest` + scope reason. Mirrors `operator-envelope.test.ts` (no `process.chdir`).

## S11 — crash-injection guard + crash-resume ledger-integration test · PR #224 · merge `02ad88d`

- **Goal:** add a crash-injection hook (`BUILDPLANE_CRASH_AFTER_ACTIVITY`, no-op by default) + a crash-resume ledger-integration test proving exactly-one `plan_receipt` and dedup on `idempotency_key`.
- **Tier:** L1/L2. **Verdict:** Reviewer PASS.
- **Workspace:** `feat/m6-s11-crash-resume`, tip `81f7ea8` (worktree `.worktrees/m6-s11-recover`). Cut pre-S8; edits confined to the loop FSM so `run-cli.ts` auto-merged. **Crash-recovered.**
- **Verification:** write-ahead ordering (flush-before-`process.exit(137)`) confirmed correct; Property-1 assertions tightened to `toBe(137)` and exactly-one `activity_completed`; exactly-one `plan_receipt`, dedup on `idempotency_key`. No changeset.

---

## Cross-slice notes

- **Merge policy:** all nine rode the required CI `verify` + `Analyze` checks; merge-on-green is operator-authorized for this milestone. Mergify was intermittently unreliable (dequeued clean PRs after label cycles) → several were direct gh-merged on green, which is the same authorized outcome.
- **Local `main` FF discipline:** worktrees cut from local/origin HEAD, so local `main` was fast-forwarded after each remote merge before cutting new slices (e.g. `257c1cd`→`f324145`).
- **Pre-existing flakes (NOT M6 regressions):** the `process.chdir` isolation-race canary (`test/ledger-integration/cwd-isolation.test.ts`) passes 3/3 alone; `published-bootstrap-stage.test.ts` hangs outside vitest `testTimeout` (npm pack / execFileSync) — CI `verify` is the canonical closure gate.
- **S6 pre-flight** (#227 `ba49394`, fixtures diff-scope + `--model` threading) merged separately; the **S6 live dogfood run itself remains open** — its 2026-07-01T02:10Z fire terminated `acceptance-fail` honestly (Claude worker rejected by a subscription 429; 6 correctly-ordered signed events on the tape) and is re-fireable per the plan's S6 runbook.

## Blockers carried forward to M6-GATE

- `globIsSubset` wildcard-middle admission decision (S4 → S6-prep; Option A/B).
- S7 emit amendments: gate `result_ready` on the terminal outcome (not `recordAcceptance` resolving `passed`); cover all 3 terminal branches of `applyOperatorDecisionSideEffect`; resolve the `RunCompletedV1` U64→`number` vs `string` conflict **before** the RED test.
- Operator items O1–O5 (expired `RELEASE_TOKEN`, missing `NPM_TOKEN`, repo `private:true` + one-time full-history secret scan, quota window, `gsd2`-bin decision) — see the 2026-07-01 plan.
