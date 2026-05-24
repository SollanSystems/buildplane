# Buildplane Auto-Merge Opt-In Helper

## Purpose

`pr-auto-merge-opt-in.mjs` is the explicit operator opt-in helper for Buildplane PR auto-merge eligibility.

It applies the `buildplane:auto-merge` label (creating it on the repo if needed) to signal that a PR is ready for autonomous merge consideration. The helper is **dry-run-first**: it only applies mutations after pre-checks pass.

The opt-in helper **never merges**.

## Command

```bash
# Dry-run (inspect only, no mutations)
node scripts/ci/pr-auto-merge-opt-in.mjs \
  --pr <number> \
  --expected-head <reviewed_head_sha> \
  --dry-run

# Live mode (apply opt-in)
node scripts/ci/pr-auto-merge-opt-in.mjs \
  --pr <number> \
  --expected-head <reviewed_head_sha>
```

Shortcut:

```bash
pnpm auto-merge:opt-in --pr <number> --expected-head <sha> --dry-run
```

## Required arguments

- `--pr <number>` — PR number to inspect and label
- `--expected-head <sha>` — Verified head SHA; blocks if it differs from live PR head

## Modes

### Dry-run mode (`--dry-run`)

Inspects live PR state, prints pre-check results and intended mutations. Does **not** change anything on GitHub.

### Live mode (default)

After pre-checks pass, applies mutations:
1. Creates `buildplane:auto-merge` label on the repo if it does not exist
2. Adds the label to the target PR
3. Optionally marks the PR ready (with `--mark-ready`)

After mutation, re-queries PR state to confirm:
- Head SHA unchanged
- Label applied
- PR state unchanged
- No new deployments

## Pre-checks (mutations blocked if any fail)

- PR is not merged or closed
- Expected head SHA matches live PR head SHA
- PR is not draft
- No unresolved review threads
- No pending checks
- If `--allow-deployments` is not set: no deployment objects for the head SHA

## Mutations allowed

- Create label `buildplane:auto-merge` (if missing from repo)
- Add label to target PR
- Optionally mark draft PR as ready (`--mark-ready`)

## Verdict vocabulary

- `OPT_IN_OK` — Pre-checks passed, mutations applied, post-mutation re-query confirms state
- `BLOCKED` — One or more pre-checks or post-checks blocked

Blocker statuses:
- `BLOCKED_ALREADY_MERGED`
- `BLOCKED_SHA_MISMATCH`
- `BLOCKED_SHA_MISSING`
- `BLOCKED_DRAFT`
- `BLOCKED_REVIEW_THREADS`
- `BLOCKED_CHECKS_PENDING`
- `BLOCKED_DEPLOYMENT_SIDE_EFFECT`
- `BLOCKED_DRY_RUN_DIVERGED`
- `ERROR_GITHUB_QUERY`

## Notes for Buildplane

- The opt-in helper is a mutating action, separated from the read-only eligibility probe.
- `OPT_IN_OK` is evidence that the label has been applied, not authority to merge.
- The merge executor must independently re-check eligibility (including the live head SHA) before merging.