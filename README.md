<div align="center">

# Buildplane

**The control plane for autonomous software execution.**

*Operator-first autonomy for serious builders.*

</div>

Buildplane by **SollanSystems** is an operator-first execution system for autonomous software work. It treats language models as bounded workers inside a deterministic kernel that owns scheduling, state, policies, verification, and recovery. Instead of relying on one long-running chat session, Buildplane dispatches typed units of work in isolated contexts, captures evidence for every meaningful action, and advances only when reality matches the contract.

Build software with autonomy you can inspect, verify, reroute, and resume.

## Why Buildplane

- **Deterministic control plane** — the model is a worker, not the system
- **Bounded execution units** — work is dispatched in clean, isolated contexts
- **Evidence-first automation** — actions produce receipts, artifacts, and verification signals
- **Operator control** — inspect, pause, replay, intervene, recover
- **Recovery built in** — resume after interruptions without losing the thread
- **Policy-aware autonomy** — budgets, trust gates, retries, and stop rules are enforced by the runtime

## Install

```bash
npm install -g buildplane
```

## Status

This repo now includes the first local vertical slice of the control plane. Milestone 1 is still focused on the execution kernel: typed units of work, durable state, bounded worker runs, verification, and operator inspection.

## Local run loop

Today’s working path is a local, packet-driven loop:

1. `buildplane init`
2. `buildplane run --packet <path>`
3. `buildplane status --json`
4. `buildplane inspect <run-id> --json`

Example packet:

```json
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["tmp/out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": [
      "-e",
      "const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('done');"
    ]
  },
  "verification": {
    "requiredOutputs": ["tmp/out.txt"]
  }
}
```

Example usage:

```bash
buildplane init
buildplane run --packet ./packet.json
buildplane status --json
buildplane inspect <run-id> --json
```

This is intentionally narrow: one packet, one run, one local command step, one persisted decision path. Worktree isolation, replay, richer policy, and model-backed execution come later.
