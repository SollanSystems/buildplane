---
"@buildplane/adapters-models": patch
"buildplane": patch
---

emit per-tool-call tape events from the Claude Code worker (M6-S8, demo step 7).

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
