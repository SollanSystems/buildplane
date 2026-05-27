//! SQLite-backed event store — append-only, trigger-enforced.

use crate::canonicalize::canonicalize_payload;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::id::{EventId, RunId};
use crate::kind::EventKind;
use crate::signing::{
    sign_event, verify_event_signature, ActorKeyRef, EventSignatureV1, SignatureAlgorithm,
    TrustedPublicKeys, VerificationStatus,
};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use uuid::Uuid;

/// SQLite connection wrapping the events + runs schema.
pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    /// Open or create a ledger database at `path`. Creates tables and the
    /// append-only trigger on first open.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self { conn })
    }

    /// Open an in-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self { conn })
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
    pub fn append_signed(
        &self,
        event: &Event,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<()> {
        // Sign first: a signing failure (e.g. unsupported schema version) must
        // never reach the storage transaction.
        let signature = sign_event(event, signing_key, signer, Utc::now())?;

        let tx = self.conn.unchecked_transaction()?;
        insert_event(&tx, event)?;
        insert_event_signature(&tx, &signature)?;
        tx.commit()?;
        Ok(())
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
