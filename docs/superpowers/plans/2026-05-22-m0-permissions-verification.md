# M0 permissions verification + hardening

## Purpose

PR #113 already landed the core Claude Code unsafe-permissions gate:
`unsafeMode?: boolean`, default `unsafeMode = false`,
`--dangerously-skip-permissions` only when `unsafeMode` is true, and a
`claude-code-unsafe-mode-used` evidence event before spawning Claude Code.

This slice verifies and hardens that shipped boundary. It is not a
reimplementation of the PR #113 gate and it must not broaden worker authority.
Buildplane remains the trusted orchestration kernel; Claude Code, Codex, and
native host bridges remain untrusted worker surfaces whose spawn arguments and
authority shortcuts must be typed, auditable, and tested.

## Acceptance criteria

- All default Claude Code executor paths omit `--dangerously-skip-permissions`.
- `unsafeMode` absent and `unsafeMode: false` both emit no
  `claude-code-unsafe-mode-used` evidence.
- Explicit `unsafeMode: true` includes `--dangerously-skip-permissions` and
  records `claude-code-unsafe-mode-used` before the spawn call.
- Focused tests cover default-safe, explicit-false, and explicit-unsafe paths.
- Adjacent worker-spawn paths are audited for ambient bypass flags or equivalent
  authority shortcuts.
- This slice introduces no new ambient permission bypass, label policy,
  branch-protection change, PR automation change, worker dispatch, or deployment.
- Independent Reviewer review and Codex/adversarial review are required before
  any merge. Acceptable review verdicts are `PASS`, `REQUEST_CHANGES`,
  `BLOCKED_INSUFFICIENT_EVIDENCE`, `BLOCKED_UNSAFE_TO_RUN`, or
  `BASELINE_FAILURE`; only `PASS` should unblock PR handoff.

## Side-effect boundaries

Allowed:

- Read source, tests, docs, and native host stubs.
- Add this checked-in verification plan.
- Add focused tests for the existing Claude Code unsafe-mode contract.
- Run local verification commands.
- Create one local commit.

Not allowed without explicit operator approval:

- Push, create a PR, merge, deploy, or delete branches/worktrees.
- Edit `.github`, branch protection, auto-merge policy, or labels.
- Materialize PlanForge, write Kanban/GSD2 state, dispatch workers, or execute
  real Claude/Codex agent jobs.
- Patch generated `dist/` artifacts by hand.

## Audit method

Commands used to discover spawn and permission-relevant surfaces:

```bash
git grep -n "dangerously-skip-permissions\|unsafeMode\|bypassPermissions\|permission-mode\|claude-code\|codex\|spawn\|execa\|child_process\|Command::new" -- . ':!node_modules' ':!.git' ':!pnpm-lock.yaml'
git grep -n -e "--dangerously" -e "--permission-mode" -e "--allow-dangerously" -- . ':!node_modules' ':!.git'
git grep -n -e "Command::new" -e "std::process::Command" -e "duct::cmd" -e "xshell" -- native/crates native/packs || true
git grep -n -e "--full-auto" -e "full-auto" -- . ':!node_modules' ':!.git'
```

Primary files inspected:

- `packages/adapters-models/src/claude-code-executor.ts`
- `packages/adapters-models/test/claude-code-executor.test.ts`
- `packages/adapters-models/src/model-executor.ts`
- `packages/adapters-codex/src/codex-executor.ts`
- `packages/adapters-codex/test/codex-executor.test.ts`
- `apps/cli/src/run-cli.ts`
- `packages/kernel/src/run-loop.ts`
- `packages/kernel/src/packet.ts`
- `native/crates/bp-host-claude/src/lib.rs`
- `native/crates/bp-host-codex/src/lib.rs`
- `native/crates/bp-host-sdk/src/lib.rs`
- `scripts/ci/pr-auto-merge-eligibility.mjs`
- `scripts/published-bootstrap/verify-positive.mjs`
- `scripts/published-bootstrap/verify-wrong-node.mjs`

## Audit findings

| Surface | Classification | Finding |
| --- | --- | --- |
| `packages/adapters-models/src/claude-code-executor.ts` | Explicit unsafe path, covered | The dangerous Claude flag is constructed as `CLAUDE_UNSAFE_PERMISSION_FLAG` and pushed only inside `if (unsafeMode)`. `unsafeMode` defaults to `false`. The executor emits `claude-code-unsafe-mode-used` immediately before the Promise that calls `spawnFn`, so the unsafe path is observable before spawn. |
| `packages/adapters-models/test/claude-code-executor.test.ts` | Default-safe and explicit-unsafe coverage | Focused tests now assert absent `unsafeMode` and `unsafeMode: false` omit the flag and emit no unsafe evidence; explicit `unsafeMode: true` includes the flag and emits unsafe evidence before spawn. |
| `packages/adapters-models/src/model-executor.ts` | Irrelevant to Claude bypass | The SDK model executor does not spawn Claude/Codex CLIs. Command packets delegate to `@buildplane/runtime`; model packets use AI SDK streaming. No dangerous Claude permission flag or unsafe evidence surface found. |
| `packages/adapters-codex/src/codex-executor.ts` | Adjacent authority-relevant path | The Codex adapter spawns `codex` with `-q --model <model> --full-auto <prompt>`. No `--dangerously-*`, `--permission-mode`, `--allow-dangerously`, or `unsafeMode` surface exists there. `--full-auto` is authority-relevant and should receive a Codex-specific permissions contract before Codex is treated as a fully policy-mediated untrusted worker, but this slice does not introduce or broaden it. |
| `packages/adapters-codex/test/codex-executor.test.ts` | Adjacent coverage | Existing tests mock the Codex spawn boundary, shim resolution, prompt folding, and command-packet rejection. They do not cover the Claude unsafe-mode contract and were left unchanged for scope control. |
| `apps/cli/src/run-cli.ts` | Default-safe caller | CLI runtime wiring imports `createClaudeCodeExecutor()` with no options, so it uses the default `unsafeMode = false`. Routing to Claude/Codex is via `routingHints.preferredWorker`; no ambient dangerous Claude flag is injected at the CLI composition root. Other `spawn`/`spawnSync` sites run git/native ledger/fork helpers, not Claude/Codex permission bypass flags. |
| `packages/kernel/src/run-loop.ts` and `packages/kernel/src/packet.ts` | Typed routing only | Kernel packet types and parser restrict `routingHints.preferredWorker` to `"claude-code" | "codex"`. They carry no unsafe-mode, permission-mode, or bypass flag. |
| `native/crates/bp-host-claude/src/lib.rs` | Broker stub, no spawn | Native Claude host detection and bridge planning expose descriptors and activation environment only. `execute` returns `Unsupported`; no process spawn or dangerous permission flag is present. |
| `native/crates/bp-host-codex/src/lib.rs` | Broker stub, no spawn | Native Codex host detection and bridge planning expose descriptors and activation environment only. `execute` returns `Unsupported`; no process spawn or permission bypass flag is present. |
| `native/crates/bp-host-sdk/src/lib.rs` | Interface only | Defines host request/event/status types and traits. No spawn surface or bypass flag. |
| `native/crates/**`, `native/packs/**` | No Rust spawn call found | `git grep` found no `Command::new`, `std::process::Command`, `duct::cmd`, or `xshell` usage in native crates/packs. |
| `scripts/ci/pr-auto-merge-eligibility.mjs` | Irrelevant CI helper | Uses `execFileSync` for GitHub/git read-style eligibility checks. No Claude/Codex worker spawn or permission bypass flags. |
| `scripts/published-bootstrap/verify-positive.mjs` and `verify-wrong-node.mjs` | Irrelevant packaging verification | Use `spawnSync` to run local package verification commands. No Claude/Codex worker spawn or permission bypass flags. |

The only legitimate checked-in occurrence of the dangerous Claude flag in source
is the gated constant in `claude-code-executor.ts`, plus focused test fixtures
that construct the same string. Historical docs still mention the pre-PR #113
gap and are intentionally not source-of-truth for current behavior.

## Test and static-assertion decision

The focused `packages/adapters-models/test/claude-code-executor.test.ts` tests
exercise the public Claude executor entry point with a mocked `spawnFn`, inspect
the exact spawned argument vector, and observe event ordering through the
synchronous event bus. That covers the M0 Claude boundary directly, so this
slice does not add a separate static grep that would risk banning the legitimate
explicit unsafe escape hatch.

## Required local verification

```bash
git -c core.filemode=false diff --check
pnpm vitest --run packages/adapters-models/test/claude-code-executor.test.ts -t "unsafe"
pnpm typecheck
pnpm lint
```

Optional broader gates before PR handoff if operator time allows:

```bash
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
```

## Reviewer requirements

Reviewers must verify:

- The diff is limited to M0 permissions verification/hardening.
- No default path can inject `--dangerously-skip-permissions`.
- Explicit unsafe mode remains opt-in, includes evidence, and records evidence
  before spawn.
- No raw credentials or secret-shaped fixtures are added.
- The Codex `--full-auto` audit note is preserved as an adjacent follow-up, not
  hidden as a default-safe permission guarantee.
- No PlanForge materialization, worker dispatch, GitHub write, deploy, merge,
  branch deletion, or worktree cleanup side effect occurred.
