//! Stdin JSONL ingest loop.
//!
//! Reads newline-delimited JSON events from a reader, deserializes them as
//! `Event`, canonicalizes, and appends to the SQLite store. Phase A: no
//! handshake, no control messages, no CAS integration for file-hash events.
//! Phase B adds `_handshake`/`_flush`/`_close` and wires CAS.

use crate::canonicalize::canonicalize;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::id::EventId;
use crate::storage::sqlite::SqliteStore;
use crate::storage::Cas;
use std::io::{BufRead, BufReader, Read, Write};

/// A single stdin line, interpreted as either a control message or an event envelope.
#[derive(Debug)]
pub enum Line {
    Control(ControlMessage),
    Event(Event),
}

/// Control messages received on stdin.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "control", rename_all = "snake_case")]
pub enum ControlMessage {
    Handshake {
        protocol: u32,
        run_id: crate::id::RunId,
        started_at: String,
        schema_version: u32,
    },
    Flush {
        seq: u64,
    },
    Close {
        seq: u64,
    },
}

/// Parse a JSON line as either a control message or an event envelope.
pub fn parse_control_or_event(line: &str) -> Result<Line> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|e| {
        LedgerError::InvalidPayload {
            kind: "<line>".into(),
            reason: format!("invalid json: {e}"),
        }
    })?;
    if value.get("control").is_some() {
        let ctl: ControlMessage = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Control(ctl))
    } else {
        let evt: Event = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Event(evt))
    }
}

#[derive(Debug, Default)]
pub struct ServeOutcome {
    pub events_written: u64,
    pub last_event_id: Option<EventId>,
}

/// Run the full protocol state machine against the provided reader/writer.
pub fn serve_with_protocol<R: Read, W: Write>(
    stdin: R,
    mut stderr: W,
    store: &SqliteStore,
    _cas: &Cas,
    declared_schema_version: u32,
) -> Result<ServeOutcome> {
    let mut buf = BufReader::new(stdin);
    let mut outcome = ServeOutcome::default();

    // Phase: AwaitingHandshake
    let mut first_line = String::new();
    if buf.read_line(&mut first_line)? == 0 {
        write_error(&mut stderr, "handshake_missing", 1, "stdin closed before handshake")?;
        return Err(LedgerError::InvalidPayload {
            kind: "<handshake>".into(),
            reason: "stdin closed before handshake".into(),
        });
    }

    let line = first_line.trim();
    let parsed = match parse_control_or_event(line) {
        Ok(l) => l,
        Err(_) => {
            write_error(&mut stderr, "handshake_malformed", 1, "first line not valid json")?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line not valid json".into(),
            });
        }
    };

    match parsed {
        Line::Control(ControlMessage::Handshake { protocol, schema_version, .. }) => {
            if protocol != 1 {
                write_handshake_ack(&mut stderr, false, &format!("protocol {} not supported", protocol))?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: format!("protocol {protocol} not supported"),
                });
            }
            if schema_version != declared_schema_version {
                write_handshake_ack(
                    &mut stderr,
                    false,
                    &format!("schema version {schema_version} not supported (supported: {declared_schema_version})"),
                )?;
                return Err(LedgerError::UnsupportedSchemaVersion {
                    received: schema_version,
                    supported: declared_schema_version,
                });
            }
            write_handshake_ack(&mut stderr, true, "")?;
        }
        _ => {
            write_error(&mut stderr, "handshake_required", 1, "first line must be a handshake")?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line must be a handshake".into(),
            });
        }
    }

    // Phase: Ingesting
    let mut line_no: u64 = 1;
    loop {
        line_no += 1;
        let mut s = String::new();
        let n = buf.read_line(&mut s)?;
        if n == 0 {
            break;
        }
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        let parsed = match parse_control_or_event(s) {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("line {}: {}", line_no, e);
                write_error(&mut stderr, "malformed_event", line_no, &msg)?;
                return Err(e);
            }
        };
        match parsed {
            Line::Event(event) => {
                let canonical = canonicalize(event)?;
                let event_id = canonical.id;
                if let Err(e) = store.append(&canonical) {
                    write_error(&mut stderr, "storage_failure", line_no, &format!("{}", e))?;
                    return Err(e);
                }
                outcome.events_written += 1;
                outcome.last_event_id = Some(event_id);
            }
            Line::Control(ControlMessage::Flush { seq }) => {
                let last = store.flush_fsync()?;
                write_flush_ack(&mut stderr, seq, last)?;
            }
            Line::Control(ControlMessage::Close { seq: _ }) => {
                let last = store.flush_fsync()?;
                write_close_ack(&mut stderr, outcome.events_written, last)?;
                return Ok(outcome);
            }
            Line::Control(ControlMessage::Handshake { .. }) => {
                write_error(&mut stderr, "unexpected_handshake", line_no, "handshake after initial setup")?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: "unexpected second handshake".into(),
                });
            }
        }
    }

    Ok(outcome)
}

fn write_handshake_ack<W: Write>(stderr: &mut W, ready: bool, reason: &str) -> std::io::Result<()> {
    let line = if ready {
        format!(
            r#"{{"control":"handshake_ack","ready":true,"ledger_version":"{}","schema_version":1}}{}"#,
            env!("CARGO_PKG_VERSION"),
            '\n'
        )
    } else {
        format!(
            r#"{{"control":"handshake_ack","ready":false,"reason":{}}}{}"#,
            serde_json::to_string(reason).unwrap_or_else(|_| "\"error\"".to_string()),
            '\n'
        )
    };
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_flush_ack<W: Write>(stderr: &mut W, seq: u64, last: Option<EventId>) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"flush_ack","seq":{},"last_event_id":"{}"}}{}"#,
        seq, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_close_ack<W: Write>(stderr: &mut W, events_written: u64, last: Option<EventId>) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"close_ack","events_written":{},"last_event_id":"{}"}}{}"#,
        events_written, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_error<W: Write>(stderr: &mut W, kind: &str, line_no: u64, message: &str) -> std::io::Result<()> {
    let line = format!(
        r#"{{"control":"error","kind":"{}","line":{},"message":{}}}{}"#,
        kind,
        line_no,
        serde_json::to_string(message).unwrap_or_else(|_| "\"error\"".to_string()),
        '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

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

#[cfg(test)]
mod control_message_tests {
    use super::*;

    #[test]
    fn control_handshake_parses() {
        let line = r#"{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":1}"#;
        let msg = parse_control_or_event(line).unwrap();
        match msg {
            Line::Control(ControlMessage::Handshake { protocol, schema_version, .. }) => {
                assert_eq!(protocol, 1);
                assert_eq!(schema_version, 1);
            }
            _ => panic!("expected Handshake"),
        }
    }

    #[test]
    fn control_flush_parses() {
        let line = r#"{"control":"flush","seq":42}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Flush { seq }) => assert_eq!(seq, 42),
            _ => panic!("expected Flush"),
        }
    }

    #[test]
    fn control_close_parses() {
        let line = r#"{"control":"close","seq":43}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Close { seq }) => assert_eq!(seq, 43),
            _ => panic!("expected Close"),
        }
    }

    #[test]
    fn event_envelope_parses_as_event() {
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let event = crate::event::Event {
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
        let line = serde_json::to_string(&event).unwrap();
        match parse_control_or_event(&line).unwrap() {
            Line::Event(e) => assert_eq!(e.id, event.id),
            _ => panic!("expected Event"),
        }
    }
}
