---
"@buildplane/ledger-client": patch
"@buildplane/kernel": patch
---

Refuse unsealed plan admissions, and correct the `PlanAdmittedV1` documentation to match what the payload actually is.

`@buildplane/kernel`: a `plan_admitted` event that is validly kernel-signed but whose admission was never sealed no longer authorizes a dispatch. The native mint commits the event, its signature, and an `awaiting_checkpoint` projection row in one transaction, and only a later successful seal advances that row — so a crash in between leaves a validly signed event on the tape whose admission was never completed, and a signature check alone cannot tell the two apart. `AdmittedPlanRecord` now carries `sealed`, read from the mint's `plan_admissions` projection in the same ledger database and failing closed on a missing table, a missing row, an unexpected state, or a failed query. The orchestrator's admission gate requires it, with a refusal that names the unsealed state rather than reporting a missing admission. Every tape written before the mint existed carries no projection at all and is therefore reported unsealed.

`@buildplane/ledger-client`: the `PlanAdmittedV1` type doc called the payload "the dispatch authority". No existing native admission control claims effect authority of itself — the V5 admission receipt and its projection both say the opposite in as many words — and the dedicated native plan-admission control that now mints this event mints recovery evidence too. The doc now says so: sealing an admission under a checkpoint makes recovery and duplicate delivery verifiable, and a consumer must reopen the evidence under a separately configured authority before any effect.

Four field docs were also misleading about where their values come from, which matters now that a second producer exists. `plan_id` said `pf-plan-<fingerprint>` without noting that the PlanForge fingerprint hashes a parsed projection of the plan rather than its compiled bytes, so the native mint cannot reproduce it and derives a deliberately distinguishable `pf-plan-native-<hex>` instead. `input_digest` did not say that PlanForge digests the JSON-quoted plan text while the native mint digests the exact content-addressed bytes it loaded. `plan_digest` and `idempotency_key` both read as canonical values; both are caller assertions the mint records verbatim and never verifies, and the doc now leads with that and names the authoritative identity instead.

The `@buildplane/ledger-client` half is documentation only: no wire shape, field, digest, or generated value changes, and `fixtures/payload-variants.json` is byte-identical.
