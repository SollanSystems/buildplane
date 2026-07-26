//! All-or-nothing protected startup composition for governed model sessions.
//!
//! Host state exists only after the fixed public config, retained authority
//! root, broker identity, rootless OCI canary, private signer custody, existing
//! signed ledger, existing CAS, and Anthropic credential deployment all pass.
//! No listener or worker authority is granted by this module.

use crate::anthropic_model_gateway::AnthropicModelGatewayV1;
use crate::confinement::BrokerHostConfinementAttestationV1;
use crate::governed_reviewer_authority::{
    execute_governed_reviewer_run_v1, open_governed_reviewer_session_from_replay_v1,
    OpenedGovernedReviewerSessionV1,
};
use crate::governed_session_client::ParsedGovernedSessionClientRequestV1;
use crate::governed_session_host::{
    handle_governed_session_connection, GovernedSessionHostDispositionV1,
    GovernedSessionHostErrorV1,
};
use crate::governed_session_response::governed_reviewer_run_result_v1;
use crate::governed_session_startup::{
    GovernedSessionHostStartupErrorV1, GovernedSessionHostStartupV1, GovernedSessionProviderLaneV1,
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
    attest_rootless_oci_v1, RootlessOciAttestationV1, RootlessOciStartupErrorV1,
};
use crate::{
    BrokerModelActionRequest, BrokerModelActionStatus, BrokerModelAuthority, LeasePolicy,
    LedgerAuthorityBackend, ReplaySnapshotVerifier, TrustedReplayVerifier,
};
use async_trait::async_trait;
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_ledger::payload::trust_spine::ExecutionRoleV1;
use bp_provider_anthropic::{AnthropicHttpTransportV1, AnthropicProvider};
use bp_provider_sdk::{
    ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse, ProviderTokenCountRequestV1,
    ProviderTokenCounterV1,
};
use std::collections::BTreeSet;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use thiserror::Error;

pub(crate) struct ProtectedGovernedSessionHostStateV1 {
    validated_startup: ValidatedGovernedSessionHostStartupV1,
    session_startup: GovernedSessionHostStartupV1,
    signing_keys: ProtectedGovernedSessionSigningKeysV1,
    ledger: ProtectedPromotionDecisionLedgerV1,
    cas: ProtectedV5CasV1,
    anthropic_provider: ProtectedAnthropicProviderV1,
    provider_runtime: tokio::runtime::Runtime,
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
    ) -> Result<BrokerModelActionStatus, ProtectedGovernedSessionProviderErrorV1> {
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
        let request = BrokerModelActionRequest {
            dispatch_event_id: evidence.reviewer_dispatch_event_ref,
            action_request_event_id: evidence.reviewer_action_request_event_ref,
        };
        match self.prepare_anthropic_provider(request.clone())? {
            ProviderTokenPreflightStatusV1::Recorded => {}
            ProviderTokenPreflightStatusV1::Pending => return Ok(BrokerModelActionStatus::Pending),
            ProviderTokenPreflightStatusV1::Failed => return Ok(BrokerModelActionStatus::Failed),
            ProviderTokenPreflightStatusV1::LeaseExpired => {
                return Ok(BrokerModelActionStatus::LeaseExpired)
            }
            ProviderTokenPreflightStatusV1::ReconciliationRequired => {
                return Ok(BrokerModelActionStatus::ReconciliationRequired)
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
        execute_governed_reviewer_run_v1(
            &execution_snapshot,
            &self.signing_keys.broker_identity().verifying_key(),
            recovery_ref,
            session_ref,
            &mut authority,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)
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
                let status = self
                    .run_reviewer_session(recovery_ref, session_ref)
                    .map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
                Ok(GovernedSessionHostDispositionV1::Completed {
                    recovery_ref: recovery_ref.clone(),
                    session_ref: session_ref.clone(),
                    result: governed_reviewer_run_result_v1(status),
                })
            }
            // Candidate opening and execution remain unavailable until the
            // same protected state owns the OCI candidate action plane.
            ParsedGovernedSessionClientRequestV1::OpenCandidateSession { .. }
            | ParsedGovernedSessionClientRequestV1::OpenRecoverySession { .. }
            | ParsedGovernedSessionClientRequestV1::RunCandidateSession { .. } => {
                Err(GovernedSessionHostErrorV1::AuthorityRejected)
            }
        }
    }

    pub(crate) fn handle_authenticated_connection(
        &self,
        stream: &mut UnixStream,
        expected_client_uid: u32,
        timeout: Duration,
    ) -> Result<(), GovernedSessionHostErrorV1> {
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
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    struct HostFixture {
        anchor: tempfile::TempDir,
        authority_root: PathBuf,
        owner: u32,
        action_seed: [u8; 32],
        claim_seed: [u8; 32],
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
                action_seed: [32; 32],
                claim_seed: [33; 32],
                broker_identity_seed: [34; 32],
            };
            fixture.install();
            fixture
        }

        fn install(&self) {
            self.write_key(
                &["kernel", "model-action"],
                "action-main",
                &self.action_seed,
            );
            self.write_key(&["kernel", "model-claim"], "claim-main", &self.claim_seed);
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
            fs::write(&credential, b"short-lived-host-secret").expect("credential");
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
                "action_request": signer(
                    "kernel:model-action",
                    "action-main",
                    self.action_seed
                ),
                "claim": signer("kernel:model-claim", "claim-main", self.claim_seed),
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
        for missing in ["action-key", "ledger", "cas", "credential"] {
            let fixture = HostFixture::new();
            match missing {
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
    fn protected_connection_authenticates_and_signs_the_closed_probe() {
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
        let verifying_key = state.signing_keys().broker_identity().verifying_key();
        let request = br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000097","operation":"probe"}"#.to_vec();
        let parsed =
            crate::governed_session_client::parse_governed_session_client_request(&request)
                .expect("probe");
        let (mut client, mut server) = UnixStream::pair().expect("socket pair");
        let client_thread = std::thread::spawn(move || {
            client
                .write_all(&(request.len() as u32).to_be_bytes())
                .expect("frame length");
            client.write_all(&request).expect("request");
            client
                .shutdown(std::net::Shutdown::Write)
                .expect("request EOF");
            let mut length = [0_u8; 4];
            client.read_exact(&mut length).expect("response length");
            let mut response = vec![0_u8; u32::from_be_bytes(length) as usize];
            client.read_exact(&mut response).expect("response");
            response
        });

        state
            .handle_authenticated_connection(
                &mut server,
                unsafe { libc::geteuid() },
                Duration::from_secs(2),
            )
            .expect("protected connection");
        let response = client_thread.join().expect("client");
        let verified = crate::governed_session_response::verify_governed_session_response_v1(
            &response,
            &verifying_key,
            &parsed,
        )
        .expect("signed probe");
        assert!(std::str::from_utf8(verified.projection_json())
            .expect("projection")
            .contains(r#""status":"ready""#));
    }
}
