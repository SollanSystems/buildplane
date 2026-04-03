# Dev Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm buildplane ...` the working repo-local developer entrypoint after `pnpm install`, keep the in-repo built CLI path stable, and make the docs and verification story honest.

**Architecture:** Keep the slice narrow. The root workspace owns the new dev-only script and lightweight contract tests. `apps/cli` keeps the real source entrypoint and built package binary split. CI owns the fresh-install smoke proof outside `pnpm test`. README is updated to distinguish repo-dev, in-repo built, and future distribution language.

**Tech Stack:** TypeScript, pnpm workspaces, Node.js 24.13.1, tsx, Vitest, GitHub Actions

---

## Planned file structure

### Root workspace and workflow contracts

- Modify: `package.json` — add the root `buildplane` script without changing existing `check` / `build` flow
- Modify: `test/workflow/root-tooling.test.ts` — assert the new root script and keep the existing workflow contract coverage
- Create: `test/workflow/readme-contract.test.ts` — assert the README distinguishes repo-dev, built-path, and future distribution guidance correctly
- Modify: `.github/workflows/ci.yml` — add a fresh-install repo-dev smoke step after install and before build

### CLI import and package metadata guards

- Modify: `apps/cli/src/index.ts` — normalize the direct-run detection only if a failing command-invocation test proves the current guard is brittle under `pnpm buildplane`
- Modify: `apps/cli/test/smoke.test.ts` — add a command-invocation regression test for the source entrypoint used by the root script
- Modify: `apps/cli/test/kernel-import.test.ts` — extend raw Node import coverage from just `@buildplane/kernel` to the full CLI-facing workspace dependency closure
- Modify: `apps/cli/package.json` — keep `bin.buildplane` pointed at `./dist/index.js` and change only if a failing test proves it is wrong (expected outcome: no behavior change)

### Docs and smoke inputs

- Modify: `README.md` — replace the current install/bootstrap story with repo-dev guidance using `pnpm buildplane ...`, built-path guidance using `node apps/cli/dist/index.js ...`, and a clearly caveated future distribution note
- Create: `test/fixtures/dev-bootstrap/packet.json` — committed packet fixture safe to use in smoke checks without dirtying the repo unexpectedly

### Design decisions locked for implementation

- The blessed repo-dev command is `pnpm buildplane ...` from the workspace root
- The root script should use `node --import tsx ./apps/cli/src/index.ts`
- The repo-dev smoke proof must exercise `pnpm buildplane`, not only the underlying entrypoint
- The heavy fresh-install proof belongs in CI / dedicated smoke execution, not inside `pnpm test`
- `apps/cli/package.json` keeps `bin.buildplane = ./dist/index.js`
- README must stop presenting bare `buildplane ...` as the current repo-bootstrap path

---

## Chunk 1: Lock the repo-dev contract in scripts and lightweight tests

**Chunk acceptance criteria:** The root workspace exposes `pnpm buildplane`, root tests guard the script shape, and package metadata still points the published/package binary at the built artifact.

### Task 1: Add the root script and protect it with tooling tests

**Files:**
- Modify: `package.json`
- Modify: `test/workflow/root-tooling.test.ts`
- Modify: `apps/cli/test/smoke.test.ts`
- Modify: `apps/cli/src/index.ts` (only if the command-invocation test proves the direct-run guard is broken)

- [ ] **Step 1: Write the failing root-tooling test for the new script**

Add an assertion to `test/workflow/root-tooling.test.ts`:

```ts
expect(pkg.scripts?.buildplane).toBe(
  "node --import tsx ./apps/cli/src/index.ts",
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts`
Expected: FAIL because `scripts.buildplane` is missing.

- [ ] **Step 3: Add the minimal root script**

Update `package.json`:

```json
"scripts": {
  "build": "tsc --build",
  "buildplane": "node --import tsx ./apps/cli/src/index.ts",
  "test": "vitest --run"
}
```

Keep the existing script set unchanged aside from the new key.

- [ ] **Step 4: Re-run the focused test to verify it passes**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing command-invocation regression test**

Extend `apps/cli/test/smoke.test.ts` with a child-process test that runs the exact source entrypoint used by the root script and asserts the CLI actually emits output for a real command, not just exit code 0. A minimal example is enough:

```ts
const output = execFileSync(process.execPath, [
  '--import',
  'tsx',
  './apps/cli/src/index.ts',
], { cwd: root, encoding: 'utf8' }).trim();

expect(output).toBe('Buildplane by SollanSystems');
```

- [ ] **Step 6: Run the focused tests to verify behavior**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts apps/cli/test/smoke.test.ts`
Expected: PASS if the current direct-run guard already works. If the new smoke test fails, fix `apps/cli/src/index.ts` by normalizing the direct-run comparison before proceeding.

- [ ] **Step 7: Add package-metadata non-regression coverage**

Extend `test/workflow/root-tooling.test.ts` with an assertion block that reads `apps/cli/package.json` and verifies:

```ts
expect(cliPkg.bin?.buildplane).toBe("./dist/index.js");
```

- [ ] **Step 8: Run the focused tests again**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts apps/cli/test/smoke.test.ts`
Expected: PASS with the root-script, command-invocation, and package-bin assertions.

- [ ] **Step 9: Commit**

```bash
git add package.json test/workflow/root-tooling.test.ts apps/cli/test/smoke.test.ts apps/cli/src/index.ts
git commit -m "test: lock dev bootstrap command contract"
```

---

## Chunk 2: Guard the source-run import path and the docs contract

**Chunk acceptance criteria:** Repo tests prove the CLI-facing source-run import closure still works before build, and README contract tests describe the repo-dev path honestly.

### Task 2: Expand raw import coverage to the CLI dependency closure

**Files:**
- Modify: `apps/cli/test/kernel-import.test.ts`

- [ ] **Step 1: Write the failing import-closure test**

Keep the existing named-export assertion for `@buildplane/kernel`, and add a second closure-oriented test that executes raw Node from `apps/cli` and imports the CLI-facing packages:

```ts
const script = `
  Promise.all([
    import('@buildplane/kernel'),
    import('@buildplane/runtime'),
    import('@buildplane/policy'),
    import('@buildplane/storage'),
    import('@buildplane/adapters-git'),
  ]).then(() => console.log('ok'));
`;
```

Assert the child process prints `ok`.

- [ ] **Step 2: Run the focused import test to verify current behavior**

Run: `pnpm vitest --run apps/cli/test/kernel-import.test.ts`
Expected: PASS if the closure already works, otherwise FAIL with the missing package/import path.

Treat the CI smoke as the authoritative no-`dist` proof. This focused test only needs to prove the raw source-run import closure itself.

- [ ] **Step 3: If it fails, make the minimal import-surface fix**

Only touch the specific package metadata or shim files needed by the failing import. Do not rewrite package exports broadly without a current repro.

- [ ] **Step 4: Re-run the focused import test**

Run: `pnpm vitest --run apps/cli/test/kernel-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/test/kernel-import.test.ts apps/cli/package.json
# If the failing repro required package metadata or shim edits, add those exact files too.
git commit -m "test: cover source-run cli import closure"
```

### Task 3: Add README contract checks before editing the docs

**Files:**
- Create: `test/workflow/readme-contract.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing README contract test**

Create `test/workflow/readme-contract.test.ts` that reads `README.md` and asserts it contains:

```ts
expect(readme).toContain('pnpm buildplane init');
expect(readme).toContain('node apps/cli/dist/index.js init');
expect(readme).toMatch(/clean git working tree/i);
expect(readme).toMatch(/distribution|published.*(install|usage)/i);
expect(readme).not.toMatch(/npm install -g buildplane/);
```

The final assertion should ensure top-level global-install guidance is not presented as the current repo-dev bootstrap path.

- [ ] **Step 2: Run the README test to verify it fails**

Run: `pnpm vitest --run test/workflow/readme-contract.test.ts`
Expected: FAIL against the current README.

- [ ] **Step 3: Rewrite the README sections minimally**

Update `README.md` so it clearly separates:

1. repo development (`pnpm install`, `pnpm buildplane ...`)
2. in-repo built path (`pnpm build`, `node apps/cli/dist/index.js ...`)
3. future distribution note (explicitly not the current repo bootstrap path)

Also add the clean-working-tree precondition near the repo-dev `run` example.

- [ ] **Step 4: Re-run the README test**

Run: `pnpm vitest --run test/workflow/readme-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the root-tooling and import tests together**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts test/workflow/readme-contract.test.ts apps/cli/test/kernel-import.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md test/workflow/readme-contract.test.ts
git commit -m "docs: clarify repo dev bootstrap path"
```

---

## Chunk 3: Prove the real command in fresh-install CI

**Chunk acceptance criteria:** CI proves the actual blessed command works after install and before build, using a safe packet and no prebuilt artifacts.

### Task 4: Add a committed smoke fixture and CI repo-dev smoke step

**Files:**
- Create: `test/fixtures/dev-bootstrap/packet.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the committed smoke packet fixture**

Create `test/fixtures/dev-bootstrap/packet.json` with a passing local command packet. Using `require()` inside `node -e` is intentional here because that inline script executes in CommonJS mode by default:

```json
{
  "unit": {
    "id": "unit-dev-bootstrap-smoke",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["tmp/out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": [
      "-e",
      "const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok');"
    ]
  },
  "verification": {
    "requiredOutputs": ["tmp/out.txt"]
  }
}
```

- [ ] **Step 2: Add a failing CI smoke step before build**

Insert a new step in `.github/workflows/ci.yml` after install and before lint/build that:

1. asserts `apps/cli/dist` and CLI-facing `packages/*/dist` directories are absent
2. runs:
   - `pnpm buildplane init`
   - `pnpm buildplane run --packet test/fixtures/dev-bootstrap/packet.json`
   - captures the run id
   - `pnpm buildplane status --json`
   - `pnpm buildplane inspect "$RUN_ID" --json`
3. asserts the repo is still clean except for Buildplane-managed state
4. asserts no `dist` directories were created by the smoke
5. cleans generated `.buildplane/project.json`, `.buildplane/state.db`, `.buildplane/artifacts`, `.buildplane/evidence`, `.buildplane/runs`, `.buildplane/logs`, `.buildplane/workspaces`, and packet outputs before the later build step

- [ ] **Step 3: Run the workflow test surface locally where possible**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts test/workflow/readme-contract.test.ts apps/cli/test/kernel-import.test.ts`
Expected: PASS.

Then run a local shell repro equivalent to the CI smoke from repo root:

```bash
pnpm install --frozen-lockfile
pnpm buildplane init
pnpm buildplane run --packet test/fixtures/dev-bootstrap/packet.json
pnpm buildplane status --json
pnpm buildplane inspect <run-id> --json
```

Expected: PASS with no `dist` creation.

- [ ] **Step 4: Run full repo verification and explicit built-path smoke**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

Then run the built CLI loop explicitly:

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js run --packet test/fixtures/dev-bootstrap/packet.json
node apps/cli/dist/index.js status --json
node apps/cli/dist/index.js inspect <run-id> --json
```

Expected: PASS with the same operator-visible behavior as the repo-dev path.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml test/fixtures/dev-bootstrap/packet.json
git commit -m "ci: prove dev bootstrap flow before build"
```

---

## Plan review notes

- Keep fixes local to the bootstrap contract. Do not refactor unrelated CLI/runtime behavior.
- If the import-closure test fails, diagnose the exact package edge before changing any export surface.
- If the CI smoke reveals new cleanliness issues, fix the root cause rather than weakening the clean-worktree contract.

Plan complete and saved to `docs/superpowers/plans/2026-03-18-dev-bootstrap-implementation.md`. Ready to execute?