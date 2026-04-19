//! Replay state types.

// Temporarily define types so lib.rs re-exports compile.
// Real implementations land in Task 4.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReplayState;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileObservation;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRef;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ReplayIssue { Placeholder }
