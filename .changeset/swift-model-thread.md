---
"@buildplane/planforge": minor
"buildplane": minor
---

thread an optional worker-model override through the PlanForge loop and dispatch. `dispatchAdmittedPlan` accepts a new optional `model` on its input and stamps it onto every dispatched packet's `model.model` (defaulting to the unchanged `DISPATCH_WORKER_MODEL`). The CLI exposes it as `buildplane planforge loop --model <id>`: the flag is parsed in the loop command and passed through `makeDefaultLoopDispatch` → `runPlanForgeDispatchCommand` → `dispatchAdmittedPlan`, so the dogfood can run workers on `claude-opus-4-8` without changing the global default. Omitting `--model` leaves dispatch byte-for-byte unchanged.
