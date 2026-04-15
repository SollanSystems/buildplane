# Model-Backed Eval Smoke Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add the smallest useful model-backed eval slice by teaching the eval harness to run one opt-in Codex-backed fixture end-to-end.

**Architecture:** keep the local eval harness intact, add one gated `model-codex` suite, add a narrow local runtime router in `eval/runner.ts`, and preserve routing hints through model strategy wrapping.

**Tech stack:** TypeScript, Vitest, existing eval harness, Codex executor, Codex renderer, git temp workspaces.

---

## Task 1: Add failing tests for model-suite gating and smoke execution

**Objective:** prove the new suite is opt-in and runnable with a stub Codex binary.

**Files:**
- Create: `test/eval/model-codex-suite.test.ts`
- Modify: `eval/runner.ts`
- Create: `eval/suites/model-codex/hello-memory-smoke/{meta,run-1,run-2}.json`

**Step 1: Write failing tests**
- one test for failing fast when `--suite model-codex` runs without `BUILDPLANE_EVAL_MODEL=1`
- one test for successful JSON report when the env is set and a stub `codex` binary is on `PATH`
- assert the JSON report shows:
  - `suiteId === "model-codex"`
  - one fixture
  - memory-on conditions inject memories
  - nomemory conditions inject zero memories

**Step 2: Run the focused test to verify failure**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: FAIL because the suite and gating do not exist yet.

**Step 3: Implement the minimal runner and fixture changes**
- add the `model-codex` fixture files
- gate model suites behind `BUILDPLANE_EVAL_MODEL=1`
- add just enough runtime routing in `eval/runner.ts` for command packets plus Codex model packets
- use async raw execution for model packets

**Step 4: Re-run the focused test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: PASS.

---

## Task 2: Add failing test for Codex renderer + memory prompt wiring

**Objective:** prove model-backed eval actually uses rendered intent memories in the Codex prompt path.

**Files:**
- Modify: `packages/adapters-codex/test/codex-executor.test.ts`

**Step 1: Write a failing executor test**
- create a model packet with `intent.context.memories`
- pass `createCodexRenderer()` to the executor
- assert the spawned prompt contains the rendered `<memories>` block and one memory line

**Step 2: Run the focused executor test to verify failure**

```bash
npx vitest run packages/adapters-codex/test/codex-executor.test.ts --testNamePattern='renderer|memories'
```

Expected: FAIL if the renderer path is not wired in the tested scenario.

**Step 3: Make the minimal implementation change**
- only if needed; prefer using the existing executor renderer support from the eval runner instead of changing executor internals unnecessarily

**Step 4: Re-run the focused executor test**

```bash
npx vitest run packages/adapters-codex/test/codex-executor.test.ts --testNamePattern='renderer|memories'
```

Expected: PASS.

---

## Task 3: Add failing test for strategy-wrapper routing-hint preservation

**Objective:** keep model-backed strategy reviewer packets on the explicit Codex route.

**Files:**
- Modify: `apps/cli/test/strategy-wrapper.test.ts`
- Modify: `apps/cli/src/strategy-wrapper.ts`

**Step 1: Write the failing test**
- add a model packet with `routingHints.preferredWorker = "codex"`
- assert the generated reviewer child packet preserves the same routing hints

**Step 2: Run the focused strategy-wrapper test to verify failure**

```bash
npx vitest run apps/cli/test/strategy-wrapper.test.ts --testNamePattern='routing hint|codex'
```

Expected: FAIL because the reviewer packet does not preserve routing hints yet.

**Step 3: Implement the minimal strategy-wrapper change**
- copy `routingHints` from the source model packet into the reviewer model packet
- do not widen command-packet behavior

**Step 4: Re-run the focused strategy-wrapper test**

```bash
npx vitest run apps/cli/test/strategy-wrapper.test.ts --testNamePattern='routing hint|codex'
```

Expected: PASS.

---

## Task 4: Run the focused verification bundle

**Objective:** prove the slice works locally before broader repo checks.

**Files:**
- verify only touched areas

**Step 1: Run focused tests**

```bash
npx vitest run \
  packages/adapters-codex/test/codex-executor.test.ts \
  apps/cli/test/strategy-wrapper.test.ts \
  test/eval/model-codex-suite.test.ts
```

**Step 2: Run harness commands**

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
```

Expected:
- local suite still works unchanged
- model-codex suite succeeds with the opt-in env

---

## Task 5: Run repo checks

**Objective:** verify no regressions outside the narrow slice.

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

Then inspect the diff:

```bash
git status --short
git diff --stat
```

Expected: only eval/Codex/strategy-wrapper/docs files are changed.

---

## Task 6: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit**

```bash
git add \
  docs/superpowers/specs/2026-04-15-model-eval-smoke-requirements.md \
  docs/superpowers/specs/2026-04-15-model-eval-smoke-design.md \
  docs/superpowers/plans/2026-04-15-model-eval-smoke-tasks.md \
  eval/runner.ts \
  eval/suites/model-codex/hello-memory-smoke/meta.json \
  eval/suites/model-codex/hello-memory-smoke/run-1.json \
  eval/suites/model-codex/hello-memory-smoke/run-2.json \
  packages/adapters-codex/test/codex-executor.test.ts \
  apps/cli/src/strategy-wrapper.ts \
  apps/cli/test/strategy-wrapper.test.ts \
  test/eval/model-codex-suite.test.ts
HUSKY=0 git commit -m "feat: add model-backed eval smoke suite"
```

**Step 2: Push**

```bash
HUSKY=0 git push -u origin HEAD
```

**Step 3: Open stacked PR**
- base branch: `feat/slice4c-bootstrap-doctor`
- title: `feat: add model-backed eval smoke suite`

**Step 4: Watch CI and fix until green**

```bash
gh pr checks <pr-number> --watch
```

**Step 5: Mark ready when green**

```bash
gh pr ready <pr-number>
```
