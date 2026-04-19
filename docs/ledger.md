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
