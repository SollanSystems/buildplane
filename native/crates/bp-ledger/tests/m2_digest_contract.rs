//! M2 signed-identity digest-contract guard (pre-S3 lock).
//!
//! The four M2 signed payloads that establish an admission/receipt identity
//! (`plan_admitted`, `plan_receipt`, `activity_started`, `activity_completed`)
//! must carry NO numeric *typed* field. A Rust `u64`/`i64`/`usize` field would
//! typeshare to a TS `number`, which cannot faithfully represent values above
//! 2^53 — silently diverging the signed wire shape across languages. Once a
//! `plan_admitted` event is signed in production, a wrong wire shape forces a
//! tape migration, so this guard fails closed at the source (the struct
//! definitions) if any future field reintroduces a number.
//!
//! See docs/architecture/canonical-digest-contract.md.

use bp_ledger::id::{EventId, RunId};
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use serde::Serialize;
use serde_json::Value;

fn numeric_paths(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Number(_) => out.push(path.to_string()),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                numeric_paths(item, &format!("{path}/{i}"), out);
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                numeric_paths(v, &format!("{path}/{k}"), out);
            }
        }
        _ => {}
    }
}

fn assert_no_numeric_fields<T: Serialize>(label: &str, payload: &T) {
    let value = serde_json::to_value(payload).unwrap();
    let mut found = Vec::new();
    numeric_paths(&value, "", &mut found);
    assert!(
        found.is_empty(),
        "{label} must carry no numeric typed field (u64 -> TS number hazard); found at: {found:?}"
    );
}

#[test]
fn plan_admitted_v1_has_no_numeric_field() {
    assert_no_numeric_fields(
        "PlanAdmittedV1",
        &PlanAdmittedV1 {
            plan_id: "pf-plan-001".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:khall".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        },
    );
}

#[test]
fn plan_receipt_v1_has_no_numeric_field() {
    assert_no_numeric_fields(
        "PlanReceiptRecordedV1",
        &PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        },
    );
}

#[test]
fn activity_started_v1_has_no_numeric_field() {
    assert_no_numeric_fields(
        "ActivityStartedV1",
        &ActivityStartedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        },
    );
}

#[test]
fn activity_completed_v1_typed_fields_have_no_numeric_field() {
    // `result` is an opaque serde_json::Value (recorded model/tool output) — it
    // is NOT a typed wire field and may legitimately contain numbers, so the
    // guard fixes it to a non-numeric value and asserts the TYPED fields only.
    assert_no_numeric_fields(
        "ActivityCompletedV1 (typed fields)",
        &ActivityCompletedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: serde_json::json!({ "content": "ok", "tool_calls": [] }),
        },
    );
}

#[test]
fn event_and_run_ids_serialize_as_json_strings() {
    // EventId/RunId are the only typeshared non-String types in the M2 payloads.
    // `#[serde(transparent)]` over a Uuid serializes to a JSON string, NOT a
    // u64 — the crux of the no-u64 finding (e.g. PlanReceipt.admission_event_id).
    assert!(serde_json::to_value(EventId::new()).unwrap().is_string());
    assert!(serde_json::to_value(RunId::new()).unwrap().is_string());
}
