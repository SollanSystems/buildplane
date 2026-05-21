//! Detached event signature contract for the signed tape.
//!
//! M1-S1 defines the wire types only. Signing, verification, storage, key
//! management, and checkpoint emission are added in later slices.

use crate::id::EventId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Supported signature algorithms for signed tape events.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureAlgorithm {
    Ed25519,
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

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn signature_algorithm_serializes_to_ed25519() {
        let value = serde_json::to_value(SignatureAlgorithm::Ed25519).unwrap();
        assert_eq!(value, serde_json::json!("ed25519"));
    }

    #[test]
    fn event_signature_v1_uses_detached_contract_shape() {
        let event_id =
            EventId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-000000000101").unwrap());
        let signed_at = "2026-05-21T21:30:00Z".parse::<DateTime<Utc>>().unwrap();
        let signature = EventSignatureV1 {
            event_id,
            canonical_event_hash: "sha256:fixture".into(),
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
        assert_eq!(json["canonical_event_hash"], "sha256:fixture");
        assert_eq!(json["signer"]["actor_id"], "kernel");
        assert_eq!(json["algorithm"], "ed25519");
        assert_eq!(json["signature"], "base64url-signature");
        assert_eq!(json["signed_at"], "2026-05-21T21:30:00Z");

        let back: EventSignatureV1 = serde_json::from_value(json).unwrap();
        assert_eq!(back, signature);
    }
}
