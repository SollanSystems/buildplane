# Benchmark Summary Publication Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** publish the smallest useful Phase 5 benchmark-summary slice by documenting the current `model-codex` evidence in repo docs and pinning that docs surface with tests.

**Architecture:** add one benchmark summary doc, add a README pointer, and pin both with workflow-level contract tests while leaving the eval harness behavior unchanged.

**Tech stack:** Markdown docs, Vitest, existing eval harness/report surfaces.

---

## Task 1: Add failing doc-surface tests

**Objective:** prove the benchmark summary doc and README pointer do not exist yet in the required shape.

**Files:**
- Create: `test/workflow/benchmark-summary-contract.test.ts`
- Modify: `test/workflow/readme-contract.test.ts`

**Step 1: Write failing contract assertions**
- require a benchmark summary doc at `docs/benchmarks/model-codex.md`
- require the doc to mention the opt-in gate, rerun command, aggregate field names, and current fixture names
- require the README to link to that benchmark summary doc

**Step 2: Run the focused tests to verify failure**

```bash
npx vitest run \
  test/workflow/benchmark-summary-contract.test.ts \
  test/workflow/readme-contract.test.ts
```

Expected: FAIL because the benchmark summary doc and README pointer are not in place yet.

---

## Task 2: Write the benchmark summary doc

**Objective:** publish the current `model-codex` benchmark evidence in one repo-local source of truth.

**Files:**
- Create: `docs/benchmarks/model-codex.md`

**Step 1: Add rerun instructions**
- include `BUILDPLANE_EVAL_MODEL=1`
- include `npx pnpm eval --suite model-codex --json`

**Step 2: Add aggregate summary language**
- describe `passRate`, `memoryInjectedRate`, `memoryHelpedRate`, `strategyHelpedRate`, and `meanDurationMs`
- explain that duration is advisory and environment-sensitive

**Step 3: Add fixture-by-fixture evidence**
- `hello-memory-smoke`
- `memory-helped-path`
- `reviewer-rescue`
- `memory-strategy-rescue`

---

## Task 3: Add a small README pointer

**Objective:** make the benchmark summary discoverable without duplicating it.

**Files:**
- Modify: `README.md`

**Step 1: Add a brief benchmark/eval section or pointer**
- mention the current `model-codex` benchmark summary
- link to `docs/benchmarks/model-codex.md`
- keep the full matrix out of the README

**Step 2: Re-run the focused tests**

```bash
npx vitest run \
  test/workflow/benchmark-summary-contract.test.ts \
  test/workflow/readme-contract.test.ts
```

Expected: PASS.

---

## Task 4: Re-verify the model suite contract

**Objective:** make sure the published docs still match the current eval evidence.

**Files:**
- Test: `test/eval/model-codex-suite.test.ts`

**Step 1: Run the focused verification bundle**

```bash
npx vitest run \
  test/workflow/benchmark-summary-contract.test.ts \
  test/workflow/readme-contract.test.ts \
  test/eval/model-codex-suite.test.ts
```

Expected:
- the benchmark doc contract passes
- the README contract passes
- the current `model-codex` suite assertions still pass

---

## Task 5: Run repo checks and supporting eval commands

**Objective:** confirm the slice stays narrow and repo-wide checks remain green.

```bash
npx pnpm build
npx pnpm eval --suite local --json
BUILDPLANE_EVAL_MODEL=1 npx pnpm eval --suite model-codex --json
npx pnpm lint
npx pnpm typecheck
```

Then inspect the diff:

```bash
git status --short
git diff --stat
```

Expected: only docs and doc-contract tests are changed unless a tiny supporting fix proved necessary.

---

## Task 6: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-benchmark-summary-publication-requirements.md \
  docs/superpowers/specs/2026-04-16-benchmark-summary-publication-design.md \
  docs/superpowers/plans/2026-04-16-benchmark-summary-publication-tasks.md
HUSKY=0 git commit -m "docs: plan benchmark summary publication slice"
```

**Step 2: Commit implementation**

```bash
git add \
  docs/benchmarks/model-codex.md \
  README.md \
  test/workflow/benchmark-summary-contract.test.ts \
  test/workflow/readme-contract.test.ts
HUSKY=0 git commit -m "docs: publish model benchmark summary"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice5b2-memory-strategy-comparison`
- title: `docs: publish model benchmark summary`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
