# M6-GATE — end-to-end demo + v0.5.0 public cut milestone gate receipt

> **STATUS: CLOSED 2026-07-08.** Evidence packet closing **Milestone M6**: the watched
> end-to-end demo (10 steps, 3 properties, incl. crash-and-resume) plus the **v0.5.0**
> public cut (MIT license, repo→public, npm publish of the vendored artifact).

## Milestone identity

- **Milestone:** M6 — end-to-end demo + cut v0.5.0
- **Base:** `257c1cd` (M5-GATE, #211)
- **Spec:** `docs/superpowers/specs/2026-06-29-m6-v05-demo-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-29-m6-v05-demo.md`, amended by
  `docs/superpowers/plans/2026-07-01-m6-completion-and-improvements.md` (its completion
  ledger rides this receipt's commit)
- **Demo runbook:** `docs/operations/2026-07-02-m6-demo-runbook.md`
- **Completed at:** 2026-07-08 — `buildplane@0.14.0` published to npm (15:24Z), repo flipped
  PUBLIC, GitHub release **v0.5.0** cut at `4b1c065` and marked latest

## Per-slice ledger

| Slice | Surface / tier | PR | Merge SHA | Review verdict |
|---|---|---|---|---|
| **S1** `riskClass` on validate/preview (planDigest rotated, idempotencyKey unchanged) | L2 | #215 | `2ce5e9d` | PASS |
| **S2** `bp goal "<text>"` CLI | L2 | #222 | `c71628d` | PASS |
| **S3** toy Express demo-repo fixture | L3 | #213 | `4b9671c` | PASS |
| **S4** `code-edit` side-effect → `native/crates/**` globs | L2 | #214 | `18bccd0` | PASS — surfaced the `globIsSubset` wildcard-middle admission blocker |
| **S5** repoint `docs/roadmap.json` to the M6 `result_ready` slice | L3 | #225 | `1c15787` | PASS |
| **S6 pre-flight** fixtures diff-scope + `--model` threading | L2 | #227 | `ba49394` | PASS |
| **S6** `result_ready` signed L0 event kind (ceremony-build) | **L0 · 4-role** | #235 | `b197580` | PASS — unanimous 4-role; live dogfood attempts 2/3 terminated honestly on the tape (worker permission gap, then budget); ceremony-build fallback per plan §7/SC3; +1 docs-only vocabulary line `8393334` |
| **S7** emit `result_ready` + `run_completed` write-ahead at terminal (amended: gated on terminal outcome) | **L0 · 4-role** | #237 | `fb96406` | PASS after one repair round (ceremony additionally closed an emit-after-marker durability hole); rebased head byte-identical to ceremony SHA `e24304e` |
| **S8** per-tool-call tape events from the claude stream (`ToolRequestStoredV1`/`ToolResultV1`) | L1 | #220 | `96c866e` | PASS |
| **S9** declarative `netEgress` allowlist (bundle + plan mapping; no enforcement) | L2 | #223 | `7c77a39` | PASS |
| **S10** `capability_denied` e2e + out-of-scope quarantine fixture | L3 | #218 | `f324145` | PASS — no enforcement bug found |
| **S11** crash-injection guard (`BUILDPLANE_CRASH_AFTER_ACTIVITY`) + crash-resume ledger-integration test | L2 | #224 | `02ad88d` | PASS — exactly-one `plan_receipt` |
| **S12** 10-step demo runner + operator runbook | L2 | #236 | `8657730` | PASS |
| **S13** MIT license + v0.5.0 public cut wiring | L2 | #238 | `a22712f` | PASS — `gsd2` bin dropped (O5); state-aware release-cut test fixed post-merge via #240 fallout |
| **O6** publish vendored staged artifact (`publish-npm.mjs`) | L2 | #239 | `a15d9ec` | PASS — closes the `workspace:*` unvendored-publish defect S13 review found |
| **R1–R7** improvement slices (dispatch-error terminal reason + loop `--reset` · `recoverPendingDecisions` startup wiring · mission-control host/origin allowlist · generated-TS freshness CI gate · broker enforcement-scope doc · docs hygiene · worker permission grant + timeout threading + reset re-seed) | L1–L3 | #228 #232 #234 #231 #230 #229 #233 | `eb7b2ec` `0f1b42e` `790ff11` `9ec2bda` `430f482` `1fbacf4` `9075722` | PASS each |
| **Version 0.13.0** (15 changesets consumed; manual stand-in for the token-blocked changesets action) | release | #240 | `3edbd99` | PASS |
| **Dependency security bumps** (ws runtime-high, vite, js-yaml; esbuild LOW deliberately skipped) | chore | #241 | `236dddf` | PASS — open dependabot alerts 8 → 1 |
| **Demo watched-run fixes** (runner stages temp repo + stamps trusted base; web-token mechanics; dispatch worker flags) | L2 | #242 | `74dc5f1` | PASS |
| **F1** fail-closed `planforge resume`/`recover` (gate-finding fix) | **L0-adjacent · 4-role-style** | #244 | `3c0c348` | PASS — adversarial reviewer CONFIRMED one HIGH (same-digest acceptance evidence was fungible; repaired via consume-once multiset `231fe1b` + regression test, re-review clean); acceptance verifier 7/7 after `2419e05`; merged after final review |
| **F2** per-tool-call tape events on the dispatch path (gate-finding fix) | L1 · 2-role | #243 | `e7b6af6` | PASS — verifier 5/5, zero review findings |
| **Release-infra fix** publish tag creation + already-published skip guard | L3 | #248 | `4b1c065` | PASS — 12/12 workflow tests (RED→GREEN), registry guard verified live, skip path proven green on the merge push |

## Watched demo evidence (LOCKED operator-watched gate — executed 2026-07-03)

- `node scripts/run-demo.mjs` ran the full **10 steps** against a staged temp target repo
  (seed SHA stamped into `goal.md`'s `Trusted base:`; `bp init`; dispatch with the R7
  `--worker-allowed-tools` grant + `--worker-timeout-ms`; step-10 merge decision via
  `POST /api/runs/<id>/decision` with the `~/.buildplane/web-token` bearer).
- **Property 1 (crash-and-resume):** demonstrated via `BUILDPLANE_CRASH_AFTER_ACTIVITY=1` +
  `planforge recover`. The watched run surfaced that recovery was **receipt-grade, not
  pipeline-grade** (fail-open class) — recorded gate-level finding **F1**, fixed in #244:
  resume/recover now enforce acceptance on the re-executed suffix, fail-close recorded work
  lacking a consumable signed `acceptance_recorded` verdict (`acceptance-not-evaluated`),
  reconcile storage `running` rows at terminal, and emit `result_ready`/`run_completed` on
  the executed suffix. Runbook Property-1 narration updated in #244.
- **Property 2 (capability broker):** the S10 e2e test — real broker over a real signed tape;
  honest scoping per `docs/architecture/capability-broker.md` §"Enforcement scope"
  (fail-closed `write_file`/`run_command` on command-executor packets; model workers are
  constrained by M4 post-hoc diff-scope + acceptance).
- **Property 3 (tape verifiability):** `ledger export-signed-tape` then
  `scripts/verify-signed-tape.mjs --fixture <dir>` — proves consistency (trusted keys are
  tape-embedded; third-party authenticity is out of scope by design).
- Second demo-surfaced gate finding **F2** (step 7 showed activity bracketing only — the
  dispatch path never wired the S8 per-tool-call sink) fixed in #243.

## Deferred-open items from M5 — how M6 resolved them

1. **`result_ready` tape event** — **implemented** (S6 kind #235 + S7 terminal-outcome-gated
   emit #237, with `run_completed`; A3 = per-field string on `RunCompletedV1`, no U64 hazard).
2. **Tier-2 signature read-back** — **still deferred**; the demo surfaces authenticity via the
   external verifier (Property 3), not in-UI.
3. **Web plan-admit (Flow 2)** — **still deferred**.
4. **SSE/live push** — **still deferred** (the fetch-on-load MVP stands; *corrected
   2026-07-08* — this receipt originally said "poll-based MVP", but the web UI has never
   polled: it fetches once on load plus user-triggered refreshes).
5. **Published-install web serving** — **still deferred**; `bp web` remains source/dev-only
   (*corrected 2026-07-08* — at gate time the published-install failure exited 1 only via
   the generic top-level CLI error path, printing a raw module-not-found message; the
   explicit, tested fail-closed contract — source-checkout guidance + staged-install
   assertion in `verify-positive.mjs` — shipped post-gate in the honesty patch).

## Known limitations disclosed at this gate (R6 honesty items)

- **Adversarial-Codex reviewer benchmark: 43.75%, measured against a deterministic local
  stub** (reviewer-rescue, 4 fixtures) — the real Codex CLI has never been benchmarked
  (`BUILDPLANE_EVAL_MODEL=1` never run), so the number characterizes the stub harness, not
  Codex. The adversarial-Codex role remains an internal review aid, not a README front
  door, until it clears an agreed bar.
- **Broker enforcement scope** is command-executor-only (see Property 2 above); extending to
  the model-worker tool surface is post-v0.5 backlog.
- **Recorded-prefix runs get no synthetic `result_ready` on resume** (deliberate — their
  evidence is the signed `activity_completed` + consumed `acceptance_recorded`; documented in
  #244 and `docs/operations/2026-07-03-m6-f1-receipt.md`).
- **Resume-path per-tool-call sink** not wired (dispatch-only in #243); follow-up slice after
  the v0.5.0 gate.
- **Dogfooding reframe** remains an open strategic fork: the `globIsSubset` wildcard-middle
  admission blocker (S4) still gates a genuine `planforge admit` code-edit dogfood.

## Operator ledger (gate-closing actions)

| Item | Status |
|---|---|
| O1 `RELEASE_TOKEN` PAT | DONE 2026-07-08 — fresh fine-grained PAT set (14:40Z); the failed release run re-ran green, and version PR #247 opened **with its required checks triggering** (the dead-token failure mode — PAT-authored pushes with no CI — is gone) |
| O2 `NPM_TOKEN` secret | DONE 2026-07-08 — set (14:49Z); the fail-loud guard passed on the release-landing push |
| O3 secret scan (gitleaks, full history, 1001 commits, 0 findings) | DONE 2026-07-02 · re-scanned 2026-07-08 across **all refs** (gitleaks 8.24.3, incl. `prototype-main`): no leaks |
| O3b repo→public flip | DONE 2026-07-08 — repo PUBLIC; **0** open dependabot alerts at the flip; stale `prototype-main` branch deleted (its classic branch protection removed first) |
| Merge #242 / #243 / #244 | DONE — #242 `74dc5f1`, #243 `e7b6af6`, #244 `3c0c348` |
| Publish + tag **v0.5.0** (release.yml re-run publishes the vendored artifact) | DONE 2026-07-08 — version PR #247 (`587a9fe`, buildplane 0.13.0→0.14.0, 5 changesets) merged; `buildplane@0.14.0` published 15:24:13Z (runner Rust toolchain sufficed for `pnpm native:build`). The run then failed post-publish: the publisher printed `New tag:` without creating the git ref, so the action's tag push died — tag + GitHub release `buildplane@0.14.0` repaired manually; defect fixed in #248 (`4b1c065`: idempotent `git tag` + already-published registry skip, proven live green on its own merge push). GitHub release **v0.5.0** cut at `4b1c065`, marked latest |

## Next gate

- **Next allowed action:** post-v0.5 planning — carry forward: resume-path tool sink,
  `globIsSubset` + code-edit side-effect vocabulary (dogfood unblocking), broker enforcement
  on the model-worker surface, Tier-2 signature read-back, web plan-admit, SSE push,
  published web serving, memory-program unfreeze decision (`run_outcomes` → M4 trust scoring).
- **Open strategic forks still unresolved:** v0.5 success criteria; Run Inspector
  productization bar; adversarial-Codex reviewer bar.
