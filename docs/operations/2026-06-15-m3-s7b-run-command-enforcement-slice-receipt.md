# M3-S7b slice receipt — run_command capability enforcement in adapters-tools

The receipt is an evidence packet, not a status claim.

## Slice identity

- Slice id: M3-S7b (gap-closure slice, discovered during S8 GATE prep)
- Milestone: M3 — Capability broker
- Goal: Enforce the capability bundle's `run_command.allowlist` on the actual tool surface. `runCommand` now runs the broker before spawn — a command whose argv0 is not allowlisted is denied fail-closed and never executed, and (with a tape context) emits a signed `capability_denied` event. `createToolRegistry` passes the bundle to `run_command` (was `write_file`-only).
- Non-goals: changing the broker's locked S2 match semantics; argv-level (beyond argv0) policy; network egress; any L0/tape change.
- Operator approval scope: explicit — operator chose "Fix now as M3-S7b, then GATE" after the gap was surfaced.
- Steward / agent: Claude Code (Opus 4.8), main-loop implementer.
- Started at: 2026-06-15
- Completed at: 2026-06-15

## Why this slice exists

The M3 goal ("**every** tool invocation — write_file, run_command — is checked against the bundle before execution"), decision 4 ("broker evaluates the **two** tools"), and the M6 demo contract ("bash limited to … — M3 must make this **enforceable, not documentary**") all require `run_command` enforcement. S2 built + tested the broker's command evaluation and S5 shipped a `capability_denied` payload whose `tool` doc already reads "`write_file` or `run_command`" — but **no production path ever called `evaluateToolInvocation` for a command**. S4 wired only `write_file`; `createToolRegistry.run_command` ignored the bundle. The allowlist was decorative. This slice closes that wiring gap with zero L0 change (the tape event already supports `run_command`).

## Source of truth

- Base branch: `main` · Base SHA: `4da98886e3179eaf086269f8bb247a538bf9c7a9`
- Source docs / specs read: `docs/superpowers/specs/2026-06-10-capability-broker-m3.md` (Goal, decision 4, S4); `packages/adapters-tools/src/write-file.ts` (the S4/S6 pattern mirrored); `apps/cli/src/run-cli.ts:1077` `toolRegistryOptionsForPacket`; `native/crates/bp-ledger/src/payload/capability_broker.rs` (tool field is `String`, doc names run_command).
- Prior prerequisite PRs verified on `origin/main`: #185 (S1 schema), #186 (S2 evaluate), #187 (S3–S6 train incl. write_file enforcement + capability_denied).

## Workspace

- Worktree path: `.worktrees/m3-s7-planforge-default-bundle`
- Branch: `feat/m3-s7-planforge-default-bundle` (stacked after S7 on the M3-close branch)
- Local HEAD SHA: `89bd765`
- `core.filemode=false` verified: yes · Clean status after commit: yes

## Scope

- Files changed: `packages/adapters-tools/src/run-command.ts` (+41: `RunCommandOptions` + broker-before-spawn), `packages/adapters-tools/src/index.ts` (+7: registry passes bundle to run_command; export `RunCommandOptions`), `packages/adapters-tools/test/run-command-broker.test.ts` (+99, new), `.changeset/m3-s7b-run-command-enforcement.md` (new).
- Diff stat: 4 files changed, 149 insertions(+), 3 deletions(-).
- Added dependencies: none. Data migrations / durable schema changes: none. L0/tape change: none.
- Deployment / publish / release side effects: changeset `buildplane: minor`.
- Secret-shaped added lines scan: none.

## Verification

- Focused tests: `pnpm -C .worktrees/m3-s7-planforge-default-bundle exec vitest run packages/adapters-tools/test/run-command-broker.test.ts` → PASS (6: allow allowlisted; deny non-allowlisted without spawn; onCapabilityDenied fires with `tool:"run_command"`; fail-closed when no allowlist; registry forwards bundle; no-bundle backward compatible). RED first confirmed (4 failed / 2 passed before wiring).
- Package / area tests: `pnpm -C … exec vitest run packages/adapters-tools` → PASS (5 files / 33 tests).
- Typecheck: `pnpm -C … typecheck` (`tsc --build`) → PASS — confirms the shared `toolOpts` object (`{capabilityBundle, onCapabilityDenied}`) types cleanly into both `WriteFileOptions` and `RunCommandOptions`, and `apps/cli` still compiles (its `onCapabilityDenied` now also flows to `run_command`).
- End-to-end wiring confirmed (read-only): `toolRegistryOptionsForPacket` extracts `packet.capability_bundle` and builds `onCapabilityDenied` → `emitCapabilityDenied(..., {...detail})` (tool not hardcoded); post-S7b that options object reaches `run_command`, so the real CLI run path now denies + tape-quarantines disallowed commands.
- Lint / format / build / full-suite: deferred to the M3-GATE full-gate run (Task 5).
- Forbidden literal / ambient-authority grep: the change REMOVES ambient command authority (the point of the slice); no shell-string interpolation added (`spawnSync` keeps argv array form, unchanged).

### Cross-language / digest

- n/a — no wire/tape/digest change. The `capability_denied` payload (S5) already types `tool: String` and documents `run_command`; this slice only begins emitting that variant.

## Review gate

- Tier: `L2` (adapters-tools enforcement, like S4). Tier justification: tool-surface enforcement logic over existing broker + tape primitives; no L0 surface touched.
- Roles satisfied: implementer TDD self-verify ✅ · independent review — **folded into the M3-GATE adversarial pass** (Opus reviewer + adversarial Codex + acceptance verifier over the full S7+S7b+S8 milestone-close diff, which exceeds the standalone L2 bar).
- Verdict: pending (M3-GATE review).

## PR gate

- Part of the single M3-close PR (S7 + S7b + S8). L1/L2 — admin-merge, no `buildplane:auto-merge`.

## Exceptions / caveats

- Argv0-only matching (per the broker's locked S2 semantics): the allowlist gates the first token; multi-token prefixes (`entry` then `${entry} `) are also honored by the broker. Finer-grained argument policy is out of scope.

## Next gate

- Next allowed action: M3-S8 (GATE) — integration test now covers run_command allow/deny too; then the comprehensive GATE review.
- Fresh context required before continuing: yes — GATE reviewers run in fresh context.
