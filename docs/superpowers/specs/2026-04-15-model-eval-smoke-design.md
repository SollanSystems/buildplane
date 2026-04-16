# Model-Backed Eval Smoke Design

## Slice name

Phase 5 / Slice 5A1: opt-in Codex model-fixture smoke suite

## Why this slice

The current eval harness already proves local command fixtures and memory injection presence.
The smallest meaningful next step is to execute one real model-backed suite through an actual worker route.

This keeps the scope narrow:

- one provider: Codex
- one new suite: `model-codex`
- one fixture
- no CI integration
- no benchmark redesign
- no raw-agent comparison yet

## Architecture

### 1. Add one model-backed fixture suite

Create:

- `eval/suites/model-codex/<fixture>/meta.json`
- `eval/suites/model-codex/<fixture>/run-1.json`
- `eval/suites/model-codex/<fixture>/run-2.json`

The first fixture should be intentionally small:

- run 1: command packet that writes a file and seeds learnings
- run 2: model packet that must create `output/hello.js`
- run 2 routing hints:
  - `preferredWorker: "codex"`

This lets tests supply a stub `codex` binary that simply writes the required output file.

### 2. Gate model suites explicitly

In `eval/runner.ts`, treat model-backed suites as opt-in.

Proposed rules:

- suite ids must be bare names such as `local` or `model-codex`
- reject path-like or traversal-like forms such as `./model-codex` or `model-codex/../model-codex`
- if `suite === "model-codex"` and `BUILDPLANE_EVAL_MODEL !== "1"`, exit with a clear error before fixture execution

This keeps the default local eval loop deterministic and avoids accidental dependence on host tools.

### 3. Add a narrow runtime router to eval/runner.ts

The current eval runner only wires command execution through the synchronous runtime path.
That is enough for local command fixtures but not model packets.

Add a minimal runtime router inside `eval/runner.ts` modeled after the existing CLI runtime router:

- command packet -> existing `@buildplane/runtime.executePacket`
- model packet with `routingHints.preferredWorker === "codex"` -> `@buildplane/adapters-codex.createCodexExecutor(...)`
- any other model packet in this slice -> explicit unsupported error

Keep this router local to the eval harness.
Do not extract a shared runtime-router abstraction in this slice.

### 4. Pass the Codex renderer into the Codex executor

The Codex executor can render prompts from `packet.intent` when given a renderer.
Use:

- `@buildplane/adapters-models.createCodexRenderer()`

This ensures injected memories are actually folded into the prompt for model-backed implementer packets.

### 5. Support async raw model execution in the harness

`runCondition()` currently uses `orchestrator.runPacket(...)` for raw conditions.
That works only for command packets.

For raw model packets:

- use `orchestrator.runPacketAsync(packet, eventBus)`
- preserve the existing sync path for command packets

### 6. Preserve worker routing through strategy wrapping

The current strategy wrapper creates a model reviewer packet but does not guarantee the implementer's worker-routing hints survive into the reviewer packet.

For model-backed strategy conditions in this slice:

- copy `routingHints` from the source model packet into the generated reviewer packet

This keeps both implementer and reviewer on the same explicit Codex route and avoids widening into generic host autodetection.

## Testing strategy

### A. Codex executor prompt wiring

Add a focused executor test proving that when:

- a packet has `intent.context.memories`
- a Codex renderer is provided

then the spawned Codex prompt includes the rendered `<memories>` block.

### B. Strategy wrapper routing preservation

Add a focused strategy-wrapper test proving a model packet with:

- `routingHints.preferredWorker = "codex"`

produces a reviewer child packet that preserves the same routing hint.

### C. Eval smoke test

Add an integration-style test for the new suite that:

- installs a stub `codex` binary on `PATH`
- verifies `model-codex` fails without `BUILDPLANE_EVAL_MODEL=1`
- verifies `BUILDPLANE_EVAL_MODEL=1` runs the suite successfully
- asserts:
  - suite id is `model-codex`
  - one fixture executed
  - memory-on conditions injected memories
  - nomemory conditions did not

## Likely files

### New
- `eval/suites/model-codex/hello-memory-smoke/meta.json`
- `eval/suites/model-codex/hello-memory-smoke/run-1.json`
- `eval/suites/model-codex/hello-memory-smoke/run-2.json`
- `test/eval/model-codex-suite.test.ts`

### Modified
- `eval/runner.ts`
- `packages/adapters-codex/test/codex-executor.test.ts`
- `apps/cli/src/strategy-wrapper.ts`
- `apps/cli/test/strategy-wrapper.test.ts`

## Verification set

Focused tests:

```bash
npx vitest run \
  packages/adapters-codex/test/codex-executor.test.ts \
  apps/cli/test/strategy-wrapper.test.ts \
  test/eval/model-codex-suite.test.ts
```

Harness checks:

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no benchmark-report redesign
- no multi-provider support
- no eval CI workflow
- no raw-agent comparison suite
- no host/auth doctor surface
