//! Stdin JSONL ingest loop.
//!
//! Reads newline-delimited JSON events from a reader, deserializes them as
//! `Event`, canonicalizes, and appends to the SQLite store. Phase A: no
//! handshake, no control messages, no CAS integration for file-hash events.
//! Phase B adds `_handshake`/`_flush`/`_close` and wires CAS.

use crate::canonicalize::canonicalize;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::storage::sqlite::SqliteStore;
use std::io::{BufRead, BufReader, Read};

/// Ingest events from `reader` and append to `store` until EOF.
///
/// Returns the number of events successfully appended. The first malformed
/// line aborts ingestion with an error — this matches the spec's "malformed
/// line is a protocol violation" requirement.
pub fn ingest<R: Read>(reader: R, store: &SqliteStore) -> Result<u64> {
    let buf = BufReader::new(reader);
    let mut count: u64 = 0;
    for (idx, line) in buf.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: Event = serde_json::from_str(&line)
            .map_err(|e| LedgerError::InvalidPayload {
                kind: "<unknown>".to_string(),
                reason: format!("line {}: {e}", idx + 1),
            })?;
        let canonical = canonicalize(event)?;
        store.append(&canonical)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{EventId, RunId};
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use crate::payload::Payload;
    use chrono::Utc;

    fn encode(event: &Event) -> String {
        serde_json::to_string(event).unwrap() + "\n"
    }

    fn sample(run_id: RunId) -> Event {
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 0,
                event_count: 1,
                unit_count: 0,
            }),
        }
    }

    #[test]
    fn ingests_single_event_to_sqlite() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = encode(&event);
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn ingests_multiple_events_in_order() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let e1 = sample(run_id);
        let e2 = sample(run_id);
        let e3 = sample(run_id);
        let input = format!("{}{}{}", encode(&e1), encode(&e2), encode(&e3));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 3);
        let rows = store.events_for_run(&run_id.to_string()).unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn skips_blank_lines() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = format!("\n{}  \n\n", encode(&event));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn malformed_line_aborts_with_error() {
        let store = SqliteStore::open_in_memory().unwrap();
        let input = b"not-valid-json\n";
        let err = ingest(&input[..], &store).unwrap_err();
        assert!(matches!(err, LedgerError::InvalidPayload { .. }));
        assert_eq!(store.event_count().unwrap(), 0);
    }
}
