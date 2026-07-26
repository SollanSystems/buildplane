use bp_ledger::keyring::KeyringRef;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::GovernedDispatchV5AdmissionAuthorityV1;
use bp_ledger::RunId;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

const KEYRING_VALIDATION_ROOT: &str = "/buildplane-v5-host-config-validation";

#[derive(Debug)]
pub(crate) struct V5AdmissionHostConfigV1 {
    pub(crate) run_id: RunId,
    pub(crate) broker_uid: u32,
    pub(crate) dispatch_admission_client_uids: Vec<u32>,
    pub(crate) socket_group_gid: u32,
    pub(crate) authority_root: PathBuf,
    pub(crate) authority_realm_digest: String,
    pub(crate) source_dispatch_signer: ActorKeyRef,
    pub(crate) admission_record_signer: ActorKeyRef,
    pub(crate) checkpoint_signer: ActorKeyRef,
    pub(crate) admission_authority: GovernedDispatchV5AdmissionAuthorityV1,
}

#[derive(Debug, Error)]
pub(crate) enum V5AdmissionHostConfigErrorV1 {
    #[error("protected V5 admission host config is invalid")]
    Invalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    schema_version: u32,
    run_id: String,
    broker_uid: u32,
    dispatch_admission_client_uids: Vec<u32>,
    socket_group_gid: u32,
    authority_root: String,
    authority_realm_digest: String,
    source_dispatch: RawSigner,
    admission_record: RawSigner,
    checkpoint: RawSigner,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSigner {
    actor_id: String,
    key_id: String,
    public_key: Vec<u8>,
}

struct ParsedSigner {
    identity: ActorKeyRef,
    public_key: Vec<u8>,
}

pub(crate) fn parse_v5_admission_host_config_v1(
    json: &str,
) -> Result<V5AdmissionHostConfigV1, V5AdmissionHostConfigErrorV1> {
    let raw: RawConfig =
        serde_json::from_str(json).map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;
    let run_uuid =
        Uuid::parse_str(&raw.run_id).map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;
    if raw.schema_version != 1
        || run_uuid.hyphenated().to_string() != raw.run_id
        || run_uuid.get_version_num() != 7
        || raw.broker_uid == 0
        || raw.dispatch_admission_client_uids.is_empty()
        || !is_canonical_digest(&raw.authority_realm_digest)
    {
        return Err(V5AdmissionHostConfigErrorV1::Invalid);
    }
    let mut client_uids = BTreeSet::new();
    for uid in &raw.dispatch_admission_client_uids {
        if *uid == 0 || *uid == raw.broker_uid || !client_uids.insert(*uid) {
            return Err(V5AdmissionHostConfigErrorV1::Invalid);
        }
    }
    let authority_root = PathBuf::from(raw.authority_root);
    if !authority_root.is_absolute()
        || authority_root == Path::new("/")
        || authority_root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(V5AdmissionHostConfigErrorV1::Invalid);
    }

    let source = parse_signer(raw.source_dispatch)?;
    let admission = parse_signer(raw.admission_record)?;
    let checkpoint = parse_signer(raw.checkpoint)?;
    let mut trusted_keys = TrustedPublicKeys::default();
    for signer in [&source, &admission, &checkpoint] {
        let hash = signer
            .identity
            .public_key_hash
            .clone()
            .ok_or(V5AdmissionHostConfigErrorV1::Invalid)?;
        trusted_keys.insert_public_key(hash, signer.public_key.clone());
    }
    let source_dispatch_signer = source.identity;
    let admission_record_signer = admission.identity;
    let checkpoint_signer = checkpoint.identity;
    let admission_authority = GovernedDispatchV5AdmissionAuthorityV1::new_governed_realm(
        trusted_keys,
        source_dispatch_signer.clone(),
        admission_record_signer.clone(),
        checkpoint_signer.clone(),
        raw.authority_realm_digest.clone(),
    )
    .map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;

    Ok(V5AdmissionHostConfigV1 {
        run_id: RunId::from_uuid(run_uuid),
        broker_uid: raw.broker_uid,
        dispatch_admission_client_uids: raw.dispatch_admission_client_uids,
        socket_group_gid: raw.socket_group_gid,
        authority_root,
        authority_realm_digest: raw.authority_realm_digest,
        source_dispatch_signer,
        admission_record_signer,
        checkpoint_signer,
        admission_authority,
    })
}

fn parse_signer(raw: RawSigner) -> Result<ParsedSigner, V5AdmissionHostConfigErrorV1> {
    let keyring = KeyringRef::new(raw.actor_id, raw.key_id);
    keyring
        .path_under(Path::new(KEYRING_VALIDATION_ROOT))
        .map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;
    let bytes: [u8; 32] = raw
        .public_key
        .as_slice()
        .try_into()
        .map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;
    let verifying_key =
        VerifyingKey::from_bytes(&bytes).map_err(|_| V5AdmissionHostConfigErrorV1::Invalid)?;
    Ok(ParsedSigner {
        identity: ActorKeyRef {
            actor_id: keyring.actor_id,
            key_id: keyring.key_id,
            public_key_hash: Some(public_key_hash(&verifying_key)),
        },
        public_key: raw.public_key,
    })
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
            "dispatch_admission_client_uids": [1001],
            "socket_group_gid": 1002,
            "authority_root": "/var/lib/buildplane/v5-admission-authority",
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "source_dispatch": signer("dispatch:v5-source", "source-main", 1),
            "admission_record": signer("kernel:v5-admission", "admission-main", 2),
            "checkpoint": signer("kernel:v5-checkpoint", "checkpoint-main", 3),
        })
    }

    #[test]
    fn parses_closed_run_bound_three_identity_v5_host_config() {
        let config = parse_v5_admission_host_config_v1(&valid_config().to_string())
            .expect("valid V5 admission host config");
        assert_eq!(
            config.run_id.to_string(),
            "018f2e40-0000-7000-8000-000000000001"
        );
        assert_eq!(config.dispatch_admission_client_uids, vec![1001]);
        assert_ne!(
            config.source_dispatch_signer,
            config.admission_record_signer
        );
        assert_ne!(config.admission_record_signer, config.checkpoint_signer);
    }

    #[test]
    fn rejects_unknown_fields_and_all_identity_or_key_aliasing() {
        let mut unknown = valid_config();
        unknown["socket_path"] = json!("/tmp/attacker.sock");
        assert!(parse_v5_admission_host_config_v1(&unknown.to_string()).is_err());
        let mut caller_selected_cas = valid_config();
        caller_selected_cas["cas_root"] = json!("/tmp/attacker-cas");
        assert!(parse_v5_admission_host_config_v1(&caller_selected_cas.to_string()).is_err());

        for (left, right) in [
            ("source_dispatch", "admission_record"),
            ("source_dispatch", "checkpoint"),
            ("admission_record", "checkpoint"),
        ] {
            let mut actor_alias = valid_config();
            actor_alias[right]["actor_id"] = actor_alias[left]["actor_id"].clone();
            assert!(parse_v5_admission_host_config_v1(&actor_alias.to_string()).is_err());

            let mut key_alias = valid_config();
            key_alias[right]["public_key"] = key_alias[left]["public_key"].clone();
            assert!(parse_v5_admission_host_config_v1(&key_alias.to_string()).is_err());
        }
    }
}
