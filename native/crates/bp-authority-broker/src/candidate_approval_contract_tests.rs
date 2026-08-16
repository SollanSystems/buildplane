use crate::candidate_approval::{
    authorize_candidate_approval_v1, CandidateApprovalRejectionV1,
};
use crate::governed_session_client::CandidateApprovalV1;
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;
use bp_ledger::{EventId, RunId};

fn resolved_with_provenance(provenance_ref: &str) -> ResolvedGovernedV5CandidateAuthorityV1 {
    ResolvedGovernedV5CandidateAuthorityV1 {
        run_id: RunId::from_uuid(uuid::Uuid::from_u128(1)),
        dispatch_event_id: EventId::from_uuid(uuid::Uuid::from_u128(1)),
        admission_event_id: EventId::from_uuid(uuid::Uuid::from_u128(2)),
        workflow_id: "wf-1".to_owned(),
        unit_id: "unit-1".to_owned(),
        attempt: 1,
        provenance_ref: provenance_ref.to_owned(),
        base_commit_sha: "a".repeat(40),
        repository_binding_digest: "sha256:aa".to_owned(),
        dispatch_envelope_digest: "sha256:bb".to_owned(),
        governed_packet_digest: "sha256:cc".to_owned(),
        sandbox_profile_digest: "sha256:dd".to_owned(),
    }
}

#[test]
fn operator_requested_is_authorized_regardless_of_provenance() {
    let resolved = resolved_with_provenance("");
    assert_eq!(
        authorize_candidate_approval_v1(&CandidateApprovalV1::OperatorRequested, &resolved),
        Ok(())
    );
}

#[test]
fn preauthorization_ref_matching_provenance_is_authorized() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000042".to_owned()),
            &resolved,
        ),
        Ok(())
    );
}

#[test]
fn preauthorization_ref_mismatching_provenance_is_rejected() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000099".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::ProvenanceMismatch)
    );
}

#[test]
fn preauthorization_ref_against_empty_provenance_is_rejected() {
    let resolved = resolved_with_provenance("");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000042".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::ProvenanceAbsent)
    );
}

#[test]
fn preauthorized_envelope_source_remains_unsupported() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizedEnvelopeSource("{}".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::UnsupportedApproval)
    );
}
