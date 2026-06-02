---
"@buildplane/kernel": minor
"@buildplane/planforge": minor
"@buildplane/adapters-git": minor
"buildplane": minor
---

M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
on the packet + admission receipt and a verified worktree_clean git status.
