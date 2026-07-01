---
"@buildplane/planforge": patch
---

cover the ledger fixtures directory in the `code-edit` diff-scope. The `code-edit` side-effect now maps to `packages/**/fixtures/**` (symmetric with the existing `packages/**/src/**` / `packages/**/test/**`), so an admitted code-edit plan can authorize the regenerated `packages/ledger-client/fixtures/payload-variants.json` that `pnpm ledger:gen-fixtures` produces. Because the M4 acceptance diff-scope (`deriveAcceptanceContract`) is derived from the same `capability_bundle.fsWrite`, a worker that regenerates and commits ledger fixtures (e.g. the `result_ready` dogfood derivation) no longer fails acceptance with an out-of-scope diff.
