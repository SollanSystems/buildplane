# GitHub Auto-Merge Policy

## Purpose

This document defines the Buildplane auto-merge governance policy — a fail-closed automation path where a PR becomes merge-eligible only when GitHub, the local steward, and Buildplane receipts all agree on the exact reviewed head SHA and required gates.

## Three-Layer Control Model

1. **GitHub hard gates** — Branch protection, required checks, required conversations, review requirements, CODEOWNERS, security scans.

2. **Buildplane steward probe** (`auto-merge:eligibility`) — A deterministic read-only eligibility command that emits a bounded machine-readable verdict. It checks exact reviewed SHA, labels, checks, review state, unresolved threads, mergeability, deployments, and base/head alignment.

3. **Mutating merge executor** (`auto-merge:execute`) — A separate narrow command that only runs after the steward probe returns `AUTO_MERGE_READY` for the exact same PR/head SHA.

## Opt-In Signal

The canonical opt-in label is `buildplane:auto-merge`. It must be explicitly applied by the operator or the opt-in helper (`auto-merge:opt-in`) before any PR is eligible for autonomous merge.

## Branch Protection

Recommended settings for `main`:

- Strict required status checks
- Required conversation resolution
- Enforce administrators
- Required approving review count: 1
- No force pushes
- No branch deletion
- Linear history
- Squash-only merges
- Delete branch on merge

Candidate required checks:
- `verify`
- `GitGuardian Security Checks` (if stable and consistently present)
- `verify-wrong-node` (if treated as a hard CI gate)
- CodeQL (once check context name is stable)

## Security Posture

- CodeQL workflow enabled for JavaScript/TypeScript as an advisory extraction/query smoke. Because Buildplane is currently a private repository without GitHub Advanced Security, SARIF upload is disabled with `upload: never`; switch to upload once GitHub code scanning is enabled for the repository.
- Secret scanning / push protection (when GitHub plan allows)
- Dependabot alerts triaged regularly
- `pnpm audit` considered for additional dependency auditing

## Stacked PR Policy

- Stacked PRs may be used for implementation flow
- Auto-merge should normally target PRs into `main` or the current protected integration branch
- A stacked PR should not be auto-merged until its base PR has landed and it has been rebased/transplanted onto the updated base

## Merge Executor Safety

The merge executor:
- Refuses stale receipts (>10 minutes old)
- Re-checks live eligibility before merging
- Refuses SHA mismatches
- Refuses already-merged PRs (emits reconciliation receipt)
- Verifies post-merge state (PR merged, on default branch, no new deployments)
- Prefers native auto-merge; direct merge only with explicit flag