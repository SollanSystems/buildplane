---
"@buildplane/kernel": patch
---

Bind the plan-admitted dispatch gate to the run it is admitting.

The tape is one `events.db` per project, so a `plan_admitted` event minted for run A satisfied the signature, authorized-next-step, and sealed checks identically when a packet dispatched for run B named it as its `provenance_ref` — and authorized the dispatch. `AdmittedPlanRecord` now carries `runId`, read from the event's own `run_id` column, and the mint's projection lookup binds `run_id` as well as the admission event id so a sealed row must belong to the same run as its event. The orchestrator's admission gate refuses an admission whose `runId` differs from the run being admitted, after the sealed check, with a message naming both runs. An admission authorizes a dispatch only in its own run; this is a per-admission binding, not a one-admission-per-run rule.

Latent today: no production path can mint a sealed `plan_admitted` yet, so the cross-run bypass was not reachable. It is fixed in the directly adjacent consumer regardless. No wire shape, digest, or generated value changes; `fixtures/payload-variants.json` is byte-identical.
