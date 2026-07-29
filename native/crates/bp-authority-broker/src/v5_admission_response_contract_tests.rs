use crate::v5_admission_response::{
    sign_v5_admission_response_v1, verify_v5_admission_response_v1,
    V5AdmissionResponseRequestBindingV1, VerifiedV5AdmissionResponseV1,
};
use crate::v5_dispatch_admission::{
    BrokerV5DispatchAdmissionDisposition, SealedV5DispatchAdmissionEvidence,
};
use bp_ledger::{EventId, RunId};
use ed25519_dalek::SigningKey;
use serde_json::Value;
use uuid::Uuid;

fn digest(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn fixture() -> (
    SigningKey,
    V5AdmissionResponseRequestBindingV1,
    SealedV5DispatchAdmissionEvidence,
) {
    let run_id = RunId::new();
    let request_id = Uuid::now_v7();
    (
        SigningKey::from_bytes(&[91; 32]),
        V5AdmissionResponseRequestBindingV1::new(request_id, run_id, digest('a'))
            .expect("valid response binding"),
        SealedV5DispatchAdmissionEvidence {
            run_id,
            source_dispatch_event_id: EventId::new(),
            source_dispatch_event_digest: digest('b'),
            admission_event_id: EventId::new(),
            admission_event_digest: digest('c'),
            v5_envelope_digest: digest('a'),
            witness_evidence_digest: digest('d'),
            semantic_identity_digest: digest('e'),
            idempotency_key: "dispatch:v5:sealed:test".into(),
            checkpoint_event_id: EventId::new(),
            checkpoint_event_digest: digest('f'),
        },
    )
}

#[test]
fn signs_and_verifies_every_sealed_evidence_field() {
    let (key, binding, evidence) = fixture();
    let payload = sign_v5_admission_response_v1(
        &key,
        &binding,
        &BrokerV5DispatchAdmissionDisposition::Sealed(evidence.clone()),
    )
    .expect("signed response");

    assert_eq!(
        verify_v5_admission_response_v1(&payload, &key.verifying_key(), &binding)
            .expect("verified response"),
        VerifiedV5AdmissionResponseV1::Sealed(evidence)
    );
}

#[test]
fn signs_and_verifies_reconciliation_without_evidence() {
    let (key, binding, _) = fixture();
    let payload = sign_v5_admission_response_v1(
        &key,
        &binding,
        &BrokerV5DispatchAdmissionDisposition::ReconciliationRequired,
    )
    .expect("signed response");

    assert_eq!(
        verify_v5_admission_response_v1(&payload, &key.verifying_key(), &binding)
            .expect("verified response"),
        VerifiedV5AdmissionResponseV1::ReconciliationRequired
    );
}

#[test]
fn rejects_wrong_key_replay_and_request_substitution() {
    let (key, binding, evidence) = fixture();
    let payload = sign_v5_admission_response_v1(
        &key,
        &binding,
        &BrokerV5DispatchAdmissionDisposition::Sealed(evidence),
    )
    .expect("signed response");
    let substituted = V5AdmissionResponseRequestBindingV1::new(
        Uuid::now_v7(),
        binding.run_id(),
        binding.v5_envelope_digest().to_string(),
    )
    .expect("substituted binding");

    assert!(verify_v5_admission_response_v1(
        &payload,
        &SigningKey::from_bytes(&[92; 32]).verifying_key(),
        &binding
    )
    .is_err());
    assert!(verify_v5_admission_response_v1(&payload, &key.verifying_key(), &substituted).is_err());
}

#[test]
fn rejects_extended_wrong_domain_and_evidence_substituted_responses() {
    let (key, binding, evidence) = fixture();
    let payload = sign_v5_admission_response_v1(
        &key,
        &binding,
        &BrokerV5DispatchAdmissionDisposition::Sealed(evidence),
    )
    .expect("signed response");

    let original: Value = serde_json::from_slice(&payload).expect("response JSON");
    for field in [
        "run_id",
        "source_dispatch_event_id",
        "source_dispatch_event_digest",
        "admission_event_id",
        "admission_event_digest",
        "v5_envelope_digest",
        "witness_evidence_digest",
        "semantic_identity_digest",
        "idempotency_key",
        "checkpoint_event_id",
        "checkpoint_event_digest",
    ] {
        let mut json = original.clone();
        json["evidence"][field] = Value::String(match field {
            "idempotency_key" => "dispatch:v5:substituted".into(),
            name if name.ends_with("_digest") => digest('9'),
            _ => "00000000-0000-0000-0000-000000000000".into(),
        });
        assert!(
            verify_v5_admission_response_v1(
                &serde_json::to_vec(&json).expect("mutated JSON"),
                &key.verifying_key(),
                &binding,
            )
            .is_err(),
            "{field} substitution must fail"
        );
    }

    let mut wrong_domain = original.clone();
    wrong_domain["domain"] = Value::String("wrong-domain".into());
    assert!(verify_v5_admission_response_v1(
        &serde_json::to_vec(&wrong_domain).expect("mutated JSON"),
        &key.verifying_key(),
        &binding,
    )
    .is_err());

    let mut extended: Value = serde_json::from_slice(&payload).expect("response JSON");
    extended["authority"] = Value::String("attacker".into());
    assert!(verify_v5_admission_response_v1(
        &serde_json::to_vec(&extended).expect("extended JSON"),
        &key.verifying_key(),
        &binding,
    )
    .is_err());

    for mutation in [
        "protocol",
        "schema_version",
        "status",
        "signature",
        "unsigned",
    ] {
        let mut json = original.clone();
        match mutation {
            "protocol" => json["protocol"] = Value::String("wrong-protocol".into()),
            "schema_version" => json["schema_version"] = Value::from(2),
            "status" => json["status"] = Value::String("reconciliation_required".into()),
            "signature" => json["signature"] = Value::String("00".repeat(64)),
            "unsigned" => {
                json.as_object_mut()
                    .expect("response object")
                    .remove("signature");
            }
            _ => unreachable!(),
        }
        assert!(
            verify_v5_admission_response_v1(
                &serde_json::to_vec(&json).expect("mutated response"),
                &key.verifying_key(),
                &binding,
            )
            .is_err(),
            "{mutation} response must fail"
        );
    }
}
