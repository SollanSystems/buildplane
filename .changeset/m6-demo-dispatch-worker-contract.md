---
"buildplane": minor
---

M6 watched-demo fixes for running the admit → dispatch cycle against an external target repo: lockfile-aware worktree dependency provisioning (`pnpm install --frozen-lockfile` / `npm ci` / `npm install`, skip when no `package.json`), standalone `planforge dispatch` worker flags (`--model`, `--max-turns`, `--worker-allowed-tools`, `--worker-timeout-ms` — R7 parity with the loop, tool grant defaults to the spike-proven set), and `bp web` serving the UI from the CLI checkout's `apps/web/dist` instead of the operator's cwd.
