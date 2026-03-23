# Local Run Loop Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real Buildplane local control-plane loop: `buildplane init`, `buildplane run --packet <path>`, `buildplane status`, and `buildplane inspect <run-id|unit-id>` backed by durable state in `.buildplane/`.

**Architecture:** Keep the slice thin and honest. `apps/cli` is the composition root and user-facing command surface; `packages/kernel` owns packet contracts and orchestration ports; `packages/runtime` executes one deterministic local command and captures receipts; `packages/policy` judges the receipts; `packages/storage` owns `.buildplane/`, SQLite persistence, and query APIs for status/inspect. Use Node 24 built-ins only where practical, especially `node:sqlite`, `node:child_process`, and `crypto.randomUUID()`.

**Tech Stack:** TypeScript, pnpm workspaces, Node.js 24.13.1, `node:sqlite`, `node:child_process`, Vitest, git

---

## Planned file structure

### CLI

- Modify: `apps/cli/package.json` — replace placeholder build script and declare workspace dependencies on kernel/runtime/policy/storage
- Modify: `apps/cli/src/index.ts` — keep direct-entrypoint behavior, export a testable `runCli()` entry
- Create: `apps/cli/src/run-cli.ts` — parse argv, compose concrete adapters, dispatch subcommands
- Create: `apps/cli/src/formatters.ts` — render human and JSON output for init/run/status/inspect
- Test: `apps/cli/test/run-cli.test.ts`

### Kernel

- Modify: `packages/kernel/src/types.ts` — retain `Unit`/`Run`, add packet-related domain types only if they belong next to the existing contracts
- Create: `packages/kernel/src/run-loop.ts` — define `UnitPacket`, execution receipt, policy decision, status snapshot, inspect snapshot types
- Create: `packages/kernel/src/ports.ts` — define storage/runtime/policy ports used by orchestration
- Create: `packages/kernel/src/packet.ts` — zero-dependency JSON packet parsing and validation
- Create: `packages/kernel/src/orchestrator.ts` — orchestrate init/run/status/inspect through injected ports
- Modify: `packages/kernel/src/index.ts` — export the new contracts/orchestrator APIs
- Modify: `packages/kernel/package.json`
- Test: `packages/kernel/test/packet.test.ts`
- Test: `packages/kernel/test/orchestrator.test.ts`

### Storage

- Modify: `packages/storage/package.json` — add `@buildplane/kernel` dependency and proper exports if needed
- Create: `packages/storage/src/project-layout.ts` — resolve `.buildplane/` paths from a project root
- Create: `packages/storage/src/database.ts` — open `state.db`, create schema, and wrap `DatabaseSync`
- Create: `packages/storage/src/store.ts` — implement the kernel storage port and query methods
- Modify: `packages/storage/src/index.ts` — export the concrete storage adapter
- Test: `packages/storage/test/project-init.test.ts`
- Test: `packages/storage/test/store.test.ts`

### Runtime

- Modify: `packages/runtime/package.json` — add `@buildplane/kernel` dependency and exports
- Create: `packages/runtime/src/command-executor.ts` — run one local command via `spawnSync`, return receipts and output checks
- Modify: `packages/runtime/src/index.ts` — export the concrete runtime adapter
- Test: `packages/runtime/test/command-executor.test.ts`

### Policy

- Modify: `packages/policy/package.json` — add `@buildplane/kernel` dependency and exports
- Create: `packages/policy/src/decision.ts` — approve/reject based on exit code and required outputs
- Modify: `packages/policy/src/index.ts` — export the concrete policy adapter
- Test: `packages/policy/test/decision.test.ts`

### Shared build graph and acceptance tests

- Modify: `apps/cli/tsconfig.json` — add project references for internal package dependencies
- Modify: `packages/storage/tsconfig.json` — reference `../kernel`
- Modify: `packages/runtime/tsconfig.json` — reference `../kernel`
- Modify: `packages/policy/tsconfig.json` — reference `../kernel`
- Create: `test/local-run-loop/end-to-end.test.ts` — prove the full init → run → status → inspect loop in a temp project
- Modify: `README.md` — document the new local run loop once it is real

### Design decisions locked for implementation

- Use `crypto.randomUUID()` for run, event, evidence, decision, and artifact ids
- Keep packet validation hand-rolled in kernel; do not add a schema dependency
- Use `spawnSync()` for the one-command runtime to stay lean and deterministic
- Keep stdout/stderr in runtime receipts, then have storage persist them into `.buildplane/logs/`
- Record decision kinds as `advance-run` and `reject-run` consistently
- For `inspect <unit-id>`, return unit metadata plus the latest run detail and a small `runHistory` list ordered newest-first

---

## Chunk 1: Contracts and durable project state

**Chunk acceptance criteria:** Kernel contracts are expanded for the local run loop, package dependency edges build cleanly, `.buildplane/` can be initialized idempotently, and storage can persist/query the minimum event and projection state needed by `status` and `inspect`.

### Task 1: Expand kernel contracts and package graph

**Files:**
- Create: `packages/kernel/src/run-loop.ts`
- Create: `packages/kernel/src/ports.ts`
- Create: `packages/kernel/src/packet.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/types.ts`
- Modify: `packages/kernel/package.json`
- Modify: `packages/storage/package.json`
- Modify: `packages/runtime/package.json`
- Modify: `packages/policy/package.json`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `packages/storage/tsconfig.json`
- Modify: `packages/runtime/tsconfig.json`
- Modify: `packages/policy/tsconfig.json`
- Test: `packages/kernel/test/packet.test.ts`

- [ ] **Step 1: Write the failing packet contract test**

Create `packages/kernel/test/packet.test.ts` with a packet shape the whole slice will use:

```ts
import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../src/packet";

describe("unit packet parsing", () => {
  it("parses a valid local command packet", () => {
    const packet = parseUnitPacket(
      JSON.stringify({
        unit: {
          id: "unit-hello",
          kind: "command",
          scope: "task",
          inputRefs: [],
          expectedOutputs: ["tmp/out.txt"],
          verificationContract: "exit-0-and-required-outputs",
          policyProfile: "default",
        },
        execution: {
          command: "node",
          args: ["-e", "console.log('ok')"],
        },
        verification: {
          requiredOutputs: ["tmp/out.txt"],
        },
      }),
    );

    expect(packet.unit.id).toBe("unit-hello");
    expect(packet.execution.command).toBe("node");
    expect(packet.verification.requiredOutputs).toEqual(["tmp/out.txt"]);
  });
});
```

- [ ] **Step 2: Run the packet test to verify it fails**

Run: `pnpm vitest --run packages/kernel/test/packet.test.ts`
Expected: FAIL because `run-loop.ts` / `packet.ts` exports do not exist yet

- [ ] **Step 3: Wire package dependencies and project references before adding implementation**

Update package manifests and tsconfig references so future imports are legal:

- `packages/storage` depends on `@buildplane/kernel`
- `packages/runtime` depends on `@buildplane/kernel`
- `packages/policy` depends on `@buildplane/kernel`
- `apps/cli` depends on `@buildplane/kernel`, `@buildplane/storage`, `@buildplane/runtime`, `@buildplane/policy`
- `packages/kernel/package.json` exports the new public entrypoints added by this slice
- runtime/policy package manifests gain proper `exports`
- tsconfig project references mirror those package edges
- `apps/cli/package.json` replaces `echo 'TODO: implement cli build'` with a real TypeScript build command
- run `pnpm install` after the manifest edits so `pnpm-lock.yaml` and workspace links are updated before implementation

- [ ] **Step 4: Add the minimal kernel contract exports**

Implement only the contracts and parser needed by the test and the next chunk. Keep them small and serializable.

Required shapes:

```ts
export interface UnitPacket {
  readonly unit: Unit;
  readonly execution: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
  };
  readonly verification: {
    readonly requiredOutputs: readonly string[];
  };
}

export interface ExecutionReceipt {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputChecks: readonly {
    path: string;
    exists: boolean;
  }[];
}
```

Also add explicit storage/runtime/policy port interfaces in `ports.ts` and export them from `packages/kernel/src/index.ts`.

Use signatures along these lines so later tasks do not need to infer the kernel boundary:

```ts
export interface BuildplaneStoragePort {
  initializeProject(): { created: boolean; projectRoot: string; stateDbPath: string };
  createRun(packet: UnitPacket): Run;
  markRunRunning(runId: string): void;
  recordExecutionEvidence(runId: string, receipt: ExecutionReceipt): void;
  recordDecision(runId: string, decision: PolicyDecision): void;
  completeRun(runId: string, status: Run["status"]): Run;
  getStatusSnapshot(): StatusSnapshot;
  inspectTarget(id: string): InspectSnapshot;
}

export interface BuildplaneRuntimePort {
  executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
}

export interface BuildplanePolicyPort {
  evaluateRun(packet: UnitPacket, receipt: ExecutionReceipt): PolicyDecision;
}
```

Add the remaining run-loop result shapes in the same task so later chunks can reuse them directly:

```ts
export interface PolicyDecision {
  readonly kind: "advance-run" | "reject-run";
  readonly outcome: "approved" | "rejected";
  readonly reasons: readonly string[];
}

export interface StatusSnapshot {
  readonly initialized: boolean;
  readonly latestRun?: {
    readonly id: string;
    readonly unitId: string;
    readonly status: Run["status"];
  };
  readonly runCounts: {
    readonly pending: number;
    readonly running: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: number;
  };
}

export interface InspectSnapshot {
  readonly kind: "run" | "unit";
  readonly unit: Unit;
  readonly run: Run;
  readonly runHistory: readonly {
    readonly id: string;
    readonly status: Run["status"];
  }[];
  readonly evidence: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  }[];
  readonly decisions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly outcome: string;
    readonly reasons: readonly string[];
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly type: string;
    readonly location: string;
  }[];
}
```

- [ ] **Step 5: Re-run the packet test and typecheck**

Run: `pnpm vitest --run packages/kernel/test/packet.test.ts && pnpm typecheck`
Expected: PASS for the packet test, exit 0 for typecheck

- [ ] **Step 6: Commit**

```bash
git add apps/cli/package.json apps/cli/tsconfig.json packages/kernel/src/index.ts packages/kernel/src/types.ts packages/kernel/src/run-loop.ts packages/kernel/src/ports.ts packages/kernel/src/packet.ts packages/kernel/package.json packages/storage/package.json packages/storage/tsconfig.json packages/runtime/package.json packages/runtime/tsconfig.json packages/policy/package.json packages/policy/tsconfig.json pnpm-lock.yaml packages/kernel/test/packet.test.ts
git commit -m "feat: add local run loop contracts"
```

### Task 2: Add idempotent `.buildplane/` initialization and schema bootstrap

**Files:**
- Create: `packages/storage/src/project-layout.ts`
- Create: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/project-init.test.ts`

- [ ] **Step 1: Write the failing storage init test**

Create `packages/storage/test/project-init.test.ts` that initializes a temp project and asserts the canonical layout:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("project initialization", () => {
  it("creates the .buildplane layout and project metadata idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "buildplane-init-"));
    const storage = createBuildplaneStorage(root);

    const first = storage.initializeProject();
    const second = storage.initializeProject();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(readFileSync(join(root, ".buildplane", "project.json"), "utf8")).toContain(
      '"defaultPolicyProfile":"default"',
    );
  });
});
```

- [ ] **Step 2: Run the storage init test to verify it fails**

Run: `pnpm vitest --run packages/storage/test/project-init.test.ts`
Expected: FAIL because `createBuildplaneStorage()` and init logic do not exist yet

- [ ] **Step 3: Implement project layout and SQLite bootstrap**

Add:

- `project-layout.ts` to resolve `.buildplane`, `state.db`, `artifacts`, `evidence`, `runs`, and `logs`
- `database.ts` to open `node:sqlite` `DatabaseSync` and execute schema bootstrap DDL
- a minimal `projects` row plus an append-only `events` table
- `initializeProject()` return shape like:

```ts
{
  created: boolean;
  projectRoot: string;
  stateDbPath: string;
}
```

`project.json` should contain only the minimum stable fields for this slice, for example:

```json
{
  "schemaVersion": 1,
  "defaultPolicyProfile": "default",
  "initializedAt": "2026-03-17T00:00:00.000Z"
}
```

- [ ] **Step 4: Re-run the init test**

Run: `pnpm vitest --run packages/storage/test/project-init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/project-layout.ts packages/storage/src/database.ts packages/storage/src/index.ts packages/storage/test/project-init.test.ts
git commit -m "feat: add buildplane project initialization"
```

### Task 3: Add storage writes and query projections for status/inspect

**Files:**
- Create: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/store.test.ts`

- [ ] **Step 1: Write the failing storage query test**

Create `packages/storage/test/store.test.ts` that seeds one unit/run/evidence/decision and reads it back through the public query APIs.

Target assertions:

```ts
expect(status.latestRun?.status).toBe("passed");
expect(status.runCounts.passed).toBe(1);
expect(inspect.kind).toBe("run");
expect(inspect.run.id).toBe("run-1");
expect(inspect.evidence[0].kind).toBe("command-exit");
expect(inspect.decisions[0].kind).toBe("advance-run");
```

- [ ] **Step 2: Run the storage query test to verify it fails**

Run: `pnpm vitest --run packages/storage/test/store.test.ts`
Expected: FAIL because append/query methods do not exist yet

- [ ] **Step 3: Implement the concrete storage adapter**

Add a concrete adapter in `store.ts` that implements the kernel storage port and query APIs:

- `createRun(packet)`
- `markRunRunning(runId)`
- `recordExecutionEvidence(runId, receipt)`
- `recordDecision(runId, decision)`
- `completeRun(runId, status)`
- `getStatusSnapshot()`
- `inspectTarget(id)`

Persist:

- an event row for each meaningful transition
- projection rows in `units`, `runs`, `evidence`, `decisions`, and `artifacts`
- stdout/stderr logs under `.buildplane/logs/<run-id>.stdout.log` and `.stderr.log`
- artifact rows for existing required outputs

Keep `packages/storage/src/contracts.ts` as the storage-layer record shapes for persisted rows. Do not move those record contracts into kernel; instead, map them into the kernel-owned `StatusSnapshot` and `InspectSnapshot` query shapes at the storage adapter boundary.

For `inspectTarget(id)`:

- if `id` is a run id, return that run with related unit/evidence/decisions/artifacts
- if `id` is a unit id, return unit metadata, the latest run detail, and a `runHistory` array ordered newest-first

- [ ] **Step 4: Re-run all storage tests together**

Run: `pnpm vitest --run packages/storage/test/project-init.test.ts packages/storage/test/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/store.ts packages/storage/src/index.ts packages/storage/test/store.test.ts
git commit -m "feat: add local run loop storage adapter"
```

---

## Chunk 2: Runtime, policy, and orchestration

**Chunk acceptance criteria:** One local command can be executed deterministically, policy can judge the result from evidence only, and the kernel can orchestrate init/run/status/inspect through injected ports without CLI knowledge.

### Task 4: Add the local command runtime adapter

**Files:**
- Create: `packages/runtime/src/command-executor.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/command-executor.test.ts`

- [ ] **Step 1: Write the failing runtime test**

Create `packages/runtime/test/command-executor.test.ts` with a temp directory, pass that temp directory as `projectRoot`, and execute a packet that writes an output file relative to that root.

Representative assertions:

```ts
expect(receipt.exitCode).toBe(0);
expect(receipt.stdout).toContain("done");
expect(receipt.outputChecks).toEqual([
  { path: "tmp/out.txt", exists: true },
]);
```

Use a deterministic Node command like:

```ts
command: "node",
args: [
  "-e",
  "const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('done');",
],
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run: `pnpm vitest --run packages/runtime/test/command-executor.test.ts`
Expected: FAIL because no runtime adapter exists yet

- [ ] **Step 3: Implement the one-command runtime**

Implement `executePacket(packet, projectRoot)` using `spawnSync()` and return an `ExecutionReceipt`.

Rules:

- resolve `cwd` relative to the project root when provided
- default `cwd` to the project root
- capture stdout/stderr as UTF-8 strings
- normalize a `null` exit status to `1`
- check declared required outputs relative to the project root
- do not write to `.buildplane/`; storage owns persistence

- [ ] **Step 4: Re-run the runtime test**

Run: `pnpm vitest --run packages/runtime/test/command-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/command-executor.ts packages/runtime/src/index.ts packages/runtime/test/command-executor.test.ts
git commit -m "feat: add local command runtime"
```

### Task 5: Add the minimal policy evaluator

**Files:**
- Create: `packages/policy/src/decision.ts`
- Modify: `packages/policy/src/index.ts`
- Test: `packages/policy/test/decision.test.ts`

- [ ] **Step 1: Write the failing policy test**

Create `packages/policy/test/decision.test.ts` with three cases:

1. exit `0` + all outputs exist => approved
2. non-zero exit => rejected
3. exit `0` + missing output => rejected

Representative assertions:

```ts
expect(decision.kind).toBe("advance-run");
expect(decision.outcome).toBe("approved");
expect(decision.reasons).toEqual([]);
```

and

```ts
expect(decision.kind).toBe("reject-run");
expect(decision.outcome).toBe("rejected");
expect(decision.reasons).toContain("required output missing: tmp/out.txt");
```

- [ ] **Step 2: Run the policy test to verify it fails**

Run: `pnpm vitest --run packages/policy/test/decision.test.ts`
Expected: FAIL because no evaluator exists yet

- [ ] **Step 3: Implement the policy evaluator**

Implement a tiny pure function or adapter class that accepts a packet and an execution receipt and returns a `PolicyDecision`.

Rules:

- `advance-run` + `approved` when exit code is `0` and all checks exist
- `reject-run` + `rejected` otherwise
- include human-readable reasons to support `inspect` output
- do not reach into the filesystem directly; use the runtime's `outputChecks`

- [ ] **Step 4: Re-run the policy test**

Run: `pnpm vitest --run packages/policy/test/decision.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/policy/src/decision.ts packages/policy/src/index.ts packages/policy/test/decision.test.ts
git commit -m "feat: add local run loop policy evaluator"
```

### Task 6: Add the kernel orchestrator for init/run/status/inspect

**Files:**
- Create: `packages/kernel/src/orchestrator.ts`
- Modify: `packages/kernel/src/run-loop.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/orchestrator.test.ts`

- [ ] **Step 1: Write the failing orchestrator test**

Create `packages/kernel/test/orchestrator.test.ts` with fake storage/runtime/policy ports.

Test two primary flows:

1. successful packet run transitions `pending -> running -> passed`
2. rejected packet run transitions `pending -> running -> failed`

Call `orchestrator.initializeProject()` as setup when needed, but keep the `runPacket()` event assertions separate so workers do not accidentally make `runPacket()` auto-initialize the project.

Representative assertions:

```ts
expect(storage.runEvents).toEqual([
  "createRun",
  "markRunRunning",
  "recordExecutionEvidence",
  "recordDecision",
  "completeRun:passed",
]);
```

and

```ts
expect(result.run.status).toBe("failed");
expect(result.decision.outcome).toBe("rejected");
```

Also add one small delegation assertion each for:

- `getStatus()` returning the storage snapshot unchanged
- `inspect(id)` returning the storage inspect payload unchanged

- [ ] **Step 2: Run the orchestrator test to verify it fails**

Run: `pnpm vitest --run packages/kernel/test/orchestrator.test.ts`
Expected: FAIL because the orchestrator does not exist yet

- [ ] **Step 3: Implement the orchestrator entrypoints**

Implement a kernel service that is constructed from the three ports plus the resolved `projectRoot`, and expose:

- `initializeProject()`
- `runPacket(packet)`
- `getStatus()`
- `inspect(id)`

Keep it pure with respect to wiring: no direct filesystem, SQLite, or CLI I/O in kernel.

Add a kernel-owned result type in `packages/kernel/src/run-loop.ts` so later layers do not invent their own return shape:

```ts
export interface RunPacketResult {
  readonly run: Run;
  readonly receipt: ExecutionReceipt;
  readonly decision: PolicyDecision;
}
```

Rules:

- receive `projectRoot` at construction time and pass it through to the runtime port on every execution
- generate ids with `crypto.randomUUID()` via storage or kernel, but keep one consistent strategy
- create the run before execution starts
- always persist evidence before policy decides
- map `approved` to `passed`, `rejected` to `failed`
- return structured result objects that CLI formatters can render directly

- [ ] **Step 4: Re-run all kernel tests together**

Run: `pnpm vitest --run packages/kernel/test/packet.test.ts packages/kernel/test/orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/orchestrator.ts packages/kernel/src/index.ts packages/kernel/test/orchestrator.test.ts
git commit -m "feat: add local run loop kernel orchestration"
```

---

## Chunk 3: CLI surface and end-to-end proof

**Chunk acceptance criteria:** The CLI exposes the real init/run/status/inspect commands, the full slice passes in a temp project through the CLI layer, and the README documents the now-working local loop.

### Task 7: Replace the banner-only CLI with a testable command surface

**Files:**
- Create: `apps/cli/src/run-cli.ts`
- Create: `apps/cli/src/formatters.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/package.json`
- Test: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write the failing CLI command test**

Create `apps/cli/test/run-cli.test.ts` around an exported `runCli(argv, options)` function.

Cover at minimum:

- `init` creates project state and returns exit code `0`
- `status --json` before `init` returns a stable machine-readable error object without a stack trace
- `inspect <run-id> --json` before `init` returns the same stable `NOT_INITIALIZED` class of error
- `run --packet <path>` before `init` fails with clear guidance and does not create a run
- `run --packet <path>` with invalid packet JSON fails before any run is created
- `run --packet <path>` for a passing packet returns exit code `0` and prints a stable run id + status pair
- `run --packet <path>` for a failing packet returns exit code `1` and still prints a stable run id + status pair
- `status --json` after `init` returns a stable machine-readable object
- `inspect <run-id> --json` returns the expected run/evidence/decision payload for a successful run
- `inspect <unit-id> --json` after two runs of the same unit returns the latest run detail plus a newest-first `runHistory` containing both runs
- `inspect <missing-id> --json` returns a stable machine-readable error object without a stack trace

Representative usage:

```ts
const stdout: string[] = [];
const stderr: string[] = [];
const exitCode = await runCli(["status", "--json"], {
  cwd: root,
  stdout: (line) => stdout.push(line),
  stderr: (line) => stderr.push(line),
});

expect(exitCode).toBe(0);
expect(JSON.parse(stdout.join("\n"))).toMatchObject({
  initialized: true,
});

const preInitExitCode = await runCli(["status", "--json"], {
  cwd: emptyRoot,
  stdout: (line) => stdout.push(line),
  stderr: (line) => stderr.push(line),
});

expect(preInitExitCode).toBe(1);
expect(JSON.parse(stdout.at(-1) ?? "{}")).toMatchObject({
  error: {
    code: "NOT_INITIALIZED",
  },
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `pnpm vitest --run apps/cli/test/run-cli.test.ts`
Expected: FAIL because `runCli()` and formatters do not exist yet

- [ ] **Step 3: Implement the CLI composition root and formatters**

Implementation rules:

- `run-cli.ts` constructs the concrete storage/runtime/policy adapters and the kernel orchestrator
- `index.ts` remains a thin direct-entry shim that calls `runCli(process.argv.slice(2), …)`
- keep argument parsing hand-rolled with a tiny `switch` over `init`, `run`, `status`, and `inspect`
- support `--json` only for `status` and `inspect`
- support `--packet <path>` only for `run`
- make the `run` command human output stable so later tests can capture the id:
  - `run-id: <uuid>`
  - `status: passed|failed`
- return CLI exit code `0` when a run is approved/passed and `1` when a run is rejected/failed or when command validation/setup fails
- for `run --packet`, fail before run creation when the packet file is unreadable or invalid JSON
- for `run --packet` before init, emit clear guidance to run `buildplane init` first
- in JSON mode, return stable machine-readable error payloads such as:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No run or unit found for id 'missing-id'"
  }
}
```

- continue exporting `getBootstrapBanner()` so the original smoke test can survive or be adapted cleanly

- [ ] **Step 4: Re-run the CLI test**

Run: `pnpm vitest --run apps/cli/test/run-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts apps/cli/src/formatters.ts apps/cli/src/index.ts apps/cli/package.json apps/cli/test/run-cli.test.ts
git commit -m "feat: add local run loop cli commands"
```

### Task 8: Add the thin-slice end-to-end test through the CLI layer

**Files:**
- Create: `test/local-run-loop/end-to-end.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

Create `test/local-run-loop/end-to-end.test.ts` that:

1. creates a temp project root
2. calls `runCli(["init"])`
3. writes a packet JSON file under the temp root
4. calls `runCli(["run", "--packet", packetPath])`
5. parses the `run-id: <uuid>` line from captured stdout
6. calls `runCli(["status", "--json"])`
7. calls `runCli(["inspect", runId, "--json"])`
8. asserts that `status --json` reports the run, for example:
   - `initialized === true`
   - `latestRun.id === runId`
   - `latestRun.status === "passed"`
   - `runCounts.passed === 1`
9. asserts on `.buildplane/state.db`, recorded output file, evidence, decision, and artifact information

Representative packet body:

```json
{
  "unit": {
    "id": "unit-e2e",
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
      "const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('vertical-slice');"
    ]
  },
  "verification": {
    "requiredOutputs": ["tmp/out.txt"]
  }
}
```

- [ ] **Step 2: Run the end-to-end test to verify it fails**

Run: `pnpm vitest --run test/local-run-loop/end-to-end.test.ts`
Expected: FAIL until the full CLI → kernel → runtime/policy → storage path is complete

- [ ] **Step 3: Make the smallest fixes needed to satisfy the full vertical slice**

Only patch the missing seams exposed by the test. Expected adjustments are likely to include:

- JSON formatting cleanup for both success and error payloads
- packet path resolution
- stable `run-id: <uuid>` reporting from `run`
- stable inspect serialization
- small status snapshot shape corrections

Avoid adding new abstractions unless the failing test proves the need.

- [ ] **Step 4: Re-run the end-to-end test**

Run: `pnpm vitest --run test/local-run-loop/end-to-end.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/local-run-loop/end-to-end.test.ts apps/cli/src apps/cli/test packages/kernel/src packages/runtime/src packages/policy/src packages/storage/src
git commit -m "test: prove local run loop end to end"
```

### Task 9: Document the slice and run final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README with the working local loop**

Add a concise developer-facing section showing:

- `buildplane init`
- a minimal packet JSON example
- `buildplane run --packet <path>`
- `buildplane status`
- `buildplane inspect <run-id>`

Keep the wording explicit that this is the first local vertical slice, not the full product.

- [ ] **Step 2: Run the focused acceptance suite**

Run:

```bash
pnpm vitest --run \
  packages/kernel/test/packet.test.ts \
  packages/kernel/test/orchestrator.test.ts \
  packages/storage/test/project-init.test.ts \
  packages/storage/test/store.test.ts \
  packages/runtime/test/command-executor.test.ts \
  packages/policy/test/decision.test.ts \
  apps/cli/test/run-cli.test.ts \
  test/local-run-loop/end-to-end.test.ts
```

Expected: PASS

- [ ] **Step 3: Run full repo verification**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add local run loop usage"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-03-17-local-run-loop-implementation.md`. Ready to execute?
