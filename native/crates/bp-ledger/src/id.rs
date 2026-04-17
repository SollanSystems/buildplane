//! Typed identifiers for events and runs.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

/// Identifier for a single event on the ledger. UUIDv7 — time-ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventId(Uuid);

/// Identifier for a run. UUIDv7 — time-ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(Uuid);

impl EventId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for EventId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl RunId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
    pub fn from_uuid(u: Uuid) -> Self {
        Self(u)
    }
    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RunId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_monotonic_when_generated_sequentially() {
        let a = EventId::new();
        let b = EventId::new();
        assert!(b.as_uuid() >= a.as_uuid(), "UUIDv7 must be time-ordered");
    }

    #[test]
    fn event_id_round_trips_through_json() {
        let id = EventId::new();
        let s = serde_json::to_string(&id).unwrap();
        let back: EventId = serde_json::from_str(&s).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn run_id_round_trips_through_json() {
        let id = RunId::new();
        let s = serde_json::to_string(&id).unwrap();
        let back: RunId = serde_json::from_str(&s).unwrap();
        assert_eq!(id, back);
    }
}
