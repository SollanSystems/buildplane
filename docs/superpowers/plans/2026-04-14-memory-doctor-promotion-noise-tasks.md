# Memory Doctor Promotion Noise Checks — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into FTS drift, expiry checks, generic hash contracts, or auto-fix flows.

**Goal:** Extend native `memory doctor` so it reports orphaned promoted rows and duplicate promoted copies.

**Architecture:** Reuse the existing native doctor report in `bp-storage-sqlite`, then surface the new fields through `bp-cli` human/JSON output. Keep this slice report-only.

**Tech Stack:** Rust, rusqlite, serde, native Buildplane memory CLI.

---

### Task 1: Add failing storage test for orphan promoted rows

**Objective:** Prove doctor reports promoted rows whose `promoted_from_id` no longer resolves.

**Files:**
- Modify: `native/crates/bp-storage-sqlite/src/lib.rs`

**Steps:**
1. Add a focused test that inserts or imports a promoted row with a missing `promoted_from_id`.
2. Run the native storage test and verify the new assertion fails for the expected reason.
3. Do not implement detection yet.

### Task 2: Add failing storage test for duplicate promoted copies

**Objective:** Prove doctor reports repeated active promoted copies with the same promoted content.

**Files:**
- Modify: `native/crates/bp-storage-sqlite/src/lib.rs`
- Optionally inspect: `native/crates/bp-memory/src/lib.rs`

**Steps:**
1. Add a focused test that promotes the same source item twice into the same destination scope.
2. Assert doctor reports both promoted ids in the duplicate-promoted field.
3. Verify the test fails before implementation.

### Task 3: Implement promoted-row doctor detection in storage

**Objective:** Extend `MemoryDoctorReport` and `doctor()` with the minimum logic needed to pass the new storage tests.

**Files:**
- Modify: `native/crates/bp-storage-sqlite/src/lib.rs`

**Steps:**
1. Extend `MemoryDoctorReport` with orphan and duplicate promoted id fields.
2. Detect orphan promoted rows by checking `promoted_from_id` against the known id set.
3. Detect duplicate active promoted rows using a deterministic grouping key.
4. Keep existing report fields unchanged.
5. Re-run the focused storage tests until they pass.

### Task 4: Add failing native CLI doctor rendering test

**Objective:** Prove human/JSON doctor output surfaces the new storage report fields.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Steps:**
1. Add a focused CLI test that exercises `memory doctor` against data with promoted-row issues.
2. Assert JSON includes the new field names.
3. Assert human output includes readable promoted-row summary labels.
4. Verify at least one assertion fails before renderer changes.

### Task 5: Implement CLI rendering updates

**Objective:** Surface the new doctor fields without changing the command surface.

**Files:**
- Modify: `native/crates/bp-cli/src/memory_cli.rs`

**Steps:**
1. Update human report rendering to include the two new summaries.
2. Keep JSON mode using existing serde-based output.
3. Re-run the focused CLI tests until they pass.

### Task 6: Run focused verification

**Objective:** Verify the slice cleanly with native Rust tests plus repo checks.

**Files:**
- No code changes expected

**Run:**
```bash
/mnt/c/Users/khall/scoop/apps/rustup/current/.cargo/bin/cargo.exe test \
  --manifest-path native/Cargo.toml \
  -p bp-storage-sqlite \
  -p bp-cli

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

**Expected:**
- targeted native tests pass
- lint passes
- typecheck passes
- build passes

### Task 7: Review, commit, and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 2B.

**Files:**
- any changed files from tasks above

**Steps:**
1. Inspect the final diff for scope creep.
2. Request independent review focused on promoted-row integrity/noise only.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice2b-promotion-lineage`.
6. Watch CI and fix any regressions before marking ready.
