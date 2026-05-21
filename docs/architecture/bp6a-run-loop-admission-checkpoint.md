# BP6A Run-Loop Admission Checkpoint Mini-Spec

> **For Hermes:** Use `test-driven-development` and the narrow BP6B test plan below before changing the run-loop implementation.

**Goal:** Define the earliest safe kernel checkpoint for recording run admission before any worker/runtime dispatch.

**Architecture:** BP6B should wire the BP5 admission receipt recording surface into the prepared-run boundary in `packages/kernel/src/orchestrator.ts`. The durable `run_admission_recorded` append is the dispatch authority: if the receipt cannot be built, cannot be recorded, is not `PASS`, or carries quarantine/denied grants that block the requested run, the kernel must halt before worker execution.

**Tech Stack:** TypeScript kernel/orchestrator, SQLite-backed local storage/event tape, existing admission receipt helpers in `packages/kernel/src/admission-receipts.ts`, Vitest regression tests.

---

## Context

BP5 established a deterministic, local-first run admission receipt and then remediated the secret-hygiene issue that allowed credential-shaped material to reach receipt/event persistence. BP6A chooses where BP6B should attach that approved surface to the live run path.

Relevant inspected surfaces:

- `docs/architecture/run-admission-receipts.md` defines the event ordering: `run_started`, then `run_admission_recorded`, then worker/runtime events only after a successful PASS append.
- `packages/kernel/src/admission-receipts.ts` currently builds dry-run/planned receipts, rejects credential-shaped inputs, stable-serializes the full receipt, computes a digest, writes the receipt artifact, and appends a compact `run_admission_recorded` event.
- `packages/kernel/src/orchestrator.ts` owns the direct run path. Its `prepareRun()` validates the packet, asserts the repository, creates the run, prepares and records the workspace, then calls `storage.markRunRunning(run.id)`.
- `packages/storage/src/store.ts` shows `storage.markRunRunning()` is the current TypeScript storage mirror point that appends the `run-started` lifecycle event.
- The direct sync and async run paths both call `prepareRun()` before emitting `execution-started` or calling `runtime.executePacket` / `runtime.executePacketAsync`.
- `run-scoped-bus` only adds run context to later events; it is not an authority or admission checkpoint.

## Chosen checkpoint: prepared-run admission gate

Attach BP6B immediately after successful `prepareRun()` and before the first execution/runtime event.

Concrete locations:

1. `packages/kernel/src/orchestrator.ts`, sync `runPacket()`:
   - after `const { ctx } = prepared;`
   - before `bus.emit({ kind: "execution-started", ... })`
   - before `runtime.executePacket(...)`

2. `packages/kernel/src/orchestrator.ts`, async `runPacketAsync()`:
   - after `const { ctx } = prepared;`
   - before constructing `runContext` / `createRunScopedBus(...)`
   - before any budget subscriber, `execution-started` event, `executeOnce(...)`, or runtime call

BP6B should centralize this in one helper, for example `recordPreparedRunAdmission(ctx, options)`, and call it from both sync and async direct run paths so one path cannot bypass the gate.

### Why this is the earliest safe point

This checkpoint is after all local facts needed for a meaningful receipt exist:

- validated packet / unit snapshot
- stable run id from `storage.createRun(...)`
- source repo head from `workspace.assertRunnableRepository(...)`
- prepared workspace path and head from `workspace.prepareWorkspace(...)`
- persisted workspace metadata from `storage.recordWorkspacePrepared(...)`
- root lifecycle event from `storage.markRunRunning(...)` / `run-started`
- resolved policy profile in the async path, when present

It is before all worker/runtime execution surfaces:

- no `execution-started` event has been emitted yet
- no run-scoped bus has been created for runtime emission
- no `runtime.executePacket(...)` / `runtime.executePacketAsync(...)` call has happened
- no model/tool/token events can exist
- no execution evidence, policy decision, retry, workspace deletion, or outcome finalization has happened

This preserves the BP5 ordering intent while avoiding a hollow receipt that lacks actual run/workspace identity.

### Dispatch rule

The dispatch gate is the durable local append, not the in-memory receipt object.

Proceed to runtime only when all are true:

1. the admission input was built from local kernel-owned facts, not worker prose;
2. credential-shaped material was rejected before artifact/event persistence;
3. the full receipt artifact write succeeded;
4. `run_admission_recorded` append/flush succeeded;
5. the recorded decision is `PASS`;
6. the recorded grants cover the requested side effects for the run;
7. no quarantine/freeze instruction is present.

Any missing condition must halt before `execution-started` and before runtime dispatch. The failure returned to operators must be sanitized and must not include raw credential-shaped values.

### Live-vs-dry-run note

The approved BP5 helper is currently dry-run/planned: its receipt and recorded payload set `will_execute_worker: false` and `authorized_next_step: "record_admission_only"` for PASS receipts. BP6B must not silently treat that dry-run marker as live dispatch authority.

BP6B has two safe implementation options:

1. add a narrow live-admission mode/companion helper that reuses the BP5 validation, digest, artifact, event, and secret guard but records `will_execute_worker: true` only for a live PASS that the kernel is about to dispatch; or
2. keep the existing dry-run helper unchanged and halt after recording until a follow-up slice introduces live authority.

For a useful run-loop integration, option 1 is preferred, but the test must make the live authority explicit.

## Rejected alternatives

### 1. Inside `run-scoped-bus`

Rejected because the scoped bus is a visibility wrapper. It injects `runId` and executor context into later events but does not own packet validation, workspace identity, policy profile resolution, local artifact persistence, or dispatch authority.

### 2. Inside `executeOnce()` or immediately before `runtime.executePacketAsync(...)`

Rejected because `executeOnce()` first emits `execution-started`. Recording admission there would put execution visibility before admission authority and makes it easier for future runtime code to run before the gate.

### 3. After execution evidence or policy finalization

Rejected because `storage.recordExecutionEvidence(...)`, policy evaluation, retry handling, and `finalizeRun(...)` are post-execution paths. They can inspect outcomes, but they cannot prove the worker was admitted before execution.

### 4. In `runGraphAsync()`

Rejected because graph execution is a scheduler/composition layer that eventually delegates to packet runs. Gating there would miss direct `runPacket()` / `runPacketAsync()` calls and would duplicate logic across graph/strategy entrypoints.

### 5. Before `storage.createRun(...)`

Rejected because there is no stable run id or run lifecycle root event yet. The receipt would have to cite speculative run identity, which weakens replay and event ordering.

### 6. Before workspace preparation

Rejected for BP6B because the current receipt PASS rules require repo/worktree/base binding evidence, including a real `worktree_path`, head commit, and clean-worktree state. A pre-workspace checkpoint can become a later optimization only if BP6 introduces a separate planned-workspace evidence model.

### 7. CLI-only live gate

Rejected for BP6B because the kernel run-loop is the authority boundary. A CLI-only gate can protect one command surface, but direct kernel callers, graph execution, strategy execution, and future hosts need the same admission invariant.

## BP6B minimum test plan

Follow RED-GREEN-REFACTOR. Add failing tests first, then implement only enough run-loop wiring to pass.

### Test 1: PASS admission records before runtime dispatch

**Objective:** A safe packet records a live PASS admission event before runtime execution begins.

**Likely file:** `packages/kernel/test/orchestrator-admission.test.ts` or the nearest existing orchestrator/run-loop test file.

**Setup:**

- create an orchestrator with fake storage, workspace, policy, and runtime ports;
- make `workspace.assertRunnableRepository(...)` return a stable source head;
- make `workspace.prepareWorkspace(...)` return a deterministic workspace path/head;
- make the admission store append succeed;
- make runtime record when it is called.

**Assertions:**

- event/storage order is `run-started` then `run_admission_recorded` then `execution-started`;
- runtime is not called until after the admission event append resolves;
- the recorded payload cites the run id/unit id and receipt digest/ref;
- the recorded decision is `PASS`;
- the recorded grants are limited to local declared scope / verification / local commit effects;
- no remote, GitHub, production, network, or auto-Kanban mutation is granted.

Focused command:

```bash
pnpm vitest --run packages/kernel/test/orchestrator-admission.test.ts -t "records PASS admission before runtime dispatch"
```

### Test 2: credential-shaped admission input fails closed before runtime dispatch

**Objective:** A credential-shaped value in admission input never reaches artifact/event persistence and never allows runtime execution.

**Likely file:** same as Test 1, plus keep the existing `packages/kernel/test/admission-receipts.test.ts` coverage.

**Setup:**

- inject a credential-shaped value through a packet/request/evidence field that BP6B maps into admission input;
- make the fake receipt artifact writer and event appender throw if called;
- make runtime throw if called.

**Assertions:**

- the returned failure is sanitized and mentions only credential-shaped/redaction guidance;
- the raw sentinel value is absent from returned errors, events, stdout/stderr-like messages, and any persisted payload;
- no receipt artifact is written;
- no `run_admission_recorded` event is appended;
- no `execution-started` event is emitted;
- runtime is not called;
- the run ends in a fail-closed state through existing infrastructure-failure finalization.

Focused command:

```bash
pnpm vitest --run packages/kernel/test/orchestrator-admission.test.ts -t "fails closed on credential-shaped admission input"
pnpm vitest --run packages/kernel/test/admission-receipts.test.ts -t "credential-shaped"
```

### Recommended extra BP6B regressions if time permits

- Admission event append failure halts before runtime and returns a sanitized infrastructure failure.
- `UNSAFE_TO_RUN` or `INSUFFICIENT_EVIDENCE` records an admission event but does not dispatch runtime.
- Sync `runPacket()` and async `runPacketAsync()` share the same admission helper so neither bypasses the gate.
- Operator-suspension runs remain non-executing; whether they record a non-live admission receipt can be deferred if the BP6B minimum tests stay narrow.

## BP6B verification commands

For implementation work:

```bash
pnpm vitest --run packages/kernel/test/orchestrator-admission.test.ts
pnpm vitest --run packages/kernel/test/admission-receipts.test.ts
pnpm typecheck
pnpm lint
```

If BP6B touches storage/event tape or generated ledger payloads, add the relevant focused storage/ledger-client/native tests from `docs/architecture/run-admission-receipts.md` before running the full gate.

For this BP6A docs-only mini-spec:

```bash
git diff --check
pnpm exec prettier --check docs/architecture/bp6a-run-loop-admission-checkpoint.md docs/architecture/README.md
python - <<'PY'
from pathlib import Path
import re
paths = [
    Path('docs/architecture/bp6a-run-loop-admission-checkpoint.md'),
    Path('docs/architecture/README.md'),
]
patterns = [
    re.compile(r'gh[pousr]_[A-Za-z0-9_]{12,}'),
    re.compile(r'sk-[A-Za-z0-9._-]{6,}'),
    re.compile(r'bp_secret_[A-Za-z0-9_./+=-]{8,}', re.I),
    re.compile(r'xox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----'),
]
findings = []
for path in paths:
    text = path.read_text()
    for pattern in patterns:
        if pattern.search(text):
            findings.append((str(path), pattern.pattern))
if findings:
    for path, pattern in findings:
        print(f'{path}: matched {pattern}')
    raise SystemExit(1)
print('credential-shaped scan: 0 findings')
PY
```

## Out of scope for BP6B

- No hosted service, swarm/router expansion, broad model routing, or architecture-review agent.
- No GitHub PR creation, remote push, merge, deployment, production mutation, or network grant.
- No auto-Kanban mutation from admission.
- No trust in worker prose as admission evidence.
- No replay side effects, replay-driven capability grants, or quarantine release.
- No raw credential persistence in receipts, events, summaries, terminal errors, test fixtures, or docs.
- No broad storage schema rewrite unless the focused admission event append requires a minimal port addition.
- No expansion of allowed side effects beyond the existing local docs/declared-scope, verification-command, and local-worktree commit grammar.
