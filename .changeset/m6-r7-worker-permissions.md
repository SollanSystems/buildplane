---
"@buildplane/adapters-models": patch
"buildplane": patch
---

make the PlanForge dogfood worker able to actually work (R7). Three fixes surfaced by a live loop dispatch whose worker made ten `Write` requests, all denied (`Claude requested permissions to write … but you haven't granted it yet`), zero edits, then killed by a hardcoded 300000ms timeout:

- **Tool-permission grant.** `createClaudeCodeExecutor` gains an `allowedTools?: readonly string[]` option, emitted as `--allowedTools <tool...>`. The `planforge loop` dispatch defaults it to the spike-proven headless grant `Edit,Write,Read,Glob,Grep,Bash` (overridable via `--worker-allowed-tools`), so a headless worker can edit files and run bash. This is the safe alternative to `--dangerously-skip-permissions` (still denied by the GAP-10 guard) — it names the exact allowed tools instead of bypassing all permission checks. Scope stays bounded post-hoc by the M4 diff-scope + acceptance contract, not by withholding the grant.
- **Configurable worker timeout.** The executor's `timeoutMs` is now threaded from the loop through `runPlanForgeDispatchCommand` → `loadCliOrchestrator`. `planforge loop` defaults the per-dispatch worker timeout to its `--wall-clock-ms` budget (overridable via `--worker-timeout-ms`, floored at 60000ms) instead of the executor's 300000ms default, which is far too short for a real multi-file derivation.
- **Reset re-seed.** A fresh `planforge loop` (including after a bare `--reset`) now seeds `trustedBase` from the workspace git HEAD (mirroring `bp goal`), so a bare `--reset` then re-fire has a trusted base rather than dying with the planner reporting INSUFFICIENT_EVIDENCE before dispatch.

Omitting the new flags leaves the executor/dispatch behaviour unchanged for callers that pass no grant or timeout.
