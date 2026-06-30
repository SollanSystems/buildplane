---
"@buildplane/capability-broker": patch
"@buildplane/planforge": patch
---

add a declarative `netEgress` host allowlist to the capability bundle. The broker schema parses, validates (non-empty hosts, no whitespace/`/`/NUL), and digest-covers the field; PlanForge maps each task's `allowedSideEffects` to a deterministic egress union (every current side-effect declares zero egress — explicit default-deny — with the map as the single extension point, e.g. a future `npm-install` → `["registry.npmjs.org"]`) and surfaces the plan-wide union on the receipt preview alongside `riskClass`. Declarative-only in v0: the field is visible and digest-covered but NOT yet enforced at the worker boundary (no verified Claude Code subprocess network-restriction flag exists).
