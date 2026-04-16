# Memory Inspect Native Delegation Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** expose the already-landed native advanced `memory inspect` contract through the umbrella CLI without breaking the existing local learning-inspect shortcut.

**Architecture:** narrow the TS-local `memory inspect` shortcut to the exact `<id>`/`<id> --json` shape, and delegate every other inspect form to native while preserving native stdout/stderr/exit code.

**Tech stack:** TypeScript CLI routing, Vitest CLI tests, existing native memory inspect contract.

---

## Task 1: Add failing routing tests

**Objective:** prove the umbrella CLI still traps advanced `memory inspect` invocations locally instead of delegating to native.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`

**Step 1: Add a failing inspect-delegation test**
- use injected `runNativeCommand` dependencies
- call `runCliCapture(root, ["memory", "inspect", "--effective", "--json"], dependencies)`
- require one native call with:
  - `commandPath: ["memory"]`
  - `argv: ["inspect", "--effective", "--json"]`

**Step 2: Add a failing JSON-preservation assertion**
- have the native stub emit a JSON envelope string and return `0`
- assert the CLI returns that JSON unchanged on stdout

**Step 3: Run the focused failure**

```bash
npx pnpm vitest run apps/cli/test/run-cli.test.ts
```

Expected: FAIL because the current TS shortcut treats `--effective` as a learning id and never calls the native stub.

---

## Task 2: Implement the routing fix

**Objective:** preserve the local learning shortcut only for the exact legacy shape and delegate all advanced inspect forms.

**Files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/test/run-cli.test.ts`

**Step 1: Classify the exact local inspect shortcut**
- allow only one non-flag positional learning id
- allow optional `--json`
- reject any other flags or extra arguments from the local shortcut path

**Step 2: Delegate every other inspect form to native**
- reuse the existing `runNativeCommand` path for memory commands
- preserve stdout/stderr/exit code

**Step 3: Re-run the focused CLI tests**

```bash
npx pnpm vitest run apps/cli/test/run-cli.test.ts
```

Expected: PASS.

---

## Task 3: Run full verification

**Objective:** confirm the slice stays narrow and green.

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
git status --short
git diff --stat
```

Expected: changes remain limited to `apps/cli/src/run-cli.ts`, `apps/cli/test/run-cli.test.ts`, and the planning docs.

---

## Task 4: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-memory-inspect-native-delegation-requirements.md \
  docs/superpowers/specs/2026-04-16-memory-inspect-native-delegation-design.md \
  docs/superpowers/plans/2026-04-16-memory-inspect-native-delegation-tasks.md
HUSKY=0 git commit -m "docs: plan memory inspect native delegation slice"
```

**Step 2: Commit implementation**

```bash
HUSKY=0 git commit -m "fix: delegate advanced memory inspect to native"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice6c3-effective-memory-json-envelope`
- title: `fix: delegate advanced memory inspect to native`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
