---
"buildplane": minor
---

Phase 2 · S2 — repo_facts branch-scoped filtering: add an optional `branch?` to `RepoFactRetrievalQuery`, thread it through `retrieveRepoFacts` and the store read helpers (`readRepoFactRows`/exact/fuzzy) with a `(branch = ? OR branch IS NULL)` clause so facts promoted on another branch no longer leak into unrelated runs (null-branch rows stay repo-global and always match), and have packet-enrichment pass the run's current branch. Additive/opt-in: omitting `branch` preserves today's unfiltered behavior. No DDL change; `valid_from_commit`/`valid_to_commit` and the ranking algorithm are untouched.
