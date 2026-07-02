---
"buildplane": patch
---

give the `planforge loop` supervisor honest terminal-reason fidelity plus a reset path (M6 R1). A failed dispatch is now split into two terminal reasons: `dispatch-error` when the worker produced NO durable side effects (empty worktree diff + no merged HEAD) — the fingerprint of an infra death such as a 429 rejection (0 tokens, 0 turns) — versus the existing `acceptance-fail` when the worker ran and built a diff the acceptance contract rejected. The dispatch outcome now surfaces `producedSideEffects` (derived from `receipt.changedFiles` / a merged HEAD) and the failing task's `decision.reasons`, which are threaded verbatim into the terminal `detail` instead of the previous hardcoded `"dispatch/acceptance failed"` string. A new `planforge loop --reset` clears `.buildplane/loop-state.json` and exits, so a loop that halted on a sticky terminal (e.g. `dispatch-error` from the 2026-07-01 dogfood 429) can be re-fired without manually deleting state.
