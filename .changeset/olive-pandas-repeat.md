---
"@buildplane/ledger-client": patch
---

Add `promotion_execution_claimed_v1` to the caller-supplied trust-spine guard, closing a drift against the native always-blocked denylist. The client-side set mirrors only the native first denylist; the signed-only second list cannot be mirrored client-side because `emit()` has no signing context, and that asymmetry is now documented at the set.
