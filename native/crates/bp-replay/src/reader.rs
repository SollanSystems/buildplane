//! SQLite event reader for replay.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::signing::{
    verify_event_signature, ActorKeyRef, EventSignatureV1, SignatureAlgorithm, TrustedPublicKeys,
    VerificationStatus,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
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
        self.all()?
            .into_iter()
            .map(|event| {
                let (verification, signature) =
                    self.verification_for_event(&event, trusted_keys)?;
                Ok(VerifiedEvent {
                    event,
                    verification,
                    signature,
                })
            })
            .collect()
    }

    fn verification_for_event(
        &self,
        event: &Event,
        trusted_keys: &TrustedPublicKeys,
    ) -> Result<(VerificationStatus, Option<EventSignatureV1>), ReaderError> {
        let Some(signature_row) = self.signature_for_event(&event.id)? else {
            return Ok((VerificationStatus::Unsigned, None));
        };

        if signature_row.algorithm != "ed25519" {
            return Ok((VerificationStatus::UnsupportedAlgorithm, None));
        }

        let signature = row_to_event_signature(signature_row)?;
        let verification = verify_event_signature(event, &signature, trusted_keys);
        Ok((verification, Some(signature)))
    }

    fn signature_for_event(
        &self,
        event_id: &EventId,
    ) -> Result<Option<StoredSignatureRow>, ReaderError> {
        if !self.event_signatures_available {
            return Ok(None);
        }
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
                [event_id.to_string()],
                |row| {
                    Ok(StoredSignatureRow {
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
            .map_err(ReaderError::from)
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
