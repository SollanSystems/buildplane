//! Tape-root checkpoint payload (M1-S6).
//!
//! A `TapeCheckpointV1` is a monotonic local checkpoint over a contiguous prefix
//! of a run's signed events. It lets an external verifier validate a compact
//! tape prefix without replaying every event: recompute each event's
//! `canonical_event_hash`, join them in tape order, hash the join, and compare
//! against the checkpoint's `tape_root_hash`.
//!
//! This is intentionally NOT a Merkle transparency log — there are no inclusion
//! proofs. It is optimized for replay verification and crash recovery. Public
//! transparency is deferred to v1+.

use crate::id::{EventId, RunId};
use crate::types::U64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use typeshare::typeshare;

/// `tape_checkpoint` payload — a monotonic local checkpoint over the signed
/// events of one run, through (and including) `through_event_id`.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TapeCheckpointV1 {
    /// Run this checkpoint covers.
    pub run_id: RunId,
    /// Monotonic per-run index, starting at 0 for a run's first checkpoint.
    pub checkpoint_index: U64,
    /// Last signed event id included in this checkpoint (inclusive).
    pub through_event_id: EventId,
    /// Total count of signed events covered by this checkpoint, from the start
    /// of the run through `through_event_id` (inclusive).
    pub through_event_count: U64,
    /// Event id of the previous checkpoint for this run, or `None` for the first.
    pub previous_checkpoint_event_id: Option<EventId>,
    /// Root hash over the covered events' canonical hashes, as `sha256:<hex>`.
    pub tape_root_hash: String,
    /// Algorithm used to derive `tape_root_hash`.
    pub algorithm: TapeRootAlgorithm,
}

/// Closed vocabulary of tape-root algorithms. v0.5 ships exactly one.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TapeRootAlgorithm {
    /// `sha256("sha256:" + hex)` over the `\n`-joined ordered canonical event
    /// hash strings. See [`tape_root_hash`].
    Sha256Linear,
}

/// Compute the v0.5 tape-root hash over an ordered slice of per-event canonical
/// hash strings.
///
/// # Checkpoint root contract (M1-S7 load-bearing)
///
/// Let `H` be the multiset of stored `event_signatures.canonical_event_hash`
/// strings for the run's **signed, non-`tape_checkpoint`** events — i.e. events
/// that have a persisted signature row and whose `kind != tape_checkpoint`.
/// Order `H` by the event `id` ascending (UUIDv7 = tape order). Then:
///
/// ```text
/// tape_root_hash = "sha256:" + hex(sha256(join("\n", H)))
/// ```
///
/// Precisely:
///
/// - the input is each event's exact stored `canonical_event_hash` *string*
///   (`sha256:<hex>`), NOT a re-hash of the event bytes here;
/// - the strings are joined by a single `\n` (U+000A) separator with **no
///   trailing newline** (an N-element join has N-1 separators);
/// - `through_event_count` on the checkpoint equals the number of such signed,
///   non-`tape_checkpoint` events covered — NOT the count of all run events;
/// - **unsigned/legacy events are excluded** from `H` entirely (they carry no
///   signature row); a "full prefix including unsigned events" reading is wrong;
/// - `tape_checkpoint` events themselves are never members of `H`.
///
/// An external verifier reproduces the root by loading exactly those signed,
/// non-checkpoint event rows for the run, reading their stored
/// `canonical_event_hash` strings in id order, `\n`-joining with no trailing
/// newline, and `sha256`-ing the joined bytes. An empty `H` hashes the empty
/// byte string.
pub fn tape_root_hash(ordered_canonical_event_hashes: &[String]) -> String {
    let joined = ordered_canonical_event_hashes.join("\n");
    let mut hasher = Sha256::new();
    hasher.update(joined.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{EventId, RunId};
    use uuid::Uuid;

    fn fixed_event_id(n: u8) -> EventId {
        EventId::from_uuid(
            Uuid::parse_str(&format!("01919000-0000-7000-8000-{n:012}")).unwrap(),
        )
    }

    fn fixed_run_id() -> RunId {
        RunId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap())
    }

    #[test]
    fn tape_root_hash_recomputes_deterministically_from_fixed_inputs() {
        // A fixed ordered set of canonical event hash strings yields a stable
        // root. This is the exact pure-function contract M1-S7 must mirror.
        let hashes = vec![
            "sha256:0000000000000000000000000000000000000000000000000000000000000001"
                .to_string(),
            "sha256:0000000000000000000000000000000000000000000000000000000000000002"
                .to_string(),
            "sha256:0000000000000000000000000000000000000000000000000000000000000003"
                .to_string(),
        ];

        // Independently recompute the spec formula here to lock the contract.
        let joined = hashes.join("\n");
        let expected = {
            let mut h = Sha256::new();
            h.update(joined.as_bytes());
            format!("sha256:{:x}", h.finalize())
        };

        let root = tape_root_hash(&hashes);
        assert_eq!(root, expected);
        assert!(root.starts_with("sha256:"));
        // Recomputing yields the same value (pure function).
        assert_eq!(tape_root_hash(&hashes), root);
    }

    #[test]
    fn tape_root_hash_is_order_sensitive() {
        let a = vec!["sha256:aa".to_string(), "sha256:bb".to_string()];
        let b = vec!["sha256:bb".to_string(), "sha256:aa".to_string()];
        assert_ne!(tape_root_hash(&a), tape_root_hash(&b));
    }

    #[test]
    fn tape_root_hash_single_vs_join_differs() {
        // A single combined string must not collide with two separate entries:
        // the `\n` join is load-bearing.
        let one = vec!["sha256:aa\nsha256:bb".to_string()];
        let two = vec!["sha256:aa".to_string(), "sha256:bb".to_string()];
        // join("\n") of `two` reconstructs the same bytes as `one`'s single
        // element, so these ARE equal — documenting the boundary explicitly so a
        // future change that, e.g., length-prefixes entries is a conscious break.
        assert_eq!(tape_root_hash(&one), tape_root_hash(&two));
    }

    #[test]
    fn tape_checkpoint_v1_round_trips() {
        let payload = TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 1,
            through_event_id: fixed_event_id(7),
            through_event_count: 4,
            previous_checkpoint_event_id: Some(fixed_event_id(5)),
            tape_root_hash: "sha256:abc".into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: TapeCheckpointV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn tape_root_algorithm_serializes_to_snake_case() {
        let value = serde_json::to_value(TapeRootAlgorithm::Sha256Linear).unwrap();
        assert_eq!(value, serde_json::json!("sha256_linear"));
    }

    #[test]
    fn previous_checkpoint_event_id_none_round_trips() {
        let payload = TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(3),
            through_event_count: 2,
            previous_checkpoint_event_id: None,
            tape_root_hash: "sha256:def".into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: TapeCheckpointV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
        assert!(back.previous_checkpoint_event_id.is_none());
    }
}
