//! Workspace observation payloads: WorkspaceRead, WorkspaceWrite.

use crate::id::EventId;
use crate::types::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceReadV1 {
    pub tool_request_id: EventId,
    pub path: String,
    pub content_hash: String,
    pub size_bytes: U64,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceWriteV1 {
    pub tool_request_id: EventId,
    pub path: String,
    /// Content hash before the write; None if the file did not exist.
    pub hash_before: Option<String>,
    /// Content hash after the write. If the ledger could not read the file
    /// (permission denied, concurrent delete), this is a `PostWriteState::Unreadable`.
    pub after: PostWriteState,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum PostWriteState {
    Captured { hash: String, size_bytes: U64 },
    Unreadable { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_read_v1_round_trips() {
        let p = WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "src/main.rs".into(),
            content_hash: "sha256:aa".into(),
            size_bytes: 123,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceReadV1>(&s).unwrap());
    }

    #[test]
    fn workspace_write_captured_round_trips() {
        let p = WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "out.txt".into(),
            hash_before: None,
            after: PostWriteState::Captured { hash: "sha256:bb".into(), size_bytes: 3 },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceWriteV1>(&s).unwrap());
    }

    #[test]
    fn workspace_write_unreadable_round_trips() {
        let p = WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "locked.txt".into(),
            hash_before: Some("sha256:aa".into()),
            after: PostWriteState::Unreadable { reason: "EACCES".into() },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<WorkspaceWriteV1>(&s).unwrap());
    }
}
