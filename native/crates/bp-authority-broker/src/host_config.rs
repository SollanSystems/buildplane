//! Pure parsing and validation for the future Linux promotion-decision host.
//!
//! This module deliberately does not open a config file or inspect a deployment
//! path, file owner, group, mode, or symlink. The future host must perform those
//! OS-bound checks before passing the already-read JSON bytes to this pure core.

use bp_ledger::keyring::KeyringRef;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::GovernedPromotionAuthorityV1;
use bp_ledger::RunId;
use bp_replay::engine::{TrustSpineSignerRole, TrustedReplayAuthorities};
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

const HOST_CONFIG_SCHEMA_VERSION_V1: u32 = 1;
const KEYRING_VALIDATION_ROOT: &str = "/buildplane-host-config-validation";

/// Public-only startup state derived from a validated V1 host config.
///
/// This intentionally contains neither a private key, seed, nor a keyring
/// path. The later Linux host will bind this public authority state to its
/// separately validated, deployment-owned files.
#[derive(Debug)]
pub(crate) struct PromotionDecisionHostConfigV1 {
    pub(crate) run_id: RunId,
    pub(crate) broker_uid: u32,
    pub(crate) promotion_decision_client_uids: Vec<u32>,
    pub(crate) socket_group_gid: u32,
    pub(crate) authority_root: PathBuf,
    pub(crate) authority_realm_digest: String,
    pub(crate) kernel_signer: ActorKeyRef,
    pub(crate) operator_signer: ActorKeyRef,
    pub(crate) reviewer_signers: Vec<ActorKeyRef>,
    pub(crate) promotion_authority: GovernedPromotionAuthorityV1,
    pub(crate) replay_authorities: TrustedReplayAuthorities,
}

#[derive(Debug, Error)]
pub(crate) enum PromotionDecisionHostConfigError {
    #[error("promotion-decision host config is not valid JSON")]
    Json(#[from] serde_json::Error),
    #[error("promotion-decision host config schema_version must be 1")]
    UnsupportedSchemaVersion,
    #[error("promotion-decision host config run_id must be a canonical lower-hyphen UUIDv7")]
    InvalidRunId,
    #[error("promotion-decision host config does not allow UID 0 for broker or client identities")]
    UidZeroNotAllowed { uid: u32 },
    #[error("promotion-decision host config requires at least one client UID")]
    NoPromotionDecisionClientUids,
    #[error("promotion-decision host config client UIDs must be distinct")]
    DuplicatePromotionDecisionClientUid,
    #[error("promotion-decision host config client UIDs must differ from the broker UID")]
    ClientUidAliasesBroker,
    #[error("promotion-decision host config authority_root must be an absolute normalized path")]
    InvalidAuthorityRoot,
    #[error("promotion-decision host config authority_realm_digest must be canonical sha256")]
    InvalidAuthorityRealmDigest,
    #[error("promotion-decision host config {role} signer actor_id/key_id is invalid")]
    InvalidSignerId { role: String },
    #[error("promotion-decision host config {role} signer public_key must be valid Ed25519 bytes")]
    InvalidSignerPublicKey { role: String },
    #[error("promotion-decision host config signers cannot form a governed promotion authority")]
    InvalidGovernedAuthority,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPromotionDecisionHostConfigV1 {
    schema_version: u32,
    run_id: String,
    broker_uid: u32,
    promotion_decision_client_uids: Vec<u32>,
    socket_group_gid: u32,
    authority_root: String,
    authority_realm_digest: String,
    kernel: RawSignerDescriptorV1,
    operator: RawSignerDescriptorV1,
    reviewers: Vec<RawSignerDescriptorV1>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignerDescriptorV1 {
    actor_id: String,
    key_id: String,
    public_key: Vec<u8>,
}

struct ParsedSignerDescriptor {
    signer: ActorKeyRef,
    public_key: Vec<u8>,
}

/// Parse an already-read V1 JSON config into trusted, role-bound public state.
///
/// This is deliberately a pure core: it validates the configuration shape and
/// values only. It does not load keys, create a listener, or verify the file
/// system deployment path or ownership of any config/key material.
pub(crate) fn parse_promotion_decision_host_config(
    json: &str,
) -> Result<PromotionDecisionHostConfigV1, PromotionDecisionHostConfigError> {
    let raw: RawPromotionDecisionHostConfigV1 = serde_json::from_str(json)?;
    if raw.schema_version != HOST_CONFIG_SCHEMA_VERSION_V1 {
        return Err(PromotionDecisionHostConfigError::UnsupportedSchemaVersion);
    }

    let run_id = parse_canonical_uuidv7(&raw.run_id)?;
    if raw.broker_uid == 0 {
        return Err(PromotionDecisionHostConfigError::UidZeroNotAllowed {
            uid: raw.broker_uid,
        });
    }
    let promotion_decision_client_uids =
        validate_client_uids(raw.broker_uid, raw.promotion_decision_client_uids)?;
    let authority_root = validate_authority_root(raw.authority_root)?;
    if !is_canonical_sha256_digest(&raw.authority_realm_digest) {
        return Err(PromotionDecisionHostConfigError::InvalidAuthorityRealmDigest);
    }

    let kernel = parse_signer("kernel", raw.kernel)?;
    let operator = parse_signer("operator", raw.operator)?;
    if raw.reviewers.is_empty() {
        return Err(PromotionDecisionHostConfigError::InvalidGovernedAuthority);
    }
    let reviewers = raw
        .reviewers
        .into_iter()
        .enumerate()
        .map(|(index, signer)| parse_signer(&format!("reviewers[{index}]"), signer))
        .collect::<Result<Vec<_>, _>>()?;

    let mut trusted_keys = TrustedPublicKeys::default();
    insert_trusted_public_key(&mut trusted_keys, &kernel);
    insert_trusted_public_key(&mut trusted_keys, &operator);
    for reviewer in &reviewers {
        insert_trusted_public_key(&mut trusted_keys, reviewer);
    }

    let kernel_signer = kernel.signer;
    let operator_signer = operator.signer;
    let reviewer_signers = reviewers
        .into_iter()
        .map(|reviewer| reviewer.signer)
        .collect::<Vec<_>>();
    let promotion_authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted_keys.clone(),
        kernel_signer.clone(),
        reviewer_signers.clone(),
        operator_signer.clone(),
        raw.authority_realm_digest.clone(),
    )
    .map_err(|_| PromotionDecisionHostConfigError::InvalidGovernedAuthority)?;

    let mut replay_authorities = TrustedReplayAuthorities::new(trusted_keys);
    replay_authorities.allow_signer(TrustSpineSignerRole::Kernel, kernel_signer.clone());
    replay_authorities.allow_signer(TrustSpineSignerRole::Operator, operator_signer.clone());
    for reviewer_signer in &reviewer_signers {
        replay_authorities.allow_signer(TrustSpineSignerRole::Reviewer, reviewer_signer.clone());
    }

    Ok(PromotionDecisionHostConfigV1 {
        run_id,
        broker_uid: raw.broker_uid,
        promotion_decision_client_uids,
        socket_group_gid: raw.socket_group_gid,
        authority_root,
        authority_realm_digest: raw.authority_realm_digest,
        kernel_signer,
        operator_signer,
        reviewer_signers,
        promotion_authority,
        replay_authorities,
    })
}

fn parse_canonical_uuidv7(run_id: &str) -> Result<RunId, PromotionDecisionHostConfigError> {
    let uuid =
        Uuid::parse_str(run_id).map_err(|_| PromotionDecisionHostConfigError::InvalidRunId)?;
    if uuid.hyphenated().to_string() != run_id || uuid.get_version_num() != 7 {
        return Err(PromotionDecisionHostConfigError::InvalidRunId);
    }
    Ok(RunId::from_uuid(uuid))
}

fn validate_client_uids(
    broker_uid: u32,
    client_uids: Vec<u32>,
) -> Result<Vec<u32>, PromotionDecisionHostConfigError> {
    if client_uids.is_empty() {
        return Err(PromotionDecisionHostConfigError::NoPromotionDecisionClientUids);
    }

    let mut unique_uids = BTreeSet::new();
    for uid in &client_uids {
        if *uid == 0 {
            return Err(PromotionDecisionHostConfigError::UidZeroNotAllowed { uid: *uid });
        }
        if *uid == broker_uid {
            return Err(PromotionDecisionHostConfigError::ClientUidAliasesBroker);
        }
        if !unique_uids.insert(*uid) {
            return Err(PromotionDecisionHostConfigError::DuplicatePromotionDecisionClientUid);
        }
    }
    Ok(client_uids)
}

fn validate_authority_root(
    authority_root: String,
) -> Result<PathBuf, PromotionDecisionHostConfigError> {
    let authority_root = PathBuf::from(authority_root);
    if !authority_root.is_absolute()
        || authority_root.parent().is_none()
        || authority_root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(PromotionDecisionHostConfigError::InvalidAuthorityRoot);
    }
    Ok(authority_root)
}

fn is_canonical_sha256_digest(digest: &str) -> bool {
    digest.len() == 71
        && digest.starts_with("sha256:")
        && digest.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn parse_signer(
    role: &str,
    raw: RawSignerDescriptorV1,
) -> Result<ParsedSignerDescriptor, PromotionDecisionHostConfigError> {
    let keyring_ref = KeyringRef::new(raw.actor_id, raw.key_id);
    keyring_ref
        .path_under(Path::new(KEYRING_VALIDATION_ROOT))
        .map_err(|_| PromotionDecisionHostConfigError::InvalidSignerId {
            role: role.to_string(),
        })?;

    let public_key: [u8; 32] = raw.public_key.as_slice().try_into().map_err(|_| {
        PromotionDecisionHostConfigError::InvalidSignerPublicKey {
            role: role.to_string(),
        }
    })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|_| {
        PromotionDecisionHostConfigError::InvalidSignerPublicKey {
            role: role.to_string(),
        }
    })?;

    Ok(ParsedSignerDescriptor {
        signer: ActorKeyRef {
            actor_id: keyring_ref.actor_id,
            key_id: keyring_ref.key_id,
            public_key_hash: Some(public_key_hash(&verifying_key)),
        },
        public_key: public_key.to_vec(),
    })
}

fn insert_trusted_public_key(keys: &mut TrustedPublicKeys, signer: &ParsedSignerDescriptor) {
    let public_key_hash = signer
        .signer
        .public_key_hash
        .clone()
        .expect("parsed signer always has a locally computed public key hash");
    keys.insert_public_key(public_key_hash, signer.public_key.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn signer(actor_id: &str, key_id: &str, seed: u8) -> serde_json::Value {
        let public_key = SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .to_bytes()
            .to_vec();
        json!({
            "actor_id": actor_id,
            "key_id": key_id,
            "public_key": public_key,
        })
    }

    fn public_key_hash_for_seed(seed: u8) -> String {
        public_key_hash(&SigningKey::from_bytes(&[seed; 32]).verifying_key())
    }

    fn valid_config() -> serde_json::Value {
        json!({
            "schema_version": 1,
            "run_id": "018f2e40-0000-7000-8000-000000000001",
            "broker_uid": 1000,
            "promotion_decision_client_uids": [1001],
            "socket_group_gid": 1002,
            "authority_root": "/var/lib/buildplane/authority",
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "kernel": signer("kernel", "kernel-main", 1),
            "operator": signer("operator", "operator-main", 2),
            "reviewers": [signer("reviewer", "reviewer-main", 3)],
        })
    }

    fn parse(
        value: serde_json::Value,
    ) -> Result<PromotionDecisionHostConfigV1, PromotionDecisionHostConfigError> {
        parse_promotion_decision_host_config(&value.to_string())
    }

    #[test]
    fn parses_a_closed_valid_config_into_role_bound_public_authority() {
        let parsed = parse(valid_config()).expect("valid host config must parse");
        let kernel_hash = public_key_hash_for_seed(1);
        let operator_hash = public_key_hash_for_seed(2);
        let reviewer_hash = public_key_hash_for_seed(3);

        assert_eq!(
            parsed.run_id.to_string(),
            "018f2e40-0000-7000-8000-000000000001"
        );
        assert_eq!(parsed.broker_uid, 1000);
        assert_eq!(parsed.promotion_decision_client_uids, vec![1001]);
        assert_eq!(parsed.socket_group_gid, 1002);
        assert_eq!(
            parsed.authority_root,
            PathBuf::from("/var/lib/buildplane/authority")
        );
        assert_eq!(
            parsed.authority_realm_digest,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            parsed.kernel_signer.public_key_hash.as_deref(),
            Some(kernel_hash.as_str())
        );
        assert_eq!(
            parsed.operator_signer.public_key_hash.as_deref(),
            Some(operator_hash.as_str())
        );
        assert_eq!(
            parsed.reviewer_signers[0].public_key_hash.as_deref(),
            Some(reviewer_hash.as_str())
        );
        assert_eq!(
            parsed.promotion_authority.configured_kernel_signer(),
            &parsed.kernel_signer
        );
        assert_eq!(
            parsed.promotion_authority.configured_operator_signer(),
            &parsed.operator_signer
        );

        let replay = format!("{:?}", parsed.replay_authorities);
        for expected in [
            "Kernel",
            "Operator",
            "Reviewer",
            "kernel-main",
            "operator-main",
            "reviewer-main",
        ] {
            assert!(
                replay.contains(expected),
                "trusted replay must bind {expected}"
            );
        }
    }

    #[test]
    fn rejects_private_material_and_unknown_signer_fields() {
        for prohibited in ["private_key", "seed", "public_key_hash"] {
            let mut config = valid_config();
            config["kernel"]
                .as_object_mut()
                .expect("kernel descriptor is an object")
                .insert(prohibited.to_string(), json!("must-not-be-accepted"));
            assert!(parse(config).is_err(), "{prohibited} must be rejected");
        }

        let mut config = valid_config();
        config["unexpected"] = json!(true);
        assert!(
            parse(config).is_err(),
            "top-level unknown fields must be rejected"
        );
    }

    #[test]
    fn rejects_relative_root_noncanonical_digest_and_non_v7_uuid() {
        let mut relative_root = valid_config();
        relative_root["authority_root"] = json!("relative/authority");
        assert!(parse(relative_root).is_err());

        let mut noncanonical_digest = valid_config();
        noncanonical_digest["authority_realm_digest"] =
            json!("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert!(parse(noncanonical_digest).is_err());

        let mut non_v7_uuid = valid_config();
        non_v7_uuid["run_id"] = json!("018f2e40-0000-6000-8000-000000000001");
        assert!(parse(non_v7_uuid).is_err());
    }

    #[test]
    fn rejects_an_unsafe_broad_authority_root() {
        let mut config = valid_config();
        config["authority_root"] = json!("/");

        assert!(matches!(
            parse(config),
            Err(PromotionDecisionHostConfigError::InvalidAuthorityRoot)
        ));
    }

    #[test]
    fn rejects_a_promotion_client_uid_that_aliases_the_broker() {
        let mut config = valid_config();
        config["promotion_decision_client_uids"] = json!([1000]);
        assert!(parse(config).is_err());
    }

    #[test]
    fn rejects_zero_valued_broker_or_promotion_client_uid() {
        let mut zero_broker = valid_config();
        zero_broker["broker_uid"] = json!(0);
        assert!(matches!(
            parse(zero_broker),
            Err(PromotionDecisionHostConfigError::UidZeroNotAllowed { uid: 0 })
        ));

        let mut zero_client = valid_config();
        zero_client["promotion_decision_client_uids"] = json!([0]);
        assert!(matches!(
            parse(zero_client),
            Err(PromotionDecisionHostConfigError::UidZeroNotAllowed { uid: 0 })
        ));
    }

    #[test]
    fn rejects_duplicate_promotion_client_uids() {
        let mut config = valid_config();
        config["promotion_decision_client_uids"] = json!([1001, 1001]);

        assert!(matches!(
            parse(config),
            Err(PromotionDecisionHostConfigError::DuplicatePromotionDecisionClientUid)
        ));
    }

    #[test]
    fn rejects_duplicate_key_material_across_governed_roles() {
        let mut config = valid_config();
        config["operator"]["public_key"] = config["kernel"]["public_key"].clone();
        assert!(parse(config).is_err());
    }

    #[test]
    fn rejects_invalid_actor_key_identifiers_and_public_bytes() {
        let mut invalid_actor = valid_config();
        invalid_actor["kernel"]["actor_id"] = json!("../kernel");
        assert!(parse(invalid_actor).is_err());

        let mut invalid_key_id = valid_config();
        invalid_key_id["kernel"]["key_id"] = json!("../kernel-main");
        assert!(parse(invalid_key_id).is_err());

        let mut invalid_public_key = valid_config();
        invalid_public_key["kernel"]["public_key"] = json!(vec![0_u8; 31]);
        assert!(parse(invalid_public_key).is_err());
    }
}
