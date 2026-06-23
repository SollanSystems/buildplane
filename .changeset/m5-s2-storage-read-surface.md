---
"@buildplane/kernel": minor
"@buildplane/storage": minor
---

add the Mission Control storage read surface and the Tier-1 acceptance shadow. `listRunsByStatus` now returns a paginated `RunPage` (array carrying an opaque `cursor`) with `limit`/`cursor` support; `recordAcceptanceShadow` writes the additive `runs.acceptance_outcome` column from the M4 acceptance path; `listPendingOperatorDecisions` returns the operator inbox feed (suspended runs as `resume`, accepted-undecided runs as `merge`, excluding runs with an `operator_decision_recorded` event). `parentRunId` is now threaded through `toRun` → `inspectTarget` → `InspectSnapshot.run`.
