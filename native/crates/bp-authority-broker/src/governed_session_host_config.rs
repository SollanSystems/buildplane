//! Closed public configuration for the protected governed-session host.
//!
//! This parser admits only public verification material and fixed policy. It
//! contains no secret bytes, credential path, socket path, ledger path, CAS
//! path, provider endpoint, environment value, or host-shell fallback.

use bp_ledger::keyring::KeyringRef;
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, GovernedDispatchV5AdmissionAuthorityV1, MAX_ACTIVITY_LEASE_MS,
    MIN_ACTIVITY_LEASE_MS,
};
use bp_ledger::RunId;
use bp_replay::{TrustSpineSignerRole, TrustedReplayAuthorities};
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

use crate::confinement::{BrokerAuthorityRoleV1, BrokerHostConfinementPolicyV1};
use crate::rootless_oci::RootlessOciProfileV1;

const KEYRING_VALIDATION_ROOT: &str = "/buildplane-governed-session-config-validation";
const MAX_ALLOWED_PROVIDER_MODELS: usize = 32;
const MAX_ALLOWED_WORKER_MANIFESTS: usize = 32;
const MAX_MODEL_ID_BYTES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AllowedProviderModelV1 {
    pub(crate) provider: ModelProviderV1,
    pub(crate) model: String,
}

#[derive(Debug)]
pub(crate) struct GovernedSessionHostConfigV1 {
    pub(crate) run_id: RunId,
    pub(crate) broker_uid: u32,
    pub(crate) governed_session_client_uids: Vec<u32>,
    pub(crate) socket_group_gid: u32,
    pub(crate) authority_root: PathBuf,
    pub(crate) authority_realm_digest: String,
    pub(crate) model_action_lease_ms: u64,
    pub(crate) allowed_provider_models: Vec<AllowedProviderModelV1>,
    pub(crate) allowed_worker_manifest_digests: Vec<String>,
    pub(crate) dispatch_signer: ActorKeyRef,
    pub(crate) v5_admission_record_signer: ActorKeyRef,
    pub(crate) v5_admission_checkpoint_signer: ActorKeyRef,
    pub(crate) action_request_signer: ActorKeyRef,
    pub(crate) claim_signer: ActorKeyRef,
    pub(crate) action_receipt_signer: ActorKeyRef,
    pub(crate) candidate_artifact_signer: ActorKeyRef,
    pub(crate) candidate_acceptance_signer: ActorKeyRef,
    pub(crate) broker_identity_signer: ActorKeyRef,
    pub(crate) activity_authority: ActivityClaimAuthorityV1,
    pub(crate) v5_admission_authority: GovernedDispatchV5AdmissionAuthorityV1,
    pub(crate) replay_authorities: TrustedReplayAuthorities,
    pub(crate) confinement_policy: BrokerHostConfinementPolicyV1,
    pub(crate) oci_profile: RootlessOciProfileV1,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionHostConfigErrorV1 {
    #[error("protected governed-session host config is invalid")]
    Invalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGovernedSessionHostConfigV1 {
    schema_version: u32,
    run_id: String,
    broker_uid: u32,
    governed_session_client_uids: Vec<u32>,
    socket_group_gid: u32,
    authority_root: String,
    authority_realm_digest: String,
    model_action_lease_ms: u64,
    allowed_provider_models: Vec<RawAllowedProviderModelV1>,
    allowed_worker_manifest_digests: Vec<String>,
    oci: RawOciProfileV1,
    dispatch: RawSignerV1,
    v5_admission_record: RawSignerV1,
    v5_admission_checkpoint: RawSignerV1,
    action_request: RawSignerV1,
    claim: RawSignerV1,
    action_receipt: RawSignerV1,
    candidate_artifact: RawSignerV1,
    candidate_acceptance: RawSignerV1,
    broker_identity: RawSignerV1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAllowedProviderModelV1 {
    provider: RawProviderV1,
    models: Vec<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawProviderV1 {
    Anthropic,
    Openai,
}

impl From<RawProviderV1> for ModelProviderV1 {
    fn from(provider: RawProviderV1) -> Self {
        match provider {
            RawProviderV1::Anthropic => Self::Anthropic,
            RawProviderV1::Openai => Self::Openai,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOciProfileV1 {
    image: String,
    profile_digest: String,
    cpu_cores: u16,
    memory_bytes: u64,
    pids_limit: u32,
    tmpfs_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignerV1 {
    actor_id: String,
    key_id: String,
    public_key: Vec<u8>,
}

struct ParsedSignerV1 {
    identity: ActorKeyRef,
    public_key: Vec<u8>,
}

pub(crate) fn parse_governed_session_host_config_v1(
    json: &str,
) -> Result<GovernedSessionHostConfigV1, GovernedSessionHostConfigErrorV1> {
    let raw: RawGovernedSessionHostConfigV1 =
        serde_json::from_str(json).map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    let run_uuid =
        Uuid::parse_str(&raw.run_id).map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    if raw.schema_version != 1
        || run_uuid.hyphenated().to_string() != raw.run_id
        || run_uuid.get_version_num() != 7
        || raw.broker_uid == 0
        || raw.governed_session_client_uids.is_empty()
        || !is_canonical_digest(&raw.authority_realm_digest)
        || !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&raw.model_action_lease_ms)
    {
        return Err(GovernedSessionHostConfigErrorV1::Invalid);
    }

    let mut client_uids = BTreeSet::new();
    for uid in &raw.governed_session_client_uids {
        if *uid == 0 || *uid == raw.broker_uid || !client_uids.insert(*uid) {
            return Err(GovernedSessionHostConfigErrorV1::Invalid);
        }
    }

    let authority_root = PathBuf::from(raw.authority_root);
    if !is_private_absolute_root(&authority_root) {
        return Err(GovernedSessionHostConfigErrorV1::Invalid);
    }

    let allowed_provider_models = parse_allowed_provider_models(raw.allowed_provider_models)?;
    let allowed_worker_manifest_digests =
        parse_worker_manifest_digests(raw.allowed_worker_manifest_digests)?;

    let dispatch = parse_signer(raw.dispatch)?;
    let v5_admission_record = parse_signer(raw.v5_admission_record)?;
    let v5_admission_checkpoint = parse_signer(raw.v5_admission_checkpoint)?;
    let action_request = parse_signer(raw.action_request)?;
    let claim = parse_signer(raw.claim)?;
    let action_receipt = parse_signer(raw.action_receipt)?;
    let candidate_artifact = parse_signer(raw.candidate_artifact)?;
    let candidate_acceptance = parse_signer(raw.candidate_acceptance)?;
    let broker_identity = parse_signer(raw.broker_identity)?;
    let signers = [
        &dispatch,
        &v5_admission_record,
        &v5_admission_checkpoint,
        &action_request,
        &claim,
        &action_receipt,
        &candidate_artifact,
        &candidate_acceptance,
        &broker_identity,
    ];
    let mut actor_ids = BTreeSet::new();
    let mut signer_identities = BTreeSet::new();
    let mut public_key_hashes = BTreeSet::new();
    let mut trusted_keys = TrustedPublicKeys::default();
    for signer in signers {
        let hash = signer
            .identity
            .public_key_hash
            .clone()
            .ok_or(GovernedSessionHostConfigErrorV1::Invalid)?;
        if !actor_ids.insert(signer.identity.actor_id.clone())
            || !signer_identities.insert((
                signer.identity.actor_id.clone(),
                signer.identity.key_id.clone(),
            ))
            || !public_key_hashes.insert(hash.clone())
        {
            return Err(GovernedSessionHostConfigErrorV1::Invalid);
        }
        trusted_keys.insert_public_key(hash, signer.public_key.clone());
    }

    let dispatch_signer = dispatch.identity;
    let v5_admission_record_signer = v5_admission_record.identity;
    let v5_admission_checkpoint_signer = v5_admission_checkpoint.identity;
    let action_request_signer = action_request.identity;
    let claim_signer = claim.identity;
    let action_receipt_signer = action_receipt.identity;
    let candidate_artifact_signer = candidate_artifact.identity;
    let candidate_acceptance_signer = candidate_acceptance.identity;
    let broker_identity_signer = broker_identity.identity;
    let activity_authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted_keys.clone(),
        dispatch_signer.clone(),
        action_request_signer.clone(),
        claim_signer.clone(),
        raw.authority_realm_digest.clone(),
    )
    .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    let v5_admission_authority = GovernedDispatchV5AdmissionAuthorityV1::new_governed_realm(
        trusted_keys.clone(),
        dispatch_signer.clone(),
        v5_admission_record_signer.clone(),
        v5_admission_checkpoint_signer.clone(),
        raw.authority_realm_digest.clone(),
    )
    .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;

    let mut replay_authorities = TrustedReplayAuthorities::new(trusted_keys);
    for signer in [
        dispatch_signer.clone(),
        v5_admission_record_signer.clone(),
        v5_admission_checkpoint_signer.clone(),
        action_request_signer.clone(),
        claim_signer.clone(),
        action_receipt_signer.clone(),
        candidate_artifact_signer.clone(),
        candidate_acceptance_signer.clone(),
    ] {
        replay_authorities.allow_signer(TrustSpineSignerRole::Kernel, signer);
    }

    let confinement_policy = BrokerHostConfinementPolicyV1::new_for_role(
        raw.broker_uid,
        BrokerAuthorityRoleV1::ModelAction,
        raw.governed_session_client_uids.iter().copied(),
    )
    .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    let oci_profile = RootlessOciProfileV1::new(
        raw.oci.image,
        raw.oci.profile_digest,
        raw.oci.cpu_cores,
        raw.oci.memory_bytes,
        raw.oci.pids_limit,
        raw.oci.tmpfs_bytes,
    )
    .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;

    Ok(GovernedSessionHostConfigV1 {
        run_id: RunId::from_uuid(run_uuid),
        broker_uid: raw.broker_uid,
        governed_session_client_uids: raw.governed_session_client_uids,
        socket_group_gid: raw.socket_group_gid,
        authority_root,
        authority_realm_digest: raw.authority_realm_digest,
        model_action_lease_ms: raw.model_action_lease_ms,
        allowed_provider_models,
        allowed_worker_manifest_digests,
        dispatch_signer,
        v5_admission_record_signer,
        v5_admission_checkpoint_signer,
        action_request_signer,
        claim_signer,
        action_receipt_signer,
        candidate_artifact_signer,
        candidate_acceptance_signer,
        broker_identity_signer,
        activity_authority,
        v5_admission_authority,
        replay_authorities,
        confinement_policy,
        oci_profile,
    })
}

fn parse_allowed_provider_models(
    raw: Vec<RawAllowedProviderModelV1>,
) -> Result<Vec<AllowedProviderModelV1>, GovernedSessionHostConfigErrorV1> {
    if raw.is_empty() {
        return Err(GovernedSessionHostConfigErrorV1::Invalid);
    }
    let mut providers = BTreeSet::new();
    let mut pairs = BTreeSet::new();
    let mut parsed = Vec::new();
    for entry in raw {
        let provider_name = match entry.provider {
            RawProviderV1::Anthropic => "anthropic",
            RawProviderV1::Openai => "openai",
        };
        if entry.models.is_empty() || !providers.insert(provider_name) {
            return Err(GovernedSessionHostConfigErrorV1::Invalid);
        }
        for model in entry.models {
            if !is_canonical_model_id(&model)
                || !pairs.insert((provider_name, model.clone()))
                || parsed.len() == MAX_ALLOWED_PROVIDER_MODELS
            {
                return Err(GovernedSessionHostConfigErrorV1::Invalid);
            }
            parsed.push(AllowedProviderModelV1 {
                provider: entry.provider.into(),
                model,
            });
        }
    }
    Ok(parsed)
}

fn parse_worker_manifest_digests(
    digests: Vec<String>,
) -> Result<Vec<String>, GovernedSessionHostConfigErrorV1> {
    if digests.is_empty() || digests.len() > MAX_ALLOWED_WORKER_MANIFESTS {
        return Err(GovernedSessionHostConfigErrorV1::Invalid);
    }
    let mut unique = BTreeSet::new();
    for digest in &digests {
        if !is_canonical_digest(digest) || !unique.insert(digest.clone()) {
            return Err(GovernedSessionHostConfigErrorV1::Invalid);
        }
    }
    Ok(digests)
}

fn parse_signer(raw: RawSignerV1) -> Result<ParsedSignerV1, GovernedSessionHostConfigErrorV1> {
    let keyring = KeyringRef::new(raw.actor_id, raw.key_id);
    keyring
        .path_under(Path::new(KEYRING_VALIDATION_ROOT))
        .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    let public_key: [u8; 32] = raw
        .public_key
        .as_slice()
        .try_into()
        .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| GovernedSessionHostConfigErrorV1::Invalid)?;
    Ok(ParsedSignerV1 {
        identity: ActorKeyRef {
            actor_id: keyring.actor_id,
            key_id: keyring.key_id,
            public_key_hash: Some(public_key_hash(&verifying_key)),
        },
        public_key: raw.public_key,
    })
}

fn is_private_absolute_root(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path
            .components()
            .all(|component| !matches!(component, Component::CurDir | Component::ParentDir))
}

fn is_canonical_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MODEL_ID_BYTES
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn is_canonical_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::{json, Value};

    fn signer(actor_id: &str, key_id: &str, seed: u8) -> Value {
        json!({
            "actor_id": actor_id,
            "key_id": key_id,
            "public_key": SigningKey::from_bytes(&[seed; 32])
                .verifying_key()
                .to_bytes()
                .to_vec(),
        })
    }

    fn valid_config() -> Value {
        json!({
            "schema_version": 1,
            "run_id": "018f2e40-0000-7000-8000-000000000001",
            "broker_uid": 1000,
            "governed_session_client_uids": [1001],
            "socket_group_gid": 1002,
            "authority_root": "/var/lib/buildplane/governed-session-authority",
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "model_action_lease_ms": MIN_ACTIVITY_LEASE_MS,
            "allowed_provider_models": [
                {"provider": "anthropic", "models": ["claude-sonnet-4-5-20250929"]},
                {"provider": "openai", "models": ["gpt-5.2"]},
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
            "dispatch": signer("dispatch:governed", "dispatch-main", 1),
            "v5_admission_record": signer(
                "kernel:v5-admission",
                "v5-admission-main",
                5
            ),
            "v5_admission_checkpoint": signer(
                "kernel:v5-admission-checkpoint",
                "v5-checkpoint-main",
                6
            ),
            "action_request": signer("kernel:model-action", "action-main", 2),
            "claim": signer("kernel:model-claim", "claim-main", 3),
            "action_receipt": signer("kernel:action-receipt", "receipt-main", 7),
            "candidate_artifact": signer("kernel:candidate-artifact", "candidate-main", 8),
            "candidate_acceptance": signer(
                "kernel:candidate-acceptance",
                "candidate-acceptance-main",
                9
            ),
            "broker_identity": signer("broker:governed-session", "broker-main", 4),
        })
    }

    #[test]
    fn parses_closed_public_policy_into_role_bound_authorities() {
        let config = parse_governed_session_host_config_v1(&valid_config().to_string())
            .expect("valid governed-session config");
        assert_eq!(
            config.run_id.to_string(),
            "018f2e40-0000-7000-8000-000000000001"
        );
        assert_eq!(config.governed_session_client_uids, vec![1001]);
        assert_eq!(config.allowed_provider_models.len(), 2);
        assert_eq!(config.model_action_lease_ms, MIN_ACTIVITY_LEASE_MS);
        assert_ne!(config.dispatch_signer, config.action_request_signer);
        assert_ne!(config.dispatch_signer, config.v5_admission_record_signer);
        assert_ne!(
            config.v5_admission_record_signer,
            config.v5_admission_checkpoint_signer
        );
        assert_ne!(config.action_request_signer, config.claim_signer);
        assert_ne!(config.claim_signer, config.action_receipt_signer);
        assert_ne!(
            config.action_receipt_signer,
            config.candidate_artifact_signer
        );
        assert_ne!(
            config.candidate_artifact_signer,
            config.broker_identity_signer
        );
        assert_ne!(
            config.candidate_artifact_signer,
            config.candidate_acceptance_signer
        );
        assert_ne!(
            config.candidate_acceptance_signer,
            config.v5_admission_checkpoint_signer
        );
        assert_ne!(config.action_receipt_signer, config.broker_identity_signer);
        assert_ne!(config.claim_signer, config.broker_identity_signer);
    }

    #[test]
    fn rejects_unknown_or_secret_and_path_authority_fields() {
        for (field, value) in [
            ("api_key", json!("secret")),
            ("credential_path", json!("/tmp/key")),
            ("socket_path", json!("/tmp/socket")),
            ("ledger_path", json!("/tmp/events.db")),
            ("cas_root", json!("/tmp/cas")),
            ("provider_endpoint", json!("https://attacker.invalid")),
            ("host_shell_fallback", json!(true)),
        ] {
            let mut config = valid_config();
            config[field] = value;
            assert!(
                parse_governed_session_host_config_v1(&config.to_string()).is_err(),
                "{field} must not be admitted"
            );
        }
    }

    #[test]
    fn rejects_identity_key_uid_lease_and_authority_aliases() {
        let mut duplicate_uid = valid_config();
        duplicate_uid["governed_session_client_uids"] = json!([1001, 1001]);
        assert!(parse_governed_session_host_config_v1(&duplicate_uid.to_string()).is_err());

        let mut same_uid = valid_config();
        same_uid["governed_session_client_uids"] = json!([1000]);
        assert!(parse_governed_session_host_config_v1(&same_uid.to_string()).is_err());

        let mut lease = valid_config();
        lease["model_action_lease_ms"] = json!(MIN_ACTIVITY_LEASE_MS - 1);
        assert!(parse_governed_session_host_config_v1(&lease.to_string()).is_err());

        for (left, right) in [
            ("dispatch", "v5_admission_record"),
            ("dispatch", "v5_admission_checkpoint"),
            ("dispatch", "action_request"),
            ("dispatch", "claim"),
            ("v5_admission_record", "v5_admission_checkpoint"),
            ("v5_admission_record", "action_request"),
            ("v5_admission_record", "claim"),
            ("v5_admission_record", "broker_identity"),
            ("v5_admission_checkpoint", "action_request"),
            ("v5_admission_checkpoint", "claim"),
            ("v5_admission_checkpoint", "broker_identity"),
            ("action_request", "claim"),
            ("action_request", "action_receipt"),
            ("claim", "action_receipt"),
            ("action_receipt", "candidate_artifact"),
            ("candidate_artifact", "candidate_acceptance"),
            ("candidate_acceptance", "v5_admission_checkpoint"),
            ("candidate_acceptance", "action_request"),
            ("candidate_acceptance", "claim"),
            ("candidate_acceptance", "action_receipt"),
            ("candidate_acceptance", "broker_identity"),
            ("claim", "candidate_artifact"),
            ("action_request", "candidate_artifact"),
            ("dispatch", "candidate_artifact"),
            ("candidate_artifact", "broker_identity"),
            ("action_receipt", "broker_identity"),
            ("dispatch", "broker_identity"),
            ("action_request", "broker_identity"),
            ("claim", "broker_identity"),
        ] {
            let mut actor_alias = valid_config();
            actor_alias[right]["actor_id"] = actor_alias[left]["actor_id"].clone();
            assert!(parse_governed_session_host_config_v1(&actor_alias.to_string()).is_err());

            let mut key_alias = valid_config();
            key_alias[right]["public_key"] = key_alias[left]["public_key"].clone();
            assert!(parse_governed_session_host_config_v1(&key_alias.to_string()).is_err());
        }
    }

    #[test]
    fn rejects_unknown_duplicate_or_unsafe_provider_worker_and_oci_policy() {
        let mut unknown_provider = valid_config();
        unknown_provider["allowed_provider_models"][0]["provider"] = json!("ambient_cli");
        assert!(parse_governed_session_host_config_v1(&unknown_provider.to_string()).is_err());

        let mut duplicate_provider = valid_config();
        duplicate_provider["allowed_provider_models"]
            .as_array_mut()
            .expect("providers")
            .push(json!({"provider": "anthropic", "models": ["claude-opus-4-1"]}));
        assert!(parse_governed_session_host_config_v1(&duplicate_provider.to_string()).is_err());

        let mut unsafe_model = valid_config();
        unsafe_model["allowed_provider_models"][0]["models"] = json!(["claude model"]);
        assert!(parse_governed_session_host_config_v1(&unsafe_model.to_string()).is_err());

        let mut duplicate_worker = valid_config();
        let digest = duplicate_worker["allowed_worker_manifest_digests"][0].clone();
        duplicate_worker["allowed_worker_manifest_digests"]
            .as_array_mut()
            .expect("worker digests")
            .push(digest);
        assert!(parse_governed_session_host_config_v1(&duplicate_worker.to_string()).is_err());

        let mut unpinned_image = valid_config();
        unpinned_image["oci"]["image"] = json!("registry.example/buildplane-worker:latest");
        assert!(parse_governed_session_host_config_v1(&unpinned_image.to_string()).is_err());
    }
}
