# Buildplane Auto-Merge Executor

> **RETIRED (2026-05-24).** Auto-merge is now owned by Mergify via `.mergify.yml`
> (`merge_protections` + label-gated `buildplane:auto-merge`). The executor's
> merge path has been removed so it cannot race Mergify — running
> `pr-auto-merge-execute.mjs` directly now refuses and exits non-zero. The
> exported helpers and the read-only `auto-merge:eligibility` probe remain.
> The sections below describe the historical behavior prior to retirement.

## Purpose

`pr-auto-merge-execute.mjs` is the narrow mutating merge executor for Buildplane PR auto-merge. It performs a GitHub PR merge ONLY after a fresh eligibility receipt proves `AUTO_MERGE_READY`.

The executor **never** merges without a valid receipt.

## Command

```bash
# Dry-run (inspect only, no merge)
node scripts/ci/pr-auto-merge-execute.mjs \
  --pr <number> \
  --receipt <path-to-eligibility-receipt> \
  --dry-run

# Live merge (with valid receipt)
node scripts/ci/pr-auto-merge-execute.mjs \
  --pr <number> \
  --receipt <path-to-eligibility-receipt>
```

Shortcut:

```bash
pnpm auto-merge:execute --pr <number> --receipt <path>
```

## Required arguments

- `--pr <number>` — PR number to merge
- `--receipt <path>` — Path to an eligibility receipt JSON proving `AUTO_MERGE_READY`
  - Accepted shapes:
    - executor-style flat receipt (`pr`, `headSha`/`expectedHeadSha`, `timestamp`)
    - canonical eligibility probe receipt (`status`, nested `pr.number`, nested `pr.headRefOid` or `review.expectedHead`, `timestamp`)

## Options

- `--dry-run` — Inspect only; validate receipt and live state, do not merge
- `--direct-merge` — Use direct REST merge instead of native auto-merge
- `--json` — JSON-only output
- `--expected-base <branch>` — Required base branch (default: `main`)

## Safety Gates

1. **Receipt validation**: Must be valid JSON, have `verdict: AUTO_MERGE_READY`, contain PR number and head SHA, and be < 10 minutes old.
2. **PR-to-receipt matching**: Receipt PR must match target PR; receipt SHA must match live PR head SHA.
3. **Live re-probe**: After receipt validation, re-runs the canonical eligibility probe with both `--expected-head` and `--expected-base`; blocks if not `AUTO_MERGE_READY`.
4. **Post-merge verification**: After merge, verifies PR state is `MERGED`, merge commit exists on default branch, and no new deployments appear.

## Merge Methods

- **Native auto-merge** (default): Uses GraphQL `enablePullRequestAutoMerge` with `SQUASH`.
- **Direct merge** (with `--direct-merge`): Uses REST `gh pr merge --squash --delete-branch`.

## Refusal Modes

- Already merged: Emits reconciliation receipt, exits 0.
- Stale receipt: Blocks with `BLOCKED_STALE_RECEIPT`.
- SHA mismatch: Blocks with `BLOCKED_RECEIPT_SHA_MISMATCH`.
- PR/receipt mismatch: Blocks with `BLOCKED_RECEIPT_PR_MISMATCH`.
- Live re-check fails: Blocks with `BLOCKED_LIVE_RECHECK`.

## Notes for Buildplane

- The merge executor is a mutating action, separated from the read-only eligibility probe and the explicit opt-in helper.
- `EXEC_AUTO_MERGE_ENABLED` or `EXEC_DIRECT_MERGED` is the final merge evidence.
- Post-merge verification must succeed before the executor exits 0.