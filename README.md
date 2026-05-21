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

Near-term work is focused on trust-surface hardening rather than broader agent-shell breadth: stabilizing the verified published install contract, tightening provenance and inspect surfaces, and making replay/review/recovery easier to operate. Published/global install remains intentionally narrower than repo-local development, with native-backed memory currently packaged for Linux x64 first.

## Benchmarks

Current Phase 5 benchmark evidence for the `model-codex` eval suite lives in [`docs/benchmarks/model-codex.md`](docs/benchmarks/model-codex.md).

That summary documents the rerun command, current aggregate signals, what the current memory-help and strategy-help fixtures prove, and which combined memory-plus-strategy proof remains a benchmark gap. The current concrete rescue story is the `reviewer-rescue` fixture: the raw one-shot path leaves a rejected draft, while Buildplane's implement-then-review strategy path records reviewer feedback and produces an accepted result.

## High-trust operator loop

For high-trust work, Buildplane's front door is the governed loop rather than a raw one-shot worker path:

1. `pnpm buildplane run --packet <path>` to run with implement-then-review instead of unbounded chat.
2. `pnpm buildplane inspect <run-id> --json` to inspect the event tape, policy decisions, evidence, artifacts, and final outcome.
3. `pnpm buildplane replay <run-id> --json` to replay the stored packet snapshot as a new run when the same unit needs another attempt with changed settings.
4. `pnpm buildplane fork <run-id> --at <event-id> --packet <fixed-packet.json>` to fork from a unit boundary when recovery after a bad or partial run needs a corrected packet.

The concrete `reviewer-rescue` benchmark documents why this loop matters: the raw one-shot path leaves a rejected draft, while the implement-then-review path records reviewer feedback and lands an accepted artifact. Use the benchmark doc for the current evidence matrix and the local run loop below for the exact repo-development commands.

## Evidence-first Run Inspector

The first Mission Control slice is **Run Inspector**: a read-only forensic surface for completed or halted Buildplane runs. It is deliberately narrower than a live cockpit and is organized around three evidence-backed panels:

- **Event Timeline** — the persisted event tape, using only real ledger/runtime events
- **Evidence Pane** — raw evidence, decisions, artifacts, tool output, and hashes behind the selected event
- **Outcome Strip** — a compact PASSED / BLOCKED / FAILED verdict that fails closed when verification or acceptance is missing

The contract is documented in [`docs/architecture/run-inspector-evidence-slice.md`](docs/architecture/run-inspector-evidence-slice.md). It explicitly defers orchestration graphs, intake parsing, replay scrubbers, persona cards, live cockpit controls, and synthetic reasoning events until the runtime records can support them honestly.

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
pnpm buildplane pack export superclaude --target github-agent --out .github/agents/superclaude.md --json
pnpm buildplane pack export superclaude --target github-skill --out .github/skills
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

This runs the CLI from TypeScript source via `tsx` — no build step required.

Native host-aware commands currently dispatch from the main TypeScript CLI into the native Rust runner. That bridge lives in `apps/cli/src/run-cli.ts`, and the repo-development and in-repo built CLI paths below verify `buildplane memory ...` plus `buildplane pack show <pack-id>` and `buildplane pack export <pack-id>`. In repo development, either build the native binary first or point the CLI at it explicitly:

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane memory doctor --json
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane pack show superclaude
BUILDPLANE_NATIVE_BIN="$PWD/native/target/debug/buildplane-native" pnpm buildplane pack export superclaude --target github-agent --out .github/agents/superclaude.md --json
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
node apps/cli/dist/index.js pack export superclaude --target github-skill --out .github/skills --json
```

This is the same interface used by the `bin.buildplane` entry in `apps/cli/package.json`.

The compiled CLI uses the same native-command bridge implementation as the published package entrypoint, and this repo verifies `buildplane memory ...`, `buildplane pack show ...`, and `buildplane pack export ...` end-to-end for the repo-development and in-repo built CLI paths. When that bridge is used, the CLI resolves the native binary in this order:
- `BUILDPLANE_NATIVE_BIN` if set
- packaged `vendor/native/linux-x64/buildplane-native` when running on Linux x64
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
buildplane memory doctor --json
```

> **Precondition:** `run` expects a clean git working tree. Commit or stash uncommitted changes before dispatching work.

Published/global native memory is packaged and verified on Linux x64. Windows and macOS packages currently report `published_memory` as optional/unavailable instead of silently trying a broken native path. You can still supply `BUILDPLANE_NATIVE_BIN` explicitly on any platform, but that is reported as a supplied native binary, not as the published package memory contract.

The capability doctor also reports required host/runtime features such as `node:sqlite`, npm, git, and the supported Node range, so global-install operators can see which prerequisite failed without reading the source.

Use this path when you want the packaged operator experience instead of the repo-local development or in-repo built CLI paths. The repo verifies this contract from a packed publishable artifact before any registry publication step.

Pack export is intentionally a workflow bridge, not a runtime bridge. `buildplane pack export <pack-id> --target github-agent|github-skill --out <path> --json` writes GitHub-compatible custom-agent or skill guidance from Buildplane pack metadata, but it does not grant provider credentials, MCP servers, hooks, GitHub permissions, or Buildplane execution authority.

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

This example is intentionally narrow: one packet, one run, one local command step, one persisted decision path. Broader repo-local surfaces already include history/status/inspect, workspace retention and cleanup, replay-oriented flows, strategy execution, policy decisions, and model-worker routing where the documented repo-development and in-repo built CLI paths support them. Published/global install remains intentionally narrower, with native-backed memory packaged for Linux x64 first and wider native targets still explicit/unavailable.

## GSD-2 repo-local task state

GSD-2 is the repo-local state layer for turning ambiguous work into bounded task envelopes before execution. It complements Buildplane's high-trust run/inspect/replay/fork loop; it does not replace `/auto-coder` as the serious coding front door and does not make a dry-run into a verified run.

Milestone 1 is intentionally non-executing: it writes and validates `.gsd2` state and previews routes or recovery plans, but it does not dispatch Buildplane runs, worktree-kernel slices, tmux sessions, or model workers.

Current repo-development commands:

```bash
pnpm gsd2 status
pnpm gsd2 new "<goal>" --route planning_only
pnpm gsd2 validate
pnpm gsd2 run --dry-run <task-id>
pnpm gsd2 admit --dry-run <task-id>
pnpm gsd2 admit <task-id>
pnpm gsd2 recover --dry-run <task-id> --parent-run <run-id> --at <event-id> --reason "<why>" --packet <file> --expected-evidence "<evidence>"
pnpm gsd2 recover <task-id> --parent-run <run-id> --at <event-id> --reason "<why>" --packet <file> --expected-evidence "<evidence>"
```

Admission is still non-executing: it moves a valid `NEW` task envelope to `READY`, records a local `task.admitted` receipt, estimates gates/capabilities/evidence, and does not dispatch Buildplane, worktree-kernel, tmux, or model workers.

`gsd2 recover` records a bounded `RecoveryPlan` for a reviewed Buildplane fork packet and leaves the task receipt `BLOCKED` until an operator explicitly approves execution and a later verifier receipt proves the fork/replay outcome. The command hashes the packet and writes local state only; it does not run Buildplane replay/fork by itself.

The first implementation target is only the state skeleton: `.gsd2/PROJECT.md`, `.gsd2/STATE.md`, `.gsd2/QUEUE.md`, `.gsd2/config.yaml`, and per-task `task.md`, `envelope.yaml`, `receipt.yaml`, and optional `recovery-plan.yaml`. Later milestones may bridge those envelopes to worktree-kernel or Buildplane after the dry-run contract is accepted.
