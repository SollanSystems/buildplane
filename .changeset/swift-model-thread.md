---
"@buildplane/planforge": minor
"buildplane": minor
---

thread an optional worker-model override through the PlanForge loop and dispatch. `dispatchAdmittedPlan` accepts a new optional `model` on its input and stamps it onto every dispatched packet's `model.model` (defaulting to the unchanged `DISPATCH_WORKER_MODEL`). The CLI exposes it as `buildplane planforge loop --model <id>`: the flag is parsed in the loop command and passed through `makeDefaultLoopDispatch` → `runPlanForgeDispatchCommand` → `dispatchAdmittedPlan`, so the dogfood can run workers on `claude-opus-4-8` without changing the global default. Omitting `--model` leaves dispatch byte-for-byte unchanged.

The override is also **durable across `planforge resume`/`recover`**: the model is persisted in the dispatch crash-recovery manifest (`PlanForgeDispatchManifest.model`) before the run loop, and `resumePlanForgePlanFromInput` recovers it (via `resolvePlanForgeResumeModel`) so a crashed-and-resumed run re-dispatches its remaining suffix on the same model rather than silently reverting to the default — the exact crash-and-resume path the M6 demo exercises.
