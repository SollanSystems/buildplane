//! Closed deployment configuration for the protected plan-admission host.
//!
//! The plan-admission realm is a **single kernel signer** realm (operator gate
//! Q4): `PlanAdmittedV1` records the operator as a payload field and the kernel
//! key signs both the admission and its sealing checkpoint. The one thing the
//! deployment must still pin is *which operator identity each authenticated
//! client UID stands for*, because `decided_by` is derived from the SO_PEERCRED
//! peer rather than asserted by the request. That mapping is the "configured
//! role policy" the design names, and it is closed: a UID absent from it cannot
//! reach the mint at all, and no two UIDs may share an identity.

use bp_ledger::keyring::KeyringRef;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::PlanAdmissionAuthorityV1;
use bp_ledger::RunId;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

const KEYRING_VALIDATION_ROOT: &str = "/buildplane-plan-admission-host-config-validation";
const MAX_OPERATOR_IDENTITY_BYTES: usize = 256;

#[derive(Debug)]
pub(crate) struct PlanAdmissionHostConfigV1 {
    pub(crate) run_id: RunId,
    pub(crate) broker_uid: u32,
    pub(crate) socket_group_gid: u32,
    pub(crate) authority_root: PathBuf,
    pub(crate) authority_realm_digest: String,
    pub(crate) kernel_signer: ActorKeyRef,
    pub(crate) admission_authority: PlanAdmissionAuthorityV1,
    /// Closed UID to operator-identity policy. Ordered so the derived client
    /// UID set is deterministic.
    operator_identities: BTreeMap<u32, String>,
}

impl PlanAdmissionHostConfigV1 {
    /// The exact set of client UIDs the confinement policy may admit. It is
    /// derived from the identity policy, so a UID can never be admitted without
    /// an operator identity to record for it.
    pub(crate) fn plan_admission_client_uids(&self) -> Vec<u32> {
        self.operator_identities.keys().copied().collect()
    }

    /// The operator identity recorded for one already-authenticated peer UID.
    pub(crate) fn operator_identity_for_uid(&self, uid: u32) -> Option<&str> {
        self.operator_identities.get(&uid).map(String::as_str)
    }
}

#[derive(Debug, Error)]
pub(crate) enum PlanAdmissionHostConfigErrorV1 {
    #[error("protected plan-admission host config is invalid")]
    Invalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    schema_version: u32,
    run_id: String,
    broker_uid: u32,
    plan_admission_clients: Vec<RawClient>,
    socket_group_gid: u32,
    authority_root: String,
    authority_realm_digest: String,
    kernel: RawSigner,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawClient {
    uid: u32,
    decided_by: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSigner {
    actor_id: String,
    key_id: String,
    public_key: Vec<u8>,
}

pub(crate) fn parse_plan_admission_host_config_v1(
    json: &str,
) -> Result<PlanAdmissionHostConfigV1, PlanAdmissionHostConfigErrorV1> {
    let raw: RawConfig =
        serde_json::from_str(json).map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;
    let run_uuid =
        Uuid::parse_str(&raw.run_id).map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;
    if raw.schema_version != 1
        || run_uuid.hyphenated().to_string() != raw.run_id
        || run_uuid.get_version_num() != 7
        || raw.broker_uid == 0
        || raw.plan_admission_clients.is_empty()
        || !is_canonical_digest(&raw.authority_realm_digest)
    {
        return Err(PlanAdmissionHostConfigErrorV1::Invalid);
    }

    let mut operator_identities: BTreeMap<u32, String> = BTreeMap::new();
    let mut claimed_identities: BTreeSet<String> = BTreeSet::new();
    for client in raw.plan_admission_clients {
        if client.uid == 0
            || client.uid == raw.broker_uid
            || !is_recordable_operator_identity(&client.decided_by)
            || !claimed_identities.insert(client.decided_by.clone())
            || operator_identities
                .insert(client.uid, client.decided_by)
                .is_some()
        {
            return Err(PlanAdmissionHostConfigErrorV1::Invalid);
        }
    }

    let authority_root = PathBuf::from(raw.authority_root);
    if !authority_root.is_absolute()
        || authority_root == Path::new("/")
        || authority_root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(PlanAdmissionHostConfigErrorV1::Invalid);
    }

    let kernel = parse_signer(raw.kernel)?;
    let mut trusted_keys = TrustedPublicKeys::default();
    let hash = kernel
        .identity
        .public_key_hash
        .clone()
        .ok_or(PlanAdmissionHostConfigErrorV1::Invalid)?;
    trusted_keys.insert_public_key(hash, kernel.public_key);
    let kernel_signer = kernel.identity;
    let admission_authority = PlanAdmissionAuthorityV1::new_kernel_realm(
        trusted_keys,
        kernel_signer.clone(),
        raw.authority_realm_digest.clone(),
    )
    .map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;

    Ok(PlanAdmissionHostConfigV1 {
        run_id: RunId::from_uuid(run_uuid),
        broker_uid: raw.broker_uid,
        socket_group_gid: raw.socket_group_gid,
        authority_root,
        authority_realm_digest: raw.authority_realm_digest,
        kernel_signer,
        admission_authority,
        operator_identities,
    })
}

struct ParsedSigner {
    identity: ActorKeyRef,
    public_key: Vec<u8>,
}

fn parse_signer(raw: RawSigner) -> Result<ParsedSigner, PlanAdmissionHostConfigErrorV1> {
    let keyring = KeyringRef::new(raw.actor_id, raw.key_id);
    keyring
        .path_under(Path::new(KEYRING_VALIDATION_ROOT))
        .map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;
    let bytes: [u8; 32] = raw
        .public_key
        .as_slice()
        .try_into()
        .map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;
    let verifying_key =
        VerifyingKey::from_bytes(&bytes).map_err(|_| PlanAdmissionHostConfigErrorV1::Invalid)?;
    Ok(ParsedSigner {
        identity: ActorKeyRef {
            actor_id: keyring.actor_id,
            key_id: keyring.key_id,
            public_key_hash: Some(public_key_hash(&verifying_key)),
        },
        public_key: raw.public_key,
    })
}

/// The storage layer refuses a `decided_by` that is empty or carries control
/// characters. Deployment configuration is held to a stricter bar than the last
/// line of defence: the identity must already be the exact single-line text the
/// mint will sign, with no surrounding whitespace to normalize away and a bound
/// that keeps it out of the frame-sized range.
fn is_recordable_operator_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATOR_IDENTITY_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
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

    fn valid_config() -> Value {
        json!({
            "schema_version": 1,
            "run_id": "018f2e40-0000-7000-8000-000000000001",
            "broker_uid": 1000,
            "plan_admission_clients": [
                { "uid": 1001, "decided_by": "operator:release-engineer" },
                { "uid": 1003, "decided_by": "operator:duty-engineer" },
            ],
            "socket_group_gid": 1002,
            "authority_root": "/var/lib/buildplane/plan-admission-authority",
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "kernel": {
                "actor_id": "kernel",
                "key_id": "kernel-main",
                "public_key": SigningKey::from_bytes(&[7; 32])
                    .verifying_key()
                    .to_bytes()
                    .to_vec(),
            },
        })
    }

    #[test]
    fn parses_a_closed_run_bound_single_kernel_signer_config() {
        let config = parse_plan_admission_host_config_v1(&valid_config().to_string())
            .expect("valid plan-admission host config");

        assert_eq!(
            config.run_id.to_string(),
            "018f2e40-0000-7000-8000-000000000001"
        );
        assert_eq!(config.plan_admission_client_uids(), vec![1001, 1003]);
        assert_eq!(config.kernel_signer.actor_id, "kernel");
        assert_eq!(config.kernel_signer.key_id, "kernel-main");
        assert!(config.kernel_signer.public_key_hash.is_some());
    }

    #[test]
    fn decided_by_is_a_closed_lookup_keyed_only_by_an_authenticated_uid() {
        let config = parse_plan_admission_host_config_v1(&valid_config().to_string())
            .expect("valid plan-admission host config");

        assert_eq!(
            config.operator_identity_for_uid(1001),
            Some("operator:release-engineer")
        );
        assert_eq!(
            config.operator_identity_for_uid(1003),
            Some("operator:duty-engineer")
        );
        assert_eq!(config.operator_identity_for_uid(1002), None);
        assert_eq!(config.operator_identity_for_uid(1000), None);
    }

    #[test]
    fn rejects_unknown_fields_and_caller_selected_deployment_surfaces() {
        for extra in ["socket_path", "cas_root", "ledger_path", "decided_by"] {
            let mut unknown = valid_config();
            unknown[extra] = json!("/tmp/attacker");
            assert!(parse_plan_admission_host_config_v1(&unknown.to_string()).is_err());
        }
        let mut unknown_client_field = valid_config();
        unknown_client_field["plan_admission_clients"][0]["trusted_base"] = json!("deadbeef");
        assert!(parse_plan_admission_host_config_v1(&unknown_client_field.to_string()).is_err());
    }

    #[test]
    fn rejects_root_broker_aliased_empty_and_duplicated_client_identities() {
        let mut root_broker = valid_config();
        root_broker["broker_uid"] = json!(0);
        assert!(parse_plan_admission_host_config_v1(&root_broker.to_string()).is_err());

        let mut root_client = valid_config();
        root_client["plan_admission_clients"][0]["uid"] = json!(0);
        assert!(parse_plan_admission_host_config_v1(&root_client.to_string()).is_err());

        let mut aliased = valid_config();
        aliased["plan_admission_clients"][0]["uid"] = json!(1000);
        assert!(parse_plan_admission_host_config_v1(&aliased.to_string()).is_err());

        let mut empty = valid_config();
        empty["plan_admission_clients"] = json!([]);
        assert!(parse_plan_admission_host_config_v1(&empty.to_string()).is_err());

        let mut duplicate_uid = valid_config();
        duplicate_uid["plan_admission_clients"][1]["uid"] = json!(1001);
        assert!(parse_plan_admission_host_config_v1(&duplicate_uid.to_string()).is_err());

        // Two peers must never collapse to one recorded operator identity: the
        // mint would then sign a `decided_by` that does not identify who acted.
        let mut duplicate_identity = valid_config();
        duplicate_identity["plan_admission_clients"][1]["decided_by"] =
            json!("operator:release-engineer");
        assert!(parse_plan_admission_host_config_v1(&duplicate_identity.to_string()).is_err());
    }

    #[test]
    fn rejects_identities_that_are_not_a_single_line_bounded_name() {
        for identity in [
            "",
            "   ",
            "operator:with\nnewline",
            "operator:with\ttab",
            " operator:padded ",
        ] {
            let mut invalid = valid_config();
            invalid["plan_admission_clients"][0]["decided_by"] = json!(identity);
            assert!(
                parse_plan_admission_host_config_v1(&invalid.to_string()).is_err(),
                "{identity:?} must not become a recorded operator identity"
            );
        }
        let mut oversized = valid_config();
        oversized["plan_admission_clients"][0]["decided_by"] = json!("o".repeat(257));
        assert!(parse_plan_admission_host_config_v1(&oversized.to_string()).is_err());
    }

    #[test]
    fn rejects_unsafe_authority_roots_and_non_canonical_realm_digests() {
        // `/var/./buildplane` is deliberately absent: `Path::components` drops a
        // mid-path `.`, so it is the same path as `/var/buildplane` and carries
        // no traversal. `..` is the case that can actually escape, and it is
        // preserved by `components` and rejected here.
        for root in ["", "relative/path", "/", "/var/../etc"] {
            let mut invalid = valid_config();
            invalid["authority_root"] = json!(root);
            assert!(
                parse_plan_admission_host_config_v1(&invalid.to_string()).is_err(),
                "{root:?} must not become a protected authority root"
            );
        }
        let mut digest = valid_config();
        digest["authority_realm_digest"] = json!("sha256:not-hex");
        assert!(parse_plan_admission_host_config_v1(&digest.to_string()).is_err());
    }

    #[test]
    fn rejects_a_kernel_signer_without_usable_pinned_key_material() {
        let mut short_key = valid_config();
        short_key["kernel"]["public_key"] = json!(vec![0_u8; 31]);
        assert!(parse_plan_admission_host_config_v1(&short_key.to_string()).is_err());

        for field in ["actor_id", "key_id"] {
            let mut blank = valid_config();
            blank["kernel"][field] = json!("");
            assert!(parse_plan_admission_host_config_v1(&blank.to_string()).is_err());

            let mut traversal = valid_config();
            traversal["kernel"][field] = json!("../escape");
            assert!(parse_plan_admission_host_config_v1(&traversal.to_string()).is_err());
        }
    }

    #[test]
    fn rejects_a_non_v7_or_non_canonical_run_identity_and_wrong_schema_version() {
        let mut version = valid_config();
        version["schema_version"] = json!(2);
        assert!(parse_plan_admission_host_config_v1(&version.to_string()).is_err());

        let mut uuid_version = valid_config();
        uuid_version["run_id"] = json!("018f2e40-0000-4000-8000-000000000001");
        assert!(parse_plan_admission_host_config_v1(&uuid_version.to_string()).is_err());

        let mut uppercase = valid_config();
        uppercase["run_id"] = json!("018F2E40-0000-7000-8000-000000000001");
        assert!(parse_plan_admission_host_config_v1(&uppercase.to_string()).is_err());
    }
}
