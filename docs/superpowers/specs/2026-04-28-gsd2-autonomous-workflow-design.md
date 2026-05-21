# GSD-2 Autonomous Workflow Design

## Slice name

GSD-2 V0 docs and schema contract

## Status

Proposed architecture contract plus Milestone 1 skeleton. This slice defines the initial schemas and boundaries, and includes the first non-executing `gsd2` CLI implementation and tests.

## Thesis

GSD-2 is the repo-local state and admission layer for autonomous work. It is not the worker, not the chat, and not the execution backend.

Its job is to decide what work exists, whether it is safe to run, what envelope constrains it, where it should execute, what evidence is required, and what recovery path exists if the run fails.

## Ownership model

### GSD-2 owns

- repo-local project/task state
- task queue and task IDs
- priority and dependency metadata
- task envelopes
- admission decisions
- routing decisions
- operator-visible progress views
- links to evidence artifacts and backend run IDs
- next-action recommendations
- receipt status lines

GSD-2 does not own worker cognition or backend execution internals.

### `/auto-coder` owns

- the single operator-facing front door for serious autonomous coding/build work
- context packet discipline
- task envelope discipline
- clarity mode and route ladder
- wrapper-first preference for serious slices
- final PR-ready summary style

GSD-2 must feed `/auto-coder`; it must not replace it with a competing slash skill, shell, or prompt surface.

### `task-kernel` and worktree-kernel own

- deterministic local slice lifecycle
- isolated worktree preparation
- task packet materialization
- assumptions/interview/spec ingestion
- one bounded writer pass
- real verification receipts
- staged review receipts
- acceptance receipts
- fail-closed finalization
- local archive/ledger of kernel artifacts

GSD-2 can map an envelope into a worktree-kernel task packet, but the kernel remains the authority on whether that local slice passed.

### Buildplane owns

- typed run packets
- event tape
- durable run state
- evidence capture
- policy evaluation
- inspect/status/history surfaces
- replay from stored packet snapshots
- fork from unit boundaries with corrected packets
- serious-mode provenance and recovery story
- worker/provider/pack/host routing transparency where implemented

GSD-2 can route a serious-mode task to Buildplane and store Buildplane run IDs, inspect summaries, replay commands, fork commands, and evidence refs. Buildplane remains the authority for its own event tape and run provenance.

### tmux owns

- process continuity
- pane layout
- detached long-running sessions
- log/tail ergonomics
- reattachment after terminal loss

tmux is not a sandbox, policy gate, verifier, or receipt authority. A task is not successful because a tmux process stayed alive.

### Skills own

- stable procedural doctrine
- repo-specific pitfalls
- verified command patterns
- reusable lessons after verified runs

Skills must not become task-progress ledgers. GSD-2 stores task progress; skills store reusable procedure.

### Static tools own

Static tools such as fallow can produce evidence inputs:

- dead-code candidates
- duplicate logic candidates
- circular dependency evidence
- complexity hotspots
- architecture drift signals

They do not own deletion/refactor authority. Any mutation from static-analysis evidence requires a normal task envelope and verification contract.

## Minimal V0 repository layout

```text
.gsd2/
  PROJECT.md
  STATE.md
  QUEUE.md
  config.yaml
  tasks/
    G2-0001/
      task.md
      envelope.yaml
      receipt.yaml
```

### `PROJECT.md`

Human-readable project contract:

- project name and purpose
- authoritative repo/remote
- naming conventions
- safety defaults
- preferred verification commands
- backend availability notes

### `STATE.md`

Human-readable current operating snapshot:

- current milestone or focus
- current recommended next task
- active blocked tasks
- recently completed task IDs
- known environment caveats

### `QUEUE.md`

Human-readable task queue:

- ordered candidate tasks
- task IDs or placeholders
- status labels
- dependency notes
- route hints

### `config.yaml`

Repo-local defaults:

```yaml
version: 0
project:
  name: buildplane
  authority: github
  expected_remote: https://github.com/SollanSystems/buildplane.git
routing:
  default_front_door: auto-coder
  small_task_mode: direct
  serious_mode: buildplane
  local_verified_mode: worktree_kernel
safety:
  no_push_by_default: true
  no_deploy_by_default: true
  no_secret_edits_by_default: true
verification:
  stop_on_failure: true
```

### `task.md`

Human-readable task brief:

- goal
- why now
- context links
- acceptance criteria
- out-of-scope items

### `envelope.yaml`

Machine-oriented task envelope. V0 schema is below.

### `receipt.yaml`

Machine-oriented final or current status receipt. V0 schema is below.

## Task envelope schema

V0 envelope shape:

```yaml
id: G2-0001
status: NEW
created_at: "2026-04-28T16:26:35Z"
updated_at: "2026-04-28T16:26:35Z"

goal: "One sentence outcome."

repo:
  path: "/absolute/path/or/repo-relative"
  authority: "github|mac|wsl|local-worktree"
  base_ref: "origin/main"
  expected_remote: "https://github.com/SollanSystems/<repo>.git"
  source_of_truth: "Live GitHub main plus repo docs."

context:
  source_docs:
    - path: "README.md"
      reason: "front-door product contract"
  assumptions:
    - text: "Implementation happens in a clean worktree."
      evidence: "buildplane-dev-worktree skill"
      confidence: high
  unresolved_questions: []

scope:
  allowed_paths:
    - "src/..."
    - "test/..."
  forbidden_paths:
    - ".env"
    - "secrets/"
    - "deploy/"
  out_of_scope:
    - "push"
    - "deploy"
    - "secret rotation"

routing:
  mode: "planning_only|direct|worktree_kernel|buildplane|manual_recovery"
  front_door: "auto-coder"
  backend: "none|worktree-kernel|buildplane"
  tmux: false
  model_policy:
    director: "gpt-5.5-high-or-xhigh"
    writer: "gpt-5.3-codex"
    helper: "gpt-5.4-mini"
  tool_policy:
    writer: ["terminal", "file"]
    reviewer: ["file"]
    helper: ["file"]

done_when:
  - "Concrete acceptance outcome."

verification:
  commands:
    - "git diff --check"
  static_analysis:
    fallow: false
  stop_on_failure: true

review:
  required_tiers:
    - "spec_scope"
    - "quality_security"
    - "evidence_acceptance"

recovery:
  max_attempts: 2
  after_failed_attempts: "stop_and_rethink"
  allowed_actions:
    - "retry_with_tighter_context"
    - "fresh_worktree"
    - "buildplane_replay"
    - "buildplane_fork"
    - "manual_escalation"
```

## Receipt schema

V0 receipt shape:

```yaml
task_id: G2-0001
run_id: null
backend: "none|direct|worktree-kernel|buildplane"
final_status: "PASSED|BLOCKED|FAILED"
checked_by: "operator|agent|reviewer"
checked_at: "2026-04-28T16:26:35Z"

verification:
  required_complete: false
  commands:
    - command: "git diff --check"
      exit_code: 0
      result: PASS
      evidence_ref: "terminal output or artifact path"

acceptance:
  explicitly_checked: false
  criteria:
    - criterion: "Acceptance statement."
      passed: false
      evidence_refs: []

reviews:
  spec_scope: "not_run|passed|blocked|failed"
  quality_security: "not_run|passed|blocked|failed"
  evidence_acceptance: "not_run|passed|blocked|failed"

artifacts:
  - path: "docs/..."
    kind: "doc|diff|log|build|test|ledger|inspect"
    summary: "What this artifact proves."

unresolved_findings: []
recovery_next_step: null
notes: []
```

## Fail-closed semantics

`PASSED` requires all of the following:

1. Every required verification command ran or a documented equivalent was explicitly accepted by the controller.
2. Every acceptance criterion was explicitly checked.
3. Spec-derived acceptance criteria have passing receipts where present.
4. Material review findings are resolved.
5. The receipt does not overclaim backend capability.
6. Evidence refs point to real commands, artifacts, Buildplane run IDs, or kernel receipts.

If any of those are missing, the task is not `PASSED`.

`BLOCKED` means execution or verification cannot safely continue without new information, environment repair, or operator decision.

`FAILED` means the bounded attempt reached a negative result and automatic retry is not justified without a new task or recovery plan.

## Route ladder

### 1. `planning_only`

Use for requirements, design, strategy, and task planning. No worker execution. Verification is usually document inspection plus `git diff --check`.

### 2. `direct`

Use for small, low-risk edits in the current operator session when a full kernel slice would be wasteful. Must still use exact verification and a receipt.

### 3. `worktree_kernel`

Use for normal serious coding where deterministic local task packets, verification receipts, staged review, and fail-closed finalization are enough.

### 4. `buildplane`

Use when a run needs durable event tape, inspect/replay/fork/recovery, provenance, worker-agnostic routing, or long-run control-plane evidence.

### 5. `manual_recovery`

Use when state is contradictory, the intended source of truth is unclear, the worktree is dirty in unsafe ways, or automation would increase risk.

## Buildplane path distinction

GSD-2 must preserve three separate Buildplane contracts:

- Repo-development: `pnpm buildplane ...` from a repo checkout.
- In-repo built CLI: `node apps/cli/dist/index.js ...` after `pnpm build`.
- Published/global: `buildplane ...` after installation.

Receipts must state which path produced evidence. Native-backed memory and ledger support must be treated as repo-local or native-binary-dependent unless the published/global path is explicitly verified.

## Milestone 1 design boundary

Milestone 1 implements only a CLI skeleton that can manage `.gsd2` state without executing workers.

Allowed Milestone 1 commands:

```bash
gsd2 status
gsd2 new
gsd2 validate
gsd2 run --dry-run
```

Forbidden in Milestone 1:

- spawning Hermes, Codex, Claude, or Buildplane workers
- calling worktree-kernel mutating wrappers
- running Buildplane packets
- creating tmux sessions
- pushing or deploying

`gsd2 run --dry-run` only previews the selected route and required evidence.

## Verification strategy for this contract and skeleton slice

This contract and Milestone 1 skeleton slice should be verified with:

```bash
git diff --check
pnpm exec vitest --run apps/cli/test/gsd2.test.ts test/workflow/gsd2-contract.test.ts test/workflow/control-plane-plan-contract.test.ts
pnpm gsd2 --help
pnpm lint
pnpm typecheck
pnpm build
```

The focused Vitest command proves the GSD-2 schema, CLI skeleton, and documentation contract directly. The live `pnpm gsd2 --help` command proves the repo-local script surface is wired, and a temp-workspace smoke can exercise `new`, `status`, `validate`, and `run --dry-run` without dirtying the repo. The wider lint, typecheck, and build commands prove the new skeleton fits the existing workspace.
