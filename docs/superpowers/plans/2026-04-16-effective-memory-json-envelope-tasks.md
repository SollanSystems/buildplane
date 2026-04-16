# Effective Memory JSON Envelope Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** make native effective-memory JSON output self-describing by wrapping inspect/explain effective results in provenance-carrying envelopes.

**Architecture:** add narrow JSON envelope structs inside the native memory CLI, reuse the shared effective-memory policy seam, and keep human output unchanged.

**Tech stack:** Rust native workspace, serde-backed JSON serialization, existing effective-memory command tests.

---

## Task 1: Add failing JSON contract tests

**Objective:** prove effective-memory JSON still returns bare arrays.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Add failing inspect-effective JSON test**
- require a JSON object with roots, policy, and `items`

**Step 2: Add failing explain-effective JSON test**
- require a JSON object with roots, policy, and `explanations`

**Step 3: Run the focused failures**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli effective_memory_json
```

Expected: FAIL because current JSON output is a bare array.

---

## Task 2: Implement the JSON envelopes

**Objective:** wrap the effective-memory JSON payloads without changing semantics.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Add narrow serializable envelope structs**
- one for inspect effective
- one for explain effective

**Step 2: Reuse the shared policy helper**
- surface `effectiveMemoryPolicy` in the envelope using the already-computed policy

**Step 3: Keep human output unchanged**
- only branch the `--json` effective paths

**Step 4: Re-run the focused native tests**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli effective_memory_json
```

Expected: PASS.

---

## Task 3: Run full verification

**Objective:** confirm the slice stays narrow and stable.

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
npx pnpm lint
npx pnpm typecheck
npx pnpm build
git status --short
git diff --stat
```

Expected: changes remain limited to `memory_cli.rs` plus the planning docs.

---

## Task 4: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-effective-memory-json-envelope-requirements.md \
  docs/superpowers/specs/2026-04-16-effective-memory-json-envelope-design.md \
  docs/superpowers/plans/2026-04-16-effective-memory-json-envelope-tasks.md
HUSKY=0 git commit -m "docs: plan effective memory json envelope slice"
```

**Step 2: Commit implementation**

```bash
HUSKY=0 git commit -m "feat: add effective memory json envelopes"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice6c2-effective-memory-root-overrides`
- title: `feat: add effective memory json envelopes`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
