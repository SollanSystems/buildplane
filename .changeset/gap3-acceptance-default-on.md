---
"buildplane": patch
---

`planforge dispatch` now enforces the M4 acceptance gate by default. Pass `--no-enforce-acceptance` to opt out (e.g. during initial dogfood bringup or when the worktree has no pnpm workspace); the legacy `--enforce-acceptance` flag is still accepted but redundant. When the gate is active, worktree dependencies are provisioned via `pnpm install --frozen-lockfile` before checks run, so a task's `verificationCommands` have their binaries.
