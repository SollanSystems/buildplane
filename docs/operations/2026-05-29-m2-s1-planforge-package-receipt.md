# M2-S1 slice receipt — `packages/planforge` extraction + runtime contract + canonical digest

Evidence packet for Buildplane slice M2-S1. Not a status claim.

## Slice identity

- Slice id: M2-S1
- Milestone: Buildplane v0.5 M2 — PlanForge admission cycle
- Goal: Lift the shipped PlanForge dry-run (`compile → validate → preview`) out of `apps/cli/src/run-cli.ts` into a new unit-testable `@buildplane/planforge` package; promote `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt` to exported runtime types; replace the non-canonical `JSON.stringify` plan digest with a stable canonical serializer — without changing dry-run behavior.
- Non-goals: unstubbing `dryRun`/`sideEffects`/`generatedAt`/`admittedBy` (S3/S6); any tape/signing wiring (S2/S3); dynamic task generation beyond `PF1`/`PF2`. The `run-cli.ts` subcommand gate and `--write/--execute/--admit` block are untouched.
- Operator approval scope: L6 slice, no L0 trust surface. Single independent reviewer; operator admin-merges. No push/merge/label changes from inside the slice.
- Steward / agent: implementation engineer (Opus), isolated worktree.
- Started at: 2026-05-29
- Completed at: 2026-05-29

## Source of truth

- Base branch: main
- Base SHA: 3a138a3ca152997a720a9047d636eb971950b8ba (`origin/main`)
- Source docs / specs read:
  - `docs/superpowers/plans/2026-05-29-m2-s1-planforge-package-contract.md`
  - `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md`
  - `docs/architecture/planforge.md` (lines 113–205 — promoted-type doc contract)
- Related issue / task / board item: M2-S1 (first task in the M2 spec)
- Prior prerequisite PRs verified on `origin/main`: PlanForge dry-run present at base (`createPlanForgeDryRunPlan`, `run-cli.ts`); base is `#160` tip (M2-PREP-1).

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane/.claude/worktrees/wf_dde3ce4b-e52-1`
- Branch: `feat/m2-s1-planforge-package`
- Local HEAD SHA: see slice commit (recorded in structured result)
- Remote branch SHA: see structured result (`pushed`)
- Git identity verified: `test <test@test>`
- `core.bare=false` verified: yes; `core.filemode=false` verified: yes
- Clean status before work: yes (HEAD == `origin/main` == 3a138a3)
- Clean status after commit: yes (only gitignored `dist/`, `*.tsbuildinfo` untracked)

## Scope

- Files changed (23):
  - New package `packages/planforge/`: `package.json`, `tsconfig.json`, `src/{schema,digest,compile,validate,preview,index}.ts`, `test/{smoke,schema,digest,dry-run}.test.ts`
  - `apps/cli/src/planforge-schema.ts` → re-export shim (`export * from "@buildplane/planforge"`)
  - `apps/cli/src/run-cli.ts` → delegates to the package; deleted the now-dead local helpers `sectionText`/`listValue`/`hasLine`/`hasForbiddenPlanForgeGoalIntent`/`createPlanForgeDryRunPlan` (278 lines) and the unused `basename` import; trimmed the planforge-schema import to `createPlanForgeDryRunPlan` + `PLANFORGE_VALIDATION_STATUS_PASS`
  - `apps/cli/package.json` + `apps/cli/tsconfig.json` + root `tsconfig.json` → register `@buildplane/planforge` (dependency + project references)
  - `vitest.config.ts` → add `@buildplane/planforge` alias; anchor all workspace aliases to the config-file dir (cwd-independent resolution so the per-package `-C` verify commands resolve)
  - `apps/cli/test/planforge-schema.test.ts` + `apps/cli/test/run-cli.test.ts` → resolve fixtures relative to the test file (was `process.cwd()`-relative, which doubled the path under `-C apps/cli`); the digest-derivation assertion now uses the package's canonical `digest`
  - `apps/cli/test/fixtures/planforge/expected-plan.json` → one-time digest update (Task 4)
  - `.changeset/m2-s1-planforge-package.md` → minor (`@buildplane/planforge`, `buildplane`)
  - `pnpm-lock.yaml` → new workspace dependency edge
- Diff stat: 23 files changed, 854 insertions(+), 439 deletions(-)
- Added dependencies: none external. New internal workspace edge `buildplane → @buildplane/planforge` (`workspace:*`).
- Data migrations / durable schema changes: none.
- Tool / workflow permission changes: none.
- Deployment / publish / release side effects: none from the slice (changeset queues a future minor version bump only).
- Secret-shaped added lines scan: clean (no api-key/secret/token/password/private-key shaped additions).

## Canonical digest change (the one intended behavior change)

`planDigest`/`inputDigest` move from insertion-order `JSON.stringify` to a recursively key-sorted canonical serializer (`canonicalJson` → `node:crypto` SHA-256, `"sha256:"`-prefixed), so the bytes an S2 `plan_admitted` signs are reproducible across Rust (`bp-ledger` `canonicalize.rs` discipline) and TS. This changes the two pinned fixture digests exactly once:

| Field | Prior | New | Rationale |
|---|---|---|---|
| `inputDigest` | `sha256:1a2924f8a39b906cbf8c3aa29abd093f7f18b38cb1e4e11d7587fa913af62c2d` | `sha256:ac29ab0bacb4b72fd4b31bebb228ea30982e7f9e4be7701aef9972c6ff57a838` | canonicalization (`digest(canonicalInput)` now JSON-encodes the canonical input string) |
| `planDigest` | `sha256:d73b27520fd9a1d27f99d582b9a31b94d23cfea859dce606d68a11ebbc9c52c2` | `sha256:510fa97554e5c087126764aa73438ad4571c9016bdf00a416e5938a171364f60` | canonicalization (key-sorted serialization of the plan-minus-`receiptPreview` review artifact) |

No other fixture field changes. Determinism (key-order invariance) is proven by `packages/planforge/test/digest.test.ts`, not a bare snapshot.

## Verification

Record commands exactly as run.

- Package tests: `pnpm -C packages/planforge exec vitest run` → PASS (4 files, 12 tests).
- Focused CLI planforge tests: `pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge` → PASS (6 planforge tests, 96 skipped).
- CLI schema test: `pnpm -C apps/cli exec vitest run test/planforge-schema.test.ts` → PASS (2 tests).
- Full CLI suite (regression check): `pnpm -C <worktree> exec vitest run apps/cli/test/run-cli.test.ts` → PASS (102 tests).
- Cross-package alias-regression check: policy (39), ledger-client (30), kernel (174) → PASS.
- Typecheck: `pnpm typecheck` (`tsc --build`) → PASS.
- Build: `pnpm build` (`tsc --build`) → PASS.
- Lint / format: `pnpm lint` (`biome check .`) → CI-canonical; whole-repo `biome check .` OOMs locally in WSL — exit status taken from CI, not local.
- Direct CLI smoke: `buildplane planforge dry-run --input apps/cli/test/fixtures/planforge/goal-input.md --json` → exit 0, status `PASS`, output equals the golden fixture except the two updated digest fields (behavioral lock holds).
- Forbidden literal / ambient-authority grep: no secret-shaped additions.

## Review gate

- Review task id / reviewer: 1 independent Reviewer (Opus, fresh session) — pending.
- Reviewed commit SHA: must equal PR head SHA at merge.
- Verdict: pending (`PASS` target).
- Significant issues found: none recorded by the implementer.
- Review notes: L6 slice — no signing/verification/key/checkpoint behavior, so no adversarial Codex reviewer required (that gate begins at S2).

## PR gate

- PR URL / number: see structured result.
- Base branch: main; Head branch: `feat/m2-s1-planforge-package`.
- Merge state: operator admin-merges (solo PR). Not auto-merge: standard non-L0, single reviewer + admin-merge. No `buildplane:auto-merge` label applied.

## Exceptions / caveats

- Known unrelated warnings: `ai` / `@ai-sdk/*` unmet-peer `zod` warnings on `pnpm install`; `node:sqlite` experimental-feature warning in CLI tests. Both pre-exist on `origin/main`.
- Local lint: whole-repo `biome check .` OOMs in WSL; CI `verify` is the canonical lint gate.
- The vitest-alias anchoring and test fixture-path hardening are necessary so the plan's per-package `-C` verify commands resolve; they fix a pre-existing `process.cwd()` fragility and do not change runtime behavior.

## Next gate

- Next allowed action: independent Reviewer verdict on the PR head SHA, then operator admin-merge.
- Actions explicitly not authorized: merge, auto-merge label, branch-protection/ruleset edits, `.github/` or release-plumbing changes from inside the slice.
- Follow-ups carried forward: unstub `dryRun`/`sideEffects`/`generatedAt`/`admittedBy` (S3/S6); tape/signing wiring (S2/S3); S2 rebases onto this canonical-digest contract.
