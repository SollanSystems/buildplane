---
"@buildplane/kernel": patch
---

Close the drift between `src/index.ts` and the hand-maintained `src/index.d.ts`, and pin it with a set-equality test. `index.d.ts` is the `"types"` target for `@buildplane/kernel`, so its contents — not `index.ts` — govern what consumers can import. It was missing the entire `./admitted-plan-reader` block (8 names, including `createDefaultAdmittedPlanReader`) and four `./run-loop` types reachable through the already-exported `InspectSnapshot`; `index.ts` in turn was missing three real `./events` types (`PolicyBudgetBreachedEvent`, `RunSuspendedEvent`, `RunResumedEvent`) that `index.d.ts` already promised.
