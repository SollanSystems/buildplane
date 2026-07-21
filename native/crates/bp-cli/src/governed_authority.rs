//! Host-owned authority realm for the governed execution lane.
//!
//! The repository workspace is intentionally not an authority store: a
//! repository can be copied or rolled back between activity attempts. This
//! module anchors the governed tape and its activity-claim uniqueness register
//! in a per-user Linux state directory discovered from the OS account rather
//! than `$HOME` or caller-provided paths. Provisioning is explicit; normal
//! governed resolution fails closed until an operator has provisioned a realm.

use bp_ledger::keyring::{load_signing_key_at, KeyringRef};
use bp_ledger::signing::{public_key_hash, ActorKeyRef};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const REALM_SCHEMA_VERSION: u8 = 1;
const REALM_DIGEST_DOMAIN: &str = "buildplane.ledger-authority-realm.v1\0";
const REALM_DIRECTORY_NAME: &str = "governed-authority-v1";
const REALM_CONFIG_FILE: &str = "realm.json";
const REVIEWER_AUTHORITY_SCHEMA_VERSION: u8 = 1;
const REVIEWER_AUTHORITY_CONFIG_FILE: &str = "reviewer-authority-v1.json";
const REVIEWER_AUTHORITY_DIGEST_DOMAIN: &str = "buildplane.ledger-reviewer-authority.v1\0";
const OPERATOR_AUTHORITY_SCHEMA_VERSION: u8 = 1;
const OPERATOR_AUTHORITY_CONFIG_FILE: &str = "operator-authority-v1.json";
const OPERATOR_AUTHORITY_DIGEST_DOMAIN: &str = "buildplane.ledger-operator-authority.v1\0";
const LEDGER_WORKSPACE_DIRECTORY: &str = "ledger-workspace";
const KEYRING_DIRECTORY: &str = "keys";
const DEFAULT_KERNEL_ACTOR_ID: &str = "kernel";
const DEFAULT_KERNEL_KEY_ID: &str = "kernel-main";
const DEFAULT_REVIEWER_ACTOR_ID: &str = "reviewer";
const DEFAULT_REVIEWER_KEY_ID: &str = "reviewer-main";
const DEFAULT_OPERATOR_ACTOR_ID: &str = "operator";
const DEFAULT_OPERATOR_KEY_ID: &str = "operator-main";
const GOVERNED_AUTHORITY_BROKER_REQUIRED: &str = "GOVERNED_AUTHORITY_BROKER_REQUIRED: local file-backed signer keys are disabled outside tests; governed execution requires an isolated external authority broker with a distinct OS identity";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedAuthorityRealmV1 {
    pub realm_digest: String,
    pub ledger_workspace: PathBuf,
    pub keyring_root: PathBuf,
    pub kernel_signer: ActorKeyRef,
}

#[derive(Debug, Clone, Serialize)]
pub struct GovernedAuthorityRealmProjectionV1 {
    pub schema_version: u8,
    pub realm_digest: String,
    pub ledger_workspace: String,
    pub kernel_signer: ActorKeyRef,
}

/// A separately provisioned reviewer signing identity. It is deliberately
/// outside the kernel realm configuration: normal kernel-realm loading must
/// not create, rotate, or otherwise make reviewer authority available.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedReviewerAuthorityV1 {
    /// Canonical digest of the reviewer authority configuration.
    pub authority_digest: String,
    /// Digest of the exact kernel realm that provisioned this reviewer.
    pub parent_realm_digest: String,
    /// Protected keyring inherited from the verified parent realm.
    pub keyring_root: PathBuf,
    /// Independently pinned reviewer event-signing identity.
    pub reviewer_signer: ActorKeyRef,
}

/// Redacted, closed reviewer-authority projection suitable for CLI status or
/// explicit provisioning output. The protected keyring location never leaves
/// the native authority boundary.
#[derive(Debug, Clone, Serialize)]
pub struct GovernedReviewerAuthorityProjectionV1 {
    pub schema_version: u8,
    pub authority_digest: String,
    pub parent_realm_digest: String,
    pub reviewer_signer: ActorKeyRef,
}

/// A separately provisioned operator signing identity. Operator-owned
/// promotion decisions must never be signed by the kernel or reviewer roots,
/// even when all three identities live under the same protected host realm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedOperatorAuthorityV1 {
    /// Canonical digest of the operator authority configuration.
    pub authority_digest: String,
    /// Digest of the exact kernel realm that provisioned this operator.
    pub parent_realm_digest: String,
    /// Protected keyring inherited from the verified parent realm.
    pub keyring_root: PathBuf,
    /// Independently pinned operator event-signing identity.
    pub operator_signer: ActorKeyRef,
}

/// Redacted, closed operator-authority projection suitable for explicit
/// provisioning output. The protected keyring location never crosses the
/// native authority boundary.
#[derive(Debug, Clone, Serialize)]
pub struct GovernedOperatorAuthorityProjectionV1 {
    pub schema_version: u8,
    pub authority_digest: String,
    pub parent_realm_digest: String,
    pub operator_signer: ActorKeyRef,
}

impl GovernedReviewerAuthorityV1 {
    pub fn projection(&self) -> GovernedReviewerAuthorityProjectionV1 {
        GovernedReviewerAuthorityProjectionV1 {
            schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
            authority_digest: self.authority_digest.clone(),
            parent_realm_digest: self.parent_realm_digest.clone(),
            reviewer_signer: self.reviewer_signer.clone(),
        }
    }
}

impl GovernedOperatorAuthorityV1 {
    pub fn projection(&self) -> GovernedOperatorAuthorityProjectionV1 {
        GovernedOperatorAuthorityProjectionV1 {
            schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
            authority_digest: self.authority_digest.clone(),
            parent_realm_digest: self.parent_realm_digest.clone(),
            operator_signer: self.operator_signer.clone(),
        }
    }
}

impl GovernedAuthorityRealmV1 {
    /// Return a lossless, closed projection for the TypeScript host. A
    /// non-UTF-8 authority location is a configuration error, never an empty
    /// string that could accidentally be interpreted as a default workspace.
    pub fn projection(&self) -> Result<GovernedAuthorityRealmProjectionV1, String> {
        Ok(GovernedAuthorityRealmProjectionV1 {
            schema_version: REALM_SCHEMA_VERSION,
            realm_digest: self.realm_digest.clone(),
            ledger_workspace: path_to_utf8(&self.ledger_workspace, "ledger workspace")?,
            kernel_signer: self.kernel_signer.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RealmConfigV1 {
    schema_version: u8,
    realm_id: String,
    kernel_actor_id: String,
    kernel_key_id: String,
    kernel_public_key_hash: String,
    realm_digest: String,
}

#[derive(Serialize)]
struct RealmDigestMaterialV1<'a> {
    schema_version: u8,
    realm_id: &'a str,
    kernel_actor_id: &'a str,
    kernel_key_id: &'a str,
    kernel_public_key_hash: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewerAuthorityConfigV1 {
    schema_version: u8,
    parent_realm_digest: String,
    reviewer_actor_id: String,
    reviewer_key_id: String,
    reviewer_public_key_hash: String,
    authority_digest: String,
}

#[derive(Serialize)]
struct ReviewerAuthorityDigestMaterialV1<'a> {
    schema_version: u8,
    parent_realm_digest: &'a str,
    reviewer_actor_id: &'a str,
    reviewer_key_id: &'a str,
    reviewer_public_key_hash: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorAuthorityConfigV1 {
    schema_version: u8,
    parent_realm_digest: String,
    operator_actor_id: String,
    operator_key_id: String,
    operator_public_key_hash: String,
    authority_digest: String,
}

#[derive(Serialize)]
struct OperatorAuthorityDigestMaterialV1<'a> {
    schema_version: u8,
    parent_realm_digest: &'a str,
    operator_actor_id: &'a str,
    operator_key_id: &'a str,
    operator_public_key_hash: &'a str,
}

/// A secure, private, write-ahead record for explicit reviewer provisioning.
/// The seed never leaves the protected keyring, and the record lets a crashed
/// provisioner resume only the exact signer/configuration it generated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingReviewerAuthorityProvisionV1 {
    schema_version: u8,
    config: ReviewerAuthorityConfigV1,
    seed: [u8; 32],
}

/// A secure, private, write-ahead record for explicit operator provisioning.
/// It is intentionally distinct from reviewer provisioning so a crash cannot
/// cause either role to adopt or rotate the other's signer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingOperatorAuthorityProvisionV1 {
    schema_version: u8,
    config: OperatorAuthorityConfigV1,
    seed: [u8; 32],
}

/// Inspect the existing host-owned governed realm. No first-run initialization
/// is performed here: silently generating a trust root from a worker/job is
/// an authority escalation.
pub fn load_governed_authority_realm() -> Result<GovernedAuthorityRealmV1, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(REALM_CONFIG_FILE);
    assert_secure_regular_file(&config_path, "governed authority realm config")?;
    let config: RealmConfigV1 = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("reading governed authority realm config: {error}"))?,
    )
    .map_err(|error| format!("parsing governed authority realm config: {error}"))?;
    validate_config(&config)?;

    let ledger_workspace = root.join(LEDGER_WORKSPACE_DIRECTORY);
    assert_secure_directory(&ledger_workspace, "governed authority ledger workspace")?;
    assert_secure_ledger_workspace(&ledger_workspace)?;
    let keyring_root = root.join(KEYRING_DIRECTORY);
    assert_secure_directory(&keyring_root, "governed authority keyring")?;
    let key_ref = KeyringRef::new(config.kernel_actor_id.clone(), config.kernel_key_id.clone());
    let key_path = key_ref
        .path_under(&keyring_root)
        .map_err(|error| format!("resolving governed authority key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed authority signing key")?;
    let signing_key = load_signing_key_at(&keyring_root, &key_ref)
        .map_err(|error| format!("loading governed authority signing key: {error}"))?;
    let actual_hash = public_key_hash(&signing_key.verifying_key());
    if actual_hash != config.kernel_public_key_hash {
        return Err(
            "governed authority signing key does not match the realm-pinned public key hash"
                .to_string(),
        );
    }
    Ok(GovernedAuthorityRealmV1 {
        realm_digest: config.realm_digest,
        ledger_workspace,
        keyring_root,
        kernel_signer: ActorKeyRef {
            actor_id: config.kernel_actor_id,
            key_id: config.kernel_key_id,
            public_key_hash: Some(actual_hash),
        },
    })
}

/// Explicit one-time operator provisioning. It makes a fresh local key inside
/// the protected realm and records only its public-key digest in configuration.
/// Normal governed execution never calls this function.
pub fn provision_governed_authority_realm() -> Result<GovernedAuthorityRealmV1, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let root = governed_authority_root()?;
    ensure_secure_directory(&root)?;
    let config_path = root.join(REALM_CONFIG_FILE);
    if config_path.exists() {
        return Err(
            "a governed authority realm is already provisioned; refusing to overwrite or rotate it implicitly"
                .to_string(),
        );
    }
    let ledger_workspace = root.join(LEDGER_WORKSPACE_DIRECTORY);
    ensure_secure_directory(&ledger_workspace)?;
    ensure_secure_ledger_workspace(&ledger_workspace)?;
    let keyring_root = root.join(KEYRING_DIRECTORY);
    ensure_secure_directory(&keyring_root)?;

    let key_ref = KeyringRef::new(
        DEFAULT_KERNEL_ACTOR_ID.to_string(),
        DEFAULT_KERNEL_KEY_ID.to_string(),
    );
    let key_path = key_ref
        .path_under(&keyring_root)
        .map_err(|error| format!("resolving governed authority key path: {error}"))?;
    let key_parent = key_path
        .parent()
        .ok_or_else(|| "governed authority key path has no parent".to_string())?;
    ensure_secure_directory(key_parent)?;

    let mut seed = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut seed))
        .map_err(|error| format!("reading host random source for governed authority: {error}"))?;
    let signing_key = SigningKey::from_bytes(&seed);
    write_new_secure_file(&key_path, &seed)?;
    let public_hash = public_key_hash(&signing_key.verifying_key());
    let realm_id = uuid::Uuid::now_v7().to_string();
    let realm_digest = realm_digest(
        &realm_id,
        DEFAULT_KERNEL_ACTOR_ID,
        DEFAULT_KERNEL_KEY_ID,
        &public_hash,
    )?;
    let config = RealmConfigV1 {
        schema_version: REALM_SCHEMA_VERSION,
        realm_id,
        kernel_actor_id: DEFAULT_KERNEL_ACTOR_ID.to_string(),
        kernel_key_id: DEFAULT_KERNEL_KEY_ID.to_string(),
        kernel_public_key_hash: public_hash,
        realm_digest,
    };
    let config_bytes = serde_json::to_vec(&config)
        .map_err(|error| format!("serializing governed authority realm config: {error}"))?;
    write_new_secure_file(&config_path, &config_bytes)?;
    load_governed_authority_realm()
}

/// Inspect the separately provisioned reviewer authority for the current
/// kernel realm. This never provisions a reviewer: a missing, malformed, or
/// stale reviewer configuration is a governed-review blocker.
pub fn load_governed_reviewer_authority() -> Result<GovernedReviewerAuthorityV1, String> {
    let realm = load_governed_authority_realm()?;
    load_governed_reviewer_authority_for_realm(&realm)
}

/// Load the reviewer authority only when it has been explicitly provisioned.
///
/// This is deliberately different from [`load_governed_reviewer_authority`]:
/// an absent config is the sole non-error outcome so kernel-only legacy tapes
/// remain replayable. Once a reviewer config path exists, every malformed,
/// insecure, stale, or mismatched state remains a hard error; callers must
/// never treat a broken reviewer root as if review authority were optional.
pub fn load_optional_governed_reviewer_authority(
) -> Result<Option<GovernedReviewerAuthorityV1>, String> {
    let realm = load_governed_authority_realm()?;
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(REVIEWER_AUTHORITY_CONFIG_FILE);
    match fs::symlink_metadata(&config_path) {
        Ok(_) => load_governed_reviewer_authority_for_realm(&realm).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Absence is safe only before reviewer provisioning has left any
            // durable state. A final key or the write-ahead transaction means
            // a provision was interrupted (or state was tampered with), not
            // that this is a legacy kernel-only realm. Do not let recovery
            // silently drop a reviewer trust root in that case.
            reject_incomplete_optional_reviewer_authority_state(&realm)?;
            Ok(None)
        }
        Err(error) => Err(format!(
            "reading governed reviewer authority config {}: {error}",
            config_path.display()
        )),
    }
}

/// Inspect the separately provisioned operator authority for the current
/// kernel realm. This never provisions an operator: promotion decisions remain
/// blocked until an explicit operator root exists and validates.
pub fn load_governed_operator_authority() -> Result<GovernedOperatorAuthorityV1, String> {
    let realm = load_governed_authority_realm()?;
    load_governed_operator_authority_for_realm(&realm)
}

/// Load the operator authority only when it has been explicitly provisioned.
///
/// An absent config is the sole non-error outcome so pre-promotion historical
/// tapes remain replayable. Once operator state is present, malformed,
/// insecure, stale, or incomplete state remains a hard error and must never be
/// treated as the absence of promotion authority.
pub fn load_optional_governed_operator_authority(
) -> Result<Option<GovernedOperatorAuthorityV1>, String> {
    let realm = load_governed_authority_realm()?;
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(OPERATOR_AUTHORITY_CONFIG_FILE);
    match fs::symlink_metadata(&config_path) {
        Ok(_) => load_governed_operator_authority_for_realm(&realm).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            reject_incomplete_optional_operator_authority_state(&realm)?;
            Ok(None)
        }
        Err(error) => Err(format!(
            "reading governed operator authority config {}: {error}",
            config_path.display()
        )),
    }
}

/// Explicit one-time operator provisioning for the dedicated reviewer
/// signer. The parent kernel realm must already be present and valid. Normal
/// governed execution never calls this function, so a reviewer cannot appear
/// through an execution-time fallback or an implicit key rotation.
pub fn provision_governed_reviewer_authority() -> Result<GovernedReviewerAuthorityV1, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let realm = load_governed_authority_realm()?;
    provision_governed_reviewer_authority_for_realm(&realm)
}

/// Explicit one-time operator provisioning. Normal governed execution and
/// recovery never call this function, so no worker or replay path can create
/// or rotate promotion authority as a fallback.
pub fn provision_governed_operator_authority() -> Result<GovernedOperatorAuthorityV1, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let realm = load_governed_authority_realm()?;
    provision_governed_operator_authority_for_realm(&realm)
}

/// Load the private reviewer key only when it still exactly matches the
/// protected reviewer configuration and its parent kernel realm. Re-loading
/// the authority here prevents a stale in-memory authority object from being
/// used after an operator has changed or removed protected configuration.
pub fn load_governed_reviewer_authority_signing_key(
    authority: &GovernedReviewerAuthorityV1,
) -> Result<SigningKey, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let pinned = load_governed_reviewer_authority()?;
    if &pinned != authority {
        return Err("realm-pinned reviewer authority changed after initialization".to_string());
    }

    let key_ref = KeyringRef::new(
        authority.reviewer_signer.actor_id.clone(),
        authority.reviewer_signer.key_id.clone(),
    );
    let key_path = key_ref
        .path_under(&authority.keyring_root)
        .map_err(|error| format!("resolving realm-pinned reviewer key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed reviewer authority signing key")?;
    let key = load_signing_key_at(&authority.keyring_root, &key_ref)
        .map_err(|error| format!("loading realm-pinned governed reviewer key: {error}"))?;
    let actual_hash = public_key_hash(&key.verifying_key());
    if authority.reviewer_signer.public_key_hash.as_deref() != Some(actual_hash.as_str()) {
        return Err("realm-pinned governed reviewer key changed after initialization".to_string());
    }
    Ok(key)
}

/// Load the private operator key only when it still exactly matches the
/// protected operator configuration and its parent kernel realm.
pub fn load_governed_operator_authority_signing_key(
    authority: &GovernedOperatorAuthorityV1,
) -> Result<SigningKey, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let pinned = load_governed_operator_authority()?;
    if &pinned != authority {
        return Err("realm-pinned operator authority changed after initialization".to_string());
    }

    let key_ref = KeyringRef::new(
        authority.operator_signer.actor_id.clone(),
        authority.operator_signer.key_id.clone(),
    );
    let key_path = key_ref
        .path_under(&authority.keyring_root)
        .map_err(|error| format!("resolving realm-pinned operator key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed operator authority signing key")?;
    let key = load_signing_key_at(&authority.keyring_root, &key_ref)
        .map_err(|error| format!("loading realm-pinned governed operator key: {error}"))?;
    let actual_hash = public_key_hash(&key.verifying_key());
    if authority.operator_signer.public_key_hash.as_deref() != Some(actual_hash.as_str()) {
        return Err("realm-pinned operator key changed after initialization".to_string());
    }
    Ok(key)
}

pub fn load_governed_authority_signing_key(
    realm: &GovernedAuthorityRealmV1,
) -> Result<SigningKey, String> {
    require_isolated_authority_broker_for_private_signing()?;
    let key_ref = KeyringRef::new(
        realm.kernel_signer.actor_id.clone(),
        realm.kernel_signer.key_id.clone(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving realm-pinned governed authority key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed authority signing key")?;
    let key = load_signing_key_at(&realm.keyring_root, &key_ref)
        .map_err(|error| format!("loading realm-pinned governed authority key: {error}"))?;
    let actual_hash = public_key_hash(&key.verifying_key());
    if realm.kernel_signer.public_key_hash.as_deref() != Some(actual_hash.as_str()) {
        return Err("realm-pinned governed authority key changed after initialization".to_string());
    }
    Ok(key)
}

/// A file readable by the invoking user cannot protect a signer from an
/// ambient worker running as that user. Keep the local implementation only
/// for deterministic tests while the production path is wired to a broker
/// whose private keys and mutable ledger state live behind a distinct OS or
/// hardware trust boundary.
fn require_isolated_authority_broker_for_private_signing() -> Result<(), String> {
    require_isolated_authority_broker(cfg!(test))
}

fn require_isolated_authority_broker(test_fixture_backend: bool) -> Result<(), String> {
    if test_fixture_backend {
        Ok(())
    } else {
        Err(GOVERNED_AUTHORITY_BROKER_REQUIRED.to_string())
    }
}

fn load_governed_reviewer_authority_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<GovernedReviewerAuthorityV1, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(REVIEWER_AUTHORITY_CONFIG_FILE);
    assert_secure_regular_file(&config_path, "governed reviewer authority config")?;
    let config: ReviewerAuthorityConfigV1 = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("reading governed reviewer authority config: {error}"))?,
    )
    .map_err(|error| format!("parsing governed reviewer authority config: {error}"))?;
    validate_reviewer_authority_config(&config, realm)?;
    ensure_reviewer_authority_is_distinct_from_optional_operator(
        realm,
        &config.reviewer_public_key_hash,
    )?;

    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    let key_ref = KeyringRef::new(
        config.reviewer_actor_id.clone(),
        config.reviewer_key_id.clone(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed reviewer authority key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed reviewer authority signing key")?;
    let signing_key = load_signing_key_at(&realm.keyring_root, &key_ref)
        .map_err(|error| format!("loading governed reviewer authority signing key: {error}"))?;
    let actual_hash = public_key_hash(&signing_key.verifying_key());
    if actual_hash != config.reviewer_public_key_hash {
        return Err(
            "governed reviewer authority signing key does not match the authority-pinned public key hash"
                .to_string(),
        );
    }

    Ok(GovernedReviewerAuthorityV1 {
        authority_digest: config.authority_digest,
        parent_realm_digest: config.parent_realm_digest,
        keyring_root: realm.keyring_root.clone(),
        reviewer_signer: ActorKeyRef {
            actor_id: config.reviewer_actor_id,
            key_id: config.reviewer_key_id,
            public_key_hash: Some(actual_hash),
        },
    })
}

/// An absent reviewer config is a legacy-compatible state only when the fixed
/// reviewer identity has no final key and no write-ahead provision record. The
/// key identity is intentionally fixed, so this check does not enumerate
/// arbitrary keyring contents or adopt caller-controlled state.
fn reject_incomplete_optional_reviewer_authority_state(
    realm: &GovernedAuthorityRealmV1,
) -> Result<(), String> {
    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    let key_ref = KeyringRef::new(
        DEFAULT_REVIEWER_ACTOR_ID.to_string(),
        DEFAULT_REVIEWER_KEY_ID.to_string(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed reviewer authority key path: {error}"))?;
    let key_parent = key_path
        .parent()
        .ok_or_else(|| "governed reviewer authority key path has no parent".to_string())?;
    assert_secure_directory_if_present(key_parent, "governed reviewer authority key directory")?;
    let pending_transaction_path = pending_authority_file_path(&key_path)?;
    let final_key_exists =
        secure_regular_file_exists(&key_path, "governed reviewer authority signing key")?;
    let pending_transaction_exists = secure_regular_file_exists(
        &pending_transaction_path,
        "pending governed reviewer authority provisioning record",
    )?;
    if final_key_exists || pending_transaction_exists {
        return Err(
            "incomplete governed reviewer provisioning state: reviewer config is absent while a final reviewer key or pending provisioning record exists"
                .to_string(),
        );
    }
    Ok(())
}

fn load_governed_operator_authority_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<GovernedOperatorAuthorityV1, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(OPERATOR_AUTHORITY_CONFIG_FILE);
    assert_secure_regular_file(&config_path, "governed operator authority config")?;
    let config: OperatorAuthorityConfigV1 = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("reading governed operator authority config: {error}"))?,
    )
    .map_err(|error| format!("parsing governed operator authority config: {error}"))?;
    validate_operator_authority_config(&config, realm)?;
    ensure_operator_authority_is_distinct_from_optional_reviewer(
        realm,
        &config.operator_public_key_hash,
    )?;

    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    let key_ref = KeyringRef::new(
        config.operator_actor_id.clone(),
        config.operator_key_id.clone(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed operator authority key path: {error}"))?;
    assert_secure_regular_file(&key_path, "governed operator authority signing key")?;
    let signing_key = load_signing_key_at(&realm.keyring_root, &key_ref)
        .map_err(|error| format!("loading governed operator authority signing key: {error}"))?;
    let actual_hash = public_key_hash(&signing_key.verifying_key());
    if actual_hash != config.operator_public_key_hash {
        return Err(
            "governed operator authority signing key does not match the authority-pinned public key hash"
                .to_string(),
        );
    }

    Ok(GovernedOperatorAuthorityV1 {
        authority_digest: config.authority_digest,
        parent_realm_digest: config.parent_realm_digest,
        keyring_root: realm.keyring_root.clone(),
        operator_signer: ActorKeyRef {
            actor_id: config.operator_actor_id,
            key_id: config.operator_key_id,
            public_key_hash: Some(actual_hash),
        },
    })
}

/// An absent operator config is legacy-compatible only when the fixed operator
/// identity has no final key and no write-ahead provision record.
fn reject_incomplete_optional_operator_authority_state(
    realm: &GovernedAuthorityRealmV1,
) -> Result<(), String> {
    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    let key_ref = KeyringRef::new(
        DEFAULT_OPERATOR_ACTOR_ID.to_string(),
        DEFAULT_OPERATOR_KEY_ID.to_string(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed operator authority key path: {error}"))?;
    let key_parent = key_path
        .parent()
        .ok_or_else(|| "governed operator authority key path has no parent".to_string())?;
    assert_secure_directory_if_present(key_parent, "governed operator authority key directory")?;
    let pending_transaction_path = pending_authority_file_path(&key_path)?;
    let final_key_exists =
        secure_regular_file_exists(&key_path, "governed operator authority signing key")?;
    let pending_transaction_exists = secure_regular_file_exists(
        &pending_transaction_path,
        "pending governed operator authority provisioning record",
    )?;
    if final_key_exists || pending_transaction_exists {
        return Err(
            "incomplete governed operator provisioning state: operator config is absent while a final operator key or pending provisioning record exists"
                .to_string(),
        );
    }
    Ok(())
}

/// Read a sibling authority configuration without loading its private key.
/// This lets each role reject shared public keys during provision and load
/// without a recursive reviewer-to-operator loader call. A sibling that has
/// started provisioning but is not complete is a hard failure rather than an
/// optional absence: it must be repaired before either role can become
/// trusted.
fn optional_reviewer_authority_config_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<Option<ReviewerAuthorityConfigV1>, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(REVIEWER_AUTHORITY_CONFIG_FILE);
    if !secure_regular_file_exists(&config_path, "governed reviewer authority config")? {
        reject_incomplete_optional_reviewer_authority_state(realm)?;
        return Ok(None);
    }
    let config: ReviewerAuthorityConfigV1 = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("reading governed reviewer authority config: {error}"))?,
    )
    .map_err(|error| format!("parsing governed reviewer authority config: {error}"))?;
    validate_reviewer_authority_config(&config, realm)?;
    Ok(Some(config))
}

fn optional_operator_authority_config_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<Option<OperatorAuthorityConfigV1>, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(OPERATOR_AUTHORITY_CONFIG_FILE);
    if !secure_regular_file_exists(&config_path, "governed operator authority config")? {
        reject_incomplete_optional_operator_authority_state(realm)?;
        return Ok(None);
    }
    let config: OperatorAuthorityConfigV1 = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("reading governed operator authority config: {error}"))?,
    )
    .map_err(|error| format!("parsing governed operator authority config: {error}"))?;
    validate_operator_authority_config(&config, realm)?;
    Ok(Some(config))
}

fn ensure_reviewer_authority_is_distinct_from_optional_operator(
    realm: &GovernedAuthorityRealmV1,
    reviewer_public_key_hash: &str,
) -> Result<(), String> {
    let operator = optional_operator_authority_config_for_realm(realm)?;
    reject_cross_role_authority_key_reuse(
        "reviewer",
        reviewer_public_key_hash,
        "operator",
        operator
            .as_ref()
            .map(|config| config.operator_public_key_hash.as_str()),
    )
}

fn ensure_operator_authority_is_distinct_from_optional_reviewer(
    realm: &GovernedAuthorityRealmV1,
    operator_public_key_hash: &str,
) -> Result<(), String> {
    let reviewer = optional_reviewer_authority_config_for_realm(realm)?;
    reject_cross_role_authority_key_reuse(
        "operator",
        operator_public_key_hash,
        "reviewer",
        reviewer
            .as_ref()
            .map(|config| config.reviewer_public_key_hash.as_str()),
    )
}

fn reject_cross_role_authority_key_reuse(
    role: &str,
    public_key_hash: &str,
    sibling_role: &str,
    sibling_public_key_hash: Option<&str>,
) -> Result<(), String> {
    if sibling_public_key_hash == Some(public_key_hash) {
        return Err(format!(
            "governed {role} authority public key must differ from the existing {sibling_role} authority signing key"
        ));
    }
    Ok(())
}

fn provision_governed_reviewer_authority_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<GovernedReviewerAuthorityV1, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(REVIEWER_AUTHORITY_CONFIG_FILE);
    if secure_regular_file_exists(&config_path, "governed reviewer authority config")? {
        return Err(
            "a governed reviewer authority is already provisioned; refusing to overwrite or rotate it implicitly"
                .to_string(),
        );
    }
    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    if realm.kernel_signer.actor_id == DEFAULT_REVIEWER_ACTOR_ID {
        return Err(
            "cannot provision governed reviewer authority because the kernel actor uses the reviewer identity"
                .to_string(),
        );
    }

    let key_ref = KeyringRef::new(
        DEFAULT_REVIEWER_ACTOR_ID.to_string(),
        DEFAULT_REVIEWER_KEY_ID.to_string(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed reviewer authority key path: {error}"))?;
    let key_parent = key_path
        .parent()
        .ok_or_else(|| "governed reviewer authority key path has no parent".to_string())?;
    ensure_secure_directory(key_parent)?;
    let pending_transaction_path = pending_authority_file_path(&key_path)?;

    let final_key_exists =
        secure_regular_file_exists(&key_path, "governed reviewer authority signing key")?;
    let pending_transaction_exists = secure_regular_file_exists(
        &pending_transaction_path,
        "pending governed reviewer authority provisioning record",
    )?;

    if final_key_exists || pending_transaction_exists {
        if !pending_transaction_exists {
            return Err(
                "incomplete governed reviewer provisioning state; refusing to adopt or rotate a pre-existing reviewer key"
                    .to_string(),
            );
        }
        return resume_governed_reviewer_authority_provision(
            realm,
            &key_ref,
            &key_path,
            &config_path,
            &pending_transaction_path,
            final_key_exists,
        );
    }

    let mut seed = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut seed))
        .map_err(|error| {
            format!("reading host random source for governed reviewer authority: {error}")
        })?;
    let config = reviewer_authority_config_for_key(realm, &SigningKey::from_bytes(&seed))?;
    ensure_reviewer_authority_is_distinct_from_optional_operator(
        realm,
        &config.reviewer_public_key_hash,
    )?;
    let pending = PendingReviewerAuthorityProvisionV1 {
        schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
        config,
        seed,
    };
    let pending_bytes = serde_json::to_vec(&pending).map_err(|error| {
        format!("serializing pending governed reviewer authority provision: {error}")
    })?;

    // This write-ahead record is intentionally a single secure artifact: a
    // retry can resume the exact seed/config pair, while a lone final key is
    // never adopted as reviewer authority.
    write_new_secure_file(&pending_transaction_path, &pending_bytes)?;
    resume_governed_reviewer_authority_provision(
        realm,
        &key_ref,
        &key_path,
        &config_path,
        &pending_transaction_path,
        false,
    )
}

fn resume_governed_reviewer_authority_provision(
    realm: &GovernedAuthorityRealmV1,
    key_ref: &KeyringRef,
    key_path: &Path,
    config_path: &Path,
    pending_transaction_path: &Path,
    final_key_exists: bool,
) -> Result<GovernedReviewerAuthorityV1, String> {
    let pending = load_pending_reviewer_authority_provision(pending_transaction_path)?;
    let pending_key = validate_pending_reviewer_authority_provision(&pending, realm, key_ref)?;
    ensure_reviewer_authority_is_distinct_from_optional_operator(
        realm,
        &pending.config.reviewer_public_key_hash,
    )?;

    if final_key_exists {
        let final_key =
            load_signing_key_from_secure_file(key_path, "governed reviewer authority signing key")?;
        if final_key.to_bytes() != pending_key.to_bytes() {
            return Err(
                "final governed reviewer key does not match the pending reviewer key".to_string(),
            );
        }
    } else {
        write_new_secure_file(key_path, &pending.seed)?;
    }
    let config_bytes = serde_json::to_vec(&pending.config)
        .map_err(|error| format!("serializing governed reviewer authority config: {error}"))?;
    publish_new_secure_file(&config_path, &config_bytes)?;

    // Cleanup failure cannot retract the committed authority and must not make
    // a successful provision look failed. A stale secure transaction is not
    // consulted by normal loading and cannot grant additional authority.
    let _ = remove_secure_file_and_sync_parent(
        pending_transaction_path,
        "pending governed reviewer authority provisioning record",
    );
    load_governed_reviewer_authority_for_realm(realm)
}

fn reviewer_authority_config_for_key(
    realm: &GovernedAuthorityRealmV1,
    signing_key: &SigningKey,
) -> Result<ReviewerAuthorityConfigV1, String> {
    let public_hash = public_key_hash(&signing_key.verifying_key());
    let kernel_public_hash = realm
        .kernel_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| "governed kernel realm lacks a pinned public key hash".to_string())?;
    if public_hash == kernel_public_hash {
        return Err(
            "generated governed reviewer key must differ from the kernel signing key".to_string(),
        );
    }
    let authority_digest = reviewer_authority_digest(
        &realm.realm_digest,
        DEFAULT_REVIEWER_ACTOR_ID,
        DEFAULT_REVIEWER_KEY_ID,
        &public_hash,
    )?;
    let config = ReviewerAuthorityConfigV1 {
        schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
        parent_realm_digest: realm.realm_digest.clone(),
        reviewer_actor_id: DEFAULT_REVIEWER_ACTOR_ID.to_string(),
        reviewer_key_id: DEFAULT_REVIEWER_KEY_ID.to_string(),
        reviewer_public_key_hash: public_hash,
        authority_digest,
    };
    validate_reviewer_authority_config(&config, realm)?;
    Ok(config)
}

fn load_pending_reviewer_authority_provision(
    path: &Path,
) -> Result<PendingReviewerAuthorityProvisionV1, String> {
    assert_secure_regular_file(
        path,
        "pending governed reviewer authority provisioning record",
    )?;
    serde_json::from_slice(&fs::read(path).map_err(|error| {
        format!("reading pending governed reviewer authority provisioning record: {error}")
    })?)
    .map_err(|error| {
        format!("parsing pending governed reviewer authority provisioning record: {error}")
    })
}

fn validate_pending_reviewer_authority_provision(
    pending: &PendingReviewerAuthorityProvisionV1,
    realm: &GovernedAuthorityRealmV1,
    key_ref: &KeyringRef,
) -> Result<SigningKey, String> {
    if pending.schema_version != REVIEWER_AUTHORITY_SCHEMA_VERSION {
        return Err("unsupported pending governed reviewer authority schema version".to_string());
    }
    validate_reviewer_authority_config(&pending.config, realm)?;
    if pending.config.reviewer_actor_id != key_ref.actor_id
        || pending.config.reviewer_key_id != key_ref.key_id
    {
        return Err(
            "pending governed reviewer authority config does not match the fixed reviewer key identity"
                .to_string(),
        );
    }
    let signing_key = SigningKey::from_bytes(&pending.seed);
    let pending_hash = public_key_hash(&signing_key.verifying_key());
    if pending_hash != pending.config.reviewer_public_key_hash {
        return Err(
            "pending governed reviewer authority key does not match the pinned public key hash"
                .to_string(),
        );
    }
    Ok(signing_key)
}

fn provision_governed_operator_authority_for_realm(
    realm: &GovernedAuthorityRealmV1,
) -> Result<GovernedOperatorAuthorityV1, String> {
    let root = governed_authority_root()?;
    assert_secure_directory(&root, "governed authority root")?;
    let config_path = root.join(OPERATOR_AUTHORITY_CONFIG_FILE);
    if secure_regular_file_exists(&config_path, "governed operator authority config")? {
        return Err(
            "a governed operator authority is already provisioned; refusing to overwrite or rotate it implicitly"
                .to_string(),
        );
    }
    assert_secure_directory(&realm.keyring_root, "governed authority keyring")?;
    if realm.kernel_signer.actor_id == DEFAULT_OPERATOR_ACTOR_ID {
        return Err(
            "cannot provision governed operator authority because the kernel actor uses the operator identity"
                .to_string(),
        );
    }

    let key_ref = KeyringRef::new(
        DEFAULT_OPERATOR_ACTOR_ID.to_string(),
        DEFAULT_OPERATOR_KEY_ID.to_string(),
    );
    let key_path = key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("resolving governed operator authority key path: {error}"))?;
    let key_parent = key_path
        .parent()
        .ok_or_else(|| "governed operator authority key path has no parent".to_string())?;
    ensure_secure_directory(key_parent)?;
    let pending_transaction_path = pending_authority_file_path(&key_path)?;

    let final_key_exists =
        secure_regular_file_exists(&key_path, "governed operator authority signing key")?;
    let pending_transaction_exists = secure_regular_file_exists(
        &pending_transaction_path,
        "pending governed operator authority provisioning record",
    )?;

    if final_key_exists || pending_transaction_exists {
        if !pending_transaction_exists {
            return Err(
                "incomplete governed operator provisioning state; refusing to adopt or rotate a pre-existing operator key"
                    .to_string(),
            );
        }
        return resume_governed_operator_authority_provision(
            realm,
            &key_ref,
            &key_path,
            &config_path,
            &pending_transaction_path,
            final_key_exists,
        );
    }

    let mut seed = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut seed))
        .map_err(|error| {
            format!("reading host random source for governed operator authority: {error}")
        })?;
    let config = operator_authority_config_for_key(realm, &SigningKey::from_bytes(&seed))?;
    ensure_operator_authority_is_distinct_from_optional_reviewer(
        realm,
        &config.operator_public_key_hash,
    )?;
    let pending = PendingOperatorAuthorityProvisionV1 {
        schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
        config,
        seed,
    };
    let pending_bytes = serde_json::to_vec(&pending).map_err(|error| {
        format!("serializing pending governed operator authority provision: {error}")
    })?;

    write_new_secure_file(&pending_transaction_path, &pending_bytes)?;
    resume_governed_operator_authority_provision(
        realm,
        &key_ref,
        &key_path,
        &config_path,
        &pending_transaction_path,
        false,
    )
}

fn resume_governed_operator_authority_provision(
    realm: &GovernedAuthorityRealmV1,
    key_ref: &KeyringRef,
    key_path: &Path,
    config_path: &Path,
    pending_transaction_path: &Path,
    final_key_exists: bool,
) -> Result<GovernedOperatorAuthorityV1, String> {
    let pending = load_pending_operator_authority_provision(pending_transaction_path)?;
    let pending_key = validate_pending_operator_authority_provision(&pending, realm, key_ref)?;
    ensure_operator_authority_is_distinct_from_optional_reviewer(
        realm,
        &pending.config.operator_public_key_hash,
    )?;

    if final_key_exists {
        let final_key =
            load_signing_key_from_secure_file(key_path, "governed operator authority signing key")?;
        if final_key.to_bytes() != pending_key.to_bytes() {
            return Err(
                "final governed operator key does not match the pending operator key".to_string(),
            );
        }
    } else {
        write_new_secure_file(key_path, &pending.seed)?;
    }
    let config_bytes = serde_json::to_vec(&pending.config)
        .map_err(|error| format!("serializing governed operator authority config: {error}"))?;
    publish_new_secure_file(&config_path, &config_bytes)?;

    let _ = remove_secure_file_and_sync_parent(
        pending_transaction_path,
        "pending governed operator authority provisioning record",
    );
    load_governed_operator_authority_for_realm(realm)
}

fn operator_authority_config_for_key(
    realm: &GovernedAuthorityRealmV1,
    signing_key: &SigningKey,
) -> Result<OperatorAuthorityConfigV1, String> {
    let public_hash = public_key_hash(&signing_key.verifying_key());
    let kernel_public_hash = realm
        .kernel_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| "governed kernel realm lacks a pinned public key hash".to_string())?;
    if public_hash == kernel_public_hash {
        return Err(
            "generated governed operator key must differ from the kernel signing key".to_string(),
        );
    }
    let authority_digest = operator_authority_digest(
        &realm.realm_digest,
        DEFAULT_OPERATOR_ACTOR_ID,
        DEFAULT_OPERATOR_KEY_ID,
        &public_hash,
    )?;
    let config = OperatorAuthorityConfigV1 {
        schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
        parent_realm_digest: realm.realm_digest.clone(),
        operator_actor_id: DEFAULT_OPERATOR_ACTOR_ID.to_string(),
        operator_key_id: DEFAULT_OPERATOR_KEY_ID.to_string(),
        operator_public_key_hash: public_hash,
        authority_digest,
    };
    validate_operator_authority_config(&config, realm)?;
    Ok(config)
}

fn load_pending_operator_authority_provision(
    path: &Path,
) -> Result<PendingOperatorAuthorityProvisionV1, String> {
    assert_secure_regular_file(
        path,
        "pending governed operator authority provisioning record",
    )?;
    serde_json::from_slice(&fs::read(path).map_err(|error| {
        format!("reading pending governed operator authority provisioning record: {error}")
    })?)
    .map_err(|error| {
        format!("parsing pending governed operator authority provisioning record: {error}")
    })
}

fn validate_pending_operator_authority_provision(
    pending: &PendingOperatorAuthorityProvisionV1,
    realm: &GovernedAuthorityRealmV1,
    key_ref: &KeyringRef,
) -> Result<SigningKey, String> {
    if pending.schema_version != OPERATOR_AUTHORITY_SCHEMA_VERSION {
        return Err("unsupported pending governed operator authority schema version".to_string());
    }
    validate_operator_authority_config(&pending.config, realm)?;
    if pending.config.operator_actor_id != key_ref.actor_id
        || pending.config.operator_key_id != key_ref.key_id
    {
        return Err(
            "pending governed operator authority config does not match the fixed operator key identity"
                .to_string(),
        );
    }
    let signing_key = SigningKey::from_bytes(&pending.seed);
    let pending_hash = public_key_hash(&signing_key.verifying_key());
    if pending_hash != pending.config.operator_public_key_hash {
        return Err(
            "pending governed operator authority key does not match the pinned public key hash"
                .to_string(),
        );
    }
    Ok(signing_key)
}

fn validate_config(config: &RealmConfigV1) -> Result<(), String> {
    if config.schema_version != REALM_SCHEMA_VERSION {
        return Err("unsupported governed authority realm schema version".to_string());
    }
    if uuid::Uuid::parse_str(&config.realm_id).is_err() {
        return Err("governed authority realm_id must be a UUID".to_string());
    }
    for (label, value) in [
        ("kernel_actor_id", config.kernel_actor_id.as_str()),
        ("kernel_key_id", config.kernel_key_id.as_str()),
        (
            "kernel_public_key_hash",
            config.kernel_public_key_hash.as_str(),
        ),
        ("realm_digest", config.realm_digest.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("governed authority {label} must not be empty"));
        }
    }
    if !is_canonical_sha256(&config.kernel_public_key_hash)
        || !is_canonical_sha256(&config.realm_digest)
    {
        return Err("governed authority digest fields must be canonical sha256 values".to_string());
    }
    let expected = realm_digest(
        &config.realm_id,
        &config.kernel_actor_id,
        &config.kernel_key_id,
        &config.kernel_public_key_hash,
    )?;
    if expected != config.realm_digest {
        return Err(
            "governed authority realm digest does not match its pinned configuration".to_string(),
        );
    }
    Ok(())
}

fn validate_reviewer_authority_config(
    config: &ReviewerAuthorityConfigV1,
    realm: &GovernedAuthorityRealmV1,
) -> Result<(), String> {
    if config.schema_version != REVIEWER_AUTHORITY_SCHEMA_VERSION {
        return Err("unsupported governed reviewer authority schema version".to_string());
    }
    if !is_canonical_sha256(&realm.realm_digest) {
        return Err("governed kernel realm digest must be a canonical sha256 value".to_string());
    }
    let kernel_public_hash = realm
        .kernel_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| "governed kernel realm lacks a pinned public key hash".to_string())?;
    if !is_canonical_sha256(kernel_public_hash) {
        return Err("governed kernel public key hash must be canonical sha256".to_string());
    }
    for (label, value) in [
        ("parent_realm_digest", config.parent_realm_digest.as_str()),
        ("reviewer_actor_id", config.reviewer_actor_id.as_str()),
        ("reviewer_key_id", config.reviewer_key_id.as_str()),
        (
            "reviewer_public_key_hash",
            config.reviewer_public_key_hash.as_str(),
        ),
        ("authority_digest", config.authority_digest.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!(
                "governed reviewer authority {label} must not be empty"
            ));
        }
    }
    if !is_canonical_sha256(&config.parent_realm_digest)
        || !is_canonical_sha256(&config.reviewer_public_key_hash)
        || !is_canonical_sha256(&config.authority_digest)
    {
        return Err(
            "governed reviewer authority digest fields must be canonical sha256 values".to_string(),
        );
    }
    if config.parent_realm_digest != realm.realm_digest {
        return Err(
            "governed reviewer authority is pinned to a different kernel realm".to_string(),
        );
    }
    if config.reviewer_actor_id != DEFAULT_REVIEWER_ACTOR_ID
        || config.reviewer_key_id != DEFAULT_REVIEWER_KEY_ID
    {
        return Err(
            "governed reviewer authority must use the fixed reviewer/reviewer-main identity"
                .to_string(),
        );
    }
    // A distinct key id under the `kernel` actor would still emit events that
    // claim kernel authority. Keep the reviewer actor role separate as well as
    // pinning a separate public key.
    if config.reviewer_actor_id == realm.kernel_signer.actor_id {
        return Err(
            "governed reviewer authority actor identity must differ from the kernel actor"
                .to_string(),
        );
    }
    if config.reviewer_public_key_hash == kernel_public_hash {
        return Err(
            "governed reviewer authority public key must differ from the kernel signing key"
                .to_string(),
        );
    }
    let reviewer_key_ref = KeyringRef::new(
        config.reviewer_actor_id.clone(),
        config.reviewer_key_id.clone(),
    );
    reviewer_key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("governed reviewer authority identity is invalid: {error}"))?;

    let expected = reviewer_authority_digest(
        &config.parent_realm_digest,
        &config.reviewer_actor_id,
        &config.reviewer_key_id,
        &config.reviewer_public_key_hash,
    )?;
    if expected != config.authority_digest {
        return Err(
            "governed reviewer authority digest does not match its pinned configuration"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_operator_authority_config(
    config: &OperatorAuthorityConfigV1,
    realm: &GovernedAuthorityRealmV1,
) -> Result<(), String> {
    if config.schema_version != OPERATOR_AUTHORITY_SCHEMA_VERSION {
        return Err("unsupported governed operator authority schema version".to_string());
    }
    if !is_canonical_sha256(&realm.realm_digest) {
        return Err("governed kernel realm digest must be a canonical sha256 value".to_string());
    }
    let kernel_public_hash = realm
        .kernel_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| "governed kernel realm lacks a pinned public key hash".to_string())?;
    if !is_canonical_sha256(kernel_public_hash) {
        return Err("governed kernel public key hash must be canonical sha256".to_string());
    }
    for (label, value) in [
        ("parent_realm_digest", config.parent_realm_digest.as_str()),
        ("operator_actor_id", config.operator_actor_id.as_str()),
        ("operator_key_id", config.operator_key_id.as_str()),
        (
            "operator_public_key_hash",
            config.operator_public_key_hash.as_str(),
        ),
        ("authority_digest", config.authority_digest.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!(
                "governed operator authority {label} must not be empty"
            ));
        }
    }
    if !is_canonical_sha256(&config.parent_realm_digest)
        || !is_canonical_sha256(&config.operator_public_key_hash)
        || !is_canonical_sha256(&config.authority_digest)
    {
        return Err(
            "governed operator authority digest fields must be canonical sha256 values".to_string(),
        );
    }
    if config.parent_realm_digest != realm.realm_digest {
        return Err(
            "governed operator authority is pinned to a different kernel realm".to_string(),
        );
    }
    if config.operator_actor_id != DEFAULT_OPERATOR_ACTOR_ID
        || config.operator_key_id != DEFAULT_OPERATOR_KEY_ID
    {
        return Err(
            "governed operator authority must use the fixed operator/operator-main identity"
                .to_string(),
        );
    }
    if config.operator_actor_id == realm.kernel_signer.actor_id {
        return Err(
            "governed operator authority actor identity must differ from the kernel actor"
                .to_string(),
        );
    }
    if config.operator_public_key_hash == kernel_public_hash {
        return Err(
            "governed operator authority public key must differ from the kernel signing key"
                .to_string(),
        );
    }
    let operator_key_ref = KeyringRef::new(
        config.operator_actor_id.clone(),
        config.operator_key_id.clone(),
    );
    operator_key_ref
        .path_under(&realm.keyring_root)
        .map_err(|error| format!("governed operator authority identity is invalid: {error}"))?;

    let expected = operator_authority_digest(
        &config.parent_realm_digest,
        &config.operator_actor_id,
        &config.operator_key_id,
        &config.operator_public_key_hash,
    )?;
    if expected != config.authority_digest {
        return Err(
            "governed operator authority digest does not match its pinned configuration"
                .to_string(),
        );
    }
    Ok(())
}

fn realm_digest(
    realm_id: &str,
    actor_id: &str,
    key_id: &str,
    public_key_hash: &str,
) -> Result<String, String> {
    let material = RealmDigestMaterialV1 {
        schema_version: REALM_SCHEMA_VERSION,
        realm_id,
        kernel_actor_id: actor_id,
        kernel_key_id: key_id,
        kernel_public_key_hash: public_key_hash,
    };
    let bytes = serde_json::to_vec(&material)
        .map_err(|error| format!("serializing governed authority realm material: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(REALM_DIGEST_DOMAIN.as_bytes());
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn reviewer_authority_digest(
    parent_realm_digest: &str,
    reviewer_actor_id: &str,
    reviewer_key_id: &str,
    reviewer_public_key_hash: &str,
) -> Result<String, String> {
    let material = ReviewerAuthorityDigestMaterialV1 {
        schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
        parent_realm_digest,
        reviewer_actor_id,
        reviewer_key_id,
        reviewer_public_key_hash,
    };
    let bytes = serde_json::to_vec(&material)
        .map_err(|error| format!("serializing governed reviewer authority material: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(REVIEWER_AUTHORITY_DIGEST_DOMAIN.as_bytes());
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn operator_authority_digest(
    parent_realm_digest: &str,
    operator_actor_id: &str,
    operator_key_id: &str,
    operator_public_key_hash: &str,
) -> Result<String, String> {
    let material = OperatorAuthorityDigestMaterialV1 {
        schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
        parent_realm_digest,
        operator_actor_id,
        operator_key_id,
        operator_public_key_hash,
    };
    let bytes = serde_json::to_vec(&material)
        .map_err(|error| format!("serializing governed operator authority material: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(OPERATOR_AUTHORITY_DIGEST_DOMAIN.as_bytes());
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn governed_authority_root() -> Result<PathBuf, String> {
    #[cfg(not(target_os = "linux"))]
    {
        return Err(
            "governed authority requires Linux/WSL; no host fallback is permitted".to_string(),
        );
    }
    #[cfg(target_os = "linux")]
    {
        let uid = linux_effective_uid()?;
        let home = linux_home_for_uid(uid)?;
        let canonical_home = fs::canonicalize(&home).map_err(|error| {
            format!("canonicalizing governed authority home directory: {error}")
        })?;
        Ok(canonical_home
            .join(".local")
            .join("state")
            .join("buildplane")
            .join(REALM_DIRECTORY_NAME))
    }
}

#[cfg(target_os = "linux")]
fn linux_effective_uid() -> Result<u32, String> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("reading /proc/self/status for governed authority: {error}"))?;
    effective_uid_from_proc_status(&status)
}

/// Parse Linux' `Uid:` status line. The first numeric field is the real UID;
/// the second is the effective UID that governs the process' file authority.
#[cfg(any(target_os = "linux", test))]
fn effective_uid_from_proc_status(status: &str) -> Result<u32, String> {
    let line = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .ok_or_else(|| "missing Uid in /proc/self/status".to_string())?;
    line.split_whitespace()
        .nth(2)
        .ok_or_else(|| "missing effective Uid value in /proc/self/status".to_string())?
        .parse::<u32>()
        .map_err(|error| format!("parsing effective Uid: {error}"))
}

#[cfg(target_os = "linux")]
fn linux_home_for_uid(uid: u32) -> Result<PathBuf, String> {
    let passwd = fs::read_to_string("/etc/passwd")
        .map_err(|error| format!("reading /etc/passwd for governed authority: {error}"))?;
    for line in passwd.lines() {
        let mut fields = line.split(':');
        let _name = fields.next();
        let _password = fields.next();
        let Some(candidate_uid) = fields.next() else {
            continue;
        };
        let _gid = fields.next();
        let _gecos = fields.next();
        let Some(home) = fields.next() else {
            continue;
        };
        if candidate_uid.parse::<u32>().ok() == Some(uid) && !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    Err(format!("could not resolve a home directory for uid {uid}"))
}

fn ensure_secure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "creating governed authority directory {}: {error}",
            path.display()
        )
    })?;
    set_owner_only_permissions(path)?;
    assert_secure_directory(path, "governed authority directory")
}

fn assert_secure_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("reading {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label} must be a non-symlink directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("{label} must not grant group or other permissions"));
        }
    }
    Ok(())
}

/// Verify an optional directory without creating it. This is used while
/// deciding whether reviewer authority is genuinely absent: a missing reviewer
/// key directory is legacy-compatible, while an existing insecure or symlinked
/// directory is not.
fn assert_secure_directory_if_present(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => assert_secure_directory(path, label),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("reading {label} {}: {error}", path.display())),
    }
}

fn assert_secure_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("reading {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a non-symlink regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("{label} must not grant group or other permissions"));
        }
    }
    Ok(())
}

fn secure_regular_file_exists(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            assert_secure_regular_file(path, label)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("reading {label} {}: {error}", path.display())),
    }
}

fn pending_authority_file_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "governed role authority provisioning path {} has no UTF-8 file name",
                path.display()
            )
        })?;
    Ok(path.with_file_name(format!(".{file_name}.pending")))
}

fn load_signing_key_from_secure_file(path: &Path, label: &str) -> Result<SigningKey, String> {
    assert_secure_regular_file(path, label)?;
    let bytes =
        fs::read(path).map_err(|error| format!("reading {label} {}: {error}", path.display()))?;
    let seed: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("{label} {} is not a 32-byte ed25519 seed", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Atomically publish fully-synced configuration bytes without replacing an
/// existing final file. A crash before the link is durable leaves only a
/// secure temporary artifact; the durable role-authority transaction can retry.
fn publish_new_secure_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    if secure_regular_file_exists(path, "governed authority file")? {
        return Err(format!(
            "refusing to overwrite governed authority file {}",
            path.display()
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "governed authority file {} has no UTF-8 file name",
                path.display()
            )
        })?;
    let temporary_path =
        path.with_file_name(format!(".{file_name}.{}.pending", uuid::Uuid::now_v7()));
    write_new_secure_file(&temporary_path, contents)?;
    match fs::hard_link(&temporary_path, path) {
        Ok(()) => {}
        Err(error) => {
            return Err(format!(
                "publishing governed authority file {}: {error}",
                path.display()
            ));
        }
    }
    sync_parent_directory(path)?;
    assert_secure_regular_file(path, "governed authority file")?;
    // Cleanup does not affect the published hard link. Avoid reporting a
    // successful publish as a failure merely because temp cleanup raced with a
    // crash/recovery attempt.
    let _ =
        remove_secure_file_and_sync_parent(&temporary_path, "temporary governed authority file");
    Ok(())
}

/// The tape and CAS live below the protected realm rather than a repository
/// workspace. Create/check each directory before opening SQLite so a lax umask
/// cannot turn the authority store into a group-readable handoff directory.
fn assert_secure_ledger_workspace(ledger_workspace: &Path) -> Result<(), String> {
    let buildplane = ledger_workspace.join(".buildplane");
    assert_secure_directory(&buildplane, "governed authority .buildplane directory")?;
    let ledger = buildplane.join("ledger");
    assert_secure_directory(&ledger, "governed authority ledger directory")?;
    let objects = ledger.join("objects");
    assert_secure_directory(&objects, "governed authority ledger objects directory")
}

pub fn ensure_secure_ledger_workspace(ledger_workspace: &Path) -> Result<(), String> {
    let buildplane = ledger_workspace.join(".buildplane");
    ensure_secure_directory(&buildplane)?;
    let ledger = buildplane.join("ledger");
    ensure_secure_directory(&ledger)?;
    let objects = ledger.join("objects");
    ensure_secure_directory(&objects)
}

fn write_new_secure_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "refusing to overwrite governed authority file {}",
            path.display()
        ));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        format!(
            "creating governed authority file {}: {error}",
            path.display()
        )
    })?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            format!(
                "writing governed authority file {}: {error}",
                path.display()
            )
        })?;
    assert_secure_regular_file(path, "governed authority file")?;
    sync_parent_directory(path)
}

fn remove_secure_file_and_sync_parent(path: &Path, label: &str) -> Result<(), String> {
    assert_secure_regular_file(path, label)?;
    fs::remove_file(path)
        .map_err(|error| format!("removing {label} {}: {error}", path.display()))?;
    sync_parent_directory(path)
}

/// Directory sync makes file creation, link publication, and cleanup durable
/// across power loss on the Linux/WSL governed lane. Non-Unix builds never
/// execute governed authority provisioning and retain a no-op for tests.
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            format!(
                "governed authority file {} has no parent directory",
                path.display()
            )
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "syncing governed authority directory {}: {error}",
                    parent.display()
                )
            })?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("setting governed authority permissions: {error}"))?;
    }
    Ok(())
}

fn is_canonical_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn path_to_utf8(path: &Path, label: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{label} is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(hex: char) -> String {
        format!("sha256:{}", hex.to_string().repeat(64))
    }

    fn fixture_realm() -> GovernedAuthorityRealmV1 {
        GovernedAuthorityRealmV1 {
            realm_digest: digest('a'),
            ledger_workspace: PathBuf::from("/protected/ledger-workspace"),
            keyring_root: PathBuf::from("/protected/keys"),
            kernel_signer: ActorKeyRef {
                actor_id: "kernel".to_string(),
                key_id: "kernel-main".to_string(),
                public_key_hash: Some(digest('b')),
            },
        }
    }

    fn valid_reviewer_config(realm: &GovernedAuthorityRealmV1) -> ReviewerAuthorityConfigV1 {
        let reviewer_public_key_hash = digest('c');
        ReviewerAuthorityConfigV1 {
            schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
            parent_realm_digest: realm.realm_digest.clone(),
            reviewer_actor_id: "reviewer".to_string(),
            reviewer_key_id: "reviewer-main".to_string(),
            authority_digest: reviewer_authority_digest(
                &realm.realm_digest,
                "reviewer",
                "reviewer-main",
                &reviewer_public_key_hash,
            )
            .unwrap(),
            reviewer_public_key_hash,
        }
    }

    fn valid_operator_config(realm: &GovernedAuthorityRealmV1) -> OperatorAuthorityConfigV1 {
        let operator_public_key_hash = digest('d');
        OperatorAuthorityConfigV1 {
            schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
            parent_realm_digest: realm.realm_digest.clone(),
            operator_actor_id: DEFAULT_OPERATOR_ACTOR_ID.to_string(),
            operator_key_id: DEFAULT_OPERATOR_KEY_ID.to_string(),
            authority_digest: operator_authority_digest(
                &realm.realm_digest,
                DEFAULT_OPERATOR_ACTOR_ID,
                DEFAULT_OPERATOR_KEY_ID,
                &operator_public_key_hash,
            )
            .unwrap(),
            operator_public_key_hash,
        }
    }

    #[test]
    fn parses_effective_uid_not_real_uid() {
        let status = "Name:\tbuildplane\nUid:\t1000\t2000\t3000\t4000\n";

        assert_eq!(effective_uid_from_proc_status(status).unwrap(), 2000);
    }

    #[test]
    fn rejects_a_missing_uid_line() {
        assert!(effective_uid_from_proc_status("Name:\tbuildplane\n").is_err());
    }

    #[test]
    fn production_rejects_the_same_uid_file_backed_authority_backend() {
        let error = require_isolated_authority_broker(false).unwrap_err();
        assert_eq!(error, GOVERNED_AUTHORITY_BROKER_REQUIRED);
        require_isolated_authority_broker(true)
            .expect("deterministic fixture backend remains available to native unit tests");
    }

    #[test]
    fn reviewer_authority_digest_canonically_binds_the_parent_and_identity() {
        let realm = fixture_realm();
        let config = valid_reviewer_config(&realm);

        validate_reviewer_authority_config(&config, &realm).unwrap();
        assert_eq!(
            config.authority_digest,
            reviewer_authority_digest(
                &config.parent_realm_digest,
                &config.reviewer_actor_id,
                &config.reviewer_key_id,
                &config.reviewer_public_key_hash,
            )
            .unwrap()
        );
        assert_ne!(
            config.authority_digest,
            reviewer_authority_digest(
                &digest('d'),
                &config.reviewer_actor_id,
                &config.reviewer_key_id,
                &config.reviewer_public_key_hash,
            )
            .unwrap()
        );
    }

    #[test]
    fn operator_authority_digest_canonically_binds_the_parent_and_fixed_identity() {
        let realm = fixture_realm();
        let config = valid_operator_config(&realm);

        validate_operator_authority_config(&config, &realm).unwrap();
        assert_eq!(
            config.authority_digest,
            operator_authority_digest(
                &config.parent_realm_digest,
                &config.operator_actor_id,
                &config.operator_key_id,
                &config.operator_public_key_hash,
            )
            .unwrap()
        );
        assert_ne!(
            config.authority_digest,
            operator_authority_digest(
                &digest('e'),
                &config.operator_actor_id,
                &config.operator_key_id,
                &config.operator_public_key_hash,
            )
            .unwrap()
        );
    }

    #[test]
    fn operator_authority_rejects_reviewer_identity_and_kernel_key_reuse() {
        let realm = fixture_realm();
        let mut config = valid_operator_config(&realm);
        config.operator_actor_id = DEFAULT_REVIEWER_ACTOR_ID.to_string();
        config.operator_key_id = DEFAULT_REVIEWER_KEY_ID.to_string();
        config.authority_digest = operator_authority_digest(
            &config.parent_realm_digest,
            &config.operator_actor_id,
            &config.operator_key_id,
            &config.operator_public_key_hash,
        )
        .unwrap();
        let error = validate_operator_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("fixed operator"), "error: {error}");

        let mut config = valid_operator_config(&realm);
        config.operator_public_key_hash = realm
            .kernel_signer
            .public_key_hash
            .clone()
            .expect("fixture kernel hash");
        config.authority_digest = operator_authority_digest(
            &config.parent_realm_digest,
            &config.operator_actor_id,
            &config.operator_key_id,
            &config.operator_public_key_hash,
        )
        .unwrap();
        let error = validate_operator_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("public key must differ"), "error: {error}");
    }

    #[test]
    fn operator_authority_rejects_an_existing_reviewer_key_even_when_each_config_is_valid() {
        let realm = fixture_realm();
        let reviewer = valid_reviewer_config(&realm);
        let mut operator = valid_operator_config(&realm);
        operator.operator_public_key_hash = reviewer.reviewer_public_key_hash.clone();
        operator.authority_digest = operator_authority_digest(
            &operator.parent_realm_digest,
            &operator.operator_actor_id,
            &operator.operator_key_id,
            &operator.operator_public_key_hash,
        )
        .unwrap();

        // The individual config is self-consistent; the sibling-root check is
        // what prevents a shared key from crossing the review/promotion role
        // boundary during provisioning or later load.
        validate_operator_authority_config(&operator, &realm).unwrap();
        let error = reject_cross_role_authority_key_reuse(
            "operator",
            &operator.operator_public_key_hash,
            "reviewer",
            Some(&reviewer.reviewer_public_key_hash),
        )
        .unwrap_err();
        assert!(error.contains("existing reviewer"), "error: {error}");
    }

    #[test]
    fn operator_authority_config_and_pending_record_are_closed() {
        let realm = fixture_realm();
        let config = valid_operator_config(&realm);
        let mut value = serde_json::to_value(config).unwrap();
        value
            .as_object_mut()
            .expect("operator config object")
            .insert(
                "unexpected_authority".to_string(),
                serde_json::Value::Bool(true),
            );
        let error = serde_json::from_value::<OperatorAuthorityConfigV1>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "error: {error}"
        );

        let signing_key = SigningKey::from_bytes(&[41_u8; 32]);
        let pending = PendingOperatorAuthorityProvisionV1 {
            schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
            config: operator_authority_config_for_key(&realm, &signing_key).unwrap(),
            seed: signing_key.to_bytes(),
        };
        let mut value = serde_json::to_value(pending).unwrap();
        value
            .as_object_mut()
            .expect("pending operator provision object")
            .insert(
                "unexpected_authority".to_string(),
                serde_json::Value::Bool(true),
            );
        let error =
            serde_json::from_value::<PendingOperatorAuthorityProvisionV1>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "error: {error}"
        );
    }

    #[test]
    fn pending_operator_provision_rejects_a_seed_that_does_not_match_its_config() {
        let realm = fixture_realm();
        let configured_key = SigningKey::from_bytes(&[43_u8; 32]);
        let pending = PendingOperatorAuthorityProvisionV1 {
            schema_version: OPERATOR_AUTHORITY_SCHEMA_VERSION,
            config: operator_authority_config_for_key(&realm, &configured_key).unwrap(),
            seed: [44_u8; 32],
        };
        let key_ref = KeyringRef::new(DEFAULT_OPERATOR_ACTOR_ID, DEFAULT_OPERATOR_KEY_ID);

        let error =
            validate_pending_operator_authority_provision(&pending, &realm, &key_ref).unwrap_err();
        assert!(error.contains("does not match"), "error: {error}");
    }

    #[test]
    fn reviewer_authority_rejects_a_different_parent_realm_even_with_a_valid_digest() {
        let realm = fixture_realm();
        let mut config = valid_reviewer_config(&realm);
        config.parent_realm_digest = digest('d');
        config.authority_digest = reviewer_authority_digest(
            &config.parent_realm_digest,
            &config.reviewer_actor_id,
            &config.reviewer_key_id,
            &config.reviewer_public_key_hash,
        )
        .unwrap();

        let error = validate_reviewer_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("different kernel realm"), "error: {error}");
    }

    #[test]
    fn reviewer_authority_rejects_non_fixed_role_identity() {
        let realm = fixture_realm();
        let mut config = valid_reviewer_config(&realm);
        config.reviewer_actor_id = realm.kernel_signer.actor_id.clone();
        config.reviewer_key_id = "reviewer-secondary".to_string();
        config.authority_digest = reviewer_authority_digest(
            &config.parent_realm_digest,
            &config.reviewer_actor_id,
            &config.reviewer_key_id,
            &config.reviewer_public_key_hash,
        )
        .unwrap();

        let error = validate_reviewer_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("fixed reviewer"), "error: {error}");
    }

    #[test]
    fn reviewer_authority_rejects_the_kernel_public_key_under_a_reviewer_name() {
        let realm = fixture_realm();
        let mut config = valid_reviewer_config(&realm);
        config.reviewer_public_key_hash = realm
            .kernel_signer
            .public_key_hash
            .clone()
            .expect("fixture kernel hash");
        config.authority_digest = reviewer_authority_digest(
            &config.parent_realm_digest,
            &config.reviewer_actor_id,
            &config.reviewer_key_id,
            &config.reviewer_public_key_hash,
        )
        .unwrap();

        let error = validate_reviewer_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("public key must differ"), "error: {error}");
    }

    #[test]
    fn reviewer_provision_config_rejects_a_key_equal_to_the_kernel_key() {
        let mut realm = fixture_realm();
        let kernel_key = SigningKey::from_bytes(&[23_u8; 32]);
        realm.kernel_signer.public_key_hash = Some(public_key_hash(&kernel_key.verifying_key()));

        let error = reviewer_authority_config_for_key(&realm, &kernel_key).unwrap_err();
        assert!(error.contains("must differ"), "error: {error}");
    }

    #[test]
    fn pending_reviewer_provision_rejects_a_seed_that_does_not_match_its_config() {
        let realm = fixture_realm();
        let configured_key = SigningKey::from_bytes(&[31_u8; 32]);
        let pending = PendingReviewerAuthorityProvisionV1 {
            schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
            config: reviewer_authority_config_for_key(&realm, &configured_key).unwrap(),
            seed: [32_u8; 32],
        };
        let key_ref = KeyringRef::new(DEFAULT_REVIEWER_ACTOR_ID, DEFAULT_REVIEWER_KEY_ID);

        let error =
            validate_pending_reviewer_authority_provision(&pending, &realm, &key_ref).unwrap_err();
        assert!(error.contains("does not match"), "error: {error}");
    }

    #[test]
    fn reviewer_authority_rejects_unsafe_keyring_identity_and_tampered_digest() {
        let realm = fixture_realm();
        let mut config = valid_reviewer_config(&realm);
        config.reviewer_actor_id = "../../kernel".to_string();
        config.authority_digest = reviewer_authority_digest(
            &config.parent_realm_digest,
            &config.reviewer_actor_id,
            &config.reviewer_key_id,
            &config.reviewer_public_key_hash,
        )
        .unwrap();
        let error = validate_reviewer_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("fixed reviewer"), "error: {error}");

        let mut config = valid_reviewer_config(&realm);
        config.authority_digest = digest('d');
        let error = validate_reviewer_authority_config(&config, &realm).unwrap_err();
        assert!(error.contains("digest does not match"), "error: {error}");
    }

    #[test]
    fn reviewer_authority_config_is_closed_to_unknown_fields() {
        let realm = fixture_realm();
        let config = valid_reviewer_config(&realm);
        let mut value = serde_json::to_value(config).unwrap();
        value
            .as_object_mut()
            .expect("reviewer config object")
            .insert(
                "unexpected_authority".to_string(),
                serde_json::Value::Bool(true),
            );

        let error = serde_json::from_value::<ReviewerAuthorityConfigV1>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "error: {error}"
        );
    }

    #[test]
    fn pending_reviewer_provision_is_closed_to_unknown_fields() {
        let realm = fixture_realm();
        let signing_key = SigningKey::from_bytes(&[37_u8; 32]);
        let pending = PendingReviewerAuthorityProvisionV1 {
            schema_version: REVIEWER_AUTHORITY_SCHEMA_VERSION,
            config: reviewer_authority_config_for_key(&realm, &signing_key).unwrap(),
            seed: signing_key.to_bytes(),
        };
        let mut value = serde_json::to_value(pending).unwrap();
        value
            .as_object_mut()
            .expect("pending reviewer provision object")
            .insert(
                "unexpected_authority".to_string(),
                serde_json::Value::Bool(true),
            );

        let error =
            serde_json::from_value::<PendingReviewerAuthorityProvisionV1>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "error: {error}"
        );
    }

    #[test]
    fn optional_reviewer_authority_rejects_incomplete_provisioning_artifacts() {
        let temporary_root = tempfile::tempdir().unwrap();
        let keyring_root = temporary_root.path().join("keys");
        ensure_secure_directory(&keyring_root).unwrap();
        let mut realm = fixture_realm();
        realm.keyring_root = keyring_root.clone();
        let key_ref = KeyringRef::new(DEFAULT_REVIEWER_ACTOR_ID, DEFAULT_REVIEWER_KEY_ID);
        let key_path = key_ref.path_under(&keyring_root).unwrap();
        let key_parent = key_path.parent().expect("reviewer key parent");
        ensure_secure_directory(key_parent).unwrap();

        // A genuinely clean realm remains eligible for kernel-only legacy
        // replay, but either durable provisioning artifact is a hard error.
        reject_incomplete_optional_reviewer_authority_state(&realm).unwrap();

        write_new_secure_file(&key_path, &[7_u8; 32]).unwrap();
        let error = reject_incomplete_optional_reviewer_authority_state(&realm).unwrap_err();
        assert!(error.contains("incomplete governed reviewer provisioning"));
        fs::remove_file(&key_path).unwrap();

        let pending_path = pending_authority_file_path(&key_path).unwrap();
        write_new_secure_file(&pending_path, b"pending").unwrap();
        let error = reject_incomplete_optional_reviewer_authority_state(&realm).unwrap_err();
        assert!(error.contains("incomplete governed reviewer provisioning"));
    }

    #[test]
    fn optional_operator_authority_rejects_incomplete_provisioning_artifacts() {
        let temporary_root = tempfile::tempdir().unwrap();
        let keyring_root = temporary_root.path().join("keys");
        ensure_secure_directory(&keyring_root).unwrap();
        let mut realm = fixture_realm();
        realm.keyring_root = keyring_root.clone();
        let key_ref = KeyringRef::new(DEFAULT_OPERATOR_ACTOR_ID, DEFAULT_OPERATOR_KEY_ID);
        let key_path = key_ref.path_under(&keyring_root).unwrap();
        let key_parent = key_path.parent().expect("operator key parent");
        ensure_secure_directory(key_parent).unwrap();

        reject_incomplete_optional_operator_authority_state(&realm).unwrap();

        write_new_secure_file(&key_path, &[11_u8; 32]).unwrap();
        let error = reject_incomplete_optional_operator_authority_state(&realm).unwrap_err();
        assert!(error.contains("incomplete governed operator provisioning"));
        fs::remove_file(&key_path).unwrap();

        let pending_path = pending_authority_file_path(&key_path).unwrap();
        write_new_secure_file(&pending_path, b"pending").unwrap();
        let error = reject_incomplete_optional_operator_authority_state(&realm).unwrap_err();
        assert!(error.contains("incomplete governed operator provisioning"));
    }

    #[test]
    fn reviewer_authority_projection_never_exposes_the_keyring_root() {
        let authority_digest = digest('d');
        let parent_realm_digest = digest('a');
        let authority = GovernedReviewerAuthorityV1 {
            authority_digest: authority_digest.clone(),
            parent_realm_digest: parent_realm_digest.clone(),
            keyring_root: PathBuf::from("/protected/keys"),
            reviewer_signer: ActorKeyRef {
                actor_id: "reviewer".to_string(),
                key_id: "reviewer-main".to_string(),
                public_key_hash: Some(digest('c')),
            },
        };

        let value = serde_json::to_value(authority.projection()).unwrap();
        let object = value.as_object().expect("reviewer projection object");
        assert_eq!(
            object
                .get("schema_version")
                .and_then(serde_json::Value::as_u64),
            Some(u64::from(REVIEWER_AUTHORITY_SCHEMA_VERSION))
        );
        assert_eq!(
            object
                .get("authority_digest")
                .and_then(serde_json::Value::as_str),
            Some(authority_digest.as_str())
        );
        assert_eq!(
            object
                .get("parent_realm_digest")
                .and_then(serde_json::Value::as_str),
            Some(parent_realm_digest.as_str())
        );
        assert!(object.contains_key("reviewer_signer"));
        assert!(!object.contains_key("keyring_root"));
        assert!(!value.to_string().contains("/protected/keys"));
    }

    #[test]
    fn operator_authority_projection_never_exposes_the_keyring_root() {
        let authority_digest = digest('e');
        let parent_realm_digest = digest('a');
        let authority = GovernedOperatorAuthorityV1 {
            authority_digest: authority_digest.clone(),
            parent_realm_digest: parent_realm_digest.clone(),
            keyring_root: PathBuf::from("/protected/keys"),
            operator_signer: ActorKeyRef {
                actor_id: DEFAULT_OPERATOR_ACTOR_ID.to_string(),
                key_id: DEFAULT_OPERATOR_KEY_ID.to_string(),
                public_key_hash: Some(digest('d')),
            },
        };

        let value = serde_json::to_value(authority.projection()).unwrap();
        let object = value.as_object().expect("operator projection object");
        assert_eq!(
            object
                .get("schema_version")
                .and_then(serde_json::Value::as_u64),
            Some(u64::from(OPERATOR_AUTHORITY_SCHEMA_VERSION))
        );
        assert_eq!(
            object
                .get("authority_digest")
                .and_then(serde_json::Value::as_str),
            Some(authority_digest.as_str())
        );
        assert_eq!(
            object
                .get("parent_realm_digest")
                .and_then(serde_json::Value::as_str),
            Some(parent_realm_digest.as_str())
        );
        assert!(object.contains_key("operator_signer"));
        assert!(!object.contains_key("keyring_root"));
        assert!(!value.to_string().contains("/protected/keys"));
    }

    #[test]
    fn secure_pending_publication_never_overwrites_an_existing_file() {
        let temporary_root = tempfile::tempdir().unwrap();
        let config_path = temporary_root.path().join("reviewer-authority-v1.json");

        publish_new_secure_file(&config_path, b"first").unwrap();
        assert_eq!(fs::read(&config_path).unwrap(), b"first");

        let error = publish_new_secure_file(&config_path, b"second").unwrap_err();
        assert!(error.contains("refusing to overwrite"), "error: {error}");
        assert_eq!(fs::read(&config_path).unwrap(), b"first");
    }

    #[test]
    fn pending_transaction_path_stays_in_the_reviewer_key_directory() {
        let key_path = PathBuf::from("/protected/keys/reviewer/reviewer-main.ed25519");
        let pending = pending_authority_file_path(&key_path).unwrap();

        assert_eq!(
            pending,
            PathBuf::from("/protected/keys/reviewer/.reviewer-main.ed25519.pending")
        );
    }
}
