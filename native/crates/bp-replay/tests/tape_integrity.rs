use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{sign_event, ActorKeyRef, EventSignatureV1, VerificationStatus};
use bp_replay::reader::VerifiedEvent;
use bp_replay::{verify_full_tape_integrity_v1, TapeIntegrityError, TapeIntegrityReportV1};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use uuid::Uuid;

const RUN_ID: &str = "01919000-0000-7000-8000-0000000000ff";
const SIGNED_AT: &str = "2026-07-19T00:00:00Z";

fn run_id() -> RunId {
    RunId::from_uuid(Uuid::parse_str(RUN_ID).unwrap())
}

fn event_id(n: u8) -> EventId {
    EventId::from_uuid(Uuid::parse_str(&format!("01919000-0000-7000-8000-{n:012}")).unwrap())
}

fn signed_at() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(SIGNED_AT)
        .unwrap()
        .with_timezone(&Utc)
}

fn kernel() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".to_string(),
        key_id: "kernel-main".to_string(),
        public_key_hash: None,
    }
}

fn ordinary_event(id: EventId) -> Event {
    Event {
        id,
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunCompleted,
        occurred_at: signed_at(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "1".to_string(),
            event_count: "1".to_string(),
            unit_count: "0".to_string(),
        }),
    }
}

fn verified(event: Event, key: &SigningKey) -> VerifiedEvent {
    let signature = sign_event(&event, key, &kernel(), signed_at()).unwrap();
    VerifiedEvent {
        event,
        verification: VerificationStatus::Verified,
        signature: Some(signature),
    }
}

fn checkpoint_event(
    id: EventId,
    through: EventId,
    ordinary_signatures: &[EventSignatureV1],
    parent_event_id: Option<EventId>,
) -> Event {
    checkpoint_event_with_chain_metadata(id, through, ordinary_signatures, parent_event_id, 0, None)
}

fn checkpoint_event_with_chain_metadata(
    id: EventId,
    through: EventId,
    ordinary_signatures: &[EventSignatureV1],
    parent_event_id: Option<EventId>,
    checkpoint_index: u64,
    previous_checkpoint_event_id: Option<EventId>,
) -> Event {
    Event {
        id,
        run_id: run_id(),
        parent_event_id,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::TapeCheckpoint,
        occurred_at: signed_at(),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: run_id(),
            checkpoint_index,
            through_event_id: through,
            through_event_count: ordinary_signatures.len() as u64,
            previous_checkpoint_event_id,
            tape_root_hash: tape_root_hash(
                &ordinary_signatures
                    .iter()
                    .map(|signature| signature.canonical_event_hash.clone())
                    .collect::<Vec<_>>(),
            ),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}

fn fully_checkpointed_tape() -> Vec<VerifiedEvent> {
    let key = SigningKey::from_bytes(&[7; 32]);
    let first = verified(ordinary_event(event_id(1)), &key);
    let second = verified(ordinary_event(event_id(2)), &key);
    let signatures = vec![
        first.signature.clone().unwrap(),
        second.signature.clone().unwrap(),
    ];
    let checkpoint = verified(
        checkpoint_event(
            event_id(3),
            second.event.id,
            &signatures,
            Some(second.event.id),
        ),
        &key,
    );
    vec![first, second, checkpoint]
}

fn fully_checkpointed_chain() -> Vec<VerifiedEvent> {
    let key = SigningKey::from_bytes(&[7; 32]);
    let first = verified(ordinary_event(event_id(1)), &key);
    let second = verified(ordinary_event(event_id(2)), &key);
    let first_signatures = vec![
        first.signature.clone().unwrap(),
        second.signature.clone().unwrap(),
    ];
    let first_checkpoint = verified(
        checkpoint_event_with_chain_metadata(
            event_id(3),
            second.event.id,
            &first_signatures,
            Some(second.event.id),
            0,
            None,
        ),
        &key,
    );
    let third = verified(ordinary_event(event_id(4)), &key);
    let all_signatures = vec![
        first.signature.clone().unwrap(),
        second.signature.clone().unwrap(),
        third.signature.clone().unwrap(),
    ];
    let second_checkpoint = verified(
        checkpoint_event_with_chain_metadata(
            event_id(5),
            third.event.id,
            &all_signatures,
            Some(third.event.id),
            1,
            Some(first_checkpoint.event.id),
        ),
        &key,
    );

    vec![first, second, first_checkpoint, third, second_checkpoint]
}

fn checkpoint_payload_mut(verified: &mut VerifiedEvent) -> &mut TapeCheckpointV1 {
    match &mut verified.event.payload {
        Payload::TapeCheckpointV1(payload) => payload,
        _ => panic!("fixture event must be a tape checkpoint"),
    }
}

#[test]
fn accepts_a_kernel_signed_checkpoint_covering_the_complete_signed_prefix() {
    let tape = fully_checkpointed_tape();
    let report =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .expect("the complete signed prefix is rooted by an authorized checkpoint");

    assert_eq!(report.schema_version, 1);
    assert_eq!(report.checkpoint_event_ref, event_id(3).to_string());
    assert_eq!(report.through_event_ref, event_id(2).to_string());
    assert_eq!(report.signed_non_checkpoint_event_count, 2);
}

#[test]
fn integrity_report_serializes_coverage_as_a_canonical_decimal_string() {
    let tape = fully_checkpointed_tape();
    let report =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .expect("the complete signed prefix is rooted by an authorized checkpoint");

    let encoded = serde_json::to_value(&report).expect("serialize integrity report");
    assert_eq!(
        encoded
            .get("signed_non_checkpoint_event_count")
            .and_then(serde_json::Value::as_str),
        Some("2")
    );
    let decoded = serde_json::from_value::<TapeIntegrityReportV1>(encoded)
        .expect("deserialize canonical integrity report");
    assert_eq!(decoded, report);
}

#[test]
fn integrity_report_rejects_noncanonical_coverage_values() {
    let tape = fully_checkpointed_tape();
    let report =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .expect("the complete signed prefix is rooted by an authorized checkpoint");

    for value in [
        serde_json::json!(2),
        serde_json::json!("02"),
        serde_json::json!("-1"),
        serde_json::json!("18446744073709551616"),
    ] {
        let mut encoded = serde_json::to_value(&report).expect("serialize integrity report");
        encoded
            .as_object_mut()
            .expect("integrity report is an object")
            .insert("signed_non_checkpoint_event_count".to_string(), value);

        assert!(
            serde_json::from_value::<TapeIntegrityReportV1>(encoded).is_err(),
            "noncanonical coverage value must fail closed"
        );
    }
}

#[test]
fn reports_the_latest_full_cover_checkpoint_from_a_valid_chain() {
    let tape = fully_checkpointed_chain();
    let report =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .expect("the complete checkpoint chain is valid");

    assert_eq!(report.checkpoint_event_ref, event_id(5).to_string());
    assert_eq!(report.through_event_ref, event_id(4).to_string());
    assert_eq!(report.signed_non_checkpoint_event_count, 3);
}

#[test]
fn rejects_a_chain_whose_first_checkpoint_does_not_start_at_zero() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[2]).checkpoint_index = 1;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(error.to_string().contains("checkpoint index"), "{error}");
}

#[test]
fn rejects_a_chain_with_nonconsecutive_checkpoint_indexes() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[4]).checkpoint_index = 2;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(error.to_string().contains("checkpoint index"), "{error}");
}

#[test]
fn rejects_a_chain_when_the_first_checkpoint_names_a_predecessor() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[2]).previous_checkpoint_event_id = Some(event_id(1));

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(
        error.to_string().contains("previous_checkpoint_event_id"),
        "{error}"
    );
}

#[test]
fn rejects_a_chain_with_the_wrong_predecessor_reference() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[4]).previous_checkpoint_event_id = Some(event_id(1));

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(
        error.to_string().contains("previous_checkpoint_event_id"),
        "{error}"
    );
}

#[test]
fn rejects_a_chain_that_reuses_the_previous_covered_prefix() {
    let mut tape = fully_checkpointed_chain();
    let first_checkpoint = match &tape[2].event.payload {
        Payload::TapeCheckpointV1(payload) => payload.clone(),
        _ => panic!("fixture event must be a tape checkpoint"),
    };
    let second_checkpoint = checkpoint_payload_mut(&mut tape[4]);
    second_checkpoint.through_event_id = first_checkpoint.through_event_id;
    second_checkpoint.through_event_count = first_checkpoint.through_event_count;
    second_checkpoint.tape_root_hash = first_checkpoint.tape_root_hash;
    tape[4].event.parent_event_id = Some(first_checkpoint.through_event_id);

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("does not advance covered prefix"),
        "{error}"
    );
}

#[test]
fn rejects_an_invalid_earlier_checkpoint_even_when_the_latest_checkpoint_is_valid() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[2]).tape_root_hash = "sha256:tampered".to_string();

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(error, TapeIntegrityError::TapeRootMismatch { .. }));
}

#[test]
fn rejects_an_earlier_checkpoint_with_the_wrong_covered_count() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[2]).through_event_count = 1;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CoverageCountMismatch { .. }
    ));
}

#[test]
fn rejects_an_earlier_checkpoint_with_the_wrong_parent() {
    let mut tape = fully_checkpointed_chain();
    tape[2].event.parent_event_id = None;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::UnanchoredCheckpoint { .. }
    ));
}

#[test]
fn rejects_an_earlier_checkpoint_for_a_different_run() {
    let mut tape = fully_checkpointed_chain();
    checkpoint_payload_mut(&mut tape[2]).run_id =
        RunId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-0000000000ee").unwrap());

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointRunMismatch { .. }
    ));
}

#[test]
fn rejects_an_earlier_checkpoint_not_signed_by_the_pinned_kernel() {
    let mut tape = fully_checkpointed_chain();
    tape[2].signature.as_mut().unwrap().signer.actor_id = "other-kernel".to_string();

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointSignerUnauthorized { .. }
    ));
}

#[test]
fn rejects_an_earlier_checkpoint_with_a_bad_detached_signature() {
    let mut tape = fully_checkpointed_chain();
    tape[2].verification = VerificationStatus::BadSignature;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointNotVerified {
            verification: VerificationStatus::BadSignature,
            ..
        }
    ));
}

#[test]
fn rejects_a_missing_checkpoint() {
    let tape = fully_checkpointed_tape();

    let error = verify_full_tape_integrity_v1(
        &tape[..2],
        RUN_ID,
        &tape[0].signature.as_ref().unwrap().signer,
    )
    .unwrap_err();

    assert!(matches!(error, TapeIntegrityError::MissingCheckpoint));
}

#[test]
fn rejects_an_uncheckpointed_signed_tail() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let mut tape = fully_checkpointed_tape();
    tape.push(verified(ordinary_event(event_id(4)), &key));

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::UncheckpointedSignedTail { .. }
    ));
}

#[test]
fn rejects_a_checkpoint_not_anchored_to_its_covered_event() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let first = verified(ordinary_event(event_id(1)), &key);
    let signature = first.signature.clone().unwrap();
    let checkpoint = verified(
        checkpoint_event(
            event_id(2),
            first.event.id,
            std::slice::from_ref(&signature),
            None,
        ),
        &key,
    );
    let error =
        verify_full_tape_integrity_v1(&[first, checkpoint], RUN_ID, &signature.signer).unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::UnanchoredCheckpoint { .. }
    ));
}

#[test]
fn rejects_an_unsigned_checkpoint_even_when_its_root_matches() {
    let mut tape = fully_checkpointed_tape();
    tape[2].verification = VerificationStatus::Unsigned;
    tape[2].signature = None;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointNotVerified { .. }
    ));
}

#[test]
fn rejects_a_checkpoint_with_a_bad_detached_signature() {
    let mut tape = fully_checkpointed_tape();
    tape[2].verification = VerificationStatus::BadSignature;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointNotVerified {
            verification: VerificationStatus::BadSignature,
            ..
        }
    ));
}

#[test]
fn governed_integrity_rejects_a_signed_ordinary_event_that_does_not_verify() {
    let mut tape = fully_checkpointed_tape();
    tape[0].verification = VerificationStatus::BadSignature;

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[1].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::SignedEventNotVerified {
            verification: VerificationStatus::BadSignature,
            ..
        }
    ));
}

#[test]
fn rejects_a_checkpoint_with_a_mismatched_root() {
    let mut tape = fully_checkpointed_tape();
    if let Payload::TapeCheckpointV1(checkpoint) = &mut tape[2].event.payload {
        checkpoint.tape_root_hash = "sha256:tampered".to_string();
    } else {
        panic!("fixture must end in a tape checkpoint");
    }

    let error =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap_err();

    assert!(matches!(error, TapeIntegrityError::TapeRootMismatch { .. }));
}

#[test]
fn rejects_a_checkpoint_not_signed_by_the_pinned_kernel() {
    let tape = fully_checkpointed_tape();
    let other_kernel = ActorKeyRef {
        actor_id: "other-kernel".to_string(),
        key_id: "kernel-main".to_string(),
        public_key_hash: tape[0]
            .signature
            .as_ref()
            .unwrap()
            .signer
            .public_key_hash
            .clone(),
    };

    let error = verify_full_tape_integrity_v1(&tape, RUN_ID, &other_kernel).unwrap_err();

    assert!(matches!(
        error,
        TapeIntegrityError::CheckpointSignerUnauthorized { .. }
    ));
}

#[test]
fn integrity_report_rejects_unknown_fields() {
    let tape = fully_checkpointed_tape();
    let report =
        verify_full_tape_integrity_v1(&tape, RUN_ID, &tape[0].signature.as_ref().unwrap().signer)
            .unwrap();
    let mut encoded = serde_json::to_value(&report).unwrap();
    encoded
        .as_object_mut()
        .unwrap()
        .insert("unexpected".to_string(), serde_json::Value::Null);

    let error = serde_json::from_value::<TapeIntegrityReportV1>(encoded).unwrap_err();

    assert!(error.to_string().contains("unexpected"));
}
