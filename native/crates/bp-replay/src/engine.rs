//! ReplayEngine: forward iteration over a tape.

use crate::reader::{EventReader, ReaderError};
use crate::state::ReplayState;
use crate::transitions;
use bp_ledger::event::Event;
use bp_ledger::id::EventId;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("reader: {0}")]
    Reader(#[from] ReaderError),
}

#[derive(Debug, Serialize)]
pub struct ReplayStep {
    pub event: Event,
    pub state_after: ReplayState,
}

pub struct ReplayEngine {
    events: Vec<Event>,
    cursor: usize,
    state: ReplayState,
}

impl ReplayEngine {
    pub fn open(run_id: &str, db_path: impl AsRef<Path>) -> Result<Self, EngineError> {
        let reader = EventReader::open(run_id, db_path)?;
        let events = reader.all()?;
        Ok(Self { events, cursor: 0, state: ReplayState::default() })
    }

    pub fn next(&mut self) -> Option<ReplayStep> {
        if self.cursor >= self.events.len() {
            return None;
        }
        let event = self.events[self.cursor].clone();
        self.cursor += 1;
        transitions::apply(&mut self.state, &event);
        Some(ReplayStep { event, state_after: self.state.clone() })
    }

    pub fn fast_forward_to(&mut self, target: EventId) -> Option<ReplayStep> {
        while let Some(step) = self.next() {
            if step.event.id == target {
                return Some(step);
            }
        }
        self.state.issues.push(crate::state::ReplayIssue::TargetNotFound {
            requested: target.to_string(),
        });
        None
    }

    pub fn state(&self) -> &ReplayState {
        &self.state
    }

    pub fn total_events(&self) -> usize {
        self.events.len()
    }
}
