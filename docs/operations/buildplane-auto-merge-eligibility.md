# Buildplane Auto-Merge Eligibility Probe

## Purpose

`pr-auto-merge-eligibility.mjs` is the read-only steward probe for Buildplane PR merge readiness.

It does not mutate GitHub state. It only inspects the live PR head, checks, labels, review state, review threads, mergeability, and deployment side effects, then emits a bounded JSON verdict.

## Command

```bash
node scripts/ci/pr-auto-merge-eligibility.mjs \
  --pr <number> \
  --expected-head <reviewed_head_sha> \
  --expected-base <branch> \
  --review-receipt <path-to-review-receipt> \
  --json
```

Shortcut:

```bash
pnpm auto-merge:eligibility --pr <number> --expected-head <sha> --expected-base main --review-pass --json
```

## Review source options

Exactly one review source is required:

- `--review-pass`
  - Manual assertion that an independent review receipt already recorded PASS.
- `--review-receipt <path>`
  - Reads a local receipt file and requires a PASS-like verdict (`PASS`, `PASSED`, `APPROVED`, or `LGTM`).

If neither is provided, the probe blocks.

## Read-only data sources

The probe reads:

- `gh pr view`
- `gh repo view`
- GitHub GraphQL review-thread metadata
- GET-only deployment probe:
  - `gh api "repos/<owner>/<repo>/deployments?ref=<head_sha>&per_page=20"`
- local `git rev-parse --short origin/main` for receipt context only

The probe must not:

- merge
- enable auto-merge
- add/remove labels
- mark PR ready
- approve reviews
- edit branch protection
- create deployments
- delete branches

## Verdict vocabulary

- `AUTO_MERGE_READY`
- `BLOCKED_CHECKS`
- `BLOCKED_REVIEW`
- `BLOCKED_REVIEW_THREADS`
- `BLOCKED_SHA_MISMATCH`
- `BLOCKED_BASE_MISMATCH`
- `BLOCKED_DEPLOYMENT_SIDE_EFFECT`
- `BLOCKED_MERGE_STATE`
- `BLOCKED_DRAFT`
- `BLOCKED_AUTO_MERGE_OPT_IN`
- `RECONCILE_ALREADY_MERGED`
- `ERROR_GITHUB_QUERY`

## Minimum blockers

The probe blocks when any of these are true:

- no independent review PASS was asserted or read from receipt
- reviewed head SHA is missing
- reviewed head SHA does not equal live PR head SHA
- expected base does not equal live PR base
- required opt-in label is missing
- PR is draft
- PR state is merged/closed (reconciliation mode instead)
- merge state is not clean/reconcilable
- checks are missing, pending, or failing unless explicitly allowed
- unresolved review threads remain
- deployment objects exist for the head SHA unless explicitly allowed

## Notes for Buildplane

- The canonical opt-in label is `buildplane:auto-merge`.
- `AUTO_MERGE_READY` is evidence, not authority.
- A separate mutating merge executor must re-check the live head SHA before enabling or performing merge.
