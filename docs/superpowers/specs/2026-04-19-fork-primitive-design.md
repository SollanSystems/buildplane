# Fork Primitive — Phase E Design

**Date:** 2026-04-19
**Status:** Approved (pending written-spec review)
**Sub-project of:** Buildplane replayable-ledger roadmap, Phase E of the decomposition in `docs/strategy/buildplane-positioning.md`.
**Builds on:**
- Phase A (PR #59) — `bp-ledger`
- Phase B (PR #60) — TS tape emitter
- Phase C (PR #61) — tool instrumentation
- Phase D (PR #62) — replay + wiring

## 1. Goal & Scope

### Goal

Ship `buildplane fork <run-id> --at <event-id> --packet <file>` — a re-execute fork that rehydrates the parent run's workspace state at a unit boundary, emits a new run with `parent_run_id` pointing at the original, and runs a new packet from there. The new run produces a fresh tape with lineage preserved. Defers tool-output VCR to Phase F.

### In scope

1. **`buildplane fork`** TS CLI top-level subcommand dispatching to a new `buildplane-native fork plan` native subcommand. Args: `--run-id <parent>`, `--at <unit-start-event-id>`, `--packet <new-packet.json>`, `--workspace <absolute path>`.
2. **`bp-fork` Rust crate** (sibling to `bp-replay`):
   - Opens parent's `events.db`, fast-forwards `ReplayEngine` to the target.
   - Validates target is a `unit_started` event; otherwise errors with the nearest unit_started suggestion.
   - Extracts the pre-unit `git_checkpoint` SHA for that unit from `ReplayState.checkpoints`.
   - Generates a fresh UUIDv7 run_id.
   - Reads + validates the new packet file.
   - Returns a `ForkPlan { new_run_id, workspace_path, checkout_sha, packet_json, parent_run_id, parent_event_id }` as stdout JSON.
3. **Fork execution path in `run-cli.ts`**:
   - Parses ForkPlan.
   - Pre-flight: clean-worktree check.
   - `gitInWorkspace(workspace, ["checkout", checkout_sha])` — moves HEAD to the pre-unit tree.
   - Spawns ledger for the new run_id.
   - Emits `run_started` with `RunStartedV1 { parent_run_id: Some(parent), git_head: checkout_sha, ... }`.
   - Runs orchestrator with the new packet; Phase D's wiring produces the full event sequence.
   - Emits `run_completed` / `run_failed`, closes ledger.
   - Prints "HEAD is at fork tree <sha>; run `git checkout <branch>` to restore" exit hint.
4. **Lineage surfacing in `bp-replay`**:
   - `ReplayState` gains `parent_run_id: Option<String>`, populated from `RunStartedV1.parent_run_id`.
   - `bp-cli ledger replay --format human` shows "forked from <parent-id> at <event-id>" header when lineage present.
5. **Integration tests**: `fork-basic.test.ts`, `fork-invalid-target.test.ts`, `fork-same-packet.test.ts`.
6. **Phase F `.skip` stubs**: `fork-vcr-basic.test.ts`, `fork-vcr-fallback.test.ts`, `fork-vcr-diff.test.ts`.
7. **`docs/ledger.md`** — Fork section with the `--packet required today` honest limit.

### Out of scope (Phase F or later)

- **VCR mode (`--vcr`).** Forked tool calls always re-execute. Phase F adds tape-replay of tool outputs, Rust-side CAS population, and the "match rule" for tool-call equivalence.
- **Fork without `--packet`** (parent packet retrieval from CAS). Requires Phase F's CAS population.
- **Mid-unit forking.** Only unit boundaries.
- **Cross-run replay** walking from child to parent.
- **Fork-of-fork chains** — work mechanically, not specifically tested.
- **Worktree isolation** for forks. Fork uses the current workspace.
- **Bisect.** Phase G.

### Success criteria

1. `buildplane fork <parent> --at <unit-start> --packet <new.json>` produces a new run whose events.db has `run_started` with `parent_run_id == parent`. Workspace reflects the new packet's effects.
2. `buildplane ledger replay <fork-id> --format human` shows the lineage header and walks events in causal order.
3. Forking at non-unit-start returns a clear error with suggestion.
4. Forking without `--packet` returns a clean error today.
5. All Phase D integration tests still pass. Canary still passes.
6. Phase F `.skip` test files exist with documented aspirational assertions.

### Non-goals (explicit)

- Fork does NOT guarantee byte-identical re-execution up to the resume point.
- Fork does NOT replay parent's model/tool outputs (that's Phase F's VCR).
- Linux + macOS only.

### Budget

~2.5 weeks focused work.

---

## 2. Architecture

### Component layout

```
┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-fork  (NEW)                                  │
│   src/                                                         │
│   ├─ lib.rs          public API + re-exports                    │
│   ├─ plan.rs         ForkPlan serializable struct               │
│   ├─ planner.rs      build_fork_plan(...) → Result<ForkPlan>    │
│   └─ apply.rs        (Phase F may extend; Phase E trivial)     │
│   tests/                                                       │
│   └─ planner.rs      Layer 1 tests: happy + 5 error cases      │
└────────────────────────────────────────────────────────────────┘
             │
             │ library dep
             ▼
┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-cli  (EXTENDED)                              │
│   src/fork_cli.rs    NEW: ForkArgs + parser + dispatch          │
│   src/main.rs        MODIFY: Command::Fork variant              │
└────────────────────────────────────────────────────────────────┘
             │
             │ subprocess
             ▼
┌────────────────────────────────────────────────────────────────┐
│  apps/cli/src/run-cli.ts  (EXTENDED)                           │
│   New top-level `fork` dispatch:                               │
│     1. spawn `buildplane-native fork plan` → receive JSON      │
│     2. clean-worktree check                                    │
│     3. gitInWorkspace checkout                                 │
│     4. spawn ledger + run orchestrator with new packet         │
│     5. emit run_started with parent_run_id                     │
│     6. close, print HEAD-at-fork hint                          │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-replay  (EXTENDED minor)                     │
│   state.rs: ReplayState gains parent_run_id: Option<String>    │
│   cli: ledger replay header shows "forked from ..."            │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  test/ledger-integration/  (EXTENDED)                          │
│   fork-basic.test.ts, fork-invalid-target.test.ts,             │
│   fork-same-packet.test.ts (active)                            │
│   fork-vcr-*.test.ts (.skip markers for Phase F)               │
└────────────────────────────────────────────────────────────────┘
```

### Data flow

```
$ buildplane fork <parent-run-id> --at <unit-start-event-id> \
    --packet new.json --workspace /abs/path
  │
  ├─ TS CLI: validate args, resolve workspace absolute
  │
  ├─ TS CLI: spawn bp-cli fork plan
  │
  ▼
bp-fork::planner::build_fork_plan:
  1. open bp-replay engine on parent events.db
  2. engine.fast_forward_to(target) → ReplayStep
  3. validate step.event.kind == UnitStarted
     - if not: error with nearest unit_started suggestion
  4. find pre-unit checkpoint in state_after.checkpoints
     - filter by unit_id + boundary == "pre-unit"
     - if missing: error
  5. read packet file bytes, validate JSON
  6. generate fresh UUIDv7 run_id
  7. return ForkPlan JSON on stdout
  │
  ▼
TS CLI (received ForkPlan):
  1. pre-flight clean-worktree check
  2. gitInWorkspace(workspace, ["checkout", checkout_sha])
     (HEAD moves; branch pointer untouched; detached HEAD)
  3. spawn ledger serve for new_run_id
  4. construct orchestrator input from packet_json
  5. emit run_started with RunStartedV1 {
       packet_hash, git_head: checkout_sha, workspace_path,
       config: {}, parent_run_id: Some(parent_run_id),
     }
  6. orchestrator.runPacket/runPacketAsync (Phase D wiring
     handles unit_started, checkpoints, tool events, etc.)
  7. emit run_completed/run_failed
  8. close ledger
  9. print exit hint: "HEAD is at fork tree <sha>; run
     `git checkout <branch>` to restore."
```

### Why top-level `buildplane fork`

- Fork is a write operation; the `ledger` namespace is read-only in user-facing usage (`ledger serve` is an internal primitive).
- Matches `buildplane run` — also a top-level write command.
- `buildplane fork` reads better than `buildplane ledger fork`.

### Workspace + HEAD handling

- **Clean-worktree pre-flight**, same as `buildplane run`. Uncommitted changes abort the fork.
- **HEAD moves to the pre-unit checkpoint SHA** via `git checkout`. The user's branch pointer is not updated (detached HEAD state).
- **On exit**, HEAD is wherever the fork's execution ended up. Exit hint guides the user to restore via `git checkout <branch>`.
- **No automatic restore** — preserves the fork's visible output. Alternative (force-restore) would silently throw away work.

### Key contracts

- **Target must be `unit_started`.** Any other kind returns an error with nearest unit_started suggestion. `run_started` is also disallowed (use `buildplane run` directly).
- **`--packet` is required in E.** Omission errors cleanly; Phase F removes this limit via CAS packet retrieval.
- **Clean worktree pre-flight.** Same as `buildplane run`.
- **HEAD moves, branch doesn't.** Detached HEAD is the correct git-native representation of "you're at the fork's state."
- **Lineage is one-level.** `parent_run_id` points at the immediate parent only. Chains of forks work (each fork has its own parent) but the `run_started` stores one parent.

### What doesn't change

- `bp-ledger`, `bp-ledger-macros`, `@buildplane/ledger-client`, `packages/adapters-tools`: untouched.
- Phase D's `ReplayEngine::fast_forward_to`: untouched. Fork consumes it unchanged.
- Phase C's `runGitCheckpoint`: untouched. Fork's execution produces new checkpoints on `refs/buildplane/run/<fork-id>`.

---

## 3. Testing Strategy

### Layer 1 (Rust) — `bp-fork` tests

`native/crates/bp-fork/tests/planner.rs` — canned parent tape written via bp-ledger + bp-replay:

- **happy path**: target is `unit_started`, returns ForkPlan with correct `checkout_sha`, `parent_run_id`, packet bytes.
- **invalid target — run_started**: error with first-unit-started suggestion.
- **invalid target — tool_request**: error with nearest enclosing unit_started.
- **missing pre-unit checkpoint**: corrupted tape, error without panic.
- **packet file not found**: error with path.
- **packet file not valid JSON**: error with parse location.

Target: ≥90% coverage in `bp-fork`.

### Layer 2 (TS) — dispatch

`apps/cli/test/fork-dispatch.test.ts` — mock native binary, assert arg forwarding + ForkPlan JSON parse + checkout + spawn sequence.

May be skipped if Layer 3 covers adequately.

### Layer 3 (integration)

**`fork-basic.test.ts`** — run parent, fork at unit_started with new packet. Assert:
- Fork's events.db has `run_started` with `parent_run_id == parent`.
- Full Phase A event sequence present for the new packet.
- Workspace reflects the fork packet's effects.
- `git rev-parse HEAD` is the fork's post-unit checkpoint.
- `buildplane ledger replay <fork-id>` works and shows lineage.

**`fork-invalid-target.test.ts`**:
- Fork at `tool_request` → error + suggestion.
- Fork at `run_started` → "cannot fork at root; use buildplane run directly."
- Fork at non-existent event-id → error.

**`fork-same-packet.test.ts`** — omit `--packet`, error cleanly pointing at Phase F.

**`cwd-isolation.test.ts`** (Phase C canary) — still passes.

### Phase F `.skip` markers

**`fork-vcr-basic.test.ts`** (`.skip`):
- Fork with `--vcr`, assert recorded tool outputs from parent are replayed.

**`fork-vcr-fallback.test.ts`** (`.skip`):
- Parent tape missing a tool_result; fallback to re-execute with `ReplayIssue::ToolOutputMissing`.

**`fork-vcr-diff.test.ts`** (`.skip`):
- VCR against a parent canonicalized between schema versions.

Each file has a header comment: "Phase F implements `--vcr`; remove `.skip` in F's implementation."

### Test-isolation discipline

Every integration test uses `makeBuildplaneRunFixture` or a new `makeForkFixture` — both live in tempdirs. No test runs `buildplane fork` in cwd.

---

## 4. Phases + Sequencing

Sequential. Total ~2.5 weeks.

### Phase E.1 — bp-fork scaffold + ForkPlan (2-3 days)

- New `native/crates/bp-fork/` crate with Cargo.toml, lib.rs, module stubs.
- `plan.rs` — `ForkPlan` struct with `serde::Serialize`.
- Add workspace member + dep in `native/Cargo.toml`.

**Demo-able:** crate compiles, stub planner returns a placeholder ForkPlan, JSON serializes.

### Phase E.2 — ForkPlan builder (3-4 days)

- `planner.rs` — `build_fork_plan(parent_run_id, target_event_id, workspace, packet_path)`:
  - Open bp-replay ReplayEngine.
  - Fast-forward to target.
  - Validate unit_started.
  - Extract pre-unit checkpoint SHA.
  - Read + validate packet file.
  - Return ForkPlan.
- Layer 1 tests: happy path + 5 error cases.

**Demo-able:** `build_fork_plan` returns correct ForkPlan for canned tape.

**Gate:** ≥90% coverage.

### Phase E.3 — bp-cli fork plan subcommand (1-2 days)

- New `fork_cli.rs` with `ForkArgs` + parser.
- `fork plan` subcommand: emits ForkPlan JSON on stdout.
- `main.rs` wires `Fork` top-level command.

**Demo-able:** `./buildplane-native fork plan --run-id ... --at ... --workspace ... --packet ...` returns valid JSON.

### Phase E.4 — TS CLI dispatch + fork execution (3-4 days)

- `run-cli.ts` top-level `fork` dispatch.
- Two-phase flow: plan via subprocess → checkout + spawn ledger + run orchestrator + emit lineage.
- Exit hint.

**Demo-able:** `pnpm buildplane fork <parent-id> --at <event-id> --packet new.json --cwd /tmp/ws` produces a new run's events.db with full Phase A sequence.

**Gate:** manual smoke produces populated events.db with `parent_run_id`.

### Phase E.5 — Integration tests + lineage surfacing (2-3 days)

- `makeForkFixture` in `test/ledger-integration/fixtures.ts`.
- `fork-basic.test.ts`, `fork-invalid-target.test.ts`, `fork-same-packet.test.ts`.
- `.skip` stubs for Phase F: `fork-vcr-basic.test.ts`, `fork-vcr-fallback.test.ts`, `fork-vcr-diff.test.ts`.
- `bp-replay::ReplayState` gains `parent_run_id: Option<String>`.
- `bp-cli ledger replay --format human` lineage header.

**Gate:** 3 active integration tests pass; canary passes.

### Phase E.6 — Verification gate + docs (1 day)

- Full test suite: all Rust crates + TS unit + integration.
- Clippy clean.
- Fixture drift clean.
- Real smoke: `buildplane run` → `buildplane fork` → `buildplane ledger replay`.
- `docs/ledger.md` Fork section.
- Spec marker.

**Verification gate:**
- [ ] All test layers green.
- [ ] Canary passes.
- [ ] Phase F `.skip` markers exist with clear comments.
- [ ] Real fork produces populated events.db with lineage.
- [ ] `bp-fork` ≥90% coverage.

### Branching + shipping

- Stacked on `feat/ledger-phase-d` (PR #62). Branch `feat/ledger-phase-e`.
- Same `--no-verify` push pattern.
- When D merges, retarget base to main.

### What could slip

Ranked by probability:

1. **Git checkout semantics.** Moving HEAD is a real operation with pre-existing-state interactions. Mitigation: strict clean-worktree pre-flight + clear exit messaging.
2. **Orchestrator expects certain pre-conditions.** Fork reuses `run`'s pipeline; mid-flight checkout may confuse state checks. Mitigation: surface + patch single-check issues.
3. **`fast_forward_to` state vs. pre-event state.** Fork wants the pre-unit checkpoint SHA, which is in `ReplayState.checkpoints` regardless of position. Mitigation: read from that field, not state position.
4. **User's branch state surprise.** Detached HEAD before fork, or branch pointing somewhere unexpected. Mitigation: error clearly if HEAD is already detached; print current branch in exit hint.

---

## Appendix A: Decision Log

| # | Decision | Chosen | Alternatives | Reason |
|---|---|---|---|---|
| 1 | Tool output semantics | **Hybrid (C)** — re-execute default, VCR opt-in | A (VCR only), B (re-execute only) | VCR needs Rust-side CAS population deferred since Phase A. Re-execute ships the thesis demo. VCR adds optional opt-in for auditing parity. |
| 2 | Phase split | **C — E=re-execute, F=VCR, `.skip` in E** | A (bundled), B (split without markers) | Phase D's `.skip` pattern worked. Clean handoff from E to F. |
| 3 | Correction injection UX | **B — `--packet <file>`** | A (no correction), C (JSON patch), D (editor), E (B+D) | Packet-granularity matches how users think. Simple + composable with shell redirection. Field-level patches and editor handoff are Phase F+ if warranted. |

---

## Appendix B: Relation to Other Sub-Projects

- 0. Foundation fixes — parallel.
- 1. Unified memory model — benefits from complete tape lineage.
- 2. Phase A — shipped (PR #59).
- 3. Phase B — shipped (PR #60).
- 4. Phase C — shipped (PR #61).
- 5. Phase D — shipped (PR #62).
- 6. **Phase E (this spec) — re-execute fork with `--packet` correction.**
- 7. Phase F — VCR mode + Rust-side CAS population. Unskips Phase E's VCR markers.
- 8. Phase G — Bisect. Walks tape(s) for first bad event across forks.
- 9. Phase H — Audit bundle + signing. Enterprise tier.
- 10. Cloud / team ledger — hosted product.

Phase E closes the first half of the fork story: "resume from event N with a correction, lineage preserved, new tape captures the divergent path." Phase F closes the second half (VCR) when the CAS-population work can be justified.
