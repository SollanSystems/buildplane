# @buildplane/adapters-models

## 0.2.0

### Minor Changes

- a5de446: Add the `buildplane planforge loop` supervisor (an FSM over `.buildplane/loop-state.json`, persisted atomically per transition) that drives plan → dry-run → envelope-check → admit → dispatch → accept → merge → re-anchor across iterations, bounded by an operator-authorized envelope. Flags: `--once`, `--max-iterations=N`, `--max-turns=N`, `--max-tokens=N`, `--wall-clock-ms=N`, `--json`. The loop resumes from a persisted non-terminal state and halts on a distinct terminal reason (roadmap-complete, stop-file, acceptance-fail, envelope-breach, token-budget, max-iterations, planner-error). It enforces both the envelope's `max_iterations` and cumulative `token_budget` as cross-iteration caps and verifies the active envelope's kernel signature on read.

  To make the runaway guard fire, `ClaudeCodeExecutor.executePacketAsync` now accepts an `AbortSignal`, streams `--output-format stream-json`, emits one `model-token-delta` per assistant text block (so the orchestrator's budget `AbortController` can count tokens and abort a runaway worker), and honors abort — with a buffered-JSON fallback that keeps the legacy single-object output path working. The runtime router forwards the signal and a lowered `--max-turns` to the worker.

### Patch Changes

- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [a5de446]
- Updated dependencies [716b8db]
  - @buildplane/kernel@0.5.0
  - @buildplane/adapters-tools@0.1.6
  - @buildplane/runtime@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [4e29efd]
- Updated dependencies [2704f4f]
  - @buildplane/kernel@0.4.2
  - @buildplane/adapters-tools@0.1.5
  - @buildplane/runtime@0.1.5

## 0.1.4

### Patch Changes

- @buildplane/adapters-tools@0.1.4
- @buildplane/kernel@0.4.1
- @buildplane/runtime@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0
  - @buildplane/adapters-tools@0.1.3
  - @buildplane/runtime@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0
  - @buildplane/adapters-tools@0.1.2
  - @buildplane/runtime@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/kernel@0.2.0
  - @buildplane/adapters-tools@0.1.1
  - @buildplane/runtime@0.1.1
