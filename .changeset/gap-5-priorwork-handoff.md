---
"@buildplane/planforge": minor
"buildplane": minor
---

GAP-5: add `PlanSummary`, `summarizePlanReceipt`, and `formatPriorWorkEntry` to planforge; add `injectPriorWorkIntoPacket`, `loadPriorWorkEntries`, and `writePlanSummaryToStorage` to cli. The dispatch path now persists a structured plan summary to storage after `plan_receipt`, and the supervisor can inject it as `TaskIntent.context.priorWork` into the next iteration's packet.
