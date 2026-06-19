---
"@buildplane/kernel": patch
"@buildplane/planforge": patch
"buildplane": patch
---

feat(m4): wire the acceptance-contract finalization gate

The kernel now records an independent acceptance verdict before a PlanForge run
is merged. `planforge dispatch` derives a per-task acceptance contract
(`deriveAcceptanceContract`: diff-scope = the task capability-bundle fsWrite,
checks = its verificationCommands), resolves it through a per-task policy
profile, and the kernel runs the checks in the worktree, evaluates the contract,
and appends a signed `acceptance_recorded` event via an injected acceptance port
**before** the merge (write-ahead). A passed verdict proceeds to the existing
merge; a rejected verdict short-circuits with no merge and preserves the worktree
as the quarantine artifact. Opt-in: with no contract configured, finalization is
byte-for-byte unchanged.
