<div align="center">

# Buildplane

**The control plane for autonomous software execution.**

*Operator-first autonomy for serious builders.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

## The v0.5 control plane

Buildplane's surface is layered trust-first on a signed, append-only event tape (L0):

- **PlanForge admission cycle** — every unit runs `compile → validate → preview → admit → dispatch → execute → receipt`. Nothing executes until an admitted, signed plan authorizes it.
- **Capability broker (M3)** — digest-referenced capability bundles gate each tool call; out-of-scope `write_file` / `run_command` attempts fail closed and are recorded as signed `capability_denied` events.
- **Acceptance contract (M4)** — finalization is gated on diff-scope + CI + lint, so a run advances only when the recorded evidence matches the contract.
- **Mission Control web (M5)** — a read-only run inspector plus an operator approval inbox, served by `bp web` (source/dev only).
- **End-to-end demo (M6)** — `node scripts/run-demo.mjs` drives the full ten-step flow on a toy repo, including kill-and-resume recovery, and the external `scripts/verify-signed-tape.mjs` re-checks the signed tape.

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

The published npm package bundles a **prebuilt native binary for linux-x64 only**. Published/global native memory is packaged and verified on Linux x64. Windows and macOS packages currently report `published_memory` as optional/unavailable instead of silently trying a broken native path. You can still supply `BUILDPLANE_NATIVE_BIN` explicitly on any platform, but that is reported as a supplied native binary, not as the published package memory contract.

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

## Known limitations

- The adversarial-Codex reviewer role currently scores **43.75%** on the internal `reviewer-rescue` benchmark (a local stub over four fixtures). It is an internal review aid, not a production-ready gate, and is disclosed as such rather than presented as finished.
- Published/global native memory ships a prebuilt binary for **linux-x64 only**; other platforms report the native-memory contract as optional/unavailable.
- `bp web` (Mission Control) is source/dev only — the web assets and the optional server package are not vendored into the published npm artifact.

## License

Buildplane is released under the [MIT License](LICENSE).
