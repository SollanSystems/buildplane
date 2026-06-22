---
"@buildplane/planforge": minor
---

Dispatch real claude-code coding workers instead of the `true` placeholder.

- `DispatchedUnitPacket` drops the `execution: { command }` field and gains `model`
  (`{ provider, model, prompt }`), `intent` (an inlined `DispatchTaskIntent`), and
  `routingHints: { preferredWorker: 'claude-code' }`. The run-loop router short-circuits
  any packet carrying `execution` to the command executor before checking
  `preferredWorker`, so removing it is what lets the real worker be selected.
- New exports: `DISPATCH_WORKER_PROVIDER`, `DISPATCH_WORKER_MODEL`, `DispatchTaskIntent`,
  and `buildTaskIntent`.
- `buildDefaultCapabilityBundleForTask` now always seeds `'claude'` into the
  `run_command` allowlist (the worker binary), so `run_command` is always present and
  the capability-bundle canonical digest changes.
- `verification.requiredOutputs` and `unit.expectedOutputs` stay empty by design; the
  real assertion is `verificationCommands` run by the M4 acceptance gate.
