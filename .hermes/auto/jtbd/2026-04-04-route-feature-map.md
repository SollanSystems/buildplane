# Buildplane Feature-to-JTBD Map

> **Date:** April 4, 2026
> **Purpose:** Map every CLI command, package, and Rust crate to the core JTBD and recommend what to elevate, merge, de-emphasize, or cut.
> **Source:** Current repo state, system health report (699 tests), existing JTBD docs

---

## JTBD Anchor

> When I hand real software work to AI agents, I want a system that dispatches them safely, verifies results against defined standards, and carries forward everything it learns — so I can delegate with confidence instead of babysitting with anxiety.

---

## 1. Component Inventory

### CLI Commands

| Command | Job Served | Classification | Recommendation |
|---------|-----------|----------------|----------------|
| `buildplane init` | Bootstrap a project with state dir + SQLite | Supporting — necessary prerequisite | Keep, but make it zero-friction (auto-init on first `run` if not initialized) |
| `buildplane run --packet` | Dispatch a single unit of work | **CORE** — the primary Little Hire entry point | Elevate — make this the hero command, add `run --natural` (no packet needed) |
| `buildplane status` | Quick project health check | Supporting — operator visibility | Keep |
| `buildplane inspect` | Deep dive into a run's evidence | Supporting — trust/verification | Keep — this is the proof layer |
| `buildplane history` | List past runs | Supporting — recall/patterns | Keep |
| `buildplane replay` | Re-execute with optional model override | Supporting — reproducibility | Keep — useful for eval harness |
| `buildplane run-graph` | DAG execution of multiple units | **CORE** — multi-unit orchestration | Elevate — this is where the system earns its keep vs raw agents |
| `buildplane run-strategy` | Implement-then-review / adversarial modes | **CORE** — quality through orchestration | Elevate — the differentiator. Should be the default path |
| `buildplane memory ...` | Scoped memory CRUD via Rust bridge | **CORE** — the self-learning loop | Elevate critically — currently schema-ready, unwired |
| `buildplane pack show` | Inspect pack definitions | Supporting — pack discovery | Keep |
| `buildplane install/uninstall` | Pack lifecycle management | Supporting — ecosystem building | De-emphasize until packs are a real thing people share |

### TypeScript Packages (Main Workspace — 13 packages, 513 tests)

| Package | Job Served | Classification | Recommendation |
|---------|-----------|----------------|----------------|
| `kernel` | Core types, orchestrator, event bus, packet parsing | **CORE** — the system is the kernel | Keep as-is, well-architected |
| `storage` | SQLite state, filesystem evidence, event store | **CORE** — durable state + audit trail | Keep |
| `runtime` | Command execution, session lifecycle | **CORE** — worker execution | Keep |
| `policy` | Verification contracts, run evaluation | **CORE** — trust gates | **Harden urgently** — this is the thesis but thinnest layer |
| `adapters-models` | AI SDK streaming, provider abstraction | Core — multi-provider support | Keep |
| `adapters-codex` | Codex CLI integration | Core — agent-agnostic execution | Keep |
| `adapters-honcho` | Honcho memory bridge | Core — memory retrieval | **Wire fully** — exists but cold path unwired |
| `adapters-tools` | Tool execution helpers | Supporting — needed for real autonomous work | Build — empty stub is a blocker for model units doing real work |
| `adapters-git` | Git integration (worktrees) | Core — execution isolation | Build — empty stub is a blocker for safe parallelism |
| `compat-gsd` | Migration from .gsd/ legacy format | Distracting — legacy compat | De-emphasize until there are actual GSD users to migrate |
| `ui-tui` | React/Ink terminal UI | Supporting — operator visibility | Build — skeleton exists, needs to show real state |

### TypeScript Packages (Root Workspace — 11 packages, 91 tests)

The root workspace is a **strict subset** of main. Every package in root has a more-featured counterpart in main.

| Package in Root | Status vs Main | Recommendation |
|-----------------|---------------|----------------|
| `kernel` | Exists identically in main + more | Merge into main; root should be a published bootstrap only |
| `storage` | Exists in main with memory tables | Merge into main |
| `runtime` | Exists in main | Merge into main |
| `policy` | Exists in main with strategy support | Merge into main |
| `adapters-models` | Exists in main | Merge into main |
| `adapters-tools` | Stub in both | Eliminate from root entirely |
| `adapters-git` | Stub in both | Eliminate from root entirely |
| `compat-gsd` | Stub in both | Eliminate from root entirely |
| `ui-tui` | Exists in main | Merge into main |
| `test-support` | Exists in main | Merge into main |
| `cli` | Main has 8 additional commands | Root CLI is obsolete; merge into main |

**Verdict on root:** It was useful as a minimal kernel contract during early development. Now it's dead weight. Every package boundary that exists in both places creates confusion about "which one is the real one."

### Rust Crates (18 crates, 95 tests)

| Crate | Job Served | Classification | Recommendation |
|-------|-----------|----------------|----------------|
| `bp-memory` | Memory domain model (scopes, kinds, promotion, forgetting) | **CORE** — the self-learning system | Keep — well-designed domain model |
| `bp-storage-sqlite` | 4 tables, FTS5 for memory persistence | **CORE** — durable memory | Keep |
| `bp-pack-manifest` | pack.toml parsing | Supporting — pack ecosystem | Keep |
| `bp-host-registry` | Claude/Codex detection | Supporting — host-aware runtime | Keep, but consolidate with TS adapter logic |
| `bp-host-claude` | Claude Code detection + execution seams | Core — host integration | Keep |
| `bp-host-codex` | Codex detection + execution seams | Core — host integration | Keep |
| `bp-host-sdk` | Host SDK interfaces | Supporting — extensibility | Keep but minimize until there are actual third-party hosts |
| `bp-provider-anthropic` | Anthropic provider interface | **STUB** — interfaces only | De-emphasize until TS adapters prove the pattern in production |
| `bp-provider-openai` | OpenAI provider interface | **STUB** — interfaces only | De-emphasize until TS adapters prove the pattern in production |
| `bp-provider-sdk` | Provider SDK interfaces | **STUB** — supporting stubs | De-emphasize until providers earn their keep |
| `bp-cli` | Rust CLI entry | Supporting — native command bridge | Keep — needed for memory/pack commands |
| `bp-config` | Configuration management | Supporting — infrastructure | Keep |
| `bp-core` | Shared core types | Core — Rust foundation | Keep |
| `bp-runtime` | Rust runtime execution | Core — Rust execution layer | Keep |
| `bp-pack-loader` | Pack loading | Supporting — pack ecosystem | Keep |
| `bp-pack-inspection` | Pack inspection | Supporting — pack ecosystem | Keep |
| `bp-ui-terminal` | Terminal UI (Rust) | Supporting — overlaps with TS ui-tui | Merge or choose one; two TUIs is wasteful |
| `bp-test-support` | Test utilities | Supporting — infrastructure | Keep |

---

## 2. What to Elevate

### Priority 1: Memory Wiring (Cold Path)
The memory system (`bp-memory` + `bp-storage-sqlite` + `adapters-honcho`) is the single most important investment. Stages 1-3 of the flywheel are live. Stages 4-7 have schema and domain types but no wiring. This is the difference between a dispatcher and a self-learning system.

**Specific actions:**
- Wire run outcome → memory extraction → scoped writeback
- Wire retrieval → prompt injection via `HonchoPort.fetchContext()`
- Wire promotion (rule-based agent that lifts session facts to workspace memory)
- Add visible evidence: "This run used 3 memories from previous runs"

### Priority 2: `run-strategy` as the Default Path
The implement-then-review strategy is Buildplane's strongest differentiator vs raw agents. It should be the default execution mode, not a special command. When someone runs `buildplane run`, they should get quality-checked output, not raw model output.

**Specific actions:**
- Make strategy the default, not opt-in
- Add a `--raw` flag for bypassing strategy (power user escape hatch)
- Default to implementing in a worktree, running verification, then presenting results

### Priority 3: Policy Layer Teeth
Verification contracts exist but only check exit codes and file existence. Need:
- Token/cost budgets that actually stop agents mid-execution
- Trust gates that require operator approval before destructive actions
- Retry logic with configurable backoff
- Stop rules (kill run if N consecutive failures)

### Priority 4: Graph Scheduler Visibility
The DAG scheduler works but needs operator visibility. When multiple units are executing, the operator should see: which nodes ran, which are pending, which failed, what the dependency graph looks like.

---

## 3. What to Merge

### Root → Main Consolidation
The root workspace should become a **published bootstrap** only — a minimal package that installs the CLI and delegates to the main implementation. All 11 root packages should be collapsed:

1. Move all root test suites into main's test structure
2. Root's `package.json` becomes a thin wrapper that re-exports main
3. The 91 tests in root are already covered by main's 513 tests — eliminate duplication
4. Keep root only if it serves as the npm-published entry point; otherwise, make main the root

### Specific Package Merges:
- `bp-ui-terminal` (Rust) + `ui-tui` (TS) → Choose one. TS has React/Ink ecosystem advantage. Unless the Rust TUI has capabilities TS cannot match, cut the Rust version.
- `bp-host-registry` + TS host detection → Consolidate. Two detection systems for the same hosts is redundant.
- `adapters-tools` (stub in both root and main) → Build in main, delete from root.

---

## 4. What to De-emphasize or Cut

### Cut Immediately:
- **Root workspace duplicate packages** — pure overhead. If root exists, it should be a published bootstrap wrapper only.
- **`compat-gsd`** — empty stub with no users. Build it when there's someone to migrate.
- **`bp-provider-*` stubs** — interfaces without implementations. The pattern is proven in TS; port when needed, not before.

### De-emphasize:
- **`bp-host-sdk`** — third-party host support is premature. Focus on Claude Code and Codex first.
- **`bp-pack-inspection`** vs **`bp-pack-loader`** — these could be one crate until pack parsing becomes complex enough to justify separation.
- **`buildplane install/uninstall`** — pack lifecycle commands before there's a pack ecosystem is putting the cart before the horse.

### Watch Closely:
- **Rust `bp-ui-terminal`** — if the TS TUI gets built out, this crate becomes redundant. Monitor.
- **`bp-test-support`** as a separate crate — could be merged into `bp-memory` or `bp-storage-sqlite` tests unless there's significant cross-crate test infrastructure.

---

## 5. CLI IA/Navigation Recommendations

### Current State
12 commands, flat hierarchy. No grouping. A new user sees all 12 commands and doesn't know which matter.

### Proposed Structure

```
buildplane run [options]              # Hero command — dispatch work
  --strategy <mode>                   # implement-then-review, adversarial, parallel
  --graph <path>                      # DAG execution
  --raw                               # bypass strategy, raw agent access
  --model <provider/model>            # override model

buildplane memory [subcommand]        # Memory system
  list [--scope]                      # list memories
  show <id>                           # show a memory
  archive <id>                        # archive a memory
  forget <id>                         # delete a memory
  promote <id>                        # promote to higher scope

buildplane inspect <run-id>           # Deep dive
buildplane history [options]          # Run history
buildplane status                     # Quick health check

buildplane pack [subcommand]          # Pack management (secondary)
  show <name>
  list
  install <name>
  uninstall <name>
  publish <name>

buildplane init                       # Bootstrap (auto-invoked if needed)
```

**Key changes:**
- `run` is the hero. Everything else is supporting.
- Memory gets its own subcommand group with a clear CRUD surface.
- Pack commands are grouped and marked as secondary (ecosystem, not core).
- Add `buildplane demo` — a single command that proves the system works in < 60 seconds.

---

## 6. Top Little-Hire Improvements

The Little Hire decision is: "Should I use Buildplane for this, or just open Claude Code directly?"

| Improvement | Impact on Little Hire | Why |
|-------------|----------------------|-----|
| Auto-init on first `run` | Reduces friction | Removes the "I need to init first" step |
| `buildplane run "fix the lint errors"` | Eliminates packet writing | Natural language is the barrier between intent and execution |
| Memory carryover visible in output | Proves value immediately | "This run used 3 memories from yesterday" is the killer moment |
| `buildplane demo` | One-command proof | Clone sample repo → run → verify → show memory carryover in 60s |
| Strategy as default | Better output quality | Raw agent output is unverified; strategy output is quality-checked |
| TUI that shows live state | Operator confidence | Seeing is believing; JSON through jq is not confidence-inspiring |

---

## 7. Prioritized Highest-Leverage Product Changes

1. **Cold path wiring** — Memory flywheel stages 4-7. This is the product.
2. **Consolidate root → main** — One workspace, one mental model, less maintenance.
3. **Natural language run entry** — `buildplane run "description"` without requiring a packet file.
4. **Policy enforcement with teeth** — Budgets that stop, gates that alert, rules that enforce.
5. **Ship the demo experience** — Proof in 60 seconds, zero config.
6. **Build the eval harness** — Benchmark vs raw agents. You need data to win trust.
7. **Complete the tool adapter** — Model units can't do real work without shell/file/search execution.
8. **Complete the git adapter** — Worktree isolation is the safety net for parallelism.
9. **TUI for operator inspection** — Make the system visible, not just inspectable.
10. **Database migrations** — Version the SQLite schema so upgrades don't break existing projects.

---

## 8. Root vs Main Workspace Analysis

**Is it helping or hurting? Currently hurting.**

The root workspace was useful during early development as a minimal kernel contract. But now:
- 91 tests are a strict subset of 608 tests — the root is tested twice
- Package boundaries are confusing — "which kernel do I import?"
- Maintenance cost is real — every change must be made in two places or risk divergence
- Cognitive overhead — new contributors must understand why two workspaces exist

**Recommendation:** Make main the only workspace. If a minimal published bootstrap is needed for npm, create a single `buildplane` package in main that installs and delegates. The root directory can contain only: README, LICENSE, package.json (workspace root pointing to main/), and top-level config (biome, vitest, changesets).

---

## 9. Rust Crates vs TS Packages — What Earns Its Keep?

### Crates that earn their keep TODAY:
- `bp-memory` — Rich domain model with scopes, kinds, promotion, forgetting. Better than what TS could offer due to Rust's type system for the state machine.
- `bp-storage-sqlite` — FTS5 integration, proper schema. The memory store needs to be fast and reliable.
- `bp-host-claude` / `bp-host-codex` — Host detection and execution seams. If the host-aware runtime is the future, these are critical.
- `bp-pack-manifest` — pack.toml parsing needs to be fast and reliable for the pack ecosystem.

### Crates that are premature:
- `bp-provider-anthropic` / `bp-provider-openai` — STUBS. The provider interfaces exist in TS and work. Porting to Rust before proving the TS pattern in production is putting the cart before the horse.
- `bp-provider-sdk` — STUB for a feature that doesn't exist yet.
- `bp-host-sdk` — Third-party host support is not the bottleneck. Claude Code and Codex are the targets.

### The honest assessment:
The Rust layer is beautiful engineering. It's also the highest-maintenance part of the system and the furthest from shipping user value. The TS kernel is where execution happens today. The memory domain model in Rust is well-designed, but until it's wired into the hot path, it's potential energy, not kinetic.

**Rule of thumb:** If a Rust crate doesn't directly serve the memory system or host detection, question whether it needs to be in Rust at all. The 80/20 split should be: 80% of user-facing value in TS (where execution happens), 20% in Rust (where performance and type safety matter most — memory domain model, host detection, pack parsing).

---

## 10. Summary

| Category | Recommendation |
|----------|---------------|
| **Elevate** | Memory wiring (cold path), `run-strategy` as default, policy enforcement, graph scheduler visibility |
| **Merge** | Root → main consolidation, unify duplicate packages, choose one TUI |
| **Keep** | Kernel, storage, runtime, bp-memory, bp-storage-sqlite, host-claude/codex, adapters-codex/honcho |
| **De-emphasize** | Provider stubs, host-sdk, pack install/uninstall commands |
| **Cut** | Root workspace duplicate packages, compat-gsd (no users), bp-ui-terminal (if TS TUI is chosen) |
| **Build** | Tool adapter, git adapter, natural language run entry, demo experience, eval harness, database migrations |
