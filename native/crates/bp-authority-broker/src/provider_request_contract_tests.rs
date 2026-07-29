use crate::anthropic_model_gateway::AnthropicModelGatewayV1;
use crate::provider_preflight::{
    CasProviderTokenPreflightEvidenceWriterV1, PrivateProviderTokenPreflightCapabilityV1,
    ProviderTokenPreflightEvidenceWriterV1,
};
use crate::provider_request::{build_provider_request_v1, build_provider_token_count_request_v1};
use crate::{CredentialGateway, PrivateModelCapability, ProviderExecutionAuthorityV1};
use async_trait::async_trait;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, derive_model_action_scope_constraints_v1,
    model_request_evidence_document_v1_bytes, model_request_evidence_v1_descriptor,
    parse_verified_canonical_model_action_input_v1,
    parse_verified_model_provider_result_document_v1,
    parse_verified_model_provider_unknown_evidence_document_v1,
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
use bp_ledger::storage::sqlite::VerifiedProviderTokenPreflightRecordingV1;
use bp_provider_anthropic::{AnthropicMessageRequestV1, AnthropicProvider, AnthropicTransportV1};
use bp_provider_sdk::{provider_response_contract_v1, ProviderError, ProviderExecutionRoleV1};
use serde_json::{json, Value};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[derive(Clone)]
struct CompletionTransport {
    fail: bool,
}

#[async_trait]
impl AnthropicTransportV1 for CompletionTransport {
    async fn available(&self) -> Result<bool, ProviderError> {
        Ok(true)
    }

    async fn send_message(
        &self,
        request: AnthropicMessageRequestV1,
        _deadline_unix_ms: i64,
    ) -> Result<Value, ProviderError> {
        if self.fail {
            return Err(ProviderError::Transport(
                "sensitive provider failure must not cross the gateway".into(),
            ));
        }
        Ok(json!({
            "id": "msg_test_1",
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "text",
                "text": "{\"schemaVersion\":1,\"outcome\":\"completed\",\"summary\":\"Candidate created.\",\"outputRefs\":[]}"
            }],
            "model": request.model,
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": {
                "input_tokens": 321,
                "output_tokens": 10
            }
        }))
    }
}

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
        provider_authority: ProviderExecutionAuthorityV1::synthetic_for_test(),
    };

    let token_count_request = build_provider_token_count_request_v1(
        &dispatch,
        &verified_model,
        &verified_scope,
        &verified_preflight,
        None,
    )
    .expect("provider token-count request");
    assert_eq!(token_count_request.provider, ModelProviderV1::Anthropic);
    assert_eq!(token_count_request.request.max_total_tokens, 14_000);
    assert_eq!(
        token_count_request.request.request_id,
        "anthropic:workflow-1:unit-1:attempt-1:model:provider-token-preflight"
    );
    assert_eq!(
        token_count_request.request.response_contract_digest,
        response.contract_digest
    );
    let preflight_capability = PrivateProviderTokenPreflightCapabilityV1::new(
        run_id.to_string(),
        "preflight-lease".into(),
        token_count_request.provider,
        token_count_request.request.clone(),
        verified_preflight.clone(),
    );
    let mut preflight_writer = CasProviderTokenPreflightEvidenceWriterV1::new(&cas);
    let persisted_preflight = preflight_writer
        .succeeded(&preflight_capability, 321)
        .expect("persist provider preflight result");
    let persisted_result_ref = persisted_preflight
        .result_ref
        .as_deref()
        .expect("result ref");
    let persisted_result_digest = persisted_preflight
        .result_digest
        .as_deref()
        .expect("result digest");
    let persisted_result_bytes = cas
        .get_verified_canonical_bytes(persisted_result_ref, persisted_result_digest)
        .expect("load provider preflight result");
    parse_verified_provider_token_preflight_result_v1(
        &persisted_result_bytes,
        persisted_result_ref,
        persisted_result_digest,
        &verified_preflight,
    )
    .expect("strict persisted provider preflight result");
    let unknown_preflight = preflight_writer
        .unknown(&preflight_capability)
        .expect("persist unknown preflight evidence");
    assert!(cas
        .get_verified_canonical_bytes(
            &unknown_preflight.evidence_ref,
            &unknown_preflight.evidence_digest,
        )
        .is_ok());

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

    let recording = VerifiedProviderTokenPreflightRecordingV1::from_verified_parts_for_tests(
        verified_preflight.clone(),
        verified_result.clone(),
        dispatch.clone(),
        verified_model.clone(),
        verified_scope.clone(),
        None,
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("provider runtime");
    let completed_capability = PrivateModelCapability {
        run_id,
        dispatch_event_id,
        action_request_event_id,
        execution_role: ExecutionRoleV1::Implementer,
        lease_id: "completion-lease".into(),
        authorization_ref: "authorization://completion".into(),
        provider_authority: ProviderExecutionAuthorityV1::verified(
            DIGEST_C.into(),
            recording.clone(),
        ),
    };
    let mut completed_gateway = AnthropicModelGatewayV1::new(
        AnthropicProvider::new(CompletionTransport { fail: false }),
        &cas,
        &runtime,
    );
    let completed = completed_gateway.invoke(completed_capability);
    assert_eq!(
        completed.completion.outcome,
        bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded
    );
    let completion_ref = completed
        .completion
        .result_ref
        .as_deref()
        .expect("provider result ref");
    let completion_digest = completed
        .completion
        .result_digest
        .as_deref()
        .expect("provider result digest");
    let completion_bytes = cas
        .get_verified_canonical_bytes(completion_ref, completion_digest)
        .expect("load provider result");
    parse_verified_model_provider_result_document_v1(
        &completion_bytes,
        completion_ref,
        completion_digest,
    )
    .expect("strict provider result");

    let unknown_capability = PrivateModelCapability {
        run_id,
        dispatch_event_id,
        action_request_event_id,
        execution_role: ExecutionRoleV1::Implementer,
        lease_id: "unknown-lease".into(),
        authorization_ref: "authorization://unknown".into(),
        provider_authority: ProviderExecutionAuthorityV1::verified(DIGEST_C.into(), recording),
    };
    let mut failing_gateway = AnthropicModelGatewayV1::new(
        AnthropicProvider::new(CompletionTransport { fail: true }),
        &cas,
        &runtime,
    );
    let unknown = failing_gateway.invoke(unknown_capability);
    assert_eq!(
        unknown.completion.outcome,
        bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown
    );
    assert!(unknown.completion.result_ref.is_none());
    assert!(unknown.completion.result_digest.is_none());
    let unknown_bytes = cas
        .get_verified_canonical_bytes(
            &unknown.completion.evidence_ref,
            &unknown.completion.evidence_digest,
        )
        .expect("load canonical unknown evidence");
    let unknown_document = parse_verified_model_provider_unknown_evidence_document_v1(
        &unknown_bytes,
        &unknown.completion.evidence_ref,
        &unknown.completion.evidence_digest,
    )
    .expect("strict unknown evidence");
    assert_eq!(
        unknown_document.document().failure_class,
        "provider_effect_unknown"
    );
    assert!(
        !String::from_utf8_lossy(&unknown_bytes).contains("sensitive provider failure"),
        "raw provider failure text must never enter durable evidence"
    );

    let mut substituted_dispatch = dispatch;
    substituted_dispatch.body.budget.max_tokens = Some(15_000);
    assert!(build_provider_token_count_request_v1(
        &substituted_dispatch,
        &verified_model,
        &verified_scope,
        &verified_preflight,
        None,
    )
    .is_err());
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
