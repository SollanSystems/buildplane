---
"buildplane": patch
---

Make the ledger activity port's `activityCompleted` await `emitter.flush()`, mirroring its `activityStarted` sibling. `emit()` swallows queue-write errors, so without an awaited flush a rejected append — `activity_completed` is on the native signed-ingest denylist — resolved as success while nothing reached the tape. This was the last true silent-success emit shape in the tree. Both routes to a bound signed activity port are currently gated shut (`run-cli.ts:11040`, `:8434`), so this changes no live behaviour today; it is observability hardening so a future un-gating cannot resurrect the shape unnoticed. Note for whoever does that un-gating: `orchestrator.ts:4345` awaits this port without a local try/catch, so a real native rejection will now propagate rather than be swallowed — that is the intent.
