---
"buildplane": patch
---

unify path-glob semantics across the envelope admission gate and the acceptance diff-scope gate on the broker's minimatch semantics: a new shared `segment-glob` module in `@buildplane/policy` decides matching (differentially tested against real minimatch) and language-inclusion subset (brute-force verified), so middle-wildcard vocabulary globs like `packages/**/src/**` now cover concrete proposals at admission and match changed files at acceptance instead of being dead patterns
