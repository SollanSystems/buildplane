use crate::provider_request::build_provider_request_v1;
use crate::PrivateModelCapability;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, derive_model_action_scope_constraints_v1,
    model_request_evidence_document_v1_bytes, model_request_evidence_v1_descriptor,
    parse_verified_canonical_model_action_input_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_provider_token_preflight_input_v1,
    parse_verified_provider_token_preflight_result_v1,
    parse_verified_trust_scope_evidence_document_v1, provider_token_preflight_input_v1_bytes,
    provider_token_preflight_result_v1_bytes, trust_scope_evidence_document_v1_bytes,
    trust_scope_evidence_v1_descriptor, CanonicalModelActionInputV1,
    CredentialFreeNormalizedModelRequestV1, ModelActionEvidenceBindingV1, ModelProviderV1,
    ModelRequestEvidenceDocumentV1, ProviderTokenPreflightInputV1, ProviderTokenPreflightResultV1,
    TrustScopeEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, ActionKindV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::storage::cas::Cas;
use bp_provider_sdk::{provider_response_contract_v1, ProviderExecutionRoleV1};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[test]
fn provider_request_is_reconstructed_only_from_exact_verified_evidence() {
    let temp = tempfile::tempdir().expect("CAS");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let run_id = RunId::new();
    let dispatch_event_id = EventId::new();
    let action_request_event_id = EventId::new();
    let response = provider_response_contract_v1(ProviderExecutionRoleV1::Implementer)
        .expect("response contract");
    let canonical_input = CanonicalModelActionInputV1::new(
        CredentialFreeNormalizedModelRequestV1 {
            provider: ModelProviderV1::Anthropic,
            model: "claude-sonnet-4-6".into(),
            system_prompt: Some("Implement only the admitted packet.".into()),
            prompt: "Return the closed implementation completion.".into(),
            response_schema_digest: response.contract_digest.clone(),
        },
        vec![],
        vec![],
    )
    .expect("canonical input");
    let input_bytes = canonical_model_action_input_v1_bytes(&canonical_input).expect("input bytes");
    let input_ref = cas.put_canonical_bytes(&input_bytes).expect("input CAS");
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    )
    .expect("verified input");
    let binding = ModelActionEvidenceBindingV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        dispatch_event_ref: dispatch_event_id,
        dispatch_envelope_digest: DIGEST_A.into(),
        action_request_event_ref: action_request_event_id,
        action_request_digest: DIGEST_B.into(),
        action_id: "workflow-1:unit-1:attempt-1:model".into(),
        idempotency_key: "workflow-1:unit-1:attempt-1:model".into(),
        action_kind: ActionKindV1::Model,
        canonical_input_ref: input_ref.to_cas_ref(),
        canonical_input_digest: input_ref.digest().into(),
        repository_binding_digest: DIGEST_B.into(),
        ledger_authority_realm_digest: DIGEST_C.into(),
        governed_packet_digest: DIGEST_A.into(),
        capability_bundle_digest: DIGEST_B.into(),
        policy_digest: DIGEST_C.into(),
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_C.into(),
        execution_role: ExecutionRoleV1::Implementer,
    };
    let model_document = ModelRequestEvidenceDocumentV1::from_verified_canonical_input(
        binding.clone(),
        &verified_input,
    )
    .expect("model evidence");
    let model_bytes =
        model_request_evidence_document_v1_bytes(&model_document).expect("model bytes");
    let model_ref = cas.put_canonical_bytes(&model_bytes).expect("model CAS");
    let verified_model = parse_verified_model_request_evidence_document_v1(
        &model_bytes,
        &model_request_evidence_v1_descriptor(&model_ref),
    )
    .expect("verified model");
    let scope_document = TrustScopeEvidenceDocumentV1::from_verified_model_request_evidence(
        &verified_model,
        DIGEST_A.into(),
        derive_model_action_scope_constraints_v1(ExecutionRoleV1::Implementer, &[])
            .expect("constraints"),
    )
    .expect("scope");
    let scope_bytes = trust_scope_evidence_document_v1_bytes(&scope_document).expect("scope bytes");
    let scope_ref = cas.put_canonical_bytes(&scope_bytes).expect("scope CAS");
    let verified_scope = parse_verified_trust_scope_evidence_document_v1(
        &scope_bytes,
        &trust_scope_evidence_v1_descriptor(&scope_ref),
    )
    .expect("verified scope");
    let preflight =
        ProviderTokenPreflightInputV1::from_verified_model_request(&verified_model, 14_000)
            .expect("preflight");
    let preflight_bytes =
        provider_token_preflight_input_v1_bytes(&preflight).expect("preflight bytes");
    let preflight_ref = cas
        .put_canonical_bytes(&preflight_bytes)
        .expect("preflight CAS");
    let verified_preflight = parse_verified_provider_token_preflight_input_v1(
        &preflight_bytes,
        &preflight_ref.to_cas_ref(),
        preflight_ref.digest(),
        &verified_model,
    )
    .expect("verified preflight");
    let preflight_result =
        ProviderTokenPreflightResultV1::new(&verified_preflight, 321).expect("preflight result");
    let result_bytes =
        provider_token_preflight_result_v1_bytes(&preflight_result).expect("result bytes");
    let result_ref = cas.put_canonical_bytes(&result_bytes).expect("result CAS");
    let verified_result = parse_verified_provider_token_preflight_result_v1(
        &result_bytes,
        &result_ref.to_cas_ref(),
        result_ref.digest(),
        &verified_preflight,
    )
    .expect("verified result");
    let dispatch = DispatchEnvelopeV3 {
        body: DispatchEnvelopeBodyV2 {
            workflow_id: binding.workflow_id.clone(),
            workflow_revision: "revision-1".into(),
            unit_id: binding.unit_id.clone(),
            attempt: binding.attempt,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: binding.provenance_ref.clone(),
            base_commit_sha: "0123456789abcdef0123456789abcdef01234567".into(),
            capability_bundle_digest: binding.capability_bundle_digest.clone(),
            acceptance_contract_digest: DIGEST_A.into(),
            context_manifest_digest: binding.context_manifest_digest.clone(),
            worker_manifest_digest: binding.worker_manifest_digest.clone(),
            sandbox_profile_digest: binding.sandbox_profile_digest.clone(),
            budget: DispatchBudgetV1 {
                max_tokens: Some(14_000),
                max_compute_time_ms: Some(60_000),
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch-1".into(),
            issued_at: "2030-01-01T00:00:00Z".into(),
            expires_at: "2030-01-01T00:02:00Z".into(),
        },
        action_evidence_version: ActionEvidenceVersionV1::SealedV3,
        repository_binding_digest: binding.repository_binding_digest.clone(),
        ledger_authority_realm_digest: binding.ledger_authority_realm_digest.clone(),
        governed_packet_digest: Some(binding.governed_packet_digest.clone()),
        envelope_digest: binding.dispatch_envelope_digest.clone(),
    };
    let capability = PrivateModelCapability {
        run_id,
        dispatch_event_id,
        action_request_event_id,
        execution_role: ExecutionRoleV1::Implementer,
        lease_id: "lease-1".into(),
        authorization_ref: "authorization://1".into(),
    };

    let request = build_provider_request_v1(
        &capability,
        &dispatch,
        &verified_model,
        &verified_scope,
        &verified_preflight,
        &verified_result,
        None,
    )
    .expect("provider request");
    assert_eq!(request.provider, ModelProviderV1::Anthropic);
    assert_eq!(
        request.request.execution_role,
        ProviderExecutionRoleV1::Implementer
    );
    assert_eq!(request.request.max_total_tokens, 14_000);
    assert_eq!(request.request.max_input_tokens, 321);
    assert_eq!(request.request.max_output_tokens, 13_679);
    assert_eq!(
        request.request.response_contract_digest,
        response.contract_digest
    );
    assert!(request.request.candidate_digest.is_none());

    let mut substituted_dispatch = dispatch;
    substituted_dispatch.body.budget.max_tokens = Some(15_000);
    assert!(build_provider_request_v1(
        &capability,
        &substituted_dispatch,
        &verified_model,
        &verified_scope,
        &verified_preflight,
        &verified_result,
        None,
    )
    .is_err());
}
