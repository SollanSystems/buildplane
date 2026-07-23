//! ReplayEngine: forward iteration over a tape.

use crate::reader::{EventReader, ReaderError, VerifiedEvent};
use crate::state::{ReplayIssue, ReplayState};
use crate::transitions;
use bp_ledger::event::Event;
use bp_ledger::id::EventId;
use bp_ledger::payload::{trust_spine::WorkflowCancellationCauseV1, Payload};
use bp_ledger::signing::{ActorKeyRef, EventSignatureV1, TrustedPublicKeys, VerificationStatus};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("reader: {0}")]
    Reader(#[from] ReaderError),
}

#[derive(Debug, Serialize)]
pub struct ReplayStep {
    pub event: Event,
    pub state_after: ReplayState,
}

/// Event-purpose authorization for trust-spine records. Cryptographic validity
/// only proves that a configured key signed an event; it does not allow a
/// worker/reviewer key to mint dispatches or promotions. Callers must register
/// each exact actor/key/hash identity for the roles it may exercise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TrustSpineSignerRole {
    Kernel,
    Reviewer,
    Operator,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SignerIdentity {
    actor_id: String,
    key_id: String,
    public_key_hash: Option<String>,
}

impl From<&ActorKeyRef> for SignerIdentity {
    fn from(signer: &ActorKeyRef) -> Self {
        Self {
            actor_id: signer.actor_id.clone(),
            key_id: signer.key_id.clone(),
            public_key_hash: signer.public_key_hash.clone(),
        }
    }
}

/// Explicit trusted keys plus the authority each key has over governed tape
/// events. Supplying only [`TrustedPublicKeys`] is deliberately insufficient
/// for a trust-spine workflow projection: it verifies bytes but grants no
/// authority.
#[derive(Clone, Debug, Default)]
pub struct TrustedReplayAuthorities {
    trusted_keys: TrustedPublicKeys,
    allowed: BTreeMap<TrustSpineSignerRole, BTreeSet<SignerIdentity>>,
}

impl TrustedReplayAuthorities {
    pub fn new(trusted_keys: TrustedPublicKeys) -> Self {
        Self {
            trusted_keys,
            allowed: BTreeMap::new(),
        }
    }

    pub fn allow_signer(&mut self, role: TrustSpineSignerRole, signer: ActorKeyRef) {
        self.allowed
            .entry(role)
            .or_default()
            .insert(SignerIdentity::from(&signer));
    }

    fn trusted_keys(&self) -> &TrustedPublicKeys {
        &self.trusted_keys
    }

    /// Internal trust-boundary check shared with the governed recovery
    /// snapshot. It deliberately remains crate-private so callers cannot use
    /// the authority registry as a substitute for trusted replay.
    pub(crate) fn permits(&self, role: TrustSpineSignerRole, signer: &ActorKeyRef) -> bool {
        self.allowed
            .get(&role)
            .is_some_and(|allowed| allowed.contains(&SignerIdentity::from(signer)))
    }
}

pub struct ReplayEngine {
    events: Vec<VerifiedEvent>,
    cursor: usize,
    state: ReplayState,
    authorities: TrustedReplayAuthorities,
    /// Runs with an authority-verified governed dispatch anywhere in this
    /// replay. Activity V1 has only a `run_id`, so the engine must know this
    /// before it encounters an earlier activity bracket: otherwise an
    /// unsigned bracket could be projected as legacy state and later adopted
    /// by a governed idempotency check.
    predeclared_governed_runs: BTreeSet<String>,
}

impl ReplayEngine {
    /// Open a replay with no trusted signing keys or event-purpose authority.
    /// Trust-spine events are therefore fail-closed while legacy tape replay
    /// remains readable.
    pub fn open(run_id: &str, db_path: impl AsRef<Path>) -> Result<Self, EngineError> {
        Self::open_with_trusted_authorities(run_id, db_path, &TrustedReplayAuthorities::default())
    }

    /// Compatibility reader for callers that need signature diagnostics but have
    /// not configured event-purpose authority. Trust-spine records remain blocked. Use
    /// [`Self::open_with_trusted_authorities`] to reconstruct a governed V1
    /// workflow.
    pub fn open_with_trusted_keys(
        run_id: &str,
        db_path: impl AsRef<Path>,
        trusted_keys: &TrustedPublicKeys,
    ) -> Result<Self, EngineError> {
        let authorities = TrustedReplayAuthorities::new(trusted_keys.clone());
        Self::open_with_trusted_authorities(run_id, db_path, &authorities)
    }

    /// Open a replay with both detached-key verification and explicit signer
    /// authority. Every governed trust-spine transition must satisfy both checks.
    pub fn open_with_trusted_authorities(
        run_id: &str,
        db_path: impl AsRef<Path>,
        authorities: &TrustedReplayAuthorities,
    ) -> Result<Self, EngineError> {
        Self::open_with_trusted_authorities_limit(run_id, db_path, authorities, None)
    }

    /// Crate-owned bounded open used only by governed recovery. This remains
    /// non-public so a caller cannot choose a partial verified tape boundary
    /// and present it as a trusted recovery view.
    pub(crate) fn open_with_trusted_authorities_bounded(
        run_id: &str,
        db_path: impl AsRef<Path>,
        authorities: &TrustedReplayAuthorities,
        max_events: usize,
    ) -> Result<Self, EngineError> {
        Self::open_with_trusted_authorities_limit(run_id, db_path, authorities, Some(max_events))
    }

    fn open_with_trusted_authorities_limit(
        run_id: &str,
        db_path: impl AsRef<Path>,
        authorities: &TrustedReplayAuthorities,
        max_events: Option<usize>,
    ) -> Result<Self, EngineError> {
        let reader = EventReader::open(run_id, db_path)?;
        let events = match max_events {
            Some(max_events) => {
                reader.all_with_verification_bounded(authorities.trusted_keys(), max_events)?
            }
            None => reader.all_with_verification(authorities.trusted_keys())?,
        };
        let predeclared_governed_runs = authorized_governed_runs(&events, authorities);
        Ok(Self {
            events,
            cursor: 0,
            state: ReplayState::default(),
            authorities: authorities.clone(),
            predeclared_governed_runs,
        })
    }

    pub fn fast_forward_to(&mut self, target: EventId) -> Option<ReplayStep> {
        for step in self.by_ref() {
            if step.event.id == target {
                return Some(step);
            }
        }
        self.state
            .issues
            .push(crate::state::ReplayIssue::TargetNotFound {
                requested: target.to_string(),
            });
        None
    }

    pub fn state(&self) -> &ReplayState {
        &self.state
    }

    pub fn total_events(&self) -> usize {
        self.events.len()
    }

    /// The immutable, signature-verified event snapshot loaded when this
    /// engine opened. Callers may inspect it for read-only integrity checks;
    /// replay progress never removes or mutates these records.
    pub fn verified_events(&self) -> &[VerifiedEvent] {
        &self.events
    }

    /// Exhaust replay without materializing [`ReplayStep`] values. Governed
    /// recovery consumes the whole tape before exposing any state, so cloning
    /// `ReplayState` for each discarded public iterator step is unnecessary.
    pub(crate) fn replay_to_end(&mut self) {
        while self.advance_one().is_some() {}
    }

    fn advance_one(&mut self) -> Option<usize> {
        let index = self.cursor;
        let verified_event = self.events.get(index)?;
        self.cursor += 1;
        let event = &verified_event.event;
        let predeclared_governed_run = self
            .predeclared_governed_runs
            .contains(&event.run_id.to_string());
        if let Some(required_role) =
            required_signer_role(&self.state, event, predeclared_governed_run)
        {
            if verified_event.verification != VerificationStatus::Verified {
                self.state
                    .issues
                    .push(ReplayIssue::UnverifiedTrustSpineEvent {
                        event_id: event.id.clone(),
                        event_kind: event.kind.as_wire().to_string(),
                        verification: verified_event.verification.clone(),
                    });
            } else if let Err(reason) = trust_spine_authorization(
                &event.payload,
                verified_event.signature.as_ref(),
                &self.authorities,
                required_role,
            ) {
                let signer = verified_event
                    .signature
                    .as_ref()
                    .map(|signature| &signature.signer);
                self.state
                    .issues
                    .push(ReplayIssue::UnauthorizedTrustSpineSigner {
                        event_id: event.id.clone(),
                        event_kind: event.kind.as_wire().to_string(),
                        required_role: signer_role_wire(required_role).to_string(),
                        signer_actor_id: signer.map(|value| value.actor_id.clone()),
                        signer_key_id: signer.map(|value| value.key_id.clone()),
                        reason,
                    });
            } else {
                transitions::apply_with_verified_signer(
                    &mut self.state,
                    event,
                    verified_event
                        .signature
                        .as_ref()
                        .map(|signature| &signature.signer),
                );
            }
        } else {
            transitions::apply_with_verified_signer(
                &mut self.state,
                event,
                verified_event
                    .signature
                    .as_ref()
                    .map(|signature| &signature.signer),
            );
        }
        Some(index)
    }
}

impl Iterator for ReplayEngine {
    type Item = ReplayStep;

    fn next(&mut self) -> Option<ReplayStep> {
        let index = self.advance_one()?;
        Some(ReplayStep {
            event: self.events[index].event.clone(),
            state_after: self.state.clone(),
        })
    }
}

/// Find runs whose dispatch authorization is already known from this tape.
/// This is deliberately a read-only authorization pre-scan, not a reducer
/// projection: only an event whose detached signature is both verified and
/// allowed to exercise the kernel role can cause earlier activity brackets to
/// require kernel authority.
fn authorized_governed_runs(
    events: &[VerifiedEvent],
    authorities: &TrustedReplayAuthorities,
) -> BTreeSet<String> {
    events
        .iter()
        .filter(|verified_event| {
            verified_event.verification == VerificationStatus::Verified
                && is_governed_dispatch(&verified_event.event.payload)
                && trust_spine_authorization(
                    &verified_event.event.payload,
                    verified_event.signature.as_ref(),
                    authorities,
                    TrustSpineSignerRole::Kernel,
                )
                .is_ok()
        })
        .map(|verified_event| verified_event.event.run_id.to_string())
        .collect()
}

fn is_governed_dispatch(payload: &Payload) -> bool {
    match payload {
        Payload::DispatchEnvelopeV1(dispatch) => {
            dispatch.trust_tier == bp_ledger::payload::trust_spine::TrustTierV1::Governed
        }
        Payload::DispatchEnvelopeV2(dispatch) => {
            dispatch.body.trust_tier == bp_ledger::payload::trust_spine::TrustTierV1::Governed
        }
        Payload::DispatchEnvelopeV3(dispatch) => {
            dispatch.body.trust_tier == bp_ledger::payload::trust_spine::TrustTierV1::Governed
        }
        Payload::DispatchEnvelopeV4(dispatch) => {
            dispatch.dispatch_v3.body.trust_tier
                == bp_ledger::payload::trust_spine::TrustTierV1::Governed
        }
        _ => false,
    }
}

fn trust_spine_authorization(
    payload: &Payload,
    signature: Option<&EventSignatureV1>,
    authorities: &TrustedReplayAuthorities,
    required_role: TrustSpineSignerRole,
) -> Result<(), String> {
    let Some(signature) = signature else {
        return Err("verified trust-spine event is missing its detached signer record".into());
    };
    if !authorities.permits(required_role, &signature.signer) {
        return Err("detached signer is not authorized for this trust-spine event role".into());
    }
    match payload {
		Payload::DispatchEnvelopeV1(dispatch)
			if dispatch.signature_ref.algorithm != "ed25519"
				|| dispatch.signature_ref.key_id != signature.signer.key_id =>
		{
			Err("dispatch signature_ref algorithm/key_id does not bind the verified detached signer".into())
		}
		Payload::PromotionDecisionRecordedV1(decision)
			if decision.authority != signature.signer.actor_id
				|| decision.decided_by != signature.signer.actor_id =>
		{
			Err("promotion authority and decided_by must equal the verified detached signer actor".into())
		}
		Payload::PromotionExecutionClaimedV1(claim)
			if claim.authority_actor != signature.signer.actor_id =>
		{
			Err("promotion execution claim authority_actor must equal the verified detached kernel signer actor".into())
		}
		Payload::PromotionApprovalRequestedV1(request)
			if request.requested_by != signature.signer.actor_id =>
		{
			Err("promotion approval requested_by must equal the verified detached kernel signer actor".into())
		}
		Payload::PromotionReconciliationResolvedV1(resolution)
			if resolution.authority != signature.signer.actor_id
				|| resolution.resolved_by != signature.signer.actor_id =>
		{
			Err("reconciliation authority and resolved_by must equal the verified detached signer actor".into())
		}
		Payload::WorkflowTimerScheduledV1(timer)
			if timer.scheduled_by != signature.signer.actor_id =>
		{
			Err("workflow timer scheduled_by must equal the verified detached kernel signer actor".into())
		}
		Payload::WorkflowTimerFiredV1(timer)
			if timer.fired_by != signature.signer.actor_id =>
		{
			Err("workflow timer fired_by must equal the verified detached kernel signer actor".into())
		}
		Payload::WorkflowCancellationRequestedV1(cancellation)
			if cancellation.requested_by != signature.signer.actor_id =>
		{
			Err("workflow cancellation requested_by must equal the verified detached authorized signer actor".into())
		}
		Payload::ActionRequestedV2(request)
			if request.authority_actor != signature.signer.actor_id =>
		{
			Err("action request authority_actor must equal the verified detached signer actor".into())
		}
		Payload::ActivityClaimedV1(claim)
			if claim.authority_actor != signature.signer.actor_id =>
		{
			Err("activity claim authority_actor must equal the verified detached claim signer actor".into())
		}
		Payload::ModelActionAuthorizedV1(authorization)
			if authorization.authorization_actor != signature.signer.actor_id =>
		{
			Err("model authorization authorization_actor must equal the verified detached kernel signer actor".into())
		}
		Payload::ModelActionIntentV1(intent)
			if intent.intent_actor != signature.signer.actor_id =>
		{
			Err("model action intent intent_actor must equal the verified detached kernel signer actor".into())
		}
		Payload::ModelActionAuthorizedV2(authorization)
			if authorization.authorization_actor != signature.signer.actor_id =>
		{
			Err("V2 model authorization authorization_actor must equal the verified detached kernel signer actor".into())
		}
		Payload::ActionReceiptRecordedV2(receipt)
			if receipt.authority_actor != signature.signer.actor_id =>
		{
			Err("action receipt authority_actor must equal the verified detached signer actor".into())
		}
		Payload::ReviewVerdictRecordedV2(review)
			if review.reviewer_authority != signature.signer.actor_id =>
		{
			Err("reviewer_authority must equal the verified detached reviewer signer actor".into())
		}
		_ => Ok(()),
	}
}

fn required_signer_role(
    state: &ReplayState,
    event: &Event,
    predeclared_governed_run: bool,
) -> Option<TrustSpineSignerRole> {
    match &event.payload {
        Payload::ActivityStartedV1(activity)
            if transitions::governed_activity_bracketing_is_required_for_run(
                state,
                event,
                &activity.activity_id,
                predeclared_governed_run,
            ) =>
        {
            Some(TrustSpineSignerRole::Kernel)
        }
        Payload::ActivityCompletedV1(activity)
            if transitions::governed_activity_bracketing_is_required_for_run(
                state,
                event,
                &activity.activity_id,
                predeclared_governed_run,
            ) =>
        {
            Some(TrustSpineSignerRole::Kernel)
        }
        Payload::DispatchEnvelopeV1(_)
        | Payload::DispatchEnvelopeV2(_)
        | Payload::DispatchEnvelopeV3(_)
        | Payload::DispatchEnvelopeV4(_)
        | Payload::WorkflowGraphDeclaredV1(_)
        | Payload::WorkflowGraphDeclaredV2(_)
        | Payload::ActionRequestedV2(_)
        | Payload::ActivityClaimedV1(_)
        | Payload::ActivityHeartbeatRecordedV1(_)
        | Payload::ActivityResultRecordedV1(_)
        | Payload::ModelActionIntentV1(_)
        | Payload::ModelActionAuthorizedV1(_)
        | Payload::ModelActionAuthorizedV2(_)
        | Payload::ActionReceiptRecordedV2(_)
        | Payload::ActionReceiptSetRecordedV1(_)
        | Payload::AttemptContextRecordedV1(_)
        | Payload::CandidateCreatedV1(_)
        | Payload::CandidateCreatedV2(_)
        | Payload::CandidateCompletionRecordedV1(_)
        | Payload::CandidateAcceptanceRecordedV1(_)
        | Payload::PromotionApprovalRequestedV1(_)
        | Payload::PromotionExecutionClaimedV1(_)
        | Payload::PromotionResultRecordedV1(_)
        | Payload::WorkflowTimerScheduledV1(_)
        | Payload::WorkflowTimerFiredV1(_)
        | Payload::WorkflowTerminalV1(_)
        | Payload::WorkflowTerminalV2(_) => Some(TrustSpineSignerRole::Kernel),
        Payload::WorkflowCancellationRequestedV1(cancellation) => Some(match cancellation.cause {
            WorkflowCancellationCauseV1::OperatorRequested => TrustSpineSignerRole::Operator,
            WorkflowCancellationCauseV1::TimerElapsed => TrustSpineSignerRole::Kernel,
        }),
        Payload::ReviewVerdictRecordedV1(_) | Payload::ReviewVerdictRecordedV2(_) => {
            Some(TrustSpineSignerRole::Reviewer)
        }
        Payload::PromotionDecisionRecordedV1(_) | Payload::PromotionReconciliationResolvedV1(_) => {
            Some(TrustSpineSignerRole::Operator)
        }
        _ => None,
    }
}

fn signer_role_wire(role: TrustSpineSignerRole) -> &'static str {
    match role {
        TrustSpineSignerRole::Kernel => "kernel",
        TrustSpineSignerRole::Reviewer => "reviewer",
        TrustSpineSignerRole::Operator => "operator",
    }
}
