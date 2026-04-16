# Workspace List and Cleanup Commands — Requirements

**Date:** 2026-04-14
**Scope:** Phase 3 / Slice 3B — retained-workspace recovery/status commands

## Goal

Give operators a dedicated CLI surface to find actionable retained workspaces and explicitly clean them up after inspection or manual recovery.

## Problem

Buildplane already persists retained and cleanup-failed workspaces and surfaces them through `status --json`, `status`, and `inspect`. But operators still lack a direct workspace-management command surface:

- `status` only shows a count of actionable workspaces in human mode
- there is no dedicated command to list actionable workspaces cleanly
- there is no explicit command to mark a retained or cleanup-failed workspace as cleaned up and delete it

This means workspace recovery is discoverable but not yet operationally complete.

## In scope

- add a dedicated workspace command namespace
- add `buildplane workspace list [--json]`
- add `buildplane workspace cleanup <run-id> [--json]`
- list only actionable workspaces (`retained`, `cleanup-failed`)
- allow cleanup for retained and cleanup-failed workspaces only
- update status/inspect surfaces through existing storage projections after cleanup
- add focused storage and CLI tests

## Out of scope

- resume execution from a retained workspace
- merge/cherry-pick/apply retained workspace changes back into the repo
- batch cleanup or prune commands
- TUI workspace management
- graph workspace recovery UX
- new replay semantics
- broader workspace repair/reconciliation logic for active runs

## Functional requirements

1. `workspace list` must return actionable workspaces in newest-first order.
2. Human `workspace list` output must show at least:
   - run id
   - status
   - path
   - cleanup error when present
3. `workspace list --json` must expose the same actionable workspace data structurally.
4. `workspace cleanup <run-id>` must only operate on workspaces in `retained` or `cleanup-failed` state.
5. Successful cleanup must:
   - delete the underlying git worktree path
   - update durable storage so the workspace is no longer actionable
6. Cleaning up an unknown run id or non-actionable workspace must return a stable operator-facing error.
7. Existing `status` and `inspect` behavior must reflect the updated deleted workspace state after cleanup.

## Acceptance criteria

- `buildplane workspace list` shows retained/cleanup-failed workspaces in human mode
- `buildplane workspace list --json` returns actionable workspace entries structurally
- `buildplane workspace cleanup <run-id>` succeeds for retained workspaces
- `buildplane workspace cleanup <run-id>` succeeds for cleanup-failed workspaces
- cleaned workspaces disappear from `actionableWorkspaces`
- `inspect <run-id>` reflects the deleted workspace state after cleanup
- focused tests pass
