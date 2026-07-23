//! SQLite event reader for replay.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::signing::{
    verify_event_signature, ActorKeyRef, EventSignatureV1, SignatureAlgorithm, TrustedPublicKeys,
    VerificationStatus,
};
use rusqlite::{params, Connection, OpenFlags, Row};
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
    #[error("replay event count exceeds the bounded verification limit of {max_events}")]
    EventLimitExceeded { max_events: usize },
    #[error("bounded replay event limit cannot be represented safely")]
    InvalidEventLimit,
}

pub struct EventReader {
    conn: Connection,
    run_id: String,
    /// Pre-signature ledger databases remain readable. They have no detached
    /// signature table, so V1 authority events are treated as unsigned rather
    /// than making replay fail before it can reconstruct legacy state.
    event_signatures_available: bool,
}

/// One tape event paired with the result of detached-signature verification.
#[derive(Clone, Debug)]
pub struct VerifiedEvent {
    pub event: Event,
    pub verification: VerificationStatus,
    /// Present only when the tape contained a parseable detached signature.
    /// The engine uses the signer identity for event-kind authorization after
    /// cryptographic verification succeeds.
    pub signature: Option<EventSignatureV1>,
}

impl EventReader {
    pub fn open(run_id: &str, db_path: impl AsRef<Path>) -> Result<Self, ReaderError> {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        let event_signatures_available = conn.query_row(
			"SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_signatures')",
			[],
			|row| row.get::<_, i64>(0),
		)? != 0;
        Ok(Self {
            conn,
            run_id: run_id.to_string(),
            event_signatures_available,
        })
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

    /// Read every event in tape order and verify its detached signature against
    /// the caller-supplied trust registry. This is intentionally read-only: it
    /// reconstructs the stored signature row and delegates cryptographic
    /// verification to `bp_ledger` rather than inferring trust from metadata.
    pub fn all_with_verification(
        &self,
        trusted_keys: &TrustedPublicKeys,
    ) -> Result<Vec<VerifiedEvent>, ReaderError> {
        self.all_with_verification_limit(trusted_keys, None)
    }

    /// Internal bounded reader for the governed recovery boundary. The limit
    /// is intentionally supplied only by crate-owned recovery policy; callers
    /// receive no partial `VerifiedEvent` snapshot when it is exceeded.
    pub(crate) fn all_with_verification_bounded(
        &self,
        trusted_keys: &TrustedPublicKeys,
        max_events: usize,
    ) -> Result<Vec<VerifiedEvent>, ReaderError> {
        self.all_with_verification_limit(trusted_keys, Some(max_events))
    }

    fn all_with_verification_limit(
        &self,
        trusted_keys: &TrustedPublicKeys,
        max_events: Option<usize>,
    ) -> Result<Vec<VerifiedEvent>, ReaderError> {
        let rows = self.stored_rows_with_signatures(max_events)?;
        if let Some(max_events) = max_events {
            if rows.len() > max_events {
                return Err(ReaderError::EventLimitExceeded { max_events });
            }
        }

        rows.into_iter()
            .map(|row| {
                let event = row_to_event(row.event)?;
                let (verification, signature) =
                    verify_stored_signature(&event, row.signature, trusted_keys)?;
                Ok(VerifiedEvent {
                    event,
                    verification,
                    signature,
                })
            })
            .collect()
    }

    fn stored_rows_with_signatures(
        &self,
        max_events: Option<usize>,
    ) -> Result<Vec<StoredVerifiedRow>, ReaderError> {
        let row_limit = match max_events {
            Some(max_events) => max_events
                .checked_add(1)
                .and_then(|max_events| i64::try_from(max_events).ok())
                .ok_or(ReaderError::InvalidEventLimit)?,
            None => i64::MAX,
        };

        if !self.event_signatures_available {
            let mut stmt = self.conn.prepare(
                "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload FROM events WHERE run_id = ?1 ORDER BY id ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![self.run_id.as_str(), row_limit], |row| {
                Ok(StoredVerifiedRow {
                    event: stored_event_row(row)?,
                    signature: None,
                })
            })?;
            return rows.map(|row| row.map_err(ReaderError::from)).collect();
        }

        // Keep signature lookup in the ordered event scan. The old per-event
        // query created an N+1 read pattern and could not place a hard bound
        // around the complete verified snapshot.
        let mut stmt = self.conn.prepare(
            "SELECT e.id, e.run_id, e.parent_event_id, e.schema_version, e.kind, e.occurred_at, e.payload, s.event_id, s.canonical_event_hash, s.actor_id, s.key_id, s.public_key_hash, s.algorithm, s.signature, s.signed_at FROM events AS e LEFT JOIN event_signatures AS s ON s.event_id = e.id WHERE e.run_id = ?1 ORDER BY e.id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![self.run_id.as_str(), row_limit], |row| {
            Ok(StoredVerifiedRow {
                event: stored_event_row(row)?,
                signature: stored_signature_row_from_join(row)?,
            })
        })?;
        rows.map(|row| row.map_err(ReaderError::from)).collect()
    }
}

struct StoredVerifiedRow {
    event: StoredRow,
    signature: Option<StoredSignatureRow>,
}

fn verify_stored_signature(
    event: &Event,
    signature_row: Option<StoredSignatureRow>,
    trusted_keys: &TrustedPublicKeys,
) -> Result<(VerificationStatus, Option<EventSignatureV1>), ReaderError> {
    let Some(signature_row) = signature_row else {
        return Ok((VerificationStatus::Unsigned, None));
    };

    if signature_row.algorithm != "ed25519" {
        return Ok((VerificationStatus::UnsupportedAlgorithm, None));
    }

    let signature = row_to_event_signature(signature_row)?;
    let verification = verify_event_signature(event, &signature, trusted_keys);
    Ok((verification, Some(signature)))
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

struct StoredSignatureRow {
    event_id: String,
    canonical_event_hash: String,
    actor_id: String,
    key_id: String,
    public_key_hash: Option<String>,
    algorithm: String,
    signature: String,
    signed_at: String,
}

fn stored_event_row(row: &Row<'_>) -> rusqlite::Result<StoredRow> {
    Ok(StoredRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        parent_event_id: row.get(2)?,
        schema_version: row.get(3)?,
        kind: row.get(4)?,
        occurred_at: row.get(5)?,
        payload: row.get(6)?,
    })
}

fn stored_signature_row_from_join(row: &Row<'_>) -> rusqlite::Result<Option<StoredSignatureRow>> {
    let Some(event_id) = row.get::<_, Option<String>>(7)? else {
        return Ok(None);
    };
    Ok(Some(StoredSignatureRow {
        event_id,
        canonical_event_hash: row.get(8)?,
        actor_id: row.get(9)?,
        key_id: row.get(10)?,
        public_key_hash: row.get(11)?,
        algorithm: row.get(12)?,
        signature: row.get(13)?,
        signed_at: row.get(14)?,
    }))
}

fn row_to_event(row: StoredRow) -> Result<Event, ReaderError> {
    let id = EventId::from_uuid(uuid::Uuid::parse_str(&row.id)?);
    let run_id = RunId::from_uuid(uuid::Uuid::parse_str(&row.run_id)?);
    let parent_event_id = match row.parent_event_id {
        Some(s) => Some(EventId::from_uuid(uuid::Uuid::parse_str(&s)?)),
        None => None,
    };
    let occurred_at =
        chrono::DateTime::parse_from_rfc3339(&row.occurred_at)?.with_timezone(&chrono::Utc);
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

fn row_to_event_signature(row: StoredSignatureRow) -> Result<EventSignatureV1, ReaderError> {
    let event_id = EventId::from_uuid(uuid::Uuid::parse_str(&row.event_id)?);
    let signed_at =
        chrono::DateTime::parse_from_rfc3339(&row.signed_at)?.with_timezone(&chrono::Utc);
    Ok(EventSignatureV1 {
        event_id,
        canonical_event_hash: row.canonical_event_hash,
        signer: ActorKeyRef {
            actor_id: row.actor_id,
            key_id: row.key_id,
            public_key_hash: row.public_key_hash,
        },
        algorithm: SignatureAlgorithm::Ed25519,
        signature: row.signature,
        signed_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::RunStartedV1;
    use bp_ledger::payload::Payload;
    use bp_ledger::storage::sqlite::SqliteStore;
    use chrono::Utc;
    use ed25519_dalek::SigningKey;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn run_started_event(run_id: RunId) -> Event {
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: Utc::now(),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:fixture".to_string(),
                git_head: "fixture".to_string(),
                workspace_path: "/fixture".to_string(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        }
    }

    #[test]
    fn bounded_verified_read_rejects_limit_plus_one_without_returning_partial_events() {
        let temp = TempDir::new().expect("temporary ledger directory");
        let db_path = temp.path().join("events.db");
        let store = SqliteStore::open(&db_path).expect("ledger store");
        let run_id = RunId::new();
        let signing_key = SigningKey::from_bytes(&[71; 32]);
        let signer = ActorKeyRef {
            actor_id: "kernel".to_string(),
            key_id: "kernel-main".to_string(),
            public_key_hash: None,
        };
        let first = run_started_event(run_id);
        let second = run_started_event(run_id);
        store
            .append_signed(&first, &signing_key, &signer)
            .expect("append first signed event");
        store
            .append_signed(&second, &signing_key, &signer)
            .expect("append second signed event");

        let key_hash = bp_ledger::signing::public_key_hash(&signing_key.verifying_key());
        let mut trusted_keys = TrustedPublicKeys::default();
        trusted_keys.insert_public_key(key_hash, signing_key.verifying_key().to_bytes().to_vec());
        let reader = EventReader::open(&run_id.to_string(), &db_path).expect("open reader");

        let error = reader
            .all_with_verification_bounded(&trusted_keys, 1)
            .expect_err("limit plus one must fail before returning a partial verified tape");
        assert!(matches!(
            error,
            ReaderError::EventLimitExceeded { max_events: 1 }
        ));

        let full = reader
            .all_with_verification(&trusted_keys)
            .expect("unbounded compatibility read");
        assert_eq!(full.len(), 2);
        assert!(
            full.iter()
                .all(|event| event.verification == VerificationStatus::Verified),
            "the bounded path must use the same detached-signature verification semantics"
        );
    }
}
