# Published Installer Shim — Implementation Tasks

> **For Hermes:** Keep this slice narrow. Use TDD. Do not widen into bootstrap doctor, Windows installer support, or package graph refactors unless a failing smoke requires it.

**Goal:** Add a one-line installer shim over the existing published npm install contract and make the published bootstrap verifier exercise it.

**Architecture:** Add a small POSIX shell installer under `scripts/published-bootstrap/`, teach the README generators to advertise it, and route packed-install smoke through it using test-only environment overrides.

**Tech Stack:** POSIX shell, Node.js scripts, npm global install, Vitest, Biome.

---

### Task 1: Add failing installer workflow tests

**Objective:** Prove the installer can install a local packed tarball into an isolated prefix.

**Files:**
- Create: `test/workflow/published-bootstrap-install.test.ts`

**Steps:**
1. Add a test that stages and packs the publishable tarball.
2. Run `scripts/published-bootstrap/install.sh` against that tarball via env override into an isolated prefix.
3. Assert the installed `buildplane` binary exists in the isolated prefix.
4. Assert the installed binary can execute a minimal help/version/banner path.
5. Run the new test and verify failure before implementation.

### Task 2: Add failing README/published README contract checks

**Objective:** Prove the one-line installer becomes part of the published install contract.

**Files:**
- Modify: `test/workflow/readme-contract.test.ts`
- Modify: `test/workflow/published-bootstrap-stage.test.ts`
- Modify: `test/workflow/published-bootstrap-contract.test.ts`

**Steps:**
1. Add assertions that README Distribution includes the installer one-liner.
2. Add assertions that the derived published README includes the installer one-liner.
3. Keep `npm install -g buildplane` as fallback/reference.
4. Run the focused workflow tests and verify failure before implementation.

### Task 3: Implement the installer shim

**Objective:** Add the smallest repo-owned installer wrapper.

**Files:**
- Create: `scripts/published-bootstrap/install.sh`

**Steps:**
1. Implement minimal command checks.
2. Support `BUILDPLANE_INSTALL_SPEC`, `BUILDPLANE_INSTALL_PREFIX`, and optional npm override envs.
3. Wrap npm global install rather than building a parallel install flow.
4. Print next-step usage guidance after install.
5. Re-run the focused installer test until it passes.

### Task 4: Wire docs and positive verification through the installer

**Objective:** Make the installer the canonical one-line path while preserving existing bootstrap guarantees.

**Files:**
- Modify: `README.md`
- Modify: `scripts/published-bootstrap/readme.mjs`
- Modify: `scripts/published-bootstrap/verify-positive.mjs`

**Steps:**
1. Update Distribution docs to show the installer one-liner.
2. Keep `npm install -g buildplane` in docs as explicit fallback/reference.
3. Update packed-install smoke to call the installer shim with test-only overrides.
4. Re-run focused workflow tests until they pass.

### Task 5: Run focused verification

**Objective:** Verify the slice cleanly before review/ship.

**Run:**
```bash
npx vitest run \
  test/workflow/readme-contract.test.ts \
  test/workflow/published-bootstrap-contract.test.ts \
  test/workflow/published-bootstrap-stage.test.ts \
  test/workflow/published-bootstrap-install.test.ts

npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

**Additional validation:**
- run the packed-install smoke path in a disposable ext4 validation worktree if needed

### Task 6: Review and ship

**Objective:** Publish the slice as a stacked PR on top of Slice 4A.

**Steps:**
1. Inspect final diff for scope creep.
2. Request independent review focused on installer-shim-only behavior.
3. Commit with a focused message.
4. Push with `HUSKY=0` if needed.
5. Open a stacked PR with base `feat/slice4a-workflow-scan-preview`.
6. Watch CI and mark ready when green.
