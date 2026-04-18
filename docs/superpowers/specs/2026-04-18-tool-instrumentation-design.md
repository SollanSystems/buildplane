# Tool Instrumentation — Phase C Design

**Date:** 2026-04-18
**Status:** Approved (pending written-spec review)
**Sub-project of:** Buildplane replayable-ledger roadmap, Phase C of the decomposition in `docs/strategy/buildplane-positioning.md`.
**Builds on:**
- `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md` (Phase A — Rust `bp-ledger` crate, shipped in PR #59)
- `docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md` (Phase B — TS tape emitter + handshake, shipped in PR #60)

## 1. Goal & Scope

### Goal

Make `buildplane run` produce a tape that captures not just run and unit lifecycle but also every tool call and its file-level effects. Ship a proxy wrapper around `ToolRegistry` that emits `tool_request` / `tool_result` around each call, wire git checkpoints at unit boundaries as the safety net for anything the wrapper can't see, and prove the whole chain works end-to-end with real `buildplane run` integration tests.

### In scope

1. **`apps/cli/src/ledger-tool-wrapper.ts`** — `wrapToolRegistryForLedger(registry, emitter, getUnitCtx)` returning a `ToolRegistry` where each method emits `tool_request` (before), `tool_result` (after), and — for `write_file` — `workspace_write` events. TS-side sha256 via `node:crypto`. No Rust-side CAS population in this phase.
2. **Wire the wrapper into `run-cli.ts`** — the `run` command, after creating the tool registry, wraps it with the ledger wrapper whenever `BUILDPLANE_LEDGER` is on.
3. **Git checkpoints at unit boundaries** — on `unit_started`, run `commit-tree` + `update-ref` on `refs/buildplane/run/<run-id>` (never touching HEAD), emit `git_checkpoint` with `{boundary: "pre-unit"}`. Same on `unit_completed` with `{boundary: "post-unit"}`. User's branch is untouched; the buildplane ref accumulates the history.
4. **Fill in or remove the Phase B `mapEventKindForLedger` stub** — Phase B left this returning null for every kind. Phase C either wires it to real tool-event mappings (if the kernel emits per-tool events) or deletes it and relies on direct emit from the wrapper and unit-boundary hooks. Prefer deletion; the wrapper is a cleaner point of emission.
5. **Fix the `--cwd` pollution bug from Phase B** — some git operations inside `buildplane run` used `process.cwd()` instead of the packet's workspace path, which caused Phase B's smoke tests to pollute the feature branch. Audit and fix via a `gitInWorkspace(workspace, ...args)` helper routing all git invocations.
6. **Integration tests** — 4 scenarios under `test/ledger-integration/` using `makeLedgerFixture()` and a new `makeBuildplaneRunFixture()` that runs `runCli()` in-process with a fully isolated tempdir workspace:
   - **tool-capture.test.ts** — real `buildplane run` with a `write_file` packet; tape contains the expected `tool_request`/`tool_result`/`workspace_write` events.
   - **shell-command-capture.test.ts** — packet that uses `run_command`; tape contains `tool_request`/`tool_result` with stdout/stderr/exit_code; git checkpoint captures the file side effects.
   - **git-checkpoint.test.ts** — multi-unit packet; verify `git_checkpoint` events emitted with pre-unit/post-unit boundaries and SHAs reachable from `refs/buildplane/run/*`.
   - **permission-denied.test.ts** — workspace with a read-only ledger directory; verify the ledger surfaces `storage_failure` or the run fails cleanly. Platform-gated if necessary.
7. **cwd-isolation regression test** — `test/ledger-integration/cwd-isolation.test.ts` — runs a full `buildplane run` against a tempdir packet and asserts the repo-root's git state is unchanged after. This is the Phase C canary; if it fails, no other test is trusted.

### Out of scope (Phase D or later)

- `read_file` tool. Not in the registry today; not adding it.
- Rust-side CAS population (reading file bytes into `objects/`). TS sends hashes; Rust stores the event row; blob bytes come later.
- `workspace_read` events. Without a `read_file` tool, there is no clean place to emit them.
- `ledger inspect` subcommand.
- Replay / fork / bisect commands.
- Concurrent-run cross-talk tests.
- Benchmarking large-file hashing overhead.

### Success criteria

1. A packet that calls `write_file({path: "out.txt", content: "hi"})` produces a tape with: `run_started` → `unit_started` → `git_checkpoint(pre-unit)` → `tool_request(write_file)` → `workspace_write(out.txt, sha256:...)` → `tool_result` → `git_checkpoint(post-unit)` → `unit_completed` → `run_completed`. All `parent_event_id` links intact.
2. A packet that calls `run_command({command: "sh", args: ["-c", "echo hi > out.txt"]})` produces a tape with `tool_request(run_command)` → `tool_result(exit_code=0)` and the two `git_checkpoint` events bracketing it. No `workspace_write` (the wrapper can't see shell effects), but the git checkpoint SHAs reveal the change.
3. Running the integration tests does not pollute any feature branch. The `cwd-isolation` test is the authoritative gate.
4. After Phase C lands, Phase B's `mapEventKindForLedger` stub is no longer load-bearing.

### Non-goals (explicit)

- Tape does not capture reads. Documented; `fork` fidelity is partial until Phase D adds reads.
- Tape does not guarantee granular file-system observation for `run_command`. Shell effects captured via git checkpoint, not event-level observations.

### Budget

~6-8 days focused work.

---

## 2. Architecture

### Component layout

```
┌─────────────────────────────────────────────────────────────────┐
│  apps/cli/src/run-cli.ts  (MODIFIED)                            │
│                                                                 │
│   run handler:                                                  │
│     ├─ existing: spawn ledger, createTapeEmitter (Phase B)      │
│     ├─ NEW: build unitCtx tracker (runId + current unitId +     │
│     │        parent_event_id)                                   │
│     ├─ NEW: wrap ToolRegistry via wrapToolRegistryForLedger     │
│     ├─ NEW: git-checkpoint hooks at unit_started/unit_completed │
│     └─ existing: orchestrator.runPacket(Async)                  │
└─────────────────────────────────────────────────────────────────┘
             │                                   │
             │ wrapped registry                  │ git checkpoint events
             ▼                                   ▼
┌───────────────────────────────────┐   ┌──────────────────────────┐
│  apps/cli/src/                    │   │  apps/cli/src/           │
│  ledger-tool-wrapper.ts  (NEW)    │   │  ledger-git-checkpoint.ts│
│                                   │   │  (NEW)                   │
│  wrapToolRegistryForLedger(       │   │                          │
│    registry,                      │   │  runGitCheckpoint(opts)  │
│    emitter,                       │   │    git write-tree        │
│    getUnitCtx                     │   │    git commit-tree       │
│  ): ToolRegistry                  │   │    git update-ref        │
│                                   │   │    emit git_checkpoint   │
│  Per-method wrapper:              │   │                          │
│   1. pre-hash input files         │   │  Never touches HEAD.     │
│   2. emit tool_request            │   │  Never runs user hooks.  │
│   3. call underlying tool         │   │                          │
│   4. for write_file: emit         │   │                          │
│      workspace_write              │   │                          │
│   5. emit tool_result             │   │                          │
└───────────────────────────────────┘   └──────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  packages/adapters-tools  (UNCHANGED)                           │
│                                                                 │
│  createToolRegistry(worktreeRoot) → { write_file, run_command } │
│  Pure functions. No ledger knowledge.                           │
└─────────────────────────────────────────────────────────────────┘
```

### Data flow for a single tool call

```
run-cli.ts detects unit boundary
    │
    ├─→ runGitCheckpoint({ boundary: "pre-unit", runId, unitId, cwd })
    │   ├─ git -C <cwd> write-tree         → TREE
    │   ├─ git -C <cwd> commit-tree TREE [-p PARENT]  → COMMIT
    │   ├─ git -C <cwd> update-ref refs/buildplane/run/<runId> COMMIT
    │   └─ emitter.emit("git_checkpoint", GitCheckpointV1{ ref, commit_sha, boundary, unit_id })
    │
    ├─→ orchestrator invokes tool via wrapped registry
    │       wrappedRegistry.write_file({ path, content })
    │
    │       wrapper logic:
    │         1. toolReqId = UUIDv7
    │         2. pre-hash: if path exists, read + sha256 → hashBefore
    │         3. emit "tool_request" (parent = unitStartedEventId)
    │         4. result = registry.write_file({ path, content })
    │         5. if result.success:
    │              emit "workspace_write" (parent = toolReqId) with hashBefore/hashAfter
    │         6. emit "tool_result" (parent = toolReqId)
    │
    └─→ runGitCheckpoint({ boundary: "post-unit", ... })
```

### Unit-context tracking

The wrapper needs to know the current `unit_id` and `parent_event_id` for its emits. `wrapToolRegistryForLedger` takes a `getUnitCtx: () => { unitId, parentEventId }` closure. `run-cli.ts` updates the ctx when it fires `unit_started` / `unit_completed`. This keeps the `ToolRegistry` interface stable (no `__meta` field threading).

### Git checkpoint implementation

```
TREE=$(git -C <cwd> write-tree)
PARENT=$(git -C <cwd> show-ref --hash refs/buildplane/run/<runId> 2>/dev/null)
if [ -n "$PARENT" ]; then
  COMMIT=$(echo "buildplane/<runId>/<unitId>/<boundary>" | \
    git -C <cwd> commit-tree "$TREE" -p "$PARENT")
else
  COMMIT=$(echo "buildplane/<runId>/<unitId>/<boundary>" | \
    git -C <cwd> commit-tree "$TREE")
fi
git -C <cwd> update-ref refs/buildplane/run/<runId> "$COMMIT"
```

Never touches HEAD. Never runs user hooks (`commit-tree` is plumbing). Works on dirty worktrees (`write-tree` captures the index). The message includes runId/unitId/boundary for human forensics via `git log refs/buildplane/run/<runId>`.

### `--cwd` pollution fix

Phase B's smoke tests polluted the worktree because some path inside `buildplane run` used `process.cwd()` when it should have used the packet's workspace. Phase C audits:

- The orchestrator's internal git operations (commit-on-success etc.)
- The worktree adapter's path resolution
- Any `resolve(".", ...)` / `path.join(process.cwd(), ...)` in `run-cli.ts` inside the run handler

Fix: centralize via a `gitInWorkspace(workspace, ...args)` helper. Every git invocation spawned from the run handler routes through it. The packet's absolute workspace path is the single source of truth.

Phase C ships this as a targeted fix with the `cwd-isolation` regression test.

### Key contracts (new in Phase C)

- **Wrapper is pure ToolRegistry → ToolRegistry.** Same interface in, same interface out. Consumers (orchestrator) cannot tell it is wrapped.
- **`getUnitCtx` returns current unit info or `null`.** If a tool is invoked before any `unit_started` has fired, the wrapper emits with `parent_event_id: null` and logs a warning. Defensive; shouldn't happen in practice.
- **Git checkpoints never touch HEAD.** The buildplane ref is the only thing that moves.
- **`workspace_write` is only emitted for `write_file`.** `run_command`'s file effects live in the git checkpoint tree delta, not in events. Documented limit.

### What doesn't change from Phases A/B

- `bp-ledger` Rust crate (envelope, payloads, storage, CAS, serve, canonicalize): untouched.
- `bp-ledger-macros`: untouched.
- `@buildplane/ledger-client` runtime: untouched — the emitter's API is sufficient.
- `bp-cli ledger serve` subcommand: untouched.
- `packages/adapters-tools`: untouched. The wrapper lives in `apps/cli`.

---

## 3. Testing Strategy

Phase C delta on the four-layer model.

### Layer 1 (Rust) — no new tests

No Rust changes in Phase C.

### Layer 2 (TS unit)

**`apps/cli/test/ledger-tool-wrapper.test.ts`** — mock `TapeEmitter`, mock `ToolRegistry`:

- `write_file` success → emits `tool_request` → calls real tool → emits `workspace_write` with correct `hash_before`/`hash_after` → emits `tool_result`. Asserts the JSONL the emitter sees in order.
- `write_file` on a path that didn't exist before → `hash_before` is null.
- `write_file` failure → emits `tool_request` and `tool_result` (with `success: false`); no `workspace_write`.
- `run_command` success → emits `tool_request` and `tool_result` only.
- `run_command` non-zero exit → `tool_result.exit_code` reflects it.
- `getUnitCtx()` threading: `parent_event_id` on each event matches the current unit's started-id.

**`apps/cli/test/ledger-git-checkpoint.test.ts`** — tempdir-based:

- `pre-unit` on fresh repo → emits event with ref + valid SHA. HEAD unchanged.
- `post-unit` chains on the prior pre-unit commit (parent linkage).
- Multi-unit: 2 pre/post pairs produce a ref with 4 commits in a chain.
- Repo with uncommitted changes: `write-tree` captures the index, HEAD unchanged, user's work preserved.
- User's current branch ref is not modified.

### Layer 3 (integration)

All use `makeBuildplaneRunFixture()` (new helper in `test/ledger-integration/fixtures.ts`):

```ts
export async function makeBuildplaneRunFixture(opts: {
  packet: unknown;
}): Promise<{
  dir: string;
  eventsDbPath: string;
  cleanup: () => Promise<void>;
}>;
```

It creates a workspace via `mkdtemp(tmpdir())`, `git init` + initial commit in that tempdir, writes packet.json, invokes `runCli()` after `process.chdir()` into the tempdir, captures the run result, restores `process.cwd()` in `finally`.

Tests:

- **tool-capture.test.ts** — packet with a unit calling `write_file({path: "out.txt", content: "hello"})`. Assert events.db contains, in causal order: `run_started` → `unit_started` → `git_checkpoint(pre-unit)` → `tool_request(write_file)` → `workspace_write(out.txt)` → `tool_result` → `git_checkpoint(post-unit)` → `unit_completed` → `run_completed`. Assert `workspace_write.after.Captured.hash` matches `sha256("hello")`.
- **shell-command-capture.test.ts** — packet calling `run_command({command: "sh", args: ["-c", "echo hi > out.txt"]})`. Assert: `tool_request(run_command)` present, `tool_result.exit_code == 0`, no `workspace_write`, pre/post `git_checkpoint` events bracket the tool. Post checkpoint's tree contains `out.txt` (verified via `git -C <dir> show refs/buildplane/run/<runId>:out.txt`).
- **git-checkpoint.test.ts** — multi-unit packet. 4 `git_checkpoint` events (2 pre + 2 post), correct `unit_id` linkage, SHA chain on `refs/buildplane/run/<runId>`. User's HEAD unchanged.
- **permission-denied.test.ts** — workspace with `.buildplane/ledger/` chmod 500. Ledger spawn fails cleanly or first write surfaces `storage_failure`. Platform-gated if needed.

**`test/ledger-integration/cwd-isolation.test.ts`** — the Phase C canary:

- Capture repo-root git state before: `git rev-parse HEAD` + `git status --porcelain`.
- Run full `buildplane run` in a tempdir packet via `makeBuildplaneRunFixture`.
- After: assert repo-root's HEAD is unchanged, `git status --porcelain` unchanged, no new refs under `refs/buildplane/run/*` in the repo root.
- Assert the tempdir has the ref.

### What we are NOT testing in Phase C

- Concurrent runs.
- Large-file hashing perf.
- Property tests.

### Test-isolation discipline

1. Every test that touches git state uses `makeBuildplaneRunFixture()` or `makeLedgerFixture()`. No exceptions.
2. `makeBuildplaneRunFixture` uses `process.chdir()` + `finally` restore. Files using this fixture must NOT be marked `concurrent: true`.
3. `cwd-isolation.test.ts` runs first (filename ordering or explicit sequencer). If it fails, the suite halts.
4. `--no-verify` on pre-push stays in effect until main's pre-existing failing tests are resolved.

---

## 4. Phases + Sequencing

Sequential — each phase gates the next. ~6-8 days total.

### Phase C.1 — ledger-tool-wrapper (1.5-2 days)

- Create `apps/cli/src/ledger-tool-wrapper.ts` with `wrapToolRegistryForLedger(registry, emitter, getUnitCtx)`.
- TS `node:crypto` sha256 helper.
- Layer 2 tests for every branch.

**Demo:** mock registry + mock emitter produces correct JSONL sequence per tool call.

### Phase C.2 — ledger-git-checkpoint (1 day)

- Create `apps/cli/src/ledger-git-checkpoint.ts` with `runGitCheckpoint()` using `write-tree` + `commit-tree` + `update-ref`.
- Layer 2 tempdir tests.

**Demo:** tempdir run produces a commit on `refs/buildplane/run/<runId>` without touching HEAD.

### Phase C.3 — --cwd audit + fix (0.5-1 day)

- Audit `run-cli.ts` and orchestrator for `process.cwd()` in run-path code.
- Introduce `gitInWorkspace(workspace, ...args)` helper; route all git ops through it.
- Add `test/ledger-integration/cwd-isolation.test.ts`.

**Demo:** `cwd-isolation` test passes.

**Gate:** this test MUST pass before any Phase C.4 test runs.

### Phase C.4 — wire into run-cli.ts (1-1.5 days)

- Extend run handler: `unitCtx` tracker, registry wrapping, unit-boundary hooks calling `runGitCheckpoint` + updating `unitCtx`.
- Delete/rewire `mapEventKindForLedger`. Prefer deletion.
- Defensive no-op for tools invoked before `unit_started`.

**Demo:** real `buildplane run` against a `write_file` packet populates events.db with the expected sequence.

### Phase C.5 — integration tests (1-1.5 days)

- Extend fixtures with `makeBuildplaneRunFixture()`.
- 4 Layer-3 tests: tool-capture, shell-command-capture, git-checkpoint, permission-denied.

**Demo:** full `vitest run test/ledger-integration/` green (Phase B tests + Phase C tests).

### Phase C.6 — verification gate + docs (0.5 day)

- Full test suite, clippy, drift alarm.
- Real `buildplane run` smoke.
- Spec marker `**Phase C status: complete (YYYY-MM-DD).**` in this file.
- Final commit.

**Verification gate:**

- [ ] All test layers green.
- [ ] `cwd-isolation` test passes.
- [ ] Real `buildplane run` produces a tape matching Section 1's success criteria.
- [ ] Spec marker flipped.
- [ ] `mapEventKindForLedger` stub removed or wired.

### Branching + shipping

- Stacked on `feat/ledger-phase-b` (PR #60). Branch name `feat/ledger-phase-c`.
- Same `--no-verify` push workaround for the pre-push hook until main's pre-existing red tests are resolved.
- When B merges, retarget C's PR base to main.

### What could slip this

Ranked by probability:

1. **`--cwd` audit sprawls.** If `process.cwd()` is used deeply, fixing it spreads into kernel-adjacent packages. Mitigation: narrow Phase C's fix to run-cli.ts direct code; defer the rest as targeted follow-up.
2. **User git-hook interaction.** `commit-tree` doesn't fire hooks, but some global hooks bind low-level. Document the invariant; can't fix external config.
3. **Kernel's orchestrator lacks a clean unit-boundary hook.** If only post-hoc signals are available, pre-unit checkpoints become approximate. Mitigation: add a hook point in C.4 if needed.
4. **Permission-denied test platform-flaky.** Skip-if-platform per Section 3.

---

## Appendix A: Decision Log

| # | Decision | Chosen | Alternatives | Reason |
|---|---|---|---|---|
| 1 | Tool observation emission point | **C — run-cli.ts wraps ToolRegistry via proxy** | A (tool adapter emits), B (kernel bus emits) | Keeps `adapters-tools` and kernel pure; wrapping layer is 30-40 lines. Composes with Phase B's direct-emit pattern. |
| 2a | Tool scope for Phase C | **A — existing tools only** (`write_file`, `run_command`) | B (add `read_file`), C (shell fs observer) | YAGNI on `read_file` — not in the registry today; `fork` fidelity is the eventual driver and that's Phase D+. Shell-observer is theater. |
| 2b | Git checkpoint strategy | **α — spec'd `refs/buildplane/run/*` checkpoints** | β (no refs, hash-object only), γ (no checkpoints in C) | `git log refs/buildplane/run/<runId>` is a real developer affordance. `commit-tree` plumbing avoids HEAD mutation and user hooks. |

---

## Appendix B: Relation to Other Sub-Projects

This sub-project is Phase C in the replayable-ledger roadmap:

0. Foundation fixes — pre-existing bugs. Parallel work.
1. Unified memory model — depends on Phase C (tool events) for full value.
2. **Event tape capture (Phase A) — shipped in PR #59.**
3. **Event tape IPC (Phase B) — shipped in PR #60.**
4. **Tool adapter instrumentation (Phase C, this spec) — tool-level events, git checkpoints, real `buildplane run` → populated tape. Consumes B.**
5. Replay + fork primitives (Phase D) — consume tape to reconstruct state; produce new runs with lineage. Consumes B + C.
6. Bisect (Phase E) — walk tape for first bad event.
7. Audit bundle + signing (Phase F) — enterprise tier.
8. Cloud / team ledger — hosted product surface.

Phase C makes the tape's contents real. Before C, the tape captures only run + unit lifecycle. After C, it captures what the agent actually did.
