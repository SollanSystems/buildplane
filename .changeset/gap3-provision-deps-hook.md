---
"@buildplane/kernel": patch
---

add optional `provisionDeps` hook to `CreateBuildplaneOrchestratorOptions`. When provided, the orchestrator invokes it with the isolated worktree path after `prepareWorkspace` succeeds and before the workspace row is recorded / admission proceeds, so dependency provisioning (e.g. `pnpm install --frozen-lockfile`) runs before acceptance-check commands. A thrown error surfaces as a `workspace-provision-failed` infrastructure failure with the worktree retained for inspection.
