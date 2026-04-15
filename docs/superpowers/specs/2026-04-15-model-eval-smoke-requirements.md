# Model-Backed Eval Smoke Requirements

## Goal

Advance Phase 5 with the smallest useful first model-backed eval slice: an opt-in Codex-backed smoke suite that proves the eval harness can execute a real model fixture path instead of only local command fixtures.

## User story

As a Buildplane operator, I want the eval harness to run at least one model-backed fixture end-to-end, so I can verify that memory injection and strategy execution work on a real model worker path rather than only on deterministic local command packets.

## In scope

Add one opt-in model suite:

- `pnpm eval --suite model-codex`

This slice must:

- keep the existing local eval suite behavior unchanged
- require explicit opt-in via environment variable before running model-backed fixtures
- use one Codex-backed fixture directory under `eval/suites/model-codex/`
- execute all four existing eval conditions for that fixture:
  - `memory+strategy`
  - `memory+raw`
  - `nomemory+strategy`
  - `nomemory+raw`
- route model packets through the Codex executor path
- preserve injected memories in the implementer prompt by using the Codex renderer
- keep the suite output compatible with the existing `EvalReport` shape

## Exact behavior

### Opt-in gate

When `--suite model-codex` is requested without the opt-in env var:

- fail fast with a clear error
- do not silently skip
- do not run any fixtures

The initial gate can be a single boolean env such as:

- `BUILDPLANE_EVAL_MODEL=1`

### Fixture behavior

The first model fixture must:

- use `run-1.json` as a deterministic command packet that writes at least one output and seeds learnings
- use `run-2.json` as a model packet with:
  - `provider: "codex"`
  - `routingHints.preferredWorker = "codex"`
  - an intent/objective that instructs creation of one required output file
- be simple enough to smoke end-to-end with a stub Codex binary in tests

### Runtime routing

The eval harness must support model packets by:

- keeping command packets on the existing command runtime path
- routing model packets with `preferredWorker = "codex"` to the Codex executor
- using async execution for raw model packets
- continuing to use strategy execution for strategy model conditions

### Strategy behavior

For model-backed strategy conditions, reviewer packets must remain on the same worker route as the implementer when the source model packet had `routingHints.preferredWorker = "codex"`.

## Constraints

- Keep this slice TypeScript-first
- Keep it limited to Codex only
- Keep it opt-in and local-only for now
- Do not add CI workflow execution yet
- Do not widen into provider autodetection, auth doctoring, benchmark redesign, or raw-agent comparison
- Do not change the `EvalReport` schema unless a tiny additive change is unavoidable

## Out of scope

- Claude Code model fixtures in the same slice
- multi-provider model matrices
- raw-agent comparison suites
- benchmark docs publication
- CI `eval.yml`
- host/provider auto-discovery beyond a narrow explicit opt-in
- approval or scoring policy redesign
- large runtime-router refactors shared with CLI unless trivially small

## Acceptance criteria

- `pnpm eval --suite local --json` remains unchanged and passes
- `BUILDPLANE_EVAL_MODEL=1 pnpm eval --suite model-codex --json` runs a real model-backed fixture and exits 0 under a working/stubbed Codex binary
- without the opt-in env, `pnpm eval --suite model-codex` fails fast with a clear message
- `memory+*` conditions for the model fixture report `memoriesInjected > 0`
- `nomemory+*` conditions for the model fixture report `memoriesInjected === 0`
- focused tests cover:
  - Codex renderer/executor prompt wiring for memories
  - strategy wrapper preserving worker routing for reviewer packets
  - model eval suite gating and smoke execution
