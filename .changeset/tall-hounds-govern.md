---
"@buildplane/ledger-client": patch
---

Correct the `PlanAdmittedV1` documentation to match what the payload actually is.

The type doc called the payload "the dispatch authority". No existing native admission control claims effect authority of itself — the V5 admission receipt and its projection both say the opposite in as many words — and the dedicated native plan-admission control that now mints this event mints recovery evidence too. The doc now says so: sealing an admission under a checkpoint makes recovery and duplicate delivery verifiable, and a consumer must reopen the evidence under a separately configured authority before any effect.

Three field docs were also misleading about where their values come from, which matters now that a second producer exists. `plan_id` said `pf-plan-<fingerprint>` without noting that the PlanForge fingerprint hashes a parsed projection of the plan rather than its compiled bytes, so the native mint cannot reproduce it and derives a deliberately distinguishable `pf-plan-native-<hex>` instead. `input_digest` did not say that PlanForge digests the JSON-quoted plan text while the native mint digests the exact content-addressed bytes it loaded. `idempotency_key` read as though it were the admission identity; the native mint keeps its own identity in its projection and never resolves a retry against this value.

Documentation only: no wire shape, field, digest, or generated value changes, and `fixtures/payload-variants.json` is byte-identical.
