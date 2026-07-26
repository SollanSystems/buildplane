use crate::provider_request::BoundProviderRequestV1;
use crate::provider_result::ProviderResultWriterV1;
use crate::PrivateModelCapability;
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, model_request_evidence_document_v1_bytes,
    model_request_evidence_v1_descriptor, parse_verified_canonical_model_action_input_v1,
    parse_verified_model_provider_result_document_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_model_result_evidence_document_v1, CanonicalModelActionInputV1,
    CredentialFreeNormalizedModelRequestV1, ModelActionEvidenceBindingV1, ModelProviderV1,
    ModelRequestEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{ActionKindV1, ExecutionRoleV1};
use bp_ledger::storage::Cas;
use bp_ledger::{EventId, RunId};
use bp_provider_sdk::{
    provider_response_contract_v1, ProviderCompletionV1, ProviderExecutionRoleV1,
    ProviderImplementerCompletionV1, ProviderRequest,
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[test]
fn provider_result_writer_persists_exact_result_and_evidence_objects() {
    let temp = tempfile::tempdir().expect("temporary CAS");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let input = CanonicalModelActionInputV1::new(
        CredentialFreeNormalizedModelRequestV1 {
            provider: ModelProviderV1::Openai,
            model: "gpt-5.6".into(),
            system_prompt: None,
            prompt: "Create the immutable candidate.".into(),
            response_schema_digest: provider_response_contract_v1(
                ProviderExecutionRoleV1::Implementer,
            )
            .expect("response contract")
            .contract_digest,
        },
        vec![],
        vec![],
    )
    .expect("canonical input");
    let input_bytes = canonical_model_action_input_v1_bytes(&input).expect("canonical input bytes");
    let input_ref = cas
        .put_canonical_bytes(&input_bytes)
        .expect("store canonical input");
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    )
    .expect("verified input");
    let run_id = RunId::new();
    let dispatch_event_id = EventId::new();
    let action_request_event_id = EventId::new();
    let action_id = "workflow-1:unit-1:attempt-1:model".to_string();
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
        action_id: action_id.clone(),
        idempotency_key: action_id.clone(),
        action_kind: ActionKindV1::Model,
        canonical_input_ref: input_ref.to_cas_ref(),
        canonical_input_digest: input_ref.digest().into(),
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: DIGEST_C.into(),
        capability_bundle_digest: DIGEST_A.into(),
        policy_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_A.into(),
        sandbox_profile_digest: DIGEST_B.into(),
        execution_role: ExecutionRoleV1::Implementer,
    };
    let model_document = ModelRequestEvidenceDocumentV1::from_verified_canonical_input(
        binding.clone(),
        &verified_input,
    )
    .expect("model request evidence");
    let model_bytes =
        model_request_evidence_document_v1_bytes(&model_document).expect("model evidence bytes");
    let model_ref = cas
        .put_canonical_bytes(&model_bytes)
        .expect("store model evidence");
    let verified_model = parse_verified_model_request_evidence_document_v1(
        &model_bytes,
        &model_request_evidence_v1_descriptor(&model_ref),
    )
    .expect("verified model evidence");
    let response_contract = provider_response_contract_v1(ProviderExecutionRoleV1::Implementer)
        .expect("response contract");
    let mut bound = BoundProviderRequestV1 {
        provider: ModelProviderV1::Openai,
        request: ProviderRequest {
            schema_version: 1,
            request_id: format!("openai:{action_id}"),
            model: "gpt-5.6".into(),
            execution_role: ProviderExecutionRoleV1::Implementer,
            system_prompt: None,
            prompt: "Create the immutable candidate.".into(),
            response_schema_name: response_contract.name.into(),
            response_contract_digest: response_contract.contract_digest,
            response_schema_digest: response_contract.schema_digest,
            response_schema: response_contract.schema,
            candidate_digest: None,
            worker_manifest_digest: DIGEST_A.into(),
            max_total_tokens: 1000,
            max_input_tokens: 750,
            max_output_tokens: 250,
            deadline_unix_ms: i64::MAX,
            tools: vec![],
        },
    };
    let capability = PrivateModelCapability {
        run_id,
        dispatch_event_id,
        action_request_event_id,
        execution_role: ExecutionRoleV1::Implementer,
        lease_id: "lease-1".into(),
        authorization_ref: "model-auth:v2:run-1:action-1".into(),
    };
    let completion = ProviderCompletionV1::Implementer(ProviderImplementerCompletionV1 {
        schema_version: 1,
        outcome: "completed".into(),
        summary: "Candidate created.".into(),
        output_refs: vec![],
    });

    let persisted = ProviderResultWriterV1::new(&cas)
        .persist_success(&capability, DIGEST_C, &verified_model, &bound, completion)
        .expect("persist paired provider result");
    let result_bytes = cas
        .get_verified_canonical_bytes(
            persisted.result_ref.as_deref().expect("result ref"),
            persisted.result_digest.as_deref().expect("result digest"),
        )
        .expect("load result");
    let result = parse_verified_model_provider_result_document_v1(
        &result_bytes,
        persisted.result_ref.as_deref().expect("result ref"),
        persisted.result_digest.as_deref().expect("result digest"),
    )
    .expect("verified provider result");
    assert_eq!(result.document().action_id, action_id);
    assert_eq!(
        result.document().worker_manifest_digest,
        binding.worker_manifest_digest
    );

    let evidence_bytes = cas
        .get_verified_canonical_bytes(&persisted.evidence_ref, &persisted.evidence_digest)
        .expect("load evidence");
    let evidence = parse_verified_model_result_evidence_document_v1(
        &evidence_bytes,
        &persisted.evidence_ref,
        &persisted.evidence_digest,
    )
    .expect("verified result evidence");
    assert_eq!(
        evidence.document().result_digest,
        result.reference().digest()
    );
    assert_eq!(
        evidence.document().authorization_ref,
        capability.authorization_ref
    );

    bound.request.worker_manifest_digest = DIGEST_B.into();
    let substituted = ProviderCompletionV1::Implementer(ProviderImplementerCompletionV1 {
        schema_version: 1,
        outcome: "completed".into(),
        summary: "Candidate created.".into(),
        output_refs: vec![],
    });
    assert!(
        ProviderResultWriterV1::new(&cas)
            .persist_success(&capability, DIGEST_C, &verified_model, &bound, substituted,)
            .is_err(),
        "a well-formed request for another worker manifest must not persist success"
    );
}
