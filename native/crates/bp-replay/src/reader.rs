//! SQLite event reader for replay.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReaderError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("uuid: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("chrono: {0}")]
    Chrono(#[from] chrono::ParseError),
    #[error("ledger: {0}")]
    Ledger(#[from] bp_ledger::error::LedgerError),
}

pub struct EventReader {
    conn: Connection,
    run_id: String,
}

impl EventReader {
    pub fn open(run_id: &str, db_path: impl AsRef<Path>) -> Result<Self, ReaderError> {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(Self { conn, run_id: run_id.to_string() })
    }

    pub fn all(&self) -> Result<Vec<Event>, ReaderError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
             FROM events WHERE run_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([self.run_id.as_str()], |r| {
            Ok(StoredRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                parent_event_id: r.get(2)?,
                schema_version: r.get(3)?,
                kind: r.get(4)?,
                occurred_at: r.get(5)?,
                payload: r.get(6)?,
            })
        })?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row_to_event(row?)?);
        }
        Ok(events)
    }
}

struct StoredRow {
    id: String,
    run_id: String,
    parent_event_id: Option<String>,
    schema_version: u32,
    kind: String,
    occurred_at: String,
    payload: String,
}

fn row_to_event(row: StoredRow) -> Result<Event, ReaderError> {
    let id = EventId::from_uuid(uuid::Uuid::parse_str(&row.id)?);
    let run_id = RunId::from_uuid(uuid::Uuid::parse_str(&row.run_id)?);
    let parent_event_id = match row.parent_event_id {
        Some(s) => Some(EventId::from_uuid(uuid::Uuid::parse_str(&s)?)),
        None => None,
    };
    let occurred_at = chrono::DateTime::parse_from_rfc3339(&row.occurred_at)?
        .with_timezone(&chrono::Utc);
    let kind = serde_json::from_value(serde_json::Value::String(row.kind.clone()))?;
    let payload_value: serde_json::Value = serde_json::from_str(&row.payload)?;
    let payload = canonicalize_payload(&row.kind, row.schema_version, payload_value)?;
    Ok(Event {
        id,
        run_id,
        parent_event_id,
        schema_version: row.schema_version,
        kind,
        occurred_at,
        payload,
    })
}
