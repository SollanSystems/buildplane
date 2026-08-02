use crate::governed_session_client::CandidateApprovalV1;
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;

/// Why a candidate approval was refused. Kept separate from the host's coarse
/// provider error so the decision can be tested without a ledger fixture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CandidateApprovalRejectionV1 {
    /// The resolved admission carries no provenance, so a preauthorization
    /// reference cannot be bound to a plan admission.
    ProvenanceAbsent,
    /// The preauthorization reference is not the admission's provenance.
    ProvenanceMismatch,
    /// Approval variant not supported on this surface.
    UnsupportedApproval,
}

/// Decide whether an approval may open a candidate session against an already
/// resolved (signature- and window-validated) V5 admission.
///
/// `OperatorRequested` is unconditional: the operator is present, and the
/// resolver has already proven exactly one live sealed admission binds this
/// packet. `PreauthorizationRef` is the standing-authority path, so it must
/// additionally bind to the plan admission that authorized the dispatch —
/// an absent provenance is refused rather than treated as a wildcard.
pub(crate) fn authorize_candidate_approval_v1(
    approval: &CandidateApprovalV1,
    resolved: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<(), CandidateApprovalRejectionV1> {
    match approval {
        CandidateApprovalV1::OperatorRequested => Ok(()),
        CandidateApprovalV1::PreauthorizationRef(reference) => {
            if resolved.provenance_ref.is_empty() {
                return Err(CandidateApprovalRejectionV1::ProvenanceAbsent);
            }
            if resolved.provenance_ref != *reference {
                return Err(CandidateApprovalRejectionV1::ProvenanceMismatch);
            }
            Ok(())
        }
        CandidateApprovalV1::PreauthorizedEnvelopeSource(_) => {
            Err(CandidateApprovalRejectionV1::UnsupportedApproval)
        }
    }
}
