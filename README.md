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

## Status

This repo now includes the first local vertical slice of the control plane. Milestone 1 is still focused on the execution kernel: typed units of work, durable state, bounded worker runs, verification, and operator inspection.

## Getting started (repo development)

After cloning the repository, install dependencies:

```bash
pnpm install
```

Then use the workspace-local dev command directly from the repo root:

```bash
pnpm buildplane init
pnpm buildplane run --packet ./packet.json
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

This runs the CLI from TypeScript source via `tsx` — no build step required.

## In-repo built CLI path

After building the project, you can run the CLI from the compiled output:

```bash
pnpm build
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet ./packet.json
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js inspect <run-id> --json
```

This is the same interface used by the `bin.buildplane` entry in `apps/cli/package.json`.

## Distribution

The packaged global-install contract verified by this repo is:

```bash
npm install -g buildplane
buildplane init
buildplane run --packet <path-to-packet.json>
buildplane status --json
buildplane inspect <run-id> --json
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

Use this path when you want the packaged operator experience instead of the repo-local development or in-repo built CLI paths. The repo verifies this contract from a packed publishable artifact before any registry publication step.

## Local run loop

Today's working path is a local, packet-driven loop:

1. `pnpm buildplane init`
2. `pnpm buildplane run --packet <path>`
3. `pnpm buildplane status --json`
4. `pnpm buildplane inspect <run-id> --json`

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

This is intentionally narrow: one packet, one run, one local command step, one persisted decision path. Worktree isolation, replay, richer policy, and model-backed execution come later.
