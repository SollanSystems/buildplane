# Buildplane Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Buildplane repo with its stable product identity, package boundaries, and Milestone 1 kernel-first scaffold.

**Architecture:** Buildplane starts as a kernel-first monorepo with SQLite-backed durable state, git worktree isolation, and a terminal-first operator surface. The first implementation pass must preserve clean boundaries: kernel owns orchestration contracts, storage owns persistence contracts, runtime owns evidence capture, and CLI only wires commands to the system.

**Tech Stack:** TypeScript, pnpm workspaces, Node.js, Vitest, git

---

## Chunk 1: Product identity and workspace skeleton

**Chunk acceptance criteria:** The repo exists at `/path/to/buildplane`, the Buildplane naming matrix is written into docs and manifests, the package boundaries match the design doc, and the repo can be committed as a clean bootstrap scaffold without production logic.

### Task 1: Lock naming and state decisions first

**Files:**
- Create: `docs/superpowers/specs/2026-03-17-buildplane-design.md`
- Modify: `README.md`

- [ ] **Step 1: Write the naming matrix into the design doc**

Document the stable decisions for product, CLI, package scope, project dir, user dir, and repo owner transition.

- [ ] **Step 2: Reflect the same naming in the README**

Ensure the public-facing identity is `Buildplane by SollanSystems` and not tied to temporary company-scoped command names.

- [ ] **Step 3: Verify naming consistency**

Run: `rg -n "Buildplane|buildplane|@buildplane|.buildplane|~/.buildplane" README.md docs`
Expected: consistent product-scoped naming

### Task 2: Create the workspace scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `docs/architecture/README.md`
- Create: `apps/cli/package.json`
- Create: `packages/kernel/package.json`
- Create: `packages/storage/package.json`
- Create: `packages/runtime/package.json`
- Create: `packages/policy/package.json`
- Create: `packages/ui-tui/package.json`
- Create: `packages/adapters-models/package.json`
- Create: `packages/adapters-tools/package.json`
- Create: `packages/adapters-git/package.json`
- Create: `packages/compat-gsd/package.json`

- [ ] **Step 1: Create the workspace directories**

Run: `mkdir -p apps/cli packages/{kernel,storage,runtime,policy,ui-tui,adapters-models,adapters-tools,adapters-git,compat-gsd} docs/{architecture,superpowers/specs,superpowers/plans}`
Expected: directories exist

- [ ] **Step 2: Write the root workspace files**

Create root manifests and docs that match the naming and package boundaries from Task 1.

- [ ] **Step 3: Write minimal package manifests for each package boundary**

Each package manifest should declare its permanent package name and responsibility without implementing runtime logic.

- [ ] **Step 4: Verify the file layout**

Run: `find apps packages docs -maxdepth 2 -type f | sort`
Expected: all scaffold files appear in expected paths

- [ ] **Step 5: Commit**

```bash
git add README.md package.json pnpm-workspace.yaml tsconfig.base.json .gitignore apps packages docs
git commit -m "chore: bootstrap buildplane workspace"
```

## Chunk 2: Tooling and test harness

**Chunk acceptance criteria:** The repo has a working TypeScript + Vitest test path so code-bearing tasks can follow real TDD instead of placeholder scripting.

### Task 3: Establish the test/tooling baseline

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `apps/cli/tsconfig.json`
- Create: `packages/kernel/tsconfig.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/policy/tsconfig.json`
- Create: `packages/ui-tui/tsconfig.json`
- Create: `packages/adapters-models/tsconfig.json`
- Create: `packages/adapters-tools/tsconfig.json`
- Create: `packages/adapters-git/tsconfig.json`
- Create: `packages/compat-gsd/tsconfig.json`

- [ ] **Step 1: Add the dev tooling dependencies**

Run: `pnpm add -D typescript vitest @types/node tsx`
Expected: dependencies are added to the workspace root

- [ ] **Step 2: Add root test/build scripts**

Add scripts for `vitest --run`, `vitest`, and future TypeScript checks.

- [ ] **Step 3: Add a minimal Vitest config**

Configure a workspace-safe test runner for `apps/**/test/**/*.test.ts` and `packages/**/test/**/*.test.ts`.

- [ ] **Step 4: Add package tsconfig files extending `tsconfig.base.json`**

Keep each package ready for focused source + test files.

- [ ] **Step 5: Verify the harness works**

Run: `pnpm test`
Expected: exits 0 and reports the expected no-tests baseline for the fresh scaffold

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.ts apps/cli/tsconfig.json packages/*/tsconfig.json pnpm-lock.yaml
git commit -m "build: add typescript and vitest baseline"
```

## Chunk 3: First code-bearing tasks with TDD

**Chunk acceptance criteria:** There is one tested kernel contract, one tested storage contract, and one tested CLI bootstrap path, all following actual red-green verification.

### Task 4: Add the first kernel contracts with TDD

**Files:**
- Create: `packages/kernel/src/types.ts`
- Create: `packages/kernel/test/types.test.ts`
- Modify: `packages/kernel/package.json`

- [ ] **Step 1: Write the failing test for kernel-owned contracts**

```ts
import { describe, expect, it } from "vitest";
import type { Unit, Run } from "../src/types";

describe("kernel contract exports", () => {
  it("defines Unit and Run shapes", () => {
    const unit: Unit = {
      id: "unit-1",
      kind: "execute",
      scope: "task",
      inputRefs: [],
      expectedOutputs: [],
      verificationContract: "artifact-exists",
      policyProfile: "default",
    };

    const run: Run = {
      id: "run-1",
      unitId: unit.id,
      status: "pending",
    };

    expect(run.unitId).toBe(unit.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest --run packages/kernel/test/types.test.ts`
Expected: FAIL because `../src/types` does not exist

- [ ] **Step 3: Write minimal implementation**

Implement only `Unit` and `Run` type exports required by the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest --run packages/kernel/test/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/types.ts packages/kernel/test/types.test.ts packages/kernel/package.json
git commit -m "feat: add kernel unit and run contracts"
```

### Task 5: Add the first storage contracts with TDD

**Files:**
- Create: `packages/storage/src/contracts.ts`
- Create: `packages/storage/test/contracts.test.ts`
- Modify: `packages/storage/package.json`

- [ ] **Step 1: Write the failing test for storage-owned contracts**

```ts
import { describe, expect, it } from "vitest";
import type { ArtifactRecord, EvidenceRecord, DecisionRecord } from "../src/contracts";

describe("storage contract exports", () => {
  it("defines persisted record shapes", () => {
    const artifact: ArtifactRecord = {
      id: "artifact-1",
      runId: "run-1",
      type: "summary",
      location: ".buildplane/artifacts/summary.md",
    };

    const evidence: EvidenceRecord = {
      id: "evidence-1",
      runId: "run-1",
      kind: "command-exit",
      status: "pass",
    };

    const decision: DecisionRecord = {
      id: "decision-1",
      runId: "run-1",
      kind: "advance-unit",
      outcome: "approved",
    };

    expect([artifact.runId, evidence.runId, decision.runId]).toEqual(["run-1", "run-1", "run-1"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest --run packages/storage/test/contracts.test.ts`
Expected: FAIL because `../src/contracts` does not exist

- [ ] **Step 3: Write minimal implementation**

Implement only `ArtifactRecord`, `EvidenceRecord`, and `DecisionRecord` type exports required by the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest --run packages/storage/test/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/contracts.ts packages/storage/test/contracts.test.ts packages/storage/package.json
git commit -m "feat: add storage record contracts"
```

### Task 6: Add a minimal CLI bootstrap path with TDD

**Files:**
- Create: `apps/cli/src/index.ts`
- Create: `apps/cli/test/smoke.test.ts`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Write the failing CLI smoke test**

```ts
import { describe, expect, it } from "vitest";
import { getBootstrapBanner } from "../src/index";

describe("cli bootstrap", () => {
  it("returns the buildplane bootstrap banner", () => {
    expect(getBootstrapBanner()).toContain("Buildplane");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest --run apps/cli/test/smoke.test.ts`
Expected: FAIL because `../src/index` does not exist

- [ ] **Step 3: Write minimal implementation**

Implement `getBootstrapBanner()` and a tiny CLI entrypoint that prints the banner.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest --run apps/cli/test/smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all current Buildplane tests pass together

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/test/smoke.test.ts apps/cli/package.json
git commit -m "feat: add buildplane cli bootstrap"
```

Plan complete and saved to `docs/superpowers/plans/2026-03-17-buildplane-bootstrap.md`. Ready to execute?
