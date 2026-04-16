# Pack Show JSON Route Explanation Tasks

> For Hermes: use auto-coder defaults, keep one writer, use strict TDD, and stop only when focused verification is green or there is an exact blocker.

**Goal:** add the smallest Phase 6 route-explanation slice by making native pack inspection available as structured JSON and proving the main CLI preserves the delegated JSON surface.

**Architecture:** extend native `pack show` with `--json`, reuse the existing inspection model, add one narrow JSON DTO / helper for selection reason, and add focused native + TypeScript tests.

**Tech stack:** Rust native workspace, serde/serde_json, existing pack inspection/runtime crates, TypeScript Vitest for CLI delegation coverage.

---

## Task 1: Add failing parser and CLI delegation tests

**Objective:** prove `pack show --json` is not yet supported and the TS success-path contract is missing.

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`
- Modify: `apps/cli/test/run-cli.test.ts`

**Step 1: Add a failing native parser test**
- require `buildplane-native pack show superclaude --json` to parse into pack-inspection args with `json: true`

**Step 2: Add a failing TS success-path test**
- require `buildplane pack show superclaude --json` to delegate to the native runner and preserve JSON stdout/stderr/exit code

**Step 3: Run the focused failures**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli parses_pack_show_with_json
npx vitest run apps/cli/test/run-cli.test.ts
```

Expected: FAIL because `--json` is not yet supported for native pack inspection and the TS success-path test does not exist yet.

---

## Task 2: Add native `--json` parsing and JSON output

**Objective:** make native pack inspection produce structured machine-readable output.

**Files:**
- Modify: `native/crates/bp-cli/src/main.rs`
- Modify: `native/crates/bp-pack-inspection/src/lib.rs`
- Modify: `native/crates/bp-pack-loader/src/lib.rs` only if a derive/helper is required
- Modify: `native/crates/bp-ui-terminal/src/lib.rs` only if selection-reason logic is shared

**Step 1: Extend inspect args with `json: bool`**
- parse `--json` alongside the existing flags
- keep unknown-flag behavior unchanged

**Step 2: Add a narrow JSON payload/helper**
- expose pack metadata and structured route explanation fields
- include a shared `selectionReason` string so human and JSON paths agree

**Step 3: Emit JSON on success**
- human mode continues to use the current renderer
- JSON mode prints valid JSON to stdout and exits `0`

**Step 4: Re-run the focused native parser/output tests**

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli pack_show
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-runtime
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
```

Expected: PASS.

---

## Task 3: Add and verify TS CLI passthrough coverage

**Objective:** prove the main CLI preserves the new native JSON success surface.

**Files:**
- Modify: `apps/cli/test/run-cli.test.ts`

**Step 1: Add a success-path delegated JSON test**
- the native runner dependency should receive argv including `--json`
- stdout JSON should pass through unchanged
- stderr and exit code should remain preserved

**Step 2: Re-run the focused TS test**

```bash
npx vitest run apps/cli/test/run-cli.test.ts
```

Expected: PASS.

---

## Task 4: Run the focused verification bundle

**Objective:** prove the slice works across native and TypeScript seams.

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-runtime
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
npx vitest run apps/cli/test/run-cli.test.ts
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

Then inspect the diff:

```bash
git status --short
git diff --stat
```

Expected: changes stay narrow to native pack inspection plus the TS delegation test seam.

---

## Task 5: Ship the slice

**Objective:** commit, push, open the stacked PR, and confirm green CI.

**Step 1: Commit planning docs first**

```bash
git add \
  docs/superpowers/specs/2026-04-16-pack-show-json-route-explanation-requirements.md \
  docs/superpowers/specs/2026-04-16-pack-show-json-route-explanation-design.md \
  docs/superpowers/plans/2026-04-16-pack-show-json-route-explanation-tasks.md
HUSKY=0 git commit -m "docs: plan pack show json route explanation slice"
```

**Step 2: Commit implementation**

```bash
HUSKY=0 git commit -m "feat: add pack show json route explanation"
```

**Step 3: Push and open stacked PR**
- base branch: `feat/slice5c1-benchmark-summary-docs`
- title: `feat: add pack show json route explanation`

**Step 4: Watch CI and mark ready when green**

```bash
gh pr checks <pr-number> --watch
gh pr ready <pr-number>
```
