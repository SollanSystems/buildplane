# Buildplane Ledger

The Buildplane ledger records a causal, append-only tape of events for every run. Events are stored in a SQLite database at `.buildplane/ledger/events.db` inside the workspace.

## Replaying a run

`buildplane ledger replay <run-id>` walks the tape for a run in causal order and emits either JSON (default) or an indented human tree. Flags:

- `--format json|human` — output mode. JSON is one line per event, carrying `{event, state_after}`. Human is an indented tree.
- `--limit <n>` — stop after n events.
- `--at <event-id>` — fast-forward to the given event, emit state at that point, exit. Preparatory for `fork`.

Examples:

```bash
buildplane ledger replay <run-id> --format human
buildplane ledger replay <run-id> --format json | jq '.event.kind'
buildplane ledger replay <run-id> --at <event-id> --format json
```

Replay is read-only — no model calls, no tool invocations, no side effects. Replay does not verify the tape against external truth (git history, real filesystem); it faithfully reports whatever the tape says happened. Corruption surfaces as `ReplayIssue` entries on the final state.

## Forking a run

`buildplane fork <parent-run-id> --at <unit-started-event-id> --packet <file> [--workspace <path>]` resumes from a unit boundary in a prior run with a new packet. The workspace is git-checked-out to the parent's pre-unit checkpoint; a new run_id records events with `parent_run_id` pointing at the parent. Re-executes tools; does NOT replay recorded outputs (Phase F adds `--vcr` for that).

Preconditions:
- Workspace git state must be clean (same as `buildplane run`).
- Target event must be a `unit_started`. Non-unit events error with a suggestion.
- `--packet` is currently required. Phase F adds CAS-backed parent-packet retrieval.

On exit, HEAD is at the fork's final tree (detached). Restore with `git checkout <branch>`.

Examples:

```bash
# After a `buildplane run` that produced run_id=RRR with a failing unit
# whose unit_started event id is UUU, try again with a corrected packet:
buildplane fork RRR --at UUU --packet fixed-packet.json --workspace /path/to/ws

# Inspect the fork's tape:
buildplane ledger replay <fork-run-id> --format human
# Output includes: "forked from RRR"
```

Lineage is one level deep: `parent_run_id` points at the immediate parent.
Chains of forks work mechanically (each fork has its own parent) but cross-run
replay is Phase F+.
