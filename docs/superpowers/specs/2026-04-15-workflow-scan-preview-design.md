# Workflow Scan Preview — Design

**Date:** 2026-04-15
**Scope:** Phase 4 / Slice 4A — workflow import for Claude Code / Codex configs

## Summary

The smallest useful Slice 4A is not a full import/apply system. It is a read-only scan/preview seam:

- `buildplane workflow scan`
- `buildplane workflow scan --json`

This command previews which Claude Code / Codex workflow surfaces Buildplane can recognize in the current workspace without writing anything.

## Why this slice

Phase 4 is about reducing habit friction without widening immediately into installer/bootstrap work. A scan-first slice is the smallest closed loop because it:

- gives users immediate evidence that Buildplane understands their existing setup
- creates a stable CLI seam for a later apply/import slice
- avoids storage mutation and later-slice bootstrap concerns
- fits cleanly into the existing TypeScript CLI surface without touching native packaging

This is safer and smaller than:
- a real importer that writes into `.buildplane`
- a published install/bootstrap change
- a doctor/prerequisite checker

## Proposed command surface

### `workflow scan [--json]`

Behavior:
1. inspect the current working directory for a small allowlist of workflow files
2. ignore secrets/state/log files
3. classify recognized files into a normalized preview shape
4. emit either JSON or compact human output
5. never require `.buildplane/state.db` or orchestrator initialization

This command should be handled before orchestrator loading, similar to the existing read-only `memory list` / `workspace list` style dispatch.

## Data model

Add a small scanner helper module, for example:

- `apps/cli/src/workflow-scan.ts`

Recommended record shape:

```ts
interface WorkflowScanFinding {
  path: string;
  source: "claude" | "codex" | "shared";
  kind: "instructions" | "config" | "hooks";
}
```

The first slice should avoid storing file contents in the preview payload. Path + classification is enough to create trust and a stable apply seam later.

## Scan rules

### Included targets

- `CLAUDE.md` -> `shared/instructions`
- `AGENTS.md` -> `shared/instructions`
- `.claude/settings.json` -> `claude/config`
- `.claude/settings.local.json` -> `claude/config`
- `.claude/hooks/*` -> `claude/hooks`
- `.codex/config.toml` -> `codex/config`
- `.codex/AGENTS.md` -> `codex/instructions`

### Ignored examples

- `.claude/auth.json`
- `.claude/*.log`
- `.codex/auth.json`
- `.codex/*.log`
- session history, sqlite/db/state artifacts, caches

### Ordering

Sort findings deterministically by:
1. source family order: shared, claude, codex
2. kind order: instructions, config, hooks
3. relative path

## Output design

### JSON

Return a simple object such as:

```json
{
  "preview": true,
  "findings": [ ... ]
}
```

### Human

Print a compact operator summary:
- headline count
- one line per finding
- final note that nothing was imported or modified

Example:

```text
workflow-findings: 4
  - [shared/instructions] CLAUDE.md
  - [claude/config] .claude/settings.json
  - [claude/hooks] .claude/hooks/pre_tool_use.py
  - [codex/config] .codex/config.toml
preview-only: no workflow data was imported
```

## Likely files

- `apps/cli/src/run-cli.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/src/workflow-scan.ts` (new)
- `apps/cli/test/workflow-scan.test.ts` (new)
- `apps/cli/test/run-cli.test.ts`

## Non-goals

- applying findings into `.buildplane`
- storing findings in memory/storage tables
- parsing every provider-specific nested config setting
- scanning outside the current workspace root
- README/bootstrap work in this slice unless a tiny command-surface note becomes unavoidable
