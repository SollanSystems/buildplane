//! Broker-private composition for one governed process effect.
//!
//! The ledger is the authority issuer: it reopens signed tape, verifies exact
//! executable CAS bytes, and commits the one purpose-bound lease. This module
//! turns only a fresh grant into a non-cloneable capability, consumes it in a
//! gateway call, and pairs the terminal evidence with the same lease before
//! the result can be recorded. Pending or ambiguous effects never enter the
//! gateway again.

use bp_ledger::error::LedgerError;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::command_evidence::VerifiedCommandIntentEvidenceDocumentV1;
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityResultDispositionV1,
    GovernedCommandActionAuthorizeAndClaimDispositionV1,
    GovernedCommandActionAuthorizeAndClaimRequestV1, GovernedCommandActionResultRequestV1,
    GovernedDispatchV5AdmissionAuthorityV1, GovernedV5CommandActionAuthorizeAndClaimRequestV1,
    SqliteStore,
};
use bp_ledger::storage::Cas;
use bp_ledger::{EventId, RunId};
use ed25519_dalek::SigningKey;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerCommandActionRequest {
    pub(crate) dispatch_event_id: EventId,
    pub(crate) action_request_event_id: EventId,
}

/// One command-effect authority. It cannot be cloned, serialized, or
/// constructed outside this module. The gateway consumes it by value.
pub(crate) struct PrivateCommandCapability {
    run_id: RunId,
    dispatch_event_id: EventId,
    action_request_event_id: EventId,
    lease_id: String,
    lease_expires_at: String,
    command_intent: VerifiedCommandIntentEvidenceDocumentV1,
}

impl PrivateCommandCapability {
    pub(crate) fn command_intent(&self) -> &VerifiedCommandIntentEvidenceDocumentV1 {
        &self.command_intent
    }

    pub(crate) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(crate) fn dispatch_event_id(&self) -> EventId {
        self.dispatch_event_id
    }

    pub(crate) fn action_request_event_id(&self) -> EventId {
        self.action_request_event_id
    }

    pub(crate) fn lease_expires_at(&self) -> &str {
        &self.lease_expires_at
    }

    pub(crate) fn complete(
        self,
        completion: CommandGatewayCompletion,
    ) -> PairedCommandGatewayResult {
        PairedCommandGatewayResult {
            capability: self,
            completion: Some(completion),
        }
    }

    /// Consume a capability whose effect may have occurred but whose terminal
    /// evidence could not be durably materialized. The broker must enter
    /// reconciliation and must not fabricate a result record.
    pub(crate) fn unrecordable(self) -> PairedCommandGatewayResult {
        PairedCommandGatewayResult {
            capability: self,
            completion: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_verified_parts_for_tests(
        run_id: RunId,
        dispatch_event_id: EventId,
        action_request_event_id: EventId,
        lease_id: String,
        lease_expires_at: String,
        command_intent: VerifiedCommandIntentEvidenceDocumentV1,
    ) -> Self {
        Self {
            run_id,
            dispatch_event_id,
            action_request_event_id,
            lease_id,
            lease_expires_at,
            command_intent,
        }
    }
}

/// Closed terminal material created by the OCI gateway. Raw stdout, stderr,
/// environment, and host paths are deliberately absent.
pub(crate) struct CommandGatewayCompletion {
    outcome: ActivityResultOutcomeV1,
    result_digest: Option<String>,
    result_ref: Option<String>,
    evidence_digest: String,
    evidence_ref: String,
}

impl CommandGatewayCompletion {
    pub(crate) fn succeeded(
        result_digest: String,
        result_ref: String,
        evidence_digest: String,
        evidence_ref: String,
    ) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Succeeded,
            result_digest: Some(result_digest),
            result_ref: Some(result_ref),
            evidence_digest,
            evidence_ref,
        }
    }

    pub(crate) fn failed(evidence_digest: String, evidence_ref: String) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Failed,
            result_digest: None,
            result_ref: None,
            evidence_digest,
            evidence_ref,
        }
    }

    /// Any uncertainty after the process boundary is terminal Unknown, never
    /// a retry signal.
    pub(crate) fn unknown(evidence_digest: String, evidence_ref: String) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Unknown,
            result_digest: None,
            result_ref: None,
            evidence_digest,
            evidence_ref,
        }
    }
}

pub(crate) struct PairedCommandGatewayResult {
    capability: PrivateCommandCapability,
    completion: Option<CommandGatewayCompletion>,
}

/// Implemented only by the rootless OCI gateway. There is no ordinary error
/// return after capability receipt: every caught control/runtime ambiguity
/// must be converted to paired Unknown evidence.
pub(crate) trait CommandEffectGateway {
    fn invoke(&mut self, capability: PrivateCommandCapability) -> PairedCommandGatewayResult;
}

pub(crate) trait CommandAuthorityBackend {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerCommandActionRequest,
        lease_duration_ms: u64,
    ) -> Result<CommandAuthorityGrant, CommandAuthorityError>;

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: CommandGatewayCompletion,
    ) -> Result<CommandResultDisposition, CommandAuthorityError>;
}

pub(crate) enum CommandAuthorityGrant {
    Granted {
        run_id: RunId,
        lease_id: String,
        lease_expires_at: String,
        command_intent: VerifiedCommandIntentEvidenceDocumentV1,
    },
    Pending {
        run_id: RunId,
    },
    Recorded {
        run_id: RunId,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        run_id: RunId,
    },
}

pub(crate) enum CommandResultDisposition {
    Recorded {
        run_id: RunId,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        run_id: RunId,
    },
}

#[derive(Debug, Error)]
pub(crate) enum CommandAuthorityError {
    #[error("command authority returned a binding outside the startup-bound run/action")]
    BindingMismatch,
    #[error("durable command authority requires reconciliation")]
    ReconciliationRequired,
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

pub(crate) struct LedgerCommandAuthorityBackend<'a> {
    store: &'a SqliteStore,
    cas: &'a Cas,
    authority: &'a ActivityClaimAuthorityV1,
    signing_key: &'a SigningKey,
    signer: &'a ActorKeyRef,
}

impl<'a> LedgerCommandAuthorityBackend<'a> {
    pub(crate) fn new(
        store: &'a SqliteStore,
        cas: &'a Cas,
        authority: &'a ActivityClaimAuthorityV1,
        signing_key: &'a SigningKey,
        signer: &'a ActorKeyRef,
    ) -> Self {
        Self {
            store,
            cas,
            authority,
            signing_key,
            signer,
        }
    }
}

impl CommandAuthorityBackend for LedgerCommandAuthorityBackend<'_> {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerCommandActionRequest,
        lease_duration_ms: u64,
    ) -> Result<CommandAuthorityGrant, CommandAuthorityError> {
        let disposition = self.store.authorize_and_claim_governed_command_action_v1(
            &GovernedCommandActionAuthorizeAndClaimRequestV1 {
                run_id,
                dispatch_event_id: request.dispatch_event_id,
                action_request_event_id: request.action_request_event_id,
                lease_duration_ms,
            },
            self.cas,
            self.authority,
            self.signing_key,
            self.signer,
        )?;
        Ok(match disposition {
            GovernedCommandActionAuthorizeAndClaimDispositionV1::Granted {
                lease_id,
                lease_expires_at,
                command_intent,
                ..
            } => CommandAuthorityGrant::Granted {
                run_id,
                lease_id,
                lease_expires_at,
                command_intent,
            },
            GovernedCommandActionAuthorizeAndClaimDispositionV1::Pending { .. } => {
                CommandAuthorityGrant::Pending { run_id }
            }
            GovernedCommandActionAuthorizeAndClaimDispositionV1::Recorded { outcome, .. } => {
                CommandAuthorityGrant::Recorded { run_id, outcome }
            }
            GovernedCommandActionAuthorizeAndClaimDispositionV1::LeaseExpired { .. } => {
                CommandAuthorityGrant::LeaseExpired { run_id }
            }
        })
    }

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: CommandGatewayCompletion,
    ) -> Result<CommandResultDisposition, CommandAuthorityError> {
        let disposition = self.store.record_governed_command_action_result_v1(
            &GovernedCommandActionResultRequestV1 {
                run_id,
                lease_id,
                outcome: completion.outcome,
                result_digest: completion.result_digest,
                result_ref: completion.result_ref,
                evidence_digest: completion.evidence_digest,
                evidence_ref: completion.evidence_ref,
            },
            self.authority,
            self.signing_key,
            self.signer,
        )?;
        Ok(match disposition {
            ActivityResultDispositionV1::Recorded { outcome, .. } => {
                CommandResultDisposition::Recorded { run_id, outcome }
            }
            ActivityResultDispositionV1::LeaseExpired { .. } => {
                CommandResultDisposition::LeaseExpired { run_id }
            }
        })
    }
}

/// Protected V5 command backend. The admission receipt identity is bound when
/// the candidate session is opened and cannot be replaced by an individual
/// command request. Both authorization and durable claim creation therefore
/// traverse the ledger's sealed-V5-only entry point.
pub(crate) struct LedgerV5CommandAuthorityBackend<'a> {
    store: &'a SqliteStore,
    cas: &'a Cas,
    v5_authority: &'a GovernedDispatchV5AdmissionAuthorityV1,
    activity_authority: &'a ActivityClaimAuthorityV1,
    admission_event_id: EventId,
    signing_key: &'a SigningKey,
    signer: &'a ActorKeyRef,
}

impl<'a> LedgerV5CommandAuthorityBackend<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        store: &'a SqliteStore,
        cas: &'a Cas,
        v5_authority: &'a GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &'a ActivityClaimAuthorityV1,
        admission_event_id: EventId,
        signing_key: &'a SigningKey,
        signer: &'a ActorKeyRef,
    ) -> Self {
        Self {
            store,
            cas,
            v5_authority,
            activity_authority,
            admission_event_id,
            signing_key,
            signer,
        }
    }
}

impl CommandAuthorityBackend for LedgerV5CommandAuthorityBackend<'_> {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerCommandActionRequest,
        lease_duration_ms: u64,
    ) -> Result<CommandAuthorityGrant, CommandAuthorityError> {
        let disposition = self
            .store
            .authorize_and_claim_governed_v5_command_action_v1(
                &GovernedV5CommandActionAuthorizeAndClaimRequestV1 {
                    run_id,
                    dispatch_event_id: request.dispatch_event_id,
                    admission_event_id: self.admission_event_id,
                    action_request_event_id: request.action_request_event_id,
                    lease_duration_ms,
                },
                self.cas,
                self.v5_authority,
                self.activity_authority,
                self.signing_key,
                self.signer,
            )?;
        Ok(command_grant_from_disposition(run_id, disposition))
    }

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: CommandGatewayCompletion,
    ) -> Result<CommandResultDisposition, CommandAuthorityError> {
        record_command_result(
            self.store,
            self.activity_authority,
            self.signing_key,
            self.signer,
            run_id,
            lease_id,
            completion,
        )
    }
}

fn command_grant_from_disposition(
    run_id: RunId,
    disposition: GovernedCommandActionAuthorizeAndClaimDispositionV1,
) -> CommandAuthorityGrant {
    match disposition {
        GovernedCommandActionAuthorizeAndClaimDispositionV1::Granted {
            lease_id,
            lease_expires_at,
            command_intent,
            ..
        } => CommandAuthorityGrant::Granted {
            run_id,
            lease_id,
            lease_expires_at,
            command_intent,
        },
        GovernedCommandActionAuthorizeAndClaimDispositionV1::Pending { .. } => {
            CommandAuthorityGrant::Pending { run_id }
        }
        GovernedCommandActionAuthorizeAndClaimDispositionV1::Recorded { outcome, .. } => {
            CommandAuthorityGrant::Recorded { run_id, outcome }
        }
        GovernedCommandActionAuthorizeAndClaimDispositionV1::LeaseExpired { .. } => {
            CommandAuthorityGrant::LeaseExpired { run_id }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn record_command_result(
    store: &SqliteStore,
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    run_id: RunId,
    lease_id: String,
    completion: CommandGatewayCompletion,
) -> Result<CommandResultDisposition, CommandAuthorityError> {
    let disposition = store.record_governed_command_action_result_v1(
        &GovernedCommandActionResultRequestV1 {
            run_id,
            lease_id,
            outcome: completion.outcome,
            result_digest: completion.result_digest,
            result_ref: completion.result_ref,
            evidence_digest: completion.evidence_digest,
            evidence_ref: completion.evidence_ref,
        },
        authority,
        signing_key,
        signer,
    )?;
    Ok(match disposition {
        ActivityResultDispositionV1::Recorded { outcome, .. } => {
            CommandResultDisposition::Recorded { run_id, outcome }
        }
        ActivityResultDispositionV1::LeaseExpired { .. } => {
            CommandResultDisposition::LeaseExpired { run_id }
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerCommandActionStatus {
    Succeeded,
    Failed,
    Unknown,
    Pending,
    LeaseExpired,
    ReconciliationRequired,
}

pub(crate) struct BrokerCommandAuthority<B, G> {
    run_id: RunId,
    backend: B,
    gateway: G,
    lease_duration_ms: u64,
}

impl<B, G> BrokerCommandAuthority<B, G>
where
    B: CommandAuthorityBackend,
    G: CommandEffectGateway,
{
    pub(crate) fn new(run_id: RunId, backend: B, gateway: G, lease_duration_ms: u64) -> Self {
        Self {
            run_id,
            backend,
            gateway,
            lease_duration_ms,
        }
    }

    pub(crate) fn authorize_and_execute(
        &mut self,
        request: BrokerCommandActionRequest,
    ) -> Result<BrokerCommandActionStatus, CommandAuthorityError> {
        let grant =
            self.backend
                .authorize_and_claim(self.run_id, &request, self.lease_duration_ms)?;
        let capability = match grant {
            CommandAuthorityGrant::Granted {
                run_id,
                lease_id,
                lease_expires_at,
                command_intent,
            } if run_id == self.run_id => PrivateCommandCapability {
                run_id,
                dispatch_event_id: request.dispatch_event_id,
                action_request_event_id: request.action_request_event_id,
                lease_id,
                lease_expires_at,
                command_intent,
            },
            CommandAuthorityGrant::Pending { run_id } if run_id == self.run_id => {
                return Ok(BrokerCommandActionStatus::Pending);
            }
            CommandAuthorityGrant::Recorded { run_id, outcome } if run_id == self.run_id => {
                return Ok(status_for_outcome(outcome));
            }
            CommandAuthorityGrant::LeaseExpired { run_id } if run_id == self.run_id => {
                return Ok(BrokerCommandActionStatus::LeaseExpired);
            }
            _ => return Err(CommandAuthorityError::BindingMismatch),
        };

        let paired = self.gateway.invoke(capability);
        if paired.capability.run_id != self.run_id
            || paired.capability.dispatch_event_id != request.dispatch_event_id
            || paired.capability.action_request_event_id != request.action_request_event_id
        {
            return Ok(BrokerCommandActionStatus::ReconciliationRequired);
        }
        let Some(completion) = paired.completion else {
            return Ok(BrokerCommandActionStatus::ReconciliationRequired);
        };
        let disposition = match self.backend.record_result(
            paired.capability.run_id,
            paired.capability.lease_id,
            completion,
        ) {
            Ok(disposition) => disposition,
            Err(_) => return Ok(BrokerCommandActionStatus::ReconciliationRequired),
        };
        Ok(match disposition {
            CommandResultDisposition::Recorded { run_id, outcome } if run_id == self.run_id => {
                status_for_outcome(outcome)
            }
            CommandResultDisposition::LeaseExpired { run_id } if run_id == self.run_id => {
                BrokerCommandActionStatus::LeaseExpired
            }
            _ => BrokerCommandActionStatus::ReconciliationRequired,
        })
    }
}

fn status_for_outcome(outcome: ActivityResultOutcomeV1) -> BrokerCommandActionStatus {
    match outcome {
        ActivityResultOutcomeV1::Succeeded => BrokerCommandActionStatus::Succeeded,
        ActivityResultOutcomeV1::Failed => BrokerCommandActionStatus::Failed,
        ActivityResultOutcomeV1::Unknown => BrokerCommandActionStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_ledger::payload::command_evidence::{
        canonical_command_action_input_v1_bytes, command_intent_evidence_document_v1_bytes,
        parse_verified_canonical_command_action_input_v1,
        parse_verified_command_intent_evidence_document_v1, CanonicalCommandActionInputV1,
        CommandActionEvidenceBindingV1, CommandIntentEvidenceDocumentV1,
    };
    use bp_ledger::payload::trust_spine::{ActionKindV1, ActionRequestedV2, ExecutionRoleV1};
    use bp_ledger::storage::Cas;
    use tempfile::tempdir;

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct FakeBackend {
        grant: Option<CommandAuthorityGrant>,
        recorded: Vec<ActivityResultOutcomeV1>,
    }

    impl CommandAuthorityBackend for FakeBackend {
        fn authorize_and_claim(
            &mut self,
            _run_id: RunId,
            _request: &BrokerCommandActionRequest,
            _lease_duration_ms: u64,
        ) -> Result<CommandAuthorityGrant, CommandAuthorityError> {
            self.grant
                .take()
                .ok_or(CommandAuthorityError::ReconciliationRequired)
        }

        fn record_result(
            &mut self,
            run_id: RunId,
            _lease_id: String,
            completion: CommandGatewayCompletion,
        ) -> Result<CommandResultDisposition, CommandAuthorityError> {
            self.recorded.push(completion.outcome);
            Ok(CommandResultDisposition::Recorded {
                run_id,
                outcome: completion.outcome,
            })
        }
    }

    struct FakeGateway {
        invocations: usize,
        expected_command: &'static str,
    }

    impl CommandEffectGateway for FakeGateway {
        fn invoke(&mut self, capability: PrivateCommandCapability) -> PairedCommandGatewayResult {
            self.invocations += 1;
            assert_eq!(
                capability.command_intent().document().command,
                self.expected_command
            );
            capability.complete(CommandGatewayCompletion::succeeded(
                DIGEST.into(),
                format!("cas:{DIGEST}"),
                DIGEST.into(),
                format!("cas:{DIGEST}"),
            ))
        }
    }

    fn verified_intent(
        run_id: RunId,
        dispatch_event_id: EventId,
        action_request_event_id: EventId,
    ) -> VerifiedCommandIntentEvidenceDocumentV1 {
        let directory = tempdir().unwrap();
        let cas = Cas::open(directory.path()).unwrap();
        let input = CanonicalCommandActionInputV1::new(
            run_id.to_string(),
            "action-1".into(),
            "/usr/bin/git".into(),
            vec!["status".into()],
            None,
        )
        .unwrap();
        let input_bytes = canonical_command_action_input_v1_bytes(&input).unwrap();
        let input_ref = cas.put_canonical_bytes(&input_bytes).unwrap();
        let verified_input = parse_verified_canonical_command_action_input_v1(
            &input_bytes,
            &input_ref.to_cas_ref(),
            input_ref.digest(),
        )
        .unwrap();
        let action = ActionRequestedV2 {
            run_id: run_id.to_string(),
            workflow_id: "workflow-1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            provenance_ref: "provenance-1".into(),
            action_id: "action-1".into(),
            idempotency_key: "command:action-1".into(),
            action_kind: ActionKindV1::Process,
            canonical_input_digest: input_ref.digest().into(),
            canonical_input_ref: input_ref.to_cas_ref(),
            dispatch_envelope_digest: DIGEST.into(),
            repository_binding_digest: DIGEST.into(),
            ledger_authority_realm_digest: DIGEST.into(),
            governed_packet_digest: Some(DIGEST.into()),
            capability_bundle_digest: DIGEST.into(),
            policy_digest: DIGEST.into(),
            context_manifest_digest: DIGEST.into(),
            worker_manifest_digest: DIGEST.into(),
            sandbox_profile_digest: DIGEST.into(),
            authority_actor: "broker-1".into(),
            execution_role: ExecutionRoleV1::Implementer,
            requested_at: "2026-07-26T12:00:00Z".into(),
        };
        let binding = CommandActionEvidenceBindingV1::from_action_requested_v2(
            &action,
            dispatch_event_id,
            action_request_event_id,
        )
        .unwrap();
        let intent = CommandIntentEvidenceDocumentV1::from_verified_canonical_input(
            binding,
            &verified_input,
        )
        .unwrap();
        let intent_bytes = command_intent_evidence_document_v1_bytes(&intent).unwrap();
        let intent_ref = cas.put_canonical_bytes(&intent_bytes).unwrap();
        parse_verified_command_intent_evidence_document_v1(
            &intent_bytes,
            &intent_ref.to_cas_ref(),
            intent_ref.digest(),
        )
        .unwrap()
    }

    #[test]
    fn fresh_grant_is_consumed_once_and_paired_with_terminal_recording() {
        let run_id = RunId::new();
        let dispatch_event_id = EventId::new();
        let action_request_event_id = EventId::new();
        let backend = FakeBackend {
            grant: Some(CommandAuthorityGrant::Granted {
                run_id,
                lease_id: "lease-1".into(),
                lease_expires_at: "2099-07-26T12:00:00Z".into(),
                command_intent: verified_intent(run_id, dispatch_event_id, action_request_event_id),
            }),
            recorded: Vec::new(),
        };
        let gateway = FakeGateway {
            invocations: 0,
            expected_command: "/usr/bin/git",
        };
        let mut authority = BrokerCommandAuthority::new(run_id, backend, gateway, 60_000);

        assert_eq!(
            authority
                .authorize_and_execute(BrokerCommandActionRequest {
                    dispatch_event_id,
                    action_request_event_id,
                })
                .unwrap(),
            BrokerCommandActionStatus::Succeeded
        );
        assert_eq!(authority.gateway.invocations, 1);
        assert_eq!(
            authority.backend.recorded,
            [ActivityResultOutcomeV1::Succeeded]
        );
    }

    #[test]
    fn pending_grant_never_enters_the_gateway() {
        let run_id = RunId::new();
        let backend = FakeBackend {
            grant: Some(CommandAuthorityGrant::Pending { run_id }),
            recorded: Vec::new(),
        };
        let gateway = FakeGateway {
            invocations: 0,
            expected_command: "/usr/bin/git",
        };
        let mut authority = BrokerCommandAuthority::new(run_id, backend, gateway, 60_000);

        assert_eq!(
            authority
                .authorize_and_execute(BrokerCommandActionRequest {
                    dispatch_event_id: EventId::new(),
                    action_request_event_id: EventId::new(),
                })
                .unwrap(),
            BrokerCommandActionStatus::Pending
        );
        assert_eq!(authority.gateway.invocations, 0);
    }
}
