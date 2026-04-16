# Model Memory-Help Fixture Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add the smallest follow-up to Slice 5A1 by proving that injected memories can materially improve one Codex-backed eval fixture.

**Architecture:** keep the existing `model-codex` suite/routing/report logic, add one new memory-sensitive fixture, and extend the test Codex stub so it succeeds only when the prompt carries the hidden output path via injected memories.

**Tech stack:** TypeScript, Vitest, existing eval harness, local Codex stub, JSON fixtures.

---

## Task 1: Add failing test coverage for a memory-helped fixture

**Objective:** prove the model suite should now contain a fixture where memory-on outperforms memory-off.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`
- Modify: `packages/adapters-codex/src/codex-executor.ts`
- Modify: `packages/adapters-codex/test/codex-executor.test.ts`
- Create: `eval/suites/model-codex/memory-helped-path/{meta,run-1,run-2}.json`

**Step 1: Write failing assertions**
- extend the opt-in suite test to expect:
  - two fixtures
  - eight total conditions
  - `memoryHelpedRate > 0`
- assert the new fixture shows `memory+strategy` passing while `nomemory+strategy` fails or underperforms

**Step 2: Run the focused test to verify failure**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: FAIL because the second fixture and behavioral proof do not exist yet.

**Step 3: Add the new fixture files**
- `run-1.json`: failing command packet that seeds a constraint learning containing the target output path
- `run-2.json`: Codex model packet whose objective does not directly reveal the target output path
- `meta.json`: explains that the fixture proves memory-on beats memory-off

**Step 4: Re-run the focused test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: still FAIL until the stub becomes prompt-sensitive.

---

## Task 2: Make the test Codex stub prompt-sensitive

**Objective:** make the suite deterministic by tying success to prompt content instead of unconditional file creation.

**Files:**
- Modify: `test/eval/model-codex-suite.test.ts`

**Step 1: Update the stub/runtime behavior**
- reviewer prompts should pass only when a JS artifact already exists in `output/`
- implementer prompts containing `output/hello.js` should create `output/hello.js`
- implementer prompts containing the hidden memory-help path should create that file
- implementer prompts with neither path should exit non-zero
- if Windows npm-style `codex.cmd` shims would truncate multiline prompts, add the smallest executor/test change needed to route through the underlying JS entry without losing the prompt body

**Step 2: Run the focused test to verify the intended red/green transition**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

Expected: PASS once the new fixture and prompt-sensitive stub line up.

---

## Task 3: Run the focused eval verification bundle

**Objective:** prove the suite works end-to-end outside the Vitest wrapper.

**Files:**
- verify only touched eval/docs files

**Step 1: Run the focused suite test**

```bash
npx vitest run test/eval/model-codex-suite.test.ts
```

**Step 2: Run harness commands**

```bash
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
BUILDPLANE_EVAL_MODEL=1 node --import tsx ./eval/runner.ts --suite model-codex --json
```

Expected:
- local suite remains unchanged
- model-codex now reports two fixtures
- `memoryHelpedRate > 0`

---

## Task 4: Run repo checks

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

Expected: only model-codex fixture/test/docs files are changed unless a tiny harness adjustment proved necessary.

---

## Task 5: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit**

```bash
git add \
  docs/superpowers/specs/2026-04-15-model-memory-help-requirements.md \
  docs/superpowers/specs/2026-04-15-model-memory-help-design.md \
  docs/superpowers/plans/2026-04-15-model-memory-help-tasks.md \
  eval/suites/model-codex/memory-helped-path/meta.json \
  eval/suites/model-codex/memory-helped-path/run-1.json \
  eval/suites/model-codex/memory-helped-path/run-2.json \
  test/eval/model-codex-suite.test.ts
HUSKY=0 git commit -m "feat: add memory-helped model fixture"
```

**Step 2: Push**

```bash
HUSKY=0 git push -u origin HEAD
```

**Step 3: Open stacked PR**
- base branch: `feat/slice5a-model-eval-smoke`
- title: `feat: add memory-helped model fixture`

**Step 4: Watch CI and fix until green**

```bash
gh pr checks <pr-number> --watch
```

**Step 5: Mark ready when green**

```bash
gh pr ready <pr-number>
```
