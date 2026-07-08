---
"buildplane": patch
---

wire the per-tool-call ledger sink into the PlanForge resume/recover executed-suffix path, so a cold-resumed run's worker tool_use/tool_result events land on the signed tape (stamped with the executed suffix packet's unit id and parented to its activity bracket) instead of recording zero tool activity — closing the resume-path evidence-trail gap left open at the M6 gate
