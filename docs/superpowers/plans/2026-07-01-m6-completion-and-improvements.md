# M6 Completion + Improvements Plan — post-assessment

**Date:** 2026-07-01
**Basis:** full-repo assessment (8-dimension adversarially-verified review) at `main` tip `ba49394`.
**Amends:** [`2026-06-29-m6-v05-demo.md`](./2026-06-29-m6-v05-demo.md) — the M6 plan stands; this doc records contract amendments, new blocking facts, and the improvement backlog discovered by the assessment. Conventions unchanged (see the M6 plan header).

---

## Ground truth at assessment time

- M6 slices **S1–S5, S8–S11 merged** (#213–#227). Remaining: **S6 → S7 → S12 → S13 → M6-GATE**.
- The **S6 live dogfood run was fired 2026-07-01T02:10Z and terminated `acceptance-fail`** — root cause: the Claude worker subprocess was rejected by a five-hour subscription rate limit (429, 0 tokens, 0 turns). The failure was recorded honestly and fully signed on the tape (6 events, correct write-ahead order). Git/worktree state is clean at `ba49394`; nothing was pushed. The run is re-fireable.
- The tape recorded `acceptance_recorded outcome=passed` (empty diff → contract trivially passed) followed by `plan_receipt outcome=failed` (policy layer rejected on raw exit code 1). This live pair is the proof case for the S7 amendment below.

## Blocking facts discovered (operator items)

| # | Item | Evidence |
|---|---|---|
| O1 | **`RELEASE_TOKEN` PAT expired** (created 2026-05-28; failures start 2026-06-28). Every "Create Release PR" run since fails at checkout; the 8 pending changesets have produced no version PR. Blocks S13 completely. | `gh run list --workflow release.yml`: last success 2026-06-23 |
| O2 | **`NPM_TOKEN` secret does not exist.** Required by the S13 publish step. | `gh secret list` |
| O3 | **Repo `SollanSystems/buildplane` is `private:true`** — S13's file list never flips visibility; the README curl installer 404s for the public and "genuine public cut" is unmet. Add an explicit **repo→public** step to S13/M6-GATE, preceded by a one-time full-history secret scan (gitleaks/trufflehog) since going public exposes all history. | `gh api repos/SollanSystems/buildplane` |
| O4 | **Quota sequencing:** the S6 worker runs on the same subscription five-hour window as interactive sessions. Fire the dogfood at a window boundary / quiet period, or thread an API-key path. | dogfood 429 log |
| O5 | Decisions: ship or drop the **`gsd2` bin** from the published `apps/cli` at S13; **`memory/` + root `AGENTS.md`** — commit or gitignore. | apps/cli/package.json `bin`; `git status` |

## S6 re-fire runbook (unchanged scope, new mechanics)

1. Land the **R1 loop-robustness slice** first (below) so a second infra failure is correctly labeled — optional but recommended.
2. Clear the absorbing terminal state: delete (or strip `terminal` from) `.worktrees/m6-s6-result-ready-dogfood/.buildplane/loop-state.json` (`nextLoopState` returns `prev` when `prev.terminal` — a bare re-invocation is a no-op).
3. Re-authorize the envelope — the previous one **expired 2026-07-01T14:02Z** (`bp planforge authorize-envelope`, same `native/**`-safe path_globs sidestep for the `globIsSubset` wildcard-middle limitation).
4. Native binary: the worktree has no `native/target/` — export `BUILDPLANE_NATIVE_BIN=/mnt/c/Dev/projects/buildplane/native/target/debug/buildplane-native` or `pnpm native:build` in the worktree.
5. Fire: `pnpm buildplane planforge loop --once --max-turns 40 --wall-clock-ms 3600000 --model claude-opus-4-8` (threading proven end-to-end by the failed run's session log).
6. On worker success: **ceremony hold** exactly per the M6 plan §M6-S6 (push branch → DRAFT PR → L0 4-role at head SHA → admin-merge). Duplicate-`plan_receipt` check: before firing, confirm the primary dispatch path gates on `planForgeReceiptExists` the way resume/recover does (deterministic idempotencyKey ⇒ same runId on re-fire).

## S7 contract amendments (lock BEFORE dispatch — supersede plan resolutions 7/8 details)

1. **Gate `result_ready` on the run's terminal outcome, not on `recordAcceptance` resolving `passed`.** The planned injection point (~orchestrator.ts:799, inside the per-attempt retry loop) fires before `policy.evaluateRun` decides pass/retry/reject — the dogfood run proves a run can record `acceptance passed` and still terminate `failed`. Emitting there signs a false fact onto the L0 tape. Emit only after the terminal advance/passed decision.
2. **`run_completed` must cover all 3 terminal branches** of `applyOperatorDecisionSideEffect` (merge+approved ~:425, resume+rejected ~:386-389, and the third `markOperatorDecisionExecuted` site), not just merge+approved — or refactor to a single exit point.
3. **Resolve the U64 conflict before writing the RED test.** The plan asserts `RunCompletedV1.{duration_ms,event_count,unit_count}` map to **string**; reality: `typeshare.toml` maps `U64 = "number"` globally and checkpoint/model_io payloads already ship `U64` on signed tapes — flipping the global mapping is a wire-shape/tape-migration hazard. Options: (a) per-field string serialization for `RunCompletedV1` only (verify no `run_completed` was ever emitted on any real tape first), or (b) keep `number` + amend the plan's assertion with an explicit 2^53-range rationale. Decide, then dispatch.

## New improvement slices (from confirmed findings)

| ID | Slice | Tier | What |
|---|---|---|---|
| R1 | Loop terminal-reason fidelity + reset | L2 · 2-role | Add a `dispatch-error`/infra terminal reason distinct from `acceptance-fail` (worker produced no side effects + non-zero exit); thread `decision.reasons` into the terminal detail (today a hardcoded string at run-cli.ts:5066-5074); add `planforge loop --reset` (or document manual state-clear). |
| R2 | Wire `recoverPendingDecisions` | L1 · 2-role | The M5-S4 crash reconciler has **zero production call sites** (verified: interface decls + tests only). Wire into startup (mission-control-server boot and/or `bp web`/`planforge recover`), and add per-item try/catch in the loop (orchestrator.ts:2173-2184) so one bad record can't wedge the batch. |
| R3 | Mission-control origin guard | L2 · 2-role | Read API is fully unauthenticated with no Host/Origin check (router.ts:202-242) → DNS-rebinding reads; add a Host/Origin allowlist in `dispatch()` + generic 500 bodies (index.ts:172-177 leaks `error.message`). |
| R4 | CI generated-TS freshness | L3 · self | CI freshness-checks only `fixtures/payload-variants.json`; add `pnpm ledger:gen && git diff --exit-code packages/ledger-client/src/generated` (CLAUDE.md's own step 6/9 is unenforced). Also fix `payload-drift.test.ts` — its `never`-exhaustiveness claim doesn't type-check as claimed (`Object.keys` widens to `string`). |
| R5 | Broker scope documentation | L3 · self | The M3 write_file/run_command fail-closed gate engages only on command-executor packets (run-cli.ts keying off `packetUnknown.execution`); model/claude-code packets rely on M4 post-hoc diff-scope. Document in CLAUDE.md + capability-broker.md (matches the demo's honest Property-2 scoping; enforcement extension is post-v0.5). |
| R6 | Hygiene batch | L3 · self | Commit M5+M6 spec/plan + M2-S1 plan docs (tracked receipts already cite them); author M6 slice receipts from `.superpowers/sdd/progress.md` before it's lost; update CLAUDE.md (M6 row says "planned/no spec" — 10 PRs stale; add M6 archive ¶); README refresh at S13 (no PlanForge/M3/M4/M5 mention, no license); disclose the 43.75% reviewer-rescue benchmark as a known limitation; prune 52 `[gone]` local branches + confirmed-merged worktrees (**never** `.worktrees/m6-s6-result-ready-dogfood`). |

Deferred/low (backlog, post-v0.5): `stableAdmissionJson` nested-`undefined` handling (pre-M1 sidecar digest only); `globIsSubset` wildcard-middle fix (Option A/B — currently sidestepped by exact envelope globs); broker enforcement on the model-packet path; codex reviewer bar.

## Sequencing

```
Phase 0 (operator, now): O1 RELEASE_TOKEN → O2 NPM_TOKEN → O5 decisions   [O3 repo-public lands with S13]
Phase 1 (parallel, small): R1 · R6(docs commits + receipts) · S7 amendments locked (plan edit)
Phase 2 (critical path): S6 re-fire (runbook above) → 4-role ceremony → admin-merge
Phase 3: S7 (amended) — L0 4-role                     ∥ Phase 4: R2 · R3 · R4 · R5
Phase 5: S12 demo runner → operator-watched live demo run
Phase 6: S13 (amended: + repo→public + secret-scan + NPM_TOKEN guard + gsd2 decision + README) → M6-GATE
```

M6-GATE SC1–SC5 unchanged; add to the receipt: the O1–O5 resolutions, the S7 amendment rationale (the live acceptance-passed/receipt-failed pair), and the R1–R6 dispositions.

---

## Completion ledger — 2026-07-02 (loop `m6-completion`, terminal `FailedBlocked` at the operator wall)

Executed via the loop-engineer repo-OS contract at `.superpowers/loops/m6-completion/` (10 iterations, 6 Workflows; per-iteration evidence in its RUNLOG.md/TASKS.json). Every autonomously completable item in this plan is DONE; the remainder is operator-only.

**Blocking facts (operator items):**
- O1 `RELEASE_TOKEN` — **operator-pending** (instructions in loop TASKS.json).
- O2 `NPM_TOKEN` — **operator-pending**.
- O3 repo→public — **secret scan DONE** (gitleaks full history `--log-opts=--all`, 1001 commits, **0 findings**; report `.superpowers/loops/m6-completion/.loop/artifacts/gitleaks.json`); the flip itself is **operator-pending** and lands with S13.
- O4 quota sequencing — superseded by events: the real dogfood blockers were permissions + timeout, fixed by R7 (#233).
- O5 — **DECIDED + applied**: gsd2 bin dropped at S13 (#238); `AGENTS.md` + `memory/` gitignored (#229).
- O6 *(new, found by S13 review)* — `changeset publish` targets the unvendored `apps/cli/package.json` (14 `workspace:*` deps); wire the `stage-package.mjs` vendored artifact before the first npm publish. **Operator-pending / follow-up slice.**

**S6 re-fire runbook:** executed — attempts 2 (worker permission gap, run `5b3c4a6d`) and 3 (50-min budget insufficient; wall-clock teardown didn't persist terminal — minor defect logged) are honestly on the tape; attempt 4 was classifier-held for explicit operator authorization. **Fallback taken per §7/SC3: ceremony-build** → DRAFT **PR #235** (`5871b7a`), **L0 4-role unanimous PASS**, operator-merge-held.

**S7 contract amendments:** all three **LOCKED** into the M6 plan (committed via #229) and **IMPLEMENTED**: A1 terminal-outcome gating (negative case tested against the live dogfood pair), A2 all-3-branches `run_completed` (single exit), A3 = option (a) per-field string on `RunCompletedV1` (evidence: `run_completed` count 0 on the only real tape). → DRAFT **PR #237** (`e24304e`, stacked on #235), **L0 4-role unanimous PASS after one repair round** (the ceremony additionally caught and fixed an emit-after-marker durability hole beyond this plan's own prescription), operator-merge-held.

**Improvement slices:** R1 **MERGED** #228 `eb7b2ec` (scope grew a receipt-dedup dispatch gate from the S6 preflect finding) · R2 **MERGED** #232 `0f1b42e` · R3 **MERGED** #234 `790ff11` · R4 **MERGED** #231 `9ec2bda` · R5 **MERGED** #230 `430f482` · R6 **MERGED** #229 `1fbacf4` · R7 *(new: worker `--allowedTools` grant, executor timeout threading, `--reset` trustedBase re-seed)* **MERGED** #233 `9075722`.

**Sequencing phases 0–6:** Phase 0 partially operator-pending (O1/O2); Phases 1–4 **complete and merged**; Phase 5 S12 **staged** (#236, CI green; watched demo = operator); Phase 6 S13 **staged** (#238, CI green, review PASS, merge LAST); **M6-GATE receipt = the one remaining authoring task**, blocked only on the operator merges (it must record real merge SHAs; the loop's resume rule picks it up).

**Operator queue (order):** merge #235 → #237 → #236 · O1 + O2 · merge #238 (resolve O6 before the version-packages PR) · O3 flip · watched demo (`node scripts/run-demo.mjs`, runbook `docs/operations/2026-07-02-m6-demo-runbook.md`) · publish + tag v0.5.0 · author M6-GATE receipt.

### Queue execution addendum — 2026-07-02 (operator-authorized session)

The operator authorized queue execution ("execute the plan"). Merge train complete, all via undraft + admin-squash-merge on green required checks:

- **#235 → `b197580`** — pre-merge, CI verify was RED (not the tally's "CI-green"): the run-inspector doc-contract test pins the event vocabulary to the generated `EventKind` enum, and S6 added `result_ready` without the doc line. Fixed docs-only at `8393334` (delta from ceremony SHA `5871b7a` = +1 vocabulary line; L3 self-review, noted on the PR).
- **#237 → `fb96406`** — after retarget to main, the GitHub merge-ref duplicated `ResultReadyV1` (squash-vs-stack three-way artifact; E0428 at the fixtures-freshness step). Rebased #237's two own commits onto main → head `39e538f`, `git diff e24304e 39e538f` EMPTY (byte-identical to the L0-ceremony tree; verdict transfers). CodeQL `Analyze` required a close/reopen to trigger on the main base (it never runs on stacked PRs).
- **#236 → `8657730`** · **#238 → `a22712f`**.
- **O6 → RESOLVED**: PR #239 → `a15d9ec` (`release:publish` publishes the `stage-package.mjs` vendored artifact via new `scripts/published-bootstrap/publish-npm.mjs`; emits the changesets `New tag:` line; NPM_TOKEN guard intact). Residual: confirm the release job has a Rust toolchain for `pnpm native:build` at the first publish (fails loud if absent).
- **Demo staged**: main built (TS + native), `node scripts/run-demo.mjs --dry-run` exit 0. Live run remains operator-watched per the runbook's LOCKED gate.
- **Still operator-only:** O1 `RELEASE_TOKEN` (release.yml failing at checkout — 3 more failures 2026-07-02), O2 `NPM_TOKEN` (absent), O3b repo→public (note: GitHub reports 8 dependabot alerts — 3 high — review before flipping), watched demo, publish + tag v0.5.0, then the M6-GATE receipt (this ledger rides that commit).

**2026-07-03 continuation:** version-packages PR opened manually as a stand-in for the token-blocked changesets action and **merged → `3edbd99`** (buildplane 0.13.0; consumed 15 changesets). It surfaced a latent S13 defect: `release-public-cut.test.ts` asserted a *pending* buildplane changeset exists, an invariant every version PR necessarily breaks — made state-aware (pending-changeset check pre-cut, applied-version ≥ 0.13.0 floor post-cut). Dependabot bumps **merged → `236dddf`** (ws 8.21.0 runtime-high, vite 8.0.16, js-yaml exact patched pins; esbuild LOW deliberately skipped — forced 0.27→0.28 under vite is disproportionate risk); open alerts 8 → 1. Publish is now fully staged: once O1+O2 secrets exist, a release.yml re-run publishes the vendored 0.13.0 artifact and creates the tag/GitHub release.

**2026-07-05 Codex continuation:** local `main` fast-forwarded to `origin/main` → `3c0c348`; the remaining gate-finding fixes are now merged: #242 `74dc5f1` (demo watched-run fixes), #243 `e7b6af6` (dispatch-path tool events), #244 `3c0c348` (fail-closed resume/recover). Gate receipt draft updated with real merge SHAs. Verified GitHub state: repo still `PRIVATE`, no `v0.5.0` tag/release, latest `release.yml` run still fails at checkout. Root cause refined: the workflow fallback used `secrets.GITHUB_TOKEN`, which is empty; patch fallback to `github.token` for the absent-token case. `gh secret list` shows `RELEASE_TOKEN` exists but is not usable, and `NPM_TOKEN` is absent, so the stale PAT still must be replaced or removed before rerunning release. Still operator-only: configure `RELEASE_TOKEN` + `NPM_TOKEN`, rerun release, flip repo public, publish/tag `v0.5.0`, then finalize M6-GATE.

**2026-07-07 Hermes continuation:** re-grounded from `origin/main` → `3c0c348` (local `main` equal to remote; no open PRs). Live GitHub state still blocks the gate: repository is still private, latest `release.yml` run `28724343218` fails at checkout while using the stale `RELEASE_TOKEN`, `gh secret list` shows `RELEASE_TOKEN` only (no `NPM_TOKEN`), and there is still no `v0.5.0` tag or GitHub release. Local fix tightened the release workflow fallback to `github.token`, added a regression assertion rejecting `secrets.GITHUB_TOKEN` in the workflow, and refreshed the active CLAUDE.md gotcha so future agents do not repeat the stale fallback. Verified: `pnpm exec vitest --run test/workflow/release-public-cut.test.ts`, `pnpm typecheck`, `pnpm lint`, and `git diff --check` all exit 0. Remaining operator-only wall is unchanged: replace/remove stale `RELEASE_TOKEN`, add `NPM_TOKEN`, rerun release/publish/tag, flip repo public, then finalize M6-GATE.
