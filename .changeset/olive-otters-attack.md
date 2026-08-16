---
"@buildplane/ledger-client": patch
---

Export `CALLER_SUPPLIED_TRUST_SPINE_KINDS` from `emitter.ts` (module-internal only — deliberately not added to the package barrel) so a new test can assert set-equality against the native always-blocked denylist read live from `native/crates/bp-ledger/src/serve.rs`. Closes the cross-language drift hole the hand-fixed `promotion_execution_claimed_v1` entry exposed: the native side self-pins its own lists, but nothing reached into TypeScript. Also corrects the `EmitOptions.id` doc comment, which claimed the override was "tests only" while production write-ahead parent-linking depends on it. No runtime behavior change.
