# Buildplane Self-Build Loop — Design

> **Date:** 2026-06-22 · **Status:** approved (2026-06-22) · **Targets:** M5 (first slice queue) → M6 (dogfood demo centerpiece)
> **Plan:** [`docs/superpowers/plans/2026-06-22-buildplane-self-build-loop.md`](../plans/2026-06-22-buildplane-self-build-loop.md)

## Goal

Run a **long-horizon (day+), unattended build loop where Buildplane builds Buildplane** — dispatching a coding worker against its own repo through the `planforge admit` path, each slice in a fresh isolated worker context, with the signed L0 tape as the durable handoff and S7 resume + a supervisor providing day+ liveness.

This is the operator's stated dogfooding fork made real: *"the last features of this tool were built and verified by this tool."* The loop's first slice queue **is** the existing 8-slice M5 (Web Mission Control) plan, so the dogfood loop and roadmap progress are the same work.

## The reframe

We are **not** building a wrap-up/clear/continue harness around Claude Code. Buildplane is already a "bounded workers in fresh contexts advancing on durable state" engine. The three behaviors the operator asked for map onto primitives that mostly already exist:

| Behavior | Buildplane primitive | State |
|---|---|---|
| **clear context / clean session per unit** | `prepareWorkspace` cuts a fresh `git worktree add --detach` per run (`packages/adapters-git/src/worktree-adapter.ts:167`); `ClaudeCodeExecutor` spawns a fresh `claude -p` subprocess per unit, no reuse (`packages/adapters-models/src/claude-code-executor.ts:135`) | ✅ **native** |
| **auto wrap-up** | signed `plan_receipt` L0 event chains to `plan_admitted` (`packages/planforge/src/receipt.ts`); `extractLearnings`→`writeLearnings` (`packages/kernel/src/orchestrator.ts:1277`); `commitAndMergeWorkspace` squash-merges (`worktree-adapter.ts:195`) | 🔶 partial (no cross-unit summary read into the next worker) |
| **continue building** | `planforge resume --input` replays `activity_completed`+`plan_receipt`, skips completed tasks, re-dispatches the suffix, re-establishes `will_execute_worker` trust from the tape (`apps/cli/src/run-cli.ts:4100`) | 🔶 partial (no auto-recovery, no multi-plan driver, no `priorWork`) |

So the work is **closing a confirmed gap set** so Buildplane can (a) authorize source edits, (b) run a real coding worker, (c) keep advancing across a day+ unattended, (d) do so safely within an operator-authorized envelope.

All gaps below were confirmed against the source by an adversarial verification pass (file:line evidence in the grounding workflow `wf_23b09161-744`). The pass corrected one first-draft assumption — see **GAP-4**.

## Locked decisions

1. **Build straight to the unattended day+ loop** (not phased). De-risking comes from a runtime `--once` mode (below), not from splitting the build.
2. **Supervisor is a first-class CLI command** `buildplane planforge loop` (state in `loop-state.json`), shipped as product surface with tests/CI — not an external shell script.
3. **Tape-reading planning worker chooses the next slice** each iteration (not a static queue) — bounded by the authorization envelope.
4. **Non-optional guardrails** (consequence of choices 1–3):
   - **`--once` / `--max-iterations=N` runtime mode.** The finished loop's *first* execution runs exactly one slice end-to-end and stops. Cheap validation of the worker path without a separate build phase.
   - **Loop authorization envelope** (GAP-10). Operator authorizes one bounded envelope up front; planner proposals auto-admit only inside it; outside → pause for approval. Preserves M2's "a human authorizes admission" — the human authorizes the boundary once.
   - **Hard runaway guard.** Lowered `--max-turns` + hard wall-clock cap + a token-delta emit path so the budget `AbortController` (`orchestrator.ts:1553`) actually fires for the Claude Code executor (today it never does — that executor emits no `model-token-delta`).

## Architecture

### One loop iteration
```
planning worker  →  plan.md  →  planforge dry-run (compile→validate→preview)
   (GAP-9)                          │
                                    ▼  (envelope check, GAP-10)
                          planforge admit  ──emit──►  plan_admitted (signed L0)
                                    │
                                    ▼
                          planforge dispatch  →  fresh worktree + fresh claude -p  →  edits src/
                                    │                         (code-edit bundle, GAP-1)
                                    ▼
                          M4 acceptance gate (dep-provisioned, GAP-3; --enforce-acceptance ON)
                                    │  pass
                                    ▼
                          commitAndMergeWorkspace  →  plan_receipt (signed L0)  →  plan summary → priorWork (GAP-5)
                                    │
                                    ▼  re-anchor HEAD (GAP-8)
                              supervisor advances (GAP-7) / resume on crash (GAP-6)
```

### Two layers of durable state
- **Kernel layer:** the signed L0 tape (`events.db`) — authoritative over storage status. `plan_admitted` / `activity_started` / `activity_completed` / `acceptance_recorded` / `plan_receipt`. Survives crashes via `bp-replay`.
- **Supervisor layer:** `loop-state.json` FSM (current iteration, envelope ref, terminal condition, last-merged HEAD). Written atomically after each transition so a crash in the supervisor itself is resumable — analogous to what `events.db` is for the kernel.

## Gap set (confirmed) and build order

Each gap is its own slice under the existing tiered review ceremony. **GAP-1 touches the capability-bundle trust surface → full L0 ceremony, ships isolated, first.**

| # | Title | Effort | Key files |
|---|---|---|---|
| **GAP-1** | `code-edit` side-effect vocab → `src/**`,`test/**`,`packages/**/src/**`,`packages/**/test/**` globs + bundle mapping | small | `packages/planforge/src/schema.ts`, `bundle.ts`, `validate.ts`, `test/bundle.test.ts`, `apps/cli/test/planforge-schema.test.ts` |
| **GAP-2** | Dynamic task generation from a `## Tasks` Markdown section (replace hardcoded PF1/PF2) | medium | `packages/planforge/src/compile.ts`, `preview.ts`, `schema.ts`, fixtures |
| **GAP-4** | Real coding-worker command. **Correction:** the router sends any packet with an `execution` field to the command executor *before* checking `preferredWorker` (`run-cli.ts:1436`), so `execution.command='true'` must be **removed entirely**, not supplemented. Set `preferredWorker='claude-code'`, populate `TaskIntent`, add `claude` to the run_command allowlist | small | `packages/planforge/src/dispatch.ts`, `schema.ts`, `test/dispatch.test.ts` |
| **GAP-3** | Worktree dep provisioning (`pnpm install --frozen-lockfile`) before acceptance checks → flip `--enforce-acceptance` default-ON | small | `packages/kernel/src/orchestrator.ts`, `apps/cli/src/run-cli.ts`, `dispatch.ts` |
| **GAP-8** | Serial worktree re-anchor: capture HEAD *after* each merge, use as next unit's base + assertion in `prepareWorkspace`. Also closes the diff-scope stale-base risk (PR #198) | small | `packages/adapters-git/src/worktree-adapter.ts`, `apps/cli/src/run-cli.ts` |
| **GAP-6** | Startup scan for orphaned `running` runs → replay tape → auto-resume (the S7 clause documented but uncoded) | medium | `packages/kernel/src/orchestrator.ts`, `packages/storage/src/store.ts`, `apps/cli/src/run-cli.ts`, `cli-main.ts` |
| **GAP-5** | `priorWork` handoff: write a structured plan summary after `plan_receipt`; inject it into the next worker's `TaskIntent.context.priorWork` | medium | `apps/cli/src/packet-enrichment.ts`, `run-cli.ts`, `packages/storage/src/store.ts`, `packages/kernel/src/types.ts` |
| **GAP-9** | **Planning worker** (added by "planner now"): a bounded worker that reads the tape + roadmap and emits the next slice's `plan.md`; output must pass `planforge validate` before admission | large | new role/executor wiring in `apps/cli`, `packages/adapters-models` |
| **GAP-10** | **Authorization envelope** (added by "unattended + self-directing"): operator authorizes a bounded envelope once via a signed `operator_decision_recorded` event (the M5 primitive); supervisor auto-admits only inside it, pauses outside. Built on `packages/policy` approval profiles | medium | `packages/policy`, `apps/cli/src/run-cli.ts`, ledger payload |
| **GAP-7** | **Supervisor** `buildplane planforge loop`: FSM over `loop-state.json`; `dry-run`→`admit`→`dispatch`→(`resume` on crash); invokes the planner for the next slice; `--once`/`--max-iterations`; stops on terminal condition / `.stop` / acceptance-FAIL / envelope breach | large | `apps/cli/src/run-cli.ts`, `cli-main.ts` |

**Build order:** GAP-1 → GAP-2 → GAP-4 → GAP-3 → GAP-8 → GAP-6 → GAP-5 → GAP-9 → GAP-10 → GAP-7. (Trust surface first; worker can edit+verify; multi-iteration safety; auto-recovery; cross-unit context; envelope; planner; supervisor integrates all. The first run of the completed loop uses `--once`.)

## Planning worker (GAP-9) — trust boundary

The planner proposes; the **admission cycle gates**. A proposed slice is dispatched only if it:
1. is sourced from a **bounded roadmap input** (the milestone map / roadmap doc + tape state), not free-invented;
2. passes `planforge validate` — evidence completeness, the `forbiddenGoalIntent` guard, side-effect allowlist;
3. falls **inside the authorization envelope** (GAP-10);
4. declares `code-edit` (only) and lists real `verificationCommands` (`cargo test`, `pnpm vitest`, `tsc`).

Anything failing 1–4 → the loop **pauses for operator approval**, it does not proceed.

## Authorization envelope (GAP-10) — reconciling M2 with unattended autonomy

M2's admission cycle requires `planforge admit --approve --operator <id>` — a human checkpoint per plan. An unattended self-directed loop cannot stop for that per-slice. Resolution: the operator authorizes a **one-time bounded envelope**, recorded as a signed `operator_decision_recorded` L0 event:

```
envelope := { milestone, allowed_side_effects: ['code-edit'], path_globs,
              max_iterations, token_budget, allowed_verification_cmds, expires_at }
```

The supervisor auto-admits a planner proposal iff it is a subset of the envelope; otherwise it pauses. The human still authorizes admission — they authorize the boundary, once, signed and on-tape.

## Risks & guardrails

| Risk | Source | Guardrail |
|---|---|---|
| **False completion** | `ClaudeCodeExecutor` exit-0 normalization (`claude-code-executor.ts:207`) passes if expected output files merely exist | `verificationCommands` must carry real assertions (`cargo test`/`pnpm vitest`), never just `tsc --noEmit`; non-trivial `expectedOutputs` |
| **Runaway worker** | No mid-stream token gate; budget `AbortController` listens for `model-token-delta` the Claude executor never emits; only 300s wall-clock | Lowered `--max-turns`; hard wall-clock cap; **token-delta emit path** parsing the streaming JSON so the budget guard fires |
| **Mid-unit context exhaustion** | Large codebase context + long objective overflows the session; resume re-runs the same full task forever | Keep per-task scope narrow (one file/boundary); restrict `context.files`; explicit scope constraints in `TaskIntent` |
| **WSL / broken Apex worktree** | bare `git status`/`git add -A`/`git checkout` fatal | All git path-scoped (`git -C <path> … -- <paths>`); never bare from workspace root |
| **Acceptance false-positive / diff-scope** | stale base if next worktree cut before prior merge recorded (PR #198 class) | GAP-8 re-anchor: capture `baseSha` **after** `commitAndMergeWorkspace` resolves, atomically |
| **U64 / digest trap** | any new signed loop-telemetry event kind | `u64→string` typeshare; full derivation (kind.rs→payload→mod.rs→canonicalize.rs→TS union hand-edit→`ledger:gen`+`gen-fixtures`→byte-stable diff→**workspace-wide** `cargo test` for exhaustive match) |
| **`plan_receipt` partial-flush crash** | crash between `emit` and `flush` (`run-cli.ts:4060`) leaves a partial event resume won't match → double receipt | idempotency/dedup guard on the append keyed on `idempotency_key` |
| **`forbiddenGoalIntent` over-block** | `validate.ts:21` matches `run commands?` → benign self-build goals rejected `UNSAFE_TO_RUN` | Narrow the regex to truly-unsafe phrasings; planner phrases verification via declared `verificationCommands` |

## Out of scope / non-goals
- Codex worker path (Claude Code executor is the loop worker; Codex stays for adversarial review).
- Outcome-routing memory (frozen, default-OFF — not consumed by this loop).
- Push/deploy from inside the loop — `commitAndMergeWorkspace` merges to local project root only; remote push stays operator-gated.
- Kernel-level `RunAdmission` capability-grant extension (`admission-receipts.ts`) — the PlanForge-attached-bundle path is the loop's authorization surface; the kernel grant path is parallel and untouched unless the loop later routes through it.

## Open questions (resolved 2026-06-22)
- **First-run target slice for `--once`:** ✅ **M5-S1** (already specced). The completed loop's first execution runs M5-S1 end-to-end and stops.
- **Planner roadmap source of truth:** ✅ **a dedicated machine-readable roadmap file** (not `CLAUDE.md` prose, not the M5 plan doc). GAP-9 designs its path + shape and the planner reads `## Tasks`/slice intent from it. This is the bounded roadmap input that the planner's proposals are gated against.
