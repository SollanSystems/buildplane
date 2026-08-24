//! Drift guard for `SqliteStore::validate_external_append`'s always-blocked set.
//!
//! The set is a trust boundary, not a convenience list: every kind on it is
//! minted only by a dedicated native control that first replays and verifies
//! the evidence it summarizes. Nothing else in the suite pins the set's exact
//! membership, so a kind silently added to (or dropped from) it would be
//! invisible — the storage guard has no analogue of `serve.rs`'s
//! `disposition_table_covers_every_event_kind_exactly_once`.
//!
//! Both halves are pinned, because the guard has two independent clauses. The
//! envelope label is caller-chosen; `bp-replay` dispatches on the payload
//! variant and never consults `event.kind`. A test that pairs a blocked kind
//! with its matching payload stays green if either clause is deleted, so the
//! kind cases here deliberately carry an unrelated payload and the payload
//! cases deliberately carry an unrelated kind.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::{TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::plan_lifecycle::PlanAdmittedV1;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::trust_spine::{
    GovernedDispatchV5AdmissionRecordedV1, PromotionReconciliationResolvedV1,
    ReconciliationResolutionOutcomeV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_ledger::LedgerError;
use chrono::Utc;

/// Verbatim membership of the storage always-blocked set, as wire names.
///
/// Editing this list is editing a trust boundary. If a change here is
/// deliberate, say so in the slice's review record — do not "fix the test".
const ALWAYS_BLOCKED_TRUST_SPINE_WIRE_NAMES: &[&str] = &[
    "governed_dispatch_v5_admission_recorded_v1",
    "promotion_reconciliation_resolved",
    "plan_admitted",
];

/// Blocked too, but under its own error variant.
const ALWAYS_BLOCKED_CHECKPOINT_WIRE_NAME: &str = "tape_checkpoint";

/// Every variant `EventKind` can represent, recovered from serde's
/// unknown-variant error rather than from a hand-maintained list. A hand list
/// would silently omit a newly added kind, which is precisely the drift this
/// guard exists to catch. (Mirrors `serve.rs`'s `every_event_kind`, which is
/// `#[cfg(test)]`-private to that module and unreachable from here.)
fn every_event_kind() -> Vec<EventKind> {
    let sentinel = serde_json::Value::String("__not_an_event_kind__".into());
    let message = serde_json::from_value::<EventKind>(sentinel)
        .expect_err("the sentinel must not name a real event kind")
        .to_string();
    let listed = message
        .split_once("expected one of ")
        .unwrap_or_else(|| {
            panic!(
                "serde no longer enumerates variants in its unknown-variant error, so this \
                 coverage check can no longer see the whole enum. Repair the parser (or replace \
                 it with an explicit list) instead of deleting the check. Message: {message}"
            )
        })
        .1;
    listed
        .split(',')
        .map(|variant| {
            let wire = variant.trim().trim_matches('`');
            serde_json::from_value::<EventKind>(serde_json::Value::String(wire.to_string()))
                .unwrap_or_else(|error| {
                    panic!("serde listed `{wire}` as an EventKind variant but refused it: {error}")
                })
        })
        .collect()
}

/// A payload that is on no denylist, so a kind case can only be refused by the
/// kind clause.
fn unrelated_payload() -> Payload {
    Payload::RunCompletedV1(RunCompletedV1 {
        outcome: RunOutcome::Passed,
        duration_ms: "1".into(),
        event_count: "1".into(),
        unit_count: "0".into(),
    })
}

fn event_of(kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

#[test]
fn the_always_blocked_kind_set_is_exactly_the_pinned_membership() {
    for kind in every_event_kind() {
        let store = SqliteStore::open_in_memory().unwrap();
        let outcome = store.append(&event_of(kind, unrelated_payload()));
        let wire = kind.as_wire();

        if wire == ALWAYS_BLOCKED_CHECKPOINT_WIRE_NAME {
            assert!(
                matches!(outcome, Err(LedgerError::CallerSuppliedCheckpoint)),
                "{wire} must be refused as a caller-supplied checkpoint, got {outcome:?}"
            );
            assert_eq!(store.event_count().unwrap(), 0);
            continue;
        }

        if ALWAYS_BLOCKED_TRUST_SPINE_WIRE_NAMES.contains(&wire) {
            assert!(
                matches!(
                    outcome,
                    Err(LedgerError::CallerSuppliedTrustSpineEvent { kind: ref reported })
                        if reported == wire
                ),
                "{wire} must be refused as a caller-supplied trust-spine event naming itself, \
                 got {outcome:?}"
            );
            assert_eq!(store.event_count().unwrap(), 0);
            continue;
        }

        assert!(
            !matches!(
                outcome,
                Err(LedgerError::CallerSuppliedCheckpoint)
                    | Err(LedgerError::CallerSuppliedTrustSpineEvent { .. })
            ),
            "{wire} is not on the storage always-blocked set but was refused as if it were: \
             {outcome:?}. If that block is deliberate, add {wire} to this guard's pinned \
             membership in the same change."
        );
    }
}

#[test]
fn the_pinned_membership_is_not_vacuous() {
    assert_eq!(ALWAYS_BLOCKED_TRUST_SPINE_WIRE_NAMES.len(), 3);
    let known: Vec<&str> = every_event_kind()
        .into_iter()
        .map(|kind| kind.as_wire())
        .collect();
    for wire in ALWAYS_BLOCKED_TRUST_SPINE_WIRE_NAMES
        .iter()
        .chain(std::iter::once(&ALWAYS_BLOCKED_CHECKPOINT_WIRE_NAME))
    {
        assert!(
            known.contains(wire),
            "the guard pins `{wire}`, which EventKind no longer has"
        );
    }
}

/// Each always-blocked payload variant, smuggled under a permitted envelope
/// label. `bp-replay` would dispatch on the payload, so the label must not be
/// able to launder it.
#[test]
fn every_always_blocked_payload_is_refused_under_a_permitted_kind() {
    let cases: Vec<(&str, Payload)> = vec![
        (
            "governed_dispatch_v5_admission_recorded_v1",
            Payload::GovernedDispatchV5AdmissionRecordedV1(GovernedDispatchV5AdmissionRecordedV1 {
                run_id: RunId::new().to_string(),
                source_dispatch_event_ref: EventId::new(),
                source_dispatch_event_digest: format!("sha256:{}", "aa".repeat(32)),
                dispatch_envelope_digest: format!("sha256:{}", "bb".repeat(32)),
                witness_evidence_digest: format!("sha256:{}", "cc".repeat(32)),
                semantic_identity_digest: format!("sha256:{}", "dd".repeat(32)),
                idempotency_key: "smuggled".into(),
                ledger_authority_realm_digest: format!("sha256:{}", "ee".repeat(32)),
                admitted_at: "2026-08-17T00:00:00Z".into(),
            }),
        ),
        (
            "promotion_reconciliation_resolved",
            Payload::PromotionReconciliationResolvedV1(PromotionReconciliationResolvedV1 {
                candidate_digest: format!("sha256:{}", "aa".repeat(32)),
                promotion_decision_ref: "decision".into(),
                promotion_result_ref: "result".into(),
                promotion_receipt_ref: "receipt".into(),
                outcome: ReconciliationResolutionOutcomeV1::Abandon,
                authority: "operator:forged".into(),
                resolved_by: "operator:forged".into(),
                idempotency_key: "smuggled".into(),
                resolved_at: "2026-08-17T00:00:00Z".into(),
            }),
        ),
        (
            "plan_admitted",
            Payload::PlanAdmittedV1(PlanAdmittedV1 {
                plan_id: "pf-plan-001".into(),
                plan_digest: format!("sha256:{}", "aa".repeat(32)),
                input_digest: format!("sha256:{}", "bb".repeat(32)),
                trusted_base: "d".repeat(40),
                decided_by: "operator:forged".into(),
                decided_at: "2026-08-17T00:00:00Z".into(),
                idempotency_key: "planforge:v0:buildplane:dddddddd:abcd1234".into(),
                authorized_next_step: "dispatch_admitted_plan".into(),
            }),
        ),
    ];

    for (expected_wire, payload) in cases {
        let store = SqliteStore::open_in_memory().unwrap();
        // A permitted envelope label. `append` does not canonicalize, so nothing
        // else in this path would notice the mismatch.
        let outcome = store.append(&event_of(EventKind::ModelRequest, payload));

        assert!(
            matches!(
                outcome,
                Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
                    if kind == expected_wire
            ),
            "a {expected_wire} payload must be refused whatever kind it declares, got {outcome:?}"
        );
        assert_eq!(store.event_count().unwrap(), 0);
    }
}

#[test]
fn a_checkpoint_payload_is_refused_under_a_permitted_kind() {
    let store = SqliteStore::open_in_memory().unwrap();
    let smuggled = event_of(
        EventKind::ModelRequest,
        Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: RunId::new(),
            checkpoint_index: 0,
            through_event_id: EventId::new(),
            through_event_count: 1,
            previous_checkpoint_event_id: None,
            tape_root_hash: format!("sha256:{}", "aa".repeat(32)),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    );

    let outcome = store.append(&smuggled);

    assert!(
        matches!(outcome, Err(LedgerError::CallerSuppliedCheckpoint)),
        "a checkpoint payload must be refused whatever kind it declares, got {outcome:?}"
    );
    assert_eq!(store.event_count().unwrap(), 0);
}
