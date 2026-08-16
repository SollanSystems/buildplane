---
"buildplane": patch
---

Surface ledger evidence loss on the fork lane instead of exiting clean.

`TapeEmitter.emit` is synchronous, returns `void`, routes queue-write errors into
`.catch(() => {})`, and silently no-ops once the emitter has latched failed. Every
writer on the `buildplane fork --raw` lane is synchronous by contract — the
event-bus subscriber that drives the unit/checkpoint events, the `ToolRegistry`
proxy from `wrapToolRegistryForLedger`, and the direct `run_started` /
`run_completed` / `tool_*` emits — so none of them could reject, and both
`emitter.close()` call sites swallowed their rejection. A fork run whose tape
rejected every append still reported `exit 0`.

A new `guardLedgerEvidence` helper latches the emitter's `onFailure` channel and
owns the close, so a rejected append or a rejected close is reported loudly and
makes the fork run exit non-zero. It deliberately never throws out of `close()` —
that call sits in a `finally` where throwing would mask the original error.

Success paths are behavior-identical: a healthy tape loses no events, exits with
the orchestrator's own verdict, and prints nothing extra. Only the failure path
changes, and only on the unsigned fork lane.

The `buildplane run` handler's close sites get the same contract so the lanes
cannot drift. There are three of them, not one — the `useAsync && !useTui`
branch, the `useTui` branch, and the default sync branch each own an independent
`finally`. All three are unreachable today behind a hard-coded
`useLedger = false`, so this is a no-op at runtime; it matters only if that flag
is re-enabled, at which point `buildplane run --async` and `--tui` would
otherwise reproduce the same silent-lost-tape bug this fixes on `fork`.
