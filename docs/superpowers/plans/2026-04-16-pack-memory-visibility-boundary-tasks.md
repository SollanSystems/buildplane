# Pack Memory Visibility Boundary Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** extract the smallest justified native memory/runtime boundary by making pack-defined memory visibility a shared seam across pack inspection and effective-memory commands.

**Architecture:** lift the pack memory-visibility policy out of CLI-local code, reuse it in native effective-memory commands, and surface the same policy in pack inspection human + JSON output.

**Tech stack:** Rust native workspace, existing pack-manifest/memory/inspection crates, serde-backed JSON output.

---

## Task 1: Add failing native tests for shared memory visibility

**Objective:** prove pack inspection does not yet expose the shared memory visibility boundary and the policy is still CLI-local.

**Files:**
- Modify: `native/crates/bp-pack-inspection/src/lib.rs`
- Modify: `native/crates/bp-ui-terminal/src/lib.rs`
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Step 1: Add a failing pack-inspection test**
- require `pack show --json` data to include the effective memory visibility policy

**Step 2: Add a failing human-render test**
- require `pack show` human output to include a `memory visibility:` section

**Step 3: Add or extend a memory CLI effective-policy agreement test**
- require effective-memory commands to derive the policy from the shared seam rather than a private local mapper

**Step 4: Run the focused failures**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
cargo test --manifest-path native/Cargo.toml -p bp-cli
```

Expected: FAIL until the shared policy seam exists.

---

## Task 2: Extract the shared memory-visibility seam

**Objective:** make pack-defined memory visibility reusable across native crates.

**Files:**
- Modify: shared native memory/inspection seam file chosen during implementation
- Modify: any small `Cargo.toml` dependency wiring needed

**Step 1: Add the serializable policy type**
- represent user/workspace/pack/session visibility explicitly

**Step 2: Add the helper that maps pack manifest memory flags into that policy**
- keep semantics unchanged from current native effective-memory behavior

**Step 3: Re-run the focused tests**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
```

Expected: policy-level tests move toward green.

---

## Task 3: Wire the shared policy into pack inspection and effective-memory commands

**Objective:** expose one consistent native memory/runtime boundary across both surfaces.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`
- Modify: `native/crates/bp-pack-inspection/src/lib.rs`
- Modify: `native/crates/bp-ui-terminal/src/lib.rs`

**Step 1: replace CLI-local policy mapping with the shared seam**
- preserve existing effective-memory behavior

**Step 2: extend pack inspection JSON + human output**
- add the structured field and human section

**Step 3: rerun focused tests**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
```

Expected: PASS.

---

## Task 4: Run verification and inspect the diff

**Objective:** confirm the slice is narrow and stable.

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli -p bp-pack-inspection -p bp-ui-terminal
npx pnpm lint
npx pnpm typecheck
npx pnpm build
git status --short
git diff --stat
```

Expected: changes remain narrow to the native memory-visibility seam and its consumers.

---

## Task 5: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-pack-memory-visibility-boundary-requirements.md \
  docs/superpowers/specs/2026-04-16-pack-memory-visibility-boundary-design.md \
  docs/superpowers/plans/2026-04-16-pack-memory-visibility-boundary-tasks.md
HUSKY=0 git commit -m "docs: plan pack memory visibility boundary slice"
```

**Step 2: Commit implementation**

```bash
HUSKY=0 git commit -m "feat: add native pack memory visibility boundary"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice6b-pack-show-json-route-explanation`
- title: `feat: add native pack memory visibility boundary`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
