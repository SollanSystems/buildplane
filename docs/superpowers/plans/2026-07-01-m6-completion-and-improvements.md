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
