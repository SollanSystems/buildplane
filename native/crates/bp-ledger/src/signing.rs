//! Detached event signature contract for the signed tape.
//!
//! M1-S1 defines the wire types. Later slices add storage, verification,
//! key management, and checkpoint emission without changing this detached
//! signature envelope.

use crate::canonicalize::{canonical_event_bytes, canonical_event_hash};
use crate::error::Result;
use crate::event::Event;
use crate::id::EventId;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use typeshare::typeshare;

/// Supported signature algorithms for signed tape events.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureAlgorithm {
    Ed25519,
}

/// Explicit verification state for a ledger event read from the tape.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Verified,
    Unsigned,
    MissingKey,
    HashMismatch,
    BadSignature,
    UnsupportedAlgorithm,
}

/// Stable reference to the actor key that produced a detached event signature.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorKeyRef {
    /// Stable actor identifier, for example `kernel`, `operator:<id>`, or `worker:<id>`.
    pub actor_id: String,
    /// Key identifier scoped to the actor.
    pub key_id: String,
    /// Optional digest of the public key material used by external verifiers.
    pub public_key_hash: Option<String>,
}

/// Detached signature over one canonical event.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventSignatureV1 {
    /// Event id this signature covers.
    pub event_id: EventId,
    /// Digest of the canonical serialized event bytes, e.g. `sha256:<hex>`.
    pub canonical_event_hash: String,
    /// Actor key that produced the signature.
    pub signer: ActorKeyRef,
    /// Signature algorithm.
    pub algorithm: SignatureAlgorithm,
    /// Encoded detached signature bytes. v0.5 uses base64url without padding.
    pub signature: String,
    /// Time the signature was produced.
    pub signed_at: DateTime<Utc>,
}

/// Public keys trusted by a read-side verifier.
///
/// The current M1 surface is intentionally local and explicit: callers supply
/// public key bytes keyed by `public_key_hash`. Private key discovery and
/// keyring loading are introduced by M1-S4, not by verification-on-read.
#[derive(Clone, Debug, Default)]
pub struct TrustedPublicKeys {
    by_public_key_hash: BTreeMap<String, Vec<u8>>,
}

impl TrustedPublicKeys {
    pub fn insert_public_key(&mut self, public_key_hash: String, public_key_bytes: Vec<u8>) {
        self.by_public_key_hash
            .insert(public_key_hash, public_key_bytes);
    }

    pub fn public_key_for(&self, signer: &ActorKeyRef) -> Option<&[u8]> {
        signer
            .public_key_hash
            .as_ref()
            .and_then(|hash| self.by_public_key_hash.get(hash))
            .map(Vec::as_slice)
    }
}

/// Digest of an ed25519 verifying (public) key, formatted as `sha256:<hex>`.
///
/// This is the exact value `TrustedPublicKeys::public_key_for` keys on, so the
/// producer side must compute it identically to the verifier side.
pub fn public_key_hash(verifying_key: &VerifyingKey) -> String {
    let digest = Sha256::digest(verifying_key.as_bytes());
    format!("sha256:{digest:x}")
}

/// Produce a detached Ed25519 signature over the canonical bytes of `event`.
///
/// The returned [`EventSignatureV1`] is the producer half of the M1 signed-tape
/// contract and is verifiable by [`verify_event_signature`]:
///
/// - `canonical_event_hash` is `canonical_event_hash(event)`.
/// - the 64-byte signature is over `canonical_event_bytes(event)`, encoded as
///   base64url without padding (round-trips with `URL_SAFE_NO_PAD.decode`).
/// - `signer.public_key_hash` is overwritten with `sha256:<hex>` of the
///   verifying key so that the verifier's [`TrustedPublicKeys`] lookup matches.
///
/// Ed25519 is deterministic, so the same key + event + `signed_at` yields a
/// stable signature. Fails closed if the event cannot be canonicalized (for
/// example an unsupported schema version); no partial signature is produced.
pub fn sign_event(
    event: &Event,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    signed_at: DateTime<Utc>,
) -> Result<EventSignatureV1> {
    let canonical_event_hash = canonical_event_hash(event)?;
    let message = canonical_event_bytes(event)?;
    let signature = signing_key.sign(&message);

    let mut signer = signer.clone();
    signer.public_key_hash = Some(public_key_hash(&signing_key.verifying_key()));

    Ok(EventSignatureV1 {
        event_id: event.id,
        canonical_event_hash,
        signer,
        algorithm: SignatureAlgorithm::Ed25519,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        signed_at,
    })
}

/// Verify one detached Ed25519 signature against the supplied event and public
/// key registry. Unsupported algorithm dispatch is handled by storage before it
/// constructs an [`EventSignatureV1`], so this function covers only the typed
/// `SignatureAlgorithm::Ed25519` path.
pub fn verify_event_signature(
    event: &Event,
    signature: &EventSignatureV1,
    trusted_keys: &TrustedPublicKeys,
) -> VerificationStatus {
    // Bind the signature to this exact event id before any crypto work: a
    // signature lifted from a different event must not verify here.
    if signature.event_id != event.id {
        return VerificationStatus::HashMismatch;
    }

    let Ok(actual_hash) = canonical_event_hash(event) else {
        return VerificationStatus::HashMismatch;
    };
    if signature.canonical_event_hash != actual_hash {
        return VerificationStatus::HashMismatch;
    }

    let Some(public_key_bytes) = trusted_keys.public_key_for(&signature.signer) else {
        return VerificationStatus::MissingKey;
    };
    let Ok(public_key_bytes) = <&[u8; 32]>::try_from(public_key_bytes) else {
        return VerificationStatus::MissingKey;
    };
    let Ok(public_key) = VerifyingKey::from_bytes(public_key_bytes) else {
        return VerificationStatus::MissingKey;
    };

    // Bind the retrieved key to its claimed hash. If the trust registry maps the
    // claimed `public_key_hash` to bytes whose actual hash differs, the trusted
    // key for that claimed identity effectively does not exist — fail closed
    // rather than verify against a key whose real identity differs from the
    // claim. `public_key_for` keyed on `Some(hash)`, so the hash is present here.
    if let Some(claimed_hash) = signature.signer.public_key_hash.as_deref() {
        if public_key_hash(&public_key) != claimed_hash {
            return VerificationStatus::MissingKey;
        }
    }

    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(&signature.signature) else {
        return VerificationStatus::BadSignature;
    };
    let Ok(signature_bytes) = <&[u8; 64]>::try_from(signature_bytes.as_slice()) else {
        return VerificationStatus::BadSignature;
    };
    let detached_signature = Signature::from_bytes(signature_bytes);

    let Ok(message) = canonical_event_bytes(event) else {
        return VerificationStatus::BadSignature;
    };
    if public_key.verify(&message, &detached_signature).is_ok() {
        VerificationStatus::Verified
    } else {
        VerificationStatus::BadSignature
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::RunId;
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use crate::payload::Payload;
    use ed25519_dalek::SigningKey;
    use sha2::{Digest, Sha256};
    use uuid::Uuid;

    const SIGNED_EVENT_FIXTURE_HASH: &str =
        "sha256:71ad93c5d6863d077cbdd5f885275e2ebac705364c44631875c9044eaffe6a08";

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

    fn fixture_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[42u8; 32])
    }

    fn expected_public_key_hash(signing_key: &SigningKey) -> String {
        let digest = Sha256::digest(signing_key.verifying_key().as_bytes());
        format!("sha256:{digest:x}")
    }

    fn trusted_keys(signing_key: &SigningKey) -> TrustedPublicKeys {
        let mut keys = TrustedPublicKeys::default();
        keys.insert_public_key(
            expected_public_key_hash(signing_key),
            signing_key.verifying_key().to_bytes().to_vec(),
        );
        keys
    }

    #[test]
    fn sign_event_round_trips_to_verified() {
        let event = sample_event();
        let signing_key = fixture_signing_key();
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };

        let signature =
            sign_event(&event, &signing_key, &signer, "2026-05-22T23:30:00Z".parse().unwrap())
                .unwrap();

        // public_key_hash is filled in by sign_event and must match the verify-path lookup.
        assert_eq!(
            signature.signer.public_key_hash.as_deref(),
            Some(expected_public_key_hash(&signing_key).as_str())
        );
        assert_eq!(signature.event_id, event.id);
        assert_eq!(signature.algorithm, SignatureAlgorithm::Ed25519);
        assert_eq!(
            signature.canonical_event_hash,
            canonical_event_hash(&event).unwrap()
        );

        let status = verify_event_signature(&event, &signature, &trusted_keys(&signing_key));
        assert_eq!(status, VerificationStatus::Verified);
    }

    #[test]
    fn verify_rejects_wrong_key_for_claimed_hash() {
        // A registry that maps the claimed hash string to the WRONG key bytes
        // must not verify, even for an otherwise well-formed signature.
        let event = sample_event();
        let signing_key = fixture_signing_key();
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };
        let signature =
            sign_event(&event, &signing_key, &signer, "2026-05-22T23:30:00Z".parse().unwrap())
                .unwrap();

        let claimed_hash = signature.signer.public_key_hash.clone().unwrap();
        // Map the claimed hash to a DIFFERENT key's bytes.
        let other_key = SigningKey::from_bytes(&[99u8; 32]);
        let mut poisoned = TrustedPublicKeys::default();
        poisoned.insert_public_key(
            claimed_hash,
            other_key.verifying_key().to_bytes().to_vec(),
        );

        assert_eq!(
            verify_event_signature(&event, &signature, &poisoned),
            VerificationStatus::MissingKey
        );
    }

    #[test]
    fn verify_rejects_signature_for_different_event_id() {
        let event = sample_event();
        let signing_key = fixture_signing_key();
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };
        let mut signature =
            sign_event(&event, &signing_key, &signer, "2026-05-22T23:30:00Z".parse().unwrap())
                .unwrap();
        // Re-point the signature at a different event id.
        signature.event_id = EventId::new();

        assert_eq!(
            verify_event_signature(&event, &signature, &trusted_keys(&signing_key)),
            VerificationStatus::HashMismatch
        );
    }

    #[test]
    fn sign_event_is_deterministic() {
        let event = sample_event();
        let signing_key = fixture_signing_key();
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };
        let at = "2026-05-22T23:30:00Z".parse().unwrap();

        let a = sign_event(&event, &signing_key, &signer, at).unwrap();
        let b = sign_event(&event, &signing_key, &signer, at).unwrap();
        assert_eq!(a.signature, b.signature);
    }

    #[test]
    fn sign_event_base64url_decodes_to_64_bytes() {
        let event = sample_event();
        let signing_key = fixture_signing_key();
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };
        let signature =
            sign_event(&event, &signing_key, &signer, "2026-05-22T23:30:00Z".parse().unwrap())
                .unwrap();
        let raw = URL_SAFE_NO_PAD.decode(&signature.signature).unwrap();
        assert_eq!(raw.len(), 64);
    }

    #[test]
    fn signature_algorithm_serializes_to_ed25519() {
        let value = serde_json::to_value(SignatureAlgorithm::Ed25519).unwrap();
        assert_eq!(value, serde_json::json!("ed25519"));
    }

    #[test]
    fn verification_status_serializes_to_snake_case() {
        let value = serde_json::to_value(VerificationStatus::BadSignature).unwrap();
        assert_eq!(value, serde_json::json!("bad_signature"));
    }

    #[test]
    fn event_signature_v1_uses_detached_contract_shape() {
        let event_id =
            EventId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-000000000101").unwrap());
        let signed_at = "2026-05-21T21:30:00Z".parse::<DateTime<Utc>>().unwrap();
        let signature = EventSignatureV1 {
            event_id,
            canonical_event_hash: SIGNED_EVENT_FIXTURE_HASH.into(),
            signer: ActorKeyRef {
                actor_id: "kernel".into(),
                key_id: "kernel-main".into(),
                public_key_hash: Some("sha256:public-key".into()),
            },
            algorithm: SignatureAlgorithm::Ed25519,
            signature: "base64url-signature".into(),
            signed_at,
        };

        let json = serde_json::to_value(&signature).unwrap();
        assert_eq!(json["event_id"], event_id.to_string());
        assert_eq!(json["canonical_event_hash"], SIGNED_EVENT_FIXTURE_HASH);
        assert_eq!(json["signer"]["actor_id"], "kernel");
        assert_eq!(json["algorithm"], "ed25519");
        assert_eq!(json["signature"], "base64url-signature");
        assert_eq!(json["signed_at"], "2026-05-21T21:30:00Z");

        let back: EventSignatureV1 = serde_json::from_value(json).unwrap();
        assert_eq!(back, signature);
    }
}
