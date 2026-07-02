# M6 — v0.5 Killer Demo + MIT Release — Design

**Date:** 2026-06-29
**Milestone:** M6 — end-to-end vertical-slice demo (incl. crash-and-resume) + cut **v0.5.0**
**Base:** `257c1cd` (M5-GATE, `main` tip)
**Plan:** [`docs/superpowers/plans/2026-06-29-m6-v05-demo.md`](../plans/2026-06-29-m6-v05-demo.md)
**Source of truth for the demo:** [`docs/superpowers/specs/2026-05-21-buildplane-v05-design.md`](./2026-05-21-buildplane-v05-design.md) §7 ("Vertical slice — the v0.5 killer demo").
**Carries:** the five deferred-open items from [`docs/operations/2026-06-28-m5-gate-receipt.md`](../../operations/2026-06-28-m5-gate-receipt.md).

> Conventions (CLAUDE.md): TDD RED→GREEN→commit · slice verify `pnpm -C <worktree> exec vitest run <paths>` (NEVER `pnpm --filter buildplane test`) · whole-workspace `cargo test --manifest-path native/Cargo.toml` (NO `-p`) for any ledger change · FF from `origin/main` before each branch · conventional **lowercase-verb** commits · changeset only when a **published** `packages/*`/`apps/*` surface changes · published-bootstrap closure for any new `packages/*` dep imported by `apps/cli` · route every push/PR through a FRESH subagent (WSL biome OOM) · CI `verify` is canonical.

---

## 1. Goal

Prove v0.5 is real by shipping the §7 killer demo end-to-end and cutting a genuine public **v0.5.0** under MIT. The demo runs the goal `bp goal "Add rate limiting to /api/login: max 5/min per IP, return 429 with Retry-After."` against a toy Express repo through the full admission→dispatch→execute→acceptance→merge cycle, and demonstrates three properties — **Replay/crash-resume**, **Policy enforcement**, **Signed receipts** — over a signed, externally verifiable tape.

The milestone is **trust-first sequenced** as always: the one net-new L0 surface (`result_ready`) lands through the full 4-role ceremony before anything emits or consumes it, and that surface is **dogfood-built through Buildplane's own admission loop** so the demo's own missing piece carries the story "the last feature of this tool was built and verified by this tool."

---

## 2. Hybrid framing (LOCKED)

The M6 deliverable is **two coordinated runs**, not one:

- **(a) The clean demo run** — `bp goal "Add rate limiting…"` on a fixed, reproducible **toy Express repo** fixture, exercising the §7 ten-step mechanics and all three properties. This is the reproducible artifact a viewer can re-run; it is the demo.
- **(b) The dogfood run** — `bp planforge loop --once` on the **Buildplane repo itself**, goal = build the `result_ready` event kind (the demo's own deferred piece). The worker produces the L0 derivation as a PR; the operator runs the full L0 4-role ceremony around it and merges. This makes the demo's missing step-9 signal a thing Buildplane built about itself.

Both are **operator-watched live runs** (see §8 live-run gate). The dogfood run merges `result_ready` *before* the demo run needs it at step 9.

---

## 3. The ten steps mapped to current build-state

Ground truth = the readiness audit. Per step: BUILT / PARTIAL / GAP, and the M6 work.

| Step | Demo action | State | M6 work |
|---|---|---|---|
| **1** | `bp goal "<text>"` | **GAP** | New top-level CLI command (M6-S2): raw goal string → auto-detect `trustedBase` via `git rev-parse HEAD` → synthesize PlanForge markdown → compile→validate→preview→JSON; register in `bp help`. |
| **2** | compile output: plan digest, trusted base, missing evidence, **risk class** | **PARTIAL** | `planDigest` (BUILT), `trustedBase` (BUILT, operator-supplied → now git-auto in S2), `missingEvidence` (BUILT). **`riskClass` is GAP** → new field on `PlanForgeValidation`/`PlanForgePlan` (M6-S1) with a defined rubric. |
| **3** | plan rendered in web Mission Control | **GAP→Option B** | Plan reviewed in the terminal (`bp goal` JSON output incl. risk class). Web inspector displays the run once dispatched. No new server route/component (see §5, Decision 3). |
| **4** | operator adjusts budget, clicks "Admit" | **GAP→Option B** | `bp planforge admit --input goal.md --approve --operator <id>` records the signed `plan_admitted` event (BUILT). Demo narrates step 4 as the CLI admit, not a web click. |
| **5** | admission recorded as signed event; bundle finalized | **BUILT** | `plan_admitted` signed by the kernel key; capability bundle finalized (M2/M3). No new work. |
| **6** | worker in fresh worktree; writable `src/`+`test/`; tools `Read/Write/Edit/Bash`; **net-egress = NPM only** | **PARTIAL** | Worktree isolation (BUILT); `code-edit` fs_write globs (BUILT). **Net egress is a complete GAP** → declarative `netEgress` bundle field + honest demo scoping (see §5, Decision 3 net-egress). |
| **7** | each `Edit`/`Bash` tool call → tape event, policy-checked | **GAP (model worker)** | Command-packet tool calls already tape-event + policy-check (BUILT). The Claude model worker bypasses the kernel ToolRegistry → per-tool-call tape events GAP → M6-S8 parses `stream-json` `tool_use`/`tool_result` into existing `ToolRequestStoredV1`/`ToolResultV1` events (no new L0 kind). |
| **8** | completion record validated against Acceptance Contract (diff-scope + CI + lint) | **BUILT** | `evaluateAndRecordAcceptanceAsync` + signed `acceptance_recorded` (M4). No new work. |
| **9** | kernel emits a **`result_ready`** event; operator sees it in the inbox | **GAP** | New signed L0 `result_ready` kind (M6-S6, dogfood-built) + write-ahead emit at finalization (M6-S7). Inbox feed stays **derived** and `result_ready` **coexists** (see §5, Decision 1). |
| **10** | operator clicks "Merge"; signed approval; merge; **final outcome event** | **PARTIAL** | Merge path + signed `operator_decision_recorded` (BUILT, M5). The **final outcome event on the tape is GAP** → emit signed `run_completed` (`RunCompletedV1` struct exists; new signing path only) write-ahead at the merge boundary (M6-S7). |

---

## 4. The three properties — how each is staged/demonstrated

### Property 1 — Replay / crash-resume
**State: PARTIAL.** `bp planforge recover` is fully built + tested (`planforge-recover.test.ts`, `crash-replay.test.ts` at three boundaries). The loop supervisor does **not** auto-recover on restart (explicit comment: a mid-iteration crash "re-runs the whole iteration").
**Demo staging:** the demo shows **explicit `bp planforge recover`** — operator kills the kernel between steps 7 and 8, restarts, runs `bp planforge recover`, the tape is replayed, the completed activity is reused (never re-invoked), execution resumes at step 8, final state identical. We do **not** put the loop auto-recover hook on the demo critical path (lower risk).
**M6 work:** a deterministic **crash-injection hook** gated behind the **`BUILDPLANE_CRASH_AFTER_ACTIVITY=1` environment variable** (NOT a named CLI flag, M6-S11) so the demo runner can reliably SIGKILL the kernel right after an `activity_completed` lands without publishing a test-only flag in the CLI argument surface (no semver bump, no demo-artifact leak); plus an integration test asserting exactly one `plan_receipt` and no re-execution after recover.

### Property 2 — Policy enforcement
**State: PARTIAL.** Command-packet tool calls are enforced through the kernel ToolRegistry (`evaluateToolInvocation` → deny + `quarantine:true`) and emit a signed `capability_denied` event (BUILT). The Claude model worker spawns as a subprocess and **bypasses** the ToolRegistry; hard enforcement of its native `write_file`/`Bash` against the bundle is **not implemented** and the subprocess spawn model has no mid-stream interception.
**Demo staging:** Property 2 is demonstrated against a **command packet** (the real M3 enforcement boundary) carrying `fsWrite=['src/**','test/**']` that attempts a write to `docs/out-of-scope.txt` → deny → signed `capability_denied` quarantine event visible on the tape. This is the honest, enforced path. Soft enforcement for the Claude worker (system-prompt + `--allowed-tools` injection) is **best-effort additive only** (M6-S8 optional sub-task), never the property-demonstrating path.
**M6 work:** an **end-to-end integration test** (real native binary, real emitter — the gap the audit found: 0 matches for `capability_denied` in `test/ledger-integration/`) asserting a command-packet out-of-scope write produces a signed `capability_denied` row in `events.db` (M6-S10); + the demo quarantine fixture.

### Property 3 — Signed receipts
**State: BUILT.** `scripts/verify-signed-tape.mjs` (200 lines, `node:crypto` only) verifies per-event Ed25519 signatures + tape-root checkpoint hashes, exit 0 iff all verify; 5 test cases cover valid/tampered/bad-root/bad-sig/missing-key.
**Demo staging:** the final demo step exports the toy-repo tape after the live run and runs `node scripts/verify-signed-tape.mjs --fixture <dir>` → exit 0. No code gap; operator staging only.
**Honesty note:** the §7 spec says "50-line script"; the real verifier is 200 lines — the demo narrative acknowledges this cosmetic mismatch. The verifier proves **consistency** (tape-embedded trusted keys), not third-party authenticity — already documented.

---

## 5. Decisions on the five deferred items

### Decision 1 — `result_ready`: NEW signed L0 kind, dogfood-built, **coexists** with the derived feed
`result_ready` is added as a real signed L0 event kind via the full nine-file derivation, and it is the **designated dogfood target** (built by `bp planforge loop --once` on the Buildplane repo, then L0 4-role reviewed). It is emitted **write-ahead** at finalization (when acceptance passes + receipt recorded), giving demo step 9 a real tape backing and giving the external verifier a signature to check.

**The inbox feed stays DERIVED and `result_ready` COEXISTS (does not replace it).** Rationale: the M5 inbox query (`acceptance_outcome='passed'` Tier-1 shadow ∧ no `operator_decision_recorded`) works today; rewriting it to be `result_ready`-driven on the demo critical path is unnecessary risk. `result_ready` is an **additive** canonical tape signal that the demo narrative and the verifier read; a later (post-v0.5) slice MAY switch the feed to a Tier-2 `result_ready` read-back. For v0.5: derived feed + coexisting signed event.

**Payload `ResultReadyV1`** (all `String`, no `u64`): `{ runId, admissionEventId, acceptanceEventId }`.

**Pre-build resolution 1a — `ResultReadyPort` design (lock before S7 is dispatched).** Create a **new `ResultReadyPort`** (one method: `recordResultReady(runId, admissionEventId, acceptanceEventId): Promise<void>`) injected alongside the existing `acceptancePort`. Rationale: single-responsibility — the acceptance port records audit evidence; the new port records the canonical readiness signal. Do **not** extend `BuildplaneAcceptancePort.recordAcceptance` to also emit `result_ready` (that couples acceptance evidence with the tape signal). The concrete emitter mirrors `apps/cli/src/ledger-operator-decision.ts`; wire it in `apps/cli` at the same site as the `acceptancePort` injection.

**Pre-build resolution 1b — `run_completed` field source (lock before S7 is dispatched).** The `RunCompletedV1` fields are supplied **synchronously** from the already-loaded `snapshot = storage.inspectTarget(runId)` return value at the merge boundary — **option (a)**: `duration_ms = Date.now() - run.createdAt`, `event_count` from a synchronous SQL `COUNT`, `unit_count` from the snapshot. This makes the async promotion of `applyOperatorDecisionSideEffect` **unnecessary** and avoids any behavioral change to the D2–D4 crash-recovery marker ordering. We explicitly reject **option (b)** (a new async storage query forcing a two-site `await` addition at `orchestrator.ts:2166` and `2178`), because that would change the contract of the hot crash-recovery path and must not be folded into S7 silently.

### Decision 2 — Tier-2 signature read-back: **deferred / out-of-band** (no in-UI signature display)
The web UI does **not** surface in-UI signature read-back for v0.5. Signature authenticity is the **external verifier's** job (Property 3) — the demo's "signed receipts" property is demonstrated out-of-band by `verify-signed-tape.mjs`, not in Mission Control. The inspector continues to render the clearly-labeled Tier-1 storage projection. (Carries M5 Decision C.)

### Decision 3 — Web plan-admit (Flow 2): **Option B — CLI admit + web display**
The operator reviews the compiled plan in the **terminal** (`bp goal` / `bp planforge dry-run --json`, now including risk class) and admits via **CLI** (`bp planforge admit --approve`). The web Mission Control **displays** the resulting run in the inspector; the web **click** in the demo is the step-10 **Merge** (which IS built, M5). This requires **zero** new server routes or web components for admission. Justification: Option A (full web Flow 2) needs a pending-plan storage concept, three new server routes, a `PlanReview` component, and `App.tsx` routing — 4–6 units across server/kernel/web with a non-trivial schema addition, all on the demo critical path. Option B collapses steps 3–5 to a CLI interaction with web monitoring; the demo script is adjusted to narrate "runs admit" rather than "clicks Admit." This does not demonstrate the full web admission surface — an explicit, accepted scope cut for v0.5.

**Net-egress (step 6) sub-decision — scope honestly:** net-egress enforcement is a **complete GAP** (zero code; `--restricted-network-access` is an unverified Claude-CLI flag at the subprocess level). For v0.5 the demo does **not** claim enforced egress allow-listing. M6-S9 adds a **declarative** `netEgress` field to the capability bundle + PlanForge mapping so the allowlist is **visible** in the admitted plan and on the tape (consistent with `docs/architecture/capability-broker.md`, which already marks `net_egress` schema/validate-only). The demo narrates egress as "declared in the bundle; enforcement is v1." M6-S9 includes a **spike** to verify the Claude flag; only if it verifies does a follow-on real-enforcement sub-slice ship — otherwise the honest declarative scope holds.

### Decision 4 — SSE / live push: **polling is sufficient for v0.5**
The web MVP keeps **polling** `GET /api/status` + list. A short poll interval is adequate for the operator-watched demo; in-process EventBus push is deferred (in-process-only, not worth the coupling for v1). (Carries M5 Decision / deferred item #4.)

### Decision 5 — published web serving / `bp web`: **source/dev-only for v0.5.0**
The demo runs from the **monorepo source** (`pnpm build` builds `apps/web`). We do **not** vendor `apps/web/dist` or make `@buildplane/mission-control-server` non-optional for the npm package. The v0.5.0 npm artifact ships the **CLI without web serving** (the `bp web` published-install error stays a handled exit-1, consistent with the `ui-tui` optional-package contract). The demo setup documents a "run from source" step. This bounds packaging scope. (Carries M5 deferred item #5.)

---

## 6. The MIT release + v0.5.0 packaging plan

**LOCKED: MIT now.** Concrete scope grounded in what the repo's changesets/CI/package.json currently support:

- **LICENSE** — add a real `LICENSE` (MIT) file at repo root. (The Rust workspace already declares `license = "MIT"` in metadata but no file exists; npm + changesets also need the file.)
- **changesets** — flip `.changeset/config.json` `access` from `restricted` → `public`.
- **publishable surface** — remove `"private": true` from **`apps/cli/package.json`** only (the single publishable artifact = the `buildplane` CLI). The 14 internal `@buildplane/*` packages stay `private` (they are not independently published; the native binary is bundled into the CLI tarball by `stage-package.mjs`).
- **release CI** — add a publish step to `.github/workflows/release.yml` (`changesets/action@v1` `publish: pnpm exec changeset publish`); wire `NPM_TOKEN`. Feed a **`RELEASE_TOKEN`** PAT to `actions/checkout` + the changesets step (`|| secrets.GITHUB_TOKEN` fallback) — `GITHUB_TOKEN`-authored release PRs never re-trigger CI (anti-recursion).
- **GitHub Release** — cut a `v0.5.0` tag at the merged version-bump SHA; attach `scripts/published-bootstrap/install.sh` as a release asset so the curl-pipe installer works without npm.
- **cargo publish** — **out of scope** for v0.5.0 (explicit decision, not a gap): the native binary ships inside the npm tarball (`stage-package.mjs` packages the linux-x64 binary). No `cargo publish` CI job.
- **platform scope** — the bundled native binary is **linux-x64 only**; macOS/Windows users source-build. v0.5.0 ships linux-x64 prebuilt; a multi-platform native matrix is deferred. The installer/README states this.
- **v0.5.0 version coordination** — the CLI is currently `0.12.2`. "v0.5.0" is the **release/tag** name (the demo + public-cut milestone), not necessarily the CLI's semver. Two acceptable resolutions, decided at release time: (a) tag the GitHub release `v0.5.0` while the npm package keeps its changeset-driven semver (≥0.12.x); or (b) if a literal `buildplane@0.5.0` npm version is wanted, that is a **downgrade** from 0.12.2 and npm forbids re-publishing/lowering — so (a) is the default. **Default = (a): `v0.5.0` is the milestone/GitHub-release tag; npm semver continues from changesets.** Flagged to the operator (§9).

---

## 7. The live-run gate (build-then-watch)

**LOCKED: the first live autonomous worker execution happens with the operator watching.** Therefore M6 build work **must NOT autonomously trigger a live Claude worker run.** All M6 slices either (a) are hand-built staging/enabler/test code, or (b) **stage** a live run that the operator triggers. Two live runs are operator-gated:

1. **Dogfood run** (M6-S6) — `bp planforge loop --once` building `result_ready`. Prerequisites are all staged by earlier slices + operator items (kernel key, signed envelope, native prebuild). The operator triggers and watches; the worker's PR then goes through L0 4-role ceremony.
2. **Demo run** (M6-S12) — `bp goal "Add rate limiting…"` on the toy repo. The runner script stages every step; the operator triggers and watches.

**Dogfood fallback:** if the dogfood worker fails the L0 derivation (context size / wall-clock — audit risk), after a bounded retry the operator/principal hand-builds `result_ready` via the normal L0 ceremony so the demo is unblocked; the dogfood attempt is still recorded in the gate (story degrades to "attempted + completed by ceremony," not "lost"). Mitigations baked into the roadmap slice: explicit step-by-step derivation objective, `--max-turns 40`, `--wall-clock-ms 3600000`.

---

## 8. Success conditions (M6-GATE)

- **SC1 — slices landed.** Every `M6-S*` slice merged to `main` with recorded merge SHAs; CI `verify` + `Analyze` green at each; the `M6-GATE` receipt exists.
- **SC2 — the demo.** The §7 ten-step flow runs end-to-end on the toy Express repo (operator-watched live run) producing a signed tape, and the three properties are each demonstrated: (P1) kill between 7–8 → `bp planforge recover` → identical final state, exactly one `plan_receipt`, no activity re-invocation; (P2) a command-packet out-of-scope write → signed `capability_denied` quarantine event on the tape; (P3) `node scripts/verify-signed-tape.mjs` exits 0 over the resulting tape.
- **SC3 — dogfood.** `result_ready` was built through Buildplane's own `planforge loop --once` admission path (operator-watched), then L0 4-role reviewed + merged — OR, if the dogfood worker failed, the recorded dogfood attempt + ceremony-built `result_ready` (the fallback path is an acceptable SC3 satisfaction with the attempt logged).
- **SC4 — release.** v0.5.0 cut: MIT `LICENSE` present, changesets `access:public`, `apps/cli` unprivate, release publish path wired, the chosen publish scope (npm publish + `v0.5.0` GitHub release + installer asset) executed.
- **SC5 — L0 ceremony.** The L0 surfaces (`result_ready` kind; `result_ready` + `run_completed` emit paths) each carried the full 4-role ceremony; the whole-workspace `cargo test` exhaustive-match gate was run for the kind addition; ledger fixtures are byte-stable (`git diff --exit-code`). **For the dogfood path specifically**, the local `planforge loop --once` merge does not create a PR, so the operator-item-6 hold step (push branch → DRAFT PR → 4-role ceremony at PR head SHA → only then approve the inbox merge) is what makes the `result_ready` L0 surface ceremony-satisfiable — SC5 is **not** met if `result_ready` lands via the bare local merge without a reviewed PR head.

---

## 9. Risks & open operator items

**Risks (mitigations in the plan):**
- **Dogfood L0 derivation under one worker context** — coordinated 8-file Rust+TS change; tight under `--max-turns`. Mitigation: explicit sequenced objective, raised turn/wall-clock caps, ceremony fallback (§7).
- **`stream-json` `tool_use` blocks (M6-S8)** — unverified that `--output-format stream-json --verbose` emits parseable `tool_use`/`tool_result`. Mitigation: spike-first; honest fallback to per-unit `activity_*` events in the step-7 narrative if it doesn't.
- **`--restricted-network-access` flag (M6-S9)** — unverified at the subprocess level. Mitigation: declarative-only scope by default; enforcement sub-slice only if the spike verifies.
- **`globIsSubset` wildcard-middle (M6-S4/S6 envelope)** — `native/crates/**/src/**` may not be a literal prefix the envelope subset check handles. Mitigation: sign the operator envelope with a simpler `native/**` glob.
- **Claude worker hard enforcement** — not feasible under the subprocess spawn model; Property 2 deliberately uses a command packet, not the Claude worker (honest scoping).
- **M5 plan_receipt tape pollution** — the planner could mis-detect M5 slices as complete/incomplete. Mitigation: `roadmap.json` → M6 scopes the planner to M6 slices only (M6-S5).

**Open operator items (need a human, not a slice):**
1. Provision the kernel Ed25519 signing key (`~/.buildplane/keys/kernel/kernel-main.ed25519`) — `bp` has no keygen; manual `openssl`.
2. Sign the M6 authorization envelope (operator decision `subject=authorize-envelope`) with a `native/**`-safe path glob set after S4/S5 land.
3. Pre-build the native binary (`pnpm native:build`) so worktree `cargo test` verification runs.
4. Configure `NPM_TOKEN` + `RELEASE_TOKEN` repo secrets before the release slice.
5. Trigger + watch the two live runs (dogfood, demo).
6. **Dogfood `result_ready` L0 ceremony — explicit hold step (CRITICAL: do NOT skip).** `bp planforge loop --once` / the inbox Merge click do a **local git merge only** (`commitAndMergeWorkspace` does **zero `git push` and creates no GitHub PR**). Because `result_ready` is an L0 surface, it MUST carry the full 4-role ceremony against a **PR head SHA** (CLAUDE.md requires "reviewed SHA == PR head") before it lands. Therefore, after the dogfood worker finishes and acceptance passes / the run appears in the inbox, and **before** clicking Merge: (1) push the worker's worktree branch to GitHub (`git push origin <worktree-branch>`); (2) open a **DRAFT** GitHub PR from that branch; (3) run the full L0 4-role ceremony (fresh-session Opus reviewer + adversarial Codex + independent acceptance verifier) on that PR head SHA; (4) **only after** the ceremony verdict is `PASS` at PR head, approve the inbox merge. Skipping this lands the L0 `result_ready` surface without ceremony and violates SC5. (Fallback path per §7 if the worker fails: ceremony-build the same derivation via a normal PR.)
7. Click Merge at demo step 10 (after step 6's ceremony has passed for the dogfood surface).
8. Confirm the v0.5.0 version-name resolution (§6: GitHub-release tag `v0.5.0` with npm semver continuing from changesets is the default).
9. Confirm linux-x64-only prebuilt native binary is acceptable for the v0.5.0 public artifact.
