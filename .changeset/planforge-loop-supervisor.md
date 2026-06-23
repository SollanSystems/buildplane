---
"buildplane": minor
"@buildplane/adapters-models": minor
---

Add the `buildplane planforge loop` supervisor (an FSM over `.buildplane/loop-state.json`, persisted atomically per transition) that drives plan → dry-run → envelope-check → admit → dispatch → accept → merge → re-anchor across iterations, bounded by an operator-authorized envelope. Flags: `--once`, `--max-iterations=N`, `--max-turns=N`, `--max-tokens=N`, `--wall-clock-ms=N`, `--json`. The loop resumes from a persisted non-terminal state and halts on a distinct terminal reason (roadmap-complete, stop-file, acceptance-fail, envelope-breach, token-budget, max-iterations, planner-error). It enforces both the envelope's `max_iterations` and cumulative `token_budget` as cross-iteration caps and verifies the active envelope's kernel signature on read.

To make the runaway guard fire, `ClaudeCodeExecutor.executePacketAsync` now accepts an `AbortSignal`, streams `--output-format stream-json`, emits one `model-token-delta` per assistant text block (so the orchestrator's budget `AbortController` can count tokens and abort a runaway worker), and honors abort — with a buffered-JSON fallback that keeps the legacy single-object output path working. The runtime router forwards the signal and a lowered `--max-turns` to the worker.
