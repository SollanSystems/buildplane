//! Replay-derived opening of one protected read-only reviewer session.
//!
//! This module performs no model, filesystem, network, secret, Git, CAS, tape,
//! or promotion effect. It turns a repository-bound signed recovery token into
//! private reviewer evidence and a lane-bound session token only after complete
//! trusted replay identifies exactly one still-unclaimed reviewer activity.

use crate::governed_session_token::{
    issue_session_token_v1, verify_recovery_token_v1, verify_session_token_v1,
    GovernedSessionKindV1,
};
use crate::reviewer_session::{
    resolve_reviewer_model_evidence_for_candidate_recovery_v1, ResolvedReviewerModelEvidenceV1,
};
use bp_replay::TrustedGovernedRecoverySnapshot;
use ed25519_dalek::{SigningKey, VerifyingKey};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenedGovernedReviewerSessionV1 {
    recovery_ref: String,
    session_ref: String,
    evidence: ResolvedReviewerModelEvidenceV1,
}

impl OpenedGovernedReviewerSessionV1 {
    pub(crate) fn recovery_ref(&self) -> &str {
        &self.recovery_ref
    }

    pub(crate) fn session_ref(&self) -> &str {
        &self.session_ref
    }

    pub(crate) fn evidence(&self) -> &ResolvedReviewerModelEvidenceV1 {
        &self.evidence
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedReviewerAuthorityErrorV1 {
    #[error("governed reviewer recovery token is invalid")]
    RecoveryRejected,
    #[error("governed reviewer recovery run does not match trusted replay")]
    RunMismatch,
    #[error("governed reviewer replay evidence is unavailable")]
    EvidenceRejected,
    #[error("governed reviewer session identity could not be issued")]
    SessionRejected,
}

pub(crate) fn open_governed_reviewer_session_v1(
    snapshot: &TrustedGovernedRecoverySnapshot,
    session_signing_key: &SigningKey,
    project_identity_digest: &str,
    recovery_ref: &str,
    session_nonce: &str,
) -> Result<OpenedGovernedReviewerSessionV1, GovernedReviewerAuthorityErrorV1> {
    let verified_recovery = verify_recovery_token_v1(
        &session_signing_key.verifying_key(),
        recovery_ref,
        project_identity_digest,
    )
    .map_err(|_| GovernedReviewerAuthorityErrorV1::RecoveryRejected)?;
    if verified_recovery.run_id() != snapshot.run_id() {
        return Err(GovernedReviewerAuthorityErrorV1::RunMismatch);
    }
    let evidence = resolve_reviewer_model_evidence_for_candidate_recovery_v1(
        snapshot,
        verified_recovery.candidate_dispatch_event_ref(),
    )
    .map_err(|_| GovernedReviewerAuthorityErrorV1::EvidenceRejected)?;
    if evidence.run_id != verified_recovery.run_id() {
        return Err(GovernedReviewerAuthorityErrorV1::RunMismatch);
    }
    let session_ref = issue_session_token_v1(
        session_signing_key,
        GovernedSessionKindV1::Reviewer,
        &verified_recovery,
        session_nonce,
    )
    .map_err(|_| GovernedReviewerAuthorityErrorV1::SessionRejected)?;
    Ok(OpenedGovernedReviewerSessionV1 {
        recovery_ref: recovery_ref.into(),
        session_ref,
        evidence,
    })
}

/// Reopen only the exact reviewer identity authenticated by a session token.
///
/// This is still a pre-effect resolution step. The returned evidence must be
/// consumed by the native atomic authorize-and-claim transaction; callers must
/// never turn it into an in-process callback or retry a provider effect.
pub(crate) fn resolve_governed_reviewer_run_v1(
    snapshot: &TrustedGovernedRecoverySnapshot,
    session_verifying_key: &VerifyingKey,
    recovery_ref: &str,
    session_ref: &str,
) -> Result<ResolvedReviewerModelEvidenceV1, GovernedReviewerAuthorityErrorV1> {
    let verified_session = verify_session_token_v1(
        session_verifying_key,
        session_ref,
        GovernedSessionKindV1::Reviewer,
        recovery_ref,
    )
    .map_err(|_| GovernedReviewerAuthorityErrorV1::SessionRejected)?;
    if verified_session.run_id() != snapshot.run_id() {
        return Err(GovernedReviewerAuthorityErrorV1::RunMismatch);
    }
    let evidence = resolve_reviewer_model_evidence_for_candidate_recovery_v1(
        snapshot,
        verified_session.candidate_dispatch_event_ref(),
    )
    .map_err(|_| GovernedReviewerAuthorityErrorV1::EvidenceRejected)?;
    if evidence.run_id != verified_session.run_id() {
        return Err(GovernedReviewerAuthorityErrorV1::RunMismatch);
    }
    Ok(evidence)
}
