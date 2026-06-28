# M5-GATE — Web Mission Control milestone gate receipt

> Evidence packet closing **Milestone M5 (Web Mission Control)**. M5 delivers the operator-facing
> approval inbox + run inspector over the signed tape: a new signed L0 `operator_decision_recorded`
> event kind, the orchestrator `recordOperatorDecision` write-ahead+recovery path, a storage read
> surface, an injected `OperatorDecisionPort`, a `node:http` mission-control server, the `apps/web`
> SPA, and the `bp web` subcommand. This receipt records the per-slice ledger, the resolved design
> forks (A–G), the deferred-open items the **M6** plan MUST decide, and the SC1/SC4 evidence.

## Milestone identity

- **Milestone:** M5 — Web Mission Control
- **Base:** `252f7c5` (M4-GATE)
- **Spec:** `docs/superpowers/specs/2026-06-21-m5-mission-control-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-21-m5-web-mission-control.md`
- **Completed at:** 2026-06-28
- **Loop success condition:** SC1 (all M5-S* merged with recorded merge SHAs, CI `verify`+`Analyze`
  green at each, this receipt exists) + SC4.

## Per-slice ledger

| Slice | Surface / tier | PR | Merge SHA | CI | Review verdict |
|---|---|---|---|---|---|
| **S1** `operator_decision_recorded` signed ledger event kind | L0 · 4-role | rode in on #200 (ratify-in-place) | `a5de446` | green | PASS — retroactive L0 4-role (Opus reviewer 11/11 + adversarial Codex + acceptance verifier); receipt `docs/operations/2026-06-23-m5-s1-slice-receipt.md`. Re-build would collide on a duplicate `EventKind` variant, so ratified in place. |
| **S2** storage read surface + Tier-1 acceptance shadow | L2 · 2-role | #202 | `716b8db6` | green | PASS |
| **S3** extract `createInspectorProjection` to `@buildplane/kernel` | L2 · 2-role | #203 | `676ecdae` | green | PASS |
| **S4** `OperatorDecisionPort` + `orchestrator.recordOperatorDecision` (write-ahead emit + crash-recovery reconciler) | L0 · 4-role | #205 | `6e6cf644` | green | PASS — full L0 ceremony; 3 repair rounds (double-merge idempotency, crash-recovery, passed-status merge eligibility) before PASS |
| **S5** `packages/mission-control-server` (`node:http` read+write API, injected port) | L2 · 2-role | #207 | `4efaf528` | green | PASS |
| **S6** `apps/web` Run Inspector UI (3 panels + run list) | L2 · 2-role | #208 | `52ad7836` | green | PASS |
| **S7** `apps/web` Approval Inbox UI (pending feed + approve/reject) | L2 · 2-role | #209 | `72c8dc18` | green | PASS |
| **S8** `bp web` subcommand + build/CI/bootstrap wiring | L2 · 2-role | #210 | `20e0a7e` | green (`verify` 9m + `Analyze` + `verify-wrong-node`) | PASS — independent Opus reviewer (no CRITICAL/HIGH) + acceptance verifier (8/8); LOW redundant-port finding fixed in-PR; receipt `docs/operations/2026-06-28-m5-s8-slice-receipt.md` |
| **S4b** operator-decision **resume** ledger-integration coverage (SC1(2a) Flow-1) | L3 · test-infra | #212 | `a394bc5` | green (`verify` + `Analyze`) | PASS — closes the SC1(2a) resume-path gap the M5-GATE adversarial verification surfaced before this gate landed: real signed `events.db` + native binary, 2 cases (kernel-signed `subject=resume` decision + exactly-once crash-recovery on resume); test-only, no production change (the resume side effect + reconciler shipped in S4) |

## Resolved design forks (A–G)

- **A — one signed L0 kind.** `operator_decision_recorded` covers approve/reject × merge/resume. `result_ready` **deferred** (feed is derived). *(S1, S4)*
- **B — inbox scope.** Flow 3 (post-acceptance MERGE) ∪ Flow 1 (suspended-run RESUME), unified under `recordOperatorDecision`. Flow 2 (web plan-admit) **deferred**. *(S2 feed, S4 emit, S7 UI)*
- **C — defer Tier-2 signature display to M6+.** No TS read-back path; signature authenticity is the external verifier's job (`scripts/verify-signed-tape.mjs`). The timeline renders the Tier-1 storage projection, clearly labeled. *(S6)*
- **D — package shape.** `packages/mission-control-server` (→ `OPTIONAL_INTERNAL_PACKAGES`, lazy-imported by `bp web`) + `apps/web` Vite SPA + `bp web` subcommand; `node:http`, no new web-framework dep. *(S5, S6, S7, S8)*
- **E — bind/auth.** Loopback-only bind + `~/.buildplane/web-token` bearer on write endpoints; `BUILDPLANE_WEB_ALLOW_EXTERNAL=1` is an explicit, warned opt-in to bind beyond loopback. *(S5, S8)*
- **F — worktree retention.** Accepted-but-undecided runs retain their git worktree (or merge off the committed branch ref) so the deferred Flow-3 merge has something to merge. *(S4)*
- **G — injected `OperatorDecisionPort`.** Interface in `packages/kernel`, ledger-backed impl in `apps/cli` (reusing `spawnLedgerSubprocess`/`createTapeEmitter`), injected into the CLI orchestrator and the `bp web`-launched server. No subprocess/native code moves into any package; the server receives only the interface. *(S4, S5, S8)*

## Deferred-open items the M6 plan MUST decide

1. **`result_ready` tape event** — deferred (Decision A), NOT removed from the v0.5 demo (demo steps 9–10). M6 must decide whether the demo needs the explicit signal or keeps the derived feed.
2. **Tier-2 signature read-back** — deferred (Decision C). No TS read-back path for the signed ledger; the inspector renders only the Tier-1 storage projection. M6 must decide if the demo surfaces signature authenticity in-UI (vs. the out-of-band external verifier).
3. **Web plan-admit (Flow 2)** — deferred (Decision B). The inbox covers RESUME + MERGE, not web-initiated plan admission.
4. **SSE/WebSocket live push** — MVP polls (`GET /api/status` + list). In-process EventBus push was deferred (in-process-only; not worth the coupling for v1).
5. **`bp web` is source/dev-only.** The web UI is served from `apps/web/dist` and `@buildplane/mission-control-server` is an optional (un-vendored) package, so `bp web` is not available from a published-install of the CLI (consistent with the `ui-tui` optional-package contract; error is a handled exit-1, not a crash). M6/v0.5 packaging must decide whether published web serving is in scope.

## SC1 / SC4 evidence

- **SC1(1) Run Inspector** — `packages/mission-control-server` tests assert the `/api/runs/:id/inspector`
  response equals `createInspectorProjection(orchestrator.inspect(id))`; `apps/web` component tests render
  each panel from fixture projections. *(S5, S6)*
- **SC1(2a) signed-tape evidence (both flows)** — the spec requires a `test/ledger-integration/` test
  (native binary built) driving **both** a suspended run (Flow 1 / resume) **and** a completed-accepted run
  (Flow 3 / merge) through `recordOperatorDecision` — "neither alone is sufficient." Flow 3 is covered by
  `test/ledger-integration/operator-decision-merge.test.ts`; Flow 1 by
  `test/ledger-integration/operator-decision-resume.test.ts` (added in **S4b**, #212 `a394bc5`). Each asserts
  the signed `operator_decision_recorded` lands in the repo-root `events.db` and verifies under the kernel
  key, the run reaches the expected state, and a crash between flush-ack and the side effect re-drives to
  **exactly-once**. The resume half was authored and merged **before this gate landed**, closing the gap the
  M5-GATE adversarial verification surfaced (the prior draft overstated SC1(2a) as met with the resume path
  covered only by mocked-port unit tests). *(S4, S4b)*
- **SC1(2b) HTTP-surface evidence** — the `mission-control-server` test asserts `POST /decision` calls the
  injected `OperatorDecisionPort` exactly once and is token-gated. *(S5)*
- **SC1(3) `bp web`** — `bp web --check` exits 0; the `test/workflow/published-bootstrap-stage.test.ts`
  snapshot passes; `apps/web/dist` is gitignored and `vite build` runs inside `pnpm build`. *(S8)*
- **SC4** — all M5 slices (incl. the S4b gate-prerequisite fix) merged to `main` with recorded merge SHAs
  (table above); CI `verify` + `Analyze` green at each merge. L0 slices (S1 kind, S4 emit/recovery) carried
  the full 4-role ceremony; the cross-language exhaustive-match gate (whole-workspace `cargo test`, no `-p`)
  was run for the kind addition.
- This receipt exists at `docs/operations/2026-06-28-m5-gate-receipt.md` → **SC1 + SC4 satisfied.**

## Next gate

- **Next allowed action:** plan **M6** (end-to-end demo incl. crash-and-resume) + cut **v0.5.0**;
  carry the five deferred-open items above into the M6 plan.
- **Open strategic forks still unresolved (from the operating manual):** v0.5 success criteria /
  license call (MIT vs. raise-first), the dogfooding slice (build a real feature through
  `planforge admit` — blocked on the `code-edit`/`src/**` side-effect vocabulary), Run Inspector
  web UI productization bar, adversarial-Codex reviewer bar.
