# Buildplane slice receipt — GAP-10 authorization envelope

The receipt is an evidence packet, not a status claim.

## Slice identity

- Slice id: GAP-10 (self-build loop) — authorization envelope
- Milestone: M5-adjacent (self-build loop infrastructure)
- Goal: a one-time signed operator-authorized bounded envelope + a pure subset-admission evaluator the supervisor (GAP-7) consumes to auto-admit a planner proposal iff it is a SUBSET of the envelope; plus closing the GAP-4 worker-binary permission-escape carry-forward.
- Non-goals: tape selection rule application (GAP-7 owns it), cumulative token-budget enforcement (GAP-7/D6), Phase-3 automation. GAP-10 records + evaluates only.
- Operator approval scope: implement the GAP-10 slice per `/tmp/sbl/render/09-GAP-10.md` and the self-build-loop plan; full L0 ceremony.
- Steward / agent: implementer (this session) + downstream independent Opus reviewer + adversarial Codex + acceptance verifier (L0 4-role, pending).
- Started at: 2026-06-22
- Completed at: 2026-06-22 (implementation; review gate pending)

## Source of truth

- Base branch: `main`
- Base SHA: `252f7c5` (origin/main at slice start)
- Source docs / specs read: `/tmp/sbl/render/00-header.md` (Global Constraints + D1–D8), `/tmp/sbl/render/09-GAP-10.md`, `docs/roadmap.json` (GAP-9), `CLAUDE.md` (L0 amendment ceremony + emit helpers).
- Related issue / task / board item: GAP-10 of the 10-gap self-build-loop set.
- Prior prerequisite PRs verified on `origin/main`: M5-S1 `operator_decision_recorded` kind present in `payload/mod.rs` + `payload.ts` (confirmed Task 0); GAP-1 `code-edit` vocab present in `planforge/src/{schema,bundle}.ts`; GAP-9 `docs/roadmap.json` present (schemaVersion `buildplane.roadmap.v0`, milestone `M5`, flat `slices[]`).

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane` (branch checked out, stacked on GAP-9)
- Branch: `feat/gap-10-authorization-envelope`
- Local HEAD SHA: see commit list below (`be6d932` + GAP-10.8 + receipt/changeset commits)
- Git identity verified: yes (Sollan Systems)
- `core.bare=false` verified: yes
- `core.filemode=false` verified: yes
- Clean status before work: stacked on GAP-9 tip `d654ea8`
- Clean status after commit: per-commit path-scoped staging, husky-clean

## Scope

- Files changed (GAP-10 only):
  - `packages/kernel/src/policy.ts` (+`AuthorizationEnvelopeV0`, `EnvelopeProposal`), `packages/kernel/src/index.ts` + `packages/kernel/src/index.d.ts` (re-export)
  - `packages/policy/src/authorization-envelope.ts` (new: evaluator + digest + canonical-json), `packages/policy/src/index.ts` (barrel)
  - `native/crates/bp-ledger/src/payload/operator_decision.rs` (amend: `authorize-envelope` subject + `envelope: Option<String>` w/ `skip_serializing_if`), `native/crates/bp-ledger/src/bin/gen_fixtures.rs` (+`envelope: None`), `native/crates/bp-ledger/tests/operator_decision.rs` (+round-trip / canonicalize / None-omits-on-wire)
  - `packages/ledger-client/src/generated/index.ts` (regen: `envelope?: string`)
  - `apps/cli/src/ledger-emit.ts` (new: behavior-preserving lift of native-binary resolution + signed-emit helpers), `apps/cli/src/planforge-authorize-envelope.ts` (new command), `apps/cli/src/run-cli.ts` (subcommand wiring + help + re-import helpers)
  - `packages/capability-broker/src/evaluate.ts` (GAP-4 fix: deny worker-binary permission-escape flags), `packages/planforge/src/bundle.ts` (doc-comment: GAP-4 closed)
  - tests: `packages/kernel/test/authorization-envelope-types.test.ts`, `packages/policy/test/authorization-envelope.test.ts`, `packages/ledger-client/test/payload-union.test.ts`, `apps/cli/test/{planforge-authorize-envelope,roadmap-shape}.test.ts`, `apps/cli/test/run-cli.test.ts` (assertion update), `packages/capability-broker/test/evaluate.test.ts`, `test/ledger-integration/operator-envelope.test.ts`
- Added dependencies: none (`@buildplane/policy` already an `apps/cli` dep — no published-bootstrap entry needed)
- Data migrations / durable schema changes: payload amendment to `operator_decision_recorded` (`envelope` optional field, `skip_serializing_if` keeps merge/resume records byte-identical — no tape migration)
- Tool / workflow permission changes: capability-broker now denies worker-binary permission-escape flags (tightening, not loosening)
- Deployment / publish / release side effects: none beyond the changeset version bumps
- Secret-shaped added lines scan: n/a — no secrets; the 32-byte ed25519 seed in the integration test is `Buffer.alloc(32, 7)` (deterministic non-secret, matches admit-test precedent)

## Verification

- Focused tests:
  - `pnpm exec vitest run packages/policy/test/authorization-envelope.test.ts` → 9 passed
  - `pnpm exec vitest run packages/kernel/test/authorization-envelope-types.test.ts` → 1 passed
  - `pnpm exec vitest run packages/capability-broker/test/evaluate.test.ts` → 13 passed (incl. `claude --dangerously-skip-permissions` DENIED via args + command-string forms)
  - `pnpm exec vitest run apps/cli/test/planforge-authorize-envelope.test.ts` → 7 passed
  - `pnpm exec vitest run apps/cli/test/roadmap-shape.test.ts` → 2 passed
  - `pnpm exec vitest run packages/ledger-client/test` → 35 passed
  - `pnpm native:build && pnpm exec vitest run test/ledger-integration/operator-envelope.test.ts --no-file-parallelism` → 3 passed (signed event present + verifies under kernel/kernel-main; idempotent re-authorize; fails-closed w/o --approve)
- Typecheck: `pnpm typecheck` → exit 0
- Lint / format: scoped `biome check` on changed files clean; husky `pnpm lint` ran per-commit (whole-repo biome OOMs in-session → routed via fresh subagents)
- Build: native `cargo build -p bp-cli` green
- Full-suite check, if run: deferred to CI `verify` (canonical); `pnpm check` not run in-session (biome OOM)
- Direct CLI smoke / manual probe: ran the command twice against a temp repo-root tape — first emits a signed event, second no-ops on the deterministic envelope-digest run id
- Forbidden literal / ambient-authority grep: n/a

### Cross-language / digest (L0 ledger, signing, replay, digest slices)

- `u64` → TS `string` boundary verified: yes — `envelope` is `Option<String>` (canonical-JSON string); `max_iterations`/`token_budget` integers live INSIDE the JSON string, so no `u64` is typeshared as TS `number`.
- Canonical digest byte-stability (Rust ↔ TS): the envelope `canonicalEnvelopeJson` (key-sorted) is produced in TS and stored verbatim; Rust treats it as an opaque string. `authorizationEnvelopeDigest` is content-addressed + order-independent (tested). The `operator_decision_recorded` canonical bytes round-trip + canonicalize in Rust (tests green).
- Ledger fixture freshness: `pnpm ledger:gen && pnpm ledger:gen-fixtures` → `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures` clean (BYTE_STABLE_OK). Only `generated/index.ts` gained the `envelope?: string` field; `payload-variants.json` + `test/fixtures/signed-tape` byte-identical (merge variant `envelope=None` omitted via `skip_serializing_if`).
- Whole-workspace `cargo test` (no `-p`): `cargo test --manifest-path native/Cargo.toml` → 287 passed, 0 failed (67 suites). `bp-replay` exhaustive `Payload` match intact (no variant added — the kind already existed; only an optional field).

## Review gate

### Ceremony tier

- Tier: `L0` (amends the signed `operator_decision_recorded` payload + adds a trust-admission evaluator) — full 4-role.
- Roles satisfied: implementer TDD self-verify ✅ · independent Opus reviewer ⏳ · adversarial Codex ⏳ · independent acceptance-criteria verifier ⏳
- Tier justification: amends a signed L0 tape payload (the full L0 amendment ceremony was followed) and introduces a new auto-admission trust gate; both are load-bearing trust surfaces.

- Review task id / reviewer: pending
- Reviewed commit SHA: pending (must equal PR head)
- Verdict: pending
- Significant issues found: pending

## Exceptions / caveats

- Known unrelated warnings: pre-existing biome warnings in `packages/policy/src/diff-scope.ts:25` + `packages/kernel/src/orchestrator.ts:821` (`useOptionalChain`) — warnings, not errors; do not block commits and predate this slice.
- Plan deviations (documented):
  - The plan's `apps/cli/src/flags.ts` does not exist; the lifted command inlines a local `readFlag` (matching run-cli's helper) to avoid a circular import.
  - The plan's `makeLedgerFixtureRepo`/`exportSignedTape` fixtures do not exist; the integration test mirrors the real `planforge-admit.test.ts` structure (temp HOME + kernel seed + direct `events.db`/`event_signatures` read via `node:sqlite`).
  - The plan's `pf-envelope-<hex>` run id is NOT a valid `RunId(Uuid)`; the native `ledger serve --run-id` rejects it (handshake fails). Fixed to a deterministic UUIDv8-shaped id derived from the envelope digest (mirrors run-cli's `planAdmitRunId`), preserving idempotency.
  - The native ledger does not dedupe by run id, so idempotency is enforced by an explicit pre-emit tape probe (`findExistingAuthorizeEnvelope`), mirroring `findExistingPlanAdmitted`.
  - `skip_serializing_if` applied ONLY to the new `envelope` field (not the three pre-existing `Option` fields) to keep M5-S1's wire shape byte-identical.
- Out-of-band merges / automation actions: none.
- Blockers carried forward: none for this slice. The full-suite `pnpm check` is deferred to CI `verify` (biome whole-repo OOMs in-session).

## Next gate

- Next allowed action: open the L0 solo PR (NOT auto-merge eligible — no `buildplane:auto-merge` label; admin-merge), dispatch the L0 4-role review (Opus reviewer + adversarial Codex + acceptance verifier), reviewed SHA must equal PR head.
- Actions explicitly not authorized: auto-merge label, merge before 4-role PASS, GAP-7 consumption work (separate slice).
- Fresh context required before continuing: yes for the independent Opus reviewer (fresh session).
