# Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute `buildplane run --packet <path>` inside a fresh git worktree rooted at `.buildplane/workspaces/<run-id>`, persist workspace lifecycle state, delete successful workspaces, retain failed ones, and surface the resulting metadata through `status` and `inspect`.

**Architecture:** Keep the slice thin and honest. `packages/kernel` owns path validation and orchestration, `packages/adapters-git` owns all direct git interaction, `packages/runtime` stays git-agnostic and executes inside a provided workspace root, `packages/storage` persists workspace events/projections plus operator queries, and `apps/cli` remains a composition root and output formatter only. Defer crash recovery, explicit cleanup commands, and concurrent-run coordination.

**Tech Stack:** TypeScript, pnpm workspaces, Node.js 24.13.1, `node:sqlite`, `node:child_process`, Git CLI, Vitest

---

## Planned file structure

### CLI

- Modify: `apps/cli/package.json` - add `@buildplane/adapters-git` workspace dependency
- Modify: `apps/cli/src/run-cli.ts` - compose the git adapter into the CLI composition root and preserve stable operator error handling
- Modify: `apps/cli/src/formatters.ts` - render workspace-aware run/status/inspect output in human and JSON modes
- Modify: `apps/cli/test/run-cli.test.ts` - cover git-aware status/inspect serialization and human output additions

### Kernel

- Create: `packages/kernel/src/workspace-paths.ts` - validate `execution.cwd` and output paths against the computed worktree root
- Modify: `packages/kernel/src/run-loop.ts` - add workspace snapshot/query types and optional evidence message support
- Modify: `packages/kernel/src/ports.ts` - add the git workspace port and storage methods for workspace lifecycle writes
- Modify: `packages/kernel/src/orchestrator.ts` - validate repo + packet paths, prepare worktree, execute inside worktree, persist workspace lifecycle, and distinguish infra failures from policy failures
- Modify: `packages/kernel/src/index.ts` - export the new workspace helpers and contract types
- Modify: `packages/kernel/src/index.d.ts` - keep root package types aligned for clean-checkout typecheck
- Test: `packages/kernel/test/workspace-paths.test.ts`
- Modify: `packages/kernel/test/orchestrator.test.ts`

### Git adapter

- Modify: `packages/adapters-git/package.json` - add exports and `@buildplane/kernel` dependency
- Create: `packages/adapters-git/src/worktree-adapter.ts` - implement repo validation, HEAD resolution, worktree creation, and worktree deletion via Git CLI
- Modify: `packages/adapters-git/src/index.ts` - export the concrete adapter factory
- Create: `packages/adapters-git/src/index.js` - root import shim for raw Node package consumption
- Create: `packages/adapters-git/src/index.d.ts` - root type shim for clean-checkout type resolution
- Test: `packages/adapters-git/test/worktree-adapter.test.ts`

### Storage

- Modify: `packages/storage/src/project-layout.ts` - add `.buildplane/workspaces/` to the resolved layout
- Modify: `packages/storage/src/index.ts` - create the new workspaces directory during initialization and expose any new helper exports needed by tests
- Modify: `packages/storage/src/store.ts` - add workspace table bootstrap, workspace read/write helpers, infra-failure evidence writes, and workspace-aware status/inspect queries
- Modify: `packages/storage/package.json` - keep package export surface aligned if new entrypoints are added
- Test: `packages/storage/test/project-init.test.ts`
- Modify: `packages/storage/test/store.test.ts`

### Runtime

- Modify: `packages/runtime/src/command-executor.ts` - treat the second argument as the execution root/workspace root for cwd resolution and output checks
- Modify: `packages/runtime/test/command-executor.test.ts`

### Shared build graph and acceptance tests

- Modify: `packages/adapters-git/tsconfig.json` - reference `../kernel`
- Modify: `apps/cli/tsconfig.json` - ensure the CLI references `../../packages/adapters-git`
- Create: `test/worktree-isolation/end-to-end.test.ts` - prove success-delete, failure-retain, untouched source checkout, and status/inspect workspace reporting in a temp git repo
- Modify: `README.md` - document `.buildplane/workspaces/` and the isolated execution behavior

### Design decisions locked for implementation

- Use Git CLI through `spawnSync()` in `packages/adapters-git`; do not add a Git library
- Compute deterministic workspace paths as `.buildplane/workspaces/<run-id>`
- Exclude `.buildplane/**` from git cleanliness checks inside the git adapter; do not mutate `.git/info/exclude` in this slice
- Validate Buildplane-managed packet paths in the kernel before any workspace is created; runtime receives an already validated packet
- Failed runs retain workspaces and atomically persist `workspace-retained` with terminal failed run state
- Passed runs atomically persist decision + `passed` run state before any delete attempt, then persist `workspace-deleted` or `workspace-cleanup-failed` after the delete result is known
- `status --json` exposes whether the latest run used worktree isolation and exposes `actionableWorkspaces` only for `retained` and `cleanup-failed` workspaces in this slice
- `inspect` may report whether a recorded workspace path currently exists on disk as a read-time observation, but it must not mutate durable state

---

## Chunk 1: Contracts, workspace validation, and git adapter foundation

**Chunk acceptance criteria:** Kernel contracts describe workspace lifecycle explicitly, packet path containment is testable before runtime executes, `packages/adapters-git` can validate a repo/pin `HEAD`/create/delete deterministic worktrees, and storage can durably represent workspace lifecycle with atomic event+projection writes.

### Task 1: Add kernel workspace contracts and path validation without breaking the graph

**Files:**
- Create: `packages/kernel/src/workspace-paths.ts`
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.js`
- Modify: `packages/kernel/src/index.d.ts`
- Test: `packages/kernel/test/workspace-paths.test.ts`

- [ ] **Step 1: Write the failing workspace-path validation test**

Create `packages/kernel/test/workspace-paths.test.ts` covering both path validation and the new contract/export surface:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BuildplaneWorkspacePort,
  RunInfrastructureFailure,
  RunPacketResult,
  StatusWorkspaceSummary,
  WorkspaceSnapshot,
} from "../src/index";
import { validatePacketForWorkspaceRoot } from "../src/workspace-paths";

describe("workspace path validation", () => {
  it("exports workspace orchestration contracts", () => {
    expectTypeOf<BuildplaneWorkspacePort>().toBeObject();
    expectTypeOf<WorkspaceSnapshot>().toMatchTypeOf<{
      path: string;
      headSha: string;
      status: string;
    }>();
    expectTypeOf<StatusWorkspaceSummary>().toMatchTypeOf<{
      headSha: string;
      status: string;
      path?: string;
    }>();
    expectTypeOf<RunInfrastructureFailure>().toMatchTypeOf<{
      kind: string;
      message: string;
    }>();
    expectTypeOf<RunPacketResult>().toMatchTypeOf<{
      run: unknown;
      receipt?: unknown;
      decision?: unknown;
      failure?: unknown;
      workspace?: unknown;
    }>();
  });

  it("accepts worktree-relative cwd and outputs", () => {
    const packet = validatePacketForWorkspaceRoot(
      {
        unit: {
          id: "unit-1",
          kind: "command",
          scope: "task",
          inputRefs: [],
          expectedOutputs: ["tmp/out.txt"],
          verificationContract: "exit-0-and-required-outputs",
          policyProfile: "default",
        },
        execution: {
          command: "node",
          cwd: "packages/cli/../cli",
        },
        verification: {
          requiredOutputs: ["tmp/out.txt"],
        },
      },
      ".buildplane/workspaces/future-run-id",
    );

    expect(packet.execution.cwd).toBe("packages/cli");
  });

  it("rejects escaping cwd", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-2",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["tmp/out.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
            cwd: "../escape",
          },
          verification: {
            requiredOutputs: ["tmp/out.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/outside the worktree root/i);
  });

  it("rejects absolute execution cwd", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-3",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["tmp/out.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
            cwd: "/tmp/escape",
          },
          verification: {
            requiredOutputs: ["tmp/out.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/absolute/i);
  });

  it("rejects escaping unit expected outputs", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-4",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["../escape.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
          },
          verification: {
            requiredOutputs: ["tmp/out.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/outside the worktree root/i);
  });

  it("rejects absolute unit expected outputs", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-5",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["/tmp/escape.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
          },
          verification: {
            requiredOutputs: ["tmp/out.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/absolute/i);
  });

  it("rejects escaping required outputs", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-6",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["tmp/out.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
          },
          verification: {
            requiredOutputs: ["../escape.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/outside the worktree root/i);
  });

  it("rejects absolute required outputs independently", () => {
    expect(() =>
      validatePacketForWorkspaceRoot(
        {
          unit: {
            id: "unit-7",
            kind: "command",
            scope: "task",
            inputRefs: [],
            expectedOutputs: ["tmp/out.txt"],
            verificationContract: "exit-0-and-required-outputs",
            policyProfile: "default",
          },
          execution: {
            command: "node",
          },
          verification: {
            requiredOutputs: ["/tmp/escape.txt"],
          },
        },
        ".buildplane/workspaces/future-run-id",
      ),
    ).toThrow(/absolute/i);
  });
});
```

- [ ] **Step 2: Run the workspace-path test to verify it fails**

Run: `pnpm vitest --run packages/kernel/test/workspace-paths.test.ts`
Expected: FAIL because `workspace-paths.ts` and the new workspace contract exports do not exist yet.

- [ ] **Step 3: Add only the kernel-side contracts needed in this task**

Keep this task typecheck-safe by limiting it to kernel-owned contracts and avoiding storage-port changes until Task 3.

Add the minimum new shapes to `run-loop.ts`:

```ts
export interface WorkspaceSnapshot {
  readonly runId: string;
  readonly path: string;
  readonly headSha: string;
  readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
  readonly finalizedAt?: string;
  readonly cleanupError?: string;
}

export interface StatusWorkspaceSummary {
  readonly runId: string;
  readonly path?: string;
  readonly headSha: string;
  readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
  readonly finalizedAt?: string;
  readonly cleanupError?: string;
}

export interface RunInfrastructureFailure {
  readonly kind: string;
  readonly message: string;
}
```

In this task, extend `InspectSnapshot["evidence"]` items with optional `message?: string`, add `WorkspaceSnapshot` plus `RunInfrastructureFailure` as new exports, and broaden `RunPacketResult` so it can represent both domain-complete runs and infrastructure-failure runs while still carrying workspace metadata for CLI output:

```ts
export interface RunPacketResult {
  readonly run: Run;
  readonly receipt?: ExecutionReceipt;
  readonly decision?: PolicyDecision;
  readonly failure?: RunInfrastructureFailure;
  readonly workspace?: WorkspaceSnapshot;
}
```

Defer `StatusSnapshot.latestWorkspace`, `StatusSnapshot.actionableWorkspaces`, and `InspectSnapshot.workspace` to Task 3 so typecheck can stay green while storage still implements the older query surface.

In `ports.ts`, add only the new git-facing port in this task:

```ts
export interface BuildplaneWorkspacePort {
  assertRunnableRepository(projectRoot: string): { headSha: string };
  prepareWorkspace(projectRoot: string, runId: string, headSha: string): {
    path: string;
    headSha: string;
  };
  deleteWorkspace(workspace: { path: string }): {
    deleted: boolean;
    cleanupError?: string;
  };
}
```

Do **not** expand `BuildplaneStoragePort` yet. That lands in Task 3 together with the actual storage implementation.

- [ ] **Step 4: Implement `validatePacketForWorkspaceRoot()` minimally**

Create `packages/kernel/src/workspace-paths.ts` with a single exported helper that:

- rejects absolute `execution.cwd`
- rejects absolute `unit.expectedOutputs`
- rejects absolute `verification.requiredOutputs`
- rejects normalized paths that escape the supplied workspace root shape
- otherwise returns a normalized packet clone with canonicalized relative paths

Keep the implementation string/`path.resolve()` based. Do not inspect the filesystem.

- [ ] **Step 5: Re-run the focused kernel test and typecheck**

Run:

```bash
pnpm vitest --run packages/kernel/test/workspace-paths.test.ts
pnpm typecheck
```

Expected: the new workspace-path test passes and typecheck remains green because storage query/result contracts have not been expanded yet.

- [ ] **Step 6: Commit the kernel contract layer**

```bash
git add packages/kernel/src/workspace-paths.ts packages/kernel/src/run-loop.ts packages/kernel/src/ports.ts packages/kernel/src/index.ts packages/kernel/src/index.js packages/kernel/src/index.d.ts packages/kernel/test/workspace-paths.test.ts
git commit -m "feat: add worktree isolation kernel contracts"
```

### Task 2: Implement the git workspace adapter with real failure-path coverage

**Files:**
- Modify: `packages/adapters-git/package.json`
- Create: `packages/adapters-git/src/worktree-adapter.ts`
- Modify: `packages/adapters-git/src/index.ts`
- Create: `packages/adapters-git/src/index.js`
- Create: `packages/adapters-git/src/index.d.ts`
- Modify: `packages/adapters-git/tsconfig.json`
- Test: `packages/adapters-git/test/worktree-adapter.test.ts`

- [ ] **Step 1: Write the failing adapter tests against real temp repos**

Create `packages/adapters-git/test/worktree-adapter.test.ts` with at least these cases:

1. happy path: pin `HEAD`, create deterministic worktree, delete it
2. pinned-commit path: move source-repo `HEAD` after `assertRunnableRepository()` and prove `prepareWorkspace()` still creates from the originally supplied `headSha`
3. missing git binary returns a clear error
4. non-git directory returns a clear error
5. dirty repo is rejected while `.buildplane/**` is ignored
6. a retained leftover under `.buildplane/workspaces/<run-id>` does not poison the next cleanliness check
7. unresolved `HEAD` in an empty repo is rejected
8. worktree-creation failure is surfaced cleanly
9. delete failure is surfaced cleanly

Use one real temp repo helper plus an injected command-runner seam, for example:

```ts
createGitWorkspaceAdapter({
  gitBinary: "git",
  runGit: (args, options) => spawnSync("git", args, options),
});
```

Use the injected runner in tests to force deterministic `prepareWorkspace()` and `deleteWorkspace()` failures without relying on brittle filesystem tricks. Use `gitBinary` override only for the "git missing" case.

Before the first real commit in the temp repo helper, set repo-local identity so the test is portable:

```bash
git config user.name "Buildplane Test"
git config user.email "test@example.com"
```

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run: `pnpm vitest --run packages/adapters-git/test/worktree-adapter.test.ts`
Expected: FAIL because the adapter factory and exports do not exist.

- [ ] **Step 3: Make the package importable from the workspace root**

Bring `packages/adapters-git` up to the same import pattern as kernel/runtime/policy/storage:

- add `exports` in `package.json`
- add `@buildplane/kernel` dependency
- add `src/index.js` shim
- add `src/index.d.ts` shim
- update `tsconfig.json` to reference `../kernel`

- [ ] **Step 4: Implement the minimal git adapter**

Create `src/worktree-adapter.ts` with:

```ts
export function createGitWorkspaceAdapter(
  options?: {
    gitBinary?: string;
    runGit?: (args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>;
  },
): BuildplaneWorkspacePort {
  return {
    assertRunnableRepository(projectRoot) { /* git rev-parse + git status */ },
    prepareWorkspace(projectRoot, runId, headSha) { /* git worktree add --detach */ },
    deleteWorkspace(workspace) { /* git worktree remove --force */ },
  };
}
```

Required behavior:

- fail clearly when `git` is unavailable
- distinguish non-git repo from dirty working tree
- pin `HEAD` with `git rev-parse HEAD`
- ignore `.buildplane/**` state in the cleanliness check
- create `.buildplane/workspaces/` parent if needed before `git worktree add`
- create the worktree from the supplied `headSha`, not from a fresh repo lookup

- [ ] **Step 5: Re-run the focused adapter tests and typecheck**

Run:

```bash
pnpm vitest --run packages/adapters-git/test/worktree-adapter.test.ts
pnpm typecheck
```

Expected: adapter tests pass and the workspace graph still typechecks.

- [ ] **Step 6: Commit the git adapter foundation**

```bash
git add packages/adapters-git/package.json packages/adapters-git/src/index.ts packages/adapters-git/src/index.js packages/adapters-git/src/index.d.ts packages/adapters-git/src/worktree-adapter.ts packages/adapters-git/tsconfig.json packages/adapters-git/test/worktree-adapter.test.ts
git commit -m "feat: add git worktree adapter"
```

### Task 3: Add workspace persistence and layout support in storage

**Files:**
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.js`
- Modify: `packages/kernel/src/index.d.ts`
- Modify: `packages/kernel/test/orchestrator.test.ts`
- Modify: `packages/storage/src/contracts.ts`
- Modify: `packages/storage/src/project-layout.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/test/contracts.test.ts`
- Modify: `packages/storage/test/project-init.test.ts`
- Modify: `packages/storage/test/store.test.ts`

- [ ] **Step 1: Extend the failing storage tests for workspaces and infra failures**

Add assertions to `packages/storage/test/store.test.ts` that describe the new behavior:

```ts
const run = storage.createRun(packet);
storage.recordWorkspacePrepared(run.id, {
  path: "/tmp/project/.buildplane/workspaces/run-1",
  headSha: "abc123",
  sourceProjectRoot: "/tmp/project",
});

const runningStatus = storage.getStatusSnapshot();
expect(runningStatus.latestWorkspace).toMatchObject({
  runId: run.id,
  status: "active",
  headSha: "abc123",
});

storage.commitRunFailureOutcome(run.id, {
  decision,
  workspaceStatus: "retained",
});

const status = storage.getStatusSnapshot();
expect(status.latestRunUsedWorkspace).toBe(true);
expect(status.latestWorkspace).toMatchObject({
  runId: run.id,
  status: "retained",
  headSha: "abc123",
});
expect(status.actionableWorkspaces).toHaveLength(1);
expect(status.actionableWorkspaces[0]?.path).toBe(
  "/tmp/project/.buildplane/workspaces/run-1",
);

const inspect = storage.inspectTarget(run.id);
expect(inspect.workspace).toMatchObject({
  status: "retained",
  path: "/tmp/project/.buildplane/workspaces/run-1",
});
expect(inspect.workspace?.finalizedAt).toBeDefined();
```

Also add:

- one setup-failure invariant test proving there is no fake normal workspace row, `inspect` still shows infrastructure evidence, and `status.latestRunUsedWorkspace` is `true`
- one post-prepare infrastructure-failure invariant test proving the failed run is retained with failure evidence in the same durable transition
- one passed-path test for `workspace-deleted`
- one passed-path test for `workspace-cleanup-failed`
- one older-actionable-workspaces query test covering more than one retained/cleanup-failed run in newest-first order
- one projection-schema test that verifies workspace lifecycle events and projection rows are written together
- one rollback-style test for a representative transition (for example `recordWorkspacePrepared()` or `commitRunFailureOutcome()`) using a deterministic storage failpoint so half-written event/projection state is not persisted
- one SQLite bootstrap/migration test in `packages/storage/test/project-init.test.ts` or `packages/storage/test/store.test.ts` covering the new optional evidence `message` column
- one type-shape test in `packages/storage/test/contracts.test.ts` covering the new optional evidence `message` field

- [ ] **Step 2: Run the storage tests to verify they fail**

Run:

```bash
pnpm vitest --run packages/storage/test/contracts.test.ts packages/storage/test/project-init.test.ts packages/storage/test/store.test.ts
```

Expected: FAIL because the layout, table, and storage methods do not exist yet.

- [ ] **Step 3: Expand the storage port and layout together**

Now that the implementation is landing, update `run-loop.ts`, `BuildplaneStoragePort` in `packages/kernel/src/ports.ts`, and root exports together.

At this point extend the public query shapes with:

```ts
StatusSnapshot["latestRunUsedWorkspace"];
StatusSnapshot["latestWorkspace"];
StatusSnapshot["actionableWorkspaces"];
InspectSnapshot["workspace"];
```

Use `latestRunUsedWorkspace: boolean` so setup-failure runs can still report that isolation was attempted even when no durable workspace row exists.

Make `latestWorkspace` use `StatusWorkspaceSummary`, while `InspectSnapshot.workspace` and `actionableWorkspaces` use `WorkspaceSnapshot`. That keeps `inspect`/actionable entries on a required-path contract while allowing non-actionable latest status summaries to omit `path`.

Make `actionableWorkspaces` include only `retained` and `cleanup-failed` rows, matching the spec, and order them newest-first. Setup-failed runs must not leak a fake actionable workspace entry.

Update `packages/kernel/test/orchestrator.test.ts` in this task only enough to keep its storage test doubles compiling against the new storage port shape; do not rewrite the behavioral assertions until Chunk 2.

Then add the concrete storage lifecycle methods the orchestrator will call:

```ts
recordWorkspacePrepared(runId: string, workspace: {
  path: string;
  headSha: string;
  sourceProjectRoot: string;
}): void;
commitRunFailureOutcome(runId: string, payload: {
  decision?: PolicyDecision;
  infrastructureFailure?: RunInfrastructureFailure;
  workspaceStatus?: "retained";
}): Run;
commitRunSuccessOutcome(runId: string, decision: PolicyDecision): Run;
recordWorkspaceDeleted(runId: string): void;
recordWorkspaceCleanupFailed(runId: string, message: string): void;
```

This keeps outcome semantics kernel-owned while giving storage one atomic failure commit primitive.

The rules for `commitRunFailureOutcome(...)` are:

- rejected run: `decision` present, `workspaceStatus: "retained"`
- setup failure after run creation: `infrastructureFailure` present, no workspace status
- post-prepare infrastructure failure: `infrastructureFailure` present, `workspaceStatus: "retained"`

In all failure variants above, any infrastructure-failure evidence and terminal run/workspace state must be written in the same transaction, not as separate ordered calls.

Do not add a separate `recordInfrastructureFailure()` storage method in this slice. Keep all failure-evidence persistence inside `commitRunFailureOutcome(...)` so the transaction boundary cannot drift.

Do not use the old `recordDecision()` / `completeRun()` pair for the worktree-isolation path once these methods exist; keep those methods only for the already-landed local-run-loop flow until the orchestrator is rewired in Chunk 2.

At the same time, update `project-layout.ts` and `index.ts` so `.buildplane/workspaces/` is part of the resolved layout and is created during `initializeProject()`.

The layout interface should gain:

```ts
readonly workspacesDir: string;
```

- [ ] **Step 4: Add the workspace projection, event writes, and atomic transitions**

Extend `store.ts` with:

- `workspaces` projection bootstrap
- explicit `workspace-prepared`, `workspace-retained`, `workspace-deleted`, and `workspace-cleanup-failed` event writes
- workspace-aware status/inspect reads
- infrastructure-failure evidence persistence inside `commitRunFailureOutcome(...)` using the existing `evidence` table with optional `message`
- a tiny optional testing seam (for example `testingHooks` / `failpoint`) that can deterministically throw inside a transaction after one write and before the next, so rollback behavior is provable in tests

Required workspace table shape:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  run_id TEXT PRIMARY KEY,
  source_project_root TEXT NOT NULL,
  path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  cleanup_error TEXT
)
```

Also update the evidence projection to carry an optional `message` column when needed by infra failures. If the current schema lacks that column, add the minimum migration/compatibility logic so already-initialized local projects do not silently break.

Make the atomic boundaries explicit in code comments and implementation:

- event append + projection update happen together for each workspace lifecycle transition
- rejected-path finalization writes decision + terminal failed run state + `workspace-retained` together, not as separate loose calls
- setup-failed-path finalization writes infrastructure-failure evidence + terminal failed run state with no workspace row in one transaction
- post-prepare infrastructure-failed-path finalization writes infrastructure-failure evidence + terminal failed run state + `workspace-retained` together without fabricating a decision
- approved-path finalization writes decision + passed run state together before delete is attempted
- `recordWorkspacePrepared()` happens before the orchestrator later marks the run `running`, so a brief durable `pending` + `active` window is acceptable in this slice; no worker should attempt to eliminate that window with speculative cross-layer coupling

- [ ] **Step 5: Re-run the focused storage tests and typecheck**

Run:

```bash
pnpm vitest --run \
  packages/storage/test/contracts.test.ts \
  packages/storage/test/project-init.test.ts \
  packages/storage/test/store.test.ts \
  packages/kernel/test/orchestrator.test.ts
pnpm typecheck
```

Expected: workspace persistence/query tests pass, bootstrap/migration coverage passes, the updated orchestrator test double still compiles/runs, and typecheck remains green.

- [ ] **Step 6: Commit the storage layer**

```bash
git add packages/kernel/src/run-loop.ts packages/kernel/src/ports.ts packages/kernel/src/index.ts packages/kernel/src/index.js packages/kernel/src/index.d.ts packages/kernel/test/orchestrator.test.ts packages/storage/src/contracts.ts packages/storage/src/project-layout.ts packages/storage/src/index.ts packages/storage/src/store.ts packages/storage/test/contracts.test.ts packages/storage/test/project-init.test.ts packages/storage/test/store.test.ts
git commit -m "feat: add workspace lifecycle storage"
```

---

## Chunk 2: Runtime/orchestrator integration and CLI surface

**Chunk acceptance criteria:** Runtime executes inside the provided workspace root, the kernel orchestrates workspace preparation/deletion/retention correctly, and the CLI exposes the same stable commands with workspace-aware output.

**Prerequisite:** Chunk 1 is already landed, including the `BuildplaneWorkspacePort`, workspace-aware storage methods, `StatusWorkspaceSummary` / `WorkspaceSnapshot`, `RunInfrastructureFailure`, and the workspace query fields in `StatusSnapshot` / `InspectSnapshot`.

### Task 4: Make runtime execute against a workspace root

**Files:**
- Modify: `packages/runtime/src/command-executor.ts`
- Modify: `packages/runtime/test/command-executor.test.ts`

- [ ] **Step 1: Extend the runtime test to prove workspace-root semantics**

Modify `packages/runtime/test/command-executor.test.ts` so it creates a temp execution root and asserts:

- `execution.cwd` resolves relative to that supplied root
- output checks resolve relative to that supplied root
- no path is resolved against the source checkout accidentally

Add an assertion like:

```ts
expect(receipt.cwd).toBe(join(workspaceRoot, "nested"));
expect(receipt.outputChecks).toEqual([
  { path: "tmp/out.txt", exists: true },
]);
```

- [ ] **Step 2: Run the runtime test to verify it fails for the new assertions**

Run: `pnpm vitest --run packages/runtime/test/command-executor.test.ts`
Expected: FAIL on the new workspace-root assertions before any implementation change.

- [ ] **Step 3: Make the execution-root contract explicit**

Update `command-executor.ts` so the second argument is treated semantically as the execution root/workspace root, and keep all cwd/output resolution relative to that root.

Do not add git logic or packet validation here.

- [ ] **Step 4: Re-run the runtime test and typecheck**

Run:

```bash
pnpm vitest --run packages/runtime/test/command-executor.test.ts
pnpm typecheck
```

Expected: runtime test passes and typecheck stays green.

- [ ] **Step 5: Commit the runtime update**

```bash
git add packages/runtime/src/command-executor.ts packages/runtime/test/command-executor.test.ts
git commit -m "feat: run commands in workspace roots"
```

### Task 5: Integrate the git adapter into kernel orchestration

**Files:**
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/orchestrator.ts`
- Modify: `packages/kernel/test/orchestrator.test.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.d.ts`

- [ ] **Step 1: Extend the failing orchestrator test to cover workspace lifecycle ordering**

Modify `packages/kernel/test/orchestrator.test.ts` and `packages/kernel/src/run-loop.ts` so the orchestrator can enrich inspect results with a read-time `workspace.existsOnDisk?: boolean` observation when a workspace path is present.

The orchestrator tests should verify:

- happy path
- workspace-prepare failure after run creation
- workspace-prepare persistence failure after git created the worktree triggers immediate best-effort cleanup and no durable workspace row
- rejected-policy path retains the workspace
- post-prepare non-domain failures such as `markRunRunning()` persistence failure, `recordExecutionEvidence()` persistence failure, or runtime/policy throws retain the workspace when durable failure finalization is still possible
- failed-path finalization/persistence failure surfaces an infrastructure error rather than fabricating retained state
- cleanup-failed after a passed run is recorded separately from the passed run result
- `commitRunSuccessOutcome()` persistence failure after policy approval is treated as an infrastructure failure and retains the prepared workspace when durable failure finalization is still possible
- git delete succeeds but `recordWorkspaceDeleted()` persistence fails, returning an infrastructure error
- absolute/escaping packet-path rejection happens before run/workspace creation

Happy-path order should look like this in the mock event log:

```ts
[
  "get-status-snapshot-for-init-preflight",
  "validate-packet-for-workspace-root",
  "assert-repo",
  "create-run",
  "prepare-workspace",
  "record-workspace-prepared",
  "mark-run-running",
  "execute-packet",
  "record-execution-evidence",
  "evaluate-run",
  "commit-run-success-outcome",
  "delete-workspace",
  "record-workspace-deleted",
]
```

Setup-failure path should assert:

- `policy.evaluateRun()` is not called
- `commitRunFailureOutcome()` is called with `infrastructureFailure` and no workspace status
- `recordWorkspacePrepared()` is not called if preparation never completed

All runtime-calling paths should also assert that the orchestrator passes the prepared workspace path into runtime, never the source project root.

Rejected-policy path should assert:

- `commitRunFailureOutcome()` is called with `decision` plus `workspaceStatus: "retained"`
- `deleteWorkspace()` is not called

Post-prepare non-domain failure paths should assert:

- `commitRunFailureOutcome()` is called with `infrastructureFailure` plus `workspaceStatus: "retained"` when durable failure finalization is still possible
- the prepared workspace path is returned in the final `RunPacketResult.workspace`

Rejected-policy and cleanup-failed paths should also assert that `RunPacketResult.workspace` carries the retained/cleanup-failed workspace metadata the CLI needs for human output.

- [ ] **Step 2: Run the orchestrator test to verify it fails**

Run: `pnpm vitest --run packages/kernel/test/orchestrator.test.ts`
Expected: FAIL because the orchestrator only knows about storage/runtime/policy today.

- [ ] **Step 3: Add the workspace port to the orchestrator options and implement the flow**

Update the orchestrator options to include the git adapter port and implement the flow described by the spec.

For the passing path:

1. call `storage.getStatusSnapshot()` first as a non-mutating init preflight so `NOT_INITIALIZED` wins over repo errors
2. validate packet paths against the future workspace root
3. assert repo / get `headSha`
4. create run
5. prepare workspace
6. record prepared workspace
7. mark run `running`
8. runtime execute inside workspace path
9. record execution evidence
10. policy evaluate
11. commit success outcome through `commitRunSuccessOutcome()`
12. if that success commit fails after policy approval, treat it as an infrastructure failure and retain the prepared workspace when durable failure finalization is still possible
13. otherwise ask the git adapter to delete the workspace
14. record deleted or cleanup-failed

For the rejected-policy path:

1. same through runtime and `recordExecutionEvidence()`
2. call `commitRunFailureOutcome()` with the policy decision and `workspaceStatus: "retained"`
3. do not ask the adapter to interpret retain-vs-delete policy
4. return a `RunPacketResult` that includes the retained workspace metadata for CLI formatting

For setup failures after run creation:

1. if git worktree creation itself fails, call `commitRunFailureOutcome()` with `infrastructureFailure` and no workspace status
2. if durable `recordWorkspacePrepared()` fails after git already created the worktree, attempt immediate best-effort delete, then call `commitRunFailureOutcome()` with `infrastructureFailure` and no workspace status, and return an infrastructure error without fabricating a normal workspace row
3. skip policy evaluation

For post-prepare non-domain failures (for example `markRunRunning()` persistence failure, `recordExecutionEvidence()` persistence failure, runtime throw, or policy throw):

1. if a valid receipt exists, persist it before failure finalization when possible
2. call `commitRunFailureOutcome()` with `infrastructureFailure` and `workspaceStatus: "retained"` when durable failure finalization is still possible
3. return a `RunPacketResult` that includes the retained workspace metadata for CLI formatting

For passed-run delete-side persistence failures:

1. if `deleteWorkspace()` fails, record `workspace-cleanup-failed` and return workspace metadata in `RunPacketResult`
2. if `deleteWorkspace()` succeeds but `recordWorkspaceDeleted()` fails, return an infrastructure error and let `RunPacketResult.workspace` carry the last known workspace metadata for operator recovery

- [ ] **Step 4: Re-run the focused orchestrator test and typecheck**

Run:

```bash
pnpm vitest --run packages/kernel/test/orchestrator.test.ts
pnpm typecheck
```

Expected: orchestrator test passes and typecheck remains green.

- [ ] **Step 5: Commit the orchestration layer**

```bash
git add packages/kernel/src/orchestrator.ts packages/kernel/src/index.ts packages/kernel/src/index.d.ts packages/kernel/test/orchestrator.test.ts
git commit -m "feat: orchestrate runs in git worktrees"
```

### Task 6: Wire the CLI and formatting to the worktree-aware system

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/formatters.ts`
- Modify: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Extend the failing CLI test for workspace-aware output**

Modify `apps/cli/test/run-cli.test.ts` to cover:

- all happy-path command tests run inside a real temp git repo with user.name/user.email configured and a baseline commit so repo/`HEAD` preflight succeeds for the intended cases
- retained failed run prints a `workspace: <path>` line in human mode
- cleanup-failed passed run prints a `workspace: <path>` line in human mode
- post-run infrastructure failure after a run id exists prints `run-id: ...`, `status: failed`, and an explicit human error line while still surfacing any retained workspace path
- human `status` still prints the latest-run summary/run counts and adds the workspace note for latest `active | retained | cleanup-failed` states plus `actionable-workspaces: <count>` when non-zero
- `status --json` includes `latestRunUsedWorkspace`, `latestWorkspace`, and `actionableWorkspaces`
- `latestWorkspace.path` is present in JSON whenever the latest workspace still needs operator attention, including `active`, `retained`, and `cleanup-failed`
- human `inspect` remains the detailed operator view and adds workspace status/path/headSha plus cleanup detail lines when present
- human `inspect` plainly reports the thin-slice `passed` + `active` limitation if that combination is observed
- `inspect --json` includes `workspace.path`, `workspace.headSha`, `workspace.status`, cleanup timestamp/error details when present, and the read-time on-disk existence observation when available
- for the delete-succeeded-but-persistence-failed case, `inspect` explicitly reports that the last-known workspace path may already be gone on disk
- `inspect <unit-id>` still resolves to the latest run for that unit and includes the same workspace metadata/reporting surface
- setup-time infrastructure failure after run creation returns exit code `1` and still points the operator to the recorded run id
- missing git / non-git repo / dirty repo / unresolved `HEAD` return stable operator-facing errors

Example assertion:

```ts
expect(failed.stdout).toEqual(
  expect.arrayContaining([
    expect.stringMatching(/^run-id: /),
    "status: failed",
    expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
  ]),
);
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `pnpm vitest --run apps/cli/test/run-cli.test.ts`
Expected: FAIL because the CLI does not yet compose the git adapter or print workspace details.

- [ ] **Step 3: Wire `@buildplane/adapters-git` into the CLI composition root**

Update `apps/cli/package.json` and `apps/cli/tsconfig.json`, then modify `run-cli.ts` so it composes:

- storage adapter
- runtime adapter
- policy adapter
- new git workspace adapter
- kernel orchestrator with all four injected boundaries

In the `run` command path, call a lightweight initialization preflight (using the existing orchestrator/storage query path) before packet file loading so `NOT_INITIALIZED` wins over missing-file or invalid-packet errors.

Add one shared temp-git-repo test helper to the CLI tests so success-path cases create a repo, configure local git identity, and commit a baseline file before calling `runCli(...)`.

Keep the CLI itself ignorant of git commands.

- [ ] **Step 4: Add the minimal formatter behavior**

Update `formatters.ts` so:

- successful human `run` output remains stable (`run-id`, `status`) with no extra noise
- retained failed runs and cleanup-failed passed runs add `workspace: <path>`
- post-run infrastructure failures with a recorded run id still print `run-id: <id>` and `status: failed` on stdout, then surface the failure message clearly in human-readable form
- human `status` preserves the existing latest-run summary/run-count view, then adds the latest workspace note for `active | retained | cleanup-failed`
- human `status` shows `actionable-workspaces: <count>` when non-zero
- human `inspect` remains the detailed operator view and adds workspace status/path/headSha plus cleanup detail lines when that data exists
- human `inspect` plainly reports the thin-slice `passed` + `active` limitation when observed
- human/JSON inspect both explicitly report when a delete-side persistence failure means the last-known workspace path may already be gone on disk, using `workspace.existsOnDisk` when available
- run-formatting for infrastructure failures uses the new `RunPacketResult.failure` contract rather than ad-hoc CLI branching
- JSON output is direct serialization of the query shape without extra wrapper nesting

- [ ] **Step 5: Re-run the focused CLI test and typecheck**

Run:

```bash
pnpm vitest --run apps/cli/test/run-cli.test.ts
pnpm typecheck
```

Expected: CLI test passes and typecheck remains green.

- [ ] **Step 6: Commit the CLI surface**

```bash
git add apps/cli/package.json apps/cli/tsconfig.json apps/cli/src/run-cli.ts apps/cli/src/formatters.ts apps/cli/test/run-cli.test.ts
git commit -m "feat: expose worktree isolation in cli"
```

---

## Chunk 3: End-to-end proof, docs, and final verification

**Chunk acceptance criteria:** A temp git repo proves the isolated execution flow end to end, the README documents the now-real worktree behavior, and the full repo gate is green.

### Task 7: Add the git-backed end-to-end acceptance test

**Files:**
- Create: `test/worktree-isolation/end-to-end.test.ts`

- [ ] **Step 1: Write the failing end-to-end test first**

Create `test/worktree-isolation/end-to-end.test.ts` that:

1. creates a temp git repo with user.name/user.email configured
2. commits a baseline file so `HEAD` exists
3. runs `buildplane init` and asserts exit code 0
4. executes a passing packet that writes inside the workspace
5. verifies the workspace directory was deleted
6. verifies the source checkout did not get the generated output file
7. verifies `inspect --json` for the passing run reports `workspace.status: "deleted"`, `workspace.headSha`, and `workspace.path`
8. verifies `status --json` reports `latestRunUsedWorkspace: true` and `latestWorkspace` with status/headSha
9. executes a failing packet
10. verifies the failed run's workspace still exists on disk
11. verifies `status --json` reports `latestWorkspace.status: "retained"` and lists that workspace under `actionableWorkspaces` with path/headSha
12. verifies `inspect --json` for the failing run reports `workspace.status: "retained"`, `workspace.path`, and `workspace.headSha`

The focused failure-path scenarios from the spec (non-git rejection, dirty rejection, unresolved HEAD, absolute/escaping paths, workspace-prepare failure, cleanup-failed, older actionable-workspaces, retained leftovers not poisoning preflight, pinned headSha) are covered at the unit/integration level in Chunks 1-2 and do not need to be duplicated in the e2e test.

Use a helper like:

```ts
async function runCliCapture(cwd: string, argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    cwd,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { exitCode, stdout, stderr };
}
```

- [ ] **Step 2: Run the acceptance test to verify it fails**

Run: `pnpm vitest --run test/worktree-isolation/end-to-end.test.ts`
Expected: FAIL because the current CLI/kernel flow still runs inside the source root.

- [ ] **Step 3: Re-run the acceptance test and confirm green**

If Chunks 1-2 are correctly landed, no additional production code changes should be needed. If this step fails, investigate and fix only the specific integration gap, not a broader scope expansion.

Run: `pnpm vitest --run test/worktree-isolation/end-to-end.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit the acceptance proof**

```bash
git add test/worktree-isolation/end-to-end.test.ts
git commit -m "test: prove worktree isolation end to end"
```

### Task 8: Update docs and run final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README with the isolated execution behavior**

Add a short section that explains:

- runs execute in `.buildplane/workspaces/<run-id>`
- successful workspaces are deleted automatically
- failed workspaces are retained for inspection
- `status --json` and `inspect --json` expose workspace metadata

Keep the wording explicit that this is still the first isolation slice, not full replay/recovery.

- [ ] **Step 2: Run the focused worktree-isolation suite**

Run:

```bash
pnpm vitest --run \
  packages/kernel/test/workspace-paths.test.ts \
  packages/kernel/test/orchestrator.test.ts \
  packages/adapters-git/test/worktree-adapter.test.ts \
  packages/storage/test/project-init.test.ts \
  packages/storage/test/store.test.ts \
  packages/runtime/test/command-executor.test.ts \
  apps/cli/test/run-cli.test.ts \
  test/worktree-isolation/end-to-end.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 3: Run the full repo gate**

Run: `pnpm check`
Expected: PASS (`lint`, `typecheck`, `test`, `build`).

- [ ] **Step 4: Commit the docs and final verification state**

```bash
git add README.md
git commit -m "docs: add worktree isolation usage"
```

---

## Plan review checkpoints

### Chunk 1 review target
Review after Tasks 1-3 are complete. Focus on:

- workspace contract clarity
- path-validation boundary correctness
- git adapter portability and error messages
- storage schema/query sufficiency for status/inspect

### Chunk 2 review target
Review after Tasks 4-6 are complete. Focus on:

- orchestrator call order and transaction boundaries
- infra-failure vs policy-failure separation
- CLI stability and output contract drift

### Chunk 3 review target
Review after Tasks 7-8 are complete. Focus on:

- end-to-end proof quality
- docs matching real behavior
- verification completeness

---

Plan complete and saved to `docs/superpowers/plans/2026-03-17-worktree-isolation-implementation.md`. Ready to execute?
