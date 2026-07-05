---
"buildplane": minor
---

M6-F2: emit per-tool-call tape events (`tool_request`/`ToolRequestStoredV1`, `tool_result`/`ToolResultV1`) on the `planforge dispatch` path. S8 wired the Claude worker's tool-stream sink only on the `bp run` path, so the dispatch tape showed activity bracketing but no per-tool-call events. `runPlanForgeDispatchCommand` now threads `onClaudeToolEvent` into `loadCliOrchestrator` on both the acceptance-enforced and no-enforce branches, bound to `createClaudeToolLedgerEmitter` over the same serialized signed dispatch emitter. A new dispatch unit-ctx tracker observes the activity-bracketing emitter to capture each in-flight packet's `activity_started` event id and unit id, so tool_request events carry the correct `unit_id` and parent event id. The resume path (`resumePlanForgePlanFromInput`) is a deliberate residual (M6-F1 rewires that region).
