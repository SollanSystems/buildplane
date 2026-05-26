---
"buildplane": minor
---

Phase 2 · S3 — episodes read path: add `listEvents({ runId, limit? })` to `BuildplaneStoragePort` (implemented via `EventStore.getEventsByRunId`) and a `memory episodes <runId> [--limit N] [--json]` CLI subcommand that lists a run's execution events with `--json` parity to `facts`/`procedures`; a missing `<runId>` exits non-zero with a clear message.
