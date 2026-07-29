use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, dispatch_envelope_v3_body_digest,
    governed_dispatch_policy_digest_v1, ActionEvidenceVersionV1, ActionFailureV1, ActionKindV1,
    ActionReceiptOutcomeV2, ActionReceiptRecordedV2, ActionRequestedV2, ActionResourceUsageV1,
    AttemptContextRecordedV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, ExecutionRoleV1, TrustTierV1, WorkflowTerminalOutcomeV1,
    WorkflowTerminalV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
pub const RETRY_ACTION_NAMESPACE: &str = "retry-action:workflow-1:implement-unit-1:2";

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn dispatch(now: DateTime<Utc>) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "implement-unit-1".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:implement-unit-1:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        DIGEST_A,
        Some(DIGEST_C),
    )
    .expect("hash governed dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_A.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn retry_dispatch(now: DateTime<Utc>) -> DispatchEnvelopeV3 {
    let mut retry = dispatch(now);
    retry.body.attempt = 2;
    retry.body.provenance_ref = "admission:retry-2".into();
    retry.body.idempotency_key = "dispatch:workflow-1:implement-unit-1:2".into();
    retry.body.issued_at = timestamp(now);
    retry.body.expires_at = timestamp(now + Duration::minutes(10));
    retry.envelope_digest = dispatch_envelope_v3_body_digest(
        &retry.body,
        retry.action_evidence_version,
        &retry.repository_binding_digest,
        &retry.ledger_authority_realm_digest,
        retry.governed_packet_digest.as_deref(),
    )
    .expect("hash retry dispatch");
    retry
}

fn event(
    run_id: RunId,
    parent_event_id: Option<EventId>,
    kind: EventKind,
    occurred_at: DateTime<Utc>,
    payload: Payload,
) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at,
        payload,
    }
}

fn prior_action_request(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    requested_at: DateTime<Utc>,
) -> ActionRequestedV2 {
    ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: "prior-attempt-effect".into(),
        idempotency_key: "prior-attempt-effect:1".into(),
        action_kind: ActionKindV1::Git,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input:prior-attempt-effect".into(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("derive governed policy"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: timestamp(requested_at),
    }
}

/// Append the minimum complete signed predecessor proof accepted by the
/// governed sealed-V3 retry identity resolver.
pub fn append_valid_retry_identity_evidence(
    store: &SqliteStore,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    run_id: RunId,
    now: DateTime<Utc>,
) -> EventId {
    let prior_dispatch = dispatch(now);
    let prior_dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(prior_dispatch.clone()),
    );
    store
        .append_signed(&prior_dispatch_event, signing_key, signer)
        .expect("append prior dispatch");

    let prior_request = prior_action_request(run_id, &prior_dispatch, now + Duration::seconds(1));
    let prior_request_event = event(
        run_id,
        Some(prior_dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(1),
        Payload::ActionRequestedV2(prior_request.clone()),
    );
    store
        .append_signed(&prior_request_event, signing_key, signer)
        .expect("append prior request");

    let prior_claim = ActivityClaimedV1 {
        run_id,
        activity_id: prior_request.action_id.clone(),
        idempotency_key: prior_request.idempotency_key.clone(),
        action_kind: prior_request.action_kind,
        action_request_event_id: prior_request_event.id,
        action_request_digest: action_requested_v2_digest(&prior_request)
            .expect("hash prior request"),
        dispatch_event_id: prior_dispatch_event.id,
        dispatch_envelope_digest: prior_dispatch.envelope_digest.clone(),
        authority_actor: signer.actor_id.clone(),
        purpose: ActivityClaimPurposeV1::Generic,
        lease_id: "lease:prior-attempt-effect".into(),
        lease_expires_at: timestamp(now + Duration::seconds(32)),
        claimed_at: timestamp(now + Duration::seconds(2)),
    };
    let prior_claim_event = event(
        run_id,
        Some(prior_request_event.id),
        EventKind::ActivityClaimedV1,
        now + Duration::seconds(2),
        Payload::ActivityClaimedV1(prior_claim.clone()),
    );
    store
        .append_signed(&prior_claim_event, signing_key, signer)
        .expect("append prior claim");

    let prior_result = ActivityResultRecordedV1 {
        run_id,
        activity_id: prior_claim.activity_id.clone(),
        idempotency_key: prior_claim.idempotency_key.clone(),
        claim_event_id: prior_claim_event.id,
        claim_event_digest: canonical_event_hash(&prior_claim_event).expect("hash prior claim"),
        lease_id: prior_claim.lease_id.clone(),
        outcome: ActivityResultOutcomeV1::Failed,
        result_digest: None,
        result_ref: None,
        evidence_digest: DIGEST_C.into(),
        evidence_ref: "cas:evidence:prior-attempt-effect".into(),
        recorded_at: timestamp(now + Duration::seconds(3)),
    };
    let prior_result_event = event(
        run_id,
        Some(prior_claim_event.id),
        EventKind::ActivityResultRecordedV1,
        now + Duration::seconds(3),
        Payload::ActivityResultRecordedV1(prior_result),
    );
    store
        .append_signed(&prior_result_event, signing_key, signer)
        .expect("append prior result");

    let prior_receipt = ActionReceiptRecordedV2 {
        run_id: run_id.to_string(),
        workflow_id: prior_request.workflow_id.clone(),
        unit_id: prior_request.unit_id.clone(),
        attempt: prior_request.attempt,
        provenance_ref: prior_request.provenance_ref.clone(),
        action_id: prior_request.action_id.clone(),
        idempotency_key: prior_request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(&prior_request)
            .expect("hash prior request"),
        dispatch_envelope_digest: prior_dispatch.envelope_digest.clone(),
        capability_bundle_digest: prior_request.capability_bundle_digest.clone(),
        policy_digest: prior_request.policy_digest.clone(),
        context_manifest_digest: prior_request.context_manifest_digest.clone(),
        worker_manifest_digest: prior_request.worker_manifest_digest.clone(),
        sandbox_profile_digest: prior_request.sandbox_profile_digest.clone(),
        authority_actor: signer.actor_id.clone(),
        execution_role: prior_dispatch.body.execution_role,
        outcome: ActionReceiptOutcomeV2::Failed,
        result_digest: None,
        result_ref: None,
        evidence_digest: DIGEST_C.into(),
        evidence_ref: "cas:evidence:prior-attempt-effect".into(),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            input_tokens: None,
            output_tokens: None,
        },
        redactions: Vec::new(),
        failure: Some(ActionFailureV1 {
            code: "effect_failed".into(),
            message_digest: DIGEST_D.into(),
            retryable: true,
        }),
        authorization_ref: None,
        action_receipt_ref: "receipt:prior-attempt-effect".into(),
        completed_at: timestamp(now + Duration::seconds(3)),
    };
    let prior_receipt_event = event(
        run_id,
        Some(prior_result_event.id),
        EventKind::ActionReceiptRecordedV2,
        now + Duration::seconds(3),
        Payload::ActionReceiptRecordedV2(prior_receipt.clone()),
    );
    store
        .append_signed(&prior_receipt_event, signing_key, signer)
        .expect("append prior receipt");

    let prior_terminal = WorkflowTerminalV1 {
        workflow_id: prior_dispatch.body.workflow_id.clone(),
        workflow_revision: prior_dispatch.body.workflow_revision.clone(),
        unit_id: prior_dispatch.body.unit_id.clone(),
        attempt: prior_dispatch.body.attempt,
        outcome: WorkflowTerminalOutcomeV1::Failed,
        candidate_digest: None,
        promotion_result_ref: None,
        reconciliation_resolution_ref: None,
        reason: Some("prior action failed".into()),
        idempotency_key: "terminal:workflow-1:implement-unit-1:1".into(),
        completed_at: timestamp(now + Duration::seconds(4)),
    };
    let prior_terminal_event = event(
        run_id,
        Some(prior_receipt_event.id),
        EventKind::WorkflowTerminal,
        now + Duration::seconds(4),
        Payload::WorkflowTerminalV1(prior_terminal),
    );
    store
        .append_signed(&prior_terminal_event, signing_key, signer)
        .expect("append prior terminal");

    let retry = retry_dispatch(now + Duration::seconds(6));
    let mut context = AttemptContextRecordedV1 {
        run_id: run_id.to_string(),
        workflow_id: prior_dispatch.body.workflow_id.clone(),
        workflow_revision: prior_dispatch.body.workflow_revision.clone(),
        unit_id: prior_dispatch.body.unit_id.clone(),
        prior_attempt: prior_dispatch.body.attempt,
        next_attempt: retry.body.attempt,
        prior_dispatch_envelope_digest: prior_dispatch.envelope_digest.clone(),
        prior_terminal_event_ref: prior_terminal_event.id.to_string(),
        prior_terminal_event_digest: canonical_event_hash(&prior_terminal_event)
            .expect("hash prior terminal"),
        prior_action_receipt_ref: prior_receipt.action_receipt_ref.clone(),
        prior_action_receipt_digest: action_receipt_recorded_v2_digest(&prior_receipt)
            .expect("hash prior receipt"),
        feedback_ref: "cas:retry-feedback:workflow-1:implement-unit-1:2".into(),
        feedback_digest: DIGEST_D.into(),
        next_dispatch_envelope_digest: retry.envelope_digest.clone(),
        next_dispatch_idempotency_key: retry.body.idempotency_key.clone(),
        retry_action_namespace: RETRY_ACTION_NAMESPACE.into(),
        idempotency_key: "retry-context:workflow-1:implement-unit-1:1:2".into(),
        recorded_at: timestamp(now + Duration::seconds(5)),
        attempt_context_digest: String::new(),
    };
    context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context).expect("hash retry context");
    let context_event = event(
        run_id,
        Some(prior_terminal_event.id),
        EventKind::AttemptContextRecordedV1,
        now + Duration::seconds(5),
        Payload::AttemptContextRecordedV1(context),
    );
    store
        .append_signed(&context_event, signing_key, signer)
        .expect("append retry context");

    let retry_event = event(
        run_id,
        Some(context_event.id),
        EventKind::DispatchEnvelopeV3,
        now + Duration::seconds(6),
        Payload::DispatchEnvelopeV3(retry),
    );
    store
        .append_signed(&retry_event, signing_key, signer)
        .expect("append retry dispatch");
    retry_event.id
}
