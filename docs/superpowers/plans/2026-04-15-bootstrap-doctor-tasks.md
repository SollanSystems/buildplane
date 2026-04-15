# Bootstrap Doctor Implementation Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add a report-only `buildplane bootstrap doctor` command that checks Node/npm/git prerequisites and can run even when the current Node version is unsupported.

**Architecture:** add a small CLI-local bootstrap-doctor module, a human formatter, a narrow `runCli()` pre-init dispatch, and a doctor-only version-guard bypass in the published entrypoint.

**Tech stack:** TypeScript, Vitest, pnpm workspaces, Node child_process probes, existing CLI formatter/error patterns.

---

## Task 1: Add failing tests for the bootstrap doctor report helper

**Objective:** prove the doctor report shape and pass/fail semantics before implementation.

**Files:**
- Create: `apps/cli/test/bootstrap-doctor.test.ts`
- Create: `apps/cli/src/bootstrap-doctor.ts`

**Step 1: Write failing tests**
- add one test that expects a fully passing report when Node matches and npm/git probes succeed
- add one test that expects deterministic failures when Node mismatches and npm/git probes fail
- assert stable check ordering: node, npm, git
- assert the informational published-memory note is present

**Step 2: Run the focused test to verify failure**

Run:

```bash
npx vitest run apps/cli/test/bootstrap-doctor.test.ts
```

Expected: FAIL because `bootstrap-doctor.ts` does not exist yet.

**Step 3: Implement the minimal helper**
- create `inspectBootstrapDoctor(...)`
- create report/check types
- use injectable probe/current-version inputs so tests do not depend on host state

**Step 4: Re-run the focused test**

Run:

```bash
npx vitest run apps/cli/test/bootstrap-doctor.test.ts
```

Expected: PASS.

---

## Task 2: Add failing tests for CLI command dispatch and formatter output

**Objective:** prove the new command works pre-init and does not create `.buildplane`.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/formatters.ts`

**Step 1: Write failing CLI tests**
- add human-output coverage for `bootstrap doctor`
- add JSON-output coverage for `bootstrap doctor --json`
- assert exit code 0 for all-pass report
- assert exit code 1 for a failing report
- assert `.buildplane` does not get created
- inject doctor dependencies rather than depending on real host tools

**Step 2: Run the focused CLI tests to verify failure**

Run:

```bash
npx vitest run apps/cli/test/run-cli.test.ts --testNamePattern='bootstrap doctor'
```

Expected: FAIL because the command surface and formatter do not exist yet.

**Step 3: Implement the minimal CLI/formatter changes**
- add `formatBootstrapDoctorReport(...)`
- add top-level help entry for `bootstrap doctor [--json]`
- add `bootstrap` command dispatch before orchestrator loading
- keep unknown bootstrap subcommands as normal CLI errors

**Step 4: Re-run the focused CLI tests**

Run:

```bash
npx vitest run apps/cli/test/run-cli.test.ts --testNamePattern='bootstrap doctor'
```

Expected: PASS.

---

## Task 3: Add failing tests for the doctor-only Node guard bypass

**Objective:** prove unsupported Node still fails for normal commands but not for `bootstrap doctor`.

**Files:**
- Modify: `apps/cli/test/version-guard.test.ts`
- Modify: `apps/cli/test/smoke.test.ts`
- Modify: `apps/cli/src/version-guard.ts`
- Modify: `apps/cli/src/index.ts`

**Step 1: Write failing guard tests**
- unit test: helper returns true only for `bootstrap doctor` argv forms
- unit test: helper returns false for `--help`, `bootstrap`, `bootstrap status`, `run`, and empty argv
- smoke/integration test: source entrypoint can run `bootstrap doctor --json` under an unsupported-node simulation
- smoke/integration test: `--help` still throws the existing strict version error under the same unsupported-node simulation

**Step 2: Run the focused guard tests to verify failure**

Run:

```bash
npx vitest run apps/cli/test/version-guard.test.ts apps/cli/test/smoke.test.ts --testNamePattern='bootstrap doctor|node guard'
```

Expected: FAIL because the bypass helper and entrypoint routing do not exist yet.

**Step 3: Implement the minimal guard change**
- add `shouldBypassNodeVersionGuardForArgv(...)`
- update `apps/cli/src/index.ts` to skip the guard only for `bootstrap doctor`
- keep `assertSupportedNodeVersion()` unchanged for all other commands

**Step 4: Re-run the focused guard tests**

Run:

```bash
npx vitest run apps/cli/test/version-guard.test.ts apps/cli/test/smoke.test.ts --testNamePattern='bootstrap doctor|node guard'
```

Expected: PASS.

---

## Task 4: Repair any staged/published contract tests only if the entrypoint contract changed

**Objective:** keep staged published bootstrap expectations aligned with the new entrypoint/version-guard shape.

**Files:**
- Modify only if failing:
  - `test/workflow/published-bootstrap-stage.test.ts`
  - `test/workflow/published-bootstrap-install.test.ts`

**Step 1: Run the staged/published tests**

Run:

```bash
npx vitest run test/workflow/published-bootstrap-stage.test.ts test/workflow/published-bootstrap-install.test.ts
```

Expected: PASS if no contract update is needed; otherwise FAIL with exact staged-content expectation drift.

**Step 2: If failing, make the smallest contract-alignment fix**
- update only the exact staged content/assertions affected by the doctor-only guard bypass
- do not widen published command surface or README promises unless intentionally required

**Step 3: Re-run the staged/published tests**

Run the same command again and expect PASS.

---

## Task 5: Run the final focused verification set

**Objective:** prove the slice works end-to-end before commit.

**Files:**
- Verify touched files only

**Step 1: Run focused tests**

```bash
npx vitest run \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  apps/cli/test/version-guard.test.ts \
  apps/cli/test/smoke.test.ts \
  test/workflow/published-bootstrap-stage.test.ts \
  test/workflow/published-bootstrap-install.test.ts
```

**Step 2: Run repo checks**

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

**Step 3: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected: only focused Slice 4C files are changed.

---

## Task 6: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Files:**
- Commit all Slice 4C files

**Step 1: Commit**

```bash
git add docs/superpowers/specs/2026-04-15-bootstrap-doctor-requirements.md \
  docs/superpowers/specs/2026-04-15-bootstrap-doctor-design.md \
  docs/superpowers/plans/2026-04-15-bootstrap-doctor-tasks.md \
  apps/cli/src/bootstrap-doctor.ts \
  apps/cli/src/formatters.ts \
  apps/cli/src/run-cli.ts \
  apps/cli/src/version-guard.ts \
  apps/cli/src/index.ts \
  apps/cli/test/bootstrap-doctor.test.ts \
  apps/cli/test/run-cli.test.ts \
  apps/cli/test/version-guard.test.ts \
  apps/cli/test/smoke.test.ts \
  test/workflow/published-bootstrap-stage.test.ts \
  test/workflow/published-bootstrap-install.test.ts
HUSKY=0 git commit -m "feat: add bootstrap doctor"
```

**Step 2: Push**

```bash
HUSKY=0 git push -u origin HEAD
```

**Step 3: Open stacked PR**
- base branch: `feat/slice4b-installer-shim`
- title: `feat: add bootstrap doctor`

**Step 4: Watch CI and fix until green**

```bash
gh pr checks <pr-number> --watch
```

**Step 5: Mark ready when green**

```bash
gh pr ready <pr-number>
```
