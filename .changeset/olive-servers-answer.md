---
"@buildplane/mission-control-server": patch
---

Answer a retired operator decision with an explicit HTTP 501 `operator_decision_surface_retired` carrying the retirement reason, instead of letting the failure escape as a generic 500. The error is matched by name (mirroring the existing `OperatorDecisionValidationError` mapping) so this package keeps depending on the kernel interface rather than its runtime value.

Boot recovery now also logs every recovered record whose signed `run_completed` was skipped against a retired completion port, so the missing tape evidence is visible to the operator rather than silent.
