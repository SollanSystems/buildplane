---
"@buildplane/planforge": patch
---

add a `riskClass` (`low` | `medium` | `high`) attribute to PlanForge validation and surface it on the receipt preview. It is computed during `validate`: `high` when the plan is unsafe to run, `medium` when evidence is missing or a clean plan declares allowed side effects, and `low` for a clean plan with no side effects. The field is additive — `riskClass` participates in the signed `planDigest` (validation is part of the digested review artifact), so the golden plan fixture's digest was regenerated.
