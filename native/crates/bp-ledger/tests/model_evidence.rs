//! Closed CAS documents used by the future native model-intent issuer.
//!
//! These tests deliberately exercise the documents without a live issuer: a
//! valid model intent must eventually be constructed from replayed tape data
//! and these verified bytes, never from a caller-provided authority proposal.

use bp_ledger::id::EventId;
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, derive_model_action_scope_constraints_v1,
    model_provider_result_document_v1_bytes, model_provider_unknown_evidence_document_v1_bytes,
    model_request_evidence_document_v1_bytes, model_request_evidence_v1_descriptor,
    model_result_evidence_document_v1_bytes, parse_verified_canonical_model_action_input_v1,
    parse_verified_model_provider_result_document_v1,
    parse_verified_model_provider_unknown_evidence_document_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_model_result_evidence_document_v1,
    parse_verified_provider_token_preflight_input_v1,
    parse_verified_provider_token_preflight_result_v1,
    parse_verified_provider_token_preflight_unknown_evidence_v1,
    parse_verified_trust_scope_evidence_document_v1, provider_token_preflight_input_v1_bytes,
    provider_token_preflight_result_v1_bytes, provider_token_preflight_unknown_evidence_v1_bytes,
    trust_scope_evidence_document_v1_bytes, trust_scope_evidence_v1_descriptor,
    verify_model_request_evidence_matches_canonical_input,
    verify_trust_scope_evidence_matches_model_request, CanonicalModelActionInputV1,
    CredentialFreeNormalizedModelRequestV1, ModelActionEvidenceBindingV1,
    ModelProviderCompletionV1, ModelProviderResultDocumentV1,
    ModelProviderUnknownEvidenceDocumentV1, ModelProviderV1, ModelRedactionCommitmentV1,
    ModelRequestEvidenceDocumentV1, ModelResultEvidenceDocumentV1, ModelToolCapabilityCommitmentV1,
    ModelToolCapabilityKindV1, ProviderTokenPreflightInputV1, ProviderTokenPreflightResultV1,
    ProviderTokenPreflightUnknownEvidenceV1, TrustScopeEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{
    ActionKindV1, ExecutionRoleV1, ReviewDecisionV1, ReviewFindingSeverityV1, ReviewFindingV1,
};
use bp_ledger::storage::cas::{CanonicalCasRef, Cas};
use serde_json::json;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn input() -> CanonicalModelActionInputV1 {
    CanonicalModelActionInputV1::new(
        CredentialFreeNormalizedModelRequestV1 {
            provider: ModelProviderV1::Openai,
            model: "gpt-5.6".into(),
            system_prompt: Some("Return only the closed response schema.".into()),
            prompt: "Review the immutable candidate.".into(),
            response_schema_digest: DIGEST_A.into(),
        },
        vec![ModelToolCapabilityCommitmentV1 {
            capability_id: "github.read".into(),
            kind: ModelToolCapabilityKindV1::ExternalService,
            input_schema_digest: DIGEST_B.into(),
            output_schema_digest: DIGEST_C.into(),
        }],
        vec![ModelRedactionCommitmentV1 {
            field: "system_prompt".into(),
            reason: "operator supplied instruction".into(),
            redacted_digest: Some(DIGEST_A.into()),
        }],
    )
    .expect("fixture input is valid")
}

fn binding(input_ref: &CanonicalCasRef) -> ModelActionEvidenceBindingV1 {
    ModelActionEvidenceBindingV1 {
        run_id: "run-1".into(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        dispatch_event_ref: EventId::new(),
        dispatch_envelope_digest: DIGEST_A.into(),
        action_request_event_ref: EventId::new(),
        action_request_digest: DIGEST_B.into(),
        action_id: "workflow-1:unit-1:attempt-1:model".into(),
        idempotency_key: "workflow-1:unit-1:attempt-1:model".into(),
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
    }
}

#[test]
fn canonical_input_round_trips_only_as_verified_canonical_raw_cas_bytes() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let input = input();
    let bytes = canonical_model_action_input_v1_bytes(&input).expect("canonical input bytes");
    let reference = cas.put_canonical_bytes(&bytes).expect("store input");

    let parsed = parse_verified_canonical_model_action_input_v1(
        &cas.get_verified_canonical_bytes(&reference.to_cas_ref(), reference.digest())
            .expect("load verified raw input"),
        &reference.to_cas_ref(),
        reference.digest(),
    )
    .expect("parse verified canonical input");
    assert_eq!(parsed.document(), &input);

    let pretty = serde_json::to_vec_pretty(&input).expect("pretty input JSON");
    let pretty_reference = cas
        .put_canonical_bytes(&pretty)
        .expect("store pretty bytes");
    assert!(
        parse_verified_canonical_model_action_input_v1(
            &pretty,
            &pretty_reference.to_cas_ref(),
            pretty_reference.digest(),
        )
        .is_err(),
        "whitespace or field-order variants must not become alternate evidence bytes"
    );
}

#[test]
fn native_evidence_constructors_bind_the_exact_input_and_closed_governed_scope() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let input = input();
    let input_bytes = canonical_model_action_input_v1_bytes(&input).expect("canonical input bytes");
    let input_ref = cas.put_canonical_bytes(&input_bytes).expect("store input");
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    )
    .expect("parse verified input");
    let binding = binding(&input_ref);

    let model_document = ModelRequestEvidenceDocumentV1::from_verified_canonical_input(
        binding.clone(),
        &verified_input,
    )
    .expect("construct model evidence from verified input");
    verify_model_request_evidence_matches_canonical_input(&model_document, &verified_input)
        .expect("model evidence must reproduce canonical input semantics");
    let model_bytes =
        model_request_evidence_document_v1_bytes(&model_document).expect("model evidence bytes");
    let model_ref = cas
        .put_canonical_bytes(&model_bytes)
        .expect("store model evidence");
    let model_descriptor = model_request_evidence_v1_descriptor(&model_ref);
    let parsed_model =
        parse_verified_model_request_evidence_document_v1(&model_bytes, &model_descriptor)
            .expect("parse verified model evidence");
    assert_eq!(parsed_model.document(), &model_document);

    let constraints =
        derive_model_action_scope_constraints_v1(binding.execution_role, &input.tool_capabilities)
            .expect("derive fixed host constraints");
    let scope = TrustScopeEvidenceDocumentV1::from_verified_model_request_evidence(
        &parsed_model,
        DIGEST_C.into(),
        constraints,
    )
    .expect("construct governed atomic sealed-v3 trust scope");
    verify_trust_scope_evidence_matches_model_request(&scope, &parsed_model)
        .expect("scope must bind the exact model evidence descriptor and semantics");
    let scope_bytes = trust_scope_evidence_document_v1_bytes(&scope).expect("trust scope bytes");
    let scope_ref = cas
        .put_canonical_bytes(&scope_bytes)
        .expect("store trust scope");
    let scope_descriptor = trust_scope_evidence_v1_descriptor(&scope_ref);
    assert_eq!(
        parse_verified_trust_scope_evidence_document_v1(&scope_bytes, &scope_descriptor)
            .expect("parse verified trust scope")
            .document(),
        &scope
    );
}

#[test]
fn evidence_documents_reject_unknown_fields_semantic_substitution_and_descriptor_mismatch() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let input = input();
    let input_bytes = canonical_model_action_input_v1_bytes(&input).expect("canonical input bytes");
    let input_ref = cas.put_canonical_bytes(&input_bytes).expect("store input");

    let mut substituted = input.clone();
    substituted.normalized_provider_request.prompt = "Call an unrelated provider action.".into();
    assert!(
        canonical_model_action_input_v1_bytes(&substituted).is_err(),
        "the semantic request digest must reject a changed request"
    );

    let mut unknown = serde_json::to_value(&input).expect("input JSON value");
    unknown
        .as_object_mut()
        .expect("input is an object")
        .insert("operator_override".into(), json!(true));
    let unknown_bytes = serde_json::to_vec(&unknown).expect("unknown input bytes");
    let unknown_ref = cas
        .put_canonical_bytes(&unknown_bytes)
        .expect("store unknown input");
    assert!(
        parse_verified_canonical_model_action_input_v1(
            &unknown_bytes,
            &unknown_ref.to_cas_ref(),
            unknown_ref.digest(),
        )
        .is_err(),
        "future fields must fail closed instead of changing issuer semantics"
    );

    assert!(
        parse_verified_canonical_model_action_input_v1(
            &input_bytes,
            &input_ref.to_cas_ref(),
            DIGEST_A,
        )
        .is_err(),
        "a descriptor that names a different raw CAS digest must be rejected"
    );
}

#[test]
fn provider_token_preflight_documents_bind_the_verified_request_and_total_budget() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let input = input();
    let input_bytes = canonical_model_action_input_v1_bytes(&input).expect("canonical input bytes");
    let input_ref = cas.put_canonical_bytes(&input_bytes).expect("store input");
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    )
    .expect("verified input");
    let model_document = ModelRequestEvidenceDocumentV1::from_verified_canonical_input(
        binding(&input_ref),
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

    let preflight =
        ProviderTokenPreflightInputV1::from_verified_model_request(&verified_model, 14_000)
            .expect("preflight input");
    let preflight_bytes =
        provider_token_preflight_input_v1_bytes(&preflight).expect("preflight bytes");
    let preflight_ref = cas
        .put_canonical_bytes(&preflight_bytes)
        .expect("store preflight");
    let verified_preflight = parse_verified_provider_token_preflight_input_v1(
        &preflight_bytes,
        &preflight_ref.to_cas_ref(),
        preflight_ref.digest(),
        &verified_model,
    )
    .expect("verified preflight");
    assert_eq!(verified_preflight.document(), &preflight);

    let result =
        ProviderTokenPreflightResultV1::new(&verified_preflight, 321).expect("preflight result");
    let result_bytes =
        provider_token_preflight_result_v1_bytes(&result).expect("preflight result bytes");
    let result_ref = cas
        .put_canonical_bytes(&result_bytes)
        .expect("store preflight result");
    assert_eq!(
        parse_verified_provider_token_preflight_result_v1(
            &result_bytes,
            &result_ref.to_cas_ref(),
            result_ref.digest(),
            &verified_preflight,
        )
        .expect("verified preflight result")
        .document(),
        &result
    );

    assert!(ProviderTokenPreflightResultV1::new(&verified_preflight, 0).is_err());
    assert!(ProviderTokenPreflightResultV1::new(&verified_preflight, 14_000).is_err());

    let provider_request_id = "openai:workflow:unit:attempt-1:model:provider-token-preflight";
    let unknown = ProviderTokenPreflightUnknownEvidenceV1::new(
        &verified_preflight,
        provider_request_id.into(),
    )
    .expect("unknown evidence");
    let unknown_bytes = provider_token_preflight_unknown_evidence_v1_bytes(&unknown)
        .expect("unknown evidence bytes");
    let unknown_ref = cas
        .put_canonical_bytes(&unknown_bytes)
        .expect("store unknown evidence");
    let verified_unknown = parse_verified_provider_token_preflight_unknown_evidence_v1(
        &unknown_bytes,
        &unknown_ref.to_cas_ref(),
        unknown_ref.digest(),
        &verified_preflight,
        provider_request_id,
    )
    .expect("verified unknown evidence");
    assert_eq!(verified_unknown.document(), &unknown);
    assert_eq!(verified_unknown.reference(), &unknown_ref);
    assert!(
        parse_verified_provider_token_preflight_unknown_evidence_v1(
            &unknown_bytes,
            &unknown_ref.to_cas_ref(),
            unknown_ref.digest(),
            &verified_preflight,
            "openai:attacker-selected",
        )
        .is_err(),
        "unknown evidence must remain bound to the exact provider request"
    );

    let mut substituted = preflight;
    substituted.model_request_digest = DIGEST_A.into();
    let substituted_bytes =
        provider_token_preflight_input_v1_bytes(&substituted).expect("well-formed substitution");
    let substituted_ref = cas
        .put_canonical_bytes(&substituted_bytes)
        .expect("store substitution");
    assert!(
        parse_verified_provider_token_preflight_input_v1(
            &substituted_bytes,
            &substituted_ref.to_cas_ref(),
            substituted_ref.digest(),
            &verified_model,
        )
        .is_err(),
        "a well-formed preflight for different model evidence must fail"
    );
}

#[test]
fn model_result_evidence_is_closed_canonical_and_bound_to_exact_result() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let evidence = ModelResultEvidenceDocumentV1::new(
        "workflow-1:unit-1:attempt-1:model".into(),
        "event:action-request-1".into(),
        DIGEST_A.into(),
        DIGEST_B.into(),
        "model-auth:v2:run-1:action-1".into(),
        DIGEST_C.into(),
        format!("cas:{}", DIGEST_A),
        DIGEST_A.into(),
        vec![ModelRedactionCommitmentV1 {
            field: "provider_credential".into(),
            reason: "host-only credential".into(),
            redacted_digest: None,
        }],
    )
    .expect("closed evidence");
    let bytes =
        model_result_evidence_document_v1_bytes(&evidence).expect("canonical evidence bytes");
    let reference = cas
        .put_canonical_bytes(&bytes)
        .expect("store result evidence");
    let verified = parse_verified_model_result_evidence_document_v1(
        &bytes,
        &reference.to_cas_ref(),
        reference.digest(),
    )
    .expect("verified result evidence");
    assert_eq!(verified.document(), &evidence);

    let mut unknown = serde_json::to_value(&evidence).expect("evidence JSON");
    unknown["operator_override"] = json!(true);
    let unknown_bytes = serde_json::to_vec(&unknown).expect("unknown bytes");
    let unknown_ref = cas
        .put_canonical_bytes(&unknown_bytes)
        .expect("store unknown bytes");
    assert!(parse_verified_model_result_evidence_document_v1(
        &unknown_bytes,
        &unknown_ref.to_cas_ref(),
        unknown_ref.digest(),
    )
    .is_err());

    let mut substituted = evidence;
    substituted.result_digest = DIGEST_B.into();
    assert!(
        model_result_evidence_document_v1_bytes(&substituted).is_err(),
        "result ref and digest substitution must fail before persistence"
    );
}

#[test]
fn model_provider_result_is_closed_and_role_candidate_manifest_bound() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let result = ModelProviderResultDocumentV1::new(
        "workflow-1:unit-1:attempt-1:model".into(),
        "openai:workflow-1:unit-1:attempt-1:model".into(),
        DIGEST_A.into(),
        ExecutionRoleV1::Reviewer,
        Some(DIGEST_B.into()),
        DIGEST_C.into(),
        ModelProviderCompletionV1::Review {
            decision: ReviewDecisionV1::Abstain,
            findings: vec![ReviewFindingV1 {
                severity: ReviewFindingSeverityV1::High,
                check_id: "review.security".into(),
                file: "src/lib.rs".into(),
                line: 12,
                explanation: "Evidence is insufficient.".into(),
                evidence_refs: vec![format!("cas:{}", DIGEST_A)],
            }],
            confidence: 0.25,
        },
    )
    .expect("closed provider result");
    let bytes =
        model_provider_result_document_v1_bytes(&result).expect("canonical provider result bytes");
    let reference = cas
        .put_canonical_bytes(&bytes)
        .expect("store provider result");
    assert_eq!(
        parse_verified_model_provider_result_document_v1(
            &bytes,
            &reference.to_cas_ref(),
            reference.digest(),
        )
        .expect("verified provider result")
        .document(),
        &result
    );

    let mut wrong_role = result.clone();
    wrong_role.execution_role = ExecutionRoleV1::Implementer;
    assert!(model_provider_result_document_v1_bytes(&wrong_role).is_err());

    let mut unknown = serde_json::to_value(&result).expect("result JSON");
    unknown["completion"]["operator_override"] = json!(true);
    let unknown_bytes = serde_json::to_vec(&unknown).expect("unknown bytes");
    let unknown_ref = cas
        .put_canonical_bytes(&unknown_bytes)
        .expect("store unknown bytes");
    assert!(parse_verified_model_provider_result_document_v1(
        &unknown_bytes,
        &unknown_ref.to_cas_ref(),
        unknown_ref.digest(),
    )
    .is_err());
}

#[test]
fn model_provider_unknown_evidence_is_closed_canonical_and_authority_bound() {
    let temp = tempfile::tempdir().expect("temporary CAS root");
    let cas = Cas::open(temp.path()).expect("open CAS");
    let evidence = ModelProviderUnknownEvidenceDocumentV1::new(
        "workflow-1:unit-1:attempt-1:model".into(),
        "anthropic:workflow-1:unit-1:attempt-1:model".into(),
        DIGEST_A.into(),
        "model-auth:v2:workflow-1:unit-1".into(),
        DIGEST_B.into(),
    )
    .expect("closed unknown evidence");
    let bytes = model_provider_unknown_evidence_document_v1_bytes(&evidence)
        .expect("canonical unknown evidence bytes");
    let reference = cas
        .put_canonical_bytes(&bytes)
        .expect("store unknown evidence");
    let verified = parse_verified_model_provider_unknown_evidence_document_v1(
        &bytes,
        &reference.to_cas_ref(),
        reference.digest(),
    )
    .expect("verified unknown evidence");
    assert_eq!(verified.document(), &evidence);
    assert_eq!(verified.reference(), &reference);

    let mut expanded = serde_json::to_value(&evidence).expect("unknown evidence JSON");
    expanded["provider_error"] = json!("secret-bearing transport error");
    let expanded_bytes = serde_json::to_vec(&expanded).expect("expanded bytes");
    let expanded_ref = cas
        .put_canonical_bytes(&expanded_bytes)
        .expect("store expanded bytes");
    assert!(
        parse_verified_model_provider_unknown_evidence_document_v1(
            &expanded_bytes,
            &expanded_ref.to_cas_ref(),
            expanded_ref.digest(),
        )
        .is_err(),
        "provider error details and unknown fields must fail closed"
    );
}
