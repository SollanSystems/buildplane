//! Local per-machine ed25519 keyring loader (M1-S4).
//!
//! Resolves actor-scoped private keys under `~/.buildplane/keys/` per
//! OPERATOR-DECISION-A. Keys are stored as raw 32-byte ed25519 seeds and loaded
//! with [`SigningKey::from_bytes`]. The loader never logs private-key bytes; on
//! failure it surfaces the path it tried and an opaque reason.
//!
//! Wire boundary: only key *references/paths* cross the process boundary. The
//! ledger process loads key material locally and redacts secret-shaped values
//! from errors.

use crate::error::{LedgerError, Result};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};

/// A reference to a local private key on disk — never the key bytes themselves.
///
/// This is the only key-related value allowed to cross the process/config
/// boundary. The actual seed is loaded locally via [`load_signing_key`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyringRef {
    /// Actor that owns the key, for example `kernel`.
    pub actor_id: String,
    /// Key identifier scoped to the actor.
    pub key_id: String,
}

impl KeyringRef {
    pub fn new(actor_id: impl Into<String>, key_id: impl Into<String>) -> Self {
        Self {
            actor_id: actor_id.into(),
            key_id: key_id.into(),
        }
    }

    /// Resolve the on-disk path for this key under the given keyring root.
    ///
    /// Layout: `<root>/<actor>/<key-id>.ed25519`.
    pub fn path_under(&self, root: &Path) -> PathBuf {
        root.join(&self.actor_id)
            .join(format!("{}.ed25519", self.key_id))
    }
}

/// Resolve the default keyring root: `~/.buildplane/keys`.
///
/// `~` is resolved from `$HOME`. Tests must never depend on this — they pass an
/// explicit root via [`load_signing_key_at`].
pub fn default_keyring_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| LedgerError::InvalidPayload {
        kind: "<keyring>".into(),
        reason: "$HOME is not set; cannot resolve ~/.buildplane/keys".into(),
    })?;
    Ok(PathBuf::from(home).join(".buildplane").join("keys"))
}

/// Load a private signing key for `key_ref` from the default keyring root.
pub fn load_signing_key(key_ref: &KeyringRef) -> Result<SigningKey> {
    let root = default_keyring_root()?;
    load_signing_key_at(&root, key_ref)
}

/// Load a private signing key for `key_ref` from an explicit keyring root.
///
/// File format is a raw 32-byte ed25519 seed. Errors carry only the path that
/// was attempted and an opaque reason — never seed bytes.
pub fn load_signing_key_at(root: &Path, key_ref: &KeyringRef) -> Result<SigningKey> {
    let path = key_ref.path_under(root);
    let bytes = std::fs::read(&path).map_err(|err| LedgerError::InvalidPayload {
        kind: "<keyring>".into(),
        reason: format!("reading key at {}: {}", path.display(), err.kind()),
    })?;
    let seed: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| LedgerError::InvalidPayload {
            kind: "<keyring>".into(),
            reason: format!(
                "key at {} is not a 32-byte ed25519 seed (got {} bytes)",
                path.display(),
                bytes.len()
            ),
        })?;
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::sign_event;
    use crate::signing::ActorKeyRef;
    use crate::signing::{verify_event_signature, TrustedPublicKeys, VerificationStatus};
    use crate::event::Event;
    use crate::id::{EventId, RunId};
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use crate::payload::Payload;
    use sha2::{Digest, Sha256};

    const FIXTURE_SEED: [u8; 32] = [9u8; 32];

    fn write_fixture_key(root: &Path, actor: &str, key_id: &str, seed: &[u8]) -> PathBuf {
        let dir = root.join(actor);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{key_id}.ed25519"));
        std::fs::write(&path, seed).unwrap();
        path
    }

    fn sample_event() -> Event {
        Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: chrono::Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 1,
                event_count: 1,
                unit_count: 0,
            }),
        }
    }

    #[test]
    fn loads_deterministic_fixture_key_and_signs_verifiably() {
        let tmp = tempfile::tempdir().unwrap();
        write_fixture_key(tmp.path(), "kernel", "kernel-main", &FIXTURE_SEED);

        let key_ref = KeyringRef::new("kernel", "kernel-main");
        let signing_key = load_signing_key_at(tmp.path(), &key_ref).unwrap();

        // Loaded key must equal the deterministic fixture seed.
        assert_eq!(signing_key.to_bytes(), FIXTURE_SEED);

        let event = sample_event();
        let signature = sign_event(
            &event,
            &signing_key,
            &ActorKeyRef {
                actor_id: "kernel".into(),
                key_id: "kernel-main".into(),
                public_key_hash: None,
            },
            "2026-05-22T23:30:00Z".parse().unwrap(),
        )
        .unwrap();

        let mut trusted = TrustedPublicKeys::default();
        let hash = format!(
            "sha256:{:x}",
            Sha256::digest(signing_key.verifying_key().as_bytes())
        );
        trusted.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());

        assert_eq!(
            verify_event_signature(&event, &signature, &trusted),
            VerificationStatus::Verified
        );
    }

    #[test]
    fn missing_key_file_errors_without_leaking_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let key_ref = KeyringRef::new("kernel", "does-not-exist");
        let err = load_signing_key_at(tmp.path(), &key_ref).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("does-not-exist.ed25519"), "msg: {msg}");
    }

    #[test]
    fn wrong_length_seed_errors_without_leaking_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        // 16 bytes instead of 32 — invalid seed length.
        let secret = [0xABu8; 16];
        write_fixture_key(tmp.path(), "kernel", "short", &secret);

        let key_ref = KeyringRef::new("kernel", "short");
        let err = load_signing_key_at(tmp.path(), &key_ref).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("32-byte"), "msg: {msg}");
        // The raw secret bytes must not appear in the error.
        assert!(!msg.contains("171"), "error leaked byte value: {msg}");
        assert!(!msg.to_lowercase().contains("ab ab"), "error leaked bytes: {msg}");
    }

    #[test]
    fn path_under_uses_actor_scoped_layout() {
        let key_ref = KeyringRef::new("kernel", "kernel-main");
        let path = key_ref.path_under(Path::new("/root/keys"));
        assert!(path.ends_with("kernel/kernel-main.ed25519"));
    }
}
