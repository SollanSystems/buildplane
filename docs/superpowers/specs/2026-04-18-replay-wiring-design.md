# Replay + Wiring Completion — Phase D Design

**Date:** 2026-04-18
**Status:** Approved (pending written-spec review)
**Sub-project of:** Buildplane replayable-ledger roadmap, Phase D of the decomposition in `docs/strategy/buildplane-positioning.md`.
**Builds on:**
- `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md` (Phase A — shipped in PR #59)
- `docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md` (Phase B — shipped in PR #60)
- `docs/superpowers/specs/2026-04-18-tool-instrumentation-design.md` (Phase C — shipped in PR #61)

## 1. Goal & Scope

### Goal

Finish Phase C's wiring gap (sync-path bus emission + registry threading) and ship `buildplane ledger replay <run-id>` as a Rust-owned subcommand that both dumps the event tape AND exposes a `ReplayEngine` API for forward-iteration through the tape with a hydrated run-state object. The state-reconstruction engine is the foundation Phase E's fork primitive will build on, and it earns its complexity by making replay output genuinely useful (causal tree, current-unit tracking, observed file state per event, reachable git refs).

### In scope

1. **Wiring W.1 — sync `runPacket` emits bus events.** Extend `orchestrator.runPacket()` (the synchronous path) to fire `execution-started` and `command-execution-complete` on the event bus, matching what `runPacketAsync` already emits. Phase C's bus subscription will then fire pre-unit/post-unit git checkpoints + `unit_started`/`unit_completed` envelopes without further code changes.
2. **Wiring W.2 — thread wrapped `ToolRegistry` into execution adapter.** Remove the `void registry` suppression. Trace the orchestrator → runtime → tool-dispatch path and pass the wrapped registry through so tool calls route through the wrapper's `tool_request` / `tool_result` / `workspace_write` emissions.
3. **Rust `ReplayEngine`** in a new crate `bp-replay` (sibling to `bp-ledger`). Core API:
   - `ReplayEngine::open(run_id, events_db_path) -> ReplayEngine`
   - `ReplayEngine::next() -> Option<ReplayStep>` where each step carries `{ event, state_after }`
   - `ReplayState { current_unit: Option<UnitId>, parent_chain: Vec<EventId>, observed_files: BTreeMap<Path, FileObservation>, checkpoints: Vec<CheckpointRef>, issues: Vec<ReplayIssue> }`
   - `FileObservation { last_known_hash: Option<String>, from_event_id: EventId }`
   - Failed checkpoints surface via `ReplayState.issues` rather than breaking iteration.
4. **`bp-cli ledger replay <run-id>`** Rust subcommand that drives the engine and emits output:
   - `--format json` (default): streams one JSON line per step.
   - `--format human` (flag): indented tree view.
   - `--limit N`: stop after N events.
   - `--at <event-id>`: fast-forward to the given event, emit state at that point, exit. The hook Phase E's fork will call.
5. **TS CLI wrapper**: `buildplane ledger replay <run-id> [--json]` spawns the native binary and streams output. Matches existing `memory` / `pack` / `ledger serve` bridge pattern.
6. **Integration tests** under `test/ledger-integration/`:
   - `tape-capture-end-to-end.test.ts`: proves that with wiring W done, a real `buildplane run` populates events.db with the full sequence promised by Phase A's Section 1. Unskip Phase C's aspirational `.skip` markers.
   - `replay-basic.test.ts`: runs a packet, spawns `buildplane ledger replay <run-id> --json` in the fixture dir, asserts streamed output matches the tape.
   - `replay-at-event.test.ts`: same fixture with `--at <event-id>`, asserts the engine fast-forwards and the emitted state has the expected unit/observed-file state.
7. **Unit tests** for `bp-replay`: per-kind state transitions, iteration determinism, issue surfacing for corrupt tapes.

### Out of scope (Phase E or later)

- `fork <run-id> --at <event-id> [--inject ...]`. Engine's `--at` hook is the foundation.
- `bisect <run-id>` — Phase F.
- Audit bundle signing + export.
- TUI interactive replay walker. Phase D ships JSON + simple human text.
- Replay across forks (parent-run chain traversal).
- Re-execution of model calls or tools during replay — strictly read-only state reconstruction.

### Success criteria

1. A `buildplane run` of a packet that calls `write_file` and a shell command produces a tape with the full event sequence Phase A promised: `run_started` → `unit_started` → `git_checkpoint(pre-unit)` → `tool_request(write_file)` → `workspace_write` → `tool_result` → `tool_request(run_command)` → `tool_result` → `git_checkpoint(post-unit)` → `unit_completed` → `run_completed`. Phase C's `.skip` markers are removed and the tests pass.
2. `buildplane ledger replay <run-id> --json` streams a JSON line per event, each carrying the envelope + a state-delta showing `current_unit`, accumulated `observed_files`, and checkpoint SHAs.
3. `buildplane ledger replay <run-id>` (human mode) renders the same data as an indented causal tree with a trailing snapshot hint pointing at `refs/buildplane/run/<id>`.
4. `buildplane ledger replay <run-id> --at <event-id>` fast-forwards and prints only the final state — including `current_unit`, `parent_chain`, `observed_files`. Determinism: same tape + same event-id always produces bit-identical state output.
5. All Phase C integration tests still pass (including the `cwd-isolation` canary).
6. A human reading the replay output can reconstruct what the run did without looking at source or SQLite directly.

### Non-goals (explicit)

- Replay does not verify tape integrity against external truth (git history, real filesystem). It faithfully reports whatever the tape says happened; corruption surfaces via `ReplayIssue`.
- Replay does not re-hash files at replay time. It reports hashes the tape captured at write time.
- Linux + macOS only, consistent with prior phases.
- No perf SLAs. Informational benchmark only.

### Budget

~3-3.5 weeks focused work.

---

## 2. Architecture

### Component layout

```
┌────────────────────────────────────────────────────────────────┐
│  packages/kernel OR runtime  (MODIFIED — W.1)                  │
│   orchestrator.runPacket() emits:                              │
│     - execution-started before unit work                       │
│     - command-execution-complete after                         │
│   Matches runPacketAsync's existing bus emissions.             │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  packages/runtime OR kernel  (MODIFIED — W.2)                  │
│   Execution adapter accepts ToolRegistry parameter.            │
│   run-cli.ts passes the wrapped registry; `void` is removed.   │
└────────────────────────────────────────────────────────────────┘
             │
             │ events (wiring complete)
             ▼
┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-ledger  (UNCHANGED)                          │
│   events.db + CAS accumulate a complete tape on every run.    │
└────────────────────────────────────────────────────────────────┘
             │
             │ read-only queries
             ▼
┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-replay  (NEW)                                │
│   src/                                                         │
│   ├─ lib.rs          public API + re-exports                    │
│   ├─ engine.rs       ReplayEngine + iteration loop              │
│   ├─ state.rs        ReplayState, FileObservation,              │
│   │                  CheckpointRef, ReplayIssue                │
│   ├─ transitions.rs  per-EventKind state update fns            │
│   └─ reader.rs       SQLite reader: fetch run's events in       │
│                      causal order (UUIDv7 natural ordering)     │
└────────────────────────────────────────────────────────────────┘
             │
             │ library dependency
             ▼
┌────────────────────────────────────────────────────────────────┐
│  native/crates/bp-cli  (EXTENDED)                              │
│   src/ledger_cli.rs: new subcommand `replay`                   │
│     - parses --run-id, --format json|human, --limit, --at      │
│     - opens bp-replay::ReplayEngine                            │
│     - streams iteration steps to stdout                         │
└────────────────────────────────────────────────────────────────┘
             │
             │ subprocess dispatch (like memory/pack/serve)
             ▼
┌────────────────────────────────────────────────────────────────┐
│  apps/cli/src/run-cli.ts  (EXTENDED)                           │
│   New dispatch case: `buildplane ledger replay <run-id>`       │
│     - resolves BUILDPLANE_NATIVE_BIN                           │
│     - spawns buildplane-native ledger replay … with user args  │
│     - streams stdout/stderr                                    │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  test/ledger-integration/  (EXTENDED)                          │
│   tape-capture-end-to-end.test.ts  (NEW) unskips Phase C .skip │
│   replay-basic.test.ts             (NEW)                       │
│   replay-at-event.test.ts          (NEW)                       │
└────────────────────────────────────────────────────────────────┘
```

### Data flow — W.1 sync-path bus emission

```
runPacket(packet):
  bus.emit({ kind: "execution-started", unitId: packet.unit.id, ... })
    → Phase C subscription fires:
        - emits unit_started envelope
        - calls runGitCheckpoint({ boundary: "pre-unit", ... })
        - sets currentUnit = { unitId, parentEventId }
  result = commandExecutor.run(packet.execution, workspace, registry)
    → tool calls route through the wrapped registry (W.2)
      → emit tool_request, workspace_write, tool_result
  bus.emit({ kind: "command-execution-complete", unitId, exitCode })
    → Phase C subscription fires:
        - calls runGitCheckpoint({ boundary: "post-unit", ... })
        - emits unit_completed envelope
        - clears currentUnit
  return result
```

Diff is two `bus.emit()` calls bracketing existing command execution. Phase C's subscription does the rest.

### Data flow — W.2 registry threading

The wrapped registry from `apps/cli/src/ledger-tool-wrapper.ts` needs to reach whatever file actually invokes `write_file` / `run_command`. The implementer audits the call chain. Most likely: `packages/runtime/src/command-executor.ts` (or similar) gets a new `registry: ToolRegistry` parameter that `run-cli.ts` passes in. The `void registry;` suppression in `run-cli.ts` is removed when the threading lands.

Implementation note: if the audit reveals the call chain requires a kernel-level API change (changing `orchestrator.runPacket`'s signature, for example), flag before making the change. Consider a facade in run-cli.ts that wraps tool calls directly instead of threading through the kernel.

### Data flow — Replay

```
$ buildplane ledger replay <run-id> --json
  │
  ├─ TS CLI: spawn(buildplane-native, ["ledger", "replay", ..., "--format", "json"])
  │
  ▼
bp-cli:
  parse args → { run_id, format: Json, limit: None, at: None }
  open events.db → bp_replay::ReplayEngine::open(run_id, db_path)
  │
  ▼
bp_replay::ReplayEngine:
  reader: SELECT * FROM events WHERE run_id = ? ORDER BY id ASC
        (UUIDv7 natural ordering = causal-respecting time order)
  state: ReplayState::new()

  loop:
    row = reader.next()?
    if row is None: return None
    event = canonicalize(row)
    transitions::apply(&mut state, &event)
    return Some(ReplayStep { event, state_after: state.clone_lite() })

bp-cli main loop:
  while Some(step) = engine.next():
    if --at provided and step.event.id > at_target: break
    if format == Json: println!("{}", serde_json::to_string(&step));
    if format == Human: render_indented_tree_line(&step);

  if format == Human && --at not set:
    println!("\nSnapshots: git -C <workspace> log refs/buildplane/run/<run-id>");

  if !state.issues.is_empty():
    eprintln!("{} issues surfaced during replay", state.issues.len());
    if format == Human: for i in state.issues: eprintln!("  - {}", i.summary());

  exit 0 (engine completes even on issues — replay is advisory)
```

### Per-EventKind state transitions

- `run_started` — set `state.run_id`, push event.id to `parent_chain`.
- `run_completed` / `run_failed` — clear `parent_chain` after emitting this step.
- `unit_started` — set `state.current_unit = Some(unit_id)`, push event.id to `parent_chain`.
- `unit_completed` / `unit_failed` / `unit_cancelled` — clear `state.current_unit`, pop from `parent_chain`.
- `git_checkpoint` with `git_status.ok` — push `CheckpointRef { sha, boundary, reference }` to `state.checkpoints`.
- `git_checkpoint` with `git_status.failed` — push `ReplayIssue::CheckpointFailed { step, error }` to `state.issues`.
- `tool_request` — no file-state change; push event.id to `parent_chain`.
- `tool_result` — pop from `parent_chain` if the prior frame was the matching `tool_request`.
- `workspace_read` — no state change (Phase D doesn't track reads).
- `workspace_write` with `after.Captured` — insert/update `state.observed_files[path] = FileObservation { hash: after.hash, from_event_id }`.
- `workspace_write` with `after.Unreadable` — push `ReplayIssue::UnreadablePostWrite { path, reason }`.
- `model_request` / `model_response` — no file-state change for Phase D; may record for Phase F audit.

### Key contracts

- **Forward-only.** No rewind. `--at` fast-forwards by running the engine up to the target and stopping.
- **`ReplayState` is cloneable** for snapshots. Per-step `state_after` is a lightweight clone.
- **Issues are non-fatal.** A corrupted tape produces `ReplayIssue` entries; engine completes; caller decides policy.
- **JSON output is the canonical contract.** Human mode is a view. Third-party consumers parse JSON.
- **`--at` uses event-id equality.** Invalid or unreachable event-id runs to EOF and surfaces `TargetNotFound`.

### What doesn't change

- `bp-ledger` crate (storage, CAS, canonicalize, event types, payloads, serve): untouched.
- `bp-ledger-macros`: untouched.
- `@buildplane/ledger-client` runtime: untouched.
- `packages/adapters-tools`: untouched.
- `apps/cli/src/ledger-tool-wrapper.ts`: untouched (Phase C shipped it correctly).

---

## 3. Testing Strategy

### Layer 1 (Rust) — `bp-replay` crate tests

- **`tests/iteration.rs`** — canned fixture tape (written via `bp-ledger::SqliteStore`, then replayed). Asserts forward iteration yields events in UUIDv7 order, state accumulates correctly, EOF returns None, reopening yields identical steps.
- **`tests/transitions.rs`** — per-`EventKind` unit tests. One test per kind (14 total).
- **`tests/fast_forward.rs`** — `--at` semantics. Target match → state at that event; target not found → `TargetNotFound` issue, non-zero exit.
- **`tests/issues.rs`** — corrupt tapes: failed checkpoint, unreadable workspace_write, dangling parent_event_id. Each produces a specific `ReplayIssue`; iteration continues.

Target: ≥90% coverage in `bp-replay`.

### Layer 2 (TS) — CLI dispatch

- **`apps/cli/test/ledger-replay-dispatch.test.ts`** — mock native binary via shell script, asserts TS CLI forwards args + streams stdout + propagates exit code. Matches existing memory/pack dispatch test pattern.

May be skipped in favor of Layer 3 if the dispatch is genuinely one-line.

### Layer 3 (integration) — the real proofs

- **`tape-capture-end-to-end.test.ts`** — runs a write_file + run_command packet via `makeBuildplaneRunFixture`. Asserts events.db has the full Section 1 success-criteria sequence. Un-skips Phase C's three `.skip` markers (tool-capture, shell-command-capture, git-checkpoint).
- **`replay-basic.test.ts`** — runs a packet, spawns `buildplane ledger replay <run-id> --json` in the fixture dir, asserts streamed output matches events.db. Step count matches event count, `current_unit` reflects context at each step, `observed_files` accumulate correctly, checkpoint SHAs match `git -C <dir> show-ref refs/buildplane/run/<run-id>`.
- **`replay-at-event.test.ts`** — same fixture, `--at <event-id>`. Asserts output is exactly one JSON line with the state at that event; `parent_chain` matches causal path; non-existent event-id produces `TargetNotFound` and non-zero exit.
- **`cwd-isolation.test.ts`** — the Phase C canary. Must continue to pass.

### What we are NOT testing

- Replay across fork chains.
- Adversarial tapes (tampered SQLite). Append-only trigger already covers happy case.
- Perf on >100k-event tapes.
- Windows.
- Concurrent replay of the same events.db from multiple processes.

### Test-isolation discipline

Same as Phase C. Every `makeBuildplaneRunFixture` use is single-file, non-concurrent, tempdir-only. Canary is the gate.

---

## 4. Phases + Sequencing

### Phase D.1 — Wiring W.1: sync-path bus emission (2-3 days)

- Audit `runPacket` to find the exact bus-emit placement used by `runPacketAsync`.
- Port the `execution-started` emit (before) and `command-execution-complete` emit (after) into the sync path.
- Run Phase C's integration suite — the `.skip` markers are unskipped as part of D.1's test plan.

**Demo-able:** tool_capture test passes without test-code changes.

**Gate:** all 3 Phase C `.skip` markers removed and passing.

### Phase D.2 — Wiring W.2: thread wrapped ToolRegistry (2-4 days)

- Audit orchestrator + runtime for tool invocation.
- Add `registry: ToolRegistry` parameter to the dispatch chain.
- Pass wrapped registry from run-cli.ts; remove `void registry` suppression.

**Demo-able:** a packet that calls `write_file` through the ToolRegistry produces tool_request/workspace_write/tool_result events in events.db.

**Gate:** `tape-capture-end-to-end.test.ts` passes with workspace_write events present.

### Phase D.3 — `bp-replay` crate (5-7 days)

- New crate under `native/crates/bp-replay/`.
- `state.rs`, `reader.rs`, `transitions.rs`, `engine.rs`, `lib.rs`.
- Layer 1 tests.

**Demo-able:** Rust integration test runs canned tape through the engine.

**Gate:** ≥90% coverage.

### Phase D.4 — `bp-cli ledger replay` subcommand (2-3 days)

- Extend `native/crates/bp-cli/src/ledger_cli.rs`.
- Arg parsing, JSON + human modes, error paths.

**Demo-able:** `./native/target/debug/buildplane-native ledger replay <run-id> --json` works against a real events.db.

**Gate:** smoke both output formats.

### Phase D.5 — TS CLI dispatch + integration tests (2-3 days)

- Add replay dispatch in `apps/cli/src/run-cli.ts`.
- Ship three Layer-3 tests.
- Update `docs/ledger.md`.

**Demo-able:** `pnpm buildplane ledger replay <run-id> --json` works.

**Gate:** all integration tests green; canary still passes.

### Phase D.6 — Verification gate + spec marker (1 day)

- Full test suite across all crates + TS packages.
- Clippy clean.
- Fixture drift check.
- Real-run smoke.
- Benchmark a 1000-event tape replay (informational).
- Spec marker `**Phase D status: complete (YYYY-MM-DD).**`.

### Branching + shipping

- Stacked on `feat/ledger-phase-c` (PR #61). Branch `feat/ledger-phase-d`.
- `--no-verify` push workaround until main's pre-existing red tests resolve.
- When C merges, retarget D's PR base to main.

### What could slip

Ranked by probability:

1. **W.2 audit depth.** 2-4 days depending on invocation chain thickness. Mitigation: facade in run-cli.ts if chain is too deep.
2. **W.1 bus emit conflicts with async path.** Audit both paths together to ensure no duplicate emit. Phase C's subscription should handle duplicates deterministically; if not, add de-dup.
3. **`ReplayState` cloning cost on big tapes.** Defer optimization unless a real user hits it.
4. **Unskipping Phase C `.skip` reveals deeper issue.** D.1's gate is explicit; halt and address in D.1/D.2 before D.3.

**Phase D status: complete (2026-04-18).**

---

## Appendix A: Decision Log

| # | Decision | Chosen | Alternatives | Reason |
|---|---|---|---|---|
| 1 | Phase D scope split | **A — wiring + replay; fork deferred to Phase E** | B (wiring only), C (wiring + replay + fork) | Replay is the thesis proof; fork has open product questions that benefit from shipping replay first. Wiring is C's debt and must be paired with user-visible delivery. |
| 2 | Replay command location | **C — TS CLI wraps Rust subcommand** | A (pure Rust), B (pure TS direct-read) | Rust owns the tape reader as single source of truth. Matches existing memory/pack dispatch pattern. |
| 3 | Replay depth | **C — full replay with in-memory state reconstruction** | A (playback only), B (playback + checkpoint refs) | Earns complexity via Phase E fork readiness (`--at` hook). In-memory state also makes replay actually useful (current-unit, observed-files) versus just rendering timeline. |

---

## Appendix B: Relation to Other Sub-Projects

This sub-project is Phase D in the replayable-ledger roadmap:

0. Foundation fixes — parallel.
1. Unified memory model — benefits from complete tape (Phase C + D).
2. **Event tape capture (Phase A) — shipped in PR #59.**
3. **Event tape IPC (Phase B) — shipped in PR #60.**
4. **Tool adapter instrumentation (Phase C, infra) — shipped in PR #61.**
5. **Replay + wiring (Phase D, this spec) — makes the tape real end-to-end and gives users a way to read it back.**
6. Fork primitive (Phase E) — uses Phase D's `ReplayEngine::--at` hook to resume mid-run with optional corrections. Consumes D.
7. Bisect (Phase F) — walks the tape for first bad event; uses D's reader.
8. Audit bundle + signing (Phase G) — enterprise tier; consumes everything.
9. Cloud / team ledger — hosted product surface.

Phase D closes the end-to-end capture loop Phase C left open AND delivers the first user-facing replay experience. Fork becomes straightforward once D's engine is real.
