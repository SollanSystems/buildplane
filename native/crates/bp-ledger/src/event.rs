//! The canonical event envelope.

use crate::id::{EventId, RunId};
use crate::kind::EventKind;
use crate::payload::Payload;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The frozen v1 event envelope. Six fields, never change shape. Payload
/// evolves via its own versioning inside `Payload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: EventId,
    pub run_id: RunId,
    pub parent_event_id: Option<EventId>,
    pub schema_version: u32,
    pub kind: EventKind,
    pub occurred_at: DateTime<Utc>,
    pub payload: Payload,
}

impl Event {
    /// The only supported schema version in this build of the ledger.
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    /// Return the variant tag as a canonical wire string.
    pub fn kind_str(&self) -> &'static str {
        self.kind.as_wire()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};

    #[test]
    fn envelope_round_trips_through_json() {
        let e = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: Some(EventId::new()),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 10,
                event_count: 2,
                unit_count: 1,
            }),
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: Event = serde_json::from_str(&s).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn kind_str_is_snake_case() {
        let e = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::UnitCancelled,
            occurred_at: Utc::now(),
            payload: Payload::UnitCancelledV1(
                crate::payload::unit_lifecycle::UnitCancelledV1 {
                    unit_id: "u-1".into(),
                    cause: crate::payload::unit_lifecycle::CancelCause::Timeout,
                },
            ),
        };
        assert_eq!(e.kind_str(), "unit_cancelled");
    }
}
