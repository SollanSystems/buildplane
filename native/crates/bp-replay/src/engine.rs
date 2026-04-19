//! ReplayEngine: forward iteration over a tape.

use crate::state::ReplayState;
use bp_ledger::event::Event;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ReplayStep {
    pub event: Event,
    pub state_after: ReplayState,
}

pub struct ReplayEngine;
