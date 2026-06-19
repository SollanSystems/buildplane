# Buildplane slice receipt

## Slice identity

- Slice id: M4-S1
- Milestone: M4 Acceptance Contract
- Goal: Add the smallest finalization-time acceptance gate skeleton so configured runs cannot finalize success when required acceptance evidence is missing or failing.
- Non-goals: no L0 tape/signing/digest event; no native changes; no ledger-client/generated fixtures; no CLI profile wiring; no Mission Control UI; no memory routing; no side-effect vocabulary changes.
- Operator approval scope: user supplied execution plan and authorized implementation in a fresh isolated worktree.
- Steward / agent: Codex
- Started at: 2026-06-19T16:20:00Z
- Completed at: 2026-06-19T17:21:27Z

## Source of truth

- Base branch: `origin/main`
- Base SHA: `df403267d80167ca5cf336a915f369034fca2f62`
- Source docs / specs read: `CLAUDE.md`; `README.md`; `docs/superpowers/specs/2026-06-18-m4-acceptance-contract-design.md`; `docs/superpowers/plans/2026-06-18-m4-s1-acceptance-contract-schema-evaluator.md`; `docs/operations/slice-receipt-template.md`
- Related issue / task / board item: user-provided M4 controller plan
- Prior prerequisite PRs verified on `origin/main`: M4 spec commit at base SHA above

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane/.worktrees/m4-s1-acceptance-finalization-gate`
- Branch: `feat/m4-s1-acceptance-finalization-gate`
- Local HEAD SHA during CI-repair update: `2db0ddcce5a5be399ddcffd20e275042240b2f69` plus uncommitted source-runtime shim fix
- Remote branch SHA during CI-repair update: `2db0ddcce5a5be399ddcffd20e275042240b2f69`
- Git identity verified: `Sollan Systems <khall0239@gmail.com>`
- `core.filemode=false` verified: yes
- Clean status before work: yes in isolated worktree
- Clean status after first commit: yes; follow-up CI-repair files pending commit during this receipt update

## Scope

- Files changed:
  - `docs/operations/2026-06-19-m4-s1-acceptance-finalization-gate-slice-receipt.md`
  - `packages/kernel/src/events.ts`
  - `packages/kernel/src/index.d.ts`
  - `packages/kernel/src/index.ts`
  - `packages/kernel/src/orchestrator.ts`
  - `packages/kernel/src/policy.ts`
  - `packages/kernel/src/ports.ts`
  - `packages/kernel/src/run-loop.ts`
  - `packages/kernel/test/orchestrator.test.ts`
  - `packages/policy/src/acceptance.js`
  - `packages/policy/src/acceptance.ts`
  - `packages/policy/src/index.js`
  - `packages/policy/src/index.ts`
  - `packages/policy/test/acceptance.test.ts`
- Diff stat: final PR branch contains 14 changed files after the source-runtime shim follow-up.
- Added dependencies: none
- Data migrations / durable schema changes: none
- Tool / workflow permission changes: none
- Deployment / publish / release side effects: none
- Secret-shaped added lines scan: exit 0, no matches for `sk-`, `api_key`, `secret`, `password`, or private-key literals in added lines/new files.

## Verification

Record commands exactly as run. Include exit codes and relevant caveats.

- Worktree creation:
  - `git worktree add .worktrees/m4-s1-acceptance-finalization-gate -b feat/m4-s1-acceptance-finalization-gate origin/main` → exit 255; sandbox blocked `.git` ref write.
  - same command with approved escalation → exit 0.
- Dependency setup:
  - `pnpm install --frozen-lockfile` → exit 1; registry `EAI_AGAIN` plus `ERR_PNPM_EACCES` rename under the Windows-mounted worktree.
  - same command with approved escalation → exit 1; `ERR_PNPM_EACCES` persisted.
  - Caveat: final verification used root checkout tool binaries and generated local symlinks for TypeScript module resolution; `pnpm -C <worktree> exec vitest ...` still returned exit 254 because the failed install did not create `.bin/vitest`.
- RED tests:
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/vitest run packages/policy/test/acceptance.test.ts packages/kernel/test/orchestrator.test.ts --config vitest.config.ts` → exit 1; expected RED: missing `../src/acceptance` module and both new orchestrator tests failed because the acceptance gate was not consulted.
- Focused tests:
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/vitest run packages/policy/test/acceptance.test.ts packages/kernel/test/orchestrator.test.ts --config vitest.config.ts` → exit 0; 2 files passed, 28 tests passed.
  - Same command after verifier-requested fix for non-empty required check evidence → exit 0; 2 files passed, 28 tests passed.
  - Same command after verifier-requested fail-closed fix for missing acceptance evaluator → exit 0; 2 files passed, 29 tests passed.
  - Same command after CI source-runtime shim fix → exit 0; 2 files passed, 29 tests passed.
- Package / area tests: covered by focused command above.
- Typecheck:
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/tsc --build packages/kernel/tsconfig.json packages/policy/tsconfig.json --pretty false` → exit 2 before final fix; surfaced stale `PolicyDecisionEvent.decisionKind` union plus dependency materialization errors from failed install.
  - same command after type fix and local generated symlinks → exit 0.
  - same command after verifier-requested evidence fix → exit 0.
  - same command after verifier-requested fail-closed evaluator fix → exit 0.
  - same command after CI source-runtime shim fix → exit 0.
- Lint / format:
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/biome check packages/kernel/src/policy.ts packages/kernel/src/run-loop.ts packages/kernel/src/ports.ts packages/kernel/src/index.ts packages/kernel/src/index.d.ts packages/kernel/src/events.ts packages/kernel/src/orchestrator.ts packages/kernel/test/orchestrator.test.ts packages/policy/src/acceptance.ts packages/policy/src/index.ts packages/policy/src/index.js packages/policy/test/acceptance.test.ts` → exit 1 before formatting; formatter changes needed.
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/biome format --write packages/kernel/src/run-loop.ts packages/kernel/test/orchestrator.test.ts packages/policy/src/acceptance.ts` → exit 0.
  - same `biome check ...` command after formatting → exit 0 with one pre-existing warning at `packages/kernel/src/orchestrator.ts:586` (`useOptionalChain`) outside this slice.
  - same `biome check ...` command after verifier-requested evidence fix → exit 0 with the same pre-existing warning.
  - same `biome check ...` command after verifier-requested fail-closed evaluator fix → exit 0 with the same pre-existing warning.
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/biome check packages/kernel/src/policy.ts packages/kernel/src/events.ts packages/kernel/src/ports.ts packages/kernel/src/run-loop.ts packages/kernel/src/orchestrator.ts packages/kernel/src/index.ts packages/kernel/src/index.d.ts packages/kernel/test/orchestrator.test.ts packages/policy/src/acceptance.ts packages/policy/src/acceptance.js packages/policy/src/index.ts packages/policy/src/index.js packages/policy/test/acceptance.test.ts docs/operations/2026-06-19-m4-s1-acceptance-finalization-gate-slice-receipt.md` after adding `acceptance.js` → exit 1; formatter change needed in `packages/policy/src/acceptance.js`; same pre-existing optional-chain warning.
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/biome format --write packages/policy/src/acceptance.js` → exit 0.
  - same `biome check ...` command after formatting `acceptance.js` → exit 0 with the same pre-existing warning.
- Build: not run; focused package typecheck completed.
- CLI integration / source-runtime smoke:
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/vitest run test/integration/graph-e2e.test.ts --config vitest.config.ts -t "executes a parallel graph"` → exit 1 in sandbox; blocked before code under test with `spawnSync /bin/sh EPERM`.
  - same command with approved escalation → exit 1; local worktree lacked generated `apps/cli/dist/index.js`.
  - `/mnt/c/Dev/projects/buildplane/node_modules/.bin/tsc --build apps/cli/tsconfig.json --pretty false` → exit 2; Windows-mounted worktree dependency materialization incomplete (`@buildplane/*`, `uuid`, `ink`, `react`, `@honcho-ai/sdk` resolution failures), but emitted enough dist to inspect generated policy imports.
  - same focused integration command after partial dist emit → exit 1; local `node_modules/@buildplane` workspace links still incomplete (`@buildplane/adapters-tools` missing), so local reproduction could not proceed to graph assertions.
  - `node --conditions=source --import tsx -e "const mod = await import('./packages/policy/src/index.js'); if (typeof mod.evaluateAcceptanceContract !== 'function') process.exit(1);"` → exit 0; verifies source-mode policy export resolves through `acceptance.js` instead of importing `acceptance.ts` directly.
- Full-suite check, if run: not run; slice plan requested narrow verification first.
- Isolated reruns for flaky / timeout failures: n/a.
- Direct CLI smoke / manual probe: n/a.
- Forbidden literal / ambient-authority grep:
  - `git status --short | rg '^( M|M |A |\?\?) (native/|packages/ledger-client/)'` → exit 1, no forbidden-scope matches.
  - `git diff --check` → exit 0.
  - `git diff --check` after verifier-requested evidence fix → exit 0.
  - `git diff --check` after verifier-requested fail-closed evaluator fix → exit 0.
  - `git diff --check` after CI source-runtime shim fix → exit 0.

### Cross-language / digest (L0 ledger, signing, replay, digest slices)

- `u64` → TS `string` boundary verified: n/a — no L0 payload, native, signing, or ledger-client wire shape touched.
- Canonical digest byte-stability: n/a — no signed digest shape touched.
- Ledger fixture freshness: n/a — no generated ledger fixtures touched.
- Whole-workspace `cargo test`: n/a — no native enum/event kind changes.

## Review gate

### Ceremony tier

- Tier: `L1` / `L2`
- Roles satisfied: implementer TDD self-verify; independent verifier requested changes twice; final verifier PASS after fixes.
- Tier justification: touches kernel finalization path and policy gate behavior; no L0/tape/signing/replay/digest surface.

- Review task id / reviewer: subagent verifier `019ee0bf-974d-7921-8dd8-e132fcf48f31`
- Reviewed commit SHA: uncommitted worktree changes at base `df403267d80167ca5cf336a915f369034fca2f62`
- Current PR head SHA during CI-repair update: `2db0ddcce5a5be399ddcffd20e275042240b2f69`
- Verdict: `PASS` after two `REQUEST_CHANGES` rounds
- Significant issues found: orchestrator pass test used empty `checks`; kernel passed hard-coded `checkResults: []`; changeset was outside worker prompt scope; configured contract failed open if `policy.evaluateAcceptanceContract` was absent.
- Issues reconciled by follow-up commit SHA: `2db0ddcce5a5be399ddcffd20e275042240b2f69`
- Review notes / link: fixed by adding `ExecutionReceipt.acceptanceEvidence`, passing `acceptanceEvidence.checkResults` into the gate, tightening orchestrator tests to require `pnpm lint` evidence, removing the changeset file, and rejecting with `acceptance.contract` when a configured contract has no evaluator.

## PR gate

- PR URL: `https://github.com/SollanSystems/buildplane/pull/192`
- PR number: `192`
- Draft state: n/a
- Base branch: `main`
- Head branch: `feat/m4-s1-acceptance-finalization-gate`
- Head SHA during initial CI failure: `2db0ddcce5a5be399ddcffd20e275042240b2f69`
- Merge state during receipt update: open; source-runtime shim follow-up pending commit/push
- Review decision: n/a
- Auto-merge opt-in label present: n/a
- Required auto-merge label: n/a
- Required checks observed: initial CodeQL success; initial CI failure in `Run tests`.
- Advisory checks observed: n/a
- Deployment objects from GET-only probe: n/a
- Auto-merge eligibility result: n/a
- Auto-merge decision: n/a during receipt update

## Post-merge verification

- Merge method: n/a
- Merge commit SHA: n/a
- `origin/main` SHA after fetch: not fetched; local `origin/main` at `df403267d80167ca5cf336a915f369034fca2f62`
- `origin/main` contains merge commit: n/a
- Default-branch CI: n/a
- Deployment objects after merge: n/a
- Remote feature branch still exists: n/a
- Local worktree retained / removed: retained
- Cleanup explicitly approved: no

## Exceptions / caveats

- Known unrelated warnings: scoped Biome reports existing optional-chain warning at `packages/kernel/src/orchestrator.ts:586`.
- Local load-sensitive failures and isolated rerun evidence: none.
- Release automation noise: changeset intentionally removed after verifier flagged it as outside the worker prompt's allowed file scope.
- Out-of-band merges / automation actions: none.
- Blockers carried forward: worktree-local `pnpm install --frozen-lockfile` fails on Windows-mounted filesystem with `ERR_PNPM_EACCES`; verification used root binaries plus generated local symlinks.

## Next gate

- Next allowed action: commit and push CI-repair follow-up, then watch PR checks and merge after required checks pass.
- Actions explicitly not authorized: L0 event work; ledger fixtures; native changes.
- Fresh context required before continuing: verify current worktree status and rerun focused tests/typecheck if edits continue.
