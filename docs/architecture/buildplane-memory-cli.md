# Buildplane Memory CLI Contract

Date: 2026-04-01
Status: Proposed v1 command contract

This document defines the operator-facing memory command surface for Buildplane.

Current command shape under active development:

```bash
buildplane memory ...
```

Current implementation and verification boundary:
- `buildplane memory ...` now dispatches from the TypeScript CLI into the native Rust memory runner; the bridge lives in `apps/cli/src/run-cli.ts`
- the native workspace remains the active memory implementation today
- the native implementation is still directly invokable as `buildplane-native memory ...` or `cargo run --manifest-path native/Cargo.toml -p bp-cli -- memory ...`
- repo-local `pnpm buildplane memory ...` and in-repo built `node apps/cli/dist/index.js memory ...` are the currently verified bridge surfaces
- packaged/global `npm install -g buildplane` does not yet make `buildplane memory ...` a verified public contract because the published package does not bundle or provision the native binary
- native binary discovery currently happens in this order: `BUILDPLANE_NATIVE_BIN`, `native/target/debug/buildplane-native` relative to the current working directory, `native/target/release/buildplane-native` relative to the current working directory, then `buildplane-native` on `PATH`
- the current `pack show` command remains an earlier inspection seam for host-aware runtime routing, not the finished memory contract

## Command design principles

- inspect before mutate
- soft delete before hard delete
- always show scope and provenance
- JSON output should be available everywhere
- destructive actions should support `--dry-run`
- the operator should be able to answer: what is stored, why is it visible, and how do I remove or promote it?

## Primary command groups

Read commands:
- `inspect`
- `list`
- `search`
- `explain`

Write commands:
- `remember`
- `edit`
- `forget`
- `restore`
- `promote`

Operational commands:
- `export`
- `import`
- `prune`
- `doctor`

## Core commands

### 1. Inspect

Show one memory item or the effective visible memory set for a context.

Examples:

```bash
buildplane memory inspect mem_01HXYZ
buildplane memory inspect --scope workspace
buildplane memory inspect --pack superclaude
buildplane memory inspect --workspace /path/to/buildplane
buildplane memory inspect --effective --pack supercodex
buildplane memory inspect mem_01HXYZ --json
```

Recommended flags:
- `--scope user|workspace|pack|session|all`
- `--pack <pack-id>`
- `--workspace <path>`
- `--session <session-id>`
- `--effective`
- `--include-forgotten`
- `--json`
- `--yaml`

Expected behavior:
- if given an id, print full details, provenance, and links
- if given `--effective`, show the ranked memory set that would apply for the current context
- include the explanation for why each item was surfaced

Suggested human output shape:

```text
ID: mem_01HXYZ
Title: Prefers deep mode for planning
Scope: user:global
Kind: preference
Status: active
Source: user
Applicable packs: all
Created: 2026-04-01T18:00:00Z
Last used: 2026-04-01T18:42:00Z

Body:
Use deep mode by default for planning, strategy, and architecture tasks.
```

### 2. Forget

Remove a memory item from active retrieval.

Examples:

```bash
buildplane memory forget mem_01HXYZ
buildplane memory forget mem_01HXYZ --reason "No longer true"
buildplane memory forget --query "structured planning prompts" --scope pack --pack superclaude
buildplane memory forget mem_01HXYZ --hard --yes
buildplane memory forget mem_01HXYZ --dry-run
```

Recommended flags:
- `--reason <text>`
- `--hard`
- `--yes`
- `--dry-run`
- `--scope ...`
- `--pack ...`
- `--query ...`

Expected behavior:
- default path is soft delete: mark item as `forgotten`
- create a `forget` event in the audit log
- hard delete requires explicit confirmation or `--yes`
- query-based forget should print matches before mutating anything

### 3. Promote

Promote a memory item into a broader scope.

Examples:

```bash
buildplane memory promote mem_01HXYZ --to workspace --workspace /path/to/buildplane
buildplane memory promote mem_01HXYZ --to user
buildplane memory promote mem_01HXYZ --to workspace --copy
buildplane memory promote mem_01HXYZ --to user --title "Prefers rollback-safe execution"
buildplane memory promote mem_01HXYZ --to user --reason "Observed across Claude and Codex workflows"
```

Recommended flags:
- `--to user|workspace|pack`
- `--workspace <path>`
- `--pack <pack-id>`
- `--copy`
- `--move`
- `--reason <text>`
- `--title <text>`
- `--kind <kind>`
- `--applicable-packs all|superclaude,supercodex`

Expected behavior:
- default should be copy, not move
- the new row gets a new id
- `promoted_from_id` points at the original item
- the CLI should print the source and destination scope clearly

## Supporting commands

### Remember

Create a memory item explicitly.

Examples:

```bash
buildplane memory remember "User prefers concise output" --scope user --kind preference
buildplane memory remember "Repo uses pnpm + turbo" --scope workspace --kind fact
buildplane memory remember "Use structured planning sections" --scope pack --pack superclaude --kind provider_heuristic
```

### Search

Search across visible or scoped memory.

Examples:

```bash
buildplane memory search "planning mode"
buildplane memory search "claude prompt" --scope pack --pack superclaude
buildplane memory search "workspace conventions" --workspace /path/to/buildplane --json
```

### Explain

Explain why an item or set of items is visible.

Examples:

```bash
buildplane memory explain mem_01HXYZ
buildplane memory explain --effective --pack superclaude
```

This is the trust command. It should answer:
- why did this item rank?
- what scope did it come from?
- what retrieval rule made it apply?
- what item did it override or get overridden by?

### List

List rows by scope without full detail.

Examples:

```bash
buildplane memory list --scope workspace
buildplane memory list --pack supercodex
```

### Restore

Bring back a forgotten item.

```bash
buildplane memory restore mem_01HXYZ
```

### Edit

Edit title, body, tags, or metadata.

```bash
buildplane memory edit mem_01HXYZ --body "Updated content"
buildplane memory edit mem_01HXYZ --title "Updated title" --tags planning,workflow
```

### Export / Import

Allow backup and migration.

```bash
buildplane memory export --scope workspace --out workspace-memory.json
buildplane memory import workspace-memory.json
```

### Prune

Clear expired or stale entries.

```bash
buildplane memory prune --expired
buildplane memory prune --session --older-than 14d
```

### Doctor

Health-check the memory store.

```bash
buildplane memory doctor
```

Checks should include:
- FTS sync
- broken links
- orphaned promoted rows
- expired session items
- duplicate rows with identical hashes

## Common flags

These should work consistently where relevant:

- `--scope`
- `--workspace`
- `--pack`
- `--session`
- `--json`
- `--yaml`
- `--dry-run`
- `--yes`

## UX defaults

- every printed item should show `Scope`, `Kind`, `Status`, and `Source`
- `forget` should default to soft delete
- `promote` should default to copy
- `inspect --effective` should become the primary debug tool for memory retrieval
- any command that mutates multiple items should summarize the impact before execution

## Suggested phased rollout

Phase 1:
- `inspect`
- `search`
- `remember`
- `forget`
- `promote`
- `restore`

Phase 2:
- `explain`
- `edit`
- `list`
- `prune`

Phase 3:
- `export`
- `import`
- `doctor`

## Mapping to current repo

- `native/crates/bp-cli` should own the native subcommand wiring
- `native/crates/bp-ui-terminal` should own human-readable renderers
- `native/crates/bp-memory` should own memory use cases and retrieval explanations
- `native/crates/bp-storage-sqlite` should back the default local persistence layer
- the current TypeScript CLI already forwards `buildplane memory ...` into the native implementation for repo-local and in-repo built CLI flows, and the published/global contract should stay de-scoped until the native binary is bundled or otherwise provisioned

The main product promise is simple: memory must be operator-visible, operator-correctable, and never spooky.