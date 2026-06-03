# M2-S5 — Activity Bracketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bracket every packet-level I/O activity in the kernel run loop with two **kernel-signed** tape events — a **write-ahead** `activity_started` (durably appended *before* the activity is invoked) and an `activity_completed` (recording the result + `result_digest`) — emitted from `executeOnce` through a typed `LedgerActivityPort`, on a tape signed by the kernel key (`actor_id="kernel"`, `key_id="kernel-main"`).

**Architecture:** S5 is a **pure TS-integration slice** — the wire shapes already shipped in S2 (#163) and S5 touches **no Rust / typeshare / canonicalize / fixtures**. A new `LedgerActivityPort` interface in `packages/kernel/src/ports.ts` (plain types only — kernel keeps its zero ledger-client/planforge dependency) is injected into the orchestrator via a new `ledgerActivityPort?` option. `executeOnce` (`orchestrator.ts:1299`) is restructured to: mint an `activityId`, build a per-type input descriptor, `await ledgerActivityPort?.activityStarted(...)` (the impl emits + `await emitter.flush()` so it resolves only when durable) **before** invoking, then invoke (await async or sync into `r`), then `await ledgerActivityPort?.activityCompleted(...)` with the result. The concrete impl `createLedgerActivityPort(emitter)` lives at the CLI layer (`apps/cli` — which may import `@buildplane/planforge`'s `digest` and `@buildplane/ledger-client`'s `TapeEmitter`); it computes `input_digest`/`result_digest` via the canonical `digest()` helper and emits `activity_started`/`activity_completed`. The `planforge dispatch` and `buildplane run` ledger subprocesses are spawned with `{ sign: true, signingKeyId: "kernel-main" }`.

**Tech Stack:** TypeScript (pnpm monorepo, `@buildplane/{kernel,planforge,ledger-client}` + `apps/cli`), vitest 4, the Rust `bp-ledger` signed tape (read/append — **no new event kind**; S5 only *emits* the two activity kinds S2 already defined).

---

## Resolved design decisions

Three operator decisions were locked before planning (the S5 equivalent of S4's D1–E3). **Do not silently change these — they are the spec of this slice.**

| # | Decision | Resolution | Why |
|---|----------|-----------|-----|
| **D1** | Where does the bracket live? | **Kernel `LedgerActivityPort`.** A typed port is injected into the orchestrator; `executeOnce` calls it. The concrete signed-emitter impl is supplied by the CLI/dispatch layer. | Matches spec line 192 ("`orchestrator.ts executeOnce` … bracket every I/O activity"); the kernel owns execution, which is what S7 recovery trusts. Keeps the kernel testable with a fake port (no native binary). |
| **D2** | What signs the activity events? | **Sign the whole run tape.** The `run` / `planforge dispatch` ledger subprocess is spawned with `{ sign: true, signingKeyId: "kernel-main" }`. | Avoids a mixed signed/unsigned tape (weakens L0 trust + complicates S7a replay). Ed25519 signing is cheap. |
| **D3** | What goes in `activity_completed.result`? | **Inline, no wire change** — the S2 `result: Value` field carries the result object directly (exitCode/stdout/stderr for command; full completion for model), consistent with the existing `ModelResponseV1.content` posture. | Keeps S5 pure-integration (no re-opening of the u64/fixtures/cargo-gate). CAS-offload + result redaction tracked as a follow-up. |
| **E1** | `LedgerActivityPort` optional? | **Yes — optional.** When no port is injected (legacy/non-ledger runs, unit tests without a signed ledger), bracketing is **skipped** and run behaviour is byte-unchanged (mirrors S4's empty-`provenance_ref` skip). | Don't break the keyless / non-PlanForge run path; don't force the native binary into kernel unit tests. |
| **E2** | Write-ahead durability | **`activityStarted` resolves only after `emitter.emit(...)` + `await emitter.flush()`** (the flush triggers the Rust `PRAGMA wal_checkpoint(TRUNCATE)` fsync). `executeOnce` `await`s it before invoking. | The recovery contract is explicit: "`activity_started` is durably appended **before** invocation" (spec line 81). Fire-and-forget `emit()` does not satisfy it. `activity_completed` does **not** need a pre-invoke flush. |
| **E3** | `input_digest` / `result_digest` path | **Canonical `digest()` from `packages/planforge/src/digest.ts`** (`sha256:` of sorted-key `canonicalJson`), computed in the CLI-layer port impl. **NOT** `JSON.stringify`, **NOT** the `preview.ts` insertion-order `idempotencyKey` exception. | Respects the M2-S1 canonical-digest contract for payload-embedded digests; same helper S3/S4 use. |
| **E4** | `activity_id` scheme | **A fresh unique id minted at bracket-open** (`crypto.randomUUID()`), captured in a closure variable, reused for the paired `activity_completed`. The kernel mints it; the impl passes it through. | `ActivityCompletedV1` has no `activity_type` — `activity_id` is the sole started↔completed pairing key (verified in `payload/activity.rs`). A per-bracket unique id is all S5 needs; S7a reads the pair back by scanning. |

### Two items flagged for operator sign-off at the plan-review gate

1. **Per-tool-call activity bracketing is OUT of S5 scope (flag).** `executeOnce` only sees **packet-level** activities (`activity_type` `model` or `command`, chosen by `p.model ? "model" : "command"`). Individual tool calls fire *inside* the model executor's AI-SDK loop and already emit dedicated `tool_request`/`tool_result` (`ToolRequestV1`/`ToolResultV1`) tape events via the CLI tool-wrapper. Wrapping each tool call in its own `activity_started`/`activity_completed` bracket would require changes in `packages/adapters-tools` / `ledger-tool-wrapper.ts`, not `executeOnce`. The spec's acceptance says "every model/tool/command activity is bracketed," but the spec's named bracket site is `executeOnce` (line 192), which is packet-level. **Recommendation:** S5 brackets the packet-level `model`/`command` activity; per-tool-call (`activity_type: "tool"`) bracketing is a tight follow-up (S5.5) or folds into S7's replay work, since tool I/O already has durable `tool_request`/`tool_result` events. _Flag for sign-off._

2. **Signing the generic `run` path requires a kernel key (flag).** `planforge dispatch` already lives in the signed-admit world (a `plan_admitted` exists → the kernel key is provisioned). The generic `buildplane run` currently spawns an **unsigned** ledger and works **without** a kernel key. Flipping it to `sign: true` (D2) means a keyless `run` would fail when the subprocess can't load `~/.buildplane/keys/kernel/kernel-main.ed25519`. **Recommendation:** fail **fast** with a clear, actionable error ("signed ledger requires a kernel key at `~/.buildplane/keys/kernel/kernel-main.ed25519` — run `buildplane keys init` / see docs") rather than silently auto-generating signing-key material. Whether to add an auto-provision path (`buildplane keys init`) is a secondary decision. _Flag for sign-off; Task 4 implements fail-fast._

## Out of scope / deferred (do NOT build in S5)

- **bp-replay reads of activity events** — replay consuming `activity_completed` to skip re-invocation is **S7a**. The `bp-replay` no-op arms (`transitions.rs:29-30`) stay no-op; emitting these kinds does **not** break the exhaustive match (verified). S5 only **writes** them.
- **`result_ref` / CAS offload + secret redaction of `result`** — D3 stores inline. CAS + `RedactSecrets` for `ActivityCompletedV1.result` is a follow-up wire-policy slice (it would re-open the L0 wire derivation).
- **Per-tool-call activity bracketing** — flag #1 above.
- **`run_admission_recorded` → signed-tape mirror** — still deferred (S4 note; not reopened here).
- **New tape event kinds / canonicalize / typeshare / fixtures** — none; S2 shipped the vocabulary.
- **Fork-path signing (`executeForkRun`, `run-cli.ts:~2523`).** The `fork` command also spawns an **unsigned** ledger subprocess; S5 does **not** flip it to `sign: true`. A fork is a *derived* run, and bracketing the primary `run` + `dispatch` paths satisfies S5 acceptance. D2 ("sign the whole run tape") is applied to the run/dispatch paths in S5; fork-tape signing + activity bracketing is deferred to **S5.5/S6** (it would also need the fork fixture harness to provision a kernel key). _Noted so the mixed-tape exemption is explicit, not silent._

## Preconditions / invariants

- S2's `ActivityStartedV1 { run_id, activity_id, activity_type, input_digest }` and `ActivityCompletedV1 { run_id, activity_id, result_digest, result }` wire shapes are **complete** in Rust + TS (verified: `payload/activity.rs:13-42`, `canonicalize.rs:114-115`, `payload.ts:39-40`, fixtures present, `m2_digest_contract.rs` u64-guards green). **S5 adds nothing here.**
- **Kernel stays dependency-clean:** `packages/kernel` must NOT import `@buildplane/ledger-client` or `@buildplane/planforge`. The `LedgerActivityPort` interface uses only plain types. The concrete impl + `digest()` call live in `apps/cli`.
- The signed tape is at `<projectRoot>/.buildplane/ledger/events.db` (same as S3/S4); the kernel gate already reads it. S5 writes the two activity kinds onto that same tape via the signed subprocess.
- `executeOnce` is the **async path only** (`runPacketAsync`); the sync `runPacket` (`orchestrator.ts:1112`) is NOT bracketed (S4 precedent + CLAUDE.md).
- Slice verify (run from the worktree root): `pnpm -C <worktree> exec vitest run <paths>`. **Never** `pnpm --filter buildplane test`. Native binary built first: `pnpm native:build`.
- `apps/cli` already vendors `@buildplane/{kernel,planforge,ledger-client}` in `scripts/published-bootstrap/stage-package.mjs` — confirm the snapshot in Task 6 (no new entry expected).

---

## File structure

**Create:**
- `packages/kernel/test/orchestrator-activity-bracketing.test.ts` — unit tests: a fake `LedgerActivityPort` asserts started-before-invoke ordering, completed-after, payload contents, and skip-when-absent.
- `apps/cli/src/ledger-activity-port.ts` — `createLedgerActivityPort(emitter)` (digest + emit + write-ahead flush).
- `apps/cli/test/ledger-activity-port.test.ts` — unit test for the impl against a fake `TapeEmitter`.
- `test/ledger-integration/activity-bracketing.test.ts` — e2e admit → dispatch → assert signed `activity_started`/`activity_completed` on the tape, write-ahead order, paired `activity_id`, `input_digest`/`result_digest` present.

**Modify:**
- `packages/kernel/src/ports.ts` — add the `LedgerActivityPort` interface + `LedgerActivityType` / input + completion types.
- `packages/kernel/src/orchestrator.ts` — `CreateBuildplaneOrchestratorOptions.ledgerActivityPort?` (`:104`); resolve it near the other option defaults; restructure `executeOnce` (`:1299`) to bracket (write-ahead started → invoke → completed).
- `packages/kernel/src/index.ts` — export `LedgerActivityPort` + its types.
- `apps/cli/src/run-cli.ts` — (a) extend `loadCliOrchestrator` (`:1044`) signature + internal `createBuildplaneOrchestrator` call (`:1394`) + the local options type-cast (`:1047-1064`) to carry `ledgerActivityPort`; (b) spawn the `run` ledger subprocess signed (`:4865`) + build the port + pass via `loadCliOrchestrator`; (c) restructure `runPlanForgeDispatchCommand` (`:3510`) to open a signed emitter + build the port **before** the orchestrator, in a `try/finally`; (d) `assertKernelSigningKey()` fail-fast (flag #2).
- `test/ledger-integration/fixtures.ts` — `makeBuildplaneRunFixture` provisions a kernel ed25519 seed at `$HOME/.buildplane/keys/kernel/kernel-main.ed25519` (else `sign: true` breaks 12+ run-fixture tests).

---

## Task 1: `LedgerActivityPort` + `executeOnce` bracketing (kernel)

**Files:** Test `packages/kernel/test/orchestrator-activity-bracketing.test.ts`; modify `packages/kernel/src/ports.ts`, `packages/kernel/src/orchestrator.ts` (`:104`, `:1299`), `packages/kernel/src/index.ts`.

- [ ] **Step 1: Write the failing tests** (`orchestrator-activity-bracketing.test.ts`). Inject a fake port that records call order. Assert, for a passing command packet (reuse this file's harness / `createPacket` from `orchestrator-admission.test.ts` as a model):
  - `activityStarted` is called **before** `runtime.executePacketAsync` (record a shared call log; the runtime mock pushes `"invoke"`, the port pushes `"started"`/`"completed"`; assert order `["started","invoke","completed"]`).
  - `activityStarted` receives `{ runId, activityId, activityType: "command", input }` and `activityCompleted` receives the **same** `activityId` plus the `result`.
  - When `ledgerActivityPort` is **absent**, the run still passes and the runtime is invoked exactly once (skip path — byte-unchanged).
  - The port’s `activityStarted` promise is **awaited** (make the fake’s `activityStarted` resolve on a deferred; assert the runtime is not invoked until it resolves — proves write-ahead ordering).

- [ ] **Step 2: Run to verify failure** — `pnpm -C <wt> exec vitest run packages/kernel/test/orchestrator-activity-bracketing.test.ts` → FAIL (no port option; `executeOnce` doesn’t bracket).

- [ ] **Step 3: Add the port interface** to `packages/kernel/src/ports.ts`:

```ts
export type LedgerActivityType = "model" | "tool" | "command";

export interface LedgerActivityStartInput {
	readonly runId: string;
	readonly activityId: string;
	readonly activityType: LedgerActivityType;
	/** Deterministic activity input; the impl digests it into ActivityStartedV1.input_digest. */
	readonly input: unknown;
}

export interface LedgerActivityCompleteInput {
	readonly runId: string;
	readonly activityId: string;
	/** Recorded activity result; the impl digests it into result_digest and stores it inline. */
	readonly result: unknown;
}

/**
 * Kernel-facing seam for emitting signed activity bracket events. The concrete
 * impl (CLI layer) wraps a signed ledger TapeEmitter. `activityStarted` MUST
 * resolve only once the event is durably on the tape (write-ahead), so the
 * orchestrator can `await` it before invoking the activity.
 */
export interface LedgerActivityPort {
	activityStarted(input: LedgerActivityStartInput): Promise<void>;
	activityCompleted(input: LedgerActivityCompleteInput): Promise<void>;
}
```

- [ ] **Step 4: Accept the port** in `CreateBuildplaneOrchestratorOptions` (after `outcomeRouting?`, `:104`): `readonly ledgerActivityPort?: LedgerActivityPort;`, and bind `const ledgerActivityPort = options.ledgerActivityPort;` near the other option destructures.

- [ ] **Step 5: Bracket `executeOnce`** (`:1299`). Restructure so both invoke paths funnel through a single awaited `r`, with the bracket around:

```ts
async function executeOnce(p: UnitPacket): Promise<ExecutionReceipt> {
	const activityType = p.model ? ("model" as const) : ("command" as const);
	scopedBus.emit({
		kind: "execution-started",
		runId: ctx.run.id,
		timestamp: new Date().toISOString(),
		executionType: activityType,
	});
	const activityId = randomUUID(); // import { randomUUID } from "node:crypto" — already imported at orchestrator.ts:2
	if (ledgerActivityPort) {
		// write-ahead: resolves only when activity_started is durable on the tape
		await ledgerActivityPort.activityStarted({
			runId: ctx.run.id,
			activityId,
			activityType,
			input: activityInputDescriptor(p), // { command } | { model } — deterministic
		});
	}
	let r: ExecutionReceipt;
	if (runtime.executePacketAsync) {
		r = await runtime.executePacketAsync(
			p, ctx.workspace.path, scopedBus, abortController.signal,
		);
	} else {
		r = runtime.executePacket(p, ctx.workspace.path);
		scopedBus.emit({
			kind: "command-execution-complete",
			runId: ctx.run.id,
			timestamp: new Date().toISOString(),
			exitCode: r.exitCode,
			outputChecks: r.outputChecks.map((c) => ({ path: c.path, exists: c.exists })),
		});
	}
	if (ledgerActivityPort) {
		await ledgerActivityPort.activityCompleted({
			runId: ctx.run.id,
			activityId,
			result: activityResultDescriptor(r), // { exitCode, stdout, stderr }
		});
	}
	return r;
}
```

> `activityInputDescriptor(p)` returns a minimal deterministic object: command → `{ command: p.execution?.command ?? "" }`; model → `{ model: p.model }` (or `p.intent` when present). `activityResultDescriptor(r)` returns `{ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }`. Define both as small local helpers (top of the orchestrator module or inline). **`randomUUID`** — `import { randomUUID } from "node:crypto"` is **already imported at `orchestrator.ts:2`**; reuse it (the codebase mints UUIDs this way; `globalThis.crypto` is NOT in the ES2023 no-DOM-lib typecheck surface, so do not use `crypto.randomUUID()`).

> **Note the behaviour change vs. today:** the async path currently `return`s `runtime.executePacketAsync(...)` directly; bracketing requires `await`ing it so `activity_completed` fires after. Confirm no caller depended on the un-awaited promise identity (the immediate caller at `:1332` already `await`s `executeOnce`).

- [ ] **Step 6: Export** from `packages/kernel/src/index.ts`: `export type { LedgerActivityPort, LedgerActivityType, LedgerActivityStartInput, LedgerActivityCompleteInput } from "./ports.js";`

- [ ] **Step 7: Typecheck + run** — `pnpm -C <wt> typecheck`; `pnpm -C <wt> exec vitest run packages/kernel/test/orchestrator-activity-bracketing.test.ts` → PASS.

- [ ] **Step 8: Commit** — `git commit -m "feat(kernel): bracket executeOnce activities via LedgerActivityPort (M2-S5)"`

---

## Task 2: `createLedgerActivityPort` impl (CLI layer)

**Files:** Create `apps/cli/src/ledger-activity-port.ts`, `apps/cli/test/ledger-activity-port.test.ts`.

- [ ] **Step 1: Write the failing test** against a fake `TapeEmitter` (records `emit` calls + `flush` count):
  - `activityStarted` calls `emit("activity_started", { ActivityStartedV1: { run_id, activity_id, activity_type, input_digest } })` then **awaits `flush()`** (assert `flush` was called exactly once and after the emit, before the returned promise resolves).
  - `input_digest` equals `digest({ command: "true" })` (import `digest` from `@buildplane/planforge` and compare) and is of the `sha256:<hex>` form.
  - `activityCompleted` calls `emit("activity_completed", { ActivityCompletedV1: { run_id, activity_id, result_digest, result } })` with `result_digest === digest(result)` and `result` passed through inline. (No required pre-resolve flush for completed.)

- [ ] **Step 2: Run to verify failure** — module does not exist.

- [ ] **Step 3: Implement** `apps/cli/src/ledger-activity-port.ts`:

```ts
import { type TapeEmitter, ActivityType } from "@buildplane/ledger-client";
import type { LedgerActivityCompleteInput, LedgerActivityPort, LedgerActivityStartInput } from "@buildplane/kernel";
import { digest } from "@buildplane/planforge";

/**
 * CLI-layer LedgerActivityPort: wraps a signed ledger TapeEmitter, computes the
 * canonical input/result digests, and emits the S2 activity bracket events.
 * `activityStarted` awaits emitter.flush() so it resolves only when the event is
 * durably on the signed tape (write-ahead — the orchestrator awaits it pre-invoke).
 */
export function createLedgerActivityPort(emitter: TapeEmitter): LedgerActivityPort {
	return {
		async activityStarted(i: LedgerActivityStartInput): Promise<void> {
			emitter.emit("activity_started", {
				ActivityStartedV1: {
					run_id: i.runId,
					activity_id: i.activityId,
					// ActivityStartedV1.activity_type is the generated `ActivityType` ENUM (Model/Tool/Command),
					// not a string. The enum values equal the kernel's string-union values, so cast is safe.
					activity_type: i.activityType as ActivityType,
					input_digest: digest(i.input),
				},
			});
			await emitter.flush(); // durable before the activity is invoked
		},
		async activityCompleted(i: LedgerActivityCompleteInput): Promise<void> {
			emitter.emit("activity_completed", {
				ActivityCompletedV1: {
					run_id: i.runId,
					activity_id: i.activityId,
					result_digest: digest(i.result),
					result: i.result,
				},
			});
		},
	};
}
```

> Confirm `digest` is exported from `@buildplane/planforge` (it is — `packages/planforge/src/index.ts` re-exports `digest` from `./digest.js`). `apps/cli` already depends on planforge + ledger-client, so no `published-bootstrap` entry change.

- [ ] **Step 4: Run** the test → PASS. **Step 5: Commit** — `git commit -m "feat(cli): add createLedgerActivityPort signed-emitter adapter (M2-S5)"`

---

## Task 3: wire the port into `planforge dispatch` (primary S5 path)

**Files:** `apps/cli/src/run-cli.ts` (`runPlanForgeDispatchCommand`, `loadCliOrchestrator`).

`planforge dispatch` already requires a kernel key (a `plan_admitted` exists), so it is the cleanest first signed-bracket path. **Both the `run` command and `dispatch` reach the orchestrator through the shared `loadCliOrchestrator` (`run-cli.ts:1044`) — neither calls `createBuildplaneOrchestrator` directly — so the port is threaded through `loadCliOrchestrator`, not around it.**

- [ ] **Step 1 — extend `loadCliOrchestrator` (THREE edits, all required or typecheck fails):**
  1. Change the signature `loadCliOrchestrator(projectRoot: string)` → `loadCliOrchestrator(projectRoot: string, opts?: { readonly ledgerActivityPort?: LedgerActivityPort })`. Default `undefined` keeps every existing caller working.
  2. Pass it into the internal `createBuildplaneOrchestrator({ … })` call (**`run-cli.ts:~1385-1394`**): add `ledgerActivityPort: opts?.ledgerActivityPort`.
  3. **Update the local dynamic-import kernel type-cast (`run-cli.ts:~1047-1064`)** that enumerates the `createBuildplaneOrchestrator` options shape — add `ledgerActivityPort?: unknown` (or import the type) to that cast, **or** the new call-site property is a TS "object literal may only specify known properties" error. (Task 1 Step 4 added the real field to `CreateBuildplaneOrchestratorOptions`; this local cast is a *separate* shape in `run-cli.ts` that must also be updated.)

- [ ] **Step 2** — In `runPlanForgeDispatchCommand` (`run-cli.ts:~3510-3578`): the function currently has **no** ledger subprocess/emitter and calls `loadCliOrchestrator(workspace)` *before* the packet loop. **Restructure** so the signed emitter is opened and the port built **before** the orchestrator is constructed, wrapping the orchestrator + loop in a `try/finally` that closes the emitter (this whole block is **new** code inserted around the existing `loadCliOrchestrator` + loop, not a modification of existing subprocess code):

```ts
const binary = resolveLedgerBinary(cwd);
const ledgerChild = spawnLedgerSubprocess(binary, runId, workspace, {
	sign: true,
	signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID, // "kernel-main"
});
const emitter = await createTapeEmitter({
	childStdin: ledgerChild.stdin, childStderr: ledgerChild.stderr,
	childExit: ledgerChild.exit, workspacePath: workspace, runId,
});
try {
	const ledgerActivityPort = createLedgerActivityPort(emitter);
	const { orchestrator, eventBus } = await loadCliOrchestrator(workspace, { ledgerActivityPort });
	// …existing per-packet runPacketAsync loop…
} finally {
	await emitter.close(); // flushes + closes the signed subprocess
}
```

> Reuse the **same `runId`** the dispatch path already derives (`planAdmitRunId(plan.idempotencyKey)`) so activity events land in the run’s partition on the shared `events.db`. Confirm `spawnLedgerSubprocess` / `createTapeEmitter` / `PLANFORGE_KERNEL_SIGNING_KEY_ID` are already imported in `run-cli.ts` (they are — used by `planforge admit`).

- [ ] **Step 3** — Typecheck. **Step 4: Commit** — `git commit -m "feat(cli): emit signed activity brackets on planforge dispatch (M2-S5)"`

---

## Task 4: wire the `run` path + kernel-key fail-fast (flag #2)

**Files:** `apps/cli/src/run-cli.ts` (`:4865` run ledger spawn).

- [ ] **Step 1** — Spawn the `run` ledger subprocess signed: change `spawnLedgerSubprocess(binary, ledgerRunId, resolvedCwd)` (`:4865`) to pass `{ sign: true, signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID }`. Build `const ledgerActivityPort = createLedgerActivityPort(ledgerEmitter);` after the emitter is created (`:4876`). The `run` command reaches the orchestrator via `loadCliOrchestrator` (`:4648`) — **pass the port through `loadCliOrchestrator(projectRoot, { ledgerActivityPort })`** (the signature extended in Task 3 Step 1), NOT a direct `createBuildplaneOrchestrator` call (the run command does not call it directly).

- [ ] **Step 2 — Kernel-key precondition (fail-fast).** Before spawning a signed subprocess (both run and dispatch), check the kernel key exists at `~/.buildplane/keys/kernel/kernel-main.ed25519`; if absent, throw a clear actionable error (do **not** auto-generate). Centralize as a small `assertKernelSigningKey()` helper reused by dispatch (Task 3) and run. _(Operator decision, flag #2: fail-fast accepted; `run` is unaffected when `useLedger` is false.)_

- [ ] **Step 3 — Update the run-fixture harness (REQUIRED — else 12+ tests break).** `sign: true` makes a keyless `run` fail the precondition. `test/ledger-integration/fixtures.ts` `makeBuildplaneRunFixture` does **not** provision a kernel key, so every test built on it would throw: `shell-command-capture`, `tape-capture-end-to-end`, `git-checkpoint`, `tool-capture`, `replay-basic`, `replay-at-event`, `fork-*`, `cwd-isolation`, `permission-denied`, `fork-vcr-basic`. Update `makeBuildplaneRunFixture` to **unconditionally provision a 32-byte ed25519 seed at `$HOME/.buildplane/keys/kernel/kernel-main.ed25519`** in its temp-HOME setup (mirror `makeDispatchEnv`/`makeAdmitEnv`’s seed write). Run the full `test/ledger-integration/` suite after this change and confirm green (these tests now produce signed tapes; the replay/fork tests must still pass — if any asserts an *unsigned* event shape, fix that assertion in this task).

- [ ] **Step 4** — Confirm the existing signed coexistence: under `sign: true`, the existing run-level emits (`run_started`/`run_completed`, `tool_request`/`tool_result`, `workspace_write`) now produce **signed** events — the Rust signer signs every append transparently. The Task 5 integration test + the regression run in Step 3 cover this.

- [ ] **Step 5: Commit** — `git commit -m "feat(cli): sign the run tape + emit activity brackets on buildplane run (M2-S5)"`

---

## Task 5: e2e integration test + Rust regression

**Files:** Create `test/ledger-integration/activity-bracketing.test.ts`. **Mirror `test/ledger-integration/planforge-dispatch.test.ts` EXACTLY** — open it and copy its real harness; the snippet below is corrected against that file's actual shapes (do not invent symbols):
- `makeDispatchEnv()` returns **`{ dir, home, eventsDbPath, cleanup }`** — there is no `workspace`/`inputRel`/`processEnv`. Use `env.dir` as `cwd`. The `--input` arg is a **module-level `GOAL_INPUT` constant** (repo-relative), exactly as the existing dispatch test uses it.
- HOME + native bin are injected via **`process.env`** in `beforeEach`/`afterEach` (`process.env.HOME = env.home`; `process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests()`), **not** a `runCli({ env })` option — `RunCliOptions` is `{ cwd?, stdout?, stderr?, dependencies? }` (no `env`).
- The fixture must provision the kernel seed at `$HOME/.buildplane/keys/kernel/kernel-main.ed25519` (it already does for admit/dispatch).
- **`readEvents` / `signatureFor` do NOT exist — define them as local helpers in this test file** (node:sqlite, read-only).

- [ ] **Step 1: Write the test** (own file — vitest worker-per-file isolation avoids the `fixtures.ts` `process.chdir` race):

```ts
import { DatabaseSync } from "node:sqlite";
// + mirror planforge-dispatch.test.ts imports: makeDispatchEnv, runCli, GOAL_INPUT,
//   resolveNativeBinaryForLedgerTests, beforeEach/afterEach env wiring.

function readEvents(eventsDbPath: string) {
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db.prepare("SELECT id, kind, payload FROM events ORDER BY id ASC").all() as
			Array<{ id: number; kind: string; payload: string }>;
	} finally { db.close(); }
}
function signatureFor(eventsDbPath: string, eventId: number) {
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db.prepare("SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?").get(eventId);
	} finally { db.close(); }
}

it("brackets each dispatched activity with signed activity_started/activity_completed", async () => {
	const env = await makeDispatchEnv();
	try {
		// REQUIRED: initialize the buildplane project (state.db) + commit, or dispatch throws
		// "Buildplane state is incomplete" at storage.createRun(). Mirror planforge-dispatch.test.ts's init.
		await runCli(["init"], { cwd: env.dir });
		// (commit the init + plan input per the existing dispatch test's git setup)

		await runCli(["planforge","admit","--input",GOAL_INPUT,"--approve","--operator","op1","--json"], { cwd: env.dir });
		const res = await runCli(["planforge","dispatch","--input",GOAL_INPUT,"--json"], { cwd: env.dir });
		expect(res.code).toBe(0);

		const rows = readEvents(env.eventsDbPath);
		const started = rows.filter((r) => r.kind === "activity_started");
		const completed = rows.filter((r) => r.kind === "activity_completed");
		expect(started.length).toBe(2);   // one bracket per dispatched task (PF1, PF2)
		expect(completed.length).toBe(2);
		for (const s of started) {        // write-ahead: started.id < its paired completed.id
			const sid = JSON.parse(s.payload).ActivityStartedV1.activity_id;
			const c = completed.find((x) => JSON.parse(x.payload).ActivityCompletedV1.activity_id === sid);
			expect(c).toBeDefined();
			expect(s.id).toBeLessThan((c as { id: number }).id);
			expect(signatureFor(env.eventsDbPath, s.id)).toMatchObject({ actor_id: "kernel", key_id: "kernel-main", algorithm: "ed25519" });
			expect(JSON.parse(s.payload).ActivityStartedV1.input_digest).toMatch(/^sha256:/);
		}
		for (const c of completed) expect(JSON.parse(c.payload).ActivityCompletedV1.result_digest).toMatch(/^sha256:/);
	} finally { await env.cleanup(); }
}, 30_000);
```

> Confirm `events.id` is the integer/`{:012}` event id used by `event_signatures.event_id` (matches the S4 admitted-plan-reader query). Optional cheap add: assert `scripts/verify-signed-tape.mjs` still validates the tape end-to-end (the new signed activity events are non-checkpoint, `id ASC` — the verifier contract holds).

- [ ] **Step 2: Build native, run** — `pnpm -C <wt> native:build`; `pnpm -C <wt> exec vitest run test/ledger-integration/activity-bracketing.test.ts` → PASS.

- [ ] **Step 3: Rust regression** — `cargo test --manifest-path native/Cargo.toml -p bp-ledger activity` (the S2 activity round-trip/digest tests still pass) **and** the whole-workspace gate `cargo test --manifest-path native/Cargo.toml` (NO `-p`) — S5 adds no Rust, so this is a no-op exhaustive-match regression check.

- [ ] **Step 4: Commit** — `git commit -m "test(ledger): e2e cover signed activity bracketing on dispatch (M2-S5)"`

---

## Task 6: slice verification + changeset

- [ ] **Step 1: Canonical slice verify** —
```bash
pnpm -C <wt> native:build
pnpm -C <wt> exec vitest run test/ledger-integration/activity-bracketing.test.ts packages/kernel/test/orchestrator-activity-bracketing.test.ts apps/cli/test/ledger-activity-port.test.ts
```
(the spec’s S5 verification — adapted to the actual test paths). Also re-run `packages/kernel/test/orchestrator-admission.test.ts` + `test/ledger-integration/planforge-dispatch.test.ts` to confirm no regression from the `executeOnce` restructure.

- [ ] **Step 2: Published-bootstrap closure** — `pnpm -C <wt> exec vitest run test/workflow/published-bootstrap-stage.test.ts` → PASS, no snapshot change (no new `@buildplane/*` import in `apps/cli`).

- [ ] **Step 3: Changeset** — `@buildplane/kernel` + `@buildplane/cli` minor (`packages/ledger-client`/`planforge` unchanged surface — confirm; if only consumed, no bump). Create `.changeset/m2-s5-activity-bracketing.md`:
```md
---
"@buildplane/kernel": minor
"@buildplane/cli": minor
---

M2-S5: activity bracketing — executeOnce emits write-ahead signed activity_started
(before invoke) + activity_completed (recorded result + digest) via a kernel
LedgerActivityPort; run/dispatch tapes are kernel-signed.
```

- [ ] **Step 4: Commit** — `git commit -m "chore(release): add M2-S5 activity-bracketing changeset"`

---

## Review & merge (L0 ceremony)

- **Review tier: L0 — Opus + adversarial Codex** (spec line 207). S5 emits **signed** events onto the L0 tape from the kernel run loop and changes the run-loop execution path (`executeOnce` restructure). The adversarial Codex pass must specifically cover:
  1. **Write-ahead durability** — `activity_started` is `emit()`-ed **and `flush()`-ed** (resolved) before `runtime.executePacket*` is called; a crash between started and invoke leaves a recoverable tape. Confirm `executeOnce` `await`s `activityStarted` (not fire-and-forget) and that the async path is now `await`-ed (not returned un-awaited).
  2. **Pairing integrity** — `activity_id` minted once per bracket, identical on started + completed; `ActivityCompletedV1` correctly omits `activity_type` (pairing by id only).
  3. **Digest contract** — `input_digest`/`result_digest` use `@buildplane/planforge`’s canonical `digest()` (NOT `JSON.stringify`, NOT the `preview.ts` idempotency exception).
  4. **Dependency invariant** — `packages/kernel` imports neither `@buildplane/ledger-client` nor `@buildplane/planforge` (port is plain types; impl + digest live in `apps/cli`).
  5. **Skip path** — absent `ledgerActivityPort` ⇒ run byte-unchanged (no emit, single invoke).
  6. **Signed coexistence** — flipping run/dispatch to `sign: true` keeps existing run-level events round-tripping; kernel-key fail-fast is clear and does not silently weaken to unsigned.
- The Reviewer verdict must cite the reviewed SHA (== PR head) and confirm `runPacket` (sync, `:1112`) is **unmodified**.
- **Solo L0 PR — not auto-merge eligible** (no `buildplane:auto-merge`); operator admin-merge once CI `verify` + `Analyze` green.
- Route every push/PR through a fresh subagent (biome-OOM guard). Lead commit subjects with a lowercase verb. Record the slice against `docs/operations/slice-receipt-template.md`.

---

## Self-review

**Spec coverage** (S5 acceptance, spec line 198):
- "every model/tool/command activity is bracketed" → Task 1 (executeOnce brackets packet-level `model`/`command`) + Task 3/4 (dispatch + run wiring) + Task 5 (asserts 2 brackets). **`tool` (per-tool-call) bracketing is flagged out of scope** (flag #1) — the spec’s named site (`executeOnce`) is packet-level; tool I/O already has `tool_request`/`tool_result`. ⚠ operator sign-off.
- "`activity_completed` carries the recorded result + digest" → Task 2 (`result` + `result_digest = digest(result)`) + Task 5 assertion. ✔
- "events are on the signed tape" → Task 3/4 (`sign: true`, kernel-main) + Task 5 signature-row assertion. ✔
- "`activity_started` durably appended before invocation" → E2 (await emit+flush) + Task 1 ordering test + Task 5 `id` ordering assertion. ✔
- Verification command (spec line 200-205) → Task 5/6. ✔ Review tier (spec line 207) → Review section. ✔

**No new wire shape:** verified S2 shipped `ActivityStartedV1`/`ActivityCompletedV1` complete (Rust+TS, fixtures, u64-guards) and `bp-replay` no-op arms exist — S5 touches no `native/`, no `canonicalize.rs`, no typeshare, no fixtures. The whole-workspace `cargo test` in Task 5 is a no-op regression gate.

**Type consistency:** `LedgerActivityPort` / `LedgerActivityStartInput` / `LedgerActivityCompleteInput` / `LedgerActivityType` match between `ports.ts` (def), the orchestrator call, and the CLI impl. Payload keys (`ActivityStartedV1`/`ActivityCompletedV1` + snake_case fields `run_id`/`activity_id`/`activity_type`/`input_digest`/`result_digest`/`result`) match the S2 TS union (`payload.ts:39-40`) exactly. `activity_id` is a plain string, minted once, reused.

**Placeholder scan:** the helper names to mirror from real files — `makeDispatchEnv`/`runCli`/`readEvents`/`signatureFor` (from `planforge-dispatch.test.ts` + `planforge-admit.test.ts`), `loadCliOrchestrator`/`spawnLedgerSubprocess`/`createTapeEmitter`/`PLANFORGE_KERNEL_SIGNING_KEY_ID` (existing `run-cli.ts` symbols), `digest` (`@buildplane/planforge`) — all reference existing symbols, not unspecified behaviour. No `TODO`/`TBD` remain. The two flagged scope items (per-tool-call bracketing; run-path key fail-fast) are explicit operator-sign-off points, not hidden gaps.
