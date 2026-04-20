//! SQLite-backed event store — append-only, trigger-enforced.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

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
        let payload_json = serde_json::to_string(&event.payload)?;
        self.conn.execute(
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
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(LedgerError::from)
    }

    /// Count events in the store (for test convenience).
    pub fn event_count(&self) -> Result<u64> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
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
            .query_row(
                "SELECT id FROM events ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
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
