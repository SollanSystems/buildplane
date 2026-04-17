//! Buildplane event tape capture — append-only ledger for replayable runs.

pub mod canonicalize;
pub mod error;
pub mod event;
pub mod id;
pub mod kind;
pub mod payload;
pub mod serve;
pub mod storage;

pub use error::{LedgerError, Result};
pub use event::Event;
pub use id::{EventId, RunId};
pub use kind::EventKind;
pub use payload::Payload;
