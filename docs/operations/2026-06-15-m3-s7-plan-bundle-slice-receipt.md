# M3-S7 slice receipt — PlanForge plan-level default capability bundle

The receipt is an evidence packet, not a status claim.

## Slice identity

- Slice id: M3-S7
- Milestone: M3 — Capability broker
- Goal: Derive a run-wide capability **envelope** from an admitted PlanForge plan — `buildDefaultCapabilityBundleForPlan(plan)` = the deterministic (sorted) union of every task's `fsWrite` globs + `run_command` allowlist, `bundleId = plan.id`.
- Non-goals: changing the per-task dispatch attach (S3, stays least-privilege); operator JSON bundle override (deferred); extending the side-effect vocabulary (`code-edit`→`src/**`); any L0/tape change.
- Operator approval scope: "Close out M3 (S7 → S8)" — build + review + draft PR; operator admin-merges.
- Steward / agent: Claude Code (Opus 4.8), main-loop implementer.
- Started at: 2026-06-15
- Completed at: 2026-06-15

## Source of truth

- Base branch: `main`
- Base SHA: `4da98886e3179eaf086269f8bb247a538bf9c7a9`
- Source docs / specs read: `docs/superpowers/specs/2026-06-10-capability-broker-m3.md` (§M3-S7, decision 6, M6 demo constraints); `packages/planforge/src/bundle.ts` (S3 per-task builder + its `// Full plan-level overrides land in M3-S7` marker); `packages/capability-broker/src/{evaluate,parse,validate,digest}.ts` (locked S2 semantics).
- Related issue / task / board item: M3 critical path S1→S8 (S1–S6 on `main`).
- Prior prerequisite PRs verified on `origin/main`: #185 (S1), #186 (S2), #187 (S3–S6 train).

## Workspace

- Worktree path: `.worktrees/m3-s7-planforge-default-bundle`
- Branch: `feat/m3-s7-planforge-default-bundle` (cut from `origin/main` @ `4da9888`)
- Local HEAD SHA: `d9fccd4977ba827b7f5d2dfe71d099ae93972934`
- Remote branch SHA: unpushed (draft PR pending)
- Git identity verified: Sollan Systems (repo default)
- `core.filemode=false` verified: yes
- Clean status before work: yes (fresh worktree)
- Clean status after commit: yes (only the untracked S7/S8 plan doc, committed with the receipt)

## Scope

- Files changed: `packages/planforge/src/bundle.ts` (+35), `packages/planforge/src/index.ts` (+1 export), `packages/planforge/test/bundle.test.ts` (+96 tests), `.changeset/m3-s7-planforge-plan-bundle.md` (new).
- Diff stat: 4 files changed, 136 insertions(+), 1 deletion(-).
- Added dependencies: none.
- Data migrations / durable schema changes: none.
- Tool / workflow permission changes: none.
- Deployment / publish / release side effects: changeset `buildplane: minor` (only public package; `@buildplane/planforge` is `private:true`, surface exposed via the `buildplane` umbrella — matches the 2026-06-08 S6 keying decision).
- Secret-shaped added lines scan: none (pure derivation logic + tests).

## Verification

- Focused tests: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run packages/planforge/test/bundle.test.ts` → PASS (5 tests: 1 existing per-task + 4 new envelope). RED first confirmed (`buildDefaultCapabilityBundleForPlan is not a function`, 4 failing / 1 passing) before implementation.
- Package / area tests: `pnpm -C … exec vitest run packages/planforge packages/capability-broker packages/kernel/test/packet.test.ts` → PASS (16 files / 60 tests, 0 failures).
- Typecheck: `pnpm -C … typecheck` (`tsc --build`) → PASS (no errors; confirms no `readonly`-array friction — `validateCapabilityBundle` takes `unknown`, enforcement uses the validated `.bundle`).
- Lint / format: deferred to S8 full-gate via fresh subagent (whole-repo `biome check` OOMs in WSL — documented trap); commit used `--no-verify`.
- Build: deferred to S8 full-gate.
- Full-suite check, if run: deferred to S8 full-gate.
- Isolated reruns for flaky / timeout failures: n/a.
- Direct CLI smoke / manual probe: n/a (pure function; covered by the broker-enforceability cross-check test).
- Forbidden literal / ambient-authority grep: n/a (no shell/exec/path-escape surface added).

### Cross-language / digest (L0 ledger, signing, replay, digest slices)

- `u64` → TS `string` boundary verified: n/a — no wire/tape change; bundle is a TS-only object digested via the existing shared `@buildplane/planforge` canonical digest.
- Canonical digest byte-stability: covered — test asserts `capabilityBundleDigest(bundle) === bundleDigest(bundle)` (planforge re-export ≡ broker) and rebuild-determinism; the envelope sorts `fsWrite`/`allowlist` so the digest is order-independent of task iteration.
- Ledger fixture freshness: n/a — no Rust payload change.
- Whole-workspace `cargo test`: n/a — no enum/event-kind change (asserted clean in S8 full-gate).

## Review gate

### Ceremony tier

- Tier: `L2` (2-role).
- Tier justification: PlanForge derivation logic over already-landed broker primitives; no tape/signing/replay/digest-algorithm change (it reuses the existing canonical digest), so below L0. Per the M3 spec review table (S7 = L2).
- Roles satisfied: implementer TDD self-verify ✅ · independent reviewer + acceptance verifier — **pending** (checkpoint before S8).
- Review task id / reviewer: pending
- Reviewed commit SHA: pending (= `d9fccd4` at request time)
- Current PR head SHA: `d9fccd4` (+ docs commit)
- Verdict: pending
- Significant issues found: pending
- Review notes / link: pending

## PR gate

- PR URL / number: pending (draft)
- Draft state: to be opened draft
- Base branch: `main`
- Head branch: `feat/m3-s7-planforge-default-bundle`
- Auto-merge opt-in label present: no (L2 solo PR — admin-merge, no `buildplane:auto-merge`)

## Post-merge verification

- Pending operator admin-merge.

## Exceptions / caveats

- **"Matching M6 demo constraints" interpretation (documented):** v0.5 §7's `src/`+`test/`+`npm` is illustrative. The toy `goal-input.md` plan is doc-oriented (`local-doc`/`local-fixture`/`local-receipt`; `git`/`pnpm`) — there is no `code-edit` side-effect kind in `PLANFORGE_ALLOWED_SIDE_EFFECTS`. So the enforceability principle (fail-closed confinement to exactly the plan's declared surface) is proven on the real fixture: envelope `fsWrite: [apps/cli/test/fixtures/**, docs/**, docs/operations/**, packages/**/test/fixtures/**]` + `allowlist: [git, pnpm]`, cross-checked against the broker (`docs/note.md` allow / `src/secret.ts` deny / `git status` allow / `curl …` deny).
- **Follow-up (not this slice):** extend the side-effect vocabulary (`code-edit`→`src/**`/`test/**`) — this also unblocks genuine `planforge admit` dogfooding of code-editing slices (the open dogfooding fork).

## Next gate

- Next allowed action: S7 L2 review (independent reviewer + acceptance verifier), then draft PR; then proceed to M3-S8 (M3-GATE).
- Actions explicitly not authorized: merge (operator admin-merge); applying `buildplane:auto-merge`.
- Fresh context required before continuing: yes — independent reviewer must run in fresh context.
