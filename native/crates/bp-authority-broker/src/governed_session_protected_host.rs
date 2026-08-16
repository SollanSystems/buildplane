//! All-or-nothing protected startup composition for governed model sessions.
//!
//! Host state exists only after the fixed public config, retained authority
//! root, broker identity, rootless OCI canary, private signer custody, existing
//! signed ledger, existing CAS, and Anthropic credential deployment all pass.
//! No listener or worker authority is granted by this module.

use crate::anthropic_model_gateway::AnthropicModelGatewayV1;
use crate::candidate_approval::authorize_candidate_approval_v1;
use crate::candidate_repository::verify_governed_repository_binding_v1;
use crate::candidate_workspace::{
    finalize_candidate_workspace_v1, immutable_candidate_artifact_v1_bytes,
    open_candidate_verification_workspace_v1, open_candidate_workspace_v1,
    persist_candidate_packet_source_binding_v1, recover_candidate_packet_source_v1,
    reopen_candidate_workspace_v1, resolve_candidate_target_ref_v1,
};
use crate::command_action::{
    BrokerCommandActionRequest, BrokerCommandActionStatus, BrokerCommandAuthority,
    LedgerV5AcceptanceAuthorityBackend, LedgerV5CommandAuthorityBackend,
};
use crate::confinement::BrokerHostConfinementAttestationV1;
use crate::governed_reviewer_authority::{
    execute_governed_reviewer_run_v1, open_governed_reviewer_session_from_replay_v1,
    OpenedGovernedReviewerSessionV1,
};
use crate::governed_session_client::{CandidateApprovalV1, ParsedGovernedSessionClientRequestV1};
use crate::governed_session_host::{
    handle_governed_session_connection, GovernedSessionHostDispositionV1,
    GovernedSessionHostErrorV1,
};
use crate::governed_session_response::{
    governed_candidate_run_status_v1, governed_reviewer_run_result_v1,
    host_owned_governed_candidate_run_result_v1, host_owned_governed_reviewer_run_result_v1,
    GovernedCandidateReceiptProjectionV1, GovernedReviewReceiptProjectionV1,
};
use crate::governed_session_startup::{
    GovernedSessionHostStartupErrorV1, GovernedSessionHostStartupV1, GovernedSessionProviderLaneV1,
};
use crate::governed_session_token::{
    issue_recovery_token_v1, issue_session_token_v1, parse_untrusted_recovery_token_binding_v1,
    verify_recovery_token_v1, verify_session_token_v1, GovernedSessionKindV1,
};
use crate::host_anthropic_credential_custody::ProtectedAnthropicCredentialBrokerV1;
use crate::host_cas_custody::{
    load_governed_session_cas_v1, ProtectedV5CasLoadError, ProtectedV5CasV1,
};
use crate::host_config_loader::{
    load_default_governed_session_host_config_v1, ProtectedHostConfigReadError,
    ValidatedGovernedSessionHostStartupV1,
};
use crate::host_key_custody::{
    load_governed_session_signing_keys_v1, ProtectedGovernedSessionSigningKeysV1,
    ProtectedHostKeyLoadError,
};
use crate::host_ledger_custody::{
    load_governed_session_ledger_v1, ProtectedHostLedgerLoadError,
    ProtectedPromotionDecisionLedgerV1,
};
use crate::provider_preflight::{
    CasProviderTokenPreflightEvidenceWriterV1, CredentialProviderTokenPreflightGatewayV1,
    LedgerProviderTokenPreflightBackendV1, ProviderTokenPreflightAuthorityV1,
    ProviderTokenPreflightStatusV1,
};
use crate::rootless_oci::{
    attest_rootless_oci_v1, FixedPodmanCommandRunner, RootlessOciAttestationV1,
    RootlessOciCommandGateway, RootlessOciStartupErrorV1,
};
use crate::{
    BrokerModelActionRequest, BrokerModelActionStatus, BrokerModelAuthority, LeasePolicy,
    LedgerAuthorityBackend, ReplaySnapshotVerifier, TrustedReplayVerifier,
};
use async_trait::async_trait;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::governed_packet::GovernedCommandPacketV1;
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_ledger::payload::trust_spine::{CandidateAcceptanceOutcomeV1, ExecutionRoleV1};
use bp_ledger::storage::sqlite::{
    ActivityClaimDispositionV1, ActivityResultDispositionV1,
    GovernedCandidateCompletionDispositionV1, GovernedCommandActionIssueDispositionV1,
    GovernedV5AcceptanceCheckIssueRequestV1, GovernedV5CandidateAcceptanceDispositionV1,
    GovernedV5CandidateAcceptanceRequestV1, GovernedV5CandidateCompletionRequestV1,
    GovernedV5CandidateCreateRequestV1, GovernedV5CandidateFinalizeActionIssueDispositionV1,
    GovernedV5CandidateFinalizeActionIssueRequestV1,
    GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1,
    GovernedV5CandidateFinalizeResultRequestV1, GovernedV5CandidateReceiptSetDispositionV1,
    GovernedV5CandidateReceiptSetRequestV1, GovernedV5CommandActionIssueRequestV1,
    GovernedV5CommandActionReceiptRequestV1, GovernedV5ReviewVerdictFinalizeDispositionV1,
    GovernedV5ReviewVerdictFinalizeRequestV1, ResolveGovernedV5CandidateAuthorityRequestV1,
};
use bp_provider_anthropic::{AnthropicHttpTransportV1, AnthropicProvider};
use bp_provider_sdk::{
    ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse, ProviderTokenCountRequestV1,
    ProviderTokenCounterV1,
};
use std::collections::BTreeSet;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

pub(crate) struct ProtectedGovernedSessionHostStateV1 {
    validated_startup: ValidatedGovernedSessionHostStartupV1,
    session_startup: GovernedSessionHostStartupV1,
    signing_keys: ProtectedGovernedSessionSigningKeysV1,
    ledger: ProtectedPromotionDecisionLedgerV1,
    cas: ProtectedV5CasV1,
    anthropic_provider: ProtectedAnthropicProviderV1,
    provider_runtime: tokio::runtime::Runtime,
}

struct CandidateCommandRunResultV1 {
    status: BrokerCommandActionStatus,
    receipt: Option<GovernedCandidateReceiptProjectionV1>,
}

#[derive(Debug, PartialEq)]
struct ReviewerRunResultV1 {
    status: BrokerModelActionStatus,
    receipt: Option<GovernedReviewReceiptProjectionV1>,
}

#[derive(Clone)]
struct ProtectedAnthropicProviderV1 {
    provider: AnthropicProvider,
    allowed_models: BTreeSet<String>,
    allowed_worker_manifest_digests: BTreeSet<String>,
}

#[async_trait]
impl ProviderTokenCounterV1 for ProtectedAnthropicProviderV1 {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn available(&self) -> Result<bool, ProviderError> {
        ProviderTokenCounterV1::available(&self.provider).await
    }

    async fn count_input_tokens(
        &self,
        request: &ProviderTokenCountRequestV1,
    ) -> Result<u32, ProviderError> {
        if !self.allowed_models.contains(&request.model)
            || !self
                .allowed_worker_manifest_digests
                .contains(&request.worker_manifest_digest)
        {
            return Err(ProviderError::InvalidContract(
                "provider request is outside protected host allowlists".into(),
            ));
        }
        self.provider.count_input_tokens(request).await
    }
}

#[async_trait]
impl ProviderAdapter for ProtectedAnthropicProviderV1 {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn available(&self) -> Result<bool, ProviderError> {
        ProviderAdapter::available(&self.provider).await
    }

    async fn complete(&self, request: &ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        if !self.allowed_models.contains(&request.model)
            || !self
                .allowed_worker_manifest_digests
                .contains(&request.worker_manifest_digest)
        {
            return Err(ProviderError::InvalidContract(
                "provider request is outside protected host allowlists".into(),
            ));
        }
        self.provider.complete(request).await
    }
}

impl ProtectedGovernedSessionHostStateV1 {
    fn open_candidate_session(
        &self,
        packet_source: &str,
        project_root: &str,
        request_id: &str,
        approval: &CandidateApprovalV1,
    ) -> Result<(String, String), ProtectedGovernedSessionProviderErrorV1> {
        let config = self.validated_startup.config();
        let resolved = self
            .ledger
            .store()
            .resolve_governed_v5_candidate_authority_v1(
                &ResolveGovernedV5CandidateAuthorityRequestV1 {
                    run_id: config.run_id,
                    packet_source: packet_source.into(),
                },
                &config.v5_admission_authority,
                &config.activity_authority,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        authorize_candidate_approval_v1(approval, &resolved)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let recovery_ref = issue_recovery_token_v1(
            self.signing_keys.broker_identity(),
            &resolved.run_id.to_string(),
            &resolved.dispatch_event_id.to_string(),
            &resolved.repository_binding_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let verified_recovery = verify_recovery_token_v1(
            &self.signing_keys.broker_identity().verifying_key(),
            &recovery_ref,
            &resolved.repository_binding_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let session_ref = issue_session_token_v1(
            self.signing_keys.broker_identity(),
            GovernedSessionKindV1::Candidate,
            &verified_recovery,
            request_id,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let packet_source_ref = self
            .cas
            .cas()
            .put_canonical_bytes(packet_source.as_bytes())
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        open_candidate_workspace_v1(
            self.validated_startup.authority_root().directory(),
            project_root,
            &resolved,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        persist_candidate_packet_source_binding_v1(
            self.validated_startup.authority_root().directory(),
            &resolved,
            &packet_source_ref.to_cas_ref(),
            packet_source_ref.digest(),
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        self.ledger
            .store()
            .issue_governed_v5_command_action_v1(
                &GovernedV5CommandActionIssueRequestV1 {
                    run_id: resolved.run_id,
                    dispatch_event_id: resolved.dispatch_event_id,
                    admission_event_id: resolved.admission_event_id,
                    packet_source: packet_source.into(),
                },
                self.cas.cas(),
                &config.v5_admission_authority,
                &config.activity_authority,
                self.signing_keys.action_request(),
                &config.action_request_signer,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        Ok((recovery_ref, session_ref))
    }

    fn run_candidate_command(
        &self,
        recovery_ref: &str,
        session_ref: &str,
    ) -> Result<CandidateCommandRunResultV1, ProtectedGovernedSessionProviderErrorV1> {
        let untrusted = parse_untrusted_recovery_token_binding_v1(recovery_ref)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let config = self.validated_startup.config();
        if untrusted.run_id != config.run_id.to_string() {
            return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
        }
        let dispatch_event_id = Uuid::parse_str(&untrusted.candidate_dispatch_event_ref)
            .map(bp_ledger::EventId::from_uuid)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let execution = self
            .ledger
            .store()
            .resolve_governed_v5_candidate_execution_authority_v1(
                config.run_id,
                dispatch_event_id,
                &config.v5_admission_authority,
                &config.activity_authority,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let verified_recovery = verify_recovery_token_v1(
            &self.signing_keys.broker_identity().verifying_key(),
            recovery_ref,
            &execution.candidate.repository_binding_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let verified_session = verify_session_token_v1(
            &self.signing_keys.broker_identity().verifying_key(),
            session_ref,
            GovernedSessionKindV1::Candidate,
            recovery_ref,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        if verified_recovery.run_id() != config.run_id.to_string()
            || verified_recovery.candidate_dispatch_event_ref()
                != execution.candidate.dispatch_event_id.to_string()
            || verified_session.run_id() != verified_recovery.run_id()
            || verified_session.candidate_dispatch_event_ref()
                != verified_recovery.candidate_dispatch_event_ref()
            || execution.candidate.sandbox_profile_digest
                != self.session_startup.sandbox_profile_digest()
        {
            return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
        }
        let workspace = reopen_candidate_workspace_v1(
            self.validated_startup.authority_root().directory(),
            &execution.candidate,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let packet_source = recover_candidate_packet_source_v1(
            self.validated_startup.authority_root().directory(),
            &execution.candidate,
            self.cas.cas(),
        )
        .and_then(|source| {
            String::from_utf8(source).map_err(|_| {
                crate::candidate_workspace::CandidateWorkspaceErrorV1::ReconciliationRequired
            })
        })
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let backend = LedgerV5CommandAuthorityBackend::new(
            self.ledger.store(),
            self.cas.cas(),
            &config.v5_admission_authority,
            &config.activity_authority,
            execution.candidate.admission_event_id,
            self.signing_keys.claim(),
            &config.claim_signer,
        );
        let gateway = RootlessOciCommandGateway::new(
            config.oci_profile.clone(),
            self.session_startup.oci_attestation(),
            &workspace.path,
            self.cas.cas(),
            FixedPodmanCommandRunner,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let mut authority = BrokerCommandAuthority::new(
            config.run_id,
            backend,
            gateway,
            config.model_action_lease_ms,
        );
        let status = authority
            .authorize_and_execute(BrokerCommandActionRequest {
                dispatch_event_id: execution.candidate.dispatch_event_id,
                action_request_event_id: execution.action_request_event_id,
            })
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        if status == BrokerCommandActionStatus::Succeeded {
            self.ledger
                .store()
                .record_succeeded_governed_v5_command_action_receipt_v1(
                    &GovernedV5CommandActionReceiptRequestV1 {
                        run_id: config.run_id,
                        action_request_event_id: execution.action_request_event_id,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    self.signing_keys.action_receipt(),
                    &config.action_receipt_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let finalize_action = self
                .ledger
                .store()
                .issue_governed_v5_candidate_finalize_action_v1(
                    &GovernedV5CandidateFinalizeActionIssueRequestV1 {
                        run_id: config.run_id,
                        process_action_request_event_id: execution.action_request_event_id,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    &config.action_receipt_signer,
                    self.signing_keys.action_request(),
                    &config.action_request_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let finalize_action_event_id = match finalize_action {
                GovernedV5CandidateFinalizeActionIssueDispositionV1::Recorded {
                    action_request_event_id,
                    ..
                }
                | GovernedV5CandidateFinalizeActionIssueDispositionV1::Existing {
                    action_request_event_id,
                    ..
                } => action_request_event_id,
            };
            let finalize_claim = self
                .ledger
                .store()
                .authorize_and_claim_governed_v5_candidate_finalize_v1(
                    &GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1 {
                        run_id: config.run_id,
                        dispatch_event_id: execution.candidate.dispatch_event_id,
                        admission_event_id: execution.candidate.admission_event_id,
                        action_request_event_id: finalize_action_event_id,
                        lease_duration_ms: config.model_action_lease_ms,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    self.signing_keys.claim(),
                    &config.claim_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            match finalize_claim {
                ActivityClaimDispositionV1::Granted { lease_id, .. } => {
                    let result_request = match finalize_candidate_workspace_v1(
                        self.validated_startup.authority_root().directory(),
                        &execution.candidate,
                    ) {
                        Ok(artifact) => {
                            let evidence = immutable_candidate_artifact_v1_bytes(&artifact)
                                .map_err(|_| {
                                    ProtectedGovernedSessionProviderErrorV1::DurableAuthority
                                })?;
                            let evidence_ref =
                                self.cas.cas().put_canonical_bytes(&evidence).map_err(|_| {
                                    ProtectedGovernedSessionProviderErrorV1::DurableAuthority
                                })?;
                            GovernedV5CandidateFinalizeResultRequestV1 {
                                run_id: config.run_id,
                                lease_id,
                                outcome: ActivityResultOutcomeV1::Succeeded,
                                result_digest: Some(artifact.candidate_digest),
                                result_ref: Some(format!("git-ref:{}", artifact.candidate_ref)),
                                evidence_digest: evidence_ref.digest().into(),
                                evidence_ref: evidence_ref.to_cas_ref(),
                            }
                        }
                        Err(_) => {
                            let evidence_ref = self
                                .cas
                                .cas()
                                .put_canonical_bytes(
                                    br#"{"outcome":"unknown","reason":"candidate-finalization-failed"}"#,
                                )
                                .map_err(|_| {
                                    ProtectedGovernedSessionProviderErrorV1::DurableAuthority
                                })?;
                            GovernedV5CandidateFinalizeResultRequestV1 {
                                run_id: config.run_id,
                                lease_id,
                                outcome: ActivityResultOutcomeV1::Unknown,
                                result_digest: None,
                                result_ref: None,
                                evidence_digest: evidence_ref.digest().into(),
                                evidence_ref: evidence_ref.to_cas_ref(),
                            }
                        }
                    };
                    let result_disposition = self
                        .ledger
                        .store()
                        .record_governed_v5_candidate_finalize_result_v1(
                            &result_request,
                            self.cas.cas(),
                            &config.v5_admission_authority,
                            &config.activity_authority,
                            self.signing_keys.claim(),
                            &config.claim_signer,
                        )
                        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                    if !matches!(
                        result_disposition,
                        ActivityResultDispositionV1::Recorded {
                            outcome: ActivityResultOutcomeV1::Succeeded,
                            ..
                        }
                    ) || result_request.outcome != ActivityResultOutcomeV1::Succeeded
                    {
                        return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
                    }
                }
                ActivityClaimDispositionV1::Recorded {
                    outcome: ActivityResultOutcomeV1::Succeeded,
                    ..
                } => {}
                ActivityClaimDispositionV1::Pending { .. }
                | ActivityClaimDispositionV1::Recorded { .. }
                | ActivityClaimDispositionV1::LeaseExpired { .. } => {
                    return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
                }
            }
            let receipt_set_disposition = self
                .ledger
                .store()
                .seal_succeeded_governed_v5_candidate_receipt_set_v1(
                    &GovernedV5CandidateReceiptSetRequestV1 {
                        run_id: config.run_id,
                        process_action_request_event_id: execution.action_request_event_id,
                        finalize_action_request_event_id: finalize_action_event_id,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    self.signing_keys.action_receipt(),
                    &config.action_receipt_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let action_receipt_set_event_id = match receipt_set_disposition {
                GovernedV5CandidateReceiptSetDispositionV1::Recorded {
                    action_receipt_set_event_id,
                    ..
                }
                | GovernedV5CandidateReceiptSetDispositionV1::Existing {
                    action_receipt_set_event_id,
                    ..
                } => action_receipt_set_event_id,
            };
            let candidate_disposition = self
                .ledger
                .store()
                .record_governed_v5_candidate_created_v1(
                    &GovernedV5CandidateCreateRequestV1 {
                        run_id: config.run_id,
                        action_receipt_set_event_id,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    &config.action_receipt_signer,
                    self.signing_keys.candidate_artifact(),
                    &config.candidate_artifact_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let candidate_created_event_id = match candidate_disposition {
                bp_ledger::storage::sqlite::GovernedV5CandidateCreateDispositionV1::Recorded {
                    candidate_created_event_id,
                    ..
                }
                | bp_ledger::storage::sqlite::GovernedV5CandidateCreateDispositionV1::Existing {
                    candidate_created_event_id,
                    ..
                } => candidate_created_event_id,
            };
            let completion_disposition = self
                .ledger
                .store()
                .record_governed_v5_candidate_completion_v1(
                    &GovernedV5CandidateCompletionRequestV1 {
                        run_id: config.run_id,
                        candidate_created_event_id,
                    },
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    &config.action_receipt_signer,
                    self.signing_keys.candidate_artifact(),
                    &config.candidate_artifact_signer,
                    self.signing_keys.checkpoint(),
                    &config.v5_admission_checkpoint_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let candidate_completion_event_id = match completion_disposition {
                GovernedCandidateCompletionDispositionV1::Recorded {
                    candidate_completion_event_id,
                    ..
                }
                | GovernedCandidateCompletionDispositionV1::Existing {
                    candidate_completion_event_id,
                    ..
                } => candidate_completion_event_id,
            };
            let artifact = finalize_candidate_workspace_v1(
                self.validated_startup.authority_root().directory(),
                &execution.candidate,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let verification_workspace = open_candidate_verification_workspace_v1(
                self.validated_startup.authority_root().directory(),
                &execution.candidate,
                &artifact,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let packet = GovernedCommandPacketV1::parse_and_verify(
                &packet_source,
                &execution.candidate.governed_packet_digest,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let acceptance_checks = packet
                .protected_acceptance_checks()
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let mut check_action_request_event_ids = Vec::with_capacity(acceptance_checks.len());
            for (check_index, _) in acceptance_checks.iter().enumerate() {
                let check_index = u32::try_from(check_index)
                    .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                let issued = self
                    .ledger
                    .store()
                    .issue_governed_v5_acceptance_check_action_v1(
                        &GovernedV5AcceptanceCheckIssueRequestV1 {
                            run_id: config.run_id,
                            candidate_completion_event_id,
                            packet_source: packet_source.clone(),
                            check_index,
                        },
                        self.cas.cas(),
                        &config.v5_admission_authority,
                        &config.activity_authority,
                        &config.action_receipt_signer,
                        &config.candidate_artifact_signer,
                        self.signing_keys.action_request(),
                        &config.action_request_signer,
                    )
                    .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                let action_request_event_id = match issued {
                    GovernedCommandActionIssueDispositionV1::Issued {
                        action_request_event_id,
                        ..
                    }
                    | GovernedCommandActionIssueDispositionV1::Existing {
                        action_request_event_id,
                        ..
                    } => action_request_event_id,
                };
                let backend = LedgerV5AcceptanceAuthorityBackend::new(
                    self.ledger.store(),
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    candidate_completion_event_id,
                    execution.candidate.dispatch_event_id,
                    action_request_event_id,
                    packet_source.clone(),
                    check_index,
                    &config.action_receipt_signer,
                    &config.candidate_artifact_signer,
                    self.signing_keys.claim(),
                    &config.claim_signer,
                );
                let gateway = RootlessOciCommandGateway::new_read_only_verifier(
                    config.oci_profile.clone(),
                    self.session_startup.oci_attestation(),
                    &verification_workspace.path,
                    self.cas.cas(),
                    FixedPodmanCommandRunner,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                let mut authority = BrokerCommandAuthority::new(
                    config.run_id,
                    backend,
                    gateway,
                    config.model_action_lease_ms,
                );
                match authority
                    .authorize_and_execute(BrokerCommandActionRequest {
                        dispatch_event_id: execution.candidate.dispatch_event_id,
                        action_request_event_id,
                    })
                    .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?
                {
                    BrokerCommandActionStatus::Succeeded | BrokerCommandActionStatus::Failed => {}
                    BrokerCommandActionStatus::Unknown
                    | BrokerCommandActionStatus::Pending
                    | BrokerCommandActionStatus::LeaseExpired
                    | BrokerCommandActionStatus::ReconciliationRequired => {
                        return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
                    }
                }
                check_action_request_event_ids.push(action_request_event_id);
            }
            let acceptance = self
                .ledger
                .store()
                .record_governed_v5_candidate_acceptance_v1(
                    &GovernedV5CandidateAcceptanceRequestV1 {
                        run_id: config.run_id,
                        candidate_completion_event_id,
                        packet_source: packet_source.clone(),
                        check_action_request_event_ids,
                    },
                    self.cas.cas(),
                    &config.v5_admission_authority,
                    &config.activity_authority,
                    &config.action_receipt_signer,
                    &config.candidate_artifact_signer,
                    self.signing_keys.candidate_acceptance(),
                    &config.candidate_acceptance_signer,
                    self.signing_keys.checkpoint(),
                    &config.v5_admission_checkpoint_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let outcome = match acceptance {
                GovernedV5CandidateAcceptanceDispositionV1::Recorded { outcome, .. }
                | GovernedV5CandidateAcceptanceDispositionV1::Existing { outcome, .. } => outcome,
            };
            return match outcome {
                CandidateAcceptanceOutcomeV1::Passed => {
                    let target_ref = resolve_candidate_target_ref_v1(
                        self.validated_startup.authority_root().directory(),
                        &execution.candidate,
                    )
                    .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                    let resolved = self
                        .ledger
                        .store()
                        .resolve_governed_v5_candidate_receipt_v1(
                            config.run_id,
                            candidate_completion_event_id,
                            &config.v5_admission_authority,
                            &config.activity_authority,
                            &config.action_receipt_signer,
                            &config.candidate_artifact_signer,
                        )
                        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
                    Ok(CandidateCommandRunResultV1 {
                        status: BrokerCommandActionStatus::Succeeded,
                        receipt: Some(GovernedCandidateReceiptProjectionV1 {
                            target_ref,
                            candidate: resolved.candidate,
                            candidate_created_event_ref: resolved
                                .candidate_created_event_id
                                .to_string(),
                            candidate_completion_event_ref: resolved
                                .candidate_completion_event_id
                                .to_string(),
                            candidate_completion_digest: resolved.candidate_completion_digest,
                            tape_root_digest: resolved.tape_root_digest,
                            native_receipt_ref: format!(
                                "signed-event:{}",
                                resolved.candidate_completion_event_id
                            ),
                            native_receipt_digest: resolved.candidate_completion_event_digest,
                            governed_packet_digest: execution
                                .candidate
                                .governed_packet_digest
                                .clone(),
                        }),
                    })
                }
                CandidateAcceptanceOutcomeV1::Rejected => Ok(CandidateCommandRunResultV1 {
                    status: BrokerCommandActionStatus::Failed,
                    receipt: None,
                }),
            };
        }
        Ok(CandidateCommandRunResultV1 {
            status,
            receipt: None,
        })
    }

    fn open_recovery_session(
        &self,
        project_root: &str,
        recovery_ref: &str,
        request_id: &str,
    ) -> Result<String, ProtectedGovernedSessionProviderErrorV1> {
        let untrusted = parse_untrusted_recovery_token_binding_v1(recovery_ref)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let config = self.validated_startup.config();
        if untrusted.run_id != config.run_id.to_string() {
            return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
        }
        let dispatch_event_id = Uuid::parse_str(&untrusted.candidate_dispatch_event_ref)
            .map(bp_ledger::EventId::from_uuid)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let execution = self
            .ledger
            .store()
            .resolve_governed_v5_candidate_execution_authority_v1(
                config.run_id,
                dispatch_event_id,
                &config.v5_admission_authority,
                &config.activity_authority,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let verified_recovery = verify_recovery_token_v1(
            &self.signing_keys.broker_identity().verifying_key(),
            recovery_ref,
            &execution.candidate.repository_binding_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        if verified_recovery.run_id() != config.run_id.to_string()
            || verified_recovery.candidate_dispatch_event_ref()
                != execution.candidate.dispatch_event_id.to_string()
            || execution.candidate.sandbox_profile_digest
                != self.session_startup.sandbox_profile_digest()
        {
            return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
        }
        verify_governed_repository_binding_v1(
            project_root,
            &execution.candidate.repository_binding_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        reopen_candidate_workspace_v1(
            self.validated_startup.authority_root().directory(),
            &execution.candidate,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let packet_source = recover_candidate_packet_source_v1(
            self.validated_startup.authority_root().directory(),
            &execution.candidate,
            self.cas.cas(),
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        GovernedCommandPacketV1::parse_and_verify(
            std::str::from_utf8(&packet_source)
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?,
            &execution.candidate.governed_packet_digest,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        issue_session_token_v1(
            self.signing_keys.broker_identity(),
            GovernedSessionKindV1::Candidate,
            &verified_recovery,
            request_id,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
    }

    pub(crate) fn validated_startup(&self) -> &ValidatedGovernedSessionHostStartupV1 {
        &self.validated_startup
    }

    pub(crate) fn session_startup(&self) -> &GovernedSessionHostStartupV1 {
        &self.session_startup
    }

    pub(crate) fn signing_keys(&self) -> &ProtectedGovernedSessionSigningKeysV1 {
        &self.signing_keys
    }

    pub(crate) fn ledger(&self) -> &ProtectedPromotionDecisionLedgerV1 {
        &self.ledger
    }

    pub(crate) fn cas(&self) -> &ProtectedV5CasV1 {
        &self.cas
    }

    pub(crate) fn anthropic_counter(&self) -> &impl ProviderTokenCounterV1 {
        &self.anthropic_provider
    }

    /// Prepare the separately recorded token-count activity for one exact
    /// signed model action. The caller may name only the dispatch and action
    /// events. Role, provider, model, prompts, manifests, candidate binding,
    /// activity identity, budgets, and evidence are reconstructed from trusted
    /// replay and strict CAS documents inside the protected host.
    pub(crate) fn prepare_anthropic_provider(
        &self,
        request: BrokerModelActionRequest,
    ) -> Result<ProviderTokenPreflightStatusV1, ProtectedGovernedSessionProviderErrorV1> {
        let config = self.validated_startup.config();
        let mut verifier = ReplaySnapshotVerifier::from_prevalidated_startup(
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.claim_signer,
        );
        let binding = verifier
            .verify_exact_action(config.run_id, &request)
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)?;
        if binding.run_id != config.run_id
            || binding.dispatch_event_id != request.dispatch_event_id
            || binding.action_request_event_id != request.action_request_event_id
            || binding.dispatch_role != binding.action_role
            || binding.dispatch_role == ExecutionRoleV1::Candidate
        {
            return Err(ProtectedGovernedSessionProviderErrorV1::TrustedReplay);
        }

        let backend = LedgerProviderTokenPreflightBackendV1::from_prevalidated_startup(
            config.run_id,
            request.dispatch_event_id,
            request.action_request_event_id,
            binding.dispatch_role,
            config.model_action_lease_ms,
            self.ledger.store(),
            self.cas.cas(),
            &config.activity_authority,
            self.signing_keys.action_request(),
            &config.action_request_signer,
            self.signing_keys.claim(),
            &config.claim_signer,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let evidence_writer = CasProviderTokenPreflightEvidenceWriterV1::new(self.cas.cas());
        let gateway = CredentialProviderTokenPreflightGatewayV1::new(
            self.anthropic_provider.clone(),
            evidence_writer,
        );
        let authority =
            ProviderTokenPreflightAuthorityV1::new(config.run_id.to_string(), backend, gateway);
        let mut lane = GovernedSessionProviderLaneV1::from_prevalidated_startup(
            &self.session_startup,
            authority,
        );
        self.provider_runtime
            .block_on(lane.prepare_provider())
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
    }

    pub(crate) fn open_reviewer_session(
        &self,
        recovery_ref: &str,
        request_id: &str,
    ) -> Result<OpenedGovernedReviewerSessionV1, ProtectedGovernedSessionProviderErrorV1> {
        let config = self.validated_startup.config();
        let snapshot = bp_replay::TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &config.run_id.to_string(),
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.claim_signer,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)?;
        open_governed_reviewer_session_from_replay_v1(
            &snapshot,
            self.signing_keys.broker_identity(),
            recovery_ref,
            request_id,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)
    }

    pub(crate) fn run_reviewer_session(
        &self,
        recovery_ref: &str,
        session_ref: &str,
    ) -> Result<ReviewerRunResultV1, ProtectedGovernedSessionProviderErrorV1> {
        let config = self.validated_startup.config();
        let snapshot = bp_replay::TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &config.run_id.to_string(),
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.claim_signer,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)?;
        let evidence = crate::governed_reviewer_authority::resolve_governed_reviewer_run_v1(
            &snapshot,
            &self.signing_keys.broker_identity().verifying_key(),
            recovery_ref,
            session_ref,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)?;
        let candidate_authority = self
            .ledger
            .store()
            .resolve_governed_v5_candidate_execution_authority_v1(
                config.run_id,
                evidence.candidate_dispatch_event_ref,
                &config.v5_admission_authority,
                &config.activity_authority,
            )
            .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let target_ref = resolve_candidate_target_ref_v1(
            self.validated_startup.authority_root().directory(),
            &candidate_authority.candidate,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        let request = BrokerModelActionRequest {
            dispatch_event_id: evidence.reviewer_dispatch_event_ref,
            action_request_event_id: evidence.reviewer_action_request_event_ref,
        };
        match self.prepare_anthropic_provider(request.clone())? {
            ProviderTokenPreflightStatusV1::Recorded => {}
            ProviderTokenPreflightStatusV1::Pending => {
                return Ok(ReviewerRunResultV1 {
                    status: BrokerModelActionStatus::Pending,
                    receipt: None,
                })
            }
            ProviderTokenPreflightStatusV1::Failed => {
                return Ok(ReviewerRunResultV1 {
                    status: BrokerModelActionStatus::Failed,
                    receipt: None,
                })
            }
            ProviderTokenPreflightStatusV1::LeaseExpired => {
                return Ok(ReviewerRunResultV1 {
                    status: BrokerModelActionStatus::LeaseExpired,
                    receipt: None,
                })
            }
            ProviderTokenPreflightStatusV1::ReconciliationRequired => {
                return Ok(ReviewerRunResultV1 {
                    status: BrokerModelActionStatus::ReconciliationRequired,
                    receipt: None,
                })
            }
        }

        let verifier = ReplaySnapshotVerifier::from_prevalidated_startup(
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.claim_signer,
        );
        let backend = LedgerAuthorityBackend::from_prevalidated_startup(
            self.ledger.store(),
            self.cas.cas(),
            &config.activity_authority,
            self.signing_keys.claim(),
            &config.claim_signer,
        );
        let gateway = AnthropicModelGatewayV1::new(
            self.anthropic_provider.clone(),
            self.cas.cas(),
            &self.provider_runtime,
        );
        let mut authority = BrokerModelAuthority::new_for_role(
            config.run_id,
            evidence.execution_role,
            verifier,
            backend,
            gateway,
            LeasePolicy::from_startup_config(config.model_action_lease_ms)
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        // Provider preflight appends to the tape. Reopen the bounded recovery
        // view before crossing the model-effect boundary so a cancellation or
        // authority transition recorded during preflight cannot be hidden by
        // the older snapshot used to resolve the session identity.
        let execution_snapshot = bp_replay::TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &config.run_id.to_string(),
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.claim_signer,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::TrustedReplay)?;
        let status = execute_governed_reviewer_run_v1(
            &execution_snapshot,
            &self.signing_keys.broker_identity().verifying_key(),
            recovery_ref,
            session_ref,
            &mut authority,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
        if status == BrokerModelActionStatus::Recorded {
            let finalized = self
                .ledger
                .store()
                .finalize_governed_v5_review_verdict_v1(
                    &GovernedV5ReviewVerdictFinalizeRequestV1 {
                        run_id: config.run_id,
                        reviewer_action_request_event_id: evidence
                            .reviewer_action_request_event_ref,
                        target_ref,
                    },
                    self.cas.cas(),
                    &config.activity_authority,
                    self.signing_keys.action_receipt(),
                    &config.action_receipt_signer,
                    self.signing_keys.review_verdict(),
                    &config.review_verdict_signer,
                    self.signing_keys.action_request(),
                    &config.action_request_signer,
                    self.signing_keys.checkpoint(),
                    &config.v5_admission_checkpoint_signer,
                )
                .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
            let (receipt, promotion_approval_request_event_ref) = match finalized {
                GovernedV5ReviewVerdictFinalizeDispositionV1::Recorded {
                    receipt,
                    promotion_approval_request_event_id,
                    ..
                }
                | GovernedV5ReviewVerdictFinalizeDispositionV1::Existing {
                    receipt,
                    promotion_approval_request_event_id,
                    ..
                } => (
                    receipt,
                    promotion_approval_request_event_id.map(|event_id| event_id.to_string()),
                ),
            };
            let verdict = receipt.verdict;
            return Ok(ReviewerRunResultV1 {
                status,
                receipt: Some(GovernedReviewReceiptProjectionV1 {
                    candidate_created_event_ref: receipt.candidate_created_event_id.to_string(),
                    candidate_completion_event_ref: receipt
                        .candidate_completion_event_id
                        .to_string(),
                    candidate_digest: receipt.candidate_digest,
                    acceptance_event_ref: receipt.acceptance_event_id.to_string(),
                    acceptance_digest: receipt.acceptance_digest,
                    reviewer_dispatch_event_ref: receipt.reviewer_dispatch_event_id.to_string(),
                    reviewer_dispatch_envelope_digest: receipt.reviewer_dispatch_envelope_digest,
                    review_verdict_event_ref: receipt.review_verdict_event_id.to_string(),
                    promotion_approval_request_event_ref,
                    decision: verdict.decision,
                    findings: verdict.findings,
                    confidence: verdict.confidence,
                    reviewer_manifest_digest: verdict.reviewer_manifest_digest,
                    tape_root_digest: receipt.tape_root_digest,
                    native_receipt_ref: format!("signed-event:{}", receipt.review_verdict_event_id),
                    native_receipt_digest: receipt.review_verdict_event_digest,
                }),
            });
        }
        Ok(ReviewerRunResultV1 {
            status,
            receipt: None,
        })
    }

    fn authorize_client_request(
        &self,
        request: &ParsedGovernedSessionClientRequestV1,
    ) -> Result<GovernedSessionHostDispositionV1, GovernedSessionHostErrorV1> {
        match request {
            ParsedGovernedSessionClientRequestV1::Probe { .. } => {
                Ok(GovernedSessionHostDispositionV1::Ready)
            }
            ParsedGovernedSessionClientRequestV1::OpenReviewerSession {
                request_id,
                recovery_ref,
                ..
            } => {
                let opened = self
                    .open_reviewer_session(recovery_ref, request_id)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                if opened.recovery_ref() != recovery_ref {
                    return Err(GovernedSessionHostErrorV1::AuthorityRejected);
                }
                Ok(GovernedSessionHostDispositionV1::Opened {
                    recovery_ref: opened.recovery_ref().into(),
                    session_ref: opened.session_ref().into(),
                })
            }
            ParsedGovernedSessionClientRequestV1::RunReviewerSession {
                recovery_ref,
                session_ref,
                ..
            } => {
                let outcome = self
                    .run_reviewer_session(recovery_ref, session_ref)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                let result = match outcome.receipt {
                    Some(receipt) => {
                        host_owned_governed_reviewer_run_result_v1(recovery_ref, receipt)
                    }
                    None => governed_reviewer_run_result_v1(outcome.status),
                };
                Ok(GovernedSessionHostDispositionV1::Completed {
                    recovery_ref: recovery_ref.clone(),
                    session_ref: session_ref.clone(),
                    result,
                })
            }
            ParsedGovernedSessionClientRequestV1::OpenCandidateSession {
                request_id,
                packet_source,
                project_root,
                approval,
            } => {
                let (recovery_ref, session_ref) = self
                    .open_candidate_session(packet_source, project_root, request_id, approval)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                Ok(GovernedSessionHostDispositionV1::Opened {
                    recovery_ref,
                    session_ref,
                })
            }
            ParsedGovernedSessionClientRequestV1::RunCandidateSession {
                recovery_ref,
                session_ref,
                ..
            } => {
                let outcome = self
                    .run_candidate_command(recovery_ref, session_ref)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                let result = match outcome.receipt {
                    Some(receipt) => {
                        host_owned_governed_candidate_run_result_v1(recovery_ref, receipt)
                    }
                    None => governed_candidate_run_status_v1(outcome.status),
                };
                Ok(GovernedSessionHostDispositionV1::Completed {
                    recovery_ref: recovery_ref.clone(),
                    session_ref: session_ref.clone(),
                    result,
                })
            }
            ParsedGovernedSessionClientRequestV1::OpenRecoverySession {
                request_id,
                project_root,
                recovery_ref,
            } => {
                let session_ref = self
                    .open_recovery_session(project_root, recovery_ref, request_id)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                Ok(GovernedSessionHostDispositionV1::Opened {
                    recovery_ref: recovery_ref.clone(),
                    session_ref,
                })
            }
        }
    }

    pub(crate) fn handle_authenticated_connection(
        &self,
        stream: &mut UnixStream,
        timeout: Duration,
    ) -> Result<(), GovernedSessionHostErrorV1> {
        let expected_client_uid = self
            .session_startup
            .verified_connected_worker_uid(stream)
            .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
        handle_governed_session_connection(
            stream,
            expected_client_uid,
            self.signing_keys.broker_identity(),
            timeout,
            |request| self.authorize_client_request(request),
        )
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedGovernedSessionProviderErrorV1 {
    #[error("protected governed-session trusted replay rejected provider preparation")]
    TrustedReplay,
    #[error("protected governed-session durable provider authority failed")]
    DurableAuthority,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedGovernedSessionHostStartupErrorV1 {
    #[error("protected governed-session host config is unavailable or invalid")]
    Config,
    #[error("protected governed-session broker identity is invalid")]
    BrokerIdentity,
    #[error("protected governed-session OCI action plane is unavailable or unsafe")]
    Oci,
    #[error("protected governed-session signing authority is unavailable or unsafe")]
    SigningAuthority,
    #[error("protected governed-session ledger is unavailable or unsafe")]
    Ledger,
    #[error("protected governed-session CAS is unavailable or unsafe")]
    Cas,
    #[error("protected governed-session provider credential is unavailable or unsafe")]
    Credential,
    #[error("protected governed-session provider runtime is unavailable")]
    ProviderRuntime,
    #[error("protected governed-session startup proof is invalid")]
    StartupProof,
}

pub(crate) fn load_default_protected_governed_session_host_v1(
) -> Result<ProtectedGovernedSessionHostStateV1, ProtectedGovernedSessionHostStartupErrorV1> {
    let validated_startup = load_default_governed_session_host_config_v1()
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Config)?;
    compose_validated_governed_session_host_v1(validated_startup)
}

pub(crate) fn compose_validated_governed_session_host_v1(
    validated_startup: ValidatedGovernedSessionHostStartupV1,
) -> Result<ProtectedGovernedSessionHostStateV1, ProtectedGovernedSessionHostStartupErrorV1> {
    let confinement_attestation = validated_startup
        .config()
        .confinement_policy
        .attest_current_broker_process()
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::BrokerIdentity)?;
    let oci_attestation = attest_rootless_oci_v1(&validated_startup.config().oci_profile)
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Oci)?;
    compose_prevalidated_governed_session_host_v1(
        validated_startup,
        confinement_attestation,
        oci_attestation,
    )
}

fn compose_prevalidated_governed_session_host_v1(
    validated_startup: ValidatedGovernedSessionHostStartupV1,
    confinement_attestation: BrokerHostConfinementAttestationV1,
    oci_attestation: RootlessOciAttestationV1,
) -> Result<ProtectedGovernedSessionHostStateV1, ProtectedGovernedSessionHostStartupErrorV1> {
    let session_startup = GovernedSessionHostStartupV1::new(
        validated_startup.config().confinement_policy.clone(),
        confinement_attestation,
        oci_attestation,
    )
    .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::StartupProof)?;
    let signing_keys = load_governed_session_signing_keys_v1(&validated_startup)
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::SigningAuthority)?;
    let ledger = load_governed_session_ledger_v1(&validated_startup)
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Ledger)?;
    let cas = load_governed_session_cas_v1(&validated_startup)
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Cas)?;
    let anthropic_credentials =
        ProtectedAnthropicCredentialBrokerV1::from_validated_governed_session_startup(
            &validated_startup,
        )
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Credential)?;
    let anthropic_transport = AnthropicHttpTransportV1::new(anthropic_credentials)
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::Credential)?;
    let allowed_models = validated_startup
        .config()
        .allowed_provider_models
        .iter()
        .filter(|entry| entry.provider == ModelProviderV1::Anthropic)
        .map(|entry| entry.model.clone())
        .collect();
    let allowed_worker_manifest_digests = validated_startup
        .config()
        .allowed_worker_manifest_digests
        .iter()
        .cloned()
        .collect();
    let anthropic_provider = ProtectedAnthropicProviderV1 {
        provider: AnthropicProvider::new(anthropic_transport),
        allowed_models,
        allowed_worker_manifest_digests,
    };
    let provider_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ProtectedGovernedSessionHostStartupErrorV1::ProviderRuntime)?;

    Ok(ProtectedGovernedSessionHostStateV1 {
        validated_startup,
        session_startup,
        signing_keys,
        ledger,
        cas,
        anthropic_provider,
        provider_runtime,
    })
}

impl From<ProtectedHostConfigReadError> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: ProtectedHostConfigReadError) -> Self {
        Self::Config
    }
}

impl From<RootlessOciStartupErrorV1> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: RootlessOciStartupErrorV1) -> Self {
        Self::Oci
    }
}

impl From<GovernedSessionHostStartupErrorV1> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: GovernedSessionHostStartupErrorV1) -> Self {
        Self::StartupProof
    }
}

impl From<ProtectedHostKeyLoadError> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: ProtectedHostKeyLoadError) -> Self {
        Self::SigningAuthority
    }
}

impl From<ProtectedHostLedgerLoadError> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: ProtectedHostLedgerLoadError) -> Self {
        Self::Ledger
    }
}

impl From<ProtectedV5CasLoadError> for ProtectedGovernedSessionHostStartupErrorV1 {
    fn from(_: ProtectedV5CasLoadError) -> Self {
        Self::Cas
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::governed_session_host_config::parse_governed_session_host_config_v1;
    use crate::host_config_loader::validate_governed_session_host_startup_from_trusted_anchor_for_test;
    use bp_ledger::storage::sqlite::SqliteStore;
    use bp_provider_anthropic::AnthropicCredentialBrokerV1;
    use bp_provider_sdk::{provider_response_contract_v1, ProviderExecutionRoleV1};
    use ed25519_dalek::SigningKey;
    use futures::executor::block_on;
    use serde_json::{json, Value};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    struct HostFixture {
        anchor: tempfile::TempDir,
        authority_root: PathBuf,
        owner: u32,
        checkpoint_seed: [u8; 32],
        action_seed: [u8; 32],
        claim_seed: [u8; 32],
        receipt_seed: [u8; 32],
        candidate_seed: [u8; 32],
        acceptance_seed: [u8; 32],
        review_seed: [u8; 32],
        broker_identity_seed: [u8; 32],
    }

    impl HostFixture {
        fn new() -> Self {
            let anchor = tempfile::tempdir().expect("host fixture");
            set_mode(anchor.path(), 0o700);
            let authority_root = anchor.path().join("authority");
            create_private_directory(&authority_root);
            let fixture = Self {
                anchor,
                authority_root,
                owner: unsafe { libc::geteuid() },
                checkpoint_seed: [36; 32],
                action_seed: [32; 32],
                claim_seed: [33; 32],
                receipt_seed: [37; 32],
                candidate_seed: [38; 32],
                acceptance_seed: [39; 32],
                review_seed: [40; 32],
                broker_identity_seed: [34; 32],
            };
            fixture.install();
            fixture
        }

        fn install(&self) {
            self.write_key(
                &["kernel", "v5-admission-checkpoint"],
                "v5-checkpoint-main",
                &self.checkpoint_seed,
            );
            self.write_key(
                &["kernel", "model-action"],
                "action-main",
                &self.action_seed,
            );
            self.write_key(&["kernel", "model-claim"], "claim-main", &self.claim_seed);
            self.write_key(
                &["kernel", "action-receipt"],
                "receipt-main",
                &self.receipt_seed,
            );
            self.write_key(
                &["kernel", "candidate-artifact"],
                "candidate-main",
                &self.candidate_seed,
            );
            self.write_key(
                &["kernel", "candidate-acceptance"],
                "candidate-acceptance-main",
                &self.acceptance_seed,
            );
            self.write_key(
                &["reviewer", "verdict"],
                "review-verdict-main",
                &self.review_seed,
            );
            self.write_key(
                &["broker", "governed-session"],
                "broker-main",
                &self.broker_identity_seed,
            );
            let ledger_directory = self.authority_root.join("ledger");
            create_private_directory(&ledger_directory);
            let database = ledger_directory.join("events.db");
            SqliteStore::open(&database).expect("initialize ledger");
            set_mode(&database, 0o600);
            create_private_directory(&self.authority_root.join("cas"));
            let credential_directory = self.authority_root.join("credentials");
            create_private_directory(&credential_directory);
            let credential = credential_directory.join("anthropic-api-key-v1");
            fs::write(&credential, b"test").expect("credential");
            set_mode(&credential, 0o600);
        }

        fn write_key(&self, actor_components: &[&str], key_id: &str, seed: &[u8]) {
            let mut directory = self.authority_root.join("keys");
            if !directory.exists() {
                create_private_directory(&directory);
            }
            for component in actor_components {
                directory.push(component);
                if !directory.exists() {
                    create_private_directory(&directory);
                }
            }
            let path = directory.join(format!("{key_id}.ed25519"));
            fs::write(&path, seed).expect("signing key");
            set_mode(&path, 0o600);
        }

        fn validated_startup(&self) -> ValidatedGovernedSessionHostStartupV1 {
            let signer = |actor_id: &str, key_id: &str, seed: [u8; 32]| -> Value {
                json!({
                    "actor_id": actor_id,
                    "key_id": key_id,
                    "public_key": SigningKey::from_bytes(&seed)
                        .verifying_key()
                        .to_bytes()
                        .to_vec(),
                })
            };
            let client_uid = if self.owner == 1 { 2 } else { 1 };
            let config = json!({
                "schema_version": 1,
                "run_id": "018f2e40-0000-7000-8000-000000000001",
                "broker_uid": self.owner,
                "governed_session_client_uids": [client_uid],
                "socket_group_gid": 1002,
                "authority_root": self.authority_root.to_string_lossy(),
                "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "model_action_lease_ms": bp_ledger::storage::sqlite::MIN_ACTIVITY_LEASE_MS,
                "allowed_provider_models": [
                    {"provider": "anthropic", "models": ["claude-sonnet-4-5-20250929"]}
                ],
                "allowed_worker_manifest_digests": [
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                ],
                "oci": {
                    "image": "registry.example/buildplane-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    "profile_digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                    "cpu_cores": 2,
                    "memory_bytes": 1073741824,
                    "pids_limit": 128,
                    "tmpfs_bytes": 67108864
                },
                "dispatch": signer("dispatch:governed", "dispatch-main", [31; 32]),
                "v5_admission_record": signer(
                    "kernel:v5-admission",
                    "v5-admission-main",
                    [35; 32]
                ),
                "v5_admission_checkpoint": signer(
                    "kernel:v5-admission-checkpoint",
                    "v5-checkpoint-main",
                    self.checkpoint_seed
                ),
                "action_request": signer(
                    "kernel:model-action",
                    "action-main",
                    self.action_seed
                ),
                "claim": signer("kernel:model-claim", "claim-main", self.claim_seed),
                "action_receipt": signer(
                    "kernel:action-receipt",
                    "receipt-main",
                    self.receipt_seed
                ),
                "candidate_artifact": signer(
                    "kernel:candidate-artifact",
                    "candidate-main",
                    self.candidate_seed
                ),
                "candidate_acceptance": signer(
                    "kernel:candidate-acceptance",
                    "candidate-acceptance-main",
                    self.acceptance_seed
                ),
                "review_verdict": signer(
                    "reviewer:verdict",
                    "review-verdict-main",
                    self.review_seed
                ),
                "broker_identity": signer(
                    "broker:governed-session",
                    "broker-main",
                    self.broker_identity_seed
                ),
            });
            validate_governed_session_host_startup_from_trusted_anchor_for_test(
                parse_governed_session_host_config_v1(&config.to_string())
                    .expect("governed-session config"),
                self.anchor.path(),
                self.owner,
            )
            .expect("validated governed-session startup")
        }
    }

    fn create_private_directory(path: &Path) {
        fs::create_dir(path).expect("private directory");
        set_mode(path, 0o700);
    }

    fn set_mode(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("fixture mode");
    }

    fn oci_attestation() -> RootlessOciAttestationV1 {
        RootlessOciAttestationV1 {
            runtime: "rootless-oci",
            rootless: true,
            read_only_base: true,
            writable_overlay: true,
            network: "none",
            host_fallback: false,
            profile_digest:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                    .into(),
            image: "registry.example/buildplane-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .into(),
        }
    }

    #[test]
    fn composes_all_protected_dependencies_before_host_state_exists() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected governed-session host");

        assert_eq!(
            state.session_startup().sandbox_profile_digest(),
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        );
        assert_eq!(state.signing_keys().checkpoint().to_bytes(), [36; 32]);
        assert_eq!(state.signing_keys().action_request().to_bytes(), [32; 32]);
        assert_eq!(state.signing_keys().claim().to_bytes(), [33; 32]);
        assert_eq!(state.signing_keys().broker_identity().to_bytes(), [34; 32]);
        assert_eq!(state.ledger().store().event_count().expect("ledger"), 0);
        assert!(state
            .cas()
            .cas()
            .get_bytes("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .is_err());
        assert!(block_on(state.anthropic_counter().available()).expect("credential"));
    }

    #[test]
    fn missing_any_protected_dependency_prevents_host_state() {
        for missing in [
            "checkpoint-key",
            "action-key",
            "ledger",
            "cas",
            "credential",
        ] {
            let fixture = HostFixture::new();
            match missing {
                "checkpoint-key" => fs::remove_file(
                    fixture
                        .authority_root
                        .join("keys/kernel/v5-admission-checkpoint/v5-checkpoint-main.ed25519"),
                )
                .expect("remove checkpoint key"),
                "action-key" => fs::remove_file(
                    fixture
                        .authority_root
                        .join("keys/kernel/model-action/action-main.ed25519"),
                )
                .expect("remove action key"),
                "ledger" => fs::remove_file(fixture.authority_root.join("ledger/events.db"))
                    .expect("remove ledger"),
                "cas" => fs::remove_dir(fixture.authority_root.join("cas")).expect("remove CAS"),
                "credential" => fs::remove_file(
                    fixture
                        .authority_root
                        .join("credentials/anthropic-api-key-v1"),
                )
                .expect("remove credential"),
                _ => unreachable!(),
            }
            let validated = fixture.validated_startup();
            let confinement = validated
                .config()
                .confinement_policy
                .attestation_for_same_process_socket_tests();
            assert!(
                compose_prevalidated_governed_session_host_v1(
                    validated,
                    confinement,
                    oci_attestation()
                )
                .is_err(),
                "{missing} must fail closed"
            );
        }
    }

    #[test]
    fn protected_counter_rejects_model_and_worker_manifest_outside_startup_policy() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected host");
        let contract = provider_response_contract_v1(ProviderExecutionRoleV1::Implementer)
            .expect("response contract");
        let mut request = ProviderTokenCountRequestV1 {
            schema_version: 1,
            request_id: "anthropic:workflow:unit:attempt-1:model:provider-token-preflight".into(),
            model: "claude-not-allowed".into(),
            execution_role: ProviderExecutionRoleV1::Implementer,
            system_prompt: None,
            prompt: "bounded prompt".into(),
            response_schema_name: contract.name.into(),
            response_contract_digest: contract.contract_digest,
            response_schema_digest: contract.schema_digest,
            response_schema: contract.schema,
            candidate_digest: None,
            worker_manifest_digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            max_total_tokens: 1_024,
            deadline_unix_ms: i64::MAX,
            tools: vec![],
        };
        assert!(matches!(
            block_on(state.anthropic_counter().count_input_tokens(&request)),
            Err(ProviderError::InvalidContract(_))
        ));

        request.model = "claude-sonnet-4-5-20250929".into();
        request.worker_manifest_digest =
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into();
        assert!(matches!(
            block_on(state.anthropic_counter().count_input_tokens(&request)),
            Err(ProviderError::InvalidContract(_))
        ));
    }

    #[test]
    fn provider_preparation_rejects_unknown_tape_identity_before_gateway_entry() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected host");
        let result = state.prepare_anthropic_provider(BrokerModelActionRequest {
            dispatch_event_id: bp_ledger::EventId::new(),
            action_request_event_id: bp_ledger::EventId::new(),
        });
        assert_eq!(
            result,
            Err(ProtectedGovernedSessionProviderErrorV1::TrustedReplay)
        );
        assert_eq!(state.ledger().store().event_count().expect("ledger"), 0);
    }

    #[test]
    fn reviewer_run_rejects_unknown_session_before_provider_or_ledger_effect() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected host");

        assert_eq!(
            state.run_reviewer_session("recovery://unknown", "session://unknown"),
            Err(ProtectedGovernedSessionProviderErrorV1::TrustedReplay)
        );
        assert_eq!(
            state.ledger().store().event_count().expect("ledger"),
            0,
            "an untrusted session identity must not reach token count, model, or ledger effects"
        );
    }

    #[test]
    fn protected_dispatcher_exposes_probe_but_keeps_candidate_lane_closed() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected host");
        let probe = crate::governed_session_client::parse_governed_session_client_request(
            br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000098","operation":"probe"}"#,
        )
        .expect("probe");
        assert_eq!(
            state.authorize_client_request(&probe),
            Ok(crate::governed_session_host::GovernedSessionHostDispositionV1::Ready)
        );

        let candidate = crate::governed_session_client::parse_governed_session_client_request(
            br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000099","operation":"run_candidate_session","recovery_ref":"recovery:opaque","session_ref":"session:opaque"}"#,
        )
        .expect("candidate request");
        assert_eq!(
            state.authorize_client_request(&candidate),
            Err(crate::governed_session_host::GovernedSessionHostErrorV1::AuthorityRejected)
        );
        assert_eq!(state.ledger().store().event_count().expect("ledger"), 0);
    }

    #[test]
    fn protected_connection_rejects_same_uid_before_parsing_or_signing() {
        let fixture = HostFixture::new();
        let validated = fixture.validated_startup();
        let confinement = validated
            .config()
            .confinement_policy
            .attestation_for_same_process_socket_tests();
        let state = compose_prevalidated_governed_session_host_v1(
            validated,
            confinement,
            oci_attestation(),
        )
        .expect("protected host");
        let (_client, mut server) = UnixStream::pair().expect("socket pair");
        assert_eq!(
            state.handle_authenticated_connection(&mut server, Duration::from_secs(2)),
            Err(GovernedSessionHostErrorV1::ConnectionRejected),
            "the broker UID cannot authenticate itself as a governed-session client"
        );
        assert_eq!(state.ledger().store().event_count().expect("ledger"), 0);
    }

    /// Integration coverage for the candidate-approval guard that
    /// `open_candidate_session` applies to a resolved V5 admission.
    ///
    /// `candidate_approval_contract_tests` already covers the pure decision.
    /// These drive the real protected host, a real file-backed sealed V5
    /// admission, a real repository binding, and a real digest-bound governed
    /// packet, so the *wiring* is pinned rather than the decision alone.
    ///
    /// This module lives inside the host's own test module deliberately:
    /// `open_candidate_session` and `authorize_client_request` are private to
    /// `governed_session_protected_host`, so only a descendant can reach them
    /// without widening production visibility.
    mod candidate_approval_integration {
        use super::*;
        use crate::candidate_repository::{
            canonical_governed_repository_binding_digest_v1,
            compute_governed_repository_binding_v1, governed_git_executable, governed_git_output,
        };
        use crate::v5_dispatch_admission::{
            handle_v5_dispatch_admission_wire, BrokerV5DispatchAdmissionDisposition,
            LedgerV5DispatchAdmissionBackend,
        };
        use bp_ledger::event::Event;
        use bp_ledger::kind::EventKind;
        use bp_ledger::payload::trust_spine::{
            context_manifest_content_v1_digest, dispatch_envelope_v3_body_digest,
            dispatch_envelope_v4_digest, dispatch_envelope_v5_digest,
            sandbox_profile_content_v1_digest, worker_manifest_content_v1_digest,
            workflow_graph_v2_digest, ActionEvidenceVersionV1, CommitModeV1,
            ContextManifestContentV1, ContextManifestDeclaredV1, ContextManifestEntryKindV1,
            ContextManifestEntryV1, ContextTaintV1, ContextTrustLevelV1, DispatchBudgetV1,
            DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5,
            SandboxProfileContentV1, SandboxProfileDeclaredV1, SandboxRuntimeV1, TrustTierV1,
            WorkerHarnessV1, WorkerManifestContentV1, WorkerManifestDeclaredV1, WorkerProviderV1,
            WorkflowGraphDeclaredV2, WorkflowGraphNodeV2,
        };
        use bp_ledger::payload::Payload;
        use bp_ledger::{EventId, RunId};
        use chrono::{DateTime, Duration as ClockDuration, SecondsFormat, Utc};
        use tempfile::TempDir;

        /// The provenance the sealed admission actually carries. Also the
        /// packet's own `provenance_ref` — resolution requires the two to be
        /// equal (`bp-ledger` `sqlite.rs` `verified_governed_command_packet_for_dispatch`).
        const SEALED_PROVENANCE_REF: &str = "01919000-0000-7000-8000-0000000000a1";
        /// A deliberately distinct opaque reference that no admission on the
        /// fixture's tape carries. Kept literally different from
        /// `SEALED_PROVENANCE_REF` so a mismatch assertion cannot pass
        /// vacuously by naming the same string twice.
        const FOREIGN_PROVENANCE_REF: &str = "01919000-0000-7000-8000-0000000000b2";
        const CANDIDATE_UNIT_ID: &str = "unit-candidate-approval";
        const OPEN_REQUEST_ID: &str = "01919000-0000-7000-8000-0000000000d4";

        fn digest(character: char) -> String {
            format!("sha256:{}", character.to_string().repeat(64))
        }

        fn timestamp(value: DateTime<Utc>) -> String {
            value.to_rfc3339_opts(SecondsFormat::Millis, true)
        }

        fn git_ok(repository: &Path, args: &[&str]) -> String {
            let git = governed_git_executable().expect("pinned governed git");
            let output = governed_git_output(&git, repository, args).expect("run governed git");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .expect("utf8 git output")
                .trim()
                .to_owned()
        }

        /// A real, clean git repository whose recomputed governed binding is
        /// what the sealed dispatch will claim. The digest is never invented:
        /// it is read back out of the repository the host will inspect.
        struct CandidateRepositoryFixture {
            repository: TempDir,
            base_commit_sha: String,
            repository_binding_digest: String,
        }

        impl CandidateRepositoryFixture {
            fn new() -> Self {
                let repository = TempDir::new().expect("candidate repository");
                git_ok(repository.path(), &["init", "-b", "main"]);
                git_ok(
                    repository.path(),
                    &[
                        "-c",
                        "user.name=Buildplane",
                        "-c",
                        "user.email=buildplane@example.invalid",
                        "commit",
                        "--allow-empty",
                        "-m",
                        "base",
                    ],
                );
                let base_commit_sha = git_ok(repository.path(), &["rev-parse", "HEAD"]);
                let binding = compute_governed_repository_binding_v1(
                    repository.path().to_str().expect("utf8 repository root"),
                )
                .expect("governed repository binding");
                let repository_binding_digest =
                    canonical_governed_repository_binding_digest_v1(&binding)
                        .expect("repository binding digest");
                Self {
                    repository,
                    base_commit_sha,
                    repository_binding_digest,
                }
            }

            fn project_root(&self) -> String {
                self.repository
                    .path()
                    .to_str()
                    .expect("utf8 repository root")
                    .to_owned()
            }
        }

        struct CandidatePacket {
            source: String,
            canonical_digest: String,
            capability_bundle_digest: String,
            acceptance_contract_digest: String,
        }

        fn candidate_packet_source(capability_bundle_digest: &str) -> String {
            serde_json::to_string(&json!({
                "unit": {
                    "id": CANDIDATE_UNIT_ID,
                    "kind": "implementation",
                    "scope": "task",
                    "verificationContract": "tests pass",
                    "policyProfile": "default"
                },
                "execution_role": "implementer",
                "execution": {
                    "command": "/usr/bin/git",
                    "args": ["status", "--short"],
                    "cwd": "repo"
                },
                "provenance_ref": SEALED_PROVENANCE_REF,
                "capability_bundle": {
                    "schemaVersion": "buildplane.capability_bundle.v0",
                    "bundleId": "candidate-approval-bundle",
                    "fsRead": ["**/*"],
                    "fsWrite": ["**/*"],
                    "netEgress": [],
                    "tools": {
                        "run_command": {
                            "allowlist": ["/usr/bin/git"]
                        }
                    }
                },
                "capability_bundle_digest": capability_bundle_digest,
                "acceptance_contract": {
                    "schemaVersion": 1,
                    "contract_version": "v0",
                    "diff_scope": { "allowed_globs": ["**/*"] },
                    "checks": [{ "command": "git status --short" }]
                },
                "trust_scope": {
                    "schemaVersion": 1,
                    "lane": "governed",
                    "principal": "operator",
                    "scope": "repository"
                }
            }))
            .expect("serialize candidate packet source")
        }

        /// Two-pass digest construction: the capability-bundle digest is a
        /// field of the document that is hashed, so it must be computed from a
        /// placeholder first and then substituted.
        fn candidate_packet() -> CandidatePacket {
            let placeholder = digest('0');
            let preliminary: GovernedCommandPacketV1 =
                serde_json::from_str(&candidate_packet_source(&placeholder))
                    .expect("parse preliminary candidate packet");
            let capability_bundle_digest = preliminary
                .capability_bundle_digest()
                .expect("capability bundle digest");
            let source = candidate_packet_source(&capability_bundle_digest);
            let packet: GovernedCommandPacketV1 =
                serde_json::from_str(&source).expect("parse candidate packet");
            CandidatePacket {
                canonical_digest: packet.canonical_digest().expect("packet canonical digest"),
                acceptance_contract_digest: packet
                    .acceptance_contract_digest()
                    .expect("acceptance contract digest"),
                capability_bundle_digest,
                source,
            }
        }

        struct GovernedCandidateFixture {
            _host: HostFixture,
            _repository: CandidateRepositoryFixture,
            state: ProtectedGovernedSessionHostStateV1,
            project_root: String,
            packet_source: String,
        }

        impl GovernedCandidateFixture {
            fn event_count(&self) -> u64 {
                self.state
                    .ledger()
                    .store()
                    .event_count()
                    .expect("ledger event count")
            }

            fn open(
                &self,
                approval: &CandidateApprovalV1,
            ) -> Result<(String, String), ProtectedGovernedSessionProviderErrorV1> {
                self.state.open_candidate_session(
                    &self.packet_source,
                    &self.project_root,
                    OPEN_REQUEST_ID,
                    approval,
                )
            }

            fn dispatch_open(
                &self,
                approval: CandidateApprovalV1,
            ) -> Result<GovernedSessionHostDispositionV1, GovernedSessionHostErrorV1> {
                self.state.authorize_client_request(
                    &ParsedGovernedSessionClientRequestV1::OpenCandidateSession {
                        request_id: OPEN_REQUEST_ID.into(),
                        packet_source: self.packet_source.clone(),
                        project_root: self.project_root.clone(),
                        approval,
                    },
                )
            }
        }

        /// Compose the protected host, then seal exactly one real V5 admission
        /// on its own file-backed ledger whose signed dispatch binds the
        /// candidate packet and the real repository.
        fn sealed_candidate_fixture() -> GovernedCandidateFixture {
            let host = HostFixture::new();
            let validated = host.validated_startup();
            let confinement = validated
                .config()
                .confinement_policy
                .attestation_for_same_process_socket_tests();
            let state = compose_prevalidated_governed_session_host_v1(
                validated,
                confinement,
                oci_attestation(),
            )
            .expect("protected governed-session host");
            let repository = CandidateRepositoryFixture::new();
            let packet = candidate_packet();
            seal_v5_admission_for_packet(&state, &repository, &packet);
            let project_root = repository.project_root();
            GovernedCandidateFixture {
                _host: host,
                _repository: repository,
                state,
                project_root,
                packet_source: packet.source,
            }
        }

        fn seal_v5_admission_for_packet(
            state: &ProtectedGovernedSessionHostStateV1,
            repository: &CandidateRepositoryFixture,
            packet: &CandidatePacket,
        ) {
            let config = state.validated_startup.config();
            let run_id = config.run_id;
            let now = Utc::now();
            // The host holds neither of these privately; both must match the
            // public keys `HostFixture::validated_startup` pins, or resolution
            // would fail closed for an unrelated reason (untrusted key) and
            // the approval decision would never be reached.
            let dispatch_key = SigningKey::from_bytes(&[31; 32]);
            let admission_key = SigningKey::from_bytes(&[35; 32]);

            let context_manifest = ContextManifestContentV1 {
                entries: vec![ContextManifestEntryV1 {
                    kind: ContextManifestEntryKindV1::RepositoryFile,
                    reference: "repo:AGENTS.md".into(),
                    digest: digest('a'),
                    provenance_ref: "provenance:repository".into(),
                    trust: ContextTrustLevelV1::Verified,
                    taint: ContextTaintV1::Clean,
                }],
            };
            let worker_manifest = WorkerManifestContentV1 {
                provider: WorkerProviderV1::OpenAi,
                model: "gpt-5".into(),
                harness: WorkerHarnessV1::OpenAiApiSdk,
                image_digest: digest('b'),
                tool_manifest_digest: digest('c'),
                skill_manifest_digest: digest('d'),
                capability_bundle_digest: packet.capability_bundle_digest.clone(),
                execution_role: ExecutionRoleV1::Implementer,
            };
            let sandbox_profile = SandboxProfileContentV1 {
                runtime: SandboxRuntimeV1::RootlessOci,
                rootless: true,
                image_digest: worker_manifest.image_digest.clone(),
                read_only_rootfs: true,
                writable_overlay_digest: digest('f'),
                mount_manifest_digest: digest('a'),
                environment_manifest_digest: digest('b'),
                network_policy_digest: digest('c'),
                resource_policy_digest: digest('d'),
                secret_handle_manifest_digest: digest('e'),
            };

            let context_declaration = ContextManifestDeclaredV1 {
                run_id: run_id.to_string(),
                workflow_id: "workflow-candidate-approval".into(),
                workflow_revision: "r1".into(),
                unit_id: CANDIDATE_UNIT_ID.into(),
                attempt: 1,
                provenance_ref: SEALED_PROVENANCE_REF.into(),
                context_manifest_digest: context_manifest_content_v1_digest(&context_manifest)
                    .expect("hash context manifest"),
                context_manifest,
                idempotency_key: "context-manifest:workflow-candidate-approval:unit:1".into(),
                declared_at: timestamp(now),
            };
            let worker_declaration = WorkerManifestDeclaredV1 {
                run_id: run_id.to_string(),
                workflow_id: "workflow-candidate-approval".into(),
                workflow_revision: "r1".into(),
                unit_id: CANDIDATE_UNIT_ID.into(),
                attempt: 1,
                provenance_ref: SEALED_PROVENANCE_REF.into(),
                worker_manifest_digest: worker_manifest_content_v1_digest(&worker_manifest)
                    .expect("hash worker manifest"),
                worker_manifest,
                idempotency_key: "worker-manifest:workflow-candidate-approval:unit:1".into(),
                declared_at: timestamp(now),
            };
            let sandbox_declaration = SandboxProfileDeclaredV1 {
                run_id: run_id.to_string(),
                workflow_id: "workflow-candidate-approval".into(),
                workflow_revision: "r1".into(),
                unit_id: CANDIDATE_UNIT_ID.into(),
                attempt: 1,
                provenance_ref: SEALED_PROVENANCE_REF.into(),
                sandbox_profile_digest: sandbox_profile_content_v1_digest(&sandbox_profile)
                    .expect("hash sandbox profile"),
                sandbox_profile,
                idempotency_key: "sandbox-profile:workflow-candidate-approval:unit:1".into(),
                declared_at: timestamp(now),
            };

            let mut graph = WorkflowGraphDeclaredV2 {
                run_id: run_id.to_string(),
                workflow_id: "workflow-candidate-approval".into(),
                workflow_revision: "r1".into(),
                nodes: vec![WorkflowGraphNodeV2 {
                    unit_id: CANDIDATE_UNIT_ID.into(),
                    depends_on: vec![],
                    execution_role: ExecutionRoleV1::Implementer,
                    governed_packet_digest: packet.canonical_digest.clone(),
                }],
                max_concurrent: 1,
                graph_digest: String::new(),
                idempotency_key: "graph-v2:workflow-candidate-approval:r1".into(),
                declared_at: timestamp(now),
            };
            graph.graph_digest = workflow_graph_v2_digest(&graph).expect("hash workflow graph");

            let graph_event = candidate_event(
                run_id,
                EventKind::WorkflowGraphDeclaredV2,
                Payload::WorkflowGraphDeclaredV2(graph.clone()),
            );
            let context_event = candidate_event(
                run_id,
                EventKind::ContextManifestDeclaredV1,
                Payload::ContextManifestDeclaredV1(context_declaration.clone()),
            );
            let worker_event = candidate_event(
                run_id,
                EventKind::WorkerManifestDeclaredV1,
                Payload::WorkerManifestDeclaredV1(worker_declaration.clone()),
            );
            let sandbox_event = candidate_event(
                run_id,
                EventKind::SandboxProfileDeclaredV1,
                Payload::SandboxProfileDeclaredV1(sandbox_declaration.clone()),
            );

            let body = DispatchEnvelopeBodyV2 {
                workflow_id: "workflow-candidate-approval".into(),
                workflow_revision: "r1".into(),
                unit_id: CANDIDATE_UNIT_ID.into(),
                attempt: 1,
                execution_role: ExecutionRoleV1::Implementer,
                commit_mode: CommitModeV1::Atomic,
                provenance_ref: SEALED_PROVENANCE_REF.into(),
                base_commit_sha: repository.base_commit_sha.clone(),
                capability_bundle_digest: packet.capability_bundle_digest.clone(),
                acceptance_contract_digest: packet.acceptance_contract_digest.clone(),
                context_manifest_digest: context_declaration.context_manifest_digest.clone(),
                worker_manifest_digest: worker_declaration.worker_manifest_digest.clone(),
                sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest.clone(),
                budget: DispatchBudgetV1 {
                    max_tokens: Some(1_024),
                    max_compute_time_ms: Some(600_000),
                },
                trust_tier: TrustTierV1::Governed,
                idempotency_key: "dispatch:workflow-candidate-approval:unit:1".into(),
                issued_at: timestamp(now - ClockDuration::seconds(1)),
                expires_at: timestamp(now + ClockDuration::minutes(10)),
            };
            let dispatch_v3 = DispatchEnvelopeV3 {
                envelope_digest: dispatch_envelope_v3_body_digest(
                    &body,
                    ActionEvidenceVersionV1::SealedV3,
                    &repository.repository_binding_digest,
                    &config.authority_realm_digest,
                    Some(&packet.canonical_digest),
                )
                .expect("hash dispatch V3 layer"),
                body,
                action_evidence_version: ActionEvidenceVersionV1::SealedV3,
                repository_binding_digest: repository.repository_binding_digest.clone(),
                ledger_authority_realm_digest: config.authority_realm_digest.clone(),
                governed_packet_digest: Some(packet.canonical_digest.clone()),
            };
            let dispatch_v4 = DispatchEnvelopeV4 {
                envelope_digest: dispatch_envelope_v4_digest(
                    &dispatch_v3,
                    &graph.graph_digest,
                    &graph_event.id,
                )
                .expect("hash dispatch V4 layer"),
                dispatch_v3,
                workflow_graph_digest: graph.graph_digest,
                workflow_graph_declaration_event_ref: graph_event.id,
            };
            let mut dispatch = DispatchEnvelopeV5 {
                dispatch_v4,
                context_manifest_declaration_event_ref: context_event.id,
                context_manifest_digest: context_declaration.context_manifest_digest,
                worker_manifest_declaration_event_ref: worker_event.id,
                worker_manifest_digest: worker_declaration.worker_manifest_digest,
                sandbox_profile_declaration_event_ref: sandbox_event.id,
                sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest,
                attempt_context_declaration_event_ref: None,
                attempt_context_digest: None,
                envelope_digest: String::new(),
            };
            dispatch.envelope_digest =
                dispatch_envelope_v5_digest(&dispatch).expect("hash V5 envelope");
            let dispatch_event = candidate_event(
                run_id,
                EventKind::DispatchEnvelopeV5,
                Payload::DispatchEnvelopeV5(dispatch.clone()),
            );

            let store = state.ledger().store();
            for event in [
                &graph_event,
                &context_event,
                &worker_event,
                &sandbox_event,
                &dispatch_event,
            ] {
                store
                    .append_signed(event, &dispatch_key, &config.dispatch_signer)
                    .expect("append signed V5 source evidence");
            }

            let backend = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
                store,
                &config.v5_admission_authority,
                &admission_key,
                &config.v5_admission_record_signer,
                state.signing_keys().checkpoint(),
                &config.v5_admission_checkpoint_signer,
            )
            .expect("V5 dispatch admission backend");
            let wire = json!({
                "request_id": "01919000-0000-7000-8000-0000000000c3",
                "run_id": run_id.to_string(),
                "v5_envelope_digest": dispatch.envelope_digest,
            })
            .to_string();
            let disposition = handle_v5_dispatch_admission_wire(&backend, wire.as_bytes())
                .expect("V5 admission wire request");
            assert!(
                matches!(disposition, BrokerV5DispatchAdmissionDisposition::Sealed(_)),
                "the fixture must seal a real V5 admission or every assertion below is vacuous"
            );
        }

        fn candidate_event(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
            Event {
                id: EventId::new(),
                run_id,
                parent_event_id: None,
                schema_version: Event::CURRENT_SCHEMA_VERSION,
                kind,
                occurred_at: Utc::now(),
                payload,
            }
        }

        #[test]
        fn fixture_seals_an_admission_whose_provenance_differs_from_the_foreign_reference() {
            assert_ne!(
                SEALED_PROVENANCE_REF, FOREIGN_PROVENANCE_REF,
                "the mismatch assertions require two genuinely distinct references"
            );
            let fixture = sealed_candidate_fixture();
            assert!(
                fixture.event_count() > 0,
                "a sealed V5 admission must have written signed evidence"
            );
        }

        #[test]
        fn preauthorization_ref_naming_the_sealed_provenance_opens_a_candidate_session() {
            let fixture = sealed_candidate_fixture();
            let (recovery_ref, session_ref) = fixture
                .open(&CandidateApprovalV1::PreauthorizationRef(
                    SEALED_PROVENANCE_REF.into(),
                ))
                .expect("a preauthorization reference naming the sealed provenance must open");
            assert!(!recovery_ref.is_empty());
            assert!(!session_ref.is_empty());
            assert_ne!(recovery_ref, session_ref);
        }

        #[test]
        fn dispatcher_opens_a_candidate_session_for_a_matching_preauthorization_ref() {
            let fixture = sealed_candidate_fixture();
            let disposition = fixture
                .dispatch_open(CandidateApprovalV1::PreauthorizationRef(
                    SEALED_PROVENANCE_REF.into(),
                ))
                .expect("the dispatcher must route a matching preauthorization to the open lane");
            let GovernedSessionHostDispositionV1::Opened {
                recovery_ref,
                session_ref,
            } = disposition
            else {
                panic!("open_candidate_session must dispose as Opened");
            };
            assert!(!recovery_ref.is_empty());
            assert!(!session_ref.is_empty());
        }

        #[test]
        fn dispatcher_rejects_a_mismatched_preauthorization_ref_without_ledger_effect() {
            let fixture = sealed_candidate_fixture();
            let before = fixture.event_count();
            assert_eq!(
                fixture.dispatch_open(CandidateApprovalV1::PreauthorizationRef(
                    FOREIGN_PROVENANCE_REF.into()
                )),
                Err(GovernedSessionHostErrorV1::AuthorityRejected)
            );
            assert_eq!(
                fixture.event_count(),
                before,
                "a refused approval must not reach any ledger effect"
            );
        }

        #[test]
        fn mismatched_preauthorization_ref_is_refused_by_the_host_lane() {
            let fixture = sealed_candidate_fixture();
            let before = fixture.event_count();
            assert_eq!(
                fixture.open(&CandidateApprovalV1::PreauthorizationRef(
                    FOREIGN_PROVENANCE_REF.into()
                )),
                Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
            );
            assert_eq!(fixture.event_count(), before);
        }

        /// The ordering hazard `candidate_approval.rs` documents, pinned in the
        /// wiring rather than in the pure decision: on identical state, the
        /// reference the guard refuses is opened unconditionally by
        /// `OperatorRequested`. So `PreauthorizationRef` grants no capability
        /// that was not already reachable — and tightening `OperatorRequested`
        /// before the broker-side signature check lands must fail here.
        #[test]
        fn operator_requested_opens_the_admission_a_mismatched_reference_cannot() {
            let fixture = sealed_candidate_fixture();
            let before = fixture.event_count();
            assert_eq!(
                fixture.open(&CandidateApprovalV1::PreauthorizationRef(
                    FOREIGN_PROVENANCE_REF.into()
                )),
                Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
            );
            assert_eq!(fixture.event_count(), before);

            let (recovery_ref, session_ref) = fixture
                .open(&CandidateApprovalV1::OperatorRequested)
                .expect("OperatorRequested is unconditional on a resolved admission");
            assert!(!recovery_ref.is_empty());
            assert!(!session_ref.is_empty());
            assert!(
                fixture.event_count() > before,
                "a granted opening must record its command action"
            );
        }

        #[test]
        fn preauthorized_envelope_source_is_refused_end_to_end() {
            let fixture = sealed_candidate_fixture();
            let before = fixture.event_count();
            assert_eq!(
                fixture.open(&CandidateApprovalV1::PreauthorizedEnvelopeSource(
                    SEALED_PROVENANCE_REF.into()
                )),
                Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
            );
            assert_eq!(
                fixture.dispatch_open(CandidateApprovalV1::PreauthorizedEnvelopeSource(
                    SEALED_PROVENANCE_REF.into()
                )),
                Err(GovernedSessionHostErrorV1::AuthorityRejected)
            );
            assert_eq!(
                fixture.event_count(),
                before,
                "an unsupported approval variant must not reach any ledger effect"
            );
        }
    }
}
