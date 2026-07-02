# M5 — Web Mission Control — Implementation Plan

**Date:** 2026-06-21 (revised after a 3-lens adversarial critique — REVISE verdict incorporated)
**Spec:** [`docs/superpowers/specs/2026-06-21-m5-mission-control-design.md`](../specs/2026-06-21-m5-mission-control-design.md)
**Milestone:** M5 · base `252f7c5` (M4-GATE) · target: all M5-S* merged + `M5-GATE` receipt (loop SC1)
**Driven by:** the supervised v0.5 build loop (`.loop/`). This plan is the **expand_queue source** — its slices become `M5-S*` tasks in `TASKS.json`.

> Conventions (loop SPEC/WORKFLOW + CLAUDE.md): TDD RED→GREEN→commit · slice verify `pnpm -C <worktree> exec vitest run <paths>` (never `pnpm --filter buildplane test`) · FF from `origin/main` before each branch · conventional **lowercase-verb** commits · changeset only when a **published** `packages/*`/`apps/*` surface changes · path-scoped `git add` · **route every commit/push through a FRESH subagent** (clean memory budget runs husky's `biome check .` without the WSL OOM; **never `HUSKY=0`/`--no-verify`/`core.hooksPath=`**; if a fresh subagent still OOMs, `FailedBlocked`) · CI `verify` is canonical.

---

## Pre-build design resolutions (close the critique's "open confirmations" BEFORE dispatching slices)

These were ambiguous in the first draft and each could half-build a slice. Resolved here so the loop does not decide them mid-build:

1. **Signed-emit is CLI-coupled — use a port, don't relocate subprocess code (CRITICAL).** `spawnLedgerSubprocess` / `PLANFORGE_KERNEL_SIGNING_KEY_ID` / `createTapeEmitter` / `kernelSigningKeyPath` live **only in `apps/cli`** (zero hits in `packages/`). Resolution = **Decision G**: define `OperatorDecisionPort` (interface) in `packages/kernel`; implement the ledger-backed concrete in `apps/cli` (reuse existing helpers verbatim); **inject** it into the CLI orchestrator AND into the `bp web`-launched server. `packages/mission-control-server` depends on the **interface only** and never imports `apps/cli`. **No native/subprocess code moves into any package** (mirrors `AcceptancePort`/`createAcceptancePort`).
2. **Ledger append to a *completed* run (CRITICAL spike — gates S4).** The decision event appends to the **repo-root** `events.db` of an already-completed run. **Confirm `bp-ledger` can open/append to an existing completed run's ledger** (fresh `ledger serve` over the repo-root ledger). If not → the port impl uses a **standalone ledger-append** command. Run this spike as the first task of S4 (or a 1-hour pre-S4 probe); it decides the port impl shape.
3. **Merge side effect is reachable; the *worktree* is the problem (HIGH).** `commitAndMergeWorkspace` is an **injected `WorkspaceAdapter` port method** (`ports.ts:346`, called at `orchestrator.ts:1237`) — callable from `recordOperatorDecision`, no extraction. But a completed clean run's **git worktree is torn down**, so Flow-3 merge has nothing to merge → **Decision F**: accepted-but-undecided runs **retain their worktree** (M4-quarantine-style) until the operator decides; *or* the merge runs off the worker's committed branch ref. Pick one in S4's design step.
4. **Flow-3 inbox feed needs a Tier-1 signal (CRITICAL).** `acceptance_recorded{passed}` is signed-L0-only (no `state.db` row, no TS read-back). **S2 adds a Tier-1 acceptance-shadow** (column on `runs` or `run_acceptance` table) written by the M4 path; the inbox query filters on it.
5. **DOM tests use per-file annotations, not a root-config change (HIGH).** `apps/web` component tests carry `// @vitest-environment jsdom` (or `happy-dom`) per file — the root `vitest.config.ts` stays node-default, so the existing ~200 tests are unperturbed. This makes S6 ∥ S7 genuinely parallel (no shared `vitest.config.ts` edit).
6. **`apps/web` is NOT a tsc project reference (HIGH).** Vite apps type-check via their own `tsc --noEmit`, not the root `tsc --build` composite graph. S8 wires a separate `tsc --noEmit` for `apps/web`; it is **not** added to root `tsconfig.json` references. `vite build` runs **inside `pnpm build`** (after both CI "assert no dist" steps); `apps/web/dist` is gitignored.

---

## Build order & dependency graph

```
S1 (L0 event)  ─┐
S2 (storage+shadow)─┼─► S4 (L0: port+decision+recovery) ─► S5 (server) ─┬─► S6 (inspector UI) ─┐
S3 (projection)─┘                                                        └─► S7 (inbox UI)     ─┼─► S8 (bp web + build wiring) ─► M5-GATE
```

- **S1, S2, S3** independent → parallel. **S4** needs S1 (kind) + S2 (shadow/feed) + the spike. **S5** needs S2+S3+S4. **S6 ∥ S7** consume S5's contract (dev against mocks). **S8** needs S5+S6+S7.

---

## M5-S1 — `operator_decision_recorded` signed ledger event kind  **[L0 · 4-role · not auto-merge eligible]**

Trust-first: the signed surface lands before anything emits it.

**Files (the 9-file derivation — CLAUDE.md §"Adding a new event kind"):** `kind.rs` (variant + `kind_str`) · `payload/operator_decision.rs` *(new, `OperatorDecisionRecordedV1`, §4.1 shape, `#[typeshare]`, all `String`/`Option<String>`/string-enum → no `u64`)* · `payload/mod.rs` (register) · `canonicalize.rs` (`kind_to_variant` + `payload_variant_name` arms) · `bp-replay/transitions.rs` (**mandatory** no-op arm) · `bp-ledger/tests/operator_decision.rs` *(new)* · `pnpm ledger:gen` · **hand-edit** `packages/ledger-client/src/payload.ts` union · `pnpm ledger:gen-fixtures`.

**RED:** Rust round-trip + canonicalize byte-stability for `OperatorDecisionRecordedV1`; **explicitly assert `canonicalize_payload("operator_decision_recorded", 1, …)` round-trips** (guards the non-compiler-enforced `kind_to_variant` catch-all arm); TS test that the new variant **parses through the hand-edited union** (guards step 8 — also not compiler-guaranteed).
**Verify:**
```
cargo test --manifest-path native/Cargo.toml          # WHOLE workspace, NO -p (exhaustive-match safety; bp-replay has no _ catch-all)
pnpm -C <wt> exec vitest run packages/ledger-client/test
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```
**Changeset:** yes (`@buildplane/ledger-client`). **Review:** L0 4-role (impl TDD + fresh-session Opus reviewer + adversarial Codex + acceptance verifier), reviewed SHA == PR head. **Admin-merge.**

---

## M5-S2 — Storage read surface + Tier-1 acceptance-shadow  **[L2 · 2-role]**

**Files:** `packages/kernel/src/ports.ts` (extend `BuildplaneStoragePort`) · `packages/kernel/src/run-loop.ts` (**add `parentRunId?` to `InspectSnapshot.run`**) · `packages/storage/src/store.ts` (`toRun` must stop dropping `parent_run_id`; new queries; **schema migration for the acceptance-shadow**) · the M4 acceptance path (`evaluateAndRecordAcceptanceAsync`) to **write the shadow row** alongside the signed event.

**Adds:**
- `listRunsByStatus(status, { limit, cursor })` — **single aggregating query** (kill the O(N²) per-run memory-count subqueries) + cursor pagination.
- **Tier-1 acceptance-shadow:** a `runs.acceptance_outcome` column (or `run_acceptance` table) set when the M4 gate records acceptance — the only Tier-1 source for "this run passed acceptance."
- `listPendingOperatorDecisions()` — inbox feed = `status='suspended'` (Flow 1) ∪ (acceptance-shadow `passed` **with no `operator_decision_recorded` event for the run**) (Flow 3). Returns `{ runId, subject:'resume'|'merge', since }[]`.
- Surface `parentRunId` end to end (`toRun` → `inspectTarget` → `InspectSnapshot.run`).

**RED:** `listRunsByStatus('suspended')` filters + paginates; **fixture inserts a synthetic `operator_decision_recorded` row and asserts that run is EXCLUDED from the feed** (testable without S1 — the kind is a string literal); a passed-acceptance-shadow run with no decision IS included; `inspect(childRun).run.parentRunId` is non-null.
**Verify:** `pnpm -C <wt> exec vitest run packages/storage/test packages/kernel/test`
**Changeset:** yes (`@buildplane/kernel` + `@buildplane/storage`). **Review:** 2-role.

---

## M5-S3 — Extract `createInspectorProjection` to `@buildplane/kernel`  **[L2 · 2-role]**

**Type surgery, not a move (critique HIGH):** the current signature is `(snapshot: InspectSnapshotLike): InspectorProjection` where `InspectSnapshotLike` is a **loose CLI-local interface** (`formatters.ts:380`). The kernel version must accept the **strict `InspectSnapshot`** and re-express all inline subtypes (`evidencePane.evidence`, etc.) against `InspectSnapshot`'s subtypes.

**Files:** new `packages/kernel/src/inspector-projection.ts` importing `InspectSnapshot` from `./run-loop.js` (same package) — **MUST NOT define or import any `*Like` type**; re-export from `@buildplane/kernel`; `apps/cli/src/formatters.ts` imports it (behavior unchanged).
**RED:** `packages/kernel/test/inspector-projection.test.ts` (port the existing projection cases); existing CLI inspector tests stay green importing from `@buildplane/kernel`.
**Verify:** `pnpm -C <wt> exec vitest run packages/kernel/test apps/cli/test && pnpm typecheck` *(typecheck catches a silent type-widening that a `*Like` copy would mask)*
**Changeset:** yes (`@buildplane/kernel` adds an export). **Review:** 2-role.

---

## M5-S4 — `OperatorDecisionPort` + `orchestrator.recordOperatorDecision`  **[L0 · 4-role · not auto-merge eligible]**

**Tier promoted (critique L2):** S4 is the **sole writer** of the new tape fact and owns the **write-ahead ordering** relative to an irreversible side effect — tape-authoring logic, the same class as M2 `activity_started`-before-invoke and M4 `recordAcceptance` flush-before-merge. Full L0 ceremony; admin-merge.

**Step 0 (spike — pre-build resolution #2):** confirm `bp-ledger` can append to a completed run's repo-root `events.db`; choose live-session vs standalone-append for the port impl.

**Files:** `packages/kernel/src/ports.ts` (`OperatorDecisionPort` interface) · `packages/kernel/src/orchestrator.ts` (`recordOperatorDecision` + the resume reconciler arm) · `apps/cli/src/ledger-operator-decision.ts` *(new — the ledger-backed `OperatorDecisionPort` impl, reusing `spawnLedgerSubprocess`/`createTapeEmitter`/key resolution)* · `apps/cli` wiring (inject into the CLI orchestrator) · a `state.db` workspace lookup so the merge can find a retained worktree path.

**Behavior (write-ahead — the load-bearing invariant):**
1. validate run state for `subject` (optimistic; reuse `approveRun`'s throw-on-wrong-status);
2. **emit + flush** signed `operator_decision_recorded` **before** the side effect (durable record first);
3. side effect: `resume`→`approveRun`/`rejectSuspendedRun`; `merge`+`approved`→ `commitAndMergeWorkspace` on the **retained worktree** (Decision F); `merge`+`rejected`→ quarantine (no merge, preserved worktree);
4. **resume reconciler:** on startup, a decided-but-unexecuted `operator_decision_recorded` **idempotently re-drives** its side effect **exactly once** (detect existing `merge_commit`/downstream receipt → no double-merge).

**RED:** event emitted+flushed **before** the transition; **crash between flush-ack and side effect → resume completes the side effect exactly once** (no double-merge); reject-merge quarantines without merging; resume signs too (closes the unsigned-approve gap); the **integration test drives a real disk-backed retained workspace** through merge and asserts an actual merge commit **and** the signed event is present in `events.db` and **verifies under the kernel key**.
**Verify:** `pnpm -C <wt> exec vitest run packages/kernel/test test/ledger-integration` *(native binary built first; quarantine/serialize the known `process.chdir` flake)*
**Changeset:** yes (`@buildplane/kernel`). **Review:** L0 4-role; the verifier independently proves write-ahead ordering + exactly-once recovery against the **tape**, not the storage status field.

**Carry-forward from the M5-S1 adversarial-Codex pass (2026-06-22, accepted into S4 scope):** M5-S1 deliberately stores `decision`/`subject`/IDs/`merge_commit` as free `String` (matching the `acceptance_recorded` precedent); **enforcement is S4's job.** S4 MUST: (1) validate `decision ∈ {approved,rejected}` and `subject ∈ {merge,resume}` at the emitter (`recordOperatorDecision`) before emit — reject malformed values so they can never be signed; (2) validate ID shape (`run_id` matches the envelope run, `acceptance_event_id`/`admission_event_id` are real event ids, `merge_commit` is a full commit sha) before emit; (3) add a **golden canonical-bytes + sha256 hash fixture** for `operator_decision_recorded` (incl. a `rejected`/`resume` case with `None` optional fields) so byte-stability is pinned by a test, not only by CI's fixture-freshness diff; (4) the S4 ledger-integration test already drives a real signed run — assert the emitted event verifies under the kernel key and is byte-stable.

---

## M5-S5 — `packages/mission-control-server` (HTTP read+write API)  **[L2 · 2-role]**

**Files (new package, mirror `packages/ui-tui`):** `package.json` (`private:true`, `type:module`) · `tsconfig.json` (extends base, `composite:true`, references kernel+storage) · `src/{index,router,auth}.ts` · `test/*`. **Registrations (same commit):** `vitest.config.ts` `workspaceAliases += @buildplane/mission-control-server` · `scripts/published-bootstrap/stage-package.mjs` `OPTIONAL_INTERNAL_PACKAGES += '@buildplane/mission-control-server'` (**NOT** `INTERNAL_PACKAGE_ENTRYPOINTS`).

**Server:** `node:http` + a tiny typed router (no web-framework dep). Factory `createMissionControlServer({ orchestrator, operatorDecisionPort, ... })` — **receives the injected `OperatorDecisionPort` (interface only)**; tests inject mocks.
- `GET /api/runs?status=&limit=&cursor=` → `listRunsByStatus`
- `GET /api/runs/:id/inspector` → `createInspectorProjection(orchestrator.inspect(id))`
- `GET /api/status` → `getStatusSnapshot`
- `GET /api/inbox` → `listPendingOperatorDecisions`
- `POST /api/runs/:id/decision { decision, subject }` → `orchestrator.recordOperatorDecision` (**token-gated**)
- static-serve `apps/web` build output · **bind `127.0.0.1` only**; `BUILDPLANE_WEB_ALLOW_EXTERNAL=1` opt-in (warn); writes require the `~/.buildplane/web-token` bearer.

**RED:** each read endpoint returns the expected shape (mock store); `/decision` 401s without a valid token and on success calls `recordOperatorDecision` **exactly once**; default bind is loopback; **assert `OPTIONAL_INTERNAL_PACKAGES` contains the package and the `published-bootstrap-stage.test.ts` snapshot does not require its `dist`**.
**Verify:** `pnpm -C <wt> exec vitest run packages/mission-control-server/test test/workflow/published-bootstrap-stage.test.ts`
**Changeset:** follow `ui-tui` precedent (no changeset for a `private` package unless it enters the npm closure). **Review:** 2-role.

---

## M5-S6 — `apps/web` Run Inspector UI (3 panels + run list)  **[L2 · 2-role]**

**Files (new Vite SPA):** `apps/web/{package.json (vite build script),vite.config.ts,tsconfig.json (NOT a root reference),index.html}` · `src/main.tsx` · `src/panels/{EventTimeline,EvidencePane,OutcomeStrip}.tsx` · `src/RunList.tsx` · `src/api.ts` · `test/*`. Gitignore `apps/web/dist`.
**Test env:** every test file carries `// @vitest-environment jsdom` (pre-build resolution #5) — **no root `vitest.config.ts` edit**.

**Contract:** render **only** `InspectorProjection` fields (§5 source-of-truth); reuse the projection's fail-closed verdict — **no verdict logic in the UI**; render missing evidence as missing; label the timeline "storage projection" (Tier-1).
**RED:** each panel renders from a fixture `InspectorProjection`; Outcome Strip = BLOCKED for a missing-evidence fixture; timeline shows no kind outside the closed `EventKind` vocabulary. **Regression guard:** `pnpm -C <wt> exec vitest run packages/kernel/test` still green after S6 (node-env tests unperturbed).
**Verify:** `pnpm -C <wt> exec vitest run apps/web/test packages/kernel/test`
**Changeset:** no. **Review:** 2-role (source-of-truth fidelity).

---

## M5-S7 — `apps/web` Approval Inbox UI (pending feed + approve/reject)  **[L2 · 2-role]**

**Files:** `apps/web/src/{Inbox,DecisionDialog}.tsx` · `src/api.ts` (+POST) · `test/*` (each `// @vitest-environment jsdom`).
**Behavior:** list `/api/inbox` (resume vs merge, with inspector link); approve/reject posts `/api/runs/:id/decision`; **surface the optimistic-concurrency conflict** (state-mismatch) explicitly instead of silently succeeding; badge = suspended + accepted-undecided counts.
**RED:** inbox renders both flows; approve/reject calls the API with the right `{decision, subject}`; a conflict response renders an explicit error (not a success).
**Verify:** `pnpm -C <wt> exec vitest run apps/web/test`
**Changeset:** no. **Review:** 2-role.

---

## M5-S8 — `bp web` subcommand + build/CI/bootstrap wiring  **[L2 · 2-role]**

**Files:** `apps/cli/src/run-cli.ts` (`web` subcommand: **lazy-import** `@buildplane/mission-control-server`, construct + inject the ledger-backed `OperatorDecisionPort`, serve `apps/web/dist`, support `--check` no-listen self-test, `--port`, loopback default) · root `package.json` (**`build` = `tsc --build && pnpm -C apps/web build`**; add an `apps/web` `tsc --noEmit` typecheck step — **do not** add `apps/web` to root `tsconfig.json` references) · `.github/workflows/ci.yml` (ensure `vite build` runs only inside `pnpm build`, **after** both "assert no dist" steps; smoke must **not** build the web app — so neither dist glob needs changing) · `.gitignore` (`apps/web/dist`) · `test/workflow/*`.

**RED:** `bp web --check` exits 0 + binds loopback; `published-bootstrap-stage.test.ts` snapshot stays green with the server in `OPTIONAL_INTERNAL_PACKAGES`; a test asserts `apps/web` is **not** in root `tsconfig.json` references and IS covered by a `tsc --noEmit` step.
**Verify:** `pnpm -C <wt> exec vitest run apps/cli/test test/workflow/published-bootstrap-stage.test.ts` *(then the CI `verify` job is the canonical closure check)*
**Changeset:** yes if `apps/cli` surface changes. **Review:** 2-role (the bootstrap/CI/dist trap is the risk).

---

## M5-GATE — milestone gate receipt  **[L3 · self]**

`docs/operations/2026-06-__-m5-gate-receipt.md`: per-slice ledger (PR#, merge SHA, green CI run, review verdict + tier); resolved forks (A–G); **deferred-open items the M6 plan MUST decide** — `result_ready` tape event (was deferred, not removed from the v0.5 demo), Tier-2 signature read-back, web plan-admit (Flow 2), SSE/live-push; SC1/SC4 evidence. **Verify:** `ls docs/operations/*m5-gate*.md`.

---

## Net change vs the first draft (audit trail)

- S4 promoted **L1+adversarial → L0 4-role**; added `OperatorDecisionPort`, worktree retention (F), crash-recovery reconciler, ledger-append spike.
- S2 gained the **Tier-1 acceptance-shadow** (+ M4-path write) and explicit `run-loop.ts`/`toRun` `parentRunId` work.
- S3 reframed as **type surgery** (strict `InspectSnapshot`, no `*Like`) + `typecheck`.
- S5 server takes the **injected port**; bootstrap snapshot is a concrete RED.
- S6/S7 pinned to **per-file jsdom annotation** (true parallelism, no root-config churn).
- S8 pinned the **`pnpm build` vite ordering**, `apps/web`-not-a-tsc-reference, and the published-bootstrap test path.
- §3.1 ledger-scoping **factual correction** (repo-root, persists; only the worktree is torn down).
- Loop `SPEC.md` **HUSKY=0 contradiction fixed** (fresh-subagent gate, aligns with `WORKFLOW.md`).
