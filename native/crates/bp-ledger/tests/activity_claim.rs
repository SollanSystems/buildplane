//! Durable, signed activity-claim semantics.

use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::tape_root_hash;
use bp_ledger::payload::trust_spine::{
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
    governed_dispatch_policy_digest_v1, ActionEvidenceVersionV1, ActionKindV1, ActionRequestedV2,
    CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4,
    ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::serve::{
    serve_governed_with_protocol, serve_with_protocol_with_activity_claims,
    ActivityClaimProtocolConfig, GovernedServeProtocolConfigV1, SigningConfig,
};
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimDispositionV1, ActivityClaimRequestV1,
    ActivityHeartbeatDispositionV1, ActivityHeartbeatRequestV1, ActivityResultDispositionV1,
    ActivityResultRequestV1, CheckpointPolicy, GovernedVerifierClaimRequestV1,
    GovernedVerifierResultRequestV1, SqliteStore,
};
use bp_ledger::storage::Cas;
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::io::Cursor;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn signer() -> (SigningKey, ActorKeyRef, TrustedPublicKeys) {
    let signing_key = SigningKey::from_bytes(&[37u8; 32]);
    let signer = ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    };
    let mut trusted = TrustedPublicKeys::default();
    trusted.insert_public_key(
        public_key_hash(&signing_key.verifying_key()),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    (signing_key, signer, trusted)
}

fn trusted_actor(signing_key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&signing_key.verifying_key())),
    }
}

fn governed_protocol_for(
    run_id: RunId,
    signing_key: SigningKey,
    signer: ActorKeyRef,
    trusted: TrustedPublicKeys,
) -> (SigningConfig, GovernedServeProtocolConfigV1) {
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .expect("construct governed activity authority");
    (
        SigningConfig::Signed {
            signing_key,
            signer,
            checkpoint_policy: CheckpointPolicy::every(1_000),
        },
        GovernedServeProtocolConfigV1 {
            expected_run_id: run_id,
            activity_claim_authority: authority,
        },
    )
}

fn governed_handshake(run_id: RunId) -> String {
    format!(
        r#"{{"control":"handshake","protocol":1,"run_id":"{}","started_at":"2026-07-18T00:00:00Z","schema_version":1}}"#,
        run_id
    )
}

fn assert_current_signed_prefix_is_checkpointed(
    store: &SqliteStore,
    run_id: RunId,
    expected_ordinary_events: usize,
) {
    let mut ordinary = Vec::new();
    let mut checkpoints = Vec::new();
    for (event, signature) in store
        .signed_events_for_run(&run_id.to_string())
        .expect("read signed governed tape")
    {
        assert!(
            signature.is_some(),
            "governed tape records must have detached signatures"
        );
        if event.kind == EventKind::TapeCheckpoint {
            let Payload::TapeCheckpointV1(checkpoint) = event.payload else {
                panic!("tape checkpoint event must carry a checkpoint payload");
            };
            checkpoints.push(checkpoint);
        } else {
            ordinary.push(event);
        }
    }

    assert_eq!(ordinary.len(), expected_ordinary_events);
    let checkpoint = checkpoints
        .last()
        .expect("the current signed governed prefix must be checkpointed");
    let through = ordinary
        .last()
        .expect("a governed activity control must have signed an ordinary event");
    let hashes = ordinary
        .iter()
        .map(|event| canonical_event_hash(event).expect("canonical governed event hash"))
        .collect::<Vec<_>>();

    assert_eq!(checkpoint.run_id, run_id);
    assert_eq!(checkpoint.through_event_count, ordinary.len() as u64);
    assert_eq!(checkpoint.through_event_id, through.id);
    assert_eq!(checkpoint.tape_root_hash, tape_root_hash(&hashes));
}

fn control_response(stderr: Vec<u8>, control: &str) -> serde_json::Value {
    String::from_utf8(stderr)
        .expect("protocol response is utf-8")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("json response"))
        .find(|message| message["control"] == control)
        .unwrap_or_else(|| panic!("expected a {control} response"))
}

/// Mirrors the closed heartbeat request digest contract so cache-corruption
/// tests can model an attacker who replaces both mutable cache identity
/// columns. The signed heartbeat event, rather than this cache value, must
/// ultimately bind the request identity.
fn heartbeat_request_digest(request: &ActivityHeartbeatRequestV1) -> String {
    #[derive(serde::Serialize)]
    struct CanonicalHeartbeatRequest<'a> {
        schema_version: u8,
        run_id: String,
        activity_id: &'a str,
        idempotency_key: &'a str,
        lease_id: &'a str,
        heartbeat_id: &'a str,
    }

    let encoded = serde_json::to_vec(&CanonicalHeartbeatRequest {
        schema_version: 1,
        run_id: request.run_id.to_string(),
        activity_id: &request.activity_id,
        idempotency_key: &request.idempotency_key,
        lease_id: &request.lease_id,
        heartbeat_id: &request.heartbeat_id,
    })
    .expect("the closed heartbeat request serializes");
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.activity-heartbeat-request.v1\0");
    hasher.update(encoded);
    format!("sha256:{:x}", hasher.finalize())
}

fn append_governed_dispatch_and_request(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_expiry(
        store,
        signing_key,
        signer,
        "2099-07-18T00:00:00Z",
    )
}

fn append_sibling_governed_action_request(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    run_id: RunId,
    dispatch_event_id: EventId,
    source_action_request_event_id: EventId,
    activity_id: &str,
    idempotency_key: &str,
) -> EventId {
    let source_event = store
        .events_for_run(&run_id.to_string())
        .expect("read source governed action request")
        .into_iter()
        .find(|row| row.id == source_action_request_event_id.to_string())
        .expect("source governed action request exists")
        .to_event()
        .expect("source governed action request decodes");
    let Payload::ActionRequestedV2(mut request) = source_event.payload else {
        panic!("source event must carry action_requested_v2");
    };
    request.action_id = activity_id.into();
    request.idempotency_key = idempotency_key.into();

    let event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event_id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: Utc::now(),
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&event, signing_key, signer)
        .expect("append sibling governed action request");
    event.id
}

fn append_governed_dispatch_and_request_with_expiry(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    expires_at: &str,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_timing(
        store,
        signing_key,
        signer,
        "2026-07-18T00:00:00Z",
        "2026-07-18T00:00:01Z",
        expires_at,
        ActionEvidenceVersionV1::SealedV3,
    )
}

fn append_governed_dispatch_and_request_with_timing(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    issued_at: &str,
    requested_at: &str,
    expires_at: &str,
    action_evidence_version: ActionEvidenceVersionV1,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_timing_and_request_packet_digest(
        store,
        signing_key,
        signer,
        issued_at,
        requested_at,
        expires_at,
        action_evidence_version,
        None,
    )
}

/// Builds otherwise-valid signed dispatch/request evidence while allowing a
/// regression test to substitute or omit the request's packet binding. The
/// native claim boundary, not append-time structural parsing, must reject that
/// substitution before it can grant an effect lease.
fn append_governed_dispatch_and_request_with_timing_and_request_packet_digest(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    issued_at: &str,
    requested_at: &str,
    expires_at: &str,
    action_evidence_version: ActionEvidenceVersionV1,
    request_packet_digest_override: Option<Option<String>>,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_timing_and_request_bindings(
        store,
        signing_key,
        signer,
        issued_at,
        requested_at,
        expires_at,
        action_evidence_version,
        request_packet_digest_override,
        None,
        ExecutionRoleV1::Implementer,
    )
}

fn append_governed_dispatch_and_request_with_timing_and_request_bindings(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    issued_at: &str,
    requested_at: &str,
    expires_at: &str,
    action_evidence_version: ActionEvidenceVersionV1,
    request_packet_digest_override: Option<Option<String>>,
    request_policy_digest_override: Option<String>,
    execution_role: ExecutionRoleV1,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm(
        store,
        signing_key,
        signer,
        issued_at,
        requested_at,
        expires_at,
        action_evidence_version,
        request_packet_digest_override,
        request_policy_digest_override,
        execution_role,
        DIGEST_B,
    )
}

fn append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    issued_at: &str,
    requested_at: &str,
    expires_at: &str,
    action_evidence_version: ActionEvidenceVersionV1,
    request_packet_digest_override: Option<Option<String>>,
    request_policy_digest_override: Option<String>,
    execution_role: ExecutionRoleV1,
    ledger_authority_realm_digest: &str,
) -> (RunId, EventId, EventId) {
    append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm_and_compute_budget(
        store,
        signing_key,
        signer,
        issued_at,
        requested_at,
        expires_at,
        action_evidence_version,
        request_packet_digest_override,
        request_policy_digest_override,
        execution_role,
        ledger_authority_realm_digest,
        None,
    )
}

fn append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm_and_compute_budget(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    issued_at: &str,
    requested_at: &str,
    expires_at: &str,
    action_evidence_version: ActionEvidenceVersionV1,
    request_packet_digest_override: Option<Option<String>>,
    request_policy_digest_override: Option<String>,
    execution_role: ExecutionRoleV1,
    ledger_authority_realm_digest: &str,
    max_compute_time_ms: Option<u32>,
) -> (RunId, EventId, EventId) {
    let run_id = RunId::new();
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        execution_role,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_A.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_000),
            max_compute_time_ms,
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".into(),
        issued_at: issued_at.into(),
        expires_at: expires_at.into(),
    };
    let governed_packet_digest = (action_evidence_version == ActionEvidenceVersionV1::SealedV3)
        .then(|| DIGEST_A.to_string());
    let dispatch = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            action_evidence_version,
            DIGEST_A,
            ledger_authority_realm_digest,
            governed_packet_digest.as_deref(),
        )
        .unwrap(),
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: ledger_authority_realm_digest.into(),
        governed_packet_digest: governed_packet_digest.clone(),
    };
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, signing_key, signer)
        .unwrap();

    let request = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input:1".into(),
        dispatch_envelope_digest: dispatch.envelope_digest,
        repository_binding_digest: dispatch.repository_binding_digest,
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest,
        governed_packet_digest: request_packet_digest_override
            .unwrap_or(dispatch.governed_packet_digest),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: request_policy_digest_override.unwrap_or_else(|| {
            governed_dispatch_policy_digest_v1(&dispatch.body.acceptance_contract_digest)
                .expect("fixture dispatch has a canonical acceptance-contract digest")
        }),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: requested_at.into(),
    };
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: Utc::now(),
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&request_event, signing_key, signer)
        .unwrap();
    (run_id, dispatch_event.id, request_event.id)
}

fn claim_request(
    run_id: RunId,
    dispatch_event_id: EventId,
    action_request_event_id: EventId,
) -> ActivityClaimRequestV1 {
    ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        dispatch_event_id,
        action_request_event_id,
        lease_duration_ms: 60_000,
    }
}

fn append_graph_bound_v4_dispatch_and_request<F>(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    select_request_dispatch_digest: F,
) -> (RunId, EventId, EventId, String, String)
where
    F: FnOnce(&DispatchEnvelopeV4) -> String,
{
    let run_id = RunId::new();
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v4".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v4".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:v4".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_A.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_000),
            max_compute_time_ms: None,
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-v4:unit-v4:1".into(),
        issued_at: "2026-07-18T00:00:00Z".into(),
        expires_at: "2099-07-18T00:00:00Z".into(),
    };
    let dispatch_v3 = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            ActionEvidenceVersionV1::SealedV3,
            DIGEST_A,
            DIGEST_B,
            Some(DIGEST_A),
        )
        .expect("hash nested V3 dispatch"),
        body,
        action_evidence_version: ActionEvidenceVersionV1::SealedV3,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: Some(DIGEST_A.into()),
    };
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: DIGEST_A.into(),
        workflow_graph_declaration_event_ref: EventId::new(),
        envelope_digest: String::new(),
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .expect("hash graph-bound V4 dispatch");
    let request_dispatch_digest = select_request_dispatch_digest(&dispatch_v4);
    let nested_digest = dispatch_v4.dispatch_v3.envelope_digest.clone();
    let outer_digest = dispatch_v4.envelope_digest.clone();
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV4,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV4(dispatch_v4.clone()),
    };
    store
        .append_signed(&dispatch_event, signing_key, signer)
        .expect("append graph-bound V4 dispatch");
    let request = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch_v4.dispatch_v3.body.workflow_id.clone(),
        unit_id: dispatch_v4.dispatch_v3.body.unit_id.clone(),
        attempt: dispatch_v4.dispatch_v3.body.attempt,
        provenance_ref: dispatch_v4.dispatch_v3.body.provenance_ref.clone(),
        action_id: "action-v4".into(),
        idempotency_key: "action:workflow-v4:unit-v4:1".into(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input:v4".into(),
        dispatch_envelope_digest: request_dispatch_digest,
        repository_binding_digest: dispatch_v4.dispatch_v3.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch_v4
            .dispatch_v3
            .ledger_authority_realm_digest
            .clone(),
        governed_packet_digest: dispatch_v4.dispatch_v3.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch_v4
            .dispatch_v3
            .body
            .capability_bundle_digest
            .clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch_v4.dispatch_v3.body.acceptance_contract_digest,
        )
        .expect("derive V4 action policy binding"),
        context_manifest_digest: dispatch_v4.dispatch_v3.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch_v4.dispatch_v3.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch_v4.dispatch_v3.body.sandbox_profile_digest.clone(),
        authority_actor: signer.actor_id.clone(),
        execution_role: dispatch_v4.dispatch_v3.body.execution_role,
        requested_at: "2026-07-18T00:00:01Z".into(),
    };
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: Utc::now(),
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&request_event, signing_key, signer)
        .expect("append outer-bound V4 action request");
    (
        run_id,
        dispatch_event.id,
        request_event.id,
        outer_digest,
        nested_digest,
    )
}

#[test]
fn activity_claim_v4_binds_the_outer_dispatch_digest_and_rejects_inner_or_wrong_digests() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let (signing_key, signer, trusted) = signer();
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted.clone(),
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor.clone(),
        DIGEST_B.into(),
    )
    .expect("construct governed authority");
    let (run_id, dispatch_event_id, request_event_id, outer_digest, _) =
        append_graph_bound_v4_dispatch_and_request(&store, &signing_key, &signer, |dispatch| {
            dispatch.envelope_digest.clone()
        });
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-v4".into(),
        idempotency_key: "action:workflow-v4:unit-v4:1".into(),
        dispatch_event_id,
        action_request_event_id: request_event_id,
        lease_duration_ms: 60_000,
    };
    let granted = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .expect("outer V4 digest must grant an activity claim");
    assert!(matches!(
        granted,
        ActivityClaimDispositionV1::Granted { .. }
    ));
    let signed_claim = store
        .events_for_run(&run_id.to_string())
        .expect("read activity tape")
        .into_iter()
        .find_map(
            |row| match row.to_event().expect("decode claim event").payload {
                Payload::ActivityClaimedV1(claim) => Some(claim),
                _ => None,
            },
        )
        .expect("a signed activity claim was appended");
    assert_eq!(signed_claim.dispatch_event_id, dispatch_event_id);
    assert_eq!(signed_claim.dispatch_envelope_digest, outer_digest);

    for (label, use_nested_digest) in [("nested V3", true), ("unrelated", false)] {
        let rejected_store = SqliteStore::open_in_memory().expect("open rejected store");
        let (rejected_run_id, rejected_dispatch_event_id, rejected_request_event_id, _, nested) =
            append_graph_bound_v4_dispatch_and_request(
                &rejected_store,
                &signing_key,
                &signer,
                |dispatch| {
                    if use_nested_digest {
                        dispatch.dispatch_v3.envelope_digest.clone()
                    } else {
                        DIGEST_A.into()
                    }
                },
            );
        let rejected = ActivityClaimRequestV1 {
            run_id: rejected_run_id,
            activity_id: "action-v4".into(),
            idempotency_key: "action:workflow-v4:unit-v4:1".into(),
            dispatch_event_id: rejected_dispatch_event_id,
            action_request_event_id: rejected_request_event_id,
            lease_duration_ms: 60_000,
        };
        let error = rejected_store
            .claim_activity_v1(&rejected, &authority, &signing_key, &signer)
            .expect_err("only the outer V4 digest may mint a claim");
        assert!(matches!(
            error,
            bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
        ));
        assert_eq!(
            rejected_store.event_count().expect("count rejected tape"),
            2,
            "{label} digest ({nested}) must not append an activity claim"
        );
    }
}

#[test]
fn signed_claim_is_written_once_and_duplicate_is_pending() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);

    let first = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap();
    assert!(matches!(first, ActivityClaimDispositionV1::Granted { .. }));
    assert_eq!(store.event_count().unwrap(), 3, "claim must be tape-backed");

    let duplicate = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityClaimDispositionV1::Pending { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "duplicate idempotency key must never mint a second signed claim"
    );
}

#[test]
fn governed_realm_authority_rejects_a_correctly_signed_foreign_realm_dispatch() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    // The fixture dispatch/request are both signed and internally consistent
    // for DIGEST_B. A realm-A server must still reject them before a claim can
    // be written, proving that copied workspace/tape evidence cannot select a
    // second activity-claim authority realm.
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_A.into(),
    )
    .unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);

    let error = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap_err();

    assert!(error
        .to_string()
        .contains("protected governed ledger authority realm"));
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "foreign realm must not mint a claim"
    );
}

#[test]
fn activity_lease_never_outlives_its_signed_dispatch() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_expiry(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:02Z",
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let now: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let grant = store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, now)
        .unwrap();
    let lease_id = match grant {
        ActivityClaimDispositionV1::Granted {
            lease_id,
            lease_expires_at,
            ..
        } => {
            assert_eq!(lease_expires_at, "2026-07-18T00:00:02.000Z");
            lease_id
        }
        other => panic!("expected first claim to grant, got {other:?}"),
    };
    let late_result = ActivityResultRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:evidence:1".into(),
    };
    let late = store
        .record_activity_result_v1_at_for_tests(
            &late_result,
            &authority,
            &signing_key,
            &signer,
            now + Duration::seconds(3),
        )
        .unwrap();
    assert!(matches!(
        late,
        ActivityResultDispositionV1::LeaseExpired { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 3);
}

#[test]
fn activity_lease_is_clamped_to_the_signed_compute_deadline_and_cannot_start_after_it() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm_and_compute_budget(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2026-07-18T00:10:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Implementer,
            DIGEST_B,
            Some(2_000),
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let now: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let grant = store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, now)
        .unwrap();
    assert!(matches!(
        grant,
        ActivityClaimDispositionV1::Granted {
            lease_expires_at,
            ..
        } if lease_expires_at == "2026-07-18T00:00:02.000Z"
    ));

    let expired_store = SqliteStore::open_in_memory().unwrap();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm_and_compute_budget(
            &expired_store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2026-07-18T00:10:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Implementer,
            DIGEST_B,
            Some(2_000),
        );
    let expired_claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let deadline: chrono::DateTime<Utc> = "2026-07-18T00:00:02Z".parse().unwrap();
    let error = expired_store
        .claim_activity_v1_at_for_tests(&expired_claim, &authority, &signing_key, &signer, deadline)
        .expect_err("claim at the signed compute deadline must be denied");
    assert!(error.to_string().contains("compute deadline"));
    assert_eq!(
        expired_store.event_count().unwrap(),
        2,
        "a deadline-denied claim must not append an authority event"
    );
}

#[test]
fn activity_claims_require_the_sealed_v3_wire_contract() {
    assert_eq!(
        serde_json::to_string(&ActionEvidenceVersionV1::SealedV2).unwrap(),
        r#""sealed-v2""#,
        "the additive legacy payload spelling remains readable"
    );
    assert_eq!(
        serde_json::to_string(&ActionEvidenceVersionV1::SealedV3).unwrap(),
        r#""sealed_v3""#,
        "sealed V3 authority bytes use the explicit underscore wire revision"
    );
    assert!(
        serde_json::from_str::<ActionEvidenceVersionV1>(r#""sealed-v3""#).is_err(),
        "a near-miss spelling must not silently select the executable protocol"
    );

    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV2,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let error = store
        .claim_activity_v1(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer,
        )
        .expect_err("legacy SealedV2 evidence must not issue an executable activity claim");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
}

#[test]
fn sealed_v3_claims_reject_missing_or_mismatched_action_request_packet_digest() {
    for (label, request_packet_digest_override) in [
        ("missing", Some(None)),
        ("mismatched", Some(Some(DIGEST_B.to_string()))),
    ] {
        let store = SqliteStore::open_in_memory().unwrap();
        let (signing_key, signer, trusted) = signer();
        let (run_id, dispatch_event_id, action_request_event_id) =
            append_governed_dispatch_and_request_with_timing_and_request_packet_digest(
                &store,
                &signing_key,
                &signer,
                "2026-07-18T00:00:00Z",
                "2026-07-18T00:00:01Z",
                "2099-07-18T00:00:00Z",
                ActionEvidenceVersionV1::SealedV3,
                request_packet_digest_override,
            );
        let trusted_actor = trusted_actor(&signing_key);
        let authority = ActivityClaimAuthorityV1::new(
            trusted,
            trusted_actor.clone(),
            trusted_actor.clone(),
            trusted_actor,
        )
        .unwrap();

        let error = store
            .claim_activity_v1(
                &claim_request(run_id, dispatch_event_id, action_request_event_id),
                &authority,
                &signing_key,
                &signer,
            )
            .expect_err("a sealed_v3 request must bind the exact dispatch packet digest");
        assert!(
            error
                .to_string()
                .contains("action request does not exactly bind the trusted governed dispatch"),
            "{label} packet digest must be rejected: {error}"
        );
        assert_eq!(
            store.event_count().unwrap(),
            2,
            "{label} packet digest must not mint an activity claim"
        );
    }
}

#[test]
fn sealed_v3_claims_reject_a_caller_selected_policy_digest() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            Some(DIGEST_A.into()),
            ExecutionRoleV1::Implementer,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();

    let error = store
        .claim_activity_v1(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer,
        )
        .expect_err("a caller-selected policy digest must not issue an effect lease");
    assert!(error
        .to_string()
        .contains("policy_digest does not match the policy binding"));
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "rejected policy binding must not append a claim"
    );
}

#[test]
fn governed_verifier_claim_and_result_derive_the_effect_identity_from_signed_reviewer_evidence() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Reviewer,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    let claim = store
        .claim_governed_verifier_v1(
            &GovernedVerifierClaimRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms: 60_000,
            },
            &authority,
            &signing_key,
            &signer,
        )
        .expect("signed reviewer process action receives one verifier lease");
    let lease_id = match claim {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a fresh verifier lease, got {other:?}"),
    };

    let result = store
        .record_governed_verifier_result_v1(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id,
                outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
                result_digest: Some(DIGEST_A.into()),
                result_ref: Some("cas:verifier-result:1".into()),
                evidence_digest: DIGEST_B.into(),
                evidence_ref: "cas:verifier-evidence:1".into(),
            },
            &authority,
            &signing_key,
            &signer,
        )
        .expect("verifier result derives activity identity from its lease");
    assert!(matches!(
        result,
        ActivityResultDispositionV1::Recorded { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 4);
}

#[test]
fn governed_verifier_expired_lease_can_record_unknown_from_its_historical_claim_lineage() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let claim_at: chrono::DateTime<Utc> = "2026-07-18T00:01:00Z".parse().unwrap();
    let result_at = claim_at + Duration::seconds(2);
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:01:00Z",
            "2026-07-18T00:01:00Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Reviewer,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    let claim = store
        .claim_governed_verifier_v1_at_for_tests(
            &GovernedVerifierClaimRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms: 1_000,
            },
            &authority,
            &signing_key,
            &signer,
            claim_at,
        )
        .expect("the signed reviewer action is valid at its historical claim time");
    let lease_id = match claim {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a fresh verifier lease, got {other:?}"),
    };

    let result = store
        .record_governed_verifier_result_v1_at_for_tests(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id,
                outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown,
                result_digest: None,
                result_ref: None,
                evidence_digest: DIGEST_B.into(),
                evidence_ref: "cas:verifier-evidence:expired-unknown".into(),
            },
            &authority,
            &signing_key,
            &signer,
            result_at,
        )
        .expect("expired verifier leases must record only unknown, after historical lineage verification");
    assert!(matches!(
        result,
        ActivityResultDispositionV1::Recorded {
            outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown,
            ..
        }
    ));
    assert_eq!(store.event_count().unwrap(), 4);
}

#[test]
fn governed_verifier_rejects_an_implementer_action_before_claiming() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    let error = store
        .claim_governed_verifier_v1(
            &GovernedVerifierClaimRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms: 60_000,
            },
            &authority,
            &signing_key,
            &signer,
        )
        .expect_err("the verifier lane must not claim implementer work");
    assert!(error.to_string().contains("signed reviewer process action"));
    assert_eq!(store.event_count().unwrap(), 2);
}

#[test]
fn governed_verifier_result_rejects_a_lease_for_an_implementer_action() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    // Exercise the terminal wrapper independently of its claim wrapper. A
    // pre-existing generic lease must not be reclassified as reviewer work
    // just because its opaque lease string is presented to this endpoint.
    let generic_claim = store
        .claim_activity_v1(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer,
        )
        .expect("the generic fixture claim is valid implementer work");
    let lease_id = match generic_claim {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a fresh generic lease, got {other:?}"),
    };

    let error = store
        .record_governed_verifier_result_v1(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id,
                outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Failed,
                result_digest: None,
                result_ref: None,
                evidence_digest: DIGEST_A.into(),
                evidence_ref: "cas:verifier-evidence:implementer".into(),
            },
            &authority,
            &signing_key,
            &signer,
        )
        .expect_err("verifier result endpoint must reject an implementer lease");
    assert!(error.to_string().contains("fixed verifier claim lane"));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "a rejected verifier result must not append a terminal event"
    );
}

#[test]
fn governed_verifier_result_rejects_a_generic_reviewer_process_lease() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Reviewer,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    // This is otherwise-valid reviewer work, but it was reserved through the
    // generic claim API. It must never be relabeled as fixed verifier work by
    // presenting the opaque lease to the narrower result endpoint.
    let generic_claim = store
        .claim_activity_v1(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer,
        )
        .expect("generic reviewer process claim is valid outside the fixed verifier lane");
    let lease_id = match generic_claim {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a fresh generic reviewer lease, got {other:?}"),
    };

    let error = store
        .record_governed_verifier_result_v1(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id,
                outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Failed,
                result_digest: None,
                result_ref: None,
                evidence_digest: DIGEST_A.into(),
                evidence_ref: "cas:verifier-evidence:generic-reviewer".into(),
            },
            &authority,
            &signing_key,
            &signer,
        )
        .expect_err("fixed verifier result must reject a generic reviewer lease");
    assert!(error.to_string().contains("fixed verifier claim lane"));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "rejected lane confusion must not append a terminal result"
    );
}

#[test]
fn governed_verifier_result_revalidates_the_claimed_realm_at_historical_claim_time() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing_and_request_bindings_and_realm(
            &store,
            &signing_key,
            &signer,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:01Z",
            "2099-07-18T00:00:00Z",
            ActionEvidenceVersionV1::SealedV3,
            None,
            None,
            ExecutionRoleV1::Reviewer,
            DIGEST_A,
        );
    let trusted_actor = trusted_actor(&signing_key);
    let foreign_realm_authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted.clone(),
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor.clone(),
        DIGEST_A.into(),
    )
    .unwrap();
    let local_realm_authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
        DIGEST_B.into(),
    )
    .unwrap();

    let claim = store
        .claim_governed_verifier_v1(
            &GovernedVerifierClaimRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms: 60_000,
            },
            &foreign_realm_authority,
            &signing_key,
            &signer,
        )
        .expect("the foreign realm can validly issue its own fixed verifier lease");
    let lease_id = match claim {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a fresh foreign-realm verifier lease, got {other:?}"),
    };

    let error = store
        .record_governed_verifier_result_v1(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id,
                outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown,
                result_digest: None,
                result_ref: None,
                evidence_digest: DIGEST_B.into(),
                evidence_ref: "cas:verifier-evidence:foreign-realm".into(),
            },
            &local_realm_authority,
            &signing_key,
            &signer,
        )
        .expect_err("a local verifier result endpoint must reject a foreign-realm lease");
    assert!(error
        .to_string()
        .contains("does not bind this protected governed ledger authority realm"));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "foreign realm result rejection must not append a terminal event"
    );
}

#[test]
fn activity_claims_enforce_dispatch_and_action_request_time_windows() {
    let claim_at: chrono::DateTime<Utc> = "2026-07-18T00:01:00Z".parse().unwrap();

    // `issued_at <= now` is intentionally inclusive: the signed tape order
    // provides ordering when RFC3339 timestamps have the same precision.
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer_ref, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer_ref,
            "2026-07-18T00:01:00Z",
            "2026-07-18T00:01:00Z",
            "2026-07-18T00:02:00Z",
            ActionEvidenceVersionV1::SealedV3,
        );
    let authority_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        authority_actor.clone(),
        authority_actor.clone(),
        authority_actor,
    )
    .unwrap();
    assert!(matches!(
        store
            .claim_activity_v1_at_for_tests(
                &claim_request(run_id, dispatch_event_id, action_request_event_id),
                &authority,
                &signing_key,
                &signer_ref,
                claim_at.clone(),
            )
            .unwrap(),
        ActivityClaimDispositionV1::Granted { .. }
    ));

    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer_ref, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer_ref,
            "2026-07-18T00:01:01Z",
            "2026-07-18T00:01:01Z",
            "2026-07-18T00:02:00Z",
            ActionEvidenceVersionV1::SealedV3,
        );
    let authority_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        authority_actor.clone(),
        authority_actor.clone(),
        authority_actor,
    )
    .unwrap();
    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer_ref,
            claim_at.clone(),
        )
        .expect_err("a future dispatch must not issue a claim before issued_at");
    assert!(error
        .to_string()
        .contains("dispatch authority is not yet active"));

    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer_ref, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer_ref,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:01:00Z",
            "2026-07-18T00:01:00Z",
            ActionEvidenceVersionV1::SealedV3,
        );
    let authority_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        authority_actor.clone(),
        authority_actor.clone(),
        authority_actor,
    )
    .unwrap();
    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer_ref,
            claim_at.clone(),
        )
        .expect_err("dispatch expiry is exclusive at the activity claim boundary");
    assert!(error.to_string().contains("dispatch authority has expired"));

    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer_ref, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer_ref,
            "2026-07-18T00:01:00Z",
            "2026-07-18T00:00:59Z",
            "2026-07-18T00:02:00Z",
            ActionEvidenceVersionV1::SealedV3,
        );
    let authority_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        authority_actor.clone(),
        authority_actor.clone(),
        authority_actor,
    )
    .unwrap();
    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer_ref,
            claim_at.clone(),
        )
        .expect_err("an action request before dispatch issuance must be rejected");
    assert!(error
        .to_string()
        .contains("action request predates its governed dispatch authority"));

    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer_ref, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request_with_timing(
            &store,
            &signing_key,
            &signer_ref,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:01:01Z",
            "2026-07-18T00:02:00Z",
            ActionEvidenceVersionV1::SealedV3,
        );
    let authority_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        authority_actor.clone(),
        authority_actor.clone(),
        authority_actor,
    )
    .unwrap();
    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request(run_id, dispatch_event_id, action_request_event_id),
            &authority,
            &signing_key,
            &signer_ref,
            claim_at,
        )
        .expect_err("an action request cannot be dated after its activity claim");
    assert!(error
        .to_string()
        .contains("action request timestamp is after the activity claim time"));
}

#[test]
fn signed_protocol_claim_requires_explicit_authority_and_appends_one_grant() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let signing = SigningConfig::Signed {
        signing_key,
        signer,
        checkpoint_policy: CheckpointPolicy::Disabled,
    };
    let input = format!(
        concat!(
            r#"{{"control":"handshake","protocol":1,"run_id":"{}","started_at":"2026-07-18T00:00:00Z","schema_version":1}}"#,
            "\n",
            r#"{{"control":"claim_activity_v1","request_id":"claim-1","run_id":"{}","activity_id":"action-1","idempotency_key":"action:workflow-1:unit-1:1","dispatch_event_id":"{}","action_request_event_id":"{}","lease_duration_ms":1000}}"#,
            "\n",
            r#"{{"control":"close","seq":0}}"#,
            "\n",
        ),
        run_id, run_id, dispatch_event_id, action_request_event_id,
    );
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol_with_activity_claims(
        Cursor::new(input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &ActivityClaimProtocolConfig::Signed(authority),
    )
    .unwrap();

    // `ServeOutcome` intentionally counts ordinary JSONL event ingestion, not
    // control-originated tape records. The tape itself still gained the
    // signed claim event.
    assert_eq!(outcome.events_written, 0);
    assert_eq!(store.event_count().unwrap(), 3);
    let messages: Vec<serde_json::Value> = String::from_utf8(stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let result = messages
        .iter()
        .find(|message| message["control"] == "claim_activity_v1_result")
        .expect("claim must receive one typed response");
    assert_eq!(result["request_id"], "claim-1");
    assert_eq!(result["outcome"], "granted");
    assert!(result["lease_id"].as_str().is_some());
}

#[test]
fn governed_activity_controls_seal_each_current_signed_prefix() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let (signing, config) = governed_protocol_for(run_id, signing_key, signer, trusted);

    let claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        claim
    );
    let mut stderr = Vec::new();
    serve_governed_with_protocol(
        Cursor::new(input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("governed claim is recorded");
    let claim_response = control_response(stderr, "claim_activity_v1_result");
    assert_eq!(claim_response["outcome"], "granted");
    let lease_id = claim_response["lease_id"]
        .as_str()
        .expect("granted claim returns a lease id")
        .to_owned();
    assert_current_signed_prefix_is_checkpointed(&store, run_id, 3);

    let heartbeat = serde_json::json!({
        "control": "heartbeat_activity_v1",
        "request_id": "heartbeat-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "lease_id": lease_id.clone(),
        "heartbeat_id": "heartbeat-1",
    });
    let input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        heartbeat
    );
    let mut stderr = Vec::new();
    serve_governed_with_protocol(
        Cursor::new(input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("governed heartbeat is recorded");
    let heartbeat_response = control_response(stderr, "heartbeat_activity_v1_result");
    assert_eq!(heartbeat_response["outcome"], "recorded");
    assert_current_signed_prefix_is_checkpointed(&store, run_id, 4);

    let result = serde_json::json!({
        "control": "record_activity_result_v1",
        "request_id": "result-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "lease_id": lease_id,
        "outcome": "succeeded",
        "result_digest": DIGEST_A,
        "result_ref": "cas:result:1",
        "evidence_digest": DIGEST_B,
        "evidence_ref": "cas:evidence:1",
    });
    let input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        result
    );
    let mut stderr = Vec::new();
    serve_governed_with_protocol(
        Cursor::new(input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("governed result is recorded");
    let result_response = control_response(stderr, "record_activity_result_v1_result");
    assert_eq!(result_response["outcome"], "recorded");
    assert_current_signed_prefix_is_checkpointed(&store, run_id, 5);
}

#[test]
fn governed_checkpoint_failure_suppresses_success_until_idempotent_retry_seals() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let retry_action_request_event_id = append_sibling_governed_action_request(
        &store,
        &signing_key,
        &signer,
        run_id,
        dispatch_event_id,
        action_request_event_id,
        "action-2",
        "action:workflow-1:unit-1:2",
    );
    let (signing, config) = governed_protocol_for(run_id, signing_key, signer, trusted);
    let initial_claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let initial_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        initial_claim
    );
    serve_governed_with_protocol(
        Cursor::new(initial_input.as_bytes()),
        Vec::new(),
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("initial claim seals the prefix for the later preflight");

    let retry_claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-2",
        "run_id": run_id,
        "activity_id": "action-2",
        "idempotency_key": "action:workflow-1:unit-1:2",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": retry_action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        retry_claim
    );

    store.fail_next_checkpoint_signature_insert_for_tests();
    let mut failed_stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(input.as_bytes()),
        &mut failed_stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("a failed governed checkpoint must suppress the claim success response");
    assert!(error
        .to_string()
        .contains("injected checkpoint signature insert failure"));
    let failed_output = String::from_utf8(failed_stderr).unwrap();
    assert!(failed_output.contains("handshake_ack"));
    assert!(
        !failed_output.contains("claim_activity_v1_result"),
        "the durable claim must not be reported successful until its prefix is sealed"
    );
    assert_eq!(
        store.event_count().unwrap(),
        7,
        "the second claim commits before its post-mutation checkpoint fails"
    );

    let retry = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-retry",
        "run_id": run_id,
        "activity_id": "action-2",
        "idempotency_key": "action:workflow-1:unit-1:2",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": retry_action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let retry_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        retry
    );
    let mut retry_stderr = Vec::new();
    serve_governed_with_protocol(
        Cursor::new(retry_input.as_bytes()),
        &mut retry_stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("an idempotent retry seals the existing claim prefix");
    let retry_response = control_response(retry_stderr, "claim_activity_v1_result");
    assert_eq!(retry_response["outcome"], "pending");
    assert_eq!(store.event_count().unwrap(), 8);
    assert_current_signed_prefix_is_checkpointed(&store, run_id, 5);
}

#[test]
fn governed_idempotent_retry_rejects_a_tampered_existing_checkpoint() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let (signing, config) = governed_protocol_for(run_id, signing_key, signer, trusted);
    let claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        claim
    );
    serve_governed_with_protocol(
        Cursor::new(input.as_bytes()),
        Vec::new(),
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("initial governed claim seals its prefix");

    let checkpoint_event_id = store
        .events_for_run(&run_id.to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "tape_checkpoint")
        .last()
        .expect("initial claim created a current checkpoint")
        .id;
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER event_signatures_no_update")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE event_signatures SET signature = ?1 WHERE event_id = ?2",
            rusqlite::params!["malformed-checkpoint-signature", checkpoint_event_id],
        )
        .unwrap();

    let retry = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-retry",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let retry_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        retry
    );
    let mut stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(retry_input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("a corrupt current checkpoint must not be accepted as an idempotent seal");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    let output = String::from_utf8(stderr).unwrap();
    assert!(output.contains("handshake_ack"));
    assert!(
        !output.contains("claim_activity_v1_result"),
        "a corrupt checkpoint must not permit a success response"
    );
    assert_eq!(store.event_count().unwrap(), 5);
}

#[test]
fn governed_corrupt_checkpoint_blocks_a_fresh_claim_before_authority_expands() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let fresh_action_request_event_id = append_sibling_governed_action_request(
        &store,
        &signing_key,
        &signer,
        run_id,
        dispatch_event_id,
        action_request_event_id,
        "action-2",
        "action:workflow-1:unit-1:2",
    );
    let (signing, config) = governed_protocol_for(run_id, signing_key, signer, trusted);

    let initial_claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let initial_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        initial_claim
    );
    serve_governed_with_protocol(
        Cursor::new(initial_input.as_bytes()),
        Vec::new(),
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("initial governed claim seals the prior and current prefixes");

    let checkpoint_event_id = store
        .events_for_run(&run_id.to_string())
        .unwrap()
        .into_iter()
        .find(|row| row.kind == "tape_checkpoint")
        .expect("initial governed claim created a checkpoint")
        .id;
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER event_signatures_no_update")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE event_signatures SET signature = ?1 WHERE event_id = ?2",
            rusqlite::params!["tampered-prior-checkpoint", checkpoint_event_id],
        )
        .unwrap();

    let event_count_before = store.event_count().unwrap();
    let authority_events_before = store
        .events_for_run(&run_id.to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "activity_claimed_v1")
        .count();
    let fresh_claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-2",
        "run_id": run_id,
        "activity_id": "action-2",
        "idempotency_key": "action:workflow-1:unit-1:2",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": fresh_action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let fresh_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        fresh_claim
    );
    let mut stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(fresh_input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("a corrupted prior checkpoint must block a fresh claim before append");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    let output = String::from_utf8(stderr).unwrap();
    assert!(output.contains("handshake_ack"));
    assert!(
        !output.contains("claim_activity_v1_result"),
        "a failed preflight must not report a claim disposition"
    );
    assert_eq!(
        store.event_count().unwrap(),
        event_count_before,
        "a corrupt prior checkpoint must prevent a fresh authority record"
    );
    assert_eq!(
        store
            .events_for_run(&run_id.to_string())
            .unwrap()
            .into_iter()
            .filter(|row| row.kind == "activity_claimed_v1")
            .count(),
        authority_events_before,
        "no fresh activity claim may be committed after preflight failure"
    );
}

#[test]
fn governed_idempotent_retry_rejects_a_tampered_earlier_checkpoint_in_the_chain() {
    let temp = tempfile::TempDir::new().unwrap();
    let store = SqliteStore::open(temp.path().join("events.db")).unwrap();
    let cas = Cas::open(temp.path().join("objects")).unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let (signing, config) = governed_protocol_for(run_id, signing_key, signer, trusted);
    let claim = serde_json::json!({
        "control": "claim_activity_v1",
        "request_id": "claim-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "dispatch_event_id": dispatch_event_id,
        "action_request_event_id": action_request_event_id,
        "lease_duration_ms": 60_000,
    });
    let claim_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        claim
    );
    let mut claim_stderr = Vec::new();
    serve_governed_with_protocol(
        Cursor::new(claim_input.as_bytes()),
        &mut claim_stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("initial governed claim seals its prefix");
    let lease_id = control_response(claim_stderr, "claim_activity_v1_result")["lease_id"]
        .as_str()
        .expect("claim grants a lease")
        .to_owned();

    let heartbeat = serde_json::json!({
        "control": "heartbeat_activity_v1",
        "request_id": "heartbeat-1",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "lease_id": lease_id.clone(),
        "heartbeat_id": "heartbeat-1",
    });
    let heartbeat_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        heartbeat
    );
    serve_governed_with_protocol(
        Cursor::new(heartbeat_input.as_bytes()),
        Vec::new(),
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect("heartbeat creates a later valid checkpoint");

    let checkpoint_event_ids = store
        .events_for_run(&run_id.to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "tape_checkpoint")
        .map(|row| row.id)
        .collect::<Vec<_>>();
    assert_eq!(
        checkpoint_event_ids.len(),
        3,
        "claim preflight/post seals plus heartbeat post seal create a complete chain"
    );
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER event_signatures_no_update")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE event_signatures SET signature = ?1 WHERE event_id = ?2",
            rusqlite::params!["tampered-earlier-checkpoint", checkpoint_event_ids[0]],
        )
        .unwrap();

    let retry = serde_json::json!({
        "control": "heartbeat_activity_v1",
        "request_id": "heartbeat-retry",
        "run_id": run_id,
        "activity_id": "action-1",
        "idempotency_key": "action:workflow-1:unit-1:1",
        "lease_id": lease_id,
        "heartbeat_id": "heartbeat-1",
    });
    let retry_input = format!(
        "{}\n{}\n{{\"control\":\"close\",\"seq\":0}}\n",
        governed_handshake(run_id),
        retry
    );
    let mut stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(retry_input.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("a corrupt earlier checkpoint must block governed idempotent success");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    let output = String::from_utf8(stderr).unwrap();
    assert!(output.contains("handshake_ack"));
    assert!(
        !output.contains("heartbeat_activity_v1_result"),
        "a corrupt earlier checkpoint must not permit an existing heartbeat success response"
    );
    assert_eq!(store.event_count().unwrap(), 7);
}

#[test]
fn projection_tampering_is_not_a_source_of_activity_authority() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        dispatch_event_id,
        action_request_event_id,
        lease_duration_ms: 60_000,
    };
    store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap();

    // The raw connection is a test-only corruption hook. Removing the normal
    // projection trigger simulates a damaged DB after a crash; the replay path
    // must re-derive authority from the signed tape instead of returning
    // Pending from a substituted cache row.
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER activity_claims_terminal_only")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE activity_claims SET action_request_digest = ?1 WHERE run_id = ?2 AND idempotency_key = ?3",
            rusqlite::params![
                DIGEST_B,
                run_id.to_string(),
                "action:workflow-1:unit-1:1",
            ],
        )
        .unwrap();
    let error = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .expect_err("a cache row that disagrees with its signed tape event must fail closed");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));

    // An intact grant is also insufficient to replay a forged terminal
    // outcome. Recreate the isolated store, record a real result, then alter
    // only its projection digest to model a crash/corruption edge case.
    let store = SqliteStore::open_in_memory().unwrap();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        dispatch_event_id,
        action_request_event_id,
        lease_duration_ms: 60_000,
    };
    let lease_id = match store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected first claim to grant, got {other:?}"),
    };
    let result = ActivityResultRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:evidence:1".into(),
    };
    store
        .record_activity_result_v1(&result, &authority, &signing_key, &signer)
        .unwrap();
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER activity_claims_terminal_only")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE activity_claims SET result_event_digest = ?1 WHERE run_id = ?2 AND idempotency_key = ?3",
            rusqlite::params![
                DIGEST_A,
                run_id.to_string(),
                "action:workflow-1:unit-1:1",
            ],
        )
        .unwrap();
    let error = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .expect_err("a forged terminal cache row must not be replayed as a completed effect");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
}

#[test]
fn recorded_result_is_replayed_without_a_second_effect_claim() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        dispatch_event_id,
        action_request_event_id,
        lease_duration_ms: 60_000,
    };
    let lease_id = match store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected first claim to grant, got {other:?}"),
    };
    let result = ActivityResultRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:evidence:1".into(),
    };
    let recorded = store
        .record_activity_result_v1(&result, &authority, &signing_key, &signer)
        .unwrap();
    assert!(matches!(
        recorded,
        ActivityResultDispositionV1::Recorded { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 4);

    let replay = store
        .claim_activity_v1(&claim, &authority, &signing_key, &signer)
        .unwrap();
    assert!(matches!(
        replay,
        ActivityClaimDispositionV1::Recorded { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        4,
        "replay must reuse the terminal result and never mint a second effect claim"
    );
}

#[test]
fn expired_claim_requires_unknown_reconciliation_instead_of_regranting() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        dispatch_event_id,
        action_request_event_id,
        lease_duration_ms: 1_000,
    };
    let now = Utc::now();
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, now)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected first claim to grant, got {other:?}"),
    };
    let after_expiry = now + Duration::seconds(2);
    let duplicate = store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, after_expiry)
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityClaimDispositionV1::LeaseExpired { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 3);

    let late_success = ActivityResultRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        lease_id: lease_id.clone(),
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:late-result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:late-evidence:1".into(),
    };
    let late = store
        .record_activity_result_v1_at_for_tests(
            &late_success,
            &authority,
            &signing_key,
            &signer,
            after_expiry,
        )
        .unwrap();
    assert!(matches!(
        late,
        ActivityResultDispositionV1::LeaseExpired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "a late success must not append an ambiguous effect outcome"
    );

    let reconciliation = ActivityResultRequestV1 {
        run_id,
        activity_id: "action-1".into(),
        idempotency_key: "action:workflow-1:unit-1:1".into(),
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown,
        result_digest: None,
        result_ref: None,
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:reconcile:1".into(),
    };
    let recorded = store
        .record_activity_result_v1_at_for_tests(
            &reconciliation,
            &authority,
            &signing_key,
            &signer,
            after_expiry,
        )
        .unwrap();
    assert!(matches!(
        recorded,
        ActivityResultDispositionV1::Recorded { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 4);
}

#[test]
fn granted_claim_remains_pending_without_a_second_lease_after_reopen() {
    let temp = tempfile::TempDir::new().unwrap();
    let ledger_path = temp.path().join("events.db");
    let (signing_key, signer, trusted) = signer();
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:02Z".parse().unwrap();

    let (run_id, dispatch_event_id, action_request_event_id, claim) = {
        let store = SqliteStore::open(&ledger_path).unwrap();
        let (run_id, dispatch_event_id, action_request_event_id) =
            append_governed_dispatch_and_request(&store, &signing_key, &signer);
        let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
        let granted = store
            .claim_activity_v1_at_for_tests(
                &claim,
                &authority,
                &signing_key,
                &signer,
                claimed_at.clone(),
            )
            .unwrap();
        assert!(matches!(
            granted,
            ActivityClaimDispositionV1::Granted { .. }
        ));
        assert_eq!(store.event_count().unwrap(), 3);
        (run_id, dispatch_event_id, action_request_event_id, claim)
    };

    let reopened = SqliteStore::open(&ledger_path).unwrap();
    let duplicate = reopened
        .claim_activity_v1_at_for_tests(
            &claim,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(1),
        )
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityClaimDispositionV1::Pending { .. }
    ));
    assert_eq!(
        reopened.event_count().unwrap(),
        3,
        "a reopened granted projection must retain its original lease rather than mint another"
    );
    assert_eq!(claim.run_id, run_id);
    assert_eq!(claim.dispatch_event_id, dispatch_event_id);
    assert_eq!(claim.action_request_event_id, action_request_event_id);
}

#[test]
fn recorded_result_survives_reopen_and_rejects_a_conflicting_terminal_retry() {
    let temp = tempfile::TempDir::new().unwrap();
    let ledger_path = temp.path().join("events.db");
    let (signing_key, signer, trusted) = signer();
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:02Z".parse().unwrap();

    let (claim, result) = {
        let store = SqliteStore::open(&ledger_path).unwrap();
        let (run_id, dispatch_event_id, action_request_event_id) =
            append_governed_dispatch_and_request(&store, &signing_key, &signer);
        let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
        let lease_id = match store
            .claim_activity_v1_at_for_tests(
                &claim,
                &authority,
                &signing_key,
                &signer,
                claimed_at.clone(),
            )
            .unwrap()
        {
            ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
            other => panic!("expected a new grant before restart, got {other:?}"),
        };
        let result = ActivityResultRequestV1 {
            run_id,
            activity_id: "action-1".into(),
            idempotency_key: "action:workflow-1:unit-1:1".into(),
            lease_id,
            outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
            result_digest: Some(DIGEST_A.into()),
            result_ref: Some("cas:result:1".into()),
            evidence_digest: DIGEST_B.into(),
            evidence_ref: "cas:evidence:1".into(),
        };
        assert!(matches!(
            store
                .record_activity_result_v1_at_for_tests(
                    &result,
                    &authority,
                    &signing_key,
                    &signer,
                    claimed_at.clone() + Duration::seconds(1),
                )
                .unwrap(),
            ActivityResultDispositionV1::Recorded { .. }
        ));
        assert_eq!(store.event_count().unwrap(), 4);
        (claim, result)
    };

    let reopened = SqliteStore::open(&ledger_path).unwrap();
    assert!(matches!(
        reopened
            .claim_activity_v1_at_for_tests(
                &claim,
                &authority,
                &signing_key,
                &signer,
                claimed_at.clone() + Duration::seconds(2),
            )
            .unwrap(),
        ActivityClaimDispositionV1::Recorded { .. }
    ));
    assert!(matches!(
        reopened
            .record_activity_result_v1_at_for_tests(
                &result,
                &authority,
                &signing_key,
                &signer,
                claimed_at.clone() + Duration::seconds(2),
            )
            .unwrap(),
        ActivityResultDispositionV1::Recorded { .. }
    ));

    let conflicting_result = ActivityResultRequestV1 {
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Failed,
        result_digest: Some(DIGEST_B.into()),
        result_ref: Some("cas:conflicting-result:1".into()),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: "cas:conflicting-evidence:1".into(),
        ..result
    };
    let error = reopened
        .record_activity_result_v1_at_for_tests(
            &conflicting_result,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(2),
        )
        .expect_err("a terminal effect must not be replaced after a restart");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimIdempotencyConflict { .. }
    ));
    assert_eq!(
        reopened.event_count().unwrap(),
        4,
        "reopened terminal projections must never append a second result"
    );
}

#[test]
fn expired_lease_remains_non_reclaimable_after_reopen() {
    let temp = tempfile::TempDir::new().unwrap();
    let ledger_path = temp.path().join("events.db");
    let (signing_key, signer, trusted) = signer();
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:02Z".parse().unwrap();

    let (claim, late_success) = {
        let store = SqliteStore::open(&ledger_path).unwrap();
        let (run_id, dispatch_event_id, action_request_event_id) =
            append_governed_dispatch_and_request(&store, &signing_key, &signer);
        let claim = ActivityClaimRequestV1 {
            lease_duration_ms: 1_000,
            ..claim_request(run_id, dispatch_event_id, action_request_event_id)
        };
        let lease_id = match store
            .claim_activity_v1_at_for_tests(
                &claim,
                &authority,
                &signing_key,
                &signer,
                claimed_at.clone(),
            )
            .unwrap()
        {
            ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
            other => panic!("expected a new grant before restart, got {other:?}"),
        };
        let late_success = ActivityResultRequestV1 {
            run_id,
            activity_id: "action-1".into(),
            idempotency_key: "action:workflow-1:unit-1:1".into(),
            lease_id,
            outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
            result_digest: Some(DIGEST_A.into()),
            result_ref: Some("cas:late-result:1".into()),
            evidence_digest: DIGEST_B.into(),
            evidence_ref: "cas:late-evidence:1".into(),
        };
        assert_eq!(store.event_count().unwrap(), 3);
        (claim, late_success)
    };

    let reopened = SqliteStore::open(&ledger_path).unwrap();
    let after_expiry = claimed_at + Duration::seconds(2);
    assert!(matches!(
        reopened
            .claim_activity_v1_at_for_tests(
                &claim,
                &authority,
                &signing_key,
                &signer,
                after_expiry.clone(),
            )
            .unwrap(),
        ActivityClaimDispositionV1::LeaseExpired { .. }
    ));
    assert!(matches!(
        reopened
            .record_activity_result_v1_at_for_tests(
                &late_success,
                &authority,
                &signing_key,
                &signer,
                after_expiry,
            )
            .unwrap(),
        ActivityResultDispositionV1::LeaseExpired { .. }
    ));
    assert_eq!(
        reopened.event_count().unwrap(),
        3,
        "an expired lease must remain blocked after restart until explicit reconciliation"
    );
}

#[test]
fn activity_heartbeat_extends_the_original_lease_once_and_replays_an_exact_duplicate() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let heartbeat = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        lease_id,
        heartbeat_id: "heartbeat-1".into(),
    };
    let heartbeat_at = claimed_at + Duration::seconds(30);

    let first = store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            heartbeat_at,
        )
        .unwrap();
    assert!(matches!(
        first,
        ActivityHeartbeatDispositionV1::Recorded {
            lease_expires_at,
            ..
        } if lease_expires_at == "2026-07-18T00:01:31.000Z"
    ));
    assert_eq!(store.event_count().unwrap(), 4);

    let duplicate = store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            heartbeat_at + Duration::seconds(1),
        )
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityHeartbeatDispositionV1::Existing {
            lease_expires_at,
            ..
        } if lease_expires_at == "2026-07-18T00:01:31.000Z"
    ));
    assert_eq!(
        store.event_count().unwrap(),
        4,
        "an exact heartbeat duplicate must reuse the signed event rather than extend authority again"
    );
}

#[test]
fn exact_heartbeat_retry_after_expiry_replays_without_mutating_the_tape() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let heartbeat = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id,
        idempotency_key: claim.idempotency_key,
        lease_id,
        heartbeat_id: "heartbeat-retry-after-expiry".into(),
    };
    let heartbeat_at = claimed_at + Duration::seconds(30);
    store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            heartbeat_at,
        )
        .unwrap();
    assert_eq!(store.event_count().unwrap(), 4);

    let duplicate = store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(91),
        )
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityHeartbeatDispositionV1::Existing {
            lease_expires_at,
            ..
        } if lease_expires_at == "2026-07-18T00:01:31.000Z"
    ));
    assert_eq!(
        store.event_count().unwrap(),
        4,
        "a lost heartbeat response must remain replayable after the effective lease expires"
    );
}

#[test]
fn exact_heartbeat_retry_after_terminal_result_replays_without_mutating_the_tape() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let heartbeat = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        lease_id: lease_id.clone(),
        heartbeat_id: "heartbeat-retry-after-terminal-result".into(),
    };
    store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(30),
        )
        .unwrap();
    let result = ActivityResultRequestV1 {
        run_id,
        activity_id: claim.activity_id,
        idempotency_key: claim.idempotency_key,
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:terminal-heartbeat-result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:terminal-heartbeat-evidence:1".into(),
    };
    store
        .record_activity_result_v1_at_for_tests(
            &result,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(70),
        )
        .unwrap();
    assert_eq!(store.event_count().unwrap(), 5);

    let duplicate = store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(71),
        )
        .unwrap();
    assert!(matches!(
        duplicate,
        ActivityHeartbeatDispositionV1::Existing {
            lease_expires_at,
            ..
        } if lease_expires_at == "2026-07-18T00:01:31.000Z"
    ));
    assert_eq!(
        store.event_count().unwrap(),
        5,
        "a terminal result must not prevent replaying the already-recorded heartbeat response"
    );
}

#[test]
fn heartbeat_cache_identity_and_request_digest_remapping_fail_closed() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let original = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        lease_id: lease_id.clone(),
        heartbeat_id: "heartbeat-original".into(),
    };
    store
        .heartbeat_activity_v1_at_for_tests(
            &original,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(30),
        )
        .unwrap();
    let remapped = ActivityHeartbeatRequestV1 {
        heartbeat_id: "heartbeat-remapped".into(),
        ..original.clone()
    };

    // Simulate a post-crash cache corruption that rewrites both columns used
    // by the existing-id lookup. The old signed event still names
    // `heartbeat-original`, so this must be rejected rather than treated as a
    // response for `heartbeat-remapped`.
    store
        .conn_for_tests()
        .execute_batch("DROP TRIGGER activity_claim_heartbeats_no_update")
        .unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE activity_claim_heartbeats \
             SET heartbeat_id = ?1, request_digest = ?2 \
             WHERE run_id = ?3 AND heartbeat_id = ?4",
            rusqlite::params![
                &remapped.heartbeat_id,
                heartbeat_request_digest(&remapped),
                run_id.to_string(),
                &original.heartbeat_id,
            ],
        )
        .unwrap();

    let error = store
        .heartbeat_activity_v1_at_for_tests(
            &remapped,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(31),
        )
        .expect_err("a cache row remapped to a different heartbeat request must fail closed");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        4,
        "cache corruption must neither replay a false result nor append another heartbeat"
    );
}

#[test]
fn terminal_result_uses_the_verified_heartbeat_expiry_not_the_original_claim_expiry() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let heartbeat = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        lease_id: lease_id.clone(),
        heartbeat_id: "heartbeat-result-window".into(),
    };
    store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(30),
        )
        .unwrap();

    let result = ActivityResultRequestV1 {
        run_id,
        activity_id: claim.activity_id,
        idempotency_key: claim.idempotency_key,
        lease_id,
        outcome: bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:heartbeat-result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:heartbeat-evidence:1".into(),
    };
    let recorded = store
        .record_activity_result_v1_at_for_tests(
            &result,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(70),
        )
        .unwrap();
    assert!(matches!(
        recorded,
        ActivityResultDispositionV1::Recorded { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        5,
        "a result inside the signed heartbeat extension must be recorded once"
    );
}

#[test]
fn heartbeat_after_lease_expiry_blocks_without_appending_a_second_authority_event() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer, trusted) = signer();
    let (run_id, dispatch_event_id, action_request_event_id) =
        append_governed_dispatch_and_request(&store, &signing_key, &signer);
    let trusted_actor = trusted_actor(&signing_key);
    let authority = ActivityClaimAuthorityV1::new(
        trusted,
        trusted_actor.clone(),
        trusted_actor.clone(),
        trusted_actor,
    )
    .unwrap();
    let claimed_at: chrono::DateTime<Utc> = "2026-07-18T00:00:01Z".parse().unwrap();
    let claim = claim_request(run_id, dispatch_event_id, action_request_event_id);
    let lease_id = match store
        .claim_activity_v1_at_for_tests(&claim, &authority, &signing_key, &signer, claimed_at)
        .unwrap()
    {
        ActivityClaimDispositionV1::Granted { lease_id, .. } => lease_id,
        other => panic!("expected a granted claim, got {other:?}"),
    };
    let heartbeat = ActivityHeartbeatRequestV1 {
        run_id,
        activity_id: claim.activity_id,
        idempotency_key: claim.idempotency_key,
        lease_id,
        heartbeat_id: "heartbeat-after-expiry".into(),
    };

    let outcome = store
        .heartbeat_activity_v1_at_for_tests(
            &heartbeat,
            &authority,
            &signing_key,
            &signer,
            claimed_at + Duration::seconds(61),
        )
        .unwrap();
    assert!(matches!(
        outcome,
        ActivityHeartbeatDispositionV1::LeaseExpired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "a heartbeat after expiry must not create an ambiguous authority event"
    );
}
