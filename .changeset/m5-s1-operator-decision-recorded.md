---
"@buildplane/ledger-client": minor
---

add `operator_decision_recorded` signed L0 event kind (`OperatorDecisionRecordedV1` payload). Records operator approve/reject decisions on a merge or resume subject. Kernel-signed; the operator identity is the `decided_by` payload field. No emitter or consumer yet — this slice lands the kind + payload + cross-language derivation only.
