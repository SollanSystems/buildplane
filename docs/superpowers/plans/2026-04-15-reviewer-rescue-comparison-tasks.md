# Reviewer-Rescue Comparison Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add the smallest raw-vs-strategy comparison slice by proving one model-backed fixture is rescued by Buildplane's reviewer loop while the corresponding raw one-shot attempt is not.

**Architecture:** keep the existing `model-codex` suite and gating, add one comparison fixture, judge raw attempts against the same reviewer acceptance standard without allowing retries, and add one additive `strategyHelpedRate` aggregate.

**Tech stack:** TypeScript, Vitest, existing eval harness, local Codex stub, JSON fixtures.

---

## Task 1: Add failing suite assertions for strategy-vs-raw proof

**Objective:** prove the model suite should now capture one strategy win over raw.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`
- Modify: `eval/report.ts`
- Create: `eval/suites/model-codex/reviewer-rescue/{meta,run-1,run-2}.json`

**Step 1: Write failing assertions**
- extend the suite expectations to include the new fixture
- assert the report exposes `strategyHelpedRate`
- assert the new fixture shows at least one strategy condition passing where the corresponding raw condition fails

**Step 2: Run the focused test to verify failure**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: FAIL because the comparison fixture and aggregate do not exist yet.

---

## Task 2: Add the comparison fixture and minimal harness logic

**Objective:** evaluate raw and strategy conditions against the same reviewer approval standard.

**Files:**
- Modify: `eval/runner.ts`
- Create: `eval/suites/model-codex/reviewer-rescue/{meta,run-1,run-2}.json`

**Step 1: Add the fixture files**
- `run-1.json`: deterministic setup packet
- `run-2.json`: model packet whose first attempt produces a reviewer-rejected draft
- `meta.json`: documents that the fixture proves reviewer rescue

**Step 2: Add the narrow harness change**
- keep strategy conditions unchanged
- for raw conditions on the comparison fixture, apply a deterministic measurement-only approval check to the produced artifact
- if that approval check fails, mark the raw condition as failed for eval purposes
- do not allow any reviewer-guided retry on the raw path

**Step 3: Re-run the focused test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: still FAIL until the stub models the reviewer rescue path.

---

## Task 3: Extend the Codex stub and renderer-feedback path for reviewer rescue

**Objective:** make the new fixture deterministic under strategy and raw conditions.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`
- Modify: `packages/adapters-codex/src/codex-executor.ts`
- Modify: `packages/adapters-codex/test/codex-executor.test.ts`

**Step 1: Update the stub behavior**
- initial implementer prompt for the new fixture writes a draft artifact that reviewers reject
- reviewer prompt for the new fixture rejects unless the artifact contains the fixed/approved form
- implementer prompt containing reviewer feedback writes the corrected artifact
- preserve existing hello/memory-help fixture behavior unchanged
- add one focused executor test proving renderer-driven packets still include `model.systemPrompt` so retry feedback survives the renderer path

**Step 2: Re-run the focused test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: PASS.

---

## Task 4: Run the focused eval verification bundle

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
- model-codex includes the reviewer-rescue fixture
- report shows `strategyHelpedRate > 0`

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

Expected: only eval/report/test/docs files are changed unless a tiny supporting fix proved necessary.

---

## Task 6: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit**

```bash
git add \
  docs/superpowers/specs/2026-04-15-reviewer-rescue-comparison-requirements.md \
  docs/superpowers/specs/2026-04-15-reviewer-rescue-comparison-design.md \
  docs/superpowers/plans/2026-04-15-reviewer-rescue-comparison-tasks.md \
  eval/report.ts \
  eval/runner.ts \
  eval/suites/model-codex/reviewer-rescue/meta.json \
  eval/suites/model-codex/reviewer-rescue/run-1.json \
  eval/suites/model-codex/reviewer-rescue/run-2.json \
  test/eval/model-codex-suite.test.ts
HUSKY=0 git commit -m "feat: add reviewer-rescue raw comparison"
```

**Step 2: Push**

```bash
HUSKY=0 git push -u origin HEAD
```

**Step 3: Open stacked PR**
- base branch: `feat/slice5a2-memory-help-model-fixture`
- title: `feat: add reviewer-rescue raw comparison`

**Step 4: Watch CI and fix until green**

```bash
gh pr checks <pr-number> --watch
```

**Step 5: Mark ready when green**

```bash
gh pr ready <pr-number>
```
