# @buildplane/adapters-models

## 0.2.4

### Patch Changes

- Updated dependencies [3c0c348]
  - @buildplane/kernel@0.8.1
  - @buildplane/adapters-tools@0.1.10
  - @buildplane/runtime@0.1.10

## 0.2.3

### Patch Changes

- 9075722: make the PlanForge dogfood worker able to actually work (R7). Three fixes surfaced by a live loop dispatch whose worker made ten `Write` requests, all denied (`Claude requested permissions to write … but you haven't granted it yet`), zero edits, then killed by a hardcoded 300000ms timeout:

  - **Tool-permission grant.** `createClaudeCodeExecutor` gains an `allowedTools?: readonly string[]` option, emitted as `--allowedTools <tool...>`. The `planforge loop` dispatch defaults it to the spike-proven headless grant `Edit,Write,Read,Glob,Grep,Bash` (overridable via `--worker-allowed-tools`), so a headless worker can edit files and run bash. This is the safe alternative to `--dangerously-skip-permissions` (still denied by the GAP-10 guard) — it names the exact allowed tools instead of bypassing all permission checks. Scope stays bounded post-hoc by the M4 diff-scope + acceptance contract, not by withholding the grant.
  - **Configurable worker timeout.** The executor's `timeoutMs` is now threaded from the loop through `runPlanForgeDispatchCommand` → `loadCliOrchestrator`. `planforge loop` defaults the per-dispatch worker timeout to its `--wall-clock-ms` budget (overridable via `--worker-timeout-ms`, floored at 60000ms) instead of the executor's 300000ms default, which is far too short for a real multi-file derivation.
  - **Reset re-seed.** A fresh `planforge loop` (including after a bare `--reset`) now seeds `trustedBase` from the workspace git HEAD (mirroring `bp goal`), so a bare `--reset` then re-fire has a trusted base rather than dying with the planner reporting INSUFFICIENT_EVIDENCE before dispatch.

  Omitting the new flags leaves the executor/dispatch behaviour unchanged for callers that pass no grant or timeout.

- 96c866e: emit per-tool-call tape events from the Claude Code worker (M6-S8, demo step 7).

  The `claude-code-executor` now parses `tool_use` (assistant) and `tool_result`
  (user) content blocks out of the `--output-format stream-json` worker stream and
  forwards them to a new optional `onToolEvent` callback (`ClaudeToolEvent`),
  mirroring the `onCapabilityDenied` shape. The executor stays transport-agnostic
  — it never builds ledger payloads. Existing token-delta, terminal-result, and
  usage handling is unchanged; absent the callback the tool blocks are parsed
  silently.

  `apps/cli` wires the concrete emitter (`createClaudeToolLedgerEmitter`) that maps
  the callback data onto the signed tape as `ToolRequestStoredV1` / `ToolResultV1`,
  correlating each result to its request event id by `tool_use_id`. The sink is
  bound per-run alongside the activity emitter, so a non-ledger run is a no-op.

- Updated dependencies [0f1b42e]
- Updated dependencies [fb96406]
  - @buildplane/kernel@0.8.0
  - @buildplane/adapters-tools@0.1.9
  - @buildplane/runtime@0.1.9

## 0.2.2

### Patch Changes

- Updated dependencies [6e6cf64]
  - @buildplane/kernel@0.7.0
  - @buildplane/adapters-tools@0.1.8
  - @buildplane/runtime@0.1.8

## 0.2.1

### Patch Changes

- Updated dependencies [676ecda]
  - @buildplane/kernel@0.6.0
  - @buildplane/adapters-tools@0.1.7
  - @buildplane/runtime@0.1.7

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
