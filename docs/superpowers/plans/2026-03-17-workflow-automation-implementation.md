# Buildplane Workflow Automation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict-but-lean local workflow and safe automation baseline for Buildplane: Biome, Husky, Commitlint, Changesets scaffolding, CI, Dependabot, and PR guidance.

**Architecture:** Treat repository workflow as a testable product surface. Implement it with small, explicit configuration files plus root-level workflow contract tests that verify expected scripts, hooks, CI commands, release behavior, and dependency automation. Keep publication disabled and avoid adding heavier tooling such as ESLint, Prettier, lint-staged, or Renovate.

**Tech Stack:** TypeScript, Vitest, pnpm, Biome, Husky, Commitlint, Changesets, GitHub Actions, Dependabot

---

## File Map

### Root manifests and config
- Modify: `package.json` — add workflow scripts, dev dependencies, `engines.node`, and Husky prepare hook
- Modify: `vitest.config.ts` — include root workflow contract tests
- Create: `.node-version` — pin local Node version for Buildplane contributors
- Create: `biome.json` — formatting + linting baseline
- Create: `commitlint.config.cjs` — Conventional Commit policy
- Create: `.changeset/config.json` — release PR scaffolding configuration

### Git hooks
- Create: `.husky/pre-commit` — fast repo-wide lint gate
- Create: `.husky/commit-msg` — commit message validation
- Create: `.husky/pre-push` — full local verification gate

### GitHub automation
- Create: `.github/workflows/ci.yml` — CI mirror of local commands
- Create: `.github/workflows/release.yml` — Changesets release PR workflow only
- Create: `.github/dependabot.yml` — weekly dependency and GitHub Actions updates
- Create: `.github/pull_request_template.md` — PR expectations and checklist

### Workflow contract tests
- Create: `test/workflow/root-tooling.test.ts` — asserts root scripts, Node pinning, and Biome config
- Create: `test/workflow/hooks.test.ts` — asserts Husky hooks and Commitlint config
- Create: `test/workflow/release-automation.test.ts` — asserts Changesets config and release workflow shape
- Create: `test/workflow/repo-automation.test.ts` — asserts CI, Dependabot, and PR template expectations

---

## Chunk 1: Local developer workflow

**Chunk acceptance criteria:** Buildplane has a real local workflow surface: pinned Node version, Biome-powered lint/format, root verification commands, Husky hooks, and Conventional Commit enforcement. Root workflow contract tests prove the configuration exists and stays aligned.

### Task 1: Add root tooling contracts and Biome baseline

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `.node-version`
- Create: `biome.json`
- Create: `test/workflow/root-tooling.test.ts`

- [ ] **Step 1: Write the failing workflow tooling test**

Create `test/workflow/root-tooling.test.ts` with this exact content:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("root workflow tooling", () => {
  it("pins node and defines canonical workflow scripts", () => {
    const pkg = readJson("package.json");

    expect(existsSync(join(root, ".node-version"))).toBe(true);
    expect(pkg.engines?.node).toBe("24.13.1");
    expect(pkg.scripts?.lint).toBe("biome check .");
    expect(pkg.scripts?.format).toBe("biome format --write .");
    expect(pkg.scripts?.check).toBe("pnpm lint && pnpm typecheck && pnpm test && pnpm build");
  });

  it("installs biome and enables formatter, linter, import organization, and git-aware ignores", () => {
    const pkg = readJson("package.json");
    const biome = readJson("biome.json");

    expect(pkg.devDependencies?.["@biomejs/biome"]).toBeDefined();
    expect(biome.formatter?.enabled).toBe(true);
    expect(biome.linter?.enabled).toBe(true);
    expect(biome.organizeImports?.enabled).toBe(true);
    expect(biome.vcs?.enabled).toBe(true);
    expect(biome.vcs?.useIgnoreFile).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts`
Expected: FAIL because `.node-version`, `biome.json`, and the required scripts/devDependency do not exist yet.

- [ ] **Step 3: Add the Biome dependency and root scripts**

Run: `pnpm add -Dw @biomejs/biome`

Then update `package.json` by adding or updating these keys while preserving the existing workspace metadata:

```json
{
  "engines": {
    "node": "24.13.1"
  },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --build --noEmit",
    "test": "vitest --run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome format --write .",
    "check": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  }
}
```

- [ ] **Step 4: Add the Node pin and Biome config**

Write `.node-version` with:

```text
24.13.1
```

Write `biome.json` with:

```json
{
  "$schema": "https://biomejs.dev/schemas/latest/schema.json",
  "formatter": {
    "enabled": true
  },
  "linter": {
    "enabled": true
  },
  "organizeImports": {
    "enabled": true
  },
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  }
}
```

- [ ] **Step 5: Extend Vitest to include root workflow tests**

Update `vitest.config.ts` so the `include` list becomes:

```ts
include: [
  "apps/**/test/**/*.test.ts",
  "packages/**/test/**/*.test.ts",
  "test/**/*.test.ts",
],
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts`
Expected: PASS

- [ ] **Step 7: Adopt Biome formatting across the current repo**

Run: `pnpm exec biome check --write .`
Expected: existing source files and config files are reformatted/organized so the lint gate can pass on current repo contents

- [ ] **Step 8: Run the repo commands the test is asserting**

Run: `pnpm lint && pnpm test`
Expected: all current tests pass and Biome exits 0 on the current repo state

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts .node-version biome.json test/workflow/root-tooling.test.ts
git add -u apps packages
git commit -m "build: add biome workflow baseline"
```

### Task 2: Add Husky and Commitlint workflow gates

**Files:**
- Modify: `package.json`
- Create: `.husky/pre-commit`
- Create: `.husky/commit-msg`
- Create: `.husky/pre-push`
- Create: `commitlint.config.cjs`
- Create: `test/workflow/hooks.test.ts`

- [ ] **Step 1: Write the failing hooks contract test**

Create `test/workflow/hooks.test.ts` with this exact content:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("local git hooks and commit policy", () => {
  it("defines the expected husky hooks", () => {
    expect(existsSync(join(root, ".husky/pre-commit"))).toBe(true);
    expect(existsSync(join(root, ".husky/commit-msg"))).toBe(true);
    expect(existsSync(join(root, ".husky/pre-push"))).toBe(true);

    expect(read(".husky/pre-commit")).toContain("pnpm lint");
    expect(read(".husky/commit-msg")).toContain('commitlint --edit "$1"');
    expect(read(".husky/pre-push")).toContain("pnpm check");
  });

  it("defines commitlint with the conventional baseline and husky prepare hook", () => {
    const pkg = JSON.parse(read("package.json"));
    const commitlint = read("commitlint.config.cjs");

    expect(pkg.scripts?.prepare).toBe("husky");
    expect(pkg.devDependencies?.husky).toBeDefined();
    expect(pkg.devDependencies?.["@commitlint/cli"]).toBeDefined();
    expect(pkg.devDependencies?.["@commitlint/config-conventional"]).toBeDefined();
    expect(commitlint).toContain("@commitlint/config-conventional");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest --run test/workflow/hooks.test.ts`
Expected: FAIL because Husky hooks and Commitlint config do not exist yet.

- [ ] **Step 3: Add Husky and Commitlint dependencies**

Run: `pnpm add -Dw husky @commitlint/cli @commitlint/config-conventional`

- [ ] **Step 4: Bootstrap Husky and replace the generated hook content**

Run: `pnpm exec husky init`
Expected: Husky bootstrap completes and adds `prepare: "husky"` to `package.json`

Then replace `.husky/pre-commit` with:

```sh
#!/usr/bin/env sh
pnpm lint
```

Create `.husky/commit-msg` with:

```sh
#!/usr/bin/env sh
pnpm exec commitlint --edit "$1"
```

Create `.husky/pre-push` with:

```sh
#!/usr/bin/env sh
pnpm check
```

Run: `chmod +x .husky/pre-commit .husky/commit-msg .husky/pre-push`

- [ ] **Step 5: Add Commitlint config**

Write `commitlint.config.cjs` with:

```js
module.exports = {
  extends: ["@commitlint/config-conventional"],
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest --run test/workflow/hooks.test.ts`
Expected: PASS

- [ ] **Step 7: Verify Commitlint against the branch history**

Run: `pnpm exec commitlint --from HEAD~1 --to HEAD`
Expected: PASS because existing branch commits follow the conventional format

- [ ] **Step 8: Run the full local gate**

Run: `pnpm check`
Expected: lint, typecheck, test, and build all pass

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml .husky commitlint.config.cjs test/workflow/hooks.test.ts
git commit -m "build: add husky and commitlint workflow gates"
```

## Chunk 2: Release and repository automation

**Chunk acceptance criteria:** Buildplane has safe pre-publish release scaffolding, CI that mirrors local verification, weekly Dependabot automation, and a PR template that reinforces the intended workflow. Root automation contract tests prove those files exist and contain the expected behavior.

### Task 3: Add Changesets pre-publish scaffolding

**Files:**
- Modify: `package.json`
- Create: `.changeset/config.json`
- Create: `.github/workflows/release.yml`
- Create: `test/workflow/release-automation.test.ts`

- [ ] **Step 1: Write the failing release automation test**

Create `test/workflow/release-automation.test.ts` with this exact content:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("release automation scaffolding", () => {
  it("defines changesets in package scripts and config", () => {
    const pkg = JSON.parse(read("package.json"));
    const changeset = JSON.parse(read(".changeset/config.json"));

    expect(pkg.devDependencies?.["@changesets/cli"]).toBeDefined();
    expect(pkg.scripts?.changeset).toBe("changeset");
    expect(pkg.scripts?.["changeset:status"]).toBe("changeset status --verbose");
    expect(changeset.baseBranch).toBe("main");
    expect(changeset.access).toBe("restricted");
  });

  it("defines a release workflow that updates the release PR but does not publish", () => {
    expect(existsSync(join(root, ".github/workflows/release.yml"))).toBe(true);

    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("changesets/action");
    expect(workflow).toContain("Create Release PR");
    expect(workflow).toContain("permissions:");
    expect(workflow).not.toContain("publish:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest --run test/workflow/release-automation.test.ts`
Expected: FAIL because Changesets config, workflow, and scripts do not exist yet.

- [ ] **Step 3: Add Changesets dependency and scripts**

Run: `pnpm add -D @changesets/cli`

Then update `package.json` to include:

```json
{
  "scripts": {
    "changeset": "changeset",
    "changeset:status": "changeset status --verbose"
  }
}
```

- [ ] **Step 4: Add Changesets config**

Write `.changeset/config.json` with:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": false,
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 5: Add the release PR workflow**

Write `.github/workflows/release.yml` with:

```yaml
name: Create Release PR

on:
  push:
    branches:
      - main

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Create or update release PR
        uses: changesets/action@v1
        with:
          version: pnpm exec changeset version
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest --run test/workflow/release-automation.test.ts`
Expected: PASS

- [ ] **Step 7: Verify the Changesets CLI wiring**

Run: `pnpm exec changeset status --verbose`
Expected: exits successfully and reports no unreleased changesets yet

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml .changeset/config.json .github/workflows/release.yml test/workflow/release-automation.test.ts
git commit -m "build: add changesets release scaffolding"
```

### Task 4: Add CI, Dependabot, and PR guidance

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `.github/pull_request_template.md`
- Create: `test/workflow/repo-automation.test.ts`

- [ ] **Step 1: Write the failing repository automation test**

Create `test/workflow/repo-automation.test.ts` with this exact content:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("repository automation", () => {
  it("defines CI that mirrors the local workflow", () => {
    expect(existsSync(join(root, ".github/workflows/ci.yml"))).toBe(true);

    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("pnpm lint");
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("node-version-file: .node-version");
  });

  it("defines dependabot and the PR checklist", () => {
    expect(existsSync(join(root, ".github/dependabot.yml"))).toBe(true);
    expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(true);

    const dependabot = read(".github/dependabot.yml");
    const prTemplate = read(".github/pull_request_template.md");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(prTemplate).toContain("pnpm check");
    expect(prTemplate).toContain("changeset");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest --run test/workflow/repo-automation.test.ts`
Expected: FAIL because CI, Dependabot, and PR template files do not exist yet.

- [ ] **Step 3: Add the CI workflow**

Write `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm build
```

- [ ] **Step 4: Add Dependabot configuration**

Write `.github/dependabot.yml` with:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    target-branch: main
    open-pull-requests-limit: 5

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    target-branch: main
    open-pull-requests-limit: 5
```

- [ ] **Step 5: Add the PR template**

Write `.github/pull_request_template.md` with:

```md
## Summary
- 

## Verification
- [ ] `pnpm check`

## Release
- [ ] changeset added if this change is release-worthy and the release track is active

## Docs
- [ ] Docs updated if needed
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest --run test/workflow/repo-automation.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite and full local gate**

Run: `pnpm check`
Expected: all workflow contract tests plus existing repo tests pass, and the repo completes lint, typecheck, test, and build successfully

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml .github/dependabot.yml .github/pull_request_template.md test/workflow/repo-automation.test.ts
git commit -m "ci: add repo automation workflows and template"
```

Plan complete and saved to `docs/superpowers/plans/2026-03-17-workflow-automation-implementation.md`. Ready to execute?
