//! Emit one canonical Payload JSON per variant into a single fixture file.
//! Phase B drift alarm: TS exhaustive switch is kept in sync by comparing
//! against this generated file in CI.

use bp_ledger::id::EventId;
use bp_ledger::payload::git_checkpoint::{
    CheckpointBoundary, GitCheckpointV1, GitStatus,
};
use bp_ledger::payload::model_io::{
    Message, ModelRequestV1, ModelResponseV1, SamplingParams, Usage,
};
use bp_ledger::payload::run_lifecycle::{
    RunCompletedV1, RunFailedV1, RunOutcome, RunStartedV1,
};
use bp_ledger::payload::tool_io::{EnvRedaction, ToolRequestStoredV1, ToolResultV1};
use bp_ledger::payload::unit_lifecycle::{
    ArtifactRef, CancelCause, UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitOutcome,
    UnitStartedV1,
};
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceReadV1, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// Fixed deterministic EventIds for fixture stability (no EventId::new() in generators).
fn fixed_event_id(n: u8) -> EventId {
    EventId::from_uuid(
        uuid::Uuid::parse_str(&format!("01919000-0000-7000-8000-{:012}", n)).unwrap(),
    )
}

fn main() {
    let out: Vec<Value> = vec![
        serde_json::to_value(Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "dead".into(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
        })).unwrap(),

        serde_json::to_value(Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed, duration_ms: 0, event_count: 0, unit_count: 0,
        })).unwrap(),

        serde_json::to_value(Payload::RunFailedV1(RunFailedV1 {
            reason: "fixture".into(), terminating_event_id: None,
        })).unwrap(),

        serde_json::to_value(Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u".into(), parent_unit_id: None, unit_kind: "command".into(), policy: json!({}),
        })).unwrap(),

        serde_json::to_value(Payload::UnitCompletedV1(UnitCompletedV1 {
            unit_id: "u".into(), outcome: UnitOutcome::Passed, artifacts: vec![ArtifactRef {
                path: "out".into(), hash: "sha256:aa".into(), size_bytes: 0,
            }],
        })).unwrap(),

        serde_json::to_value(Payload::UnitFailedV1(UnitFailedV1 {
            unit_id: "u".into(), reason: "fixture".into(), terminating_event_id: None,
        })).unwrap(),

        serde_json::to_value(Payload::UnitCancelledV1(UnitCancelledV1 {
            unit_id: "u".into(), cause: CancelCause::Timeout,
        })).unwrap(),

        serde_json::to_value(Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit, reference: "refs/...".into(),
            commit_sha: "0".repeat(40), unit_id: "u".into(), git_status: GitStatus::Ok,
        })).unwrap(),

        serde_json::to_value(Payload::ModelRequestV1(ModelRequestV1 {
            provider: "anthropic".into(), model: "claude-opus-4-7".into(),
            system: None, messages: vec![Message { role: "user".into(), content: "hi".into() }],
            tools: vec![], sampling: SamplingParams { temperature: Some(0.0), top_p: None, max_tokens: Some(100) },
            headers: BTreeMap::new(),
        })).unwrap(),

        serde_json::to_value(Payload::ModelResponseV1(ModelResponseV1 {
            content: Some("ok".into()), tool_calls: vec![],
            usage: Usage { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn".into(),
            latency_ms: 0,
        })).unwrap(),

        serde_json::to_value(Payload::ToolRequestStoredV1(ToolRequestStoredV1 {
            tool_name: "shell".into(), arguments: json!({}), env: EnvRedaction {
                redacted: true, hash: "sha256:aa".into(), hint: "env_var".into(),
            }, working_directory: "/".into(), unit_id: "u".into(),
        })).unwrap(),

        serde_json::to_value(Payload::ToolResultV1(ToolResultV1 {
            tool_request_id: fixed_event_id(1), stdout: String::new(), stderr: String::new(),
            exit_code: Some(0), output: None, duration_ms: 0,
        })).unwrap(),

        serde_json::to_value(Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: fixed_event_id(2), path: "x".into(),
            content_hash: "sha256:aa".into(), size_bytes: 0,
        })).unwrap(),

        serde_json::to_value(Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: fixed_event_id(3), path: "x".into(), hash_before: None,
            after: PostWriteState::Captured { hash: "sha256:aa".into(), size_bytes: 0 },
        })).unwrap(),
    ];

    let dest = std::env::args().nth(1).unwrap_or_else(|| {
        PathBuf::from("packages/ledger-client/fixtures/payload-variants.json")
            .to_string_lossy()
            .into_owned()
    });
    fs::create_dir_all(PathBuf::from(&dest).parent().unwrap()).unwrap();
    let mut content = serde_json::to_string_pretty(&out).unwrap();
    content.push('\n');
    fs::write(&dest, content).unwrap();
    eprintln!("wrote {}", dest);
}
