# M5-S8 slice receipt — `bp web` subcommand + build/CI/bootstrap wiring

> Evidence packet for M5-S8, the final build slice of M5 (Web Mission Control).

## Slice identity

- **Slice id:** M5-S8
- **Milestone:** M5 — Web Mission Control
- **Goal:** add the `bp web` subcommand (serve the Mission Control web UI over the S5 server + S6/S7
  SPA) and the build/CI/bootstrap wiring for the `apps/web` Vite app.
- **Non-goals:** no new event kind / wire format / signing path; no published-install web serving;
  no SSE/live-push; no Flow-2 web plan-admit.
- **Operator approval scope:** "continue buildplane workflow" — autonomous build + 2-role ceremony;
  merge to `main` explicitly gated to the operator (auto-mode classifier blocked self-merge).
- **Steward / agent:** principal-driven (Opus), parallel discovery + 2-role review via subagents.
- **Completed at:** 2026-06-28

## Source of truth

- **Base branch:** `main` · **Base SHA:** `72c8dc1` (origin/main, M5-S7 tip)
- **Source docs:** plan `docs/superpowers/plans/2026-06-21-m5-web-mission-control.md` §M5-S8; spec
  `docs/superpowers/specs/2026-06-21-m5-mission-control-design.md` (Decisions D/E/G); CLAUDE.md
  §"Gotchas" (published-bootstrap closure, biome OOM), §"Build / test / run".
- **Prior prerequisite PRs verified on `origin/main`:** S5 #207, S6 #208, S7 #209 (all merged).

## Workspace

- **Worktree:** `/mnt/c/Dev/projects/buildplane-m5-s8` · **Branch:** `feat/m5-s8-bp-web`
- **Local HEAD SHA:** `48d8b22` · **Remote branch SHA:** `48d8b22`
- **`core.bare=false` verified:** yes · **Clean status before work:** yes (fresh from origin/main)

## Scope

- **Files changed (10):** `apps/cli/src/web-command.ts` (new), `apps/cli/src/run-cli.ts`,
  `apps/cli/test/web-command.test.ts` (new), `test/workflow/apps-web-build-isolation.test.ts` (new),
  `package.json`, `apps/cli/package.json`, `apps/cli/tsconfig.json`, `.github/workflows/ci.yml`,
  `pnpm-lock.yaml`, `.changeset/m5-s8-bp-web.md` (new).
- **Diff stat:** +525 / −1.
- **Added dependencies:** `@buildplane/mission-control-server` (`workspace:*`) on `apps/cli` — kept in
  `OPTIONAL_INTERNAL_PACKAGES` (lazy `import()`), so the published-bootstrap closure is unchanged.
- **Data migrations / schema / permission / deploy changes:** none.
- **Secret-shaped added lines scan:** clean (0 matches; `web-token`/`BearerTokenSource` references are
  existing API surface, not secrets).

## Verification

- **Focused tests:** `pnpm -C <wt> exec vitest run apps/cli/test/web-command.test.ts test/workflow/apps-web-build-isolation.test.ts` → **16 passed** (exit 0).
- **Area tests:** full `apps/cli/test` → 375 passed; the 3 `smoke.test.ts` `ensureBuiltCliDist`
  failures were a local stale-`.tsbuildinfo` artifact of manual `dist` cleanup (CI uses a fresh
  checkout) — re-ran after clearing `.tsbuildinfo` → **smoke 16/16 pass**.
- **published-bootstrap closure:** `test/workflow/published-bootstrap-stage.test.ts` (real `pnpm build`)
  → **110 passed** (exit 0); server stays optional, snapshot + `REQUIRED_BUILD_OUTPUTS` unchanged.
- **Typecheck:** `pnpm typecheck` (`tsc --build`) → exit 0.
- **Lint:** `biome check .` whole-repo → exit 0 (487 files; only pre-existing `spawn` unused-import
  warning, not introduced by this slice).
- **Build:** root `pnpm build` exercised by the published-bootstrap test (vite + tsc).
- **Direct CLI behavior:** `bp web --check` no-listen self-test path covered by unit tests (synthetic
  `GET /api/status` → 200); listen + graceful SIGINT close covered with an `AbortController`.

### Cross-language / digest (L0)

- **n/a — no event kind / wire-format / signing change.** S8 is CLI + build wiring. The signed
  `operator_decision_recorded` emit is unchanged and stays owned by the orchestrator's
  constructor-injected `OperatorDecisionPort`; the web server routes decisions through
  `orchestrator.recordOperatorDecision` (no new trust surface, no double-emit).

## Review gate

- **Tier:** L2 (CLI + build/CI wiring; no tape/signing/replay/digest surface) · **2-role**.
- **Roles satisfied:** implementer TDD self-verify (RED→GREEN) · independent Opus reviewer (open
  critique, fresh context) · independent acceptance-criteria verifier.
- **Independent reviewer verdict:** **PASS** — no CRITICAL/HIGH; verified all four flagged risks
  (published-bootstrap closure, build-order reversal, `--check` soundness, trust surface). One LOW
  (redundant second `OperatorDecisionPort` passed to server deps — dead wiring + latent double-emit)
  was **fixed in-slice** (dropped). One MEDIUM (published-install unavailability) accepted as a
  documented limitation consistent with the `ui-tui` optional-package contract.
- **Acceptance verifier verdict:** **PASS** — 8/8 criteria (subcommand, build chain, CI typecheck +
  no-root-ref, gitignore coverage, `--check` exit-0 + loopback, published-bootstrap green, isolation
  test asserts, changeset).
- **Reviewed state → commit:** the reviewed working state was committed as `48d8b22`; the post-review
  cleanup was a strict code removal (dropped dead port), re-verified green (web-command 9/9 + typecheck 0).

## PR gate

- **PR:** #210 · **Base:** `main` · **Head:** `feat/m5-s8-bp-web` @ `48d8b22` · **Draft:** no.
- **Required checks observed:** `verify` (SUCCESS, 9m), `Analyze (javascript-typescript)` (SUCCESS),
  `verify-wrong-node` (SUCCESS); advisory `GitGuardian` (SUCCESS), `Mergify Merge Protections` (SUCCESS).
- **Merge state:** CLEAN · **mergeable:** MERGEABLE.
- **Merge decision:** operator-gated — the auto-mode classifier blocked agent self-merge to `main`;
  merge performed/approved by the operator.

## Post-merge verification

- **Merge method:** squash · **Merge commit SHA:** `20e0a7e` · **`origin/main` contains it:** `yes (origin/main contains 20e0a7e)`.

## Exceptions / caveats

- **Build-order note:** root `build` runs `pnpm -C apps/web build && tsc --build` (web first) so a
  forwarded `pnpm build --force` (used by `published-bootstrap-stage.test.ts`) reaches `tsc --build`;
  `vite build` rejects unknown flags (CAC). `apps/web` has no `@buildplane/*` imports, so the order is safe.
- **`.gitignore`:** the plan listed `apps/web/dist` as a deliverable; the pre-existing bare `dist/`
  rule already covers it tree-wide, so no redundant line was added (the isolation test asserts coverage).
- **Known limitation:** `bp web` is source/dev-only (carried to M5-GATE deferred items).

## Next gate

- **Next allowed action:** M5-GATE receipt → close M5; then plan M6.
