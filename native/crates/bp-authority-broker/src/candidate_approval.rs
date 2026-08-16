use crate::governed_session_client::CandidateApprovalV1;
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;

/// Why a candidate approval was refused. Kept separate from the host's coarse
/// provider error so the decision can be tested without a ledger fixture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CandidateApprovalRejectionV1 {
    /// The resolved admission carries no provenance, so a preauthorization
    /// reference cannot be matched against one. Defense-in-depth only: the wire
    /// parser rejects an empty reference, and `validate_governed_dispatch`
    /// rejects an empty `provenance_ref` at resolve time, so this is not
    /// reachable in production.
    ProvenanceAbsent,
    /// The preauthorization reference is not the admission's provenance.
    ProvenanceMismatch,
    /// Approval variant not supported on this surface.
    UnsupportedApproval,
}

/// Decide whether an approval may open a candidate session against an already
/// resolved (signature- and window-validated) V5 admission.
///
/// `OperatorRequested` is unconditional. It asserts no operator presence and
/// proves none — nothing on this path checks for a live operator decision. It
/// is admitted because the resolver has already proven exactly one live sealed
/// admission binds this packet.
///
/// # What the `PreauthorizationRef` arm is NOT
///
/// It is a **consistency check**, not proof of an out-of-band grant. It
/// establishes only that the supplied reference names the same admission the
/// caller's own packet already resolves to — and the caller can read that value
/// straight out of the `packet_source` it must supply anyway: resolution
/// enforces `packet.provenance_ref == dispatch.body.provenance_ref`
/// (`bp-ledger` `sqlite.rs:15331`), and that same value becomes
/// `resolved.provenance_ref` (`sqlite.rs:9253`). So any caller able to resolve
/// an admission at all can always satisfy this arm.
///
/// Do **not** treat "opened via `PreauthorizationRef`" as evidence of standing
/// or automated authorization. Making it real requires verifying the referenced
/// `plan_admitted` event's own kernel signature inside the broker — a blocking
/// prerequisite before this arm carries any authority weight, tracked as the
/// first item of the standing-authority slice.
///
/// This arm is safe today only because `OperatorRequested` is itself
/// unconditional and strictly weaker, so this grants no capability that was not
/// already reachable. **Ordering hazard:** tightening `OperatorRequested`
/// without first landing that signature check would silently make this the
/// weakest path and defeat the tightening.
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
