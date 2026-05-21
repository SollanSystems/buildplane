# Buildplane slice receipt template

Use this receipt for each small Buildplane buildout slice before advancing review,
PR, merge, or post-merge gates. The receipt is an evidence packet, not a status
claim. Fill unknown fields with `unknown` and block the gate rather than guessing.

## Slice identity

- Slice id:
- Milestone:
- Goal:
- Non-goals:
- Operator approval scope:
- Steward / agent:
- Started at:
- Completed at:

## Source of truth

- Base branch:
- Base SHA:
- Source docs / specs read:
- Related issue / task / board item:
- Prior prerequisite PRs verified on `origin/main`:

## Workspace

- Worktree path:
- Branch:
- Local HEAD SHA:
- Remote branch SHA:
- Git identity verified:
- `core.filemode=false` verified:
- Clean status before work:
- Clean status after commit:

## Scope

- Files changed:
- Diff stat:
- Added dependencies:
- Data migrations / durable schema changes:
- Tool / workflow permission changes:
- Deployment / publish / release side effects:
- Secret-shaped added lines scan:

## Verification

Record commands exactly as run. Include exit codes and relevant caveats.

- Focused tests:
- Package / area tests:
- Typecheck:
- Lint / format:
- Build:
- Full-suite check, if run:
- Isolated reruns for flaky / timeout failures:
- Direct CLI smoke / manual probe:
- Forbidden literal / ambient-authority grep:

## Review gate

- Review task id / reviewer:
- Reviewed commit SHA:
- Current PR head SHA:
- Verdict: `PASS` | `REQUEST_CHANGES` | `BLOCKED_INSUFFICIENT_EVIDENCE` | `BLOCKED_UNSAFE_TO_RUN` | `BASELINE_FAILURE`
- Significant issues found:
- Issues reconciled by follow-up commit SHA:
- Review notes / link:

## PR gate

- PR URL:
- PR number:
- Draft state:
- Base branch:
- Head branch:
- Head SHA:
- Merge state:
- Review decision:
- Auto-merge opt-in label present:
- Required auto-merge label:
- Required checks observed:
- Advisory checks observed:
- Deployment objects from GET-only probe:
- Auto-merge eligibility result:
- Auto-merge decision:

## Post-merge verification

- Merge method:
- Merge commit SHA:
- `origin/main` SHA after fetch:
- `origin/main` contains merge commit:
- Default-branch CI:
- Deployment objects after merge:
- Remote feature branch still exists:
- Local worktree retained / removed:
- Cleanup explicitly approved:

## Exceptions / caveats

- Known unrelated warnings:
- Local load-sensitive failures and isolated rerun evidence:
- Release automation noise:
- Out-of-band merges / automation actions:
- Blockers carried forward:

## Next gate

- Next allowed action:
- Actions explicitly not authorized:
- Fresh context required before continuing:
