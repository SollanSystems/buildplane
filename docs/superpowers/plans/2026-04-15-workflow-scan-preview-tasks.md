# Workflow Scan Preview — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into import-apply, bootstrap, installer, doctor, or native work.

**Goal:** Add a read-only `workflow scan` command that previews which Claude Code / Codex workflow surfaces Buildplane can recognize in the current workspace.

**Architecture:** Add a pure scanner helper in the TypeScript CLI, dispatch the new command before orchestrator loading, and render compact human/JSON output from a deterministic finding shape.

**Tech Stack:** TypeScript, pnpm workspaces, Node.js fs/path APIs, Vitest, Biome.

---

### Task 1: Add failing pure scanner tests

**Objective:** Prove the workflow scanner finds only the allowed high-confidence targets and ignores stateful/secret files.

**Files:**
- Create: `apps/cli/test/workflow-scan.test.ts`
- Create: fixture files under temp dirs inside the test

**Steps:**
1. Add a test covering detection of:
   - `CLAUDE.md`
   - `AGENTS.md`
   - `.claude/settings.json`
   - `.claude/settings.local.json`
   - `.claude/hooks/*`
   - `.codex/config.toml`
   - `.codex/AGENTS.md`
2. Add a test proving ignored files such as auth/log/state artifacts are excluded.
3. Add a test locking deterministic output order.
4. Run the focused scanner test and verify failure before implementation.

### Task 2: Add failing CLI tests for workflow scan

**Objective:** Prove the read-only CLI surface and help contract.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`

**Steps:**
1. Add a top-level help assertion for `workflow scan`.
2. Add a human-output test for `workflow scan` in a temp workspace.
3. Add a `workflow scan --json` test.
4. Add a regression test proving the command works before `buildplane init` and does not create `.buildplane`.
5. Run the focused CLI tests and verify failure before implementation.

### Task 3: Implement the scanner helper

**Objective:** Add the smallest deterministic read-only scanner.

**Files:**
- Create: `apps/cli/src/workflow-scan.ts`

**Steps:**
1. Implement a pure function that scans the workspace root for the approved allowlist only.
2. Classify findings into `shared|claude|codex` and `instructions|config|hooks`.
3. Filter ignored auth/log/state files.
4. Return findings in deterministic sorted order.
5. Re-run focused scanner tests until they pass.

### Task 4: Implement the CLI command surface

**Objective:** Wire the scanner into the CLI without triggering orchestrator/init requirements.

**Files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/formatters.ts`

**Steps:**
1. Add `workflow scan` to top-level help.
2. Dispatch `workflow scan [--json]` before orchestrator loading.
3. Add compact human formatter support.
4. Keep JSON output machine-readable and preview-only.
5. Re-run focused CLI tests until they pass.

### Task 5: Run focused verification

**Objective:** Verify the slice cleanly before review/ship.

**Run:**
```bash
npx vitest run \
  apps/cli/test/workflow-scan.test.ts \
  apps/cli/test/run-cli.test.ts

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

### Task 6: Review and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 3C.

**Steps:**
1. Inspect final diff for scope creep.
2. Request independent review focused on scan-only behavior.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice3c-tui-lifecycle-alerts`.
6. Watch CI and mark ready when green.
