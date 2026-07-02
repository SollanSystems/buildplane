# M5 — Web Mission Control (Run Inspector + Approval Inbox) — Design

**Date:** 2026-06-21
**Status:** Design — authored by the supervised v0.5 build loop at `M5-PLAN`
**Milestone:** M5 (the 🔶 next milestone after M4-GATE `252f7c5`)
**Companion plan:** [`docs/superpowers/plans/2026-06-21-m5-web-mission-control.md`](../plans/2026-06-21-m5-web-mission-control.md)
**Source-of-truth contract reused verbatim:** [`docs/architecture/run-inspector-evidence-slice.md`](../../architecture/run-inspector-evidence-slice.md)
**North-star vision:** v0.5 design L8 + §7 killer demo — [`2026-05-21-buildplane-v05-design.md`](./2026-05-21-buildplane-v05-design.md)

> This spec is grounded in a 5-agent discovery sweep of the **real** tree at `252f7c5` (not the 2026-05-02 arch doc's prose). Every "exists today" claim cites `file:line`.

---

## 1. Goal

Ship **Mission Control web UI v1**, local-only, in two surfaces:

1. **Run Inspector** — a read-only forensic viewer for any run: **Event Timeline + Evidence Pane + Outcome Strip** (the contract already documented in `run-inspector-evidence-slice.md`), plus a run list.
2. **Approval Inbox** — lists pending operator decisions and approves/rejects them, **emitting a signed event to the L0 tape** for every decision.

It is the **L7 operator surface** (CLI/TUI/web) reading the M1–M4 backend. The whole point: make a BLOCKED/FAILED run *legible from evidence*, and make an operator's approve/merge decision a *signed, replayable* fact — not a click that vanishes.

---

## 2. What already exists (reuse, do not rebuild)

Discovery confirmed the read model is **real and complete**:

| Capability | Symbol | Location |
|---|---|---|
| Single-run deep read | `InspectSnapshot` | `packages/kernel/src/run-loop.ts:238` |
| Builder | `storage.inspectTarget` | `packages/storage/src/store.ts:3191` |
| Kernel wrapper | `orchestrator.inspect` | `packages/kernel/src/orchestrator.ts:1828` |
| **3-panel projection (pure fn)** | `createInspectorProjection` → `InspectorProjection` | `apps/cli/src/formatters.ts:633 / :452` |
| Storage-local event timeline | `readEventTapeSummary` | `packages/storage/src/store.ts:1824` |
| Evidence / decisions / artifacts reads | `readEvidence` / `readDecisions` / `readArtifacts` | `store.ts:1643 / :1666 / :1684` |
| Suspend / approve / reject FSM | `suspendRun` / `approveRun` / `rejectSuspendedRun` | `store.ts:2503 / :2529 / :2555` (on `BuildplaneStoragePort` `ports.ts:93`) |
| Suspended-count badge | `getStatusSnapshot().runCounts.suspended` | `store.ts:3107` |
| Signed-emit pattern — **lives in `apps/cli`, not kernel** | `spawnLedgerSubprocess` + `PLANFORGE_KERNEL_SIGNING_KEY_ID` + `createTapeEmitter` + `emitAcceptanceRecorded` | `apps/cli/src/run-cli.ts:3370–3429`, `apps/cli/src/ledger-acceptance.ts:26` |
| Port-injection precedent (reuse the *pattern*, not a layer move) | `BuildplaneAcceptancePort` / `createAcceptancePort` (kernel interface, apps/cli impl, injected) | `packages/kernel/src/ports.ts` + `apps/cli` wiring |
| Closest signed-event template | `PlanAdmittedV1` / `AcceptanceRecordedV1` | `ledger-client/src/generated/index.ts:241` / `payload/acceptance.rs:17` |
| Web framework dep | `vite@8.0.5` (already pinned in root devDeps via `pnpm.overrides`) | root `package.json` |

The Run Inspector is therefore **a serving problem, not a modeling problem**: expose the existing snapshot/projection over HTTP and render it.

## 3. The two hard truths discovery surfaced

### 3.1 Storage is two-tier — the inspector reads Tier 1

- **Tier 1 — `state.db`** (`<repo-root>/.buildplane/state.db`, TS): the `events` table is an **unsigned local mirror** written by the TS side. `readEventTapeSummary` reads it. **All existing `BuildplaneStoragePort` reads work here. The Run Inspector MVP is built entirely on Tier 1.**
- **Tier 2 — `events.db`** (Rust Ed25519 signed ledger): the TS `ledger-client` is **write-only — there is no TS read-back path**; read-back is Rust-only (`export_signed_tape` / bp-cli `ledger export`).

> **Correction (critique L2):** the signed ledger is **repo-root-scoped and survives worktree teardown** — every signed-emit call site passes `workspace = resolve(cwd)` (the repo root, `run-cli.ts:3748/3915/4114`), so M2/M3/M4 admit-cycle events already persist at `<repo-root>/.buildplane/ledger/events.db`. **What is torn down after a clean run is the per-run *git worktree* (the isolated working copy with the diff to merge) — NOT the signed ledger.** Keep these distinct: the **write** path for `operator_decision_recorded` (§4) always has a repo-root ledger to append to; only the *merge side effect* faces the missing-worktree problem (→ Decision F). Do **not** carry "the signed ledger may be gone" into the write path.

**Decision C (fork, operator-confirmed): defer Tier-2 signature display to M6+.** Re-justified on the *correct* grounds: there is **no TS read-back path** for the signed ledger, and signature **authenticity is the external verifier's job** (`scripts/verify-signed-tape.mjs`), out of band — not because the ledger is absent. The timeline renders the Tier-1 projection, **clearly labeled as the storage projection** (matches the arch doc non-goal "no signing claims beyond existing hashes/refs").

### 3.2 The approval climax needs a NEW L0 event

The v0.5 demo's steps 9–10 ("result-ready" + **"signed approval event written to tape"**) have **no existing event kind**; the 22 current kinds cover run/unit/plan lifecycle, capability-denial (M3), and the *kernel's automated* acceptance verdict (M4) — **none records the human operator's decision**. The M4 spec *explicitly deferred the operator merge-decision event to M5* (`2026-06-18-m4-acceptance-contract-design.md:44`). The existing `approveRun`/`rejectSuspendedRun` path is **unsigned (state.db only)** — wiring the inbox to it alone is a documented "trust-level regression."

**Decision A (fork, operator-confirmed): add one new signed L0 ledger kind `operator_decision_recorded`.** Every operator decision (approve/reject, merge/resume) lands on the signed tape. This is the trust-first-correct design and the only way the M6 demo can show signed approval.

---

## 4. Design decisions

| # | Decision | Rationale |
|---|---|---|
| **A** | **Add signed L0 `operator_decision_recorded`** (single kind covers approve/reject × merge/resume). Defer `result_ready` — derive the inbox feed instead. | Honors trust-first thesis + demo step 10; one kind minimizes L0 surface. |
| **B** | **Inbox covers Flow 3 (post-acceptance MERGE) + Flow 1 (suspended-run RESUME)**, unified under one orchestrator `recordOperatorDecision`. Flow 2 (web plan-admit) deferred. | Flow 3 is the demo climax; Flow 1 is the real suspension case already in the engine. Both routed through the signed event. |
| **C** | **Defer Tier-2 signature read-back** to M6+. Inspector renders Tier-1 projection, labeled. | Arch-doc non-goal; events.db is write-only-from-TS and worktree-ephemeral. |
| **D** | **`packages/mission-control-server`** (mirrors `ui-tui`; → `OPTIONAL_INTERNAL_PACKAGES`, **lazy-imported** by a `bp web` subcommand) + **`apps/web`** Vite SPA + **`bp web`** subcommand. Server uses `node:http` (no new web-framework dep). | Lazy-import keeps the published-bootstrap closure untouched (`ui-tui` precedent). `node:http` minimizes deps/biome/bundle surface. |
| **E** | **Loopback bind only** + a **`~/.buildplane/web-token`** bearer check on **write** endpoints. `BUILDPLANE_WEB_ALLOW_EXTERNAL=1` is an explicit opt-in to bind beyond loopback (emits a warning). | Closes "any localhost listener can approve a merge" without real auth infra. |
| **F** | **Accepted-but-undecided runs RETAIN their git worktree** until the operator decides (mirrors M4 quarantine retention), released on decision. *Alternative an implementer may choose in S4:* operate the squash-merge off the worker's committed branch ref instead of the live worktree dir. | A clean run tears its worktree down at finalize; a *later* web merge (Flow 3) then has nothing to merge. Retention (or ref-based merge) is what makes the deferred operator-merge flow possible at all. |
| **G** | **Signed emit goes through an injected `OperatorDecisionPort`** — interface in `packages/kernel`, ledger-backed impl in `apps/cli` (reusing the existing `spawnLedgerSubprocess`/`createTapeEmitter`), injected into both the CLI orchestrator and the `bp web`-launched server. **No subprocess/native-binary code moves into any package.** | `spawnLedgerSubprocess` is CLI-layer (child-process + native-binary resolution). Lifting it into kernel would pollute every `@buildplane/kernel` importer; the `AcceptancePort` precedent keeps native coupling at the composition root. The server (a package) receives only the *interface* — never imports `apps/cli`. |

### 4.1 `operator_decision_recorded` — proposed wire shape (finalized in M5-S1 TDD)

```
OperatorDecisionRecordedV1 {
  run_id:              String,
  decision:            "approved" | "rejected",
  subject:             "merge" | "resume",          // Flow 3 vs Flow 1
  acceptance_event_id: Option<String>,              // merge: the acceptance_recorded this approves
  admission_event_id:  Option<String>,              // plan_admitted lineage when present
  merge_commit:        Option<String>,              // set when an approved merge produced a commit
  decided_by:          String,                      // operator identity (payload field)
  decided_at:          String,                      // RFC3339
}
```

- **No `u64` fields** → no U64→string wire hazard. (Still verify in S1.)
- **Signed by the kernel key** (`actor_id="kernel"`, `key_id="kernel-main"`); operator identity is the `decided_by` payload field — identical convention to `plan_admitted`/`acceptance_recorded`. Operator-key signing stays deferred (consistent with M2).
- **Replay = metadata no-op** (no state transition), same as `run_admission_recorded` in `bp-replay/transitions.rs` — but the arm is **mandatory** (exhaustive match, no `_` catch-all).

### 4.2 Approval inbox model

The inbox feed = **pending operator decisions**, the union of:
- **Flow 1 — suspended runs:** `runs.status = 'suspended'` (policy-gate `trustGates.requiresApproval`). Action: resume (`approveRun`) or reject (`rejectSuspendedRun`).
- **Flow 3 — accepted-but-undecided runs:** runs with an `acceptance_recorded{outcome=passed}` and **no subsequent `operator_decision_recorded`**. Action: merge (approve) or quarantine (reject).

`recordOperatorDecision({ runId, decision, subject })` (kernel) does, in write-ahead order:
1. validate (run is in the expected state for `subject`; optimistic — `approveRun` already throws if status ≠ suspended);
2. **emit + flush** the signed `operator_decision_recorded` event **before** the side effect;
3. perform the side effect: `subject=resume` → `approveRun`/`rejectSuspendedRun`; `subject=merge` + `approved` → existing finalize/merge path (`commitAndMergeWorkspace`); `subject=merge` + `rejected` → quarantine (no merge, preserved worktree, per M4).

This closes the trust-chain hole for **both** flows: the resume path that is unsigned today becomes signed too.

**Crash-recovery reconciler (the M6 runway — critique L2).** The write-ahead order (emit+flush **before** the side effect) creates a deterministic crash window where `operator_decision_recorded{approved}` is durable on the tape but the merge/resume did **not** complete. Per the resume rule (the tape is authoritative over storage status), startup recovery must, on seeing a decided-but-unexecuted record, **idempotently re-drive the side effect exactly once** — the M2-S7 missing-receipt re-emit contract, extended to this kind. The `operator_decision_recorded` payload carries enough to make the re-drive safe (detect an existing `merge_commit` / downstream receipt before acting, so a second pass cannot double-merge). S4 must specify and test this arm; M6 consumes it.

**Pre-flight confirmation (gates S4 — critique L3).** The decision event is appended to the **repo-root** ledger of an **already-completed** run. Before S4 builds, confirm `bp-ledger` can open/append to an existing completed run's `events.db` (a fresh `ledger serve` session over the repo-root ledger). If it cannot, the `OperatorDecisionPort` impl uses a **standalone ledger-append** path rather than a live per-run subprocess session. This is a real spike, not an aside.

---

## 5. Source-of-truth rendering contract (reused verbatim)

The three panels render **only** fields backed by real records (`run-inspector-evidence-slice.md` §"Source-of-truth contract"). No panel may invent reasoning events, synthetic summaries, or signing claims.

- **Event Timeline** ← `InspectorProjection.eventTimeline` (`{id, kind, occurredAt, summary, metadata?}[]`); jump-to-event, **not** a cinematic scrubber. Closed v1 event vocabulary = the generated `EventKind` enum (copied, never invented). Add `parentRunId` surfacing for fork/parent lineage (currently in DB, not in `InspectSnapshot`).
- **Evidence Pane** ← `InspectorProjection.evidencePane` (`{evidence, decisions, artifacts}`); prefer raw excerpts + durable refs over paraphrase; **render missing evidence as missing**; redact secrets to hashes/hints.
- **Outcome Strip** ← `InspectorProjection.outcomeStrip`; **fail-closed verdict mapping** (`createInspectorProjection` already implements it: PASSED needs passing evidence; BLOCKED on missing evidence / required approval; FAILED on explicit failure; UNKNOWN on partial). Reuse verbatim — **do not re-derive verdicts in the UI.**

**Demo posture (unchanged):** lead with a BLOCKED run; click the halted event; show raw evidence; show the Outcome Strip stopping merge because acceptance isn't green. Evidence over confidence.

---

## 6. Architecture

```
apps/web (Vite SPA, React)
   │  fetch /api/*  (loopback; token on writes)
   ▼
packages/mission-control-server  (node:http; OPTIONAL_INTERNAL_PACKAGES; lazy-imported)
   │  reads:  orchestrator.inspect / listRunsByStatus / status / inbox-feed
   │  writes: orchestrator.recordOperatorDecision  ──emits──►  signed L0 tape (operator_decision_recorded)
   ▼
packages/kernel + packages/storage  (Tier-1 state.db reads; existing FSM)        packages/ledger-client (signed emit)
```

- **Read endpoints:** `GET /api/runs?status=&limit=&cursor=`, `GET /api/runs/:id/inspector` (→ `InspectorProjection`), `GET /api/status` (badge counts), `GET /api/inbox` (pending decisions feed).
- **Write endpoint:** `POST /api/runs/:id/decision { decision, subject }` → `recordOperatorDecision` (token-gated).
- **Static:** server serves the built `apps/web` bundle.
- **Live updates:** **poll** in MVP (`GET /api/status` + list). In-process EventBus SSE/WebSocket push is deferred (only works in-process; not worth the coupling for v1).
- **Perf:** add **pagination** + a single aggregating query for the run list (current `getRunHistory` is O(N²) subqueries + unbounded — must not be served raw).
- **Concurrency:** optimistic — the decision POST may race the kernel; `approveRun`/`recordOperatorDecision` throw on unexpected state and the UI surfaces the conflict.

---

## 7. Success criteria (evidence-named)

M5 satisfies loop **SC1** when:

1. **Run Inspector** serves all three panels for a real run over HTTP, rendering only source-of-truth fields. *Evidence:* `packages/mission-control-server` tests assert the `/api/runs/:id/inspector` response equals `createInspectorProjection(orchestrator.inspect(id))`; `apps/web` component tests render each panel from fixture projections.
2. **Approval Inbox** lists pending decisions and approving/rejecting **emits a signed `operator_decision_recorded`** to the tape, then performs the correct side effect (merge/quarantine/resume). *Evidence (two distinct assertions — critique L1/L2):* **(a)** an **S4 ledger-integration test** (`test/ledger-integration/`, native binary built) drives a suspended run *and* a completed-accepted run through `recordOperatorDecision` and asserts the signed `operator_decision_recorded` is **present in the repo-root `events.db` and verifies under the kernel key**, the run reaches the expected terminal state, and a crash between flush-ack and side-effect re-drives to **exactly-once** on resume; **(b)** an **S5 server test** asserts `POST /decision` calls the injected `OperatorDecisionPort` exactly once and is token-gated. (a) is the signed-tape evidence; (b) is the HTTP-surface evidence — neither alone is sufficient.
3. **`bp web`** launches the server bound to loopback, serving the SPA, with the published-bootstrap closure unchanged. *Evidence:* `bp web --check` (no-listen self-test) exits 0; the **`test/workflow/published-bootstrap-stage.test.ts` snapshot test passes** — this is a vitest test, so the loop's `verify_fast` step catches a closure miss (it is **not** CI-only); `apps/web/dist` is gitignored and `vite build` runs **inside `pnpm build`** (after both CI "assert no dist" steps), so neither dist assertion trips.
4. All M5-S* slices merged to `main` with recorded merge SHAs; CI `verify`+`Analyze` green at each; **`docs/operations/*m5-gate*.md`** receipt exists. *(= the loop's SC1 evidence rule + SC4.)*

---

## 8. Non-goals (explicit — deferred, not forgotten)

- **Tier-2 signed-tape read-back / per-event verified badges** (decision C) → M6+.
- **`result_ready` tape event** → derive the feed instead; revisit if the M6 demo needs the explicit signal.
- **Web plan-admit (Flow 2 / demo step 4 "click Admit")** → CLI `planforge admit` stays the admit path for M5; web-admit is M6 demo-glue if needed.
- **SSE/WebSocket live push, time-scrubber animation, orchestration graph, intake parser, agent persona cards, generic chat** (arch-doc non-goals).
- **Multi-operator / CRDT / federation, mobile, IDE extensions, real auth** (v∞).
- **Operator-key signing** (kernel key signs; operator identity is a payload field — consistent with M1–M4).

---

## 9. Risks & traps (each has burned a prior session)

- **L0 derivation discipline (M5-S1):** the new kind is the 9-file Rust+TS derivation (CLAUDE.md §"Adding a new event kind"). Run the **whole** native workspace (`cargo test --manifest-path native/Cargo.toml`, **no `-p`**) — a new `Payload`/`EventKind` variant breaks sibling exhaustive matches (`bp-replay`) — the PR #163 lesson. Regenerate fixtures; `git diff --exit-code` generated + fixtures. Solo L0 PR ⇒ **not auto-merge eligible** (admin-merge; full 4-role ceremony).
- **Published-bootstrap closure:** keep the server in `OPTIONAL_INTERNAL_PACKAGES`, **lazy-imported** inside the `bp web` handler — do **not** add it to `INTERNAL_PACKAGE_ENTRYPOINTS` (that forces a `REQUIRED_BUILD_OUTPUTS` snapshot update and vendors it). Only CI `verify` catches a miss.
- **`apps/web/dist`:** gitignore it AND exclude it from the CI "assert no dist dirs" glob (currently `apps/cli/dist packages/*/dist`). Wire `vite build` explicitly — `tsc --build` does **not** build a Vite app, so `pnpm build` silently skips it otherwise.
- **Biome OOM:** `biome check .` OOMs in WSL — CI is canonical; route every push through a fresh subagent; scope local lint to changed files.
- **Slice verify:** `pnpm -C <worktree> exec vitest run <paths>`. **Never** `pnpm --filter buildplane test`.
- **Per-run git *worktree* teardown (NOT the ledger):** the signed ledger is repo-root and persists (§3.1); the *isolated git worktree* is torn down after a clean run. Consequences: (1) the inspector's Tier-1 read path already handles cleaned workspaces (renders fine); (2) Flow-3 **merge** of a completed-accepted run needs the worktree (or its branch ref) retained — **Decision F**. Don't conflate the two.
- **Inbox Flow-3 needs a Tier-1 acceptance signal (critique L1):** `acceptance_recorded{passed}` is a signed-L0-only event (`events.db`) with **no Tier-1 mirror** and **no TS read-back** — so the `state.db` inbox query has nothing to filter on. M5 must write a **Tier-1 acceptance-shadow row** (a column on `runs` or a small `run_acceptance` table) at the M4 acceptance-gate moment (`evaluateAndRecordAcceptanceAsync`), alongside the signed event. This is real hidden work owned by **M5-S2**, and it touches the M4 path.
- **vitest alias:** add `@buildplane/mission-control-server` to `vitest.config.ts` `workspaceAliases` (and TS project `references`) or its tests can't resolve siblings.

---

## 10. Slice map (detail in the companion plan)

| Slice | Tier | Summary |
|---|---|---|
| **M5-S1** | **L0** | `operator_decision_recorded` signed ledger kind (9-file Rust+TS derivation). |
| **M5-S2** | L2 | Storage read surface: `listRunsByStatus` + pagination + pending-decisions feed + **Tier-1 acceptance-shadow** + `parentRunId` in `InspectSnapshot` (incl. `run-loop.ts` + `toRun`). |
| **M5-S3** | L2 | Extract `createInspectorProjection`/`InspectorProjection` → `@buildplane/kernel`, **rewritten to the strict `InspectSnapshot`** (no `*Like` in kernel; +`pnpm typecheck`). |
| **M5-S4** | **L0 · 4-role** | `OperatorDecisionPort` (kernel iface, apps/cli impl, injected) + `orchestrator.recordOperatorDecision` — **write-ahead signed emit + crash-recovery reconciler** + merge(retained-worktree)/quarantine/resume. Sole writer of the new tape fact ⇒ full ceremony, not auto-merge eligible. |
| **M5-S5** | L2 | `packages/mission-control-server` — `node:http` read+write API, loopback+token, static serve. |
| **M5-S6** | L2 | `apps/web` Run Inspector UI (3 panels + run list) against the API/fixtures. |
| **M5-S7** | L2 | `apps/web` Approval Inbox UI (pending feed + approve/reject). |
| **M5-S8** | L2 | `bp web` CLI subcommand + Vite build/CI/bootstrap/gitignore wiring. |
| **M5-GATE** | L3 | Gate receipt under `docs/operations/`. |

Build order: **S1 ∥ S2 ∥ S3** (independent) → **S4** (needs S1) → **S5** (needs S2,S3,S4) → **S6 ∥ S7** (against S5's contract; UI can develop against mocks) → **S8** → **M5-GATE**.
