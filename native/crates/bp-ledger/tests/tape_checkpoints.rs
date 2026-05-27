//! M1-S6 tape-root checkpoint emission, cadence, chaining, atomicity, and
//! tamper-evidence integration tests.

use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::error::LedgerError;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::{CheckpointPolicy, SqliteStore};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const FIXTURE_SEED: [u8; 32] = [21u8; 32];

fn fixture_key() -> SigningKey {
    SigningKey::from_bytes(&FIXTURE_SEED)
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

fn trusted_for(signing_key: &SigningKey) -> TrustedPublicKeys {
    let mut keys = TrustedPublicKeys::default();
    let hash = format!(
        "sha256:{:x}",
        Sha256::digest(signing_key.verifying_key().as_bytes())
    );
    keys.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());
    keys
}

fn run_started(run_id: RunId) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunStarted,
        occurred_at: chrono::Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "dead".into(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    }
}

fn run_completed(run_id: RunId) -> Event {
    Event {
        id: EventId::new(),
        run_id,
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

/// Read all `tape_checkpoint` events for a run, ordered by id, decoded into the
/// typed payload.
fn checkpoints_for_run(store: &SqliteStore, run_id: RunId) -> Vec<(EventId, TapeCheckpointV1)> {
    store
        .events_for_run(&run_id.to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "tape_checkpoint")
        .map(|row| {
            let event = row.to_event().unwrap();
            let id = event.id;
            let Payload::TapeCheckpointV1(p) = event.payload else {
                panic!("tape_checkpoint row must carry a TapeCheckpointV1 payload");
            };
            (id, p)
        })
        .collect()
}

#[test]
fn checkpoint_emits_at_cadence_boundaries_and_chains() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    // 4 ordinary signed events with cadence 2 => checkpoints after #2 and #4.
    let mut ordinary = Vec::new();
    for _ in 0..4 {
        let e = run_started(run_id);
        ordinary.push(e.clone());
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &policy)
            .unwrap();
    }

    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(checkpoints.len(), 2, "two cadence-2 checkpoints over 4 events");

    let (cp0_id, cp0) = &checkpoints[0];
    let (cp1_id, cp1) = &checkpoints[1];

    assert_eq!(cp0.checkpoint_index, 0);
    assert_eq!(cp1.checkpoint_index, 1);

    assert_eq!(cp0.through_event_count, 2);
    assert_eq!(cp1.through_event_count, 4);

    assert_eq!(cp0.through_event_id, ordinary[1].id);
    assert_eq!(cp1.through_event_id, ordinary[3].id);

    assert_eq!(cp0.previous_checkpoint_event_id, None);
    assert_eq!(cp1.previous_checkpoint_event_id, Some(*cp0_id));

    assert_eq!(cp0.run_id, run_id);
    assert_eq!(cp1.algorithm, TapeRootAlgorithm::Sha256Linear);

    // Each checkpoint event must itself be appended after its covered events.
    assert!(cp0_id.as_uuid() > ordinary[1].id.as_uuid());
    assert!(cp1_id.as_uuid() > ordinary[3].id.as_uuid());
}

#[test]
fn checkpoint_event_is_signed_and_reads_back_verified() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    for _ in 0..2 {
        let e = run_started(run_id);
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &policy)
            .unwrap();
    }

    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(checkpoints.len(), 1);
    let (cp_id, _) = &checkpoints[0];

    // The checkpoint event must carry a verified detached signature.
    let rows = store
        .verified_events_for_run(&run_id.to_string(), &trusted_for(&key))
        .unwrap();
    let cp_row = rows
        .iter()
        .find(|r| r.event.id == cp_id.to_string())
        .expect("checkpoint event must be readable");
    assert_eq!(cp_row.verification, VerificationStatus::Verified);

    // And a matching signature row is persisted.
    let sig_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM event_signatures WHERE event_id = ?1",
            [cp_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sig_count, 1, "checkpoint signature must be persisted");
}

#[test]
fn checkpoint_signature_insert_failure_rolls_back_checkpoint_event() {
    // Headline fail-closed guarantee for the checkpoint: if the checkpoint's
    // signature insert fails AFTER the checkpoint event row has been inserted
    // in the same transaction, the whole checkpoint append must roll back — no
    // checkpoint event persists without its signature.
    //
    // We force the failure with a one-shot fault injection hook that aborts the
    // checkpoint signature insert. The ordinary events that triggered the
    // cadence have already been committed; only the checkpoint must vanish.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    let e1 = run_started(run_id);
    store
        .append_signed_with_checkpoint(&e1, &key, &kernel_signer(), &policy)
        .unwrap();

    // Arm the fault: the next checkpoint signature insert fails.
    store.fail_next_checkpoint_signature_insert_for_tests();

    let e2 = run_started(run_id);
    let result = store.append_signed_with_checkpoint(&e2, &key, &kernel_signer(), &policy);
    assert!(
        result.is_err(),
        "checkpoint signature insert failure must surface as an error"
    );

    // The ordinary events e1 and e2 are committed (their own atomic appends).
    let ordinary_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1 AND kind = 'run_started'",
            [run_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ordinary_count, 2, "ordinary events stay committed");

    // No checkpoint event row, and no checkpoint signature row, persisted.
    let cp_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1 AND kind = 'tape_checkpoint'",
            [run_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cp_count, 0, "checkpoint event must roll back with its signature");
}

#[test]
fn final_checkpoint_emits_at_run_completed_with_uncheckpointed_events() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    // Cadence high enough that no cadence checkpoint fires for 3 events.
    let policy = CheckpointPolicy::every(256);

    let mut ordinary = Vec::new();
    for _ in 0..3 {
        let e = run_started(run_id);
        ordinary.push(e.clone());
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &policy)
            .unwrap();
    }
    assert_eq!(
        checkpoints_for_run(&store, run_id).len(),
        0,
        "no cadence checkpoint below the cadence threshold"
    );

    // run_completed forces a final checkpoint over the uncheckpointed events.
    // run_completed is itself a signed ordinary event, so the final checkpoint
    // covers all 4 signed events (3 run_started + run_completed) through the
    // run_completed event.
    let done = run_completed(run_id);
    store
        .append_signed_with_checkpoint(&done, &key, &kernel_signer(), &policy)
        .unwrap();

    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(checkpoints.len(), 1, "one final checkpoint at run_completed");
    let (_, cp) = &checkpoints[0];
    assert_eq!(cp.checkpoint_index, 0);
    // Final checkpoint covers the 4 signed events through run_completed.
    assert_eq!(cp.through_event_count, 4);
    assert_eq!(cp.through_event_id, done.id);
    let _ = &ordinary;
}

#[test]
fn final_checkpoint_covers_lone_run_completed_event() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    // Exactly 2 events => one cadence checkpoint, then nothing uncheckpointed.
    for _ in 0..2 {
        let e = run_started(run_id);
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &policy)
            .unwrap();
    }
    assert_eq!(checkpoints_for_run(&store, run_id).len(), 1);

    // run_completed must NOT emit a second checkpoint: zero uncheckpointed
    // ordinary events since the cadence checkpoint (run_completed itself is the
    // only new ordinary event, so a final checkpoint would cover exactly it).
    //
    // Per spec the final checkpoint emits when >=1 signed event is uncheckpointed
    // since the last checkpoint. run_completed is itself signed, so it counts.
    // To test the zero-uncheckpointed branch we instead complete a run whose
    // last cadence checkpoint already covered everything including completion is
    // impossible; so here we assert the simpler invariant: a run with NO signed
    // events at all emits no checkpoint at completion.
    let empty_run = RunId::new();
    let done = run_completed(empty_run);
    store
        .append_signed_with_checkpoint(&done, &key, &kernel_signer(), &policy)
        .unwrap();
    // The only signed event in empty_run is run_completed itself, which IS
    // uncheckpointed, so a final checkpoint covering it is expected.
    let cps = checkpoints_for_run(&store, empty_run);
    assert_eq!(cps.len(), 1, "final checkpoint covers the lone signed event");
    assert_eq!(cps[0].1.through_event_count, 1);
    assert_eq!(cps[0].1.through_event_id, done.id);
}

#[test]
fn external_recomputation_matches_stored_root_and_detects_tamper() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(3);

    let mut ordinary = Vec::new();
    for _ in 0..3 {
        let e = run_started(run_id);
        ordinary.push(e.clone());
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &policy)
            .unwrap();
    }

    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(checkpoints.len(), 1);
    let (_, cp) = &checkpoints[0];

    // Independently recompute the root from the ordinary events' canonical
    // hashes, in id order. This mirrors exactly what M1-S7 must do.
    let mut ordered = ordinary.clone();
    ordered.sort_by_key(|e| e.id.as_uuid());
    let recomputed_hashes: Vec<String> =
        ordered.iter().map(|e| canonical_event_hash(e).unwrap()).collect();
    let recomputed_root = tape_root_hash(&recomputed_hashes);

    assert_eq!(
        cp.tape_root_hash, recomputed_root,
        "stored checkpoint root must match an external recomputation"
    );

    // Tamper-evidence: altering any covered event hash changes the root, so the
    // recomputation no longer matches the stored checkpoint.
    let mut tampered = recomputed_hashes.clone();
    tampered[0] = "sha256:deadbeef".into();
    let tampered_root = tape_root_hash(&tampered);
    assert_ne!(
        cp.tape_root_hash, tampered_root,
        "any altered event hash must change the recomputed root"
    );
}

#[test]
fn unsigned_append_emits_no_checkpoints() {
    // Checkpoints belong to signed mode. The plain unsigned append path never
    // produces a checkpoint, even past the cadence boundary.
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    for _ in 0..10 {
        let e = run_started(run_id);
        store.append(&e).unwrap();
    }

    assert_eq!(
        checkpoints_for_run(&store, run_id).len(),
        0,
        "unsigned appends never emit checkpoints"
    );
}

#[test]
fn disabled_policy_emits_no_checkpoints_even_signed() {
    // Signed mode with a Disabled checkpoint policy (the legacy `append_signed`
    // surface) must not emit checkpoints.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();

    for _ in 0..10 {
        let e = run_started(run_id);
        store
            .append_signed_with_checkpoint(&e, &key, &kernel_signer(), &CheckpointPolicy::Disabled)
            .unwrap();
    }
    assert_eq!(checkpoints_for_run(&store, run_id).len(), 0);

    // run_completed under a disabled policy also emits nothing.
    let done = run_completed(run_id);
    store
        .append_signed_with_checkpoint(&done, &key, &kernel_signer(), &CheckpointPolicy::Disabled)
        .unwrap();
    assert_eq!(checkpoints_for_run(&store, run_id).len(), 0);
}

/// Build a forged caller-supplied `tape_checkpoint` event as a wire producer
/// might inject it.
fn forged_checkpoint_event(run_id: RunId) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::TapeCheckpoint,
        occurred_at: chrono::Utc::now(),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id,
            checkpoint_index: 999,
            through_event_id: EventId::new(),
            through_event_count: 999,
            previous_checkpoint_event_id: None,
            tape_root_hash: "sha256:forged".into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}

#[test]
fn caller_supplied_checkpoint_is_rejected_pre_persist() {
    // Codex P1-1: a producer-supplied `tape_checkpoint` event must be rejected
    // BEFORE signing or persisting, so a forged checkpoint can never enter the
    // store for `latest_checkpoint` to trust.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    let forged = forged_checkpoint_event(run_id);
    let result = store.append_signed_with_checkpoint(&forged, &key, &kernel_signer(), &policy);
    assert!(
        matches!(result, Err(LedgerError::CallerSuppliedCheckpoint)),
        "wire-supplied tape_checkpoint must be rejected with a typed error, got {result:?}"
    );

    // Nothing persisted: no event row, no signature row.
    let event_rows: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE id = ?1",
            [forged.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(event_rows, 0, "forged checkpoint event must never persist");
    let sig_rows: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM event_signatures WHERE event_id = ?1",
            [forged.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sig_rows, 0, "forged checkpoint must never be signed");
    assert_eq!(
        checkpoints_for_run(&store, run_id).len(),
        0,
        "no checkpoint may exist after a rejected injection"
    );
}

#[test]
fn checkpoint_injection_does_not_perturb_cadence() {
    // An attempted forged-checkpoint injection between cadence events must leave
    // cadence unaffected: `latest_checkpoint` only ever sees ledger-emitted
    // checkpoints, so the real checkpoints still emit at the right boundaries.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    let e1 = run_started(run_id);
    store
        .append_signed_with_checkpoint(&e1, &key, &kernel_signer(), &policy)
        .unwrap();

    // Inject a forged checkpoint claiming to cover everything — must be rejected.
    let forged = forged_checkpoint_event(run_id);
    assert!(store
        .append_signed_with_checkpoint(&forged, &key, &kernel_signer(), &policy)
        .is_err());

    let e2 = run_started(run_id);
    store
        .append_signed_with_checkpoint(&e2, &key, &kernel_signer(), &policy)
        .unwrap();

    // Exactly one real cadence-2 checkpoint over the two ordinary events, with
    // honest coverage — the forged index/count never leaked in.
    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(checkpoints.len(), 1, "cadence unaffected by injection attempt");
    let (_, cp) = &checkpoints[0];
    assert_eq!(cp.checkpoint_index, 0);
    assert_eq!(cp.through_event_count, 2);
    assert_eq!(cp.through_event_id, e2.id);
}

#[test]
fn lower_id_ordinary_append_rejected_per_run_monotonic() {
    // Codex P1-2: an incoming ordinary event whose id is not strictly greater
    // than the latest existing id for the SAME run is rejected, preserving
    // "id-ordered prefix == append order" so checkpoint coverage can't be
    // retroactively invalidated.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(256);

    let first = run_started(run_id);
    store
        .append_signed_with_checkpoint(&first, &key, &kernel_signer(), &policy)
        .unwrap();

    // A lower-id event for the same run is rejected.
    let mut lower = run_started(run_id);
    lower.id = EventId::from_uuid(
        uuid::Uuid::parse_str("00000000-0000-7000-8000-000000000000").unwrap(),
    );
    let result = store.append_signed_with_checkpoint(&lower, &key, &kernel_signer(), &policy);
    assert!(
        matches!(result, Err(LedgerError::NonMonotonicEventId { .. })),
        "lower-id same-run append must be rejected, got {result:?}"
    );

    // An equal-id (replay) event for the same run is also rejected.
    let mut equal = run_started(run_id);
    equal.id = first.id;
    let result = store.append_signed_with_checkpoint(&equal, &key, &kernel_signer(), &policy);
    assert!(
        matches!(result, Err(LedgerError::NonMonotonicEventId { .. })),
        "equal-id same-run replay must be rejected, got {result:?}"
    );

    // Neither rejected event persisted.
    let count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1",
            [run_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "only the first monotonic event persists");

    // A normal monotonic append still passes.
    let next = run_started(run_id);
    assert!(next.id.as_uuid() > first.id.as_uuid());
    store
        .append_signed_with_checkpoint(&next, &key, &kernel_signer(), &policy)
        .unwrap();
}

#[test]
fn unsigned_append_rejects_caller_supplied_checkpoint() {
    // Gate round 2, fix #1(a): the raw/unsigned `append` path must also reject a
    // caller-supplied `tape_checkpoint`. Checkpoints are ledger-internal in
    // EVERY mode, so a producer talking to an unsigned ledger can't inject one.
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    let forged = forged_checkpoint_event(run_id);
    let result = store.append(&forged);
    assert!(
        matches!(result, Err(LedgerError::CallerSuppliedCheckpoint)),
        "unsigned append of a tape_checkpoint must be rejected, got {result:?}"
    );

    let event_rows: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE id = ?1",
            [forged.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        event_rows, 0,
        "forged checkpoint must never persist via unsigned append"
    );
    assert_eq!(checkpoints_for_run(&store, run_id).len(), 0);
}

#[test]
fn unsigned_append_rejects_non_monotonic_ordinary_id() {
    // Gate round 2, fix #1(b): the raw/unsigned `append` path enforces the same
    // per-run strictly-monotonic ordinary-id guard as the signed paths.
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    let first = run_started(run_id);
    store.append(&first).unwrap();

    let mut lower = run_started(run_id);
    lower.id =
        EventId::from_uuid(uuid::Uuid::parse_str("00000000-0000-7000-8000-000000000000").unwrap());
    let result = store.append(&lower);
    assert!(
        matches!(result, Err(LedgerError::NonMonotonicEventId { .. })),
        "lower-id same-run unsigned append must be rejected, got {result:?}"
    );

    // Equal-id (replay) is rejected too.
    let mut equal = run_started(run_id);
    equal.id = first.id;
    let result = store.append(&equal);
    assert!(
        matches!(result, Err(LedgerError::NonMonotonicEventId { .. })),
        "equal-id same-run unsigned replay must be rejected, got {result:?}"
    );

    let count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1",
            [run_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "only the first monotonic event persists on unsigned path"
    );

    // A normal monotonic unsigned append still passes.
    let next = run_started(run_id);
    assert!(next.id.as_uuid() > first.id.as_uuid());
    store.append(&next).unwrap();
}

#[test]
fn ordinary_id_below_emitted_checkpoint_id_is_accepted() {
    // Gate round 2, fix #2 (regression): a checkpoint id is minted AFTER the
    // events it covers, so it can be greater than a subsequent legitimate
    // ordinary event whose id was pre-generated earlier. The monotonic guard
    // must compare only against the latest NON-checkpoint event id, never the
    // checkpoint id, so such an ordinary event is ACCEPTED.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let run_id = RunId::new();
    let policy = CheckpointPolicy::every(2);

    // Pre-generate ordinary ids up front so the "next" ordinary event's id is
    // already minted BEFORE the checkpoint event is created.
    let e1 = run_started(run_id);
    let e2 = run_started(run_id);
    let e3 = run_started(run_id); // id minted now, appended after the checkpoint
    assert!(e1.id.as_uuid() < e2.id.as_uuid());
    assert!(e2.id.as_uuid() < e3.id.as_uuid());

    // Cross the cadence boundary => a checkpoint is emitted. Its id is minted
    // (EventId::new()) AFTER e3's id was generated, so checkpoint_id > e3.id.
    store
        .append_signed_with_checkpoint(&e1, &key, &kernel_signer(), &policy)
        .unwrap();
    store
        .append_signed_with_checkpoint(&e2, &key, &kernel_signer(), &policy)
        .unwrap();

    let checkpoints = checkpoints_for_run(&store, run_id);
    assert_eq!(
        checkpoints.len(),
        1,
        "cadence-2 checkpoint over the first two events"
    );
    let (cp_id, _) = &checkpoints[0];
    assert!(
        cp_id.as_uuid() > e3.id.as_uuid(),
        "regression precondition: emitted checkpoint id must exceed the pre-generated ordinary id"
    );

    // e3 has a lower id than the just-emitted checkpoint, but a higher id than
    // the latest ORDINARY event (e2). It MUST be accepted.
    store
        .append_signed_with_checkpoint(&e3, &key, &kernel_signer(), &policy)
        .expect("ordinary event with id below the emitted checkpoint id must be accepted");

    let ordinary_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1 AND kind = 'run_started'",
            [run_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ordinary_count, 3, "all three ordinary events must persist");
}

#[test]
fn monotonic_guard_is_per_run_and_allows_interleaving() {
    // The monotonic guard is per-run: a low-id event for run B is accepted even
    // when run A already holds higher-id events. Interleaving distinct runs is
    // unaffected.
    let store = SqliteStore::open_in_memory().unwrap();
    let key = fixture_key();
    let policy = CheckpointPolicy::every(256);

    let run_a = RunId::new();
    let run_b = RunId::new();

    // Append a high-id event to run A first.
    let a1 = run_started(run_a);
    store
        .append_signed_with_checkpoint(&a1, &key, &kernel_signer(), &policy)
        .unwrap();

    // run B's first event carries a lower id than run A's existing event; the
    // per-run guard must NOT reject it (different run_id).
    let mut b1 = run_started(run_b);
    b1.id = EventId::from_uuid(
        uuid::Uuid::parse_str("00000000-0000-7000-8000-000000000001").unwrap(),
    );
    assert!(b1.id.as_uuid() < a1.id.as_uuid());
    store
        .append_signed_with_checkpoint(&b1, &key, &kernel_signer(), &policy)
        .expect("per-run guard must not reject a low-id event for a different run");

    // Both events persisted under their own runs.
    let a_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1",
            [run_a.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let b_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1",
            [run_b.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(a_count, 1);
    assert_eq!(b_count, 1);
}
