use crate::provider_request::BoundProviderRequestV1;
use crate::provider_result::ProviderResultWriterV1;
use crate::{PrivateModelCapability, ProviderExecutionAuthorityV1};
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, model_request_evidence_document_v1_bytes,
    model_request_evidence_v1_descriptor, parse_verified_canonical_model_action_input_v1,
    parse_verified_model_provider_result_document_v1,
    parse_verified_model_provider_unknown_evidence_document_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_model_result_evidence_document_v1, CanonicalModelActionInputV1,
    CredentialFreeNormalizedModelRequestV1, ModelActionEvidenceBindingV1, ModelProviderV1,
    ModelRequestEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{
    candidate_view_v1_digest, review_verdict_output_v1_digest, ActionKindV1, CandidateViewV1,
    ExecutionRoleV1, ModelActionCandidateBindingV1, ReviewDecisionV1, ReviewVerdictOutputV1,
};
use bp_ledger::storage::Cas;
use bp_ledger::{EventId, RunId};
use bp_provider_sdk::{
    provider_response_contract_v1, ProviderCompletionV1, ProviderExecutionRoleV1,
    ProviderImplementerCompletionV1, ProviderRequest, ProviderReviewDecisionV1,
    ProviderReviewVerdictV1,
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
        provider_authority: ProviderExecutionAuthorityV1::synthetic_for_test(),
    };
    let completion = ProviderCompletionV1::Implementer(ProviderImplementerCompletionV1 {
        schema_version: 1,
        outcome: "completed".into(),
        summary: "Candidate created.".into(),
        output_refs: vec![],
    });

    let persisted = ProviderResultWriterV1::new(&cas)
        .persist_success(
            &capability,
            DIGEST_C,
            &verified_model,
            &bound,
            None,
            completion,
        )
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

    let unknown = ProviderResultWriterV1::new(&cas)
        .persist_unknown(&capability, DIGEST_C, &verified_model)
        .expect("persist paired unknown evidence");
    let unknown_bytes = cas
        .get_verified_canonical_bytes(&unknown.evidence_ref, &unknown.evidence_digest)
        .expect("load unknown evidence");
    let unknown_evidence = parse_verified_model_provider_unknown_evidence_document_v1(
        &unknown_bytes,
        &unknown.evidence_ref,
        &unknown.evidence_digest,
    )
    .expect("verify unknown evidence");
    assert_eq!(
        unknown_evidence.document().authorization_ref,
        capability.authorization_ref
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
            .persist_success(
                &capability,
                DIGEST_C,
                &verified_model,
                &bound,
                None,
                substituted,
            )
            .is_err(),
        "a well-formed request for another worker manifest must not persist success"
    );
}

#[test]
fn provider_result_writer_persists_the_exact_closed_review_output() {
    let temp = tempfile::tempdir().expect("temporary CAS");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let response_contract = provider_response_contract_v1(ProviderExecutionRoleV1::Reviewer)
        .expect("review response contract");
    let input = CanonicalModelActionInputV1::new(
        CredentialFreeNormalizedModelRequestV1 {
            provider: ModelProviderV1::Openai,
            model: "gpt-5.6".into(),
            system_prompt: None,
            prompt: "Review the immutable candidate.".into(),
            response_schema_digest: response_contract.contract_digest.clone(),
        },
        vec![],
        vec![],
    )
    .expect("canonical review input");
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
    let action_id = "workflow-review:unit-review:attempt-1:model".to_string();
    let binding = ModelActionEvidenceBindingV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-review".into(),
        unit_id: "unit-review".into(),
        attempt: 1,
        provenance_ref: "admission:review".into(),
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
        execution_role: ExecutionRoleV1::Reviewer,
    };
    let model_document = ModelRequestEvidenceDocumentV1::from_verified_canonical_input(
        binding.clone(),
        &verified_input,
    )
    .expect("review model request evidence");
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
    let candidate_view = CandidateViewV1 {
        candidate_ref: "refs/buildplane/candidates/review-target".into(),
        candidate_digest: DIGEST_C.into(),
        candidate_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        tree_digest: DIGEST_B.into(),
        reviewer_context_manifest_digest: binding.context_manifest_digest.clone(),
        reviewer_sandbox_profile_digest: binding.sandbox_profile_digest.clone(),
        mount_path_digest: DIGEST_A.into(),
        read_only: true,
        network_disabled: true,
    };
    let candidate_view_digest =
        candidate_view_v1_digest(&candidate_view).expect("candidate view digest");
    let candidate = ModelActionCandidateBindingV1 {
        candidate_created_event_ref: EventId::new(),
        candidate_digest: candidate_view.candidate_digest.clone(),
        candidate_commit_sha: candidate_view.candidate_commit_sha.clone(),
        candidate_view_ref: format!("cas:{candidate_view_digest}"),
        candidate_view_digest: candidate_view_digest.clone(),
        candidate_view,
    };
    let bound = BoundProviderRequestV1 {
        provider: ModelProviderV1::Openai,
        request: ProviderRequest {
            schema_version: 1,
            request_id: format!("openai:{action_id}"),
            model: "gpt-5.6".into(),
            execution_role: ProviderExecutionRoleV1::Reviewer,
            system_prompt: None,
            prompt: "Review the immutable candidate.".into(),
            response_schema_name: response_contract.name.into(),
            response_contract_digest: response_contract.contract_digest,
            response_schema_digest: response_contract.schema_digest,
            response_schema: response_contract.schema,
            candidate_digest: Some(DIGEST_C.into()),
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
        execution_role: ExecutionRoleV1::Reviewer,
        lease_id: "lease-review".into(),
        authorization_ref: "model-auth:v2:run-review:action-review".into(),
        provider_authority: ProviderExecutionAuthorityV1::synthetic_for_test(),
    };
    let completion = ProviderCompletionV1::Review(ProviderReviewVerdictV1 {
        schema_version: 1,
        candidate_digest: DIGEST_C.into(),
        decision: ProviderReviewDecisionV1::Abstain,
        findings: vec![],
        confidence: 0.25,
        reviewer_manifest_digest: DIGEST_A.into(),
    });

    let persisted = ProviderResultWriterV1::new(&cas)
        .persist_success(
            &capability,
            DIGEST_B,
            &verified_model,
            &bound,
            Some(&candidate),
            completion,
        )
        .expect("persist exact closed review output");
    let result_bytes = cas
        .get_verified_canonical_bytes(
            persisted.result_ref.as_deref().expect("review result ref"),
            persisted
                .result_digest
                .as_deref()
                .expect("review result digest"),
        )
        .expect("load review result");
    let output: ReviewVerdictOutputV1 =
        serde_json::from_slice(&result_bytes).expect("decode closed review output");
    assert_eq!(output.decision, ReviewDecisionV1::Abstain);
    assert_eq!(output.candidate_digest, DIGEST_C);
    assert_eq!(output.candidate_view_digest, candidate_view_digest);
    let semantic_digest = review_verdict_output_v1_digest(&output).expect("review semantic digest");
    assert_ne!(
        semantic_digest,
        persisted
            .result_digest
            .expect("persisted review content digest"),
        "domain-separated review semantics and raw CAS content use distinct digests"
    );
}
