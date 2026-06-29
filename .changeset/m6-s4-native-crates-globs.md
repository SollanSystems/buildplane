---
"@buildplane/planforge": patch
---

map the `code-edit` side-effect to `native/crates/**/src/**` and `native/crates/**/tests/**` so admitted plans can authorize edits to native crate sources and tests (unblocks the dogfood worker writing ledger payloads/tests).
