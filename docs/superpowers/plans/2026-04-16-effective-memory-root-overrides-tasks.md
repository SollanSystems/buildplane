# Effective Memory Root Override Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** make native effective-memory commands preserve an explicit `--native-root` even when `--workspace-root` is also provided, regardless of flag order.

**Architecture:** keep the fix inside native memory CLI parsing, add parser coverage for inspect/explain, and add one execution-level regression for detached workspace behavior.

**Tech stack:** Rust native workspace, existing memory CLI parser/tests, existing temporary pack-manifest helpers.

---

## Task 1: Add failing parser tests for explicit native-root preservation

**Objective:** prove the parser currently drops an explicit native root when `--workspace-root` appears later.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Add failing parser tests**
- inspect effective with `--native-root` before `--workspace-root`
- inspect effective with `--workspace-root` before `--native-root`
- explain effective with `--native-root` before `--workspace-root`
- explain effective with `--workspace-root` before `--native-root`

**Step 2: Run the focused failures**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli parses_effective
```

Expected: FAIL because the problematic ordering still resets `native_root`.

---

## Task 2: Add a failing execution-level regression

**Objective:** prove the real effective-memory command path fails when native root and workspace root diverge.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Add one regression test**
- build a temp native root with a non-default pack memory policy
- use a separate workspace root outside the native tree
- parse the inspect-effective command with explicit `--native-root` followed by `--workspace-root`
- execute the parsed command and assert effective memory matches the pack policy instead of failing

**Step 2: Run the focused failure**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli effective_memory_commands_honor_explicit_native_root
```

Expected: FAIL before the parser fix lands.

---

## Task 3: Implement the minimal parser fix

**Objective:** preserve explicit native-root intent while keeping workspace-derived defaulting behavior.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Track explicit native-root state**
- introduce a small boolean or equivalent local state in `parse_inspect(...)` and `parse_explain(...)`
- only recompute workspace-derived native root when no explicit native root has been provided yet

**Step 2: Re-run the focused native tests**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
```

Expected: PASS.

---

## Task 4: Run full verification and inspect the diff

**Objective:** confirm the slice stays narrow and regression-free.

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
npx pnpm lint
npx pnpm typecheck
npx pnpm build
git status --short
git diff --stat
```

Expected: changes remain limited to native memory CLI parsing/tests plus slice docs.

---

## Task 5: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-effective-memory-root-overrides-requirements.md \
  docs/superpowers/specs/2026-04-16-effective-memory-root-overrides-design.md \
  docs/superpowers/plans/2026-04-16-effective-memory-root-overrides-tasks.md
HUSKY=0 git commit -m "docs: plan effective memory root override slice"
```

**Step 2: Commit implementation**

```bash
HUSKY=0 git commit -m "fix: preserve explicit native root for effective memory"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice6c1-pack-memory-visibility-boundary`
- title: `fix: preserve explicit native root for effective memory`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
