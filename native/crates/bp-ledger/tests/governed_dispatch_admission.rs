//! Durable governed-dispatch admission coverage.
//!
//! Admission is intentionally a two-phase native control: the signed V3
//! dispatch becomes durable with an immutable projection first, then a distinct
//! checkpoint seal makes that projection recovery-verifiable. A raw V3 event
//! or generic signed append is not admission success.

use bp_ledger::event::Event;
use bp_ledger::id::RunId;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    dispatch_envelope_v3_body_digest, ActionEvidenceVersionV1, CommitModeV1, DispatchBudgetV1,
    DispatchEnvelopeBodyV2, DispatchEnvelopeV3, ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    GovernedDispatchAdmissionAuthorityV1, GovernedDispatchAdmissionDispositionV1,
    GovernedDispatchAdmissionRequestV1, GovernedDispatchAdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::LedgerError;
use bp_ledger::Payload;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection};
use std::path::Path;
use tempfile::TempDir;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn actor(actor_id: &str, key_id: &str, key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.into(),
        key_id: key_id.into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn trusted_keys(keys: &[&SigningKey]) -> TrustedPublicKeys {
    let mut trusted = TrustedPublicKeys::default();
    for key in keys {
        trusted.insert_public_key(
            public_key_hash(&key.verifying_key()),
            key.verifying_key().to_bytes().to_vec(),
        );
    }
    trusted
}

fn governed_implementer_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "implement-unit-1".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:implement-unit-1:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        realm_digest,
        Some(DIGEST_C),
    )
    .expect("hash governed implementer dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: realm_digest.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn rehash_dispatch(dispatch: &mut DispatchEnvelopeV3) {
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("rehash V3 dispatch");
}

fn admission_authority(
    dispatch_key: &SigningKey,
    checkpoint_key: &SigningKey,
    realm_digest: &str,
) -> (
    GovernedDispatchAdmissionAuthorityV1,
    ActorKeyRef,
    ActorKeyRef,
) {
    let dispatch_signer = actor("broker:dispatch", "dispatch-1", dispatch_key);
    let checkpoint_signer = actor("kernel:checkpoint", "checkpoint-1", checkpoint_key);
    let authority = GovernedDispatchAdmissionAuthorityV1::new_governed_realm(
        trusted_keys(&[dispatch_key, checkpoint_key]),
        dispatch_signer.clone(),
        checkpoint_signer.clone(),
        realm_digest.into(),
    )
    .expect("construct governed admission authority");
    (authority, dispatch_signer, checkpoint_signer)
}

fn raw_same_identity_dispatch_v3_event(request: &GovernedDispatchAdmissionRequestV1) -> Event {
    Event {
        id: bp_ledger::EventId::new(),
        run_id: request.run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(request.dispatch.clone()),
    }
}

struct LegacyB87AdmissionFixture {
    run_id: RunId,
    dispatch_event_ids: Vec<bp_ledger::EventId>,
    dispatches: Vec<DispatchEnvelopeV3>,
}

fn bootstrap_legacy_b87_governed_dispatch_admissions(
    ledger_path: &Path,
    revisions: &[&str],
) -> LegacyB87AdmissionFixture {
    let conn = Connection::open(ledger_path).expect("open legacy b87 ledger file");
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys=ON;

        CREATE TABLE events (
            id               TEXT PRIMARY KEY,
            run_id           TEXT NOT NULL,
            parent_event_id  TEXT,
            schema_version   INTEGER NOT NULL,
            kind             TEXT NOT NULL,
            occurred_at      TEXT NOT NULL,
            payload          TEXT NOT NULL
        );

        CREATE TABLE governed_dispatch_admissions (
            run_id                              TEXT NOT NULL,
            idempotency_key                     TEXT NOT NULL,
            workflow_id                         TEXT NOT NULL,
            workflow_revision                   TEXT NOT NULL,
            unit_id                             TEXT NOT NULL,
            attempt                             INTEGER NOT NULL CHECK(attempt > 0),
            envelope_digest                     TEXT NOT NULL,
            governed_packet_digest              TEXT NOT NULL,
            semantic_identity_digest            TEXT NOT NULL,
            dispatch_event_id                   TEXT NOT NULL UNIQUE,
            dispatch_event_digest               TEXT NOT NULL,
            state                               TEXT NOT NULL CHECK(state IN ('awaiting_checkpoint', 'sealed')),
            sealed_checkpoint_event_id          TEXT,
            sealed_checkpoint_event_digest      TEXT,
            created_at                          TEXT NOT NULL,
            sealed_at                           TEXT,
            PRIMARY KEY (run_id, idempotency_key),
            UNIQUE (run_id, workflow_id, workflow_revision, unit_id, attempt),
            UNIQUE (run_id, semantic_identity_digest),
            FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
            FOREIGN KEY(sealed_checkpoint_event_id) REFERENCES events(id),
            CHECK(
                (state = 'awaiting_checkpoint'
                    AND sealed_checkpoint_event_id IS NULL
                    AND sealed_checkpoint_event_digest IS NULL
                    AND sealed_at IS NULL)
                OR
                (state = 'sealed'
                    AND sealed_checkpoint_event_id IS NOT NULL
                    AND sealed_checkpoint_event_digest IS NOT NULL
                    AND sealed_at IS NOT NULL)
            )
        );
        "#,
    )
    .expect("create b87-style admission schema");

    let run_id = RunId::new();
    let mut dispatch_event_ids = Vec::with_capacity(revisions.len());
    let mut dispatches = Vec::with_capacity(revisions.len());
    for (index, revision) in revisions.iter().enumerate() {
        let mut dispatch = governed_implementer_dispatch(Utc::now(), DIGEST_B);
        dispatch.body.workflow_revision = (*revision).into();
        dispatch.body.idempotency_key = format!(
            "legacy:workflow-1:implement-unit-1:{revision}:{}",
            index + 1
        );
        rehash_dispatch(&mut dispatch);
        let event = Event {
            id: bp_ledger::EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::DispatchEnvelopeV3,
            occurred_at: Utc::now(),
            payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
        };
        let payload = serde_json::to_string(&event.payload).expect("serialize legacy event");
        conn.execute(
            r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                event.id.to_string(),
                event.run_id.to_string(),
                event.parent_event_id.map(|id| id.to_string()),
                event.schema_version,
                event.kind.as_wire(),
                event.occurred_at.to_rfc3339(),
                payload,
            ],
        )
        .expect("insert replayable legacy event");
        conn.execute(
            r#"INSERT INTO governed_dispatch_admissions (
                    run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt,
                    envelope_digest, governed_packet_digest, semantic_identity_digest,
                    dispatch_event_id, dispatch_event_digest, state, created_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    'awaiting_checkpoint', ?12
                )"#,
            params![
                run_id.to_string(),
                &dispatch.body.idempotency_key,
                &dispatch.body.workflow_id,
                &dispatch.body.workflow_revision,
                &dispatch.body.unit_id,
                dispatch.body.attempt,
                &dispatch.envelope_digest,
                dispatch
                    .governed_packet_digest
                    .as_deref()
                    .expect("fixture dispatch includes governed packet digest"),
                format!("sha256:{:064x}", index + 1),
                event.id.to_string(),
                format!("sha256:{:064x}", 100 + index),
                event.occurred_at.to_rfc3339(),
            ],
        )
        .expect("insert legacy b87 admission projection");
        dispatch_event_ids.push(event.id);
        dispatches.push(dispatch);
    }

    LegacyB87AdmissionFixture {
        run_id,
        dispatch_event_ids,
        dispatches,
    }
}

#[test]
fn legacy_b87_admission_without_cross_revision_conflict_opens_and_replays_events() {
    let temp = TempDir::new().expect("create file-backed legacy ledger directory");
    let ledger_path = temp.path().join("legacy-b87-no-conflict.db");
    let fixture = bootstrap_legacy_b87_governed_dispatch_admissions(&ledger_path, &["r1"]);

    let store = SqliteStore::open(&ledger_path).expect("open compatible legacy b87 ledger");
    assert_eq!(store.event_count().expect("count legacy events"), 1);
    let events = store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read legacy tape events");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].to_event().expect("parse legacy tape event").kind,
        EventKind::DispatchEnvelopeV3
    );
    let identity_index_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            ["idx_governed_dispatch_admissions_workflow_attempt"],
            |row| row.get(0),
        )
        .expect("query V2 identity index");
    assert_eq!(identity_index_count, 1);
}

#[test]
fn legacy_b87_cross_revision_conflict_opens_without_rewriting_historical_rows() {
    let temp = TempDir::new().expect("create file-backed legacy ledger directory");
    let ledger_path = temp.path().join("legacy-b87-cross-revision-conflict.db");
    let fixture = bootstrap_legacy_b87_governed_dispatch_admissions(&ledger_path, &["r1", "r2"]);

    let store = SqliteStore::open(&ledger_path)
        .expect("V2 guard must open a legacy conflicting admission ledger");
    assert_eq!(store.event_count().expect("count historical events"), 2);
    let events = store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read historical tape events");
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(
        |event| event.to_event().expect("parse historical event").kind
            == EventKind::DispatchEnvelopeV3
    ));
    let admissions: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_admissions WHERE run_id = ?1",
            [fixture.run_id.to_string()],
            |row| row.get(0),
        )
        .expect("count historical admission projections");
    assert_eq!(admissions, 2);
    let identity_index_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            ["idx_governed_dispatch_admissions_workflow_attempt"],
            |row| row.get(0),
        )
        .expect("query absent V2 identity index");
    assert_eq!(identity_index_count, 0);
    let conflict_markers: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_admission_identity_conflicts_v2
             WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4",
            params![
                fixture.run_id.to_string(),
                "workflow-1",
                "implement-unit-1",
                1,
            ],
            |row| row.get(0),
        )
        .expect("read immutable V2 conflict marker");
    assert_eq!(conflict_markers, 1);
    let future_duplicate = store
        .conn_for_tests()
        .execute(
            r#"INSERT INTO governed_dispatch_admissions (
                    run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt,
                    envelope_digest, governed_packet_digest, semantic_identity_digest,
                    dispatch_event_id, dispatch_event_digest, state, created_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    'awaiting_checkpoint', ?12
                )"#,
            params![
                fixture.run_id.to_string(),
                "future:duplicate",
                "workflow-1",
                "r3",
                "implement-unit-1",
                1,
                DIGEST_A,
                DIGEST_C,
                "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                bp_ledger::EventId::new().to_string(),
                DIGEST_D,
                Utc::now().to_rfc3339(),
            ],
        )
        .expect_err("V2 trigger must reject a future duplicate projection");
    assert!(future_duplicate
        .to_string()
        .contains("governed dispatch admission identity already exists"));
    assert_eq!(
        store
            .event_count()
            .expect("count events after rejected duplicate"),
        2
    );
    drop(store);

    let reopened = SqliteStore::open(&ledger_path)
        .expect("V2 guard must be idempotent across conflicting legacy reopens");
    let reopened_markers: i64 = reopened
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_admission_identity_conflicts_v2
             WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4",
            params![
                fixture.run_id.to_string(),
                "workflow-1",
                "implement-unit-1",
                1,
            ],
            |row| row.get(0),
        )
        .expect("read stable V2 conflict marker after reopen");
    assert_eq!(reopened_markers, 1);
    assert_eq!(
        reopened
            .events_for_run(&fixture.run_id.to_string())
            .expect("replay historical events after reopen")
            .len(),
        2
    );
}

#[test]
fn legacy_b87_cross_revision_conflict_fails_closed_for_record_and_seal_without_mutation() {
    let temp = TempDir::new().expect("create file-backed legacy ledger directory");
    let ledger_path = temp.path().join("legacy-b87-runtime-conflict.db");
    let fixture = bootstrap_legacy_b87_governed_dispatch_admissions(&ledger_path, &["r1", "r2"]);
    let store = SqliteStore::open(&ledger_path)
        .expect("V2 guard must open a legacy conflicting admission ledger");
    let dispatch_key = SigningKey::from_bytes(&[71_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[73_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: fixture.run_id,
        dispatch: fixture.dispatches[0].clone(),
    };
    let before_events = store.event_count().expect("count historical events");

    let record = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("conflicted legacy identity must not return historical authority");
    assert!(matches!(
        record,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().expect("count events after record"),
        before_events
    );

    let seal = store
        .seal_governed_dispatch_admission_v1(
            &GovernedDispatchAdmissionSealRequestV1 {
                run_id: fixture.run_id,
                dispatch_event_id: fixture.dispatch_event_ids[0],
            },
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("conflicted legacy identity must not seal a selected historical row");
    assert!(matches!(
        seal,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().expect("count events after seal"),
        before_events
    );
    let awaiting_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_admissions
             WHERE run_id = ?1 AND state = 'awaiting_checkpoint'",
            [fixture.run_id.to_string()],
            |row| row.get(0),
        )
        .expect("count unmodified historical admissions");
    assert_eq!(awaiting_count, 2);
}

#[test]
fn governed_dispatch_admission_records_and_exact_retry_resolves_original_awaiting_checkpoint() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[7_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[9_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };

    let first = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record governed admission");
    let (dispatch_event_id, dispatch_event_digest, semantic_identity_digest, idempotency_key) =
        match first {
            GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
                dispatch_event_id,
                dispatch_event_digest,
                semantic_identity_digest,
                idempotency_key,
            } => (
                dispatch_event_id,
                dispatch_event_digest,
                semantic_identity_digest,
                idempotency_key,
            ),
            other => panic!("new admission must await its dedicated checkpoint, got {other:?}"),
        };
    assert_eq!(store.event_count().unwrap(), 1);

    let retry = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("resolve exact admission retry");
    assert_eq!(
        retry,
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id,
            dispatch_event_digest,
            semantic_identity_digest,
            idempotency_key,
        }
    );
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "retry must not append a second dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_mismatched_idempotency_or_attempt_reuse_without_append() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[11_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[13_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record original admission");

    let mut same_key_different_dispatch = request.clone();
    same_key_different_dispatch
        .dispatch
        .repository_binding_digest = DIGEST_D.into();
    rehash_dispatch(&mut same_key_different_dispatch.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &same_key_different_dispatch,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("same idempotency key may not select different V3 authority bytes");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));

    let mut same_attempt_different_key = request.clone();
    same_attempt_different_key.dispatch.body.idempotency_key = "dispatch:other-key".into();
    rehash_dispatch(&mut same_attempt_different_key.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &same_attempt_different_key,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("one workflow/unit/attempt may not have two admission projections");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "conflicts must not append another V3 dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_changed_revision_and_idempotency_for_same_attempt() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[15_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[17_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record original admission");

    let mut changed_revision_and_key = request.clone();
    changed_revision_and_key.dispatch.body.workflow_revision = "r2".into();
    changed_revision_and_key.dispatch.body.idempotency_key =
        "dispatch:workflow-1:implement-unit-1:r2".into();
    rehash_dispatch(&mut changed_revision_and_key.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &changed_revision_and_key,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("one workflow/unit/attempt may not gain a changed-revision sibling");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "a changed revision and idempotency key must not append a second V3 dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_unsafe_v3_posture_without_write() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[17_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[19_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let mut unsafe_dispatch = governed_implementer_dispatch(Utc::now(), DIGEST_B);
    unsafe_dispatch.body.execution_role = ExecutionRoleV1::Candidate;
    rehash_dispatch(&mut unsafe_dispatch);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: unsafe_dispatch,
    };

    let error = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("candidate V3 dispatch must never be escalated to governed admission");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        0,
        "unsafe posture must not write a tape event"
    );
}

#[test]
fn governed_dispatch_admission_rejects_inactive_or_elapsed_authority_without_append() {
    let dispatch_key = SigningKey::from_bytes(&[41_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[43_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let now = Utc::now();

    let mut expired = governed_implementer_dispatch(now - Duration::minutes(20), DIGEST_B);
    expired.body.budget.max_compute_time_ms = None;
    rehash_dispatch(&mut expired);
    let inactive = governed_implementer_dispatch(now + Duration::minutes(5), DIGEST_B);
    let compute_deadline_elapsed =
        governed_implementer_dispatch(now - Duration::minutes(2), DIGEST_B);

    for (description, dispatch, expected_reason) in [
        ("expired", expired, "expired"),
        ("not yet active", inactive, "not yet active"),
        (
            "compute deadline elapsed",
            compute_deadline_elapsed,
            "compute deadline has elapsed",
        ),
    ] {
        let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
        let request = GovernedDispatchAdmissionRequestV1 {
            run_id: RunId::new(),
            dispatch,
        };

        let error = store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect_err("{description} V3 authority must not be admitted");
        assert!(matches!(
            error,
            LedgerError::GovernedDispatchAdmissionAuthorityRejected { reason }
                if reason.contains(expected_reason)
        ));
        assert_eq!(
            store.event_count().unwrap(),
            0,
            "{description} authority must not append a tape event"
        );
    }
}

#[test]
fn governed_dispatch_admission_blocks_changed_revision_raw_v3_without_native_projection() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[23_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[29_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let mut raw_dispatch = request.dispatch.clone();
    raw_dispatch.body.workflow_revision = "r2".into();
    raw_dispatch.body.idempotency_key = "dispatch:workflow-1:implement-unit-1:r2".into();
    rehash_dispatch(&mut raw_dispatch);
    let raw_event = Event {
        id: bp_ledger::EventId::new(),
        run_id: request.run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(raw_dispatch),
    };
    store
        .append_signed(&raw_event, &dispatch_key, &dispatch_signer)
        .expect("direct signed append leaves a raw V3 event for reconciliation coverage");

    let error = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("raw V3 event cannot be silently adopted as an admission");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "reconciliation must not append a sibling dispatch"
    );
}

#[test]
fn governed_dispatch_admission_withholds_success_until_its_exact_checkpoint_seals_and_retries() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[31_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[37_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let awaiting = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record admission before sealing");
    let dispatch_event_id = match awaiting {
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id, ..
        } => dispatch_event_id,
        other => panic!("unsealed admission must not report success, got {other:?}"),
    };
    let seal_request = GovernedDispatchAdmissionSealRequestV1 {
        run_id: request.run_id,
        dispatch_event_id,
    };

    store.fail_next_checkpoint_signature_insert_for_tests();
    let error = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("failed checkpoint must withhold admission success");
    assert!(matches!(error, LedgerError::AppendOnlyViolation(_)));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "failed checkpoint insert must roll back"
    );
    assert!(matches!(
        store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect("retry resolves the original unsealed record"),
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint { .. }
    ));

    let sealed = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("retry seals the original admission rather than appending another dispatch");
    let checkpoint_event_id = match &sealed {
        GovernedDispatchAdmissionDispositionV1::Sealed {
            dispatch_event_id: sealed_dispatch_event_id,
            checkpoint_event_id,
            ..
        } => {
            assert_eq!(*sealed_dispatch_event_id, dispatch_event_id);
            *checkpoint_event_id
        }
        other => panic!("dedicated seal must report a sealed admission, got {other:?}"),
    };
    assert_ne!(checkpoint_event_id, dispatch_event_id);
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "sealing emits only the checkpoint"
    );
    assert_eq!(
        store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect("sealed retry resolves the original sealed admission"),
        sealed
    );
    assert_eq!(
        store
            .seal_governed_dispatch_admission_v1(
                &seal_request,
                &authority,
                &checkpoint_key,
                &checkpoint_signer,
            )
            .expect("normal seal retry resolves the original sealed admission"),
        sealed
    );
}

#[test]
fn governed_dispatch_admission_sealed_retries_require_reconciliation_for_raw_same_identity_v3_sibling(
) {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[43_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[47_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let awaiting = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record admission before sealing");
    let dispatch_event_id = match awaiting {
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id, ..
        } => dispatch_event_id,
        other => panic!("unsealed admission must not report success, got {other:?}"),
    };
    let seal_request = GovernedDispatchAdmissionSealRequestV1 {
        run_id: request.run_id,
        dispatch_event_id,
    };
    assert!(matches!(
        store
            .seal_governed_dispatch_admission_v1(
                &seal_request,
                &authority,
                &checkpoint_key,
                &checkpoint_signer,
            )
            .expect("seal original admission"),
        GovernedDispatchAdmissionDispositionV1::Sealed { .. }
    ));

    let raw_sibling = raw_same_identity_dispatch_v3_event(&request);
    assert_ne!(raw_sibling.id, dispatch_event_id);
    store
        .append_signed(&raw_sibling, &dispatch_key, &dispatch_signer)
        .expect("append raw same-identity V3 sibling after seal");

    let record_retry = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("sealed record retry must reconcile the raw V3 sibling");
    assert!(matches!(
        record_retry,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));

    let seal_retry = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("sealed retry must reconcile the raw V3 sibling");
    assert!(matches!(
        seal_retry,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
}

#[test]
fn governed_dispatch_admission_fresh_seal_materializes_before_a_later_raw_v3_sibling() {
    let temp = TempDir::new().expect("create file-backed ledger directory");
    let ledger_path = temp.path().join("events.db");
    let store = SqliteStore::open(&ledger_path).expect("open primary ledger");
    let dispatch_key = SigningKey::from_bytes(&[53_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[59_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let awaiting = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record admission before sealing");
    let dispatch_event_id = match awaiting {
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id, ..
        } => dispatch_event_id,
        other => panic!("unsealed admission must not report success, got {other:?}"),
    };
    let seal_request = GovernedDispatchAdmissionSealRequestV1 {
        run_id: request.run_id,
        dispatch_event_id,
    };
    let secondary = SqliteStore::open(&ledger_path).expect("open independent secondary ledger");
    let raw_sibling = raw_same_identity_dispatch_v3_event(&request);
    let secondary_dispatch_key = dispatch_key.clone();
    let secondary_dispatch_signer = dispatch_signer.clone();

    let sealed = store
        .seal_governed_dispatch_admission_v1_with_after_transition_hook_for_tests(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
            move || {
                secondary
                    .append_signed(
                        &raw_sibling,
                        &secondary_dispatch_key,
                        &secondary_dispatch_signer,
                    )
                    .expect("real secondary store appends the raw V3 sibling");
            },
        )
        .expect("a sibling appended after sealing must not rewrite the sealed result");
    assert!(matches!(
        sealed,
        GovernedDispatchAdmissionDispositionV1::Sealed {
            dispatch_event_id: sealed_dispatch_event_id,
            ..
        } if sealed_dispatch_event_id == dispatch_event_id
    ));
    assert_eq!(
        store.event_count().expect("count persisted events"),
        3,
        "the later raw sibling is durable but outside the sealed decision"
    );

    let later_retry = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("a later retry must reopen reconciliation for the raw sibling");
    assert!(matches!(
        later_retry,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
}

#[test]
fn governed_dispatch_admission_sealed_retry_materializes_before_a_later_raw_v3_sibling() {
    let temp = TempDir::new().expect("create file-backed ledger directory");
    let ledger_path = temp.path().join("events.db");
    let store = SqliteStore::open(&ledger_path).expect("open primary ledger");
    let dispatch_key = SigningKey::from_bytes(&[61_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[67_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let awaiting = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record admission before sealing");
    let dispatch_event_id = match awaiting {
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id, ..
        } => dispatch_event_id,
        other => panic!("unsealed admission must not report success, got {other:?}"),
    };
    let seal_request = GovernedDispatchAdmissionSealRequestV1 {
        run_id: request.run_id,
        dispatch_event_id,
    };
    let first_seal = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("initial seal succeeds");
    let secondary = SqliteStore::open(&ledger_path).expect("open independent secondary ledger");
    let raw_sibling = raw_same_identity_dispatch_v3_event(&request);
    let secondary_dispatch_key = dispatch_key.clone();
    let secondary_dispatch_signer = dispatch_signer.clone();

    let retry = store
        .seal_governed_dispatch_admission_v1_with_after_transition_hook_for_tests(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
            move || {
                secondary
                    .append_signed(
                        &raw_sibling,
                        &secondary_dispatch_key,
                        &secondary_dispatch_signer,
                    )
                    .expect("real secondary store appends the raw V3 sibling");
            },
        )
        .expect("a later raw sibling must not rewrite the retried sealed result");
    assert_eq!(
        retry, first_seal,
        "normal sealed retry keeps its original result"
    );
    assert_eq!(
        store.event_count().expect("count persisted events"),
        3,
        "the later raw sibling is durable but outside the retried sealed decision"
    );

    let later_retry = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("a later retry must reopen reconciliation for the raw sibling");
    assert!(matches!(
        later_retry,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
}
