# Workspace List and Cleanup Commands — Design

**Date:** 2026-04-14
**Scope:** Phase 3 / Slice 3B — retained-workspace recovery/status commands

## Summary

The smallest useful Slice 3B is to add a dedicated workspace namespace with two commands:

- `buildplane workspace list`
- `buildplane workspace cleanup <run-id>`

This creates the smallest closed operator loop for retained workspaces:
- discover leftovers
- inspect or manually recover what is needed
- clean them up explicitly

## Why this slice

Current Buildplane code already has most of the read path:
- durable workspace rows
- `status` summaries
- `inspect` workspace metadata
- newest-first `actionableWorkspaces`

What is missing is the operator action surface.

This is smaller and safer than other interpretations of Slice 3B because it avoids:
- resuming execution from retained workspaces
- merge/apply/cherry-pick workflows
- reconciliation for active runs
- new TUI or replay behavior

## Proposed behavior

### 1. `workspace list`

Source of truth:
- existing `actionableWorkspaces` read model from storage

Human output should print a concise table/list with:
- run id
- workspace status
- path
- head sha when available
- cleanup error when present

JSON output should return the actionable workspace records directly.

### 2. `workspace cleanup <run-id>`

Allowed only for:
- `retained`
- `cleanup-failed`

Flow:
1. load the persisted workspace snapshot for the run id
2. validate that it is actionable
3. call the git/workspace adapter delete operation on the persisted path
4. if delete succeeds:
   - mark the workspace deleted in storage
   - return a compact success payload/result
5. if delete fails:
   - keep the workspace actionable
   - return a stable error

### 3. Storage change

The existing `recordWorkspaceDeleted(runId)` transition is currently too narrow for this slice because it only models the passed-run active-workspace deletion path.

Add a narrow operator-facing cleanup transition that allows:
- retained -> deleted
- cleanup-failed -> deleted

Do not widen this into a generic arbitrary workspace-state transition system.

## Likely files

- `apps/cli/src/run-cli.ts`
- `apps/cli/src/formatters.ts`
- `apps/cli/test/run-cli.test.ts`
- `packages/storage/src/store.ts`
- `packages/storage/src/index.ts`
- `packages/storage/test/store.test.ts`
- possibly `test/workflow/readme-contract.test.ts` if help text/README contracts need updating

## Non-goals

- batch cleanup commands
- merge/reapply retained changes
- active-workspace recovery or interruption reconciliation
- TUI workspace management
- replay changes
