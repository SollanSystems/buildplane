//! Fail-closed tape-root verification for governed recovery projections.
//!
//! Ordinary replay intentionally remains able to read legacy and partially
//! signed tapes. A governed resolver is different: before it can project a
//! mutable recovery snapshot, a kernel-authorized `TapeCheckpointV1` chain
//! must cover every signed ordinary event that contributes to that snapshot.
//! This module only evaluates stored tape evidence; it neither authorizes nor
//! performs effects.

use crate::reader::VerifiedEvent;
use bp_ledger::payload::checkpoint::{TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, EventSignatureV1, VerificationStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;

/// Closed integrity facts for one recovery snapshot.
///
/// This report proves a locally verified tape prefix; it is deliberately not
/// rollback-resistant external anchoring or a transparency-log proof. It makes
/// no claims about events outside the resolver's run snapshot, exactly-once
/// recovery, or whether any effect was performed.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TapeIntegrityReportV1 {
    pub schema_version: u8,
    pub checkpoint_event_ref: String,
    pub checkpoint_event_digest: String,
    pub through_event_ref: String,
    /// A string on the JSON wire because JavaScript cannot losslessly parse
    /// every `u64` checkpoint coverage count. The Rust projection retains a
    /// numeric value and only accepts canonical decimal during deserialization.
    #[serde(
        serialize_with = "serialize_u64_decimal",
        deserialize_with = "deserialize_u64_decimal"
    )]
    pub signed_non_checkpoint_event_count: u64,
    pub tape_root_hash: String,
    pub algorithm: TapeRootAlgorithm,
}

fn serialize_u64_decimal<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_string())
}

fn deserialize_u64_decimal<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let parsed = value.parse::<u64>().map_err(|_| {
        <D::Error as serde::de::Error>::custom("must be a canonical unsigned 64-bit decimal string")
    })?;
    if parsed.to_string() != value {
        return Err(<D::Error as serde::de::Error>::custom(
            "must be a canonical unsigned 64-bit decimal string",
        ));
    }
    Ok(parsed)
}

/// Why a signed tape cannot be used as governed recovery authority.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TapeIntegrityError {
    #[error("tape contains an event outside requested run {expected_run}: {event_id}")]
    ForeignRunEvent {
        expected_run: String,
        event_id: String,
    },
    #[error("tape events are not strictly ordered at {previous_event_id} then {event_id}")]
    TapeOrder {
        previous_event_id: String,
        event_id: String,
    },
    #[error("governed recovery requires a tape_checkpoint event")]
    MissingCheckpoint,
    #[error("tape_checkpoint event {event_id} has checkpoint index {actual}; expected {expected}")]
    CheckpointIndexMismatch {
        event_id: String,
        expected: u64,
        actual: u64,
    },
    #[error("tape_checkpoint event {event_id} has previous_checkpoint_event_id {actual:?}; expected {expected:?}")]
    CheckpointPredecessorMismatch {
        event_id: String,
        expected: Option<String>,
        actual: Option<String>,
    },
    #[error("tape_checkpoint event {event_id} does not carry TapeCheckpointV1")]
    MalformedCheckpoint { event_id: String },
    #[error("tape_checkpoint event {event_id} is not signature-verified ({verification:?})")]
    CheckpointNotVerified {
        event_id: String,
        verification: VerificationStatus,
    },
    #[error("tape_checkpoint event {event_id} is missing its detached signature")]
    CheckpointSignatureMissing { event_id: String },
    #[error("tape_checkpoint event {event_id} is not signed by the pinned kernel authority")]
    CheckpointSignerUnauthorized { event_id: String },
    #[error("tape_checkpoint event {event_id} is for a different run")]
    CheckpointRunMismatch { event_id: String },
    #[error("tape_checkpoint event {event_id} uses unsupported root algorithm {algorithm:?}")]
    UnsupportedAlgorithm {
        event_id: String,
        algorithm: TapeRootAlgorithm,
    },
    #[error("tape_checkpoint event {event_id} is not parented to its through_event_id {through_event_id}")]
    UnanchoredCheckpoint {
        event_id: String,
        through_event_id: String,
    },
    #[error("tape_checkpoint event {event_id} references signed through_event_id {through_event_id} that is absent")]
    ThroughEventMissing {
        event_id: String,
        through_event_id: String,
    },
    #[error("signed event {event_id} is not signature-verified ({verification:?})")]
    SignedEventNotVerified {
        event_id: String,
        verification: VerificationStatus,
    },
    #[error("signed event {event_id} is missing its detached signature")]
    SignedEventSignatureMissing { event_id: String },
    #[error("tape_checkpoint event {event_id} declares {declared} covered signed events but recomputation found {actual}")]
    CoverageCountMismatch {
        event_id: String,
        declared: u64,
        actual: u64,
    },
    #[error("tape_checkpoint event {event_id} root does not match the signed event prefix")]
    TapeRootMismatch { event_id: String },
    #[error("tape_checkpoint event {event_id} does not advance covered prefix beyond checkpoint {previous_checkpoint_event_id}")]
    CheckpointCoverageNotAdvanced {
        event_id: String,
        previous_checkpoint_event_id: String,
    },
    #[error("tape_checkpoint event {checkpoint_event_id} leaves signed event {tail_event_id} outside its covered prefix")]
    UncheckpointedSignedTail {
        checkpoint_event_id: String,
        tail_event_id: String,
    },
}

/// Incremental implementation of the `sha256_linear` checkpoint-root wire
/// contract. Each signed ordinary-event hash is appended exactly once; a
/// checkpoint clones and finalizes the current state, preserving the
/// newline-separated/no-trailing-newline input used by `tape_root_hash`.
#[derive(Clone, Default)]
struct TapeRootHasher {
    hasher: Sha256,
    count: usize,
}

impl TapeRootHasher {
    fn push(&mut self, canonical_event_hash: &str) {
        if self.count != 0 {
            self.hasher.update(b"\n");
        }
        self.hasher.update(canonical_event_hash.as_bytes());
        self.count += 1;
    }

    fn root(&self) -> String {
        format!("sha256:{:x}", self.hasher.clone().finalize())
    }
}

/// Verify that the complete signed, non-checkpoint prefix used by a governed
/// recovery snapshot is covered by a directly anchored, pinned-kernel-signed
/// checkpoint chain. Every checkpoint in the supplied snapshot is validated
/// before the latest full-cover checkpoint is reported.
///
/// The input must be the same ordered `VerifiedEvent` snapshot used by the
/// resolver. The root computation intentionally mirrors
/// `bp_ledger::payload::checkpoint::tape_root_hash`: only events that carry a
/// detached signature are included, checkpoint events are excluded, and their
/// stored canonical hash strings are joined in tape order. Unlike ordinary
/// replay, an encountered signed event that did not verify blocks governed
/// recovery rather than silently becoming untrusted metadata. This is a local
/// evidence predicate only: it does not provide rollback resistance,
/// exactly-once recovery, or effect execution semantics.
pub fn verify_full_tape_integrity_v1(
    events: &[VerifiedEvent],
    run_id: &str,
    pinned_kernel_signer: &ActorKeyRef,
) -> Result<TapeIntegrityReportV1, TapeIntegrityError> {
    for pair in events.windows(2) {
        if pair[0].event.id.as_uuid() >= pair[1].event.id.as_uuid() {
            return Err(TapeIntegrityError::TapeOrder {
                previous_event_id: pair[0].event.id.to_string(),
                event_id: pair[1].event.id.to_string(),
            });
        }
    }
    for verified in events {
        if verified.event.run_id.to_string() != run_id {
            return Err(TapeIntegrityError::ForeignRunEvent {
                expected_run: run_id.to_string(),
                event_id: verified.event.id.to_string(),
            });
        }
    }

    let mut signed_ordinary = Vec::new();
    let mut signed_ordinary_positions = HashMap::new();
    let mut checkpoints = Vec::new();
    for verified in events {
        if verified.event.kind == bp_ledger::EventKind::TapeCheckpoint {
            checkpoints.push(verified);
            continue;
        }
        if verified.verification == VerificationStatus::Unsigned {
            continue;
        }
        if verified.verification != VerificationStatus::Verified {
            return Err(TapeIntegrityError::SignedEventNotVerified {
                event_id: verified.event.id.to_string(),
                verification: verified.verification,
            });
        }
        let signature = verified.signature.as_ref().ok_or_else(|| {
            TapeIntegrityError::SignedEventSignatureMissing {
                event_id: verified.event.id.to_string(),
            }
        })?;
        // Preserve the prior `iter().position(...)` behavior if a malformed
        // snapshot contains duplicate event IDs: the first occurrence is the
        // only one that can satisfy a `through_event_id` lookup.
        let signed_ordinary_position = signed_ordinary.len();
        signed_ordinary_positions
            .entry(verified.event.id)
            .or_insert(signed_ordinary_position);
        signed_ordinary.push((verified, signature));
    }

    if checkpoints.is_empty() {
        return Err(TapeIntegrityError::MissingCheckpoint);
    }

    let mut previous_checkpoint: Option<(&VerifiedEvent, usize)> = None;
    let mut latest_checkpoint: Option<(
        &VerifiedEvent,
        &TapeCheckpointV1,
        &EventSignatureV1,
        usize,
    )> = None;
    let mut rolling_root = TapeRootHasher::default();

    for (position, checkpoint) in checkpoints.into_iter().enumerate() {
        let event_id = checkpoint.event.id.to_string();
        let Payload::TapeCheckpointV1(payload) = &checkpoint.event.payload else {
            return Err(TapeIntegrityError::MalformedCheckpoint { event_id });
        };

        if checkpoint.verification != VerificationStatus::Verified {
            return Err(TapeIntegrityError::CheckpointNotVerified {
                event_id,
                verification: checkpoint.verification,
            });
        }
        let signature = checkpoint.signature.as_ref().ok_or_else(|| {
            TapeIntegrityError::CheckpointSignatureMissing {
                event_id: checkpoint.event.id.to_string(),
            }
        })?;
        if signature.signer != *pinned_kernel_signer {
            return Err(TapeIntegrityError::CheckpointSignerUnauthorized {
                event_id: checkpoint.event.id.to_string(),
            });
        }
        if payload.run_id != checkpoint.event.run_id || payload.run_id.to_string() != run_id {
            return Err(TapeIntegrityError::CheckpointRunMismatch {
                event_id: checkpoint.event.id.to_string(),
            });
        }
        if payload.algorithm != TapeRootAlgorithm::Sha256Linear {
            return Err(TapeIntegrityError::UnsupportedAlgorithm {
                event_id: checkpoint.event.id.to_string(),
                algorithm: payload.algorithm,
            });
        }
        if checkpoint.event.parent_event_id != Some(payload.through_event_id) {
            return Err(TapeIntegrityError::UnanchoredCheckpoint {
                event_id: checkpoint.event.id.to_string(),
                through_event_id: payload.through_event_id.to_string(),
            });
        }

        let through_position = signed_ordinary_positions
            .get(&payload.through_event_id)
            .copied()
            .ok_or_else(|| TapeIntegrityError::ThroughEventMissing {
                event_id: checkpoint.event.id.to_string(),
                through_event_id: payload.through_event_id.to_string(),
            })?;
        let covered_count = (through_position + 1) as u64;
        if payload.through_event_count != covered_count {
            return Err(TapeIntegrityError::CoverageCountMismatch {
                event_id: checkpoint.event.id.to_string(),
                declared: payload.through_event_count,
                actual: covered_count,
            });
        }

        if let Some((previous, previous_through_position)) = previous_checkpoint {
            if through_position <= previous_through_position {
                return Err(TapeIntegrityError::CheckpointCoverageNotAdvanced {
                    event_id: checkpoint.event.id.to_string(),
                    previous_checkpoint_event_id: previous.event.id.to_string(),
                });
            }
        }

        while rolling_root.count <= through_position {
            rolling_root.push(&signed_ordinary[rolling_root.count].1.canonical_event_hash);
        }
        if payload.tape_root_hash != rolling_root.root() {
            return Err(TapeIntegrityError::TapeRootMismatch {
                event_id: checkpoint.event.id.to_string(),
            });
        }

        let expected_index = position as u64;
        if payload.checkpoint_index != expected_index {
            return Err(TapeIntegrityError::CheckpointIndexMismatch {
                event_id: checkpoint.event.id.to_string(),
                expected: expected_index,
                actual: payload.checkpoint_index,
            });
        }
        let expected_predecessor = previous_checkpoint.map(|(previous, _)| previous.event.id);
        if payload.previous_checkpoint_event_id != expected_predecessor {
            return Err(TapeIntegrityError::CheckpointPredecessorMismatch {
                event_id: checkpoint.event.id.to_string(),
                expected: expected_predecessor.map(|id| id.to_string()),
                actual: payload
                    .previous_checkpoint_event_id
                    .map(|id| id.to_string()),
            });
        }

        previous_checkpoint = Some((checkpoint, through_position));
        latest_checkpoint = Some((checkpoint, payload, signature, through_position));
    }

    let (checkpoint, payload, signature, through_position) =
        latest_checkpoint.ok_or(TapeIntegrityError::MissingCheckpoint)?;
    let covered_count = (through_position + 1) as u64;
    if let Some((tail, _)) = signed_ordinary.get(through_position + 1) {
        return Err(TapeIntegrityError::UncheckpointedSignedTail {
            checkpoint_event_id: checkpoint.event.id.to_string(),
            tail_event_id: tail.event.id.to_string(),
        });
    }

    Ok(TapeIntegrityReportV1 {
        schema_version: 1,
        checkpoint_event_ref: checkpoint.event.id.to_string(),
        checkpoint_event_digest: signature.canonical_event_hash.clone(),
        through_event_ref: payload.through_event_id.to_string(),
        signed_non_checkpoint_event_count: covered_count,
        tape_root_hash: payload.tape_root_hash.clone(),
        algorithm: payload.algorithm,
    })
}

#[cfg(test)]
mod tests {
    use super::TapeRootHasher;
    use bp_ledger::payload::checkpoint::tape_root_hash;

    #[test]
    fn rolling_tape_root_matches_the_wire_contract_for_every_prefix() {
        let hashes = vec![
            "sha256:0000000000000000000000000000000000000000000000000000000000000001".to_string(),
            "sha256:0000000000000000000000000000000000000000000000000000000000000002".to_string(),
            "sha256:0000000000000000000000000000000000000000000000000000000000000003".to_string(),
        ];
        let mut rolling = TapeRootHasher::default();

        assert_eq!(rolling.root(), tape_root_hash(&[]));
        for (index, hash) in hashes.iter().enumerate() {
            rolling.push(hash);
            assert_eq!(rolling.root(), tape_root_hash(&hashes[..=index]));
        }
    }
}
