# Memory-Strategy Comparison Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add the smallest follow-up comparison slice by proving one `model-codex` fixture only succeeds when memory injection and the reviewer loop are both present.

**Architecture:** keep the existing `model-codex` suite, add one new fixture, and extend the deterministic Codex stub so only `memory+strategy` reaches the approved artifact.

**Tech stack:** TypeScript, Vitest, existing eval harness, local Codex stub, JSON fixtures.

---

## Task 1: Add failing suite assertions for memory+strategy-only success

**Objective:** prove the model suite should now contain a fixture where only `memory+strategy` passes.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`
- Create: `eval/suites/model-codex/memory-strategy-rescue/{meta,run-1,run-2}.json`

**Step 1: Write failing assertions**
- extend the suite expectations to include the new fixture
- assert the new fixture shows:
  - `memory+strategy` => pass
  - `memory+raw` => fail
  - `nomemory+strategy` => fail
  - `nomemory+raw` => fail

**Step 2: Run the focused test to verify failure**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: FAIL because the new fixture does not exist yet.

---

## Task 2: Add the new fixture files

**Objective:** create the hidden-memory + reviewer-rescue scenario.

**Files:**
- Create: `eval/suites/model-codex/memory-strategy-rescue/{meta,run-1,run-2}.json`

**Step 1: Create `run-1.json`**
- seed a memory that includes the hidden output path or approval hint

**Step 2: Create `run-2.json`**
- model packet whose visible objective omits the hidden path
- still allows strategy retry to react to reviewer feedback

**Step 3: Create `meta.json`**
- explain that the fixture proves memory+strategy-only success

---

## Task 3: Extend the deterministic Codex stub

**Objective:** make the new fixture deterministic under the four condition variants.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`

**Step 1: Add stub branches**
- hidden memory path present + first-round implementer => write draft artifact
- hidden memory path present + reviewer feedback => write approved artifact
- hidden memory path missing => fail
- preserve all existing fixture behavior unchanged

**Step 2: Re-run the focused test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: PASS.

---

## Task 4: Run the focused verification bundle

**Objective:** prove the slice works end-to-end outside Vitest.

**Step 1: Focused tests**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

**Step 2: Harness checks**

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
BUILDPLANE_EVAL_MODEL=1 node --import tsx ./eval/runner.ts --suite model-codex --json
```

Expected:
- local suite remains unchanged
- model-codex includes the new fixture
- the new fixture passes only under `memory+strategy`

---

## Task 5: Run repo checks

**Objective:** confirm the slice stays narrow and regression-free.

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

Expected: only eval/test/docs files are changed unless a tiny supporting fix proved necessary.

---

## Task 6: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit**

```bash
git add \
  docs/superpowers/specs/2026-04-15-memory-strategy-comparison-requirements.md \
  docs/superpowers/specs/2026-04-15-memory-strategy-comparison-design.md \
  docs/superpowers/plans/2026-04-15-memory-strategy-comparison-tasks.md \
  eval/suites/model-codex/memory-strategy-rescue/meta.json \
  eval/suites/model-codex/memory-strategy-rescue/run-1.json \
  eval/suites/model-codex/memory-strategy-rescue/run-2.json \
  test/eval/model-codex-suite.test.ts
HUSKY=0 git commit -m "feat: add memory-strategy comparison fixture"
```

**Step 2: Push**

```bash
HUSKY=0 git push -u origin HEAD
```

**Step 3: Open stacked PR**
- base branch: `feat/slice5b1-reviewer-rescue-comparison`
- title: `feat: add memory-strategy comparison fixture`

**Step 4: Watch CI and fix until green**

```bash
gh pr checks <pr-number> --watch
```

**Step 5: Mark ready when green**

```bash
gh pr ready <pr-number>
```
