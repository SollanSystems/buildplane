<div align="center">

# Buildplane

**The control plane for autonomous software execution.**

*Operator-first autonomy for serious builders.*

</div>

Buildplane by **SollanSystems** is the deterministic control plane for autonomous software execution. It treats language models and agent shells as bounded workers inside a kernel that owns scheduling, state, policies, verification, and recovery. Instead of treating one long-running chat session as the system, Buildplane dispatches typed units of work in isolated contexts, captures evidence for every meaningful action, and advances only when reality matches the contract.

Build software with autonomy you can inspect, verify, reroute, and resume.

## Why Buildplane

- **Deterministic control plane** — the worker is not the system
- **Bounded execution units** — work is dispatched in clean, isolated contexts
- **Evidence-first automation** — actions produce receipts, artifacts, and verification signals
- **Operator control** — inspect, pause, replay, intervene, recover
- **Recovery built in** — resume after interruptions without losing the thread
- **Policy-aware autonomy** — budgets, trust gates, retries, and stop rules are enforced by the runtime
- **Worker-agnostic execution model** — route Hermes, Claude Code, Codex, or future workers without making any single shell the product center

## Status

Buildplane already has a real repo-local control-plane path: typed runs, durable state, evidence capture, policy evaluation, status/inspect surfaces, replay-oriented execution flows, strategy execution, and structured memory foundations. The current best-supported operator paths are the repo-development and in-repo built CLI flows documented below.

Near-term work is focused on trust-surface hardening rather than broader agent-shell breadth: stabilizing the verified published install contract, tightening provenance and inspect surfaces, and making replay/review/recovery easier to operate. Published/global install remains intentionally narrower than repo-local development, especially for native-backed memory commands.

## Benchmarks

Current Phase 5 benchmark evidence for the `model-codex` eval suite lives in [`docs/benchmarks/model-codex.md`](docs/benchmarks/model-codex.md).

That summary documents the rerun command, current aggregate signals, what the current memory-help and strategy-help fixtures prove, and which combined memory-plus-strategy proof remains a benchmark gap.

## Verification contract

CI keeps the deterministic trust gate explicit. The required local equivalents are:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

Model-backed evals remain opt-in until a deterministic local suite is promoted into the required gate.

## Getting started (repo development)

After cloning the repository, install dependencies:

```bash
pnpm install
```

Repo development uses `.node-version` (`24.13.1`) as the tested development baseline. The published CLI runtime guard accepts compatible Node 24 runtimes in the range `>=24.13.1 <25`; use the doctor commands below to inspect the current host instead of guessing from the pinned development baseline.

Then use the workspace-local dev command directly from the repo root:

```bash
pnpm buildplane bootstrap doctor --json
pnpm buildplane bootstrap doctor --capabilities --json
pnpm buildplane init
pnpm buildplane run --packet ./packet.json
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
pnpm buildplane replay <run-id> --json
pnpm buildplane fork <run-id> --at <event-id> --packet <fixed-packet.json>
pnpm buildplane memory doctor
pnpm buildplane pack show superclaude
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

This runs the CLI from TypeScript source via `tsx` — no build step required.

Native host-aware commands currently dispatch from the main TypeScript CLI into the native Rust runner. That bridge lives in `apps/cli/src/run-cli.ts`, and the repo-development and in-repo built CLI paths below verify `buildplane memory ...` plus `buildplane pack show <pack-id>`. In repo development, either build the native binary first or point the CLI at it explicitly:

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane memory doctor --json
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane pack show superclaude
```

## In-repo built CLI path

After building the project, you can run the CLI from the compiled output:

```bash
pnpm build
node apps/cli/dist/index.js bootstrap doctor --json
node apps/cli/dist/index.js bootstrap doctor --capabilities --json
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet ./packet.json
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js inspect <run-id> --json
node apps/cli/dist/index.js replay <run-id> --json
node apps/cli/dist/index.js fork <run-id> --at <event-id> --packet <fixed-packet.json>
node apps/cli/dist/index.js memory doctor --json
node apps/cli/dist/index.js pack show superclaude
```

This is the same interface used by the `bin.buildplane` entry in `apps/cli/package.json`.

The compiled CLI uses the same native-command bridge implementation as the published package entrypoint, and this repo verifies `buildplane memory ...` and `buildplane pack show ...` end-to-end for the repo-development and in-repo built CLI paths. When that bridge is used, the CLI resolves the native binary in this order:
- `BUILDPLANE_NATIVE_BIN` if set
- `native/target/debug/buildplane-native` relative to the current working directory
- `native/target/release/buildplane-native` relative to the current working directory
- `buildplane-native` on `PATH`

## Distribution

The packaged global-install contract verified by this repo is:

```bash
tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/SollanSystems/buildplane/main/scripts/published-bootstrap/install.sh -o "$tmp" && bash "$tmp"
```

If you prefer the explicit npm path, the published fallback/reference contract is:

```bash
npm install -g buildplane
buildplane bootstrap doctor --json
buildplane bootstrap doctor --capabilities --json
buildplane init
buildplane run --packet <path-to-packet.json>
buildplane status --json
buildplane inspect <run-id> --json
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

Published/global installs do not yet include a verified `buildplane memory ...` contract. The npm package does not bundle or provision `buildplane-native`, so memory remains a repo-local or direct-native workflow unless you separately supply the native binary yourself. Published/global native memory remains outside the verified package contract unless you separately supply a discoverable `buildplane-native` binary; the capability doctor reports this as optional/unavailable rather than failing the published run contract.

The capability doctor also reports required host/runtime features such as `node:sqlite`, npm, git, and the supported Node range, so global-install operators can see which prerequisite failed without reading the source.

Use this path when you want the packaged operator experience instead of the repo-local development or in-repo built CLI paths. The repo verifies this contract from a packed publishable artifact before any registry publication step.

## Local run loop

Today's working path is a local, packet-driven loop:

1. `pnpm buildplane init`
2. `pnpm buildplane run --packet <path>`
3. `pnpm buildplane status --json`
4. `pnpm buildplane inspect <run-id> --json` to inspect the event tape, decisions, evidence, and workspace state
5. `pnpm buildplane replay <run-id> --json` to replay the stored packet snapshot as a new run when you want another attempt with changed settings
6. `pnpm buildplane fork <run-id> --at <event-id> --packet <fixed-packet.json>` to fork from a unit boundary when recovery needs a corrected packet

The top-level `replay` command re-executes the stored packet snapshot and records a new run. The native-backed read-only event-tape walker is documented separately in [`docs/ledger.md`](docs/ledger.md) as `buildplane ledger replay --run-id <run-id> --workspace <path>`. Use `fork` when a prior run found the right setup but a later unit needs recovery from a known `unit_started` boundary.

Example packet:

```json
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": [".buildplane/artifacts/published-bootstrap/out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": [
      "-e",
      "const fs = require('node:fs'); fs.mkdirSync('.buildplane/artifacts/published-bootstrap', { recursive: true }); fs.writeFileSync('.buildplane/artifacts/published-bootstrap/out.txt', 'ok'); console.log('done');"
    ]
  },
  "verification": {
    "requiredOutputs": [".buildplane/artifacts/published-bootstrap/out.txt"]
  }
}
```

This example is intentionally narrow: one packet, one run, one local command step, one persisted decision path. Broader repo-local surfaces already include history/status/inspect, workspace retention and cleanup, replay-oriented flows, strategy execution, policy decisions, and model-worker routing where the documented repo-development and in-repo built CLI paths support them. Published/global install remains intentionally narrower, especially for native-backed memory and ledger surfaces.
