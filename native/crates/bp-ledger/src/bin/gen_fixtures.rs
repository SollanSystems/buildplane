//! Emit one canonical Payload JSON per variant into a single fixture file.
//! Phase B drift alarm: TS exhaustive switch is kept in sync by comparing
//! against this generated file in CI.

use bp_ledger::id::{EventId, RunId};
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::checkpoint::{TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::git_checkpoint::{
    CheckpointBoundary, GitCheckpointV1, GitStatus,
};
use bp_ledger::payload::model_io::{
    Message, ModelRequestV1, ModelResponseV1, SamplingParams, Usage,
};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::run_lifecycle::{
    RunAdmissionDecision, RunAdmissionEvidenceInputV1, RunAdmissionRecordedV1,
    RunCompletedV1, RunFailedV1, RunOutcome, RunStartedV1,
};
use bp_ledger::payload::tool_io::{EnvRedaction, ToolRequestStoredV1, ToolResultV1};
use bp_ledger::payload::unit_lifecycle::{
    ArtifactRef, CancelCause, UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitOutcome,
    UnitStartedV1,
};
use bp_ledger::payload::capability_broker::CapabilityDeniedV1;
use bp_ledger::payload::acceptance::{AcceptanceCheckResultV1, AcceptanceRecordedV1};
use bp_ledger::payload::operator_decision::OperatorDecisionRecordedV1;
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

/// Fixed deterministic RunId for fixture stability.
fn fixed_run_id() -> RunId {
    RunId::from_uuid(
        uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap(),
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
            parent_event_id: None,
        })).unwrap(),

        serde_json::to_value(Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed, duration_ms: 0, event_count: 0, unit_count: 0,
        })).unwrap(),

        serde_json::to_value(Payload::RunFailedV1(RunFailedV1 {
            reason: "fixture".into(), terminating_event_id: None,
        })).unwrap(),

        serde_json::to_value(Payload::RunAdmissionRecordedV1(RunAdmissionRecordedV1 {
            receipt_id: "receipt-fixture".into(),
            receipt_digest: "sha256:aa".into(),
            receipt_ref: Some("cas:sha256:aa".into()),
            idempotency_key: "run.admission:v0:fixture".into(),
            decision: RunAdmissionDecision::Pass,
            policy_profile_id: "reviewed-green".into(),
            requested_side_effects: vec!["fs.write:declared_scope".into()],
            allowed_side_effects: vec!["fs.write:declared_scope".into()],
            denied_side_effects: vec![],
            missing_evidence: vec![],
            unsafe_requests: vec![],
            evidence_inputs: vec![RunAdmissionEvidenceInputV1 {
                kind: "git.status".into(),
                reference: "evidence/git-status.txt".into(),
                digest: Some("sha256:bb".into()),
                required: true,
                status: "present".into(),
                reason: None,
            }],
            quarantine: false,
            will_execute_worker: true,
            authorized_next_step: "dispatch_after_admission_append".into(),
            decided_by: "buildplane.kernel.admission".into(),
            decided_at: "2026-05-24T22:41:16Z".into(),
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

        serde_json::to_value(Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(4),
            through_event_count: 2,
            previous_checkpoint_event_id: None,
            tape_root_hash: "sha256:aa".into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        })).unwrap(),

        serde_json::to_value(Payload::PlanAdmittedV1(PlanAdmittedV1 {
            plan_id: "pf-plan-fixture".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:fixture".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:fixture".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        })).unwrap(),

        serde_json::to_value(Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: fixed_event_id(5),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:00:10Z".into(),
        })).unwrap(),

        serde_json::to_value(Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        })).unwrap(),

        serde_json::to_value(Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok"}),
        })).unwrap(),

        serde_json::to_value(Payload::CapabilityDeniedV1(CapabilityDeniedV1 {
            run_id: fixed_run_id().to_string(),
            bundle_digest: "sha256:ff".into(),
            tool: "write_file".into(),
            reason: "capability broker: outside fsWrite allowlist".into(),
            target: "docs/readme.md".into(),
        })).unwrap(),

        serde_json::to_value(Payload::AcceptanceRecordedV1(AcceptanceRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: fixed_event_id(5).to_string(),
            contract_digest: "sha256:gg".into(),
            outcome: "passed".into(),
            diff_scope_status: "passed".into(),
            out_of_scope_files: vec![],
            checks: vec![AcceptanceCheckResultV1 {
                command: "pnpm lint".into(),
                exit_code: "0".into(),
                status: "passed".into(),
            }],
            evaluated_at: "2026-06-19T12:00:00Z".into(),
        })).unwrap(),

        serde_json::to_value(Payload::OperatorDecisionRecordedV1(OperatorDecisionRecordedV1 {
            run_id: fixed_run_id().to_string(),
            decision: "approved".into(),
            subject: "merge".into(),
            acceptance_event_id: Some(fixed_event_id(5).to_string()),
            admission_event_id: Some(fixed_event_id(4).to_string()),
            merge_commit: Some("deadbeef".into()),
            decided_by: "operator@buildplane".into(),
            decided_at: "2026-06-22T12:00:00Z".into(),
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
