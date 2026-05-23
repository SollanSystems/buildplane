//! Detached event signature contract for the signed tape.
//!
//! M1-S1 defines the wire types. Later slices add storage, verification,
//! key management, and checkpoint emission without changing this detached
//! signature envelope.

use crate::canonicalize::{canonical_event_bytes, canonical_event_hash};
use crate::event::Event;
use crate::id::EventId;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
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
#[typeshare]
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

/// Verify one detached Ed25519 signature against the supplied event and public
/// key registry. Unsupported algorithm dispatch is handled by storage before it
/// constructs an [`EventSignatureV1`], so this function covers only the typed
/// `SignatureAlgorithm::Ed25519` path.
pub fn verify_event_signature(
    event: &Event,
    signature: &EventSignatureV1,
    trusted_keys: &TrustedPublicKeys,
) -> VerificationStatus {
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
    use uuid::Uuid;

    const SIGNED_EVENT_FIXTURE_HASH: &str =
        "sha256:71ad93c5d6863d077cbdd5f885275e2ebac705364c44631875c9044eaffe6a08";

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
