//! SQLite-backed event store — append-only, trigger-enforced.

use crate::canonicalize::canonicalize_payload;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::id::{EventId, RunId};
use crate::kind::EventKind;
use crate::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use crate::payload::Payload;
use crate::signing::{
    sign_event, verify_event_signature, ActorKeyRef, EventSignatureV1, SignatureAlgorithm,
    TrustedPublicKeys, VerificationStatus,
};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension};
use std::cell::Cell;
use std::path::Path;
use uuid::Uuid;

/// Default tape-root checkpoint cadence: emit one checkpoint per 256 signed
/// events per run.
pub const DEFAULT_CHECKPOINT_CADENCE: u64 = 256;

/// Tape-root checkpoint emission policy for the signed-append path.
///
/// Checkpoints belong to signed mode. A `Disabled` policy (the default for the
/// legacy [`SqliteStore::append_signed`] surface) never emits checkpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointPolicy {
    /// Never emit tape-root checkpoints.
    Disabled,
    /// Emit a checkpoint every `cadence` signed ordinary events per run, and a
    /// final checkpoint at `run_completed` when at least one signed ordinary
    /// event is uncheckpointed since the last checkpoint.
    Enabled { cadence: u64 },
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        CheckpointPolicy::Enabled {
            cadence: DEFAULT_CHECKPOINT_CADENCE,
        }
    }
}

impl CheckpointPolicy {
    /// Enable checkpoints with an explicit per-run cadence. A cadence of 0 is
    /// treated as 1 (emit on every signed event) to avoid a divide-by-never.
    pub fn every(cadence: u64) -> Self {
        CheckpointPolicy::Enabled {
            cadence: cadence.max(1),
        }
    }
}

/// SQLite connection wrapping the events + runs schema.
pub struct SqliteStore {
    conn: Connection,
    /// Test-only one-shot fault injector for the checkpoint signature insert.
    /// Always `false` in production; armed only by `*_for_tests` helpers.
    fail_next_checkpoint_signature_insert: Cell<bool>,
}

impl SqliteStore {
    /// Open or create a ledger database at `path`. Creates tables and the
    /// append-only trigger on first open.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self {
            conn,
            fail_next_checkpoint_signature_insert: Cell::new(false),
        })
    }

    /// Open an in-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self {
            conn,
            fail_next_checkpoint_signature_insert: Cell::new(false),
        })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS events (
                id               TEXT PRIMARY KEY,
                run_id           TEXT NOT NULL,
                parent_event_id  TEXT,
                schema_version   INTEGER NOT NULL,
                kind             TEXT NOT NULL,
                occurred_at      TEXT NOT NULL,
                payload          TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
            CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);

            CREATE TRIGGER IF NOT EXISTS events_no_update
                BEFORE UPDATE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS events_no_delete
                BEFORE DELETE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden');
                END;

            CREATE TABLE IF NOT EXISTS event_signatures (
                event_id              TEXT PRIMARY KEY,
                canonical_event_hash  TEXT NOT NULL,
                actor_id              TEXT NOT NULL,
                key_id                TEXT NOT NULL,
                public_key_hash       TEXT,
                algorithm             TEXT NOT NULL,
                signature             TEXT NOT NULL,
                signed_at             TEXT NOT NULL,
                FOREIGN KEY(event_id) REFERENCES events(id)
            );

            CREATE TRIGGER IF NOT EXISTS event_signatures_no_update
                BEFORE UPDATE ON event_signatures
                BEGIN
                    SELECT RAISE(ABORT, 'event_signatures is append-only: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS event_signatures_no_delete
                BEFORE DELETE ON event_signatures
                BEGIN
                    SELECT RAISE(ABORT, 'event_signatures is append-only: DELETE forbidden');
                END;

            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                started_at       TEXT NOT NULL,
                completed_at     TEXT,
                outcome          TEXT,
                workspace_path   TEXT NOT NULL,
                packet_hash      TEXT NOT NULL,
                schema_version   INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    /// Append an event to the log. Fails if the id already exists.
    pub fn append(&self, event: &Event) -> Result<()> {
        insert_event(&self.conn, event)
    }

    /// Append a detached event signature. The `event_signatures` table is
    /// append-only and keyed by `event_id`, so duplicates and missing event ids
    /// fail through SQLite constraints.
    pub fn append_event_signature(&self, signature: &EventSignatureV1) -> Result<()> {
        insert_event_signature(&self.conn, signature)
    }

    /// Append an event and its matching detached signature atomically (signed
    /// mode).
    ///
    /// Within a single SQLite transaction this: (1) signs the canonical event
    /// bytes with `signing_key`, (2) inserts the event row, (3) inserts the
    /// matching `event_signatures` row, and commits only if all three succeed.
    /// If signing fails, the event-row insert fails, or the signature insert
    /// fails, the transaction rolls back and no event row persists — the append
    /// fails closed.
    ///
    /// The signature is produced before the inserts so a signing error never
    /// touches the database. `signer.public_key_hash` is overwritten by
    /// [`sign_event`] with the verifying-key digest.
    ///
    /// On a `COMMIT` failure the transaction is dropped without committing, so
    /// the inserts leave no committed state on this per-process connection; the
    /// error is surfaced to the caller and the append fails closed.
    // TODO(M4-04 multi-actor): `signer` is currently always the kernel actor,
    // so every event is signed under kernel authorship. Per-actor signing is a
    // follow-up (see R-004); this slice intentionally signs all-under-kernel.
    pub fn append_signed(
        &self,
        event: &Event,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<()> {
        self.append_signed_with_checkpoint(event, signing_key, signer, &CheckpointPolicy::Disabled)
            .map(|_| ())
    }

    /// Append a signed event and, per `policy`, emit a tape-root checkpoint.
    ///
    /// This first appends the ordinary event and its detached signature exactly
    /// as [`append_signed`] does (one atomic transaction; fails closed on any
    /// signing or insert error). Then, in signed mode with an enabled policy:
    ///
    /// 1. count the run's uncheckpointed signed ordinary events;
    /// 2. if the cadence boundary is reached — or the event is `run_completed`
    ///    and at least one signed ordinary event is uncheckpointed — build a
    ///    checkpoint over the full prefix of the run's signed ordinary event
    ///    hashes through the latest such event;
    /// 3. sign the checkpoint event and append it together with its signature in
    ///    a single transaction, so a checkpoint never persists without its
    ///    signature (fail closed).
    ///
    /// Returns the ids of any checkpoint events emitted (0 or 1). A failure
    /// while building/appending the checkpoint surfaces as an error; the
    /// ordinary event remains committed (it was its own atomic append), but the
    /// checkpoint event and its signature roll back together.
    ///
    /// `tape_checkpoint` events do not themselves count toward the cadence and
    /// are never checkpointed.
    ///
    /// Two-transaction edge: the ordinary event commits in its own transaction
    /// before checkpoint emission. If checkpoint emission then fails (e.g. its
    /// signature insert aborts), the ordinary event stays committed without its
    /// (final) checkpoint. This is recoverable — a later signed event for the
    /// run re-triggers emission over the still-uncheckpointed prefix — and never
    /// breaks per-event verification, which does not depend on checkpoints.
    pub fn append_signed_with_checkpoint(
        &self,
        event: &Event,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        policy: &CheckpointPolicy,
    ) -> Result<Vec<EventId>> {
        // Guard (Codex P1-1): reject caller/wire-supplied checkpoint events
        // before signing or persisting anything. `tape_checkpoint` events are
        // ledger-internal and created only by `emit_checkpoint` (which inserts
        // directly via `insert_event`/`insert_event_signature`, bypassing this
        // public entry point), so this never blocks legitimate internal
        // checkpoints. Without this, a producer could inject a forged checkpoint
        // that `latest_checkpoint` would then trust, corrupting cadence.
        if event.kind == EventKind::TapeCheckpoint {
            return Err(LedgerError::CallerSuppliedCheckpoint);
        }

        // Guard (Codex P1-2): enforce a per-run strictly-monotonic event id on
        // incoming ordinary events before signing or persisting. UUIDv7 ids are
        // time-monotonic and runs are single-producer, so an id that is not
        // strictly greater than the latest existing id for the SAME run would
        // either be a replay or an out-of-order insert that could retroactively
        // invalidate a checkpoint's coverage. The guard is per-run, so events
        // for different runs interleaving freely are unaffected.
        if let Some(latest) = self.latest_event_id_for_run(&event.run_id)? {
            if event.id.as_uuid() <= latest.as_uuid() {
                return Err(LedgerError::NonMonotonicEventId {
                    run_id: event.run_id.to_string(),
                });
            }
        }

        // Step 1+2 (spec ordering): append the ordinary event and flush its
        // detached signature atomically. Sign first so a signing failure never
        // reaches the storage transaction.
        let signature = sign_event(event, signing_key, signer, Utc::now())?;
        {
            let tx = self.conn.unchecked_transaction()?;
            insert_event(&tx, event)?;
            insert_event_signature(&tx, &signature)?;
            tx.commit()?;
        }

        let CheckpointPolicy::Enabled { cadence } = *policy else {
            return Ok(vec![]);
        };

        // Step 3: decide whether a checkpoint is due over the run's signed
        // ordinary events. `prior` is the last checkpoint for this run, if any.
        let prior = self.latest_checkpoint(&event.run_id)?;
        let already_checkpointed = prior.as_ref().map(|p| p.through_event_count).unwrap_or(0);
        let covered = self.signed_ordinary_events(&event.run_id)?;
        let total = covered.len() as u64;
        let uncheckpointed = total.saturating_sub(already_checkpointed);

        let is_final = event.kind == EventKind::RunCompleted;
        let cadence_due = uncheckpointed >= cadence;
        let final_due = is_final && uncheckpointed >= 1;
        if !cadence_due && !final_due {
            return Ok(vec![]);
        }

        let checkpoint_id =
            self.emit_checkpoint(&event.run_id, &covered, prior, signing_key, signer)?;
        Ok(vec![checkpoint_id])
    }

    /// Build, sign, and atomically append a tape-root checkpoint over the full
    /// prefix of `covered` (the run's signed ordinary events, id-ordered).
    fn emit_checkpoint(
        &self,
        run_id: &RunId,
        covered: &[SignedOrdinaryEvent],
        prior: Option<StoredCheckpoint>,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<EventId> {
        let through = covered.last().expect("checkpoint requires >=1 covered event");
        let hashes: Vec<String> = covered.iter().map(|e| e.canonical_event_hash.clone()).collect();
        let root = tape_root_hash(&hashes);

        let checkpoint_index = prior.as_ref().map(|p| p.checkpoint_index + 1).unwrap_or(0);
        let previous_checkpoint_event_id = prior.as_ref().map(|p| p.event_id);

        let payload = TapeCheckpointV1 {
            run_id: *run_id,
            checkpoint_index,
            through_event_id: through.event_id,
            through_event_count: covered.len() as u64,
            previous_checkpoint_event_id,
            tape_root_hash: root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        };

        let checkpoint_event = Event {
            id: EventId::new(),
            run_id: *run_id,
            parent_event_id: Some(through.event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::TapeCheckpoint,
            occurred_at: Utc::now(),
            payload: Payload::TapeCheckpointV1(payload),
        };

        // Sign the checkpoint before opening the transaction.
        let signature = sign_event(&checkpoint_event, signing_key, signer, Utc::now())?;

        let tx = self.conn.unchecked_transaction()?;
        insert_event(&tx, &checkpoint_event)?;
        if self.fail_next_checkpoint_signature_insert.replace(false) {
            // Test-only injected fault: drop the tx without committing so the
            // checkpoint event row rolls back with its (never-inserted)
            // signature. Mirrors a real signature-insert failure.
            return Err(LedgerError::AppendOnlyViolation(
                "injected checkpoint signature insert failure (test only)".into(),
            ));
        }
        insert_event_signature(&tx, &signature)?;
        tx.commit()?;
        Ok(checkpoint_event.id)
    }

    /// Arm a one-shot fault that makes the next checkpoint signature insert fail
    /// after the checkpoint event row has been inserted in the same transaction.
    /// Test-only — used to prove the checkpoint's fail-closed rollback.
    pub fn fail_next_checkpoint_signature_insert_for_tests(&self) {
        self.fail_next_checkpoint_signature_insert.set(true);
    }

    /// The id of the most recently appended event for a run (any kind),
    /// id-ordered (UUIDv7 = time order), or `None` if the run has no events.
    /// Used by the per-run monotonic-id guard on the signed-append path.
    fn latest_event_id_for_run(&self, run_id: &RunId) -> Result<Option<EventId>> {
        let last: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM events WHERE run_id = ?1 ORDER BY id DESC LIMIT 1",
                params![run_id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        match last {
            Some(s) => Ok(Some(parse_event_id(&s, "events")?)),
            None => Ok(None),
        }
    }

    /// The latest tape-root checkpoint for a run, if any.
    fn latest_checkpoint(&self, run_id: &RunId) -> Result<Option<StoredCheckpoint>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, payload FROM events
             WHERE run_id = ?1 AND kind = 'tape_checkpoint'
             ORDER BY id DESC LIMIT 1",
        )?;
        let row = stmt
            .query_row(params![run_id.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?;
        let Some((id, payload_json)) = row else {
            return Ok(None);
        };
        let event_id = parse_event_id(&id, "tape_checkpoint")?;
        let payload: Payload = serde_json::from_str(&payload_json)?;
        let Payload::TapeCheckpointV1(cp) = payload else {
            return Err(invalid_payload(
                "tape_checkpoint",
                "checkpoint row payload is not a TapeCheckpointV1".into(),
            ));
        };
        Ok(Some(StoredCheckpoint {
            event_id,
            checkpoint_index: cp.checkpoint_index,
            through_event_id: cp.through_event_id,
            through_event_count: cp.through_event_count,
        }))
    }

    /// All signed, non-checkpoint events for a run, id-ordered (tape order),
    /// paired with their stored canonical event hash. Only events with a
    /// persisted signature row are returned — checkpoints cover signed events.
    fn signed_ordinary_events(&self, run_id: &RunId) -> Result<Vec<SignedOrdinaryEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.id, s.canonical_event_hash
             FROM events e
             JOIN event_signatures s ON s.event_id = e.id
             WHERE e.run_id = ?1 AND e.kind != 'tape_checkpoint'
             ORDER BY e.id ASC",
        )?;
        let rows = stmt.query_map(params![run_id.to_string()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, canonical_event_hash) = row?;
            out.push(SignedOrdinaryEvent {
                event_id: parse_event_id(&id, "events")?,
                canonical_event_hash,
            });
        }
        Ok(out)
    }

    /// Read all events for a run, ordered by id (UUIDv7 = time-ordered).
    pub fn events_for_run(&self, run_id: &str) -> Result<Vec<StoredEventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload
             FROM events WHERE run_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok(StoredEventRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                parent_event_id: r.get(2)?,
                schema_version: r.get(3)?,
                kind: r.get(4)?,
                occurred_at: r.get(5)?,
                payload: r.get(6)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(LedgerError::from)
    }

    /// Read events with explicit detached-signature verification status.
    pub fn verified_events_for_run(
        &self,
        run_id: &str,
        trusted_keys: &TrustedPublicKeys,
    ) -> Result<Vec<VerifiedEventRow>> {
        let rows = self.events_for_run(run_id)?;
        rows.into_iter()
            .map(|event_row| {
                let event = event_row.to_event()?;
                let Some(signature_row) = self.signature_for_event(&event_row.id)? else {
                    return Ok(VerifiedEventRow {
                        event: event_row,
                        signature: None,
                        verification: VerificationStatus::Unsigned,
                    });
                };

                if signature_row.algorithm != "ed25519" {
                    return Ok(VerifiedEventRow {
                        event: event_row,
                        signature: None,
                        verification: VerificationStatus::UnsupportedAlgorithm,
                    });
                }

                let signature = signature_row.to_event_signature()?;
                let verification = verify_event_signature(&event, &signature, trusted_keys);
                Ok(VerifiedEventRow {
                    event: event_row,
                    signature: Some(signature),
                    verification,
                })
            })
            .collect()
    }

    fn signature_for_event(&self, event_id: &str) -> Result<Option<StoredEventSignatureRow>> {
        self.conn
            .query_row(
                r#"SELECT
                    event_id,
                    canonical_event_hash,
                    actor_id,
                    key_id,
                    public_key_hash,
                    algorithm,
                    signature,
                    signed_at
                FROM event_signatures
                WHERE event_id = ?1"#,
                params![event_id],
                |row| {
                    Ok(StoredEventSignatureRow {
                        event_id: row.get(0)?,
                        canonical_event_hash: row.get(1)?,
                        actor_id: row.get(2)?,
                        key_id: row.get(3)?,
                        public_key_hash: row.get(4)?,
                        algorithm: row.get(5)?,
                        signature: row.get(6)?,
                        signed_at: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(LedgerError::from)
    }

    /// Count events in the store (for test convenience).
    pub fn event_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// Expose the raw connection for use by tests that need to assert
    /// append-only behavior. Not part of the stable API.
    pub fn conn_for_tests(&self) -> &Connection {
        &self.conn
    }

    /// Flush the WAL and fsync. Returns the id of the most recently appended
    /// event (useful for flush_ack).
    pub fn flush_fsync(&self) -> Result<Option<crate::id::EventId>> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        let last: Option<String> = self
            .conn
            .query_row("SELECT id FROM events ORDER BY id DESC LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;

        match last {
            Some(s) => {
                let uuid = uuid::Uuid::parse_str(&s).map_err(|e| {
                    LedgerError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    ))
                })?;
                Ok(Some(crate::id::EventId::from_uuid(uuid)))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod flush_fsync_tests {
    use super::*;

    #[test]
    fn flush_fsync_on_empty_store_succeeds() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.flush_fsync().unwrap();
    }

    #[test]
    fn flush_fsync_after_append_returns_last_event_id() {
        use crate::event::Event;
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let store = SqliteStore::open_in_memory().unwrap();
        let event = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 0,
                event_count: 0,
                unit_count: 0,
            }),
        };
        store.append(&event).unwrap();
        let last = store.flush_fsync().unwrap();
        assert_eq!(last, Some(event.id));
    }
}

/// Stored row — textual fields as read from SQLite. Use `canonicalize` to
/// turn this into a typed `Event`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEventRow {
    pub id: String,
    pub run_id: String,
    pub parent_event_id: Option<String>,
    pub schema_version: u32,
    pub kind: String,
    pub occurred_at: String,
    pub payload: String,
}

impl StoredEventRow {
    pub fn to_event(&self) -> Result<Event> {
        let event_id = parse_event_id(&self.id, &self.kind)?;
        let run_id = parse_run_id(&self.run_id, &self.kind)?;
        let parent_event_id = self
            .parent_event_id
            .as_deref()
            .map(|id| parse_event_id(id, &self.kind))
            .transpose()?;
        let kind: EventKind = serde_json::from_value(serde_json::Value::String(self.kind.clone()))?;
        let occurred_at = DateTime::parse_from_rfc3339(&self.occurred_at)
            .map_err(|err| invalid_payload(&self.kind, format!("invalid occurred_at: {err}")))?
            .with_timezone(&Utc);
        let payload_json: serde_json::Value = serde_json::from_str(&self.payload)?;
        let payload = canonicalize_payload(&self.kind, self.schema_version, payload_json)?;
        Ok(Event {
            id: event_id,
            run_id,
            parent_event_id,
            schema_version: self.schema_version,
            kind,
            occurred_at,
            payload,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEventSignatureRow {
    pub event_id: String,
    pub canonical_event_hash: String,
    pub actor_id: String,
    pub key_id: String,
    pub public_key_hash: Option<String>,
    pub algorithm: String,
    pub signature: String,
    pub signed_at: String,
}

impl StoredEventSignatureRow {
    pub fn to_event_signature(&self) -> Result<EventSignatureV1> {
        let event_id = parse_event_id(&self.event_id, "event_signatures")?;
        let algorithm = match self.algorithm.as_str() {
            "ed25519" => SignatureAlgorithm::Ed25519,
            _ => {
                return Err(invalid_payload(
                    "event_signatures",
                    format!(
                        "unsupported signature algorithm '{}'; check status first",
                        self.algorithm
                    ),
                ));
            }
        };
        let signed_at = DateTime::parse_from_rfc3339(&self.signed_at)
            .map_err(|err| {
                invalid_payload("event_signatures", format!("invalid signed_at: {err}"))
            })?
            .with_timezone(&Utc);
        Ok(EventSignatureV1 {
            event_id,
            canonical_event_hash: self.canonical_event_hash.clone(),
            signer: ActorKeyRef {
                actor_id: self.actor_id.clone(),
                key_id: self.key_id.clone(),
                public_key_hash: self.public_key_hash.clone(),
            },
            algorithm,
            signature: self.signature.clone(),
            signed_at,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedEventRow {
    pub event: StoredEventRow,
    pub signature: Option<EventSignatureV1>,
    pub verification: VerificationStatus,
}

/// Minimal projection of the latest checkpoint needed to chain the next one.
///
/// `through_event_id` is retained (alongside `through_event_count`) so the
/// checkpoint chain stays auditable: each checkpoint records the exact last
/// covered event id, not merely how many events it covered.
#[derive(Debug, Clone)]
struct StoredCheckpoint {
    event_id: EventId,
    checkpoint_index: u64,
    /// Last covered event id of the prior checkpoint. Retained for chain
    /// auditability; not yet consumed by emission logic (cadence uses
    /// `through_event_count`).
    #[allow(dead_code)]
    through_event_id: EventId,
    through_event_count: u64,
}

/// A signed, non-checkpoint event in tape order, with its stored canonical
/// hash — the input to the tape-root computation.
#[derive(Debug, Clone)]
struct SignedOrdinaryEvent {
    event_id: EventId,
    canonical_event_hash: String,
}

fn signature_algorithm_wire(algorithm: SignatureAlgorithm) -> &'static str {
    match algorithm {
        SignatureAlgorithm::Ed25519 => "ed25519",
    }
}

fn insert_event(conn: &Connection, event: &Event) -> Result<()> {
    let payload_json = serde_json::to_string(&event.payload)?;
    conn.execute(
        r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        params![
            event.id.to_string(),
            event.run_id.to_string(),
            event.parent_event_id.map(|e| e.to_string()),
            event.schema_version,
            event.kind_str(),
            event.occurred_at.to_rfc3339(),
            payload_json,
        ],
    )?;
    Ok(())
}

fn insert_event_signature(conn: &Connection, signature: &EventSignatureV1) -> Result<()> {
    conn.execute(
        r#"INSERT INTO event_signatures (
            event_id,
            canonical_event_hash,
            actor_id,
            key_id,
            public_key_hash,
            algorithm,
            signature,
            signed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
        params![
            signature.event_id.to_string(),
            signature.canonical_event_hash,
            signature.signer.actor_id,
            signature.signer.key_id,
            signature.signer.public_key_hash,
            signature_algorithm_wire(signature.algorithm),
            signature.signature,
            signature.signed_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn parse_event_id(id: &str, kind: &str) -> Result<EventId> {
    Uuid::parse_str(id)
        .map(EventId::from_uuid)
        .map_err(|err| invalid_payload(kind, format!("invalid event id: {err}")))
}

fn parse_run_id(id: &str, kind: &str) -> Result<RunId> {
    Uuid::parse_str(id)
        .map(RunId::from_uuid)
        .map_err(|err| invalid_payload(kind, format!("invalid run id: {err}")))
}

fn invalid_payload(kind: &str, reason: String) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason,
    }
}
