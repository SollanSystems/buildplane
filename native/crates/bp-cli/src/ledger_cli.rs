//! `buildplane-native ledger ...` subcommands.
//!
//! Phase A: `serve` is wired. Phase D adds `replay`.

use bp_ledger::keyring::{load_signing_key, KeyringRef};
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::trust_spine::{
    ActionKindV1, ExecutionRoleV1, ModelRequestEvidenceV1, TrustScopeEvidenceV1,
};
use bp_ledger::serve::{
    serve_governed_with_protocol, serve_with_protocol, serve_with_protocol_with_activity_claims,
    ActivityClaimProtocolConfig, GovernedServeProtocolConfigV1, SigningConfig,
};
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimDispositionV1, ActivityResultDispositionV1,
    GovernedVerifierClaimRequestV1, GovernedVerifierResultRequestV1,
    ModelActionIntentIssueDispositionV1, ModelActionIntentIssueRequestV1, SqliteStore,
    MAX_ACTIVITY_LEASE_MS, MIN_ACTIVITY_LEASE_MS,
};
use bp_ledger::storage::Cas;
use bp_ledger::EventKind;
use bp_replay::engine::{ReplayEngine, TrustSpineSignerRole, TrustedReplayAuthorities};
use bp_replay::state::{WorkflowCancellationReplayState, WorkflowTimerReplayState};
#[cfg(test)]
use bp_replay::ReplayIssue;
use bp_replay::{
    ActionReceiptReplayState, ActionReceiptSetReplayState, ActionRequestReplayState,
    ActivityClaimReplayState, CandidateAcceptanceReplayState, CandidateArtifactReplayState,
    CandidateCompletionReplayState, PromotionApprovalRequestReplayState, PromotionReplayState,
    ReviewVerdictReplayState, TapeIntegrityReportV1, TrustedGovernedRecoverySnapshot,
    WorkflowDispatchReplayState, WorkflowInstanceV1, WorkflowPhaseV1, WorkflowTerminalReplayState,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::governed_authority::{
    load_governed_authority_realm, load_governed_authority_signing_key,
    load_governed_operator_authority_signing_key, load_governed_reviewer_authority_signing_key,
    load_optional_governed_operator_authority, load_optional_governed_reviewer_authority,
    provision_governed_authority_realm, provision_governed_operator_authority,
    provision_governed_reviewer_authority, GovernedAuthorityRealmV1, GovernedOperatorAuthorityV1,
    GovernedReviewerAuthorityV1,
};

/// Default kernel key id used when `--sign` is set without `--signing-key-id`.
const DEFAULT_KERNEL_KEY_ID: &str = "kernel-main";
/// Default actor used when `--sign` is set without `--signing-actor-id`.
const DEFAULT_KERNEL_ACTOR_ID: &str = "kernel";
const REPOSITORY_BINDING_DOMAIN_V1: &str = "buildplane.repository-binding.v1\0";
const ORIGIN_URL_DIGEST_DOMAIN_V1: &str = "buildplane.repository-origin.v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerCommand {
    Serve(ServeArgs),
    ServeGovernedV1(ServeGovernedV1Args),
    Replay(ReplayArgs),
    ResolveGovernedDispatchV3(ResolveGovernedDispatchV3Args),
    GovernedVerifierV1(GovernedVerifierV1Args),
    GovernedModelIntentV1(GovernedModelIntentV1Args),
    GovernedAuthorityV1,
    ProvisionGovernedAuthorityV1,
    ProvisionGovernedReviewerAuthorityV1,
    ProvisionGovernedOperatorAuthorityV1,
    ExportSignedTape(ExportSignedTapeArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub schema_version: u32,
    /// Opt-in signing. Default OFF (unsigned), preserving legacy behavior.
    pub sign: bool,
    /// Actor identity recorded in detached signatures and used to resolve the
    /// actor-scoped key directory.
    pub signing_actor_id: String,
    /// Key id to load from the configured actor keyring directory.
    pub signing_key_id: String,
    /// Explicit authority configuration for signed ActivityClaim V1 controls.
    /// Absent by default, preserving the legacy-disabled protocol path.
    pub activity_claim_authority: Option<ActivityClaimAuthorityArgs>,
}

/// No caller-selected workspace, signer, or claim authority is accepted in
/// this lane. The native binary derives all three from its host-owned realm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeGovernedV1Args {
    pub run_id: String,
    pub schema_version: u32,
}

/// Exact trusted identities for the dispatch and action-request evidence that
/// signed ActivityClaim V1 controls may accept.
///
/// The CLI derives their public-key hash from the configured signing key at
/// runtime; this struct carries identity references only and never key bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityClaimAuthorityArgs {
    pub dispatch_actor_id: String,
    pub dispatch_key_id: String,
    pub action_request_actor_id: String,
    pub action_request_key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub format: ReplayFormat,
    pub limit: Option<usize>,
    pub at: Option<String>,
}

/// Read-only request for the exact signed V3 governed dispatch that a host
/// may use to construct a per-run action gateway. The kernel signer is an
/// explicit local trust configuration: it is never discovered from mutable
/// event metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveGovernedDispatchV3Args {
    pub run_id: String,
    pub workspace: PathBuf,
    pub project_root: PathBuf,
    pub dispatch_event_ref: String,
    pub kernel_actor_id: String,
    pub kernel_key_id: String,
}

/// Closed host-realm commands for the first fixed, read-only verifier lane.
/// These commands deliberately accept neither a workspace, signer, command
/// line, tool arguments, nor action identity. Claiming derives those from the
/// signature-verified dispatch/action tape evidence; result recording derives
/// them from the opaque lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GovernedVerifierV1Args {
    Claim(GovernedVerifierClaimArgs),
    Result(GovernedVerifierResultArgs),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedVerifierClaimArgs {
    pub run_id: String,
    pub project_root: PathBuf,
    pub dispatch_event_ref: String,
    pub action_request_event_ref: String,
    pub lease_duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedVerifierResultArgs {
    pub run_id: String,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
}

/// Closed host-realm command for creating the parented `ModelActionIntentV1`
/// record. There is intentionally no workspace, signer, model request, or
/// evidence descriptor argument: native code derives all of those from the
/// protected realm, verified tape, and the strict canonical input CAS object
/// named by the signed action request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GovernedModelIntentV1Args {
    Issue(GovernedModelIntentIssueArgs),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedModelIntentIssueArgs {
    pub run_id: String,
    pub dispatch_event_ref: String,
    pub action_request_event_ref: String,
}

/// Closed, read-only authority projection emitted by
/// `resolve-governed-dispatch-v3`.
///
/// `workflow` is reconstructed exclusively from signature-verified,
/// signer-authorized tape events. It contains the action, receipt, and
/// candidate evidence a resumed TypeScript host needs; it is not a mutable
/// SQLite metadata view and it grants no new authority on its own.
#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedDispatchResolutionV1 {
    schema_version: u8,
    dispatch_event_ref: String,
    trusted_kernel_signer: ActorKeyRef,
    dispatch: ResolvedGovernedDispatchV3,
    tape_integrity: TapeIntegrityReportV1,
    recovery: GovernedDispatchRecoveryV1,
}

/// Exact V3 dispatch fields reconstructed from an authority-verified replay.
/// The flattened state is intentionally a closed, typed snapshot of the
/// signed V3 body and its canonical digest rather than the caller's input.
#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct ResolvedGovernedDispatchV3 {
    run_id: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    #[serde(flatten)]
    envelope: WorkflowDispatchReplayState,
}

/// Verified recovery facts for the single immutable workflow attempt. Empty
/// vectors mean no matching signed evidence has been recorded, not that the
/// caller may infer or mint a replacement effect.
#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedDispatchRecoveryV1 {
    phase: WorkflowPhaseV1,
    requests: Vec<ActionRequestReplayState>,
    activity_claims: Vec<ActivityClaimReplayState>,
    receipts: Vec<ActionReceiptReplayState>,
    receipt_set: Option<ActionReceiptSetReplayState>,
    candidates: Vec<CandidateArtifactReplayState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_completion: Option<CandidateCompletionReplayState>,
    acceptance: Option<CandidateAcceptanceReplayState>,
    reviews: Vec<ReviewVerdictReplayState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    promotion_approval: Option<PromotionApprovalRequestReplayState>,
    promotion: Option<PromotionReplayState>,
    terminal: Option<WorkflowTerminalReplayState>,
    /// Reducer-owned lifecycle facts are a diagnostic projection only. This
    /// resolver never turns a schedule, firing, or cancellation into worker
    /// authority; a future isolated broker must reconcile them before any
    /// effect can resume.
    timers: Vec<WorkflowTimerReplayState>,
    /// Present while the reducer has durably blocked further effect
    /// advancement and awaits an exactly bound terminal event.
    cancellation: Option<WorkflowCancellationReplayState>,
    pending_action_ids: Vec<String>,
    unknown_action_ids: Vec<String>,
    failed_action_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedVerifierClaimResponseV1 {
    schema_version: u8,
    status: String,
    claim_event_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    claim_event_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_event_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_event_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedVerifierResultResponseV1 {
    schema_version: u8,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    claim_event_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_event_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_event_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_expires_at: Option<String>,
}

/// Closed response from the native-only model intent issuer. It intentionally
/// names only tape IDs and raw CAS descriptors: normalized prompts, system
/// instructions, credentials, and provider request content never cross this
/// command boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedModelIntentIssueResponseV1 {
    schema_version: u8,
    status: String,
    intent_event_ref: String,
    intent_digest: String,
    model_request_evidence: ModelRequestEvidenceV1,
    trust_scope_evidence: TrustScopeEvidenceV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayFormat {
    Json,
    Human,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportSignedTapeArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    /// Directory the `tape.json` export is written into.
    pub out: PathBuf,
}

/// Parse `ledger <subcommand> [args...]` into a LedgerCommand.
pub fn parse_ledger_command(args: &[String]) -> Result<LedgerCommand, String> {
    match args.first().map(String::as_str) {
        Some("serve") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_serve(&args[1..]).map(LedgerCommand::Serve)
        }
        Some("serve-governed-v1") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_serve_governed_v1(&args[1..]).map(LedgerCommand::ServeGovernedV1)
        }
        Some("replay") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_replay(&args[1..]).map(LedgerCommand::Replay)
        }
        Some("resolve-governed-dispatch-v3") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_resolve_governed_dispatch_v3(&args[1..])
                .map(LedgerCommand::ResolveGovernedDispatchV3)
        }
        Some("governed-verifier-v1") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_governed_verifier_v1(&args[1..]).map(LedgerCommand::GovernedVerifierV1)
        }
        Some("governed-model-intent-v1") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_governed_model_intent_v1(&args[1..]).map(LedgerCommand::GovernedModelIntentV1)
        }
        Some("governed-authority-v1") => {
            if args.len() != 1 {
                return Err("governed-authority-v1 does not accept flags".to_string());
            }
            Ok(LedgerCommand::GovernedAuthorityV1)
        }
        Some("provision-governed-authority-v1") => {
            if args.len() != 2
                || args[0] != "provision-governed-authority-v1"
                || args[1] != "--confirm"
            {
                return Err(
					"provision-governed-authority-v1 requires exactly --confirm; provisioning is an explicit operator action"
						.to_string(),
				);
            }
            Ok(LedgerCommand::ProvisionGovernedAuthorityV1)
        }
        Some("provision-governed-reviewer-authority-v1") => {
            if args.len() != 2
                || args[0] != "provision-governed-reviewer-authority-v1"
                || args[1] != "--confirm"
            {
                return Err(
                    "provision-governed-reviewer-authority-v1 requires exactly --confirm; provisioning a reviewer authority is an explicit operator action"
                        .to_string(),
                );
            }
            Ok(LedgerCommand::ProvisionGovernedReviewerAuthorityV1)
        }
        Some("provision-governed-operator-authority-v1") => {
            if args.len() != 2
                || args[0] != "provision-governed-operator-authority-v1"
                || args[1] != "--confirm"
            {
                return Err(
                    "provision-governed-operator-authority-v1 requires exactly --confirm; provisioning an operator authority is an explicit operator action"
                        .to_string(),
                );
            }
            Ok(LedgerCommand::ProvisionGovernedOperatorAuthorityV1)
        }
        Some("export-signed-tape") => {
            if args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
            {
                return Ok(LedgerCommand::Help);
            }
            parse_export_signed_tape(&args[1..]).map(LedgerCommand::ExportSignedTape)
        }
        Some("--help" | "-h" | "help") | None => Ok(LedgerCommand::Help),
        Some(other) => Err(format!("unknown ledger subcommand: {other}")),
    }
}

fn parse_serve(args: &[String]) -> Result<ServeArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut schema_version: u32 = 1;
    let mut sign = false;
    let mut signing_actor_id: Option<String> = None;
    let mut signing_key_id: Option<String> = None;
    let mut enable_activity_claims = false;
    let mut activity_claim_dispatch_actor_id: Option<String> = None;
    let mut activity_claim_dispatch_key_id: Option<String> = None;
    let mut activity_claim_action_request_actor_id: Option<String> = None;
    let mut activity_claim_action_request_key_id: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(
                    args.get(i).ok_or("--workspace requires a value")?,
                ));
            }
            "--schema-version" => {
                i += 1;
                schema_version = args
                    .get(i)
                    .ok_or("--schema-version requires a value")?
                    .parse()
                    .map_err(|_| "--schema-version must be an integer")?;
            }
            "--sign" => {
                sign = true;
            }
            "--signing-actor-id" => {
                i += 1;
                signing_actor_id = Some(
                    args.get(i)
                        .ok_or("--signing-actor-id requires a value")?
                        .clone(),
                );
            }
            "--signing-key-id" => {
                i += 1;
                signing_key_id = Some(
                    args.get(i)
                        .ok_or("--signing-key-id requires a value")?
                        .clone(),
                );
            }
            "--enable-activity-claims" => {
                enable_activity_claims = true;
            }
            "--activity-claim-dispatch-actor-id" => {
                i += 1;
                activity_claim_dispatch_actor_id = Some(
                    args.get(i)
                        .ok_or("--activity-claim-dispatch-actor-id requires a value")?
                        .clone(),
                );
            }
            "--activity-claim-dispatch-key-id" => {
                i += 1;
                activity_claim_dispatch_key_id = Some(
                    args.get(i)
                        .ok_or("--activity-claim-dispatch-key-id requires a value")?
                        .clone(),
                );
            }
            "--activity-claim-action-request-actor-id" => {
                i += 1;
                activity_claim_action_request_actor_id = Some(
                    args.get(i)
                        .ok_or("--activity-claim-action-request-actor-id requires a value")?
                        .clone(),
                );
            }
            "--activity-claim-action-request-key-id" => {
                i += 1;
                activity_claim_action_request_key_id = Some(
                    args.get(i)
                        .ok_or("--activity-claim-action-request-key-id requires a value")?
                        .clone(),
                );
            }
            "--help" | "-h" => {
                return Err("--help is handled by the top-level ledger parser".to_string());
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    let workspace = workspace.ok_or("missing --workspace")?;
    if !workspace.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace.display()
        ));
    }
    let authority_identity_supplied = [
        activity_claim_dispatch_actor_id.is_some(),
        activity_claim_dispatch_key_id.is_some(),
        activity_claim_action_request_actor_id.is_some(),
        activity_claim_action_request_key_id.is_some(),
    ]
    .into_iter()
    .any(|supplied| supplied);
    if authority_identity_supplied && !enable_activity_claims {
        return Err("activity claim authority flags require --enable-activity-claims".to_string());
    }
    let activity_claim_authority = if enable_activity_claims {
        if !sign {
            return Err("--enable-activity-claims requires --sign".to_string());
        }
        Some(ActivityClaimAuthorityArgs {
            dispatch_actor_id: require_activity_claim_identity(
                "--activity-claim-dispatch-actor-id",
                activity_claim_dispatch_actor_id,
            )?,
            dispatch_key_id: require_activity_claim_identity(
                "--activity-claim-dispatch-key-id",
                activity_claim_dispatch_key_id,
            )?,
            action_request_actor_id: require_activity_claim_identity(
                "--activity-claim-action-request-actor-id",
                activity_claim_action_request_actor_id,
            )?,
            action_request_key_id: require_activity_claim_identity(
                "--activity-claim-action-request-key-id",
                activity_claim_action_request_key_id,
            )?,
        })
    } else {
        None
    };
    Ok(ServeArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace,
        schema_version,
        sign,
        signing_actor_id: signing_actor_id.unwrap_or_else(|| DEFAULT_KERNEL_ACTOR_ID.to_string()),
        signing_key_id: signing_key_id.unwrap_or_else(|| DEFAULT_KERNEL_KEY_ID.to_string()),
        activity_claim_authority,
    })
}

fn parse_serve_governed_v1(args: &[String]) -> Result<ServeGovernedV1Args, String> {
    let mut run_id: Option<String> = None;
    let mut schema_version = 1_u32;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--run-id" => {
                index += 1;
                if run_id.is_some() {
                    return Err("duplicate --run-id".to_string());
                }
                run_id = Some(args.get(index).ok_or("--run-id requires a value")?.clone());
            }
            "--schema-version" => {
                index += 1;
                schema_version = args
                    .get(index)
                    .ok_or("--schema-version requires a value")?
                    .parse()
                    .map_err(|_| "--schema-version must be an integer")?;
            }
            other => return Err(format!("unknown governed serve flag: {other}")),
        }
        index += 1;
    }
    if schema_version != 1 {
        return Err("serve-governed-v1 supports only schema version 1".to_string());
    }
    let run_id = run_id.ok_or("missing --run-id")?;
    uuid::Uuid::parse_str(&run_id).map_err(|error| format!("--run-id must be a UUID: {error}"))?;
    Ok(ServeGovernedV1Args {
        run_id,
        schema_version,
    })
}

fn require_activity_claim_identity(flag: &str, value: Option<String>) -> Result<String, String> {
    let value =
        value.ok_or_else(|| format!("{flag} is required when --enable-activity-claims is set"))?;
    if value.trim().is_empty() {
        return Err(format!("{flag} must not be empty"));
    }
    Ok(value)
}

fn parse_replay(args: &[String]) -> Result<ReplayArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut format = ReplayFormat::Json;
    let mut limit: Option<usize> = None;
    let mut at: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(
                    args.get(i).ok_or("--workspace requires a value")?,
                ));
            }
            "--format" => {
                i += 1;
                let v = args.get(i).ok_or("--format requires a value")?;
                format = match v.as_str() {
                    "json" => ReplayFormat::Json,
                    "human" => ReplayFormat::Human,
                    other => return Err(format!("unknown format: {other}")),
                };
            }
            "--limit" => {
                i += 1;
                limit = Some(
                    args.get(i)
                        .ok_or("--limit requires a value")?
                        .parse()
                        .map_err(|_| "--limit must be a non-negative integer")?,
                );
            }
            "--at" => {
                i += 1;
                at = Some(args.get(i).ok_or("--at requires a value")?.clone());
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    Ok(ReplayArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace: workspace.ok_or("missing --workspace")?,
        format,
        limit,
        at,
    })
}

fn parse_resolve_governed_dispatch_v3(
    args: &[String],
) -> Result<ResolveGovernedDispatchV3Args, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut project_root: Option<PathBuf> = None;
    let mut dispatch_event_ref: Option<String> = None;
    let mut kernel_actor_id: Option<String> = None;
    let mut kernel_key_id: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                if run_id.is_some() {
                    return Err("duplicate --run-id".to_string());
                }
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                if workspace.is_some() {
                    return Err("duplicate --workspace".to_string());
                }
                workspace = Some(PathBuf::from(
                    args.get(i).ok_or("--workspace requires a value")?,
                ));
            }
            "--project-root" => {
                i += 1;
                if project_root.is_some() {
                    return Err("duplicate --project-root".to_string());
                }
                project_root = Some(PathBuf::from(
                    args.get(i).ok_or("--project-root requires a value")?,
                ));
            }
            "--dispatch-event-ref" => {
                i += 1;
                if dispatch_event_ref.is_some() {
                    return Err("duplicate --dispatch-event-ref".to_string());
                }
                dispatch_event_ref = Some(
                    args.get(i)
                        .ok_or("--dispatch-event-ref requires a value")?
                        .clone(),
                );
            }
            "--kernel-actor-id" => {
                i += 1;
                if kernel_actor_id.is_some() {
                    return Err("duplicate --kernel-actor-id".to_string());
                }
                kernel_actor_id = Some(
                    args.get(i)
                        .ok_or("--kernel-actor-id requires a value")?
                        .clone(),
                );
            }
            "--kernel-key-id" => {
                i += 1;
                if kernel_key_id.is_some() {
                    return Err("duplicate --kernel-key-id".to_string());
                }
                kernel_key_id = Some(
                    args.get(i)
                        .ok_or("--kernel-key-id requires a value")?
                        .clone(),
                );
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }

    let workspace = workspace.ok_or("missing --workspace")?;
    if !workspace.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace.display()
        ));
    }
    let project_root = project_root.ok_or("missing --project-root")?;
    if !project_root.is_absolute() {
        return Err(format!(
            "--project-root must be an absolute path; got: {}",
            project_root.display()
        ));
    }
    let dispatch_event_ref = dispatch_event_ref.ok_or("missing --dispatch-event-ref")?;
    let run_id = run_id.ok_or("missing --run-id")?;
    uuid::Uuid::parse_str(&run_id).map_err(|error| format!("--run-id must be a UUID: {error}"))?;
    uuid::Uuid::parse_str(&dispatch_event_ref)
        .map_err(|error| format!("--dispatch-event-ref must be a UUID: {error}"))?;
    let kernel_actor_id = require_trusted_kernel_identity("--kernel-actor-id", kernel_actor_id)?;
    let kernel_key_id = require_trusted_kernel_identity("--kernel-key-id", kernel_key_id)?;
    KeyringRef::new(kernel_actor_id.clone(), kernel_key_id.clone())
        .path_under(std::path::Path::new("/"))
        .map_err(|error| format!("invalid trusted kernel key reference: {error}"))?;

    Ok(ResolveGovernedDispatchV3Args {
        run_id,
        workspace,
        project_root,
        dispatch_event_ref,
        kernel_actor_id,
        kernel_key_id,
    })
}

fn parse_governed_verifier_v1(args: &[String]) -> Result<GovernedVerifierV1Args, String> {
    let Some((operation, flags)) = args.split_first() else {
        return Err("governed-verifier-v1 requires one of: claim, result".to_string());
    };
    match operation.as_str() {
        "claim" => parse_governed_verifier_claim(flags).map(GovernedVerifierV1Args::Claim),
        "result" => parse_governed_verifier_result(flags).map(GovernedVerifierV1Args::Result),
        other => Err(format!(
            "unknown governed-verifier-v1 operation: {other}; expected claim or result"
        )),
    }
}

fn parse_governed_model_intent_v1(args: &[String]) -> Result<GovernedModelIntentV1Args, String> {
    let Some((operation, flags)) = args.split_first() else {
        return Err("governed-model-intent-v1 requires the issue operation".to_string());
    };
    match operation.as_str() {
        "issue" => parse_governed_model_intent_issue(flags).map(GovernedModelIntentV1Args::Issue),
        other => Err(format!(
            "unknown governed-model-intent-v1 operation: {other}; expected issue"
        )),
    }
}

fn parse_governed_model_intent_issue(
    args: &[String],
) -> Result<GovernedModelIntentIssueArgs, String> {
    let values = parse_closed_governed_model_intent_flags(
        args,
        &[
            "--run-id",
            "--dispatch-event-ref",
            "--action-request-event-ref",
        ],
    )?;
    let run_id = required_governed_model_intent_flag(&values, "--run-id")?;
    require_uuid_flag("--run-id", &run_id)?;
    let dispatch_event_ref = required_governed_model_intent_flag(&values, "--dispatch-event-ref")?;
    require_uuid_flag("--dispatch-event-ref", &dispatch_event_ref)?;
    let action_request_event_ref =
        required_governed_model_intent_flag(&values, "--action-request-event-ref")?;
    require_uuid_flag("--action-request-event-ref", &action_request_event_ref)?;
    Ok(GovernedModelIntentIssueArgs {
        run_id,
        dispatch_event_ref,
        action_request_event_ref,
    })
}

fn parse_closed_governed_model_intent_flags(
    args: &[String],
    allowed: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !allowed.contains(&flag) {
            return Err(format!("unknown governed-model-intent-v1 flag: {flag}"));
        }
        index += 1;
        let value = args
            .get(index)
            .ok_or_else(|| format!("{flag} requires a value"))?
            .clone();
        if values.insert(flag.to_string(), value).is_some() {
            return Err(format!("duplicate {flag}"));
        }
        index += 1;
    }
    Ok(values)
}

fn required_governed_model_intent_flag(
    values: &BTreeMap<String, String>,
    flag: &str,
) -> Result<String, String> {
    let value = values
        .get(flag)
        .cloned()
        .ok_or_else(|| format!("missing {flag}"))?;
    if value.trim().is_empty() {
        return Err(format!("{flag} must not be empty"));
    }
    Ok(value)
}

fn parse_governed_verifier_claim(args: &[String]) -> Result<GovernedVerifierClaimArgs, String> {
    let values = parse_closed_governed_verifier_flags(
        args,
        &[
            "--run-id",
            "--project-root",
            "--dispatch-event-ref",
            "--action-request-event-ref",
            "--lease-duration-ms",
        ],
    )?;
    let run_id = required_governed_verifier_flag(&values, "--run-id")?;
    require_uuid_flag("--run-id", &run_id)?;
    let project_root = PathBuf::from(required_governed_verifier_flag(&values, "--project-root")?);
    if !project_root.is_absolute() {
        return Err(format!(
            "--project-root must be an absolute path; got: {}",
            project_root.display()
        ));
    }
    let dispatch_event_ref = required_governed_verifier_flag(&values, "--dispatch-event-ref")?;
    require_uuid_flag("--dispatch-event-ref", &dispatch_event_ref)?;
    let action_request_event_ref =
        required_governed_verifier_flag(&values, "--action-request-event-ref")?;
    require_uuid_flag("--action-request-event-ref", &action_request_event_ref)?;
    let lease_duration_ms = required_governed_verifier_flag(&values, "--lease-duration-ms")?
        .parse::<u64>()
        .map_err(|_| "--lease-duration-ms must be an unsigned integer".to_string())?;
    if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&lease_duration_ms) {
        return Err(format!(
            "--lease-duration-ms must be between {MIN_ACTIVITY_LEASE_MS} and {MAX_ACTIVITY_LEASE_MS}"
        ));
    }
    Ok(GovernedVerifierClaimArgs {
        run_id,
        project_root,
        dispatch_event_ref,
        action_request_event_ref,
        lease_duration_ms,
    })
}

fn parse_governed_verifier_result(args: &[String]) -> Result<GovernedVerifierResultArgs, String> {
    let values = parse_closed_governed_verifier_flags(
        args,
        &[
            "--run-id",
            "--lease-id",
            "--outcome",
            "--result-digest",
            "--result-ref",
            "--evidence-digest",
            "--evidence-ref",
        ],
    )?;
    let run_id = required_governed_verifier_flag(&values, "--run-id")?;
    require_uuid_flag("--run-id", &run_id)?;
    let lease_id = required_governed_verifier_flag(&values, "--lease-id")?;
    let outcome = match required_governed_verifier_flag(&values, "--outcome")?.as_str() {
        "succeeded" => ActivityResultOutcomeV1::Succeeded,
        "failed" => ActivityResultOutcomeV1::Failed,
        "unknown" => ActivityResultOutcomeV1::Unknown,
        other => {
            return Err(format!(
                "--outcome must be succeeded, failed, or unknown; got {other:?}"
            ))
        }
    };
    let result_digest = values.get("--result-digest").cloned();
    let result_ref = values.get("--result-ref").cloned();
    if result_digest.is_some() != result_ref.is_some() {
        return Err("--result-digest and --result-ref must be supplied together".to_string());
    }
    if outcome == ActivityResultOutcomeV1::Succeeded && result_digest.is_none() {
        return Err("--outcome succeeded requires --result-digest and --result-ref".to_string());
    }
    if outcome == ActivityResultOutcomeV1::Unknown && result_digest.is_some() {
        return Err("--outcome unknown must not include a result".to_string());
    }
    if let Some(digest) = result_digest.as_deref() {
        require_canonical_sha256_flag("--result-digest", digest)?;
    }
    if let Some(reference) = result_ref.as_deref() {
        require_nonempty_governed_verifier_flag("--result-ref", reference)?;
    }
    let evidence_digest = required_governed_verifier_flag(&values, "--evidence-digest")?;
    require_canonical_sha256_flag("--evidence-digest", &evidence_digest)?;
    let evidence_ref = required_governed_verifier_flag(&values, "--evidence-ref")?;
    require_nonempty_governed_verifier_flag("--evidence-ref", &evidence_ref)?;
    Ok(GovernedVerifierResultArgs {
        run_id,
        lease_id,
        outcome,
        result_digest,
        result_ref,
        evidence_digest,
        evidence_ref,
    })
}

fn parse_closed_governed_verifier_flags(
    args: &[String],
    allowed: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !allowed.contains(&flag) {
            return Err(format!("unknown governed-verifier-v1 flag: {flag}"));
        }
        index += 1;
        let value = args
            .get(index)
            .ok_or_else(|| format!("{flag} requires a value"))?
            .clone();
        if values.insert(flag.to_string(), value).is_some() {
            return Err(format!("duplicate {flag}"));
        }
        index += 1;
    }
    Ok(values)
}

fn required_governed_verifier_flag(
    values: &BTreeMap<String, String>,
    flag: &str,
) -> Result<String, String> {
    let value = values
        .get(flag)
        .cloned()
        .ok_or_else(|| format!("missing {flag}"))?;
    require_nonempty_governed_verifier_flag(flag, &value)?;
    Ok(value)
}

fn require_nonempty_governed_verifier_flag(flag: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{flag} must not be empty"));
    }
    Ok(())
}

fn require_uuid_flag(flag: &str, value: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(value).map_err(|error| format!("{flag} must be a UUID: {error}"))?;
    Ok(())
}

fn require_canonical_sha256_flag(flag: &str, value: &str) -> Result<(), String> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(format!("{flag} must be a canonical sha256 digest"));
    }
    Ok(())
}

fn require_trusted_kernel_identity(flag: &str, value: Option<String>) -> Result<String, String> {
    let value = value.ok_or_else(|| format!("missing {flag}"))?;
    if value.trim().is_empty() {
        return Err(format!("{flag} must not be empty"));
    }
    Ok(value)
}

fn parse_export_signed_tape(args: &[String]) -> Result<ExportSignedTapeArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(
                    args.get(i).ok_or("--workspace requires a value")?,
                ));
            }
            "--out" => {
                i += 1;
                out = Some(PathBuf::from(args.get(i).ok_or("--out requires a value")?));
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    let workspace = workspace.ok_or("missing --workspace")?;
    if !workspace.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace.display()
        ));
    }
    Ok(ExportSignedTapeArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace,
        out: out.ok_or("missing --out")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_ledger::payload::trust_spine::governed_dispatch_policy_digest_v1;

    #[test]
    fn parse_governed_verifier_claim_accepts_only_closed_host_realm_inputs() {
        let args = vec![
            "governed-verifier-v1".to_string(),
            "claim".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--action-request-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000002".to_string(),
            "--lease-duration-ms".to_string(),
            MIN_ACTIVITY_LEASE_MS.to_string(),
        ];

        let command = parse_ledger_command(&args).unwrap();
        assert!(matches!(
            command,
            LedgerCommand::GovernedVerifierV1(GovernedVerifierV1Args::Claim(
                GovernedVerifierClaimArgs { lease_duration_ms, .. }
            )) if lease_duration_ms == MIN_ACTIVITY_LEASE_MS
        ));
    }

    #[test]
    fn parse_governed_verifier_rejects_generic_authority_and_invalid_result_shapes() {
        let claim = vec![
            "claim".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--action-request-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000002".to_string(),
            "--lease-duration-ms".to_string(),
            MIN_ACTIVITY_LEASE_MS.to_string(),
            "--workspace".to_string(),
            "/tmp/forged".to_string(),
        ];
        let claim_error = parse_governed_verifier_v1(&claim).unwrap_err();
        assert!(
            claim_error.contains("unknown governed-verifier-v1 flag: --workspace"),
            "unexpected error: {claim_error}"
        );

        let result = vec![
            "result".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--lease-id".to_string(),
            "lease-1".to_string(),
            "--outcome".to_string(),
            "succeeded".to_string(),
            "--evidence-digest".to_string(),
            format!("sha256:{}", "a".repeat(64)),
            "--evidence-ref".to_string(),
            "cas:verifier-evidence".to_string(),
        ];
        let result_error = parse_governed_verifier_v1(&result).unwrap_err();
        assert!(
            result_error.contains("succeeded requires --result-digest and --result-ref"),
            "unexpected error: {result_error}"
        );
    }

    #[test]
    fn parse_governed_model_intent_issue_accepts_only_tape_identity_flags() {
        let args = vec![
            "governed-model-intent-v1".to_string(),
            "issue".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--action-request-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000002".to_string(),
        ];
        let command = parse_ledger_command(&args).unwrap();
        assert!(matches!(
            command,
            LedgerCommand::GovernedModelIntentV1(GovernedModelIntentV1Args::Issue(
                GovernedModelIntentIssueArgs { .. }
            ))
        ));
    }

    #[test]
    fn parse_governed_model_intent_rejects_caller_authority_and_evidence_inputs() {
        let args = vec![
            "issue".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--action-request-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000002".to_string(),
            "--workspace".to_string(),
            "/tmp/forged".to_string(),
        ];
        let error = parse_governed_model_intent_v1(&args).unwrap_err();
        assert!(
            error.contains("unknown governed-model-intent-v1 flag: --workspace"),
            "unexpected error: {error}"
        );

        let with_evidence = vec![
            "issue".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--action-request-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000002".to_string(),
            "--model-request-evidence".to_string(),
            "cas:sha256:forged".to_string(),
        ];
        let evidence_error = parse_governed_model_intent_v1(&with_evidence).unwrap_err();
        assert!(
            evidence_error
                .contains("unknown governed-model-intent-v1 flag: --model-request-evidence"),
            "unexpected error: {evidence_error}"
        );
    }

    #[test]
    fn parse_serve_rejects_relative_workspace() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "./relative/path".to_string(),
        ];
        let err = parse_serve(&args).unwrap_err();
        assert!(
            err.contains("absolute"),
            "expected 'absolute' in error: {err}"
        );
    }

    #[test]
    fn parse_serve_accepts_absolute_workspace() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
        ];
        let out = parse_serve(&args).unwrap();
        assert_eq!(out.workspace.to_str().unwrap(), "/tmp/abs");
        assert_eq!(out.run_id, "abc");
    }

    #[test]
    fn parse_serve_defaults_to_unsigned() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
        ];
        let out = parse_serve(&args).unwrap();
        assert!(!out.sign, "signing must default OFF");
        assert_eq!(out.signing_actor_id, "kernel");
        assert_eq!(out.signing_key_id, "kernel-main");
        assert!(
            out.activity_claim_authority.is_none(),
            "activity claims must default disabled"
        );
    }

    #[test]
    fn parse_serve_accepts_sign_flag_key_id_and_actor_id() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--signing-actor-id".to_string(),
            "operator:1".to_string(),
            "--signing-key-id".to_string(),
            "operator-main".to_string(),
        ];
        let out = parse_serve(&args).unwrap();
        assert!(out.sign);
        assert_eq!(out.signing_actor_id, "operator:1");
        assert_eq!(out.signing_key_id, "operator-main");
    }

    #[test]
    fn parse_serve_enables_activity_claims_with_complete_explicit_authority() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--enable-activity-claims".to_string(),
            "--activity-claim-dispatch-actor-id".to_string(),
            "kernel".to_string(),
            "--activity-claim-dispatch-key-id".to_string(),
            "kernel-main".to_string(),
            "--activity-claim-action-request-actor-id".to_string(),
            "worker:dispatch".to_string(),
            "--activity-claim-action-request-key-id".to_string(),
            "worker-main".to_string(),
        ];

        let out = parse_serve(&args).unwrap();
        let authority = out
            .activity_claim_authority
            .expect("complete explicit authority must enable activity claims");
        assert_eq!(authority.dispatch_actor_id, "kernel");
        assert_eq!(authority.dispatch_key_id, "kernel-main");
        assert_eq!(authority.action_request_actor_id, "worker:dispatch");
        assert_eq!(authority.action_request_key_id, "worker-main");
    }

    #[test]
    fn parse_serve_rejects_activity_claim_enable_without_signing() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--enable-activity-claims".to_string(),
            "--activity-claim-dispatch-actor-id".to_string(),
            "kernel".to_string(),
            "--activity-claim-dispatch-key-id".to_string(),
            "kernel-main".to_string(),
            "--activity-claim-action-request-actor-id".to_string(),
            "worker:dispatch".to_string(),
            "--activity-claim-action-request-key-id".to_string(),
            "worker-main".to_string(),
        ];

        let err = parse_serve(&args).unwrap_err();
        assert!(err.contains("--sign"), "expected signing error: {err}");
    }

    #[test]
    fn parse_serve_rejects_activity_claim_enable_without_authority_identities() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--enable-activity-claims".to_string(),
        ];

        let err = parse_serve(&args).unwrap_err();
        assert!(
            err.contains("--activity-claim-dispatch-actor-id"),
            "expected missing authority error: {err}"
        );
    }

    #[test]
    fn parse_serve_rejects_partial_activity_claim_authority() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--enable-activity-claims".to_string(),
            "--activity-claim-dispatch-actor-id".to_string(),
            "kernel".to_string(),
            "--activity-claim-dispatch-key-id".to_string(),
            "kernel-main".to_string(),
        ];

        let err = parse_serve(&args).unwrap_err();
        assert!(
            err.contains("activity-claim-action-request"),
            "expected incomplete authority error: {err}"
        );
    }

    #[test]
    fn parse_serve_rejects_activity_claim_authority_without_enable_flag() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--activity-claim-dispatch-actor-id".to_string(),
            "kernel".to_string(),
            "--activity-claim-dispatch-key-id".to_string(),
            "kernel-main".to_string(),
            "--activity-claim-action-request-actor-id".to_string(),
            "worker:dispatch".to_string(),
            "--activity-claim-action-request-key-id".to_string(),
            "worker-main".to_string(),
        ];

        let err = parse_serve(&args).unwrap_err();
        assert!(
            err.contains("--enable-activity-claims"),
            "expected opt-in error: {err}"
        );
    }

    #[test]
    fn parse_serve_rejects_empty_activity_claim_authority_identity() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
            "--sign".to_string(),
            "--enable-activity-claims".to_string(),
            "--activity-claim-dispatch-actor-id".to_string(),
            "".to_string(),
            "--activity-claim-dispatch-key-id".to_string(),
            "kernel-main".to_string(),
            "--activity-claim-action-request-actor-id".to_string(),
            "worker:dispatch".to_string(),
            "--activity-claim-action-request-key-id".to_string(),
            "worker-main".to_string(),
        ];

        let err = parse_serve(&args).unwrap_err();
        assert!(
            err.contains("must not be empty"),
            "expected empty error: {err}"
        );
    }

    #[test]
    fn activity_claim_authority_builder_rejects_unsigned_signing_config() {
        let authority = ActivityClaimAuthorityArgs {
            dispatch_actor_id: "kernel".to_string(),
            dispatch_key_id: "kernel-main".to_string(),
            action_request_actor_id: "worker:dispatch".to_string(),
            action_request_key_id: "worker-main".to_string(),
        };

        let err = build_activity_claim_protocol_config(Some(&authority), &SigningConfig::Unsigned)
            .unwrap_err();
        assert!(
            err.contains("signed append"),
            "expected unsigned rejection: {err}"
        );
    }

    #[test]
    fn parse_replay_defaults_to_json_format() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(out.format, ReplayFormat::Json);
        assert!(out.limit.is_none());
        assert!(out.at.is_none());
    }

    #[test]
    fn parse_replay_accepts_human_format_with_limit() {
        let args = vec![
            "--run-id".to_string(),
            "run1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--format".to_string(),
            "human".to_string(),
            "--limit".to_string(),
            "5".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(out.format, ReplayFormat::Human);
        assert_eq!(out.limit, Some(5));
    }

    #[test]
    fn parse_replay_accepts_at_flag() {
        let args = vec![
            "--run-id".to_string(),
            "run1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--at".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(
            out.at.as_deref(),
            Some("01919000-0000-7000-8000-000000000001")
        );
    }

    #[test]
    fn parse_replay_rejects_unknown_format() {
        let args = vec![
            "--run-id".to_string(),
            "r".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--format".to_string(),
            "xml".to_string(),
        ];
        let err = parse_replay(&args).unwrap_err();
        assert!(err.contains("xml"), "expected format name in error: {err}");
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_requires_explicit_local_kernel_trust() {
        let args = vec![
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
        ];
        let err = parse_resolve_governed_dispatch_v3(&args).unwrap_err();
        assert!(
            err.contains("--kernel-actor-id"),
            "expected explicit kernel actor failure: {err}"
        );
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_accepts_closed_local_trust_config() {
        let args = vec![
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-key-id".to_string(),
            "kernel-main".to_string(),
        ];
        let out = parse_resolve_governed_dispatch_v3(&args).unwrap();
        assert_eq!(out.kernel_actor_id, "kernel");
        assert_eq!(out.kernel_key_id, "kernel-main");
        assert_eq!(
            out.dispatch_event_ref,
            "01919000-0000-7000-8000-000000000001"
        );
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_rejects_non_uuid_dispatch_reference() {
        let args = vec![
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "not-a-uuid".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-key-id".to_string(),
            "kernel-main".to_string(),
        ];
        let err = parse_resolve_governed_dispatch_v3(&args).unwrap_err();
        assert!(err.contains("UUID"), "expected UUID rejection: {err}");
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_rejects_non_uuid_run_id() {
        let args = vec![
            "--run-id".to_string(),
            "not-a-run-uuid".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-key-id".to_string(),
            "kernel-main".to_string(),
        ];
        let err = parse_resolve_governed_dispatch_v3(&args).unwrap_err();
        assert!(err.contains("--run-id must be a UUID"), "error: {err}");
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_rejects_duplicate_authority_flags() {
        let args = vec![
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-actor-id".to_string(),
            "other-kernel".to_string(),
            "--kernel-key-id".to_string(),
            "kernel-main".to_string(),
        ];
        let err = parse_resolve_governed_dispatch_v3(&args).unwrap_err();
        assert!(err.contains("duplicate --kernel-actor-id"), "error: {err}");
    }

    #[test]
    fn parse_resolve_governed_dispatch_v3_rejects_unsafe_local_key_reference() {
        let args = vec![
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-key-id".to_string(),
            "../../escape".to_string(),
        ];
        let err = parse_resolve_governed_dispatch_v3(&args).unwrap_err();
        assert!(
            err.contains("invalid trusted kernel key reference"),
            "error: {err}"
        );
    }

    fn resolved_governed_v3_workflow(expires_at: &str) -> WorkflowInstanceV1 {
        use bp_ledger::payload::trust_spine::{
            ActionEvidenceVersionV1, CommitModeV1, DispatchBudgetV1, ExecutionRoleV1, TrustTierV1,
        };

        WorkflowInstanceV1 {
            run_id: "run".to_string(),
            workflow_id: "workflow".to_string(),
            workflow_revision: "v1".to_string(),
            unit_id: "unit".to_string(),
            attempt: 1,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 3,
                event_id: bp_ledger::id::EventId::from_uuid(
                    uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000001").unwrap(),
                ),
                envelope_digest:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                provenance_ref: "provenance".to_string(),
                base_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                repository_binding_digest: Some(
                    "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                        .to_string(),
                ),
                ledger_authority_realm_digest: Some(
                    "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                        .to_string(),
                ),
                governed_packet_digest: Some(
                    "sha256:3333333333333333333333333333333333333333333333333333333333333333"
                        .to_string(),
                ),
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_string(),
                acceptance_contract_digest:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_string(),
                context_manifest_digest:
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                        .to_string(),
                worker_manifest_digest:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_string(),
                sandbox_profile_digest:
                    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                        .to_string(),
                execution_role: ExecutionRoleV1::Implementer,
                commit_mode: CommitModeV1::Atomic,
                budget: DispatchBudgetV1 {
                    max_tokens: Some(1),
                    max_compute_time_ms: Some(1),
                },
                trust_tier: TrustTierV1::Governed,
                idempotency_key: "attempt-1".to_string(),
                issued_at: "2026-01-01T00:00:00Z".to_string(),
                expires_at: expires_at.to_string(),
                signature_ref: None,
                action_evidence_version: Some(ActionEvidenceVersionV1::SealedV3),
            },
            action_evidence: None,
            retry_context: None,
            timers: Default::default(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: Default::default(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        }
    }

    /// This is the sole construction point for the cross-language resolver
    /// fixture. Keep it a projection of the native closed structs, rather
    /// than duplicating those structs in TypeScript: the assertion below
    /// fails whenever serde output changes.
    fn governed_dispatch_resolution_v1_fixture_projection() -> GovernedDispatchResolutionV1 {
        governed_dispatch_resolution_v1_fixture_from_workflow(
            governed_dispatch_resolution_v1_fixture_workflow(),
        )
    }

    fn governed_dispatch_resolution_v1_fixture_workflow() -> WorkflowInstanceV1 {
        use bp_ledger::payload::trust_spine::DispatchBudgetV1;

        let mut workflow = resolved_governed_v3_workflow("2099-07-18T12:00:00Z");
        workflow.run_id = "00000000-0000-7000-8000-000000000011".to_string();
        workflow.workflow_id = "workflow-trust-spine".to_string();
        workflow.workflow_revision = "1".to_string();
        workflow.unit_id = "unit-trust-spine".to_string();
        workflow.dispatch.event_id = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str("00000000-0000-7000-8000-000000000012").unwrap(),
        );
        workflow.dispatch.envelope_digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_string();
        workflow.dispatch.provenance_ref = "plan-admitted:fixture".to_string();
        workflow.dispatch.base_commit_sha = "a".repeat(40);
        workflow.dispatch.repository_binding_digest = Some(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        );
        workflow.dispatch.ledger_authority_realm_digest = Some(
            "sha256:9999999999999999999999999999999999999999999999999999999999999999".to_string(),
        );
        workflow.dispatch.governed_packet_digest = Some(
            "sha256:8888888888888888888888888888888888888888888888888888888888888888".to_string(),
        );
        workflow.dispatch.capability_bundle_digest =
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string();
        workflow.dispatch.acceptance_contract_digest =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        workflow.dispatch.context_manifest_digest =
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_string();
        workflow.dispatch.worker_manifest_digest =
            "sha256:1111111111111111111111111111111111111111111111111111111111111111".to_string();
        workflow.dispatch.sandbox_profile_digest =
            "sha256:2222222222222222222222222222222222222222222222222222222222222222".to_string();
        workflow.dispatch.budget = DispatchBudgetV1 {
            max_tokens: Some(12),
            max_compute_time_ms: Some(30_000),
        };
        workflow.dispatch.idempotency_key = "dispatch:fixture".to_string();
        workflow.dispatch.issued_at = "2026-07-18T12:00:00Z".to_string();

        workflow
    }

    fn governed_dispatch_resolution_v1_fixture_from_workflow(
        workflow: WorkflowInstanceV1,
    ) -> GovernedDispatchResolutionV1 {
        use bp_ledger::payload::checkpoint::TapeRootAlgorithm;

        project_governed_dispatch_resolution(
            "00000000-0000-7000-8000-000000000012".to_string(),
            ActorKeyRef {
                actor_id: "kernel".to_string(),
                key_id: "kernel-main".to_string(),
                public_key_hash: Some(
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_string(),
                ),
            },
            workflow,
            TapeIntegrityReportV1 {
                schema_version: 1,
                checkpoint_event_ref: "00000000-0000-7000-8000-000000000015".to_string(),
                checkpoint_event_digest:
                    "sha256:7777777777777777777777777777777777777777777777777777777777777777"
                        .to_string(),
                through_event_ref: "00000000-0000-7000-8000-000000000012".to_string(),
                signed_non_checkpoint_event_count: 1,
                tape_root_hash:
                    "sha256:6666666666666666666666666666666666666666666666666666666666666666"
                        .to_string(),
                algorithm: TapeRootAlgorithm::Sha256Linear,
            },
        )
    }

    #[test]
    fn governed_dispatch_resolution_v1_fixture_matches_native_serialization() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../apps/cli/test/fixtures/governed-dispatch-resolution-v1.json"
        ))
        .expect("cross-language governed-dispatch fixture must be valid JSON");
        let actual = serde_json::to_value(governed_dispatch_resolution_v1_fixture_projection())
            .expect("native governed-dispatch projection must serialize");

        assert_eq!(
            actual, expected,
            "the TypeScript resolver fixture must stay exactly aligned with the native closed projection"
        );
    }

    fn governed_fixture_event_id(value: &str) -> bp_ledger::id::EventId {
        bp_ledger::id::EventId::from_uuid(uuid::Uuid::parse_str(value).unwrap())
    }

    fn governed_fixture_digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn governed_dispatch_resolution_v1_completed_candidate_fixture_workflow() -> WorkflowInstanceV1
    {
        use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
        use bp_ledger::payload::trust_spine::{
            action_receipt_recorded_v2_digest, action_receipt_set_v1_digest,
            action_requested_v2_digest, candidate_completion_recorded_v1_digest,
            governed_dispatch_policy_digest_v1, ActionEvidenceVersionV1, ActionKindV1,
            ActionReceiptOutcomeV2, ActionReceiptRecordedV2, ActionReceiptSetEntryV1,
            ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
            CandidateCompletionRecordedV1,
        };
        use bp_replay::{ActionEvidenceReplayState, ActionReplayState, ActivityResultReplayState};
        use std::collections::BTreeMap;

        let mut workflow = governed_dispatch_resolution_v1_fixture_workflow();
        workflow.phase = WorkflowPhaseV1::CandidateCreated;
        let action_id = "git-candidate-create:candidate-1/run-1/1".to_string();
        let action_request_payload = ActionRequestedV2 {
            run_id: workflow.run_id.clone(),
            workflow_id: workflow.workflow_id.clone(),
            unit_id: workflow.unit_id.clone(),
            attempt: workflow.attempt,
            provenance_ref: workflow.dispatch.provenance_ref.clone(),
            action_id: action_id.clone(),
            idempotency_key: action_id.clone(),
            action_kind: ActionKindV1::Git,
            canonical_input_digest: governed_fixture_digest('1'),
            canonical_input_ref: "cas://candidate-create/input".to_string(),
            dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
            repository_binding_digest: workflow
                .dispatch
                .repository_binding_digest
                .clone()
                .expect("fixture V3 dispatch repository binding"),
            ledger_authority_realm_digest: workflow
                .dispatch
                .ledger_authority_realm_digest
                .clone()
                .expect("fixture V3 dispatch ledger realm"),
            governed_packet_digest: workflow.dispatch.governed_packet_digest.clone(),
            capability_bundle_digest: workflow.dispatch.capability_bundle_digest.clone(),
            policy_digest: governed_dispatch_policy_digest_v1(
                &workflow.dispatch.acceptance_contract_digest,
            )
            .expect("fixture acceptance digest is canonical"),
            context_manifest_digest: workflow.dispatch.context_manifest_digest.clone(),
            worker_manifest_digest: workflow.dispatch.worker_manifest_digest.clone(),
            sandbox_profile_digest: workflow.dispatch.sandbox_profile_digest.clone(),
            authority_actor: "kernel".to_string(),
            execution_role: ExecutionRoleV1::Implementer,
            requested_at: "2026-07-18T12:01:00Z".to_string(),
        };
        let action_request_digest = action_requested_v2_digest(&action_request_payload)
            .expect("fixture action request must serialize");
        let action_request = ActionRequestReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000013"),
            action_id: action_request_payload.action_id.clone(),
            idempotency_key: action_request_payload.idempotency_key.clone(),
            action_kind: action_request_payload.action_kind,
            canonical_input_digest: action_request_payload.canonical_input_digest.clone(),
            canonical_input_ref: action_request_payload.canonical_input_ref.clone(),
            repository_binding_digest: action_request_payload.repository_binding_digest.clone(),
            ledger_authority_realm_digest: action_request_payload
                .ledger_authority_realm_digest
                .clone(),
            governed_packet_digest: action_request_payload.governed_packet_digest.clone(),
            policy_digest: action_request_payload.policy_digest.clone(),
            authority_actor: action_request_payload.authority_actor.clone(),
            execution_role: action_request_payload.execution_role,
            requested_at: action_request_payload.requested_at.clone(),
            action_request_digest: action_request_digest.clone(),
        };

        let action_receipt_payload = ActionReceiptRecordedV2 {
            run_id: workflow.run_id.clone(),
            workflow_id: workflow.workflow_id.clone(),
            unit_id: workflow.unit_id.clone(),
            attempt: workflow.attempt,
            provenance_ref: workflow.dispatch.provenance_ref.clone(),
            action_id: action_id.clone(),
            idempotency_key: action_id.clone(),
            action_request_digest: action_request_digest.clone(),
            dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
            capability_bundle_digest: workflow.dispatch.capability_bundle_digest.clone(),
            policy_digest: action_request_payload.policy_digest.clone(),
            context_manifest_digest: workflow.dispatch.context_manifest_digest.clone(),
            worker_manifest_digest: workflow.dispatch.worker_manifest_digest.clone(),
            sandbox_profile_digest: workflow.dispatch.sandbox_profile_digest.clone(),
            authority_actor: "kernel".to_string(),
            execution_role: ExecutionRoleV1::Implementer,
            outcome: ActionReceiptOutcomeV2::Succeeded,
            result_digest: Some(governed_fixture_digest('2')),
            result_ref: Some("cas://candidate-create/result".to_string()),
            evidence_digest: governed_fixture_digest('3'),
            evidence_ref: "cas://candidate-create/evidence".to_string(),
            resource_usage: ActionResourceUsageV1 {
                wall_time_ms: 1,
                cpu_time_ms: None,
                peak_memory_bytes: None,
                input_bytes: None,
                output_bytes: None,
                input_tokens: Some(2),
                output_tokens: Some(3),
            },
            redactions: vec![],
            failure: None,
            authorization_ref: None,
            action_receipt_ref: "receipt:candidate-create".to_string(),
            completed_at: "2026-07-18T12:02:00Z".to_string(),
        };
        let action_receipt_digest = action_receipt_recorded_v2_digest(&action_receipt_payload)
            .expect("fixture action receipt must serialize");
        let action_receipt = ActionReceiptReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000019"),
            action_id: action_receipt_payload.action_id.clone(),
            idempotency_key: action_receipt_payload.idempotency_key.clone(),
            action_request_digest: action_receipt_payload.action_request_digest.clone(),
            outcome: action_receipt_payload.outcome,
            result_digest: action_receipt_payload.result_digest.clone(),
            result_ref: action_receipt_payload.result_ref.clone(),
            evidence_digest: action_receipt_payload.evidence_digest.clone(),
            evidence_ref: action_receipt_payload.evidence_ref.clone(),
            resource_usage: action_receipt_payload.resource_usage.clone(),
            redactions: action_receipt_payload.redactions.clone(),
            failure: action_receipt_payload.failure.clone(),
            authorization_ref: action_receipt_payload.authorization_ref.clone(),
            action_receipt_ref: action_receipt_payload.action_receipt_ref.clone(),
            action_receipt_digest: action_receipt_digest.clone(),
            completed_at: action_receipt_payload.completed_at.clone(),
        };

        let mut receipt_set_payload = ActionReceiptSetRecordedV1 {
            run_id: workflow.run_id.clone(),
            workflow_id: workflow.workflow_id.clone(),
            unit_id: workflow.unit_id.clone(),
            attempt: workflow.attempt,
            provenance_ref: workflow.dispatch.provenance_ref.clone(),
            dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
            action_receipt_set_ref: "receipt-set:candidate-create".to_string(),
            action_receipt_set_digest: String::new(),
            receipts: vec![ActionReceiptSetEntryV1 {
                action_id: action_id.clone(),
                action_receipt_ref: action_receipt_payload.action_receipt_ref.clone(),
                action_receipt_digest: action_receipt_digest.clone(),
            }],
            sealed_at: action_receipt_payload.completed_at.clone(),
        };
        receipt_set_payload.action_receipt_set_digest =
            action_receipt_set_v1_digest(&receipt_set_payload)
                .expect("fixture receipt set must serialize");
        let receipt_set = ActionReceiptSetReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000016"),
            action_receipt_set_ref: receipt_set_payload.action_receipt_set_ref.clone(),
            action_receipt_set_digest: receipt_set_payload.action_receipt_set_digest.clone(),
            receipts: receipt_set_payload.receipts.clone(),
            sealed_at: receipt_set_payload.sealed_at.clone(),
        };

        let activity_claim = ActivityClaimReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000017"),
            claim_event_digest: governed_fixture_digest('4'),
            run_id: workflow.run_id.clone(),
            activity_id: action_id.clone(),
            idempotency_key: action_id.clone(),
            action_kind: ActionKindV1::Git,
            action_request_event_id: action_request.event_id,
            action_request_digest: action_request_digest.clone(),
            dispatch_event_id: workflow.dispatch.event_id,
            dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
            authority_actor: "kernel".to_string(),
            lease_id: "candidate-create-lease".to_string(),
            lease_expires_at: "2026-07-18T12:10:00Z".to_string(),
            claimed_at: "2026-07-18T12:01:30Z".to_string(),
            signer: Some(ActorKeyRef {
                actor_id: "kernel".to_string(),
                key_id: "kernel-main".to_string(),
                public_key_hash: Some(governed_fixture_digest('c')),
            }),
            heartbeats: vec![],
            result: Some(ActivityResultReplayState {
                event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000018"),
                event_digest: governed_fixture_digest('5'),
                run_id: workflow.run_id.clone(),
                activity_id: action_id.clone(),
                idempotency_key: action_id.clone(),
                claim_event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000017"),
                claim_event_digest: governed_fixture_digest('4'),
                lease_id: "candidate-create-lease".to_string(),
                outcome: ActivityResultOutcomeV1::Succeeded,
                result_digest: Some(governed_fixture_digest('6')),
                result_ref: Some("cas://candidate-create/activity-result".to_string()),
                evidence_digest: governed_fixture_digest('7'),
                evidence_ref: "cas://candidate-create/activity-evidence".to_string(),
                recorded_at: "2026-07-18T12:01:45Z".to_string(),
            }),
        };

        workflow.action_evidence = Some(ActionEvidenceReplayState {
            action_evidence_version: ActionEvidenceVersionV1::SealedV3,
            actions: BTreeMap::from([(
                action_id.clone(),
                ActionReplayState {
                    request: action_request,
                    model_intent: None,
                    model_authorization: None,
                    activity_claim: Some(activity_claim),
                    receipt: Some(action_receipt),
                },
            )]),
            sealed_receipt_set: Some(receipt_set),
            pending_action_ids: vec![],
            unknown_action_ids: vec![],
            failed_action_ids: vec![],
        });
        workflow.candidate = Some(CandidateArtifactReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000014"),
            candidate_id: "candidate-1".to_string(),
            candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".to_string(),
            candidate_digest: governed_fixture_digest('3'),
            base_commit_sha: workflow.dispatch.base_commit_sha.clone(),
            candidate_commit_sha: "b".repeat(40),
            commit_digest: governed_fixture_digest('4'),
            tree_digest: governed_fixture_digest('5'),
            patch_digest: governed_fixture_digest('6'),
            changed_files_digest: governed_fixture_digest('7'),
            envelope_digest: workflow.dispatch.envelope_digest.clone(),
            action_receipt_digest: None,
            action_receipt_set_ref: Some(receipt_set_payload.action_receipt_set_ref.clone()),
            action_receipt_set_digest: Some(receipt_set_payload.action_receipt_set_digest.clone()),
        });
        let mut completion = CandidateCompletionRecordedV1 {
            run_id: workflow.run_id.clone(),
            workflow_id: workflow.workflow_id.clone(),
            unit_id: workflow.unit_id.clone(),
            attempt: workflow.attempt,
            provenance_ref: workflow.dispatch.provenance_ref.clone(),
            candidate_created_event_ref: governed_fixture_event_id(
                "00000000-0000-7000-8000-000000000014",
            ),
            candidate_digest: governed_fixture_digest('3'),
            candidate_create_action_id: action_id,
            action_request_ref: governed_fixture_event_id("00000000-0000-7000-8000-000000000013"),
            action_request_digest,
            activity_claim_event_ref: governed_fixture_event_id(
                "00000000-0000-7000-8000-000000000017",
            ),
            activity_claim_event_digest: governed_fixture_digest('4'),
            activity_result_event_ref: governed_fixture_event_id(
                "00000000-0000-7000-8000-000000000018",
            ),
            activity_result_event_digest: governed_fixture_digest('5'),
            action_receipt_ref: action_receipt_payload.action_receipt_ref,
            action_receipt_digest,
            completion_digest: String::new(),
            completed_at: action_receipt_payload.completed_at,
        };
        completion.completion_digest = candidate_completion_recorded_v1_digest(&completion)
            .expect("fixture candidate completion must serialize");
        workflow.candidate_completion = Some(CandidateCompletionReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000020"),
            completion,
        });

        workflow
    }

    fn governed_dispatch_resolution_v1_completed_candidate_fixture_projection(
    ) -> GovernedDispatchResolutionV1 {
        governed_dispatch_resolution_v1_fixture_from_workflow(
            governed_dispatch_resolution_v1_completed_candidate_fixture_workflow(),
        )
    }

    fn governed_dispatch_resolution_v1_cancellation_fixture_projection(
    ) -> GovernedDispatchResolutionV1 {
        use bp_ledger::payload::trust_spine::{WorkflowCancellationCauseV1, WorkflowTimerKindV1};

        let mut workflow = governed_dispatch_resolution_v1_fixture_workflow();
        workflow.phase = WorkflowPhaseV1::CancellationRequested;
        let timer_event = governed_fixture_event_id("00000000-0000-7000-8000-000000000021");
        let timer_digest = governed_fixture_digest('1');
        let fired_event = governed_fixture_event_id("00000000-0000-7000-8000-000000000022");
        workflow.timers.insert(
            "deadline:fixture".to_string(),
            WorkflowTimerReplayState {
                event_id: timer_event,
                event_digest: timer_digest.clone(),
                run_id: workflow.run_id.clone(),
                workflow_id: workflow.workflow_id.clone(),
                workflow_revision: workflow.workflow_revision.clone(),
                unit_id: workflow.unit_id.clone(),
                attempt: workflow.attempt,
                dispatch_event_ref: workflow.dispatch.event_id,
                dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
                timer_id: "deadline:fixture".to_string(),
                timer_kind: WorkflowTimerKindV1::WorkflowDeadline,
                due_at: "2026-07-18T12:10:00Z".to_string(),
                idempotency_key: "timer:deadline:fixture".to_string(),
                scheduled_by: "kernel".to_string(),
                scheduled_at: "2026-07-18T12:01:00Z".to_string(),
                fired: Some(bp_replay::state::WorkflowTimerFiredReplayState {
                    event_id: fired_event,
                    event_digest: governed_fixture_digest('2'),
                    timer_schedule_event_ref: timer_event,
                    timer_schedule_event_digest: timer_digest,
                    fired_by: "kernel".to_string(),
                    fired_at: "2026-07-18T12:10:00Z".to_string(),
                }),
            },
        );
        workflow.cancellation = Some(WorkflowCancellationReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000023"),
            event_digest: governed_fixture_digest('3'),
            cancellation_id: "cancel:deadline:fixture".to_string(),
            cause: WorkflowCancellationCauseV1::TimerElapsed,
            timer_fired_event_ref: Some(fired_event),
            timer_fired_event_digest: Some(governed_fixture_digest('2')),
            requested_by: "kernel".to_string(),
            idempotency_key: "cancel:deadline:fixture".to_string(),
            requested_at: "2026-07-18T12:10:00Z".to_string(),
        });

        governed_dispatch_resolution_v1_fixture_from_workflow(workflow)
    }

    fn governed_dispatch_resolution_v1_promotion_approval_fixture_projection(
    ) -> GovernedDispatchResolutionV1 {
        use bp_ledger::payload::trust_spine::{
            candidate_view_v1_digest, review_verdict_output_v1_digest,
            CandidateAcceptanceOutcomeV1, CandidateViewV1, ReviewDecisionV1, ReviewVerdictOutputV1,
        };

        let mut workflow = governed_dispatch_resolution_v1_completed_candidate_fixture_workflow();
        let candidate = workflow
            .candidate
            .as_ref()
            .expect("completed candidate fixture must retain candidate state")
            .clone();
        let acceptance = CandidateAcceptanceReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000021"),
            candidate_digest: candidate.candidate_digest.clone(),
            candidate_commit_sha: candidate.candidate_commit_sha.clone(),
            acceptance_ref: "acceptance:fixture".to_string(),
            acceptance_contract_digest: workflow.dispatch.acceptance_contract_digest.clone(),
            acceptance_digest: governed_fixture_digest('8'),
            outcome: CandidateAcceptanceOutcomeV1::Passed,
            evaluated_at: "2026-07-18T12:02:10Z".to_string(),
        };
        workflow.acceptance = Some(acceptance.clone());

        let candidate_view = CandidateViewV1 {
            candidate_ref: candidate.candidate_ref.clone(),
            candidate_digest: candidate.candidate_digest.clone(),
            candidate_commit_sha: candidate.candidate_commit_sha.clone(),
            tree_digest: candidate.tree_digest.clone(),
            reviewer_context_manifest_digest: governed_fixture_digest('6'),
            reviewer_sandbox_profile_digest: governed_fixture_digest('7'),
            mount_path_digest: governed_fixture_digest('8'),
            read_only: true,
            network_disabled: true,
        };
        let candidate_view_digest = candidate_view_v1_digest(&candidate_view)
            .expect("fixture candidate view must serialize");
        let review_output_digest = review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
            candidate_digest: candidate.candidate_digest.clone(),
            candidate_commit_sha: candidate.candidate_commit_sha.clone(),
            decision: ReviewDecisionV1::Approve,
            findings: vec![],
            confidence: 1.0,
            candidate_view_digest: candidate_view_digest.clone(),
        })
        .expect("fixture review output must serialize");
        let review_ref = "review:fixture".to_string();
        workflow.reviews.insert(
            review_ref.clone(),
            ReviewVerdictReplayState {
                review_version: 2,
                event_id: governed_fixture_event_id("00000000-0000-7000-8000-000000000022"),
                candidate_digest: candidate.candidate_digest.clone(),
                candidate_commit_sha: candidate.candidate_commit_sha.clone(),
                review_ref: review_ref.clone(),
                decision: ReviewDecisionV1::Approve,
                findings: vec![],
                confidence: 1.0,
                reviewer_manifest_digest: governed_fixture_digest('9'),
                review_verdict_action_id: Some("review:fixture/action".to_string()),
                review_action_request_digest: Some(governed_fixture_digest('1')),
                review_action_receipt_ref: Some("receipt:review:fixture".to_string()),
                review_action_receipt_digest: Some(governed_fixture_digest('2')),
                review_output_ref: Some("cas://review/fixture-output".to_string()),
                review_output_digest: Some(review_output_digest),
                acceptance_ref: Some(acceptance.acceptance_ref.clone()),
                acceptance_digest: Some(acceptance.acceptance_digest.clone()),
                acceptance_contract_digest: Some(acceptance.acceptance_contract_digest.clone()),
                candidate_envelope_digest: Some(candidate.envelope_digest.clone()),
                reviewer_workflow_id: Some("review-workflow:fixture".to_string()),
                reviewer_dispatch_envelope_digest: Some(governed_fixture_digest('4')),
                reviewer_unit_id: Some("review-unit:fixture".to_string()),
                reviewer_attempt: Some(1),
                reviewer_execution_role: Some(ExecutionRoleV1::Reviewer),
                review_action_receipt_set_ref: Some("receipt-set:review:fixture".to_string()),
                review_action_receipt_set_digest: Some(governed_fixture_digest('5')),
                candidate_view: Some(candidate_view),
                candidate_view_ref: Some("candidate-view:fixture".to_string()),
                candidate_view_digest: Some(candidate_view_digest),
                reviewer_authority: Some("reviewer:fixture".to_string()),
                reviewed_at: "2026-07-18T12:02:20Z".to_string(),
            },
        );
        workflow.phase = WorkflowPhaseV1::ReviewApproved;
        workflow.promotion_approval = Some(PromotionApprovalRequestReplayState {
            event_id: governed_fixture_event_id("00000000-0000-7000-8000-0000000000aa"),
            candidate_digest: candidate.candidate_digest,
            base_commit_sha: candidate.base_commit_sha,
            target_ref: "refs/heads/main".to_string(),
            envelope_digest: candidate.envelope_digest,
            acceptance_ref: acceptance.acceptance_ref,
            review_refs: vec![review_ref],
            requested_by: "kernel".to_string(),
            requested_at: "2026-07-18T12:02:30Z".to_string(),
            idempotency_key: "promotion:fixture".to_string(),
        });
        workflow.phase = WorkflowPhaseV1::PromotionApprovalPending;

        governed_dispatch_resolution_v1_fixture_from_workflow(workflow)
    }

    #[test]
    fn governed_dispatch_resolution_v1_completed_candidate_fixture_matches_native_serialization() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../apps/cli/test/fixtures/governed-dispatch-resolution-v1-completed-candidate.json"
        ))
        .expect("completed candidate cross-language fixture must be valid JSON");
        let actual = serde_json::to_value(
            governed_dispatch_resolution_v1_completed_candidate_fixture_projection(),
        )
        .expect("native completed candidate projection must serialize");

        assert_eq!(
            actual, expected,
            "the populated TypeScript resolver fixture must stay exactly aligned with the native closed projection"
        );
    }

    #[test]
    fn governed_dispatch_resolution_v1_cancellation_fixture_matches_native_serialization() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../apps/cli/test/fixtures/governed-dispatch-resolution-v1-cancellation.json"
        ))
        .expect("cancellation cross-language fixture must be valid JSON");
        let actual =
            serde_json::to_value(governed_dispatch_resolution_v1_cancellation_fixture_projection())
                .expect("native cancellation projection must serialize");

        assert_eq!(
            actual, expected,
            "the timer/cancellation TypeScript resolver fixture must stay exactly aligned with the native closed projection"
        );
    }

    #[test]
    fn governed_dispatch_resolution_v1_promotion_approval_fixture_matches_native_serialization() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../apps/cli/test/fixtures/governed-dispatch-resolution-v1-promotion-approval.json"
        ))
        .expect("promotion approval cross-language fixture must be valid JSON");
        let actual = serde_json::to_value(
            governed_dispatch_resolution_v1_promotion_approval_fixture_projection(),
        )
        .expect("native promotion approval projection must serialize");

        assert_eq!(
            actual, expected,
            "the promotion approval TypeScript resolver fixture must stay exactly aligned with the native closed projection"
        );
    }

    #[test]
    fn recovery_projection_exposes_a_pending_promotion_approval_as_read_only_evidence() {
        let mut workflow = resolved_governed_v3_workflow("2026-01-02T00:00:00Z");
        workflow.phase = WorkflowPhaseV1::PromotionApprovalPending;
        workflow.promotion_approval = Some(PromotionApprovalRequestReplayState {
            event_id: bp_ledger::id::EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000aa").unwrap(),
            ),
            candidate_digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            base_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            target_ref: "refs/heads/main".to_string(),
            envelope_digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_string(),
            acceptance_ref: "acceptance:1".to_string(),
            review_refs: vec!["review:1".to_string()],
            requested_by: "kernel".to_string(),
            requested_at: "2026-01-01T00:00:00Z".to_string(),
            idempotency_key: "promotion:1".to_string(),
        });

        let recovery = project_governed_dispatch_recovery(&workflow);

        assert_eq!(recovery.phase, WorkflowPhaseV1::PromotionApprovalPending);
        assert_eq!(
            recovery
                .promotion_approval
                .as_ref()
                .expect("pending approval evidence")
                .event_id,
            workflow
                .promotion_approval
                .as_ref()
                .expect("pending approval state")
                .event_id
        );
        assert!(recovery.promotion.is_none());
    }

    #[test]
    fn recovery_projection_exposes_timer_and_cancellation_status_without_authority() {
        use bp_ledger::payload::trust_spine::{WorkflowCancellationCauseV1, WorkflowTimerKindV1};

        let mut workflow = resolved_governed_v3_workflow("2026-01-02T00:00:00Z");
        workflow.phase = WorkflowPhaseV1::CancellationRequested;
        let timer_event = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000041").unwrap(),
        );
        let timer_digest =
            "sha256:1111111111111111111111111111111111111111111111111111111111111111".to_string();
        let fired_event = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000042").unwrap(),
        );
        workflow.timers.insert(
            "deadline:fixture".to_string(),
            bp_replay::state::WorkflowTimerReplayState {
                event_id: timer_event,
                event_digest: timer_digest.clone(),
                run_id: workflow.run_id.clone(),
                workflow_id: workflow.workflow_id.clone(),
                workflow_revision: workflow.workflow_revision.clone(),
                unit_id: workflow.unit_id.clone(),
                attempt: workflow.attempt,
                dispatch_event_ref: workflow.dispatch.event_id,
                dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
                timer_id: "deadline:fixture".to_string(),
                timer_kind: WorkflowTimerKindV1::WorkflowDeadline,
                due_at: "2026-01-01T00:10:00Z".to_string(),
                idempotency_key: "timer:deadline:fixture".to_string(),
                scheduled_by: "kernel".to_string(),
                scheduled_at: "2026-01-01T00:00:00Z".to_string(),
                fired: Some(bp_replay::state::WorkflowTimerFiredReplayState {
                    event_id: fired_event,
                    event_digest:
                        "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                            .to_string(),
                    timer_schedule_event_ref: timer_event,
                    timer_schedule_event_digest: timer_digest,
                    fired_by: "kernel".to_string(),
                    fired_at: "2026-01-01T00:10:00Z".to_string(),
                }),
            },
        );
        workflow.cancellation = Some(bp_replay::state::WorkflowCancellationReplayState {
            event_id: bp_ledger::id::EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000043").unwrap(),
            ),
            event_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333"
                .to_string(),
            cancellation_id: "cancel:deadline:fixture".to_string(),
            cause: WorkflowCancellationCauseV1::TimerElapsed,
            timer_fired_event_ref: Some(fired_event),
            timer_fired_event_digest: Some(
                "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                    .to_string(),
            ),
            requested_by: "kernel".to_string(),
            idempotency_key: "cancel:deadline:fixture".to_string(),
            requested_at: "2026-01-01T00:10:00Z".to_string(),
        });

        let recovery = project_governed_dispatch_recovery(&workflow);

        assert_eq!(recovery.phase, WorkflowPhaseV1::CancellationRequested);
        assert_eq!(recovery.timers.len(), 1);
        assert_eq!(
            recovery.timers[0]
                .fired
                .as_ref()
                .expect("firing record")
                .event_id,
            fired_event
        );
        assert_eq!(
            recovery
                .cancellation
                .as_ref()
                .expect("cancellation status")
                .cancellation_id,
            "cancel:deadline:fixture"
        );
    }

    #[test]
    fn recovery_projection_exposes_the_exact_candidate_completion_proof() {
        use bp_ledger::payload::trust_spine::CandidateCompletionRecordedV1;

        let mut workflow = resolved_governed_v3_workflow("2026-01-02T00:00:00Z");
        workflow.candidate_completion = Some(CandidateCompletionReplayState {
            event_id: bp_ledger::id::EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000049").unwrap(),
            ),
            completion: CandidateCompletionRecordedV1 {
                run_id: "run".to_string(),
                workflow_id: "workflow".to_string(),
                unit_id: "unit".to_string(),
                attempt: 1,
                provenance_ref: "provenance".to_string(),
                candidate_created_event_ref: bp_ledger::id::EventId::from_uuid(
                    uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000046").unwrap(),
                ),
                candidate_digest:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                candidate_create_action_id: "git-candidate-create:candidate/run/1".to_string(),
                action_request_ref: bp_ledger::id::EventId::from_uuid(
                    uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000041").unwrap(),
                ),
                action_request_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_string(),
                activity_claim_event_ref: bp_ledger::id::EventId::from_uuid(
                    uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000047").unwrap(),
                ),
                activity_claim_event_digest:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_string(),
                activity_result_event_ref: bp_ledger::id::EventId::from_uuid(
                    uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000048").unwrap(),
                ),
                activity_result_event_digest:
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                        .to_string(),
                action_receipt_ref: "receipt:1".to_string(),
                action_receipt_digest:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_string(),
                completion_digest:
                    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                        .to_string(),
                completed_at: "2026-01-01T00:00:00Z".to_string(),
            },
        });

        let recovery = project_governed_dispatch_recovery(&workflow);

        let completion = recovery
            .candidate_completion
            .expect("candidate completion recovery proof");
        assert_eq!(
            completion.event_id,
            workflow
                .candidate_completion
                .as_ref()
                .expect("candidate completion state")
                .event_id
        );
        assert_eq!(
            completion
                .completion
                .candidate_created_event_ref
                .to_string(),
            "01919000-0000-7000-8000-000000000046"
        );
        assert_eq!(
            completion.completion.activity_result_event_digest,
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        );
    }

    #[test]
    fn verified_dispatch_expiry_blocks_resolution() {
        let workflow = resolved_governed_v3_workflow("2026-01-01T00:01:00Z");
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:01:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let err = validate_resolved_governed_dispatch_v3(&workflow, now).unwrap_err();
        assert!(err.contains("expired"), "expected expiry failure: {err}");
    }

    #[test]
    fn verified_dispatch_rejects_legacy_evidence_even_after_replay() {
        use bp_ledger::payload::trust_spine::ActionEvidenceVersionV1;

        let mut workflow = resolved_governed_v3_workflow("2026-01-02T00:00:00Z");
        workflow.dispatch.action_evidence_version = Some(ActionEvidenceVersionV1::SealedV2);
        let now = DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let err = validate_resolved_governed_dispatch_v3(&workflow, now).unwrap_err();
        assert!(
            err.contains("sealed_v3"),
            "expected sealed_v3 failure: {err}"
        );
    }

    #[test]
    fn resolver_blocks_an_uncheckpointed_governed_tape_before_projecting_recovery() {
        use bp_ledger::event::Event;
        use bp_ledger::id::{EventId, RunId};
        use bp_ledger::kind::EventKind;
        use bp_ledger::payload::trust_spine::{
            dispatch_envelope_v3_body_digest, ActionEvidenceVersionV1, ActionKindV1,
            ActionRequestedV2, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
            DispatchEnvelopeV3, ExecutionRoleV1, TrustTierV1,
        };
        use bp_ledger::payload::Payload;
        use bp_ledger::storage::sqlite::SqliteStore;
        use ed25519_dalek::SigningKey;

        const DIGEST_A: &str =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const DIGEST_B: &str =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const DIGEST_C: &str =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        let temp = tempfile::tempdir().unwrap();
        let ledger_dir = temp.path().join(".buildplane").join("ledger");
        std::fs::create_dir_all(&ledger_dir).unwrap();
        let store = SqliteStore::open(ledger_dir.join("events.db")).unwrap();
        let run_id = RunId::from_uuid(
            uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap(),
        );
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let signer = ActorKeyRef {
            actor_id: "kernel".to_string(),
            key_id: "kernel-main".to_string(),
            public_key_hash: None,
        };
        let body = DispatchEnvelopeBodyV2 {
            workflow_id: "workflow-1".to_string(),
            workflow_revision: "r1".to_string(),
            unit_id: "unit-1".to_string(),
            attempt: 1,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: "admission:1".to_string(),
            base_commit_sha: "1".repeat(40),
            capability_bundle_digest: DIGEST_A.to_string(),
            acceptance_contract_digest: DIGEST_B.to_string(),
            context_manifest_digest: DIGEST_A.to_string(),
            worker_manifest_digest: DIGEST_B.to_string(),
            sandbox_profile_digest: DIGEST_C.to_string(),
            budget: DispatchBudgetV1 {
                max_tokens: Some(2_048),
                max_compute_time_ms: Some(60_000),
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch:workflow-1:unit-1:1".to_string(),
            issued_at: "2026-07-17T00:00:00Z".to_string(),
            expires_at: "2026-07-17T01:00:00Z".to_string(),
        };
        let dispatch = DispatchEnvelopeV3 {
            envelope_digest: dispatch_envelope_v3_body_digest(
                &body,
                ActionEvidenceVersionV1::SealedV3,
                DIGEST_A,
                DIGEST_B,
                Some(DIGEST_C),
            )
            .unwrap(),
            body,
            action_evidence_version: ActionEvidenceVersionV1::SealedV3,
            repository_binding_digest: DIGEST_A.to_string(),
            ledger_authority_realm_digest: DIGEST_B.to_string(),
            governed_packet_digest: Some(DIGEST_C.to_string()),
        };
        let dispatch_event = Event {
            id: EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000001").unwrap(),
            ),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::DispatchEnvelopeV3,
            occurred_at: DateTime::parse_from_rfc3339("2026-07-17T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
        };
        store
            .append_signed(&dispatch_event, &signing_key, &signer)
            .unwrap();

        let request_event = Event {
            id: EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000002").unwrap(),
            ),
            run_id,
            parent_event_id: Some(dispatch_event.id),
            schema_version: 1,
            kind: EventKind::ActionRequestedV2,
            occurred_at: DateTime::parse_from_rfc3339("2026-07-17T00:00:01Z")
                .unwrap()
                .with_timezone(&Utc),
            payload: Payload::ActionRequestedV2(ActionRequestedV2 {
                run_id: run_id.to_string(),
                workflow_id: dispatch.body.workflow_id.clone(),
                unit_id: dispatch.body.unit_id.clone(),
                attempt: dispatch.body.attempt,
                provenance_ref: dispatch.body.provenance_ref.clone(),
                action_id: "action-1".to_string(),
                idempotency_key: "action:action-1".to_string(),
                action_kind: ActionKindV1::Process,
                canonical_input_digest: DIGEST_A.to_string(),
                canonical_input_ref: "cas:input:action-1".to_string(),
                dispatch_envelope_digest: dispatch.envelope_digest.clone(),
                repository_binding_digest: dispatch.repository_binding_digest.clone(),
                ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
                governed_packet_digest: dispatch.governed_packet_digest.clone(),
                capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
                policy_digest: governed_dispatch_policy_digest_v1(
                    &dispatch.body.acceptance_contract_digest,
                )
                .unwrap(),
                context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
                worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
                sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
                authority_actor: "kernel".to_string(),
                execution_role: dispatch.body.execution_role,
                requested_at: "2026-07-17T00:00:01Z".to_string(),
            }),
        };
        store
            .append_signed(&request_event, &signing_key, &signer)
            .unwrap();

        let args = ResolveGovernedDispatchV3Args {
            run_id: run_id.to_string(),
            workspace: temp.path().to_path_buf(),
            project_root: temp.path().to_path_buf(),
            dispatch_event_ref: dispatch_event.id.to_string(),
            kernel_actor_id: "kernel".to_string(),
            kernel_key_id: "kernel-main".to_string(),
        };
        let (authorities, trusted_signer) =
            trusted_kernel_replay_authorities("kernel", "kernel-main", &signing_key);
        let now = DateTime::parse_from_rfc3339("2026-07-17T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let missing_checkpoint =
            resolve_governed_dispatch_v3_at(&args, &authorities, trusted_signer, now).unwrap_err();
        assert!(
            missing_checkpoint.contains("tape integrity"),
            "governed recovery must reject an uncheckpointed signed snapshot: {missing_checkpoint}"
        );
        drop(store);

        let untrusted_key = SigningKey::from_bytes(&[8; 32]);
        let (untrusted_authorities, untrusted_signer) =
            trusted_kernel_replay_authorities("kernel", "kernel-main", &untrusted_key);
        let err =
            resolve_governed_dispatch_v3_at(&args, &untrusted_authorities, untrusted_signer, now)
                .unwrap_err();
        assert!(
            err.contains("not verified and authorized"),
            "untrusted tape signer must not mint authority: {err}"
        );
    }

    #[test]
    fn governed_replay_blocks_unresolved_authority_evidence() {
        let issue = ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id: bp_ledger::id::EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000aa").unwrap(),
            ),
            event_kind: "review_verdict_recorded_v2".to_string(),
            required_role: "reviewer".to_string(),
            signer_actor_id: Some("reviewer".to_string()),
            signer_key_id: Some("reviewer-main".to_string()),
            reason: "detached signer is not authorized for this trust-spine event role".to_string(),
        };

        let error = reject_governed_replay_issues(&[issue]).unwrap_err();
        assert!(error.contains("recovery is blocked"), "error: {error}");
        assert!(
            error.contains("review_verdict_recorded_v2"),
            "error: {error}"
        );
    }

    #[test]
    fn governed_replay_blocks_unpinned_operator_promotion_evidence() {
        let issue = ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id: bp_ledger::id::EventId::from_uuid(
                uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ab").unwrap(),
            ),
            event_kind: "promotion_decision_recorded".to_string(),
            required_role: "operator".to_string(),
            signer_actor_id: Some("operator".to_string()),
            signer_key_id: Some("operator-main".to_string()),
            reason: "detached signer is not authorized for this trust-spine event role".to_string(),
        };

        let error = reject_governed_replay_issues(&[issue]).unwrap_err();
        assert!(error.contains("recovery is blocked"), "error: {error}");
        assert!(
            error.contains("promotion_decision_recorded"),
            "error: {error}"
        );
    }

    #[test]
    fn governed_replay_does_not_treat_legacy_diagnostics_as_authority() {
        let issue = ReplayIssue::CheckpointFailed {
            unit_id: "legacy-unit".to_string(),
            step: "checkpoint".to_string(),
            error: "legacy checkpoint diagnostic".to_string(),
        };

        reject_governed_replay_issues(&[issue])
            .expect("a legacy diagnostic alone must not rewrite governed authority semantics");
    }

    #[test]
    fn role_root_preflight_is_limited_to_its_assigned_event_kinds() {
        assert!(event_kind_requires_reviewer_authority(
            EventKind::ReviewVerdictRecorded.as_wire()
        ));
        assert!(event_kind_requires_reviewer_authority(
            EventKind::ReviewVerdictRecordedV2.as_wire()
        ));
        assert!(!event_kind_requires_reviewer_authority(
            EventKind::DispatchEnvelopeV3.as_wire()
        ));
        assert!(!event_kind_requires_reviewer_authority(
            EventKind::ModelActionIntentV1.as_wire()
        ));
        assert!(!event_kind_requires_reviewer_authority(
            "future_unknown_event_kind"
        ));
        assert!(event_kind_requires_operator_authority(
            EventKind::PromotionDecisionRecorded.as_wire()
        ));
        assert!(event_kind_requires_operator_authority(
            EventKind::PromotionReconciliationResolved.as_wire()
        ));
        assert!(!event_kind_requires_operator_authority(
            EventKind::PromotionApprovalRequested.as_wire()
        ));
        assert!(!event_kind_requires_operator_authority(
            EventKind::ReviewVerdictRecordedV2.as_wire()
        ));
        assert!(!event_kind_requires_operator_authority(
            EventKind::DispatchEnvelopeV3.as_wire()
        ));
    }

    #[test]
    fn replay_authority_rejects_cross_role_key_reuse() {
        let kernel = ActorKeyRef {
            actor_id: "kernel".to_string(),
            key_id: "kernel-main".to_string(),
            public_key_hash: Some(format!("sha256:{}", "a".repeat(64))),
        };
        let reviewer = ActorKeyRef {
            actor_id: "reviewer".to_string(),
            key_id: "reviewer-main".to_string(),
            public_key_hash: Some(format!("sha256:{}", "b".repeat(64))),
        };
        let operator_with_reviewer_key = ActorKeyRef {
            actor_id: "operator".to_string(),
            key_id: "operator-main".to_string(),
            public_key_hash: reviewer.public_key_hash.clone(),
        };

        let error = reject_replay_signer_key_reuse(
            &kernel,
            Some(&reviewer),
            Some(&operator_with_reviewer_key),
        )
        .unwrap_err();
        assert!(
            error.contains("distinct from the reviewer"),
            "error: {error}"
        );

        reject_replay_signer_key_reuse(&kernel, Some(&reviewer), None)
            .expect("a distinct reviewer key remains valid");
    }

    #[test]
    fn parse_export_signed_tape_requires_all_flags() {
        let args = vec![
            "--run-id".to_string(),
            "run-1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--out".to_string(),
            "/tmp/out".to_string(),
        ];
        let out = parse_export_signed_tape(&args).unwrap();
        assert_eq!(out.run_id, "run-1");
        assert_eq!(out.workspace.to_str().unwrap(), "/tmp/ws");
        assert_eq!(out.out.to_str().unwrap(), "/tmp/out");
    }

    #[test]
    fn parse_export_signed_tape_rejects_relative_workspace() {
        let args = vec![
            "--run-id".to_string(),
            "run-1".to_string(),
            "--workspace".to_string(),
            "./ws".to_string(),
            "--out".to_string(),
            "/tmp/out".to_string(),
        ];
        let err = parse_export_signed_tape(&args).unwrap_err();
        assert!(
            err.contains("absolute"),
            "expected 'absolute' in error: {err}"
        );
    }

    #[test]
    fn parse_export_signed_tape_requires_out() {
        let args = vec![
            "--run-id".to_string(),
            "run-1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
        ];
        let err = parse_export_signed_tape(&args).unwrap_err();
        assert!(err.contains("out"), "expected missing --out error: {err}");
    }

    #[test]
    fn parse_ledger_command_routes_export_signed_tape() {
        let args = vec![
            "export-signed-tape".to_string(),
            "--run-id".to_string(),
            "r".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--out".to_string(),
            "/tmp/out".to_string(),
        ];
        assert!(matches!(
            parse_ledger_command(&args).unwrap(),
            LedgerCommand::ExportSignedTape(_)
        ));
    }

    #[test]
    fn parse_ledger_command_routes_governed_dispatch_resolution() {
        let args = vec![
            "resolve-governed-dispatch-v3".to_string(),
            "--run-id".to_string(),
            "01919000-0000-7000-8000-0000000000ff".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--project-root".to_string(),
            "/tmp/project".to_string(),
            "--dispatch-event-ref".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
            "--kernel-actor-id".to_string(),
            "kernel".to_string(),
            "--kernel-key-id".to_string(),
            "kernel-main".to_string(),
        ];
        assert!(matches!(
            parse_ledger_command(&args).unwrap(),
            LedgerCommand::ResolveGovernedDispatchV3(_)
        ));
    }

    #[test]
    fn parse_governed_reviewer_authority_provision_requires_exact_confirmation() {
        let accepted = vec![
            "provision-governed-reviewer-authority-v1".to_string(),
            "--confirm".to_string(),
        ];
        assert_eq!(
            parse_ledger_command(&accepted).unwrap(),
            LedgerCommand::ProvisionGovernedReviewerAuthorityV1
        );

        for rejected in [
            vec!["provision-governed-reviewer-authority-v1"],
            vec![
                "provision-governed-reviewer-authority-v1",
                "--workspace",
                "/tmp/untrusted-workspace",
            ],
            vec![
                "provision-governed-reviewer-authority-v1",
                "--reviewer-key-id",
                "caller-selected-key",
            ],
            vec![
                "provision-governed-reviewer-authority-v1",
                "--signing-actor-id",
                "caller-selected-signer",
            ],
            vec![
                "provision-governed-reviewer-authority-v1",
                "--confirm",
                "--confirm",
            ],
        ] {
            let rejected = rejected.into_iter().map(str::to_string).collect::<Vec<_>>();
            let error = parse_ledger_command(&rejected).unwrap_err();
            assert!(
                error.contains("requires exactly --confirm"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn parse_governed_operator_authority_provision_requires_exact_confirmation() {
        let accepted = vec![
            "provision-governed-operator-authority-v1".to_string(),
            "--confirm".to_string(),
        ];
        assert_eq!(
            parse_ledger_command(&accepted).unwrap(),
            LedgerCommand::ProvisionGovernedOperatorAuthorityV1
        );

        for rejected in [
            vec!["provision-governed-operator-authority-v1"],
            vec![
                "provision-governed-operator-authority-v1",
                "--workspace",
                "/tmp/untrusted-workspace",
            ],
            vec![
                "provision-governed-operator-authority-v1",
                "--operator-key-id",
                "caller-selected-key",
            ],
            vec![
                "provision-governed-operator-authority-v1",
                "--signing-actor-id",
                "caller-selected-signer",
            ],
            vec![
                "provision-governed-operator-authority-v1",
                "--confirm",
                "--confirm",
            ],
        ] {
            let rejected = rejected.into_iter().map(str::to_string).collect::<Vec<_>>();
            let error = parse_ledger_command(&rejected).unwrap_err();
            assert!(
                error.contains("requires exactly --confirm"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn ledger_usage_documents_only_confirmation_for_reviewer_authority_provisioning() {
        let usage = usage_text();
        assert!(usage.contains("provision-governed-reviewer-authority-v1"));
        let (_, provision_flags) = usage
            .split_once("flags for `provision-governed-reviewer-authority-v1`:\n")
            .expect("reviewer authority provisioning flags should be documented");
        let (provision_flags, _) = provision_flags
            .split_once("\nflags for `provision-governed-operator-authority-v1`:")
            .expect("reviewer authority provisioning flags should remain closed");
        assert_eq!(
            provision_flags.trim(),
            "--confirm                 closed bootstrap syntax; production requires a broker"
        );
    }

    #[test]
    fn ledger_usage_documents_only_confirmation_for_operator_authority_provisioning() {
        let usage = usage_text();
        assert!(usage.contains("provision-governed-operator-authority-v1"));
        let (_, provision_flags) = usage
            .split_once("flags for `provision-governed-operator-authority-v1`:\n")
            .expect("operator authority provisioning flags should be documented");
        let (provision_flags, _) = provision_flags
            .split_once("\nflags for `export-signed-tape`:")
            .expect("operator authority provisioning flags should remain closed");
        assert_eq!(
            provision_flags.trim(),
            "--confirm                 closed bootstrap syntax; production requires a broker"
        );
    }

    #[test]
    fn ledger_usage_documents_the_kernel_realm_prerequisite_and_marks_serve_legacy() {
        let usage = usage_text();

        assert!(usage.contains("governed-authority-v1"));
        assert!(usage.contains("provision-governed-authority-v1"));
        assert!(usage.contains("GOVERNED_AUTHORITY_BROKER_REQUIRED"));
        assert!(usage.contains("Legacy/non-governed ledger ingest"));
        assert!(usage.contains("It cannot create a trusted"));
        assert!(
            !usage.contains("operator:1 maps to"),
            "legacy actor aliases must not be presented as governed authority"
        );
    }

    #[test]
    fn parse_ledger_command_routes_export_help_to_help() {
        let args = vec!["export-signed-tape".to_string(), "--help".to_string()];
        assert_eq!(parse_ledger_command(&args).unwrap(), LedgerCommand::Help);
    }

    #[test]
    fn parse_ledger_command_routes_serve_help_to_help() {
        let args = vec!["serve".to_string(), "--help".to_string()];
        assert_eq!(parse_ledger_command(&args).unwrap(), LedgerCommand::Help);
    }

    #[test]
    fn parse_ledger_command_routes_replay_help_to_help() {
        let args = vec![
            "replay".to_string(),
            "--run-id".to_string(),
            "run-1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "-h".to_string(),
        ];
        assert_eq!(parse_ledger_command(&args).unwrap(), LedgerCommand::Help);
    }

    #[test]
    fn governed_serve_endpoint_requires_the_protected_authority_broker() {
        let err = run_serve_governed_v1(ServeGovernedV1Args {
            run_id: "01919000-0000-7000-8000-0000000000aa".to_string(),
            schema_version: 1,
        })
        .unwrap_err();
        assert!(
            err.contains("GOVERNED_AUTHORITY_BROKER_REQUIRED")
                || err.contains("reading governed authority root"),
            "governed serve must fail closed when the protected authority broker is unavailable: {err}"
        );
    }
}

/// Execute the `ledger serve` command.
///
/// Resolves the ledger database path from the workspace, opens it, and runs
/// the protocol state machine against stdin.
pub fn run_serve(args: ServeArgs) -> Result<(), String> {
    if args.schema_version != 1 {
        return Err(format!(
            "schema version {} not supported in this build (supported: 1)",
            args.schema_version
        ));
    }
    // Signing is opt-in (default OFF). When enabled, only a key *reference* is
    // resolved here; key bytes are loaded locally by the ledger and any error
    // redacts secret-shaped material.
    let signing = if args.sign {
        let key_ref = KeyringRef::new(args.signing_actor_id.clone(), args.signing_key_id.clone());
        SigningConfig::signed_from_keyring(&key_ref)
            .map_err(|e| format!("loading configured signing key: {e}"))?
    } else {
        SigningConfig::Unsigned
    };
    let activity_claims =
        build_activity_claim_protocol_config(args.activity_claim_authority.as_ref(), &signing)?;
    run_serve_with_authority(args, signing, activity_claims)
}

/// Run the protected, run-bound governed activity-control session.
///
/// This deliberately differs from generic `ledger serve`: stdin may carry
/// only closed claim/heartbeat/result controls and is bound to the one
/// caller-requested run after the host realm has been loaded. All caller event
/// lines are rejected before canonicalization, signing, or storage. Admission,
/// dispatch, action-request, candidate, review, and promotion issuance remain
/// separate protected native operations; this command cannot mint them from a
/// pipe holder's JSON.
pub fn run_serve_governed_v1(args: ServeGovernedV1Args) -> Result<(), String> {
    if args.schema_version != 1 {
        return Err(format!(
            "schema version {} not supported in this build (supported: 1)",
            args.schema_version
        ));
    }
    let run_id = parse_run_id_flag("--run-id", &args.run_id)?;
    let (realm, signing_key, authority) = load_governed_kernel_authority()?;
    let store = open_governed_realm_store(&realm)?;
    let cas = open_governed_realm_cas(&realm)?;
    let signing = SigningConfig::Signed {
        signing_key,
        signer: realm.kernel_signer.clone(),
        checkpoint_policy: bp_ledger::storage::sqlite::CheckpointPolicy::default(),
    };
    let config = GovernedServeProtocolConfigV1 {
        expected_run_id: run_id,
        activity_claim_authority: authority,
    };

    let stdin = io::stdin();
    let locked = stdin.lock();
    let stderr = io::stderr();
    let mut stderr_lock = stderr.lock();
    serve_governed_with_protocol(locked, &mut stderr_lock, &store, &cas, 1, &signing, &config)
        .map_err(|error| format!("serve-governed-v1: {error}"))?;
    stderr_lock.flush().ok();
    Ok(())
}

/// Execute one operation in the deliberately narrow fixed-verifier lane.
///
/// This is not a generic action endpoint: authority, workspace, signer,
/// action identity, and executable behavior are all intentionally absent from
/// its flags. `claim` first proves the target repository still matches the
/// signed dispatch and that the exact action is a reviewer-owned process;
/// `result` resolves the action only through the opaque lease.
pub fn run_governed_verifier_v1(args: GovernedVerifierV1Args) -> Result<(), String> {
    match args {
        GovernedVerifierV1Args::Claim(args) => run_governed_verifier_claim(args),
        GovernedVerifierV1Args::Result(args) => run_governed_verifier_result(args),
    }
}

/// Issue the one native-signed, parented `ModelActionIntentV1` record for a
/// sealed V3 governed implementer action. This is evidence preparation only:
/// it neither grants a provider lease nor starts a model request. Provider
/// authorization remains unavailable until a later native claim/consume path
/// can atomically bind the resulting intent to a host action gateway.
pub fn run_governed_model_intent_v1(args: GovernedModelIntentV1Args) -> Result<(), String> {
    match args {
        GovernedModelIntentV1Args::Issue(args) => run_governed_model_intent_issue(args),
    }
}

fn run_governed_model_intent_issue(args: GovernedModelIntentIssueArgs) -> Result<(), String> {
    let run_id = parse_run_id_flag("--run-id", &args.run_id)?;
    let dispatch_event_id = parse_event_id_flag("--dispatch-event-ref", &args.dispatch_event_ref)?;
    let action_request_event_id =
        parse_event_id_flag("--action-request-event-ref", &args.action_request_event_ref)?;
    let (realm, signing_key, authority) = load_governed_kernel_authority()?;
    let store = open_governed_realm_store(&realm)?;
    let cas = open_governed_realm_cas(&realm)?;
    let disposition = store
        .issue_model_action_intent_v1(
            &ModelActionIntentIssueRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
            },
            &cas,
            &authority,
            &signing_key,
            &realm.kernel_signer,
        )
        .map_err(|error| format!("issue governed model intent: {error}"))?;
    let response = governed_model_intent_issue_response(disposition);
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| format!("serializing governed model intent response: {error}"))?
    );
    Ok(())
}

fn run_governed_verifier_claim(args: GovernedVerifierClaimArgs) -> Result<(), String> {
    let run_id = parse_run_id_flag("--run-id", &args.run_id)?;
    let dispatch_event_id = parse_event_id_flag("--dispatch-event-ref", &args.dispatch_event_ref)?;
    let action_request_event_id =
        parse_event_id_flag("--action-request-event-ref", &args.action_request_event_ref)?;
    let (realm, signing_key, authority) = load_governed_kernel_authority()?;

    // Resolve from the host realm itself before minting a lease. The resolver
    // replays signature-verified tape, enforces V3/atomic/expiry constraints,
    // and checks the current project-root repository binding.
    let (replay_authorities, trusted_kernel_signer) = trusted_kernel_replay_authorities(
        &realm.kernel_signer.actor_id,
        &realm.kernel_signer.key_id,
        &signing_key,
    );
    let resolved = resolve_governed_dispatch_v3_at(
        &ResolveGovernedDispatchV3Args {
            run_id: args.run_id.clone(),
            workspace: realm.ledger_workspace.clone(),
            project_root: args.project_root,
            dispatch_event_ref: args.dispatch_event_ref.clone(),
            kernel_actor_id: realm.kernel_signer.actor_id.clone(),
            kernel_key_id: realm.kernel_signer.key_id.clone(),
        },
        &replay_authorities,
        trusted_kernel_signer,
        Utc::now(),
    )?;
    if resolved
        .dispatch
        .envelope
        .ledger_authority_realm_digest
        .as_deref()
        != Some(realm.realm_digest.as_str())
    {
        return Err(
            "signed governed dispatch does not bind the current protected ledger authority realm"
                .to_string(),
        );
    }
    let action = resolved
        .recovery
        .requests
        .iter()
        .find(|request| request.event_id == action_request_event_id)
        .ok_or_else(|| {
            "--action-request-event-ref was not signature-verified as action evidence for the exact governed dispatch"
                .to_string()
        })?;
    if action.action_kind != ActionKindV1::Process
        || action.execution_role != ExecutionRoleV1::Reviewer
    {
        return Err(
            "governed-verifier-v1 claim requires a signed reviewer process action".to_string(),
        );
    }

    let store = open_governed_realm_store(&realm)?;
    let disposition = store
        .claim_governed_verifier_v1(
            &GovernedVerifierClaimRequestV1 {
                run_id,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms: args.lease_duration_ms,
            },
            &authority,
            &signing_key,
            &realm.kernel_signer,
        )
        .map_err(|error| format!("claim governed verifier activity: {error}"))?;
    let response = governed_verifier_claim_response(disposition);
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| format!("serializing governed verifier claim response: {error}"))?
    );
    Ok(())
}

fn run_governed_verifier_result(args: GovernedVerifierResultArgs) -> Result<(), String> {
    let run_id = parse_run_id_flag("--run-id", &args.run_id)?;
    let (realm, signing_key, authority) = load_governed_kernel_authority()?;
    let store = open_governed_realm_store(&realm)?;
    let disposition = store
        .record_governed_verifier_result_v1(
            &GovernedVerifierResultRequestV1 {
                run_id,
                lease_id: args.lease_id,
                outcome: args.outcome,
                result_digest: args.result_digest,
                result_ref: args.result_ref,
                evidence_digest: args.evidence_digest,
                evidence_ref: args.evidence_ref,
            },
            &authority,
            &signing_key,
            &realm.kernel_signer,
        )
        .map_err(|error| format!("record governed verifier result: {error}"))?;
    let response = governed_verifier_result_response(disposition);
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| format!("serializing governed verifier result response: {error}"))?
    );
    Ok(())
}

fn load_governed_kernel_authority() -> Result<
    (
        GovernedAuthorityRealmV1,
        ed25519_dalek::SigningKey,
        ActivityClaimAuthorityV1,
    ),
    String,
> {
    let realm = load_governed_authority_realm()?;
    let signing_key = load_governed_authority_signing_key(&realm)?;
    let hash = public_key_hash(&signing_key.verifying_key());
    let trusted_signer = full_actor_key_ref(
        &realm.kernel_signer.actor_id,
        &realm.kernel_signer.key_id,
        &hash,
    );
    let mut trusted_keys = TrustedPublicKeys::default();
    trusted_keys.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted_keys,
        trusted_signer.clone(),
        trusted_signer.clone(),
        trusted_signer,
        realm.realm_digest.clone(),
    )
    .map_err(|error| format!("constructing governed kernel authority: {error}"))?;
    Ok((realm, signing_key, authority))
}

fn open_governed_realm_store(realm: &GovernedAuthorityRealmV1) -> Result<SqliteStore, String> {
    let path = realm
        .ledger_workspace
        .join(".buildplane")
        .join("ledger")
        .join("events.db");
    SqliteStore::open(path)
        .map_err(|error| format!("opening protected governed events.db: {error}"))
}

fn open_governed_realm_cas(realm: &GovernedAuthorityRealmV1) -> Result<Cas, String> {
    let path = realm
        .ledger_workspace
        .join(".buildplane")
        .join("ledger")
        .join("objects");
    Cas::open(path).map_err(|error| format!("opening protected governed CAS: {error}"))
}

fn parse_run_id_flag(flag: &str, value: &str) -> Result<bp_ledger::id::RunId, String> {
    uuid::Uuid::parse_str(value)
        .map(bp_ledger::id::RunId::from_uuid)
        .map_err(|error| format!("{flag} must be a UUID: {error}"))
}

fn parse_event_id_flag(flag: &str, value: &str) -> Result<bp_ledger::id::EventId, String> {
    uuid::Uuid::parse_str(value)
        .map(bp_ledger::id::EventId::from_uuid)
        .map_err(|error| format!("{flag} must be a UUID: {error}"))
}

fn governed_verifier_claim_response(
    disposition: ActivityClaimDispositionV1,
) -> GovernedVerifierClaimResponseV1 {
    match disposition {
        ActivityClaimDispositionV1::Granted {
            claim_event_id,
            claim_event_digest,
            lease_id,
            lease_expires_at,
        } => GovernedVerifierClaimResponseV1 {
            schema_version: 1,
            status: "granted".into(),
            claim_event_ref: claim_event_id.to_string(),
            claim_event_digest: Some(claim_event_digest),
            lease_id: Some(lease_id),
            lease_expires_at: Some(lease_expires_at),
            result_event_ref: None,
            result_event_digest: None,
            outcome: None,
        },
        ActivityClaimDispositionV1::Pending {
            claim_event_id,
            lease_expires_at,
        } => GovernedVerifierClaimResponseV1 {
            schema_version: 1,
            status: "pending".into(),
            claim_event_ref: claim_event_id.to_string(),
            claim_event_digest: None,
            lease_id: None,
            lease_expires_at: Some(lease_expires_at),
            result_event_ref: None,
            result_event_digest: None,
            outcome: None,
        },
        ActivityClaimDispositionV1::Recorded {
            claim_event_id,
            result_event_id,
            result_event_digest,
            outcome,
        } => GovernedVerifierClaimResponseV1 {
            schema_version: 1,
            status: "recorded".into(),
            claim_event_ref: claim_event_id.to_string(),
            claim_event_digest: None,
            lease_id: None,
            lease_expires_at: None,
            result_event_ref: Some(result_event_id.to_string()),
            result_event_digest: Some(result_event_digest),
            outcome: Some(activity_result_outcome_wire(outcome).into()),
        },
        ActivityClaimDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => GovernedVerifierClaimResponseV1 {
            schema_version: 1,
            status: "lease_expired".into(),
            claim_event_ref: claim_event_id.to_string(),
            claim_event_digest: None,
            lease_id: None,
            lease_expires_at: Some(lease_expires_at),
            result_event_ref: None,
            result_event_digest: None,
            outcome: None,
        },
    }
}

fn governed_verifier_result_response(
    disposition: ActivityResultDispositionV1,
) -> GovernedVerifierResultResponseV1 {
    match disposition {
        ActivityResultDispositionV1::Recorded {
            result_event_id,
            result_event_digest,
            outcome,
        } => GovernedVerifierResultResponseV1 {
            schema_version: 1,
            status: "recorded".into(),
            claim_event_ref: None,
            result_event_ref: Some(result_event_id.to_string()),
            result_event_digest: Some(result_event_digest),
            outcome: Some(activity_result_outcome_wire(outcome).into()),
            lease_expires_at: None,
        },
        ActivityResultDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => GovernedVerifierResultResponseV1 {
            schema_version: 1,
            status: "lease_expired".into(),
            claim_event_ref: Some(claim_event_id.to_string()),
            result_event_ref: None,
            result_event_digest: None,
            outcome: None,
            lease_expires_at: Some(lease_expires_at),
        },
    }
}

fn governed_model_intent_issue_response(
    disposition: ModelActionIntentIssueDispositionV1,
) -> GovernedModelIntentIssueResponseV1 {
    match disposition {
        ModelActionIntentIssueDispositionV1::Issued {
            intent_event_id,
            intent_digest,
            model_request_evidence,
            trust_scope_evidence,
        } => GovernedModelIntentIssueResponseV1 {
            schema_version: 1,
            status: "issued".into(),
            intent_event_ref: intent_event_id.to_string(),
            intent_digest,
            model_request_evidence,
            trust_scope_evidence,
        },
        ModelActionIntentIssueDispositionV1::Existing {
            intent_event_id,
            intent_digest,
            model_request_evidence,
            trust_scope_evidence,
        } => GovernedModelIntentIssueResponseV1 {
            schema_version: 1,
            status: "existing".into(),
            intent_event_ref: intent_event_id.to_string(),
            intent_digest,
            model_request_evidence,
            trust_scope_evidence,
        },
    }
}

fn activity_result_outcome_wire(outcome: ActivityResultOutcomeV1) -> &'static str {
    match outcome {
        ActivityResultOutcomeV1::Succeeded => "succeeded",
        ActivityResultOutcomeV1::Failed => "failed",
        ActivityResultOutcomeV1::Unknown => "unknown",
    }
}

pub fn run_governed_authority_v1() -> Result<(), String> {
    let realm = load_governed_authority_realm()?;
    let projection = realm.projection()?;
    println!(
        "{}",
        serde_json::to_string(&projection)
            .map_err(|error| format!("serializing governed authority realm: {error}"))?
    );
    Ok(())
}

pub fn run_provision_governed_authority_v1() -> Result<(), String> {
    let realm = provision_governed_authority_realm()?;
    let projection = realm.projection()?;
    println!(
        "{}",
        serde_json::to_string(&projection).map_err(|error| format!(
            "serializing provisioned governed authority realm: {error}"
        ))?
    );
    Ok(())
}

/// Explicitly provision the separately protected reviewer authority and emit
/// only its redacted projection. In particular, the protected keyring path
/// remains inside the native authority boundary.
pub fn run_provision_governed_reviewer_authority_v1() -> Result<(), String> {
    let authority = provision_governed_reviewer_authority()?;
    let projection = authority.projection();
    println!(
        "{}",
        serde_json::to_string(&projection).map_err(|error| format!(
            "serializing provisioned governed reviewer authority: {error}"
        ))?
    );
    Ok(())
}

/// Explicitly provision the separately protected operator authority and emit
/// only its redacted projection. No promotion decision or target mutation is
/// performed by this command.
pub fn run_provision_governed_operator_authority_v1() -> Result<(), String> {
    let authority = provision_governed_operator_authority()?;
    let projection = authority.projection();
    println!(
        "{}",
        serde_json::to_string(&projection).map_err(|error| format!(
            "serializing provisioned governed operator authority: {error}"
        ))?
    );
    Ok(())
}

fn run_serve_with_authority(
    args: ServeArgs,
    signing: SigningConfig,
    activity_claims: ActivityClaimProtocolConfig,
) -> Result<(), String> {
    let ledger_dir = args.workspace.join(".buildplane").join("ledger");
    std::fs::create_dir_all(&ledger_dir).map_err(|e| format!("creating ledger dir: {e}"))?;
    let db_path = ledger_dir.join("events.db");
    let store = SqliteStore::open(&db_path).map_err(|e| format!("opening events.db: {e}"))?;
    let cas = Cas::open(ledger_dir.join("objects")).map_err(|e| format!("opening cas: {e}"))?;

    let stdin = io::stdin();
    let locked = stdin.lock();
    let stderr = io::stderr();
    let mut stderr_lock = stderr.lock();

    match &activity_claims {
        ActivityClaimProtocolConfig::Disabled => {
            // Preserve the legacy/default entry point. Claim controls remain
            // disabled unless the explicit authority flags were accepted.
            serve_with_protocol(locked, &mut stderr_lock, &store, &cas, 1, &signing)
        }
        ActivityClaimProtocolConfig::Signed(_) => serve_with_protocol_with_activity_claims(
            locked,
            &mut stderr_lock,
            &store,
            &cas,
            1,
            &signing,
            &activity_claims,
        ),
    }
    .map_err(|e| format!("serve: {e}"))?;

    stderr_lock.flush().ok();
    Ok(())
}

/// Construct the independent activity-claim authority only after the signing
/// key has been loaded locally. The CLI never accepts public-key bytes or
/// private-key material as flags; all trusted hashes and bytes are derived from
/// the configured signing key in-process.
fn build_activity_claim_protocol_config(
    authority_args: Option<&ActivityClaimAuthorityArgs>,
    signing: &SigningConfig,
) -> Result<ActivityClaimProtocolConfig, String> {
    let Some(authority_args) = authority_args else {
        return Ok(ActivityClaimProtocolConfig::Disabled);
    };
    let SigningConfig::Signed {
        signing_key,
        signer,
        ..
    } = signing
    else {
        return Err("activity claim authority requires signed append configuration".to_string());
    };

    let verifying_key = signing_key.verifying_key();
    let trusted_public_key_hash = public_key_hash(&verifying_key);
    let mut trusted_keys = TrustedPublicKeys::default();
    trusted_keys.insert_public_key(
        trusted_public_key_hash.clone(),
        verifying_key.to_bytes().to_vec(),
    );

    let dispatch_signer = full_actor_key_ref(
        &authority_args.dispatch_actor_id,
        &authority_args.dispatch_key_id,
        &trusted_public_key_hash,
    );
    let action_request_signer = full_actor_key_ref(
        &authority_args.action_request_actor_id,
        &authority_args.action_request_key_id,
        &trusted_public_key_hash,
    );
    let claim_signer =
        full_actor_key_ref(&signer.actor_id, &signer.key_id, &trusted_public_key_hash);
    let authority = ActivityClaimAuthorityV1::new(
        trusted_keys,
        dispatch_signer,
        action_request_signer,
        claim_signer,
    )
    .map_err(|e| format!("configuring activity claim authority: {e}"))?;

    Ok(ActivityClaimProtocolConfig::Signed(authority))
}

fn full_actor_key_ref(actor_id: &str, key_id: &str, public_key_hash: &str) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.to_string(),
        key_id: key_id.to_string(),
        public_key_hash: Some(public_key_hash.to_string()),
    }
}

/// Resolve one signed, governed V3 dispatch into a closed recovery projection.
///
/// This is intentionally separate from `ledger replay`: the ordinary replay
/// command is an inspection tool and opens without trust authority. A caller
/// using this resolver has supplied an exact local kernel key reference. The
/// resolver derives its public key and hash locally, then asks `bp-replay` to
/// verify both signature bytes and kernel-purpose authorization before it
/// projects any governed state.
pub fn run_resolve_governed_dispatch_v3(args: ResolveGovernedDispatchV3Args) -> Result<(), String> {
    let realm = load_governed_authority_realm()?;
    if args.kernel_actor_id != realm.kernel_signer.actor_id
        || args.kernel_key_id != realm.kernel_signer.key_id
    {
        return Err(
            "governed dispatch resolver kernel identity differs from the host-realm-pinned signer"
                .to_string(),
        );
    }
    require_governed_authority_workspace(&args.workspace, &realm.ledger_workspace)?;
    let signing_key = load_governed_authority_signing_key(&realm)?;
    // Keep historical kernel-only tapes replayable even if a later reviewer
    // provision is malformed or incomplete. The preflight is intentionally
    // only a *required-root detector*: it never accepts an event or grants a
    // signer. If a reviewer verdict exists, loading remains strict and replay
    // below independently verifies its signature and purpose. A concurrent
    // reviewer event appended after this scan simply produces an unresolved
    // authority issue and is blocked by `reject_governed_replay_issues`.
    let reviewer_authority = if governed_run_requires_reviewer_authority(&realm, &args.run_id)? {
        Some(load_optional_governed_reviewer_authority()?.ok_or_else(|| {
            "governed reviewer evidence exists but no locally pinned reviewer authority is provisioned"
                .to_string()
        })?)
    } else {
        None
    };
    // Promotion decisions and reconciliation resolutions are a distinct
    // operator trust domain. As with reviews, a preflight only determines
    // whether the locally pinned root is required; trusted replay below still
    // verifies the event bytes, detached signature, signer purpose, and
    // candidate-bound transition before projecting it.
    let operator_authority = if governed_run_requires_operator_authority(&realm, &args.run_id)? {
        Some(load_optional_governed_operator_authority()?.ok_or_else(|| {
            "governed operator evidence exists but no locally pinned operator authority is provisioned"
                .to_string()
        })?)
    } else {
        None
    };
    let reviewer_signing_key = reviewer_authority
        .as_ref()
        .map(load_governed_reviewer_authority_signing_key)
        .transpose()?;
    let operator_signing_key = operator_authority
        .as_ref()
        .map(load_governed_operator_authority_signing_key)
        .transpose()?;
    let (authorities, trusted_kernel_signer) =
        trusted_kernel_reviewer_and_operator_replay_authorities(
            &realm.kernel_signer.actor_id,
            &realm.kernel_signer.key_id,
            &signing_key,
            reviewer_authority
                .as_ref()
                .zip(reviewer_signing_key.as_ref()),
            operator_authority
                .as_ref()
                .zip(operator_signing_key.as_ref()),
        )?;
    let projection =
        resolve_governed_dispatch_v3_at(&args, &authorities, trusted_kernel_signer, Utc::now())?;
    if projection
        .dispatch
        .envelope
        .ledger_authority_realm_digest
        .as_deref()
        != Some(realm.realm_digest.as_str())
    {
        return Err(
            "signed governed dispatch does not bind the current protected ledger authority realm"
                .to_string(),
        );
    }
    let encoded = serde_json::to_string(&projection)
        .map_err(|error| format!("serializing governed dispatch resolution: {error}"))?;
    println!("{encoded}");
    Ok(())
}

fn require_governed_authority_workspace(
    workspace: &Path,
    expected_workspace: &Path,
) -> Result<(), String> {
    let actual = std::fs::canonicalize(workspace)
        .map_err(|error| format!("canonicalizing governed resolver workspace: {error}"))?;
    let expected = std::fs::canonicalize(expected_workspace)
        .map_err(|error| format!("canonicalizing host governed authority workspace: {error}"))?;
    if actual != expected {
        return Err(
			"governed dispatch resolver rejects caller-selected ledger workspaces; use the protected host authority realm"
				.to_string(),
		);
    }
    Ok(())
}

/// Determine whether this exact run has any event kind that the replay engine
/// assigns to the reviewer signing role. This is a conservative preflight for
/// loading the *local* reviewer root, not evidence validation: the subsequent
/// trusted replay still checks every event's schema, signature, signer role,
/// parents, and workflow transition.
///
/// Inspecting raw kind discriminators avoids treating a malformed reviewer
/// event as absent. Unknown or malformed records remain replay errors rather
/// than a source of authority.
fn governed_run_requires_reviewer_authority(
    realm: &GovernedAuthorityRealmV1,
    run_id: &str,
) -> Result<bool, String> {
    let store = open_governed_realm_store(realm)?;
    let events = store.events_for_run(run_id).map_err(|error| {
        format!("reading protected governed run for reviewer authority: {error}")
    })?;
    Ok(events
        .iter()
        .any(|event| event_kind_requires_reviewer_authority(event.kind.as_str())))
}

fn event_kind_requires_reviewer_authority(kind: &str) -> bool {
    matches!(
        kind,
        value if value == EventKind::ReviewVerdictRecorded.as_wire()
            || value == EventKind::ReviewVerdictRecordedV2.as_wire()
    )
}

/// Determine whether this run carries any event kind assigned to the operator
/// role by trusted replay. This remains only a root-requirement detector; it
/// cannot make a promotion decision valid without the full replay pass.
fn governed_run_requires_operator_authority(
    realm: &GovernedAuthorityRealmV1,
    run_id: &str,
) -> Result<bool, String> {
    let store = open_governed_realm_store(realm)?;
    let events = store.events_for_run(run_id).map_err(|error| {
        format!("reading protected governed run for operator authority: {error}")
    })?;
    Ok(events
        .iter()
        .any(|event| event_kind_requires_operator_authority(event.kind.as_str())))
}

fn event_kind_requires_operator_authority(kind: &str) -> bool {
    matches!(
        kind,
        value if value == EventKind::PromotionDecisionRecorded.as_wire()
            || value == EventKind::PromotionReconciliationResolved.as_wire()
    )
}

/// Build the smallest possible replay trust registry: one locally loaded
/// kernel key, authorized only for kernel-owned trust-spine events. There is
/// no tape-driven key discovery and no implicit reviewer/operator authority.
fn trusted_kernel_replay_authorities(
    actor_id: &str,
    key_id: &str,
    signing_key: &ed25519_dalek::SigningKey,
) -> (TrustedReplayAuthorities, ActorKeyRef) {
    let verifying_key = signing_key.verifying_key();
    let hash = public_key_hash(&verifying_key);
    let signer = full_actor_key_ref(actor_id, key_id, &hash);
    let mut trusted_keys = TrustedPublicKeys::default();
    trusted_keys.insert_public_key(hash, verifying_key.to_bytes().to_vec());
    let mut authorities = TrustedReplayAuthorities::new(trusted_keys);
    authorities.allow_signer(TrustSpineSignerRole::Kernel, signer.clone());
    (authorities, signer)
}

/// Construct the exact locally pinned replay authority set for a governed
/// resolver. Reviewer and operator roots are supplied only from protected
/// realm state, never from tape events or CLI flags. Distinct public keys are
/// mandatory across all signer roles so one secret cannot cross-sign review or
/// promotion authority.
fn trusted_kernel_reviewer_and_operator_replay_authorities(
    kernel_actor_id: &str,
    kernel_key_id: &str,
    kernel_signing_key: &ed25519_dalek::SigningKey,
    reviewer: Option<(&GovernedReviewerAuthorityV1, &ed25519_dalek::SigningKey)>,
    operator: Option<(&GovernedOperatorAuthorityV1, &ed25519_dalek::SigningKey)>,
) -> Result<(TrustedReplayAuthorities, ActorKeyRef), String> {
    let kernel_verifying_key = kernel_signing_key.verifying_key();
    let kernel_hash = public_key_hash(&kernel_verifying_key);
    let kernel_signer = full_actor_key_ref(kernel_actor_id, kernel_key_id, &kernel_hash);
    let mut trusted_keys = TrustedPublicKeys::default();
    trusted_keys.insert_public_key(kernel_hash, kernel_verifying_key.to_bytes().to_vec());

    let reviewer_signer = if let Some((authority, signing_key)) = reviewer {
        let verifying_key = signing_key.verifying_key();
        let hash = public_key_hash(&verifying_key);
        if authority.reviewer_signer.public_key_hash.as_deref() != Some(hash.as_str()) {
            return Err(
                "reviewer signing key does not match the protected reviewer authority".to_string(),
            );
        }
        let signer = full_actor_key_ref(
            &authority.reviewer_signer.actor_id,
            &authority.reviewer_signer.key_id,
            &hash,
        );
        trusted_keys.insert_public_key(hash, verifying_key.to_bytes().to_vec());
        Some(signer)
    } else {
        None
    };

    let operator_signer = if let Some((authority, signing_key)) = operator {
        let verifying_key = signing_key.verifying_key();
        let hash = public_key_hash(&verifying_key);
        if authority.operator_signer.public_key_hash.as_deref() != Some(hash.as_str()) {
            return Err(
                "operator signing key does not match the protected operator authority".to_string(),
            );
        }
        let signer = full_actor_key_ref(
            &authority.operator_signer.actor_id,
            &authority.operator_signer.key_id,
            &hash,
        );
        trusted_keys.insert_public_key(hash, verifying_key.to_bytes().to_vec());
        Some(signer)
    } else {
        None
    };

    reject_replay_signer_key_reuse(
        &kernel_signer,
        reviewer_signer.as_ref(),
        operator_signer.as_ref(),
    )?;

    let mut authorities = TrustedReplayAuthorities::new(trusted_keys);
    authorities.allow_signer(TrustSpineSignerRole::Kernel, kernel_signer.clone());
    if let Some(reviewer_signer) = reviewer_signer {
        authorities.allow_signer(TrustSpineSignerRole::Reviewer, reviewer_signer);
    }
    if let Some(operator_signer) = operator_signer {
        authorities.allow_signer(TrustSpineSignerRole::Operator, operator_signer);
    }
    Ok((authorities, kernel_signer))
}

fn reject_replay_signer_key_reuse(
    kernel: &ActorKeyRef,
    reviewer: Option<&ActorKeyRef>,
    operator: Option<&ActorKeyRef>,
) -> Result<(), String> {
    let kernel_hash = kernel
        .public_key_hash
        .as_deref()
        .ok_or_else(|| "kernel replay signer is missing its public key hash".to_string())?;
    if let Some(reviewer) = reviewer {
        let reviewer_hash = reviewer
            .public_key_hash
            .as_deref()
            .ok_or_else(|| "reviewer replay signer is missing its public key hash".to_string())?;
        if reviewer_hash == kernel_hash {
            return Err(
                "reviewer replay signer must use a key distinct from the kernel signer".to_string(),
            );
        }
    }
    if let Some(operator) = operator {
        let operator_hash = operator
            .public_key_hash
            .as_deref()
            .ok_or_else(|| "operator replay signer is missing its public key hash".to_string())?;
        if operator_hash == kernel_hash {
            return Err(
                "operator replay signer must use a key distinct from the kernel signer".to_string(),
            );
        }
        if let Some(reviewer) = reviewer {
            let reviewer_hash = reviewer.public_key_hash.as_deref().ok_or_else(|| {
                "reviewer replay signer is missing its public key hash".to_string()
            })?;
            if operator_hash == reviewer_hash {
                return Err(
                    "operator replay signer must use a key distinct from the reviewer signer"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

/// Pure read-only resolver used by the binary and focused tests. `now` is an
/// explicit input so expiry behavior is deterministic and cannot accidentally
/// use a caller-provided dispatch timestamp as a source of authority.
fn resolve_governed_dispatch_v3_at(
    args: &ResolveGovernedDispatchV3Args,
    authorities: &TrustedReplayAuthorities,
    trusted_kernel_signer: ActorKeyRef,
    now: DateTime<Utc>,
) -> Result<GovernedDispatchResolutionV1, String> {
    let dispatch_event_id = bp_ledger::id::EventId::from_uuid(
        uuid::Uuid::parse_str(&args.dispatch_event_ref)
            .map_err(|error| format!("--dispatch-event-ref must be a UUID: {error}"))?,
    );
    let db_path = args
        .workspace
        .join(".buildplane")
        .join("ledger")
        .join("events.db");
    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &args.run_id,
        &db_path,
        authorities,
        &trusted_kernel_signer,
    )
    .map_err(|error| format!("trusted governed recovery snapshot: {error}"))?;
    let workflow = snapshot
        .workflow_for_dispatch_event_ref(&dispatch_event_id.to_string())
        .cloned()
        .ok_or_else(|| {
            format!(
                "dispatch event {} was not verified and authorized as a governed atomic sealed_v3 workflow by the configured kernel key",
                args.dispatch_event_ref
            )
        })?;

    validate_resolved_governed_dispatch_v3(&workflow, now)?;
    let local_repository_binding_digest = governed_repository_binding_digest(&args.project_root)?;
    if workflow.dispatch.repository_binding_digest.as_deref()
        != Some(local_repository_binding_digest.as_str())
    {
        return Err(
            "signed governed dispatch repository binding does not match the supplied target repository"
                .to_string(),
        );
    }
    Ok(project_governed_dispatch_resolution(
        dispatch_event_id.to_string(),
        trusted_kernel_signer,
        workflow,
        snapshot.tape_integrity().clone(),
    ))
}

/// Ordinary legacy replay records can retain non-fatal diagnostics, but a
/// governed resolver is itself an authority boundary. Any cryptographic,
/// signer-purpose, activity-bracketing, or workflow-transition issue leaves
/// recovery ambiguous and must block before its projection is handed to a
/// gateway or promotion path.
#[cfg(test)]
fn reject_governed_replay_issues(issues: &[ReplayIssue]) -> Result<(), String> {
    let Some(issue) = issues.iter().find(|issue| {
        matches!(
            issue,
            ReplayIssue::ActivityTransitionRejected { .. }
                | ReplayIssue::UnverifiedTrustSpineEvent { .. }
                | ReplayIssue::UnauthorizedTrustSpineSigner { .. }
                | ReplayIssue::WorkflowTransitionRejected { .. }
        )
    }) else {
        return Ok(());
    };
    Err(format!(
        "trusted governed replay has unresolved authority or workflow evidence ({issue:?}); recovery is blocked"
    ))
}

/// Validate the reducer-owned dispatch fields after signature verification.
/// Reducer construction already checked its canonical envelope digest and all
/// closed authority fields; this adds wall-clock liveness, which deliberately
/// is not encoded as a tape transition.
fn validate_resolved_governed_dispatch_v3(
    workflow: &WorkflowInstanceV1,
    now: DateTime<Utc>,
) -> Result<(), String> {
    use bp_ledger::payload::trust_spine::{ActionEvidenceVersionV1, CommitModeV1, TrustTierV1};

    if workflow.dispatch.dispatch_version != 3
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
        || workflow.dispatch.commit_mode != CommitModeV1::Atomic
        || workflow.dispatch.action_evidence_version != Some(ActionEvidenceVersionV1::SealedV3)
        || workflow.dispatch.governed_packet_digest.is_none()
    {
        return Err(
            "verified replay did not produce a governed sealed_v3 atomic V3 dispatch".to_string(),
        );
    }
    let issued_at = parse_rfc3339_utc(&workflow.dispatch.issued_at, "issued_at")?;
    let expires_at = parse_rfc3339_utc(&workflow.dispatch.expires_at, "expires_at")?;
    if now < issued_at {
        return Err("governed dispatch is not active yet".to_string());
    }
    if now >= expires_at {
        return Err("governed dispatch has expired".to_string());
    }
    Ok(())
}

fn parse_rfc3339_utc(value: &str, field: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| format!("verified dispatch {field} is not RFC3339: {error}"))
}

#[derive(Serialize)]
struct RepositoryBindingMaterialV1 {
    schema_version: u8,
    repository_root: String,
    git_common_dir: String,
    object_format: String,
    target_ref: String,
    origin_url_digest: Option<String>,
}

/// Compute the Rust half of the `buildplane.repository-binding.v1` contract.
/// It must stay byte-for-byte aligned with the TypeScript admission helper:
/// the signed tape receives only this digest, never a credential-bearing
/// remote URL or host path in a separate payload field.
fn governed_repository_binding_digest(project_root: &Path) -> Result<String, String> {
    if !project_root.is_absolute() {
        return Err("governed repository binding requires an absolute project root".to_string());
    }
    let requested_root = canonical_git_path(project_root, "requested project root")?;
    let repository_root_raw = git_value(&requested_root, &["rev-parse", "--show-toplevel"])?;
    let repository_root = canonical_git_path(Path::new(&repository_root_raw), "repository root")?;
    if !requested_root.starts_with(&repository_root) {
        return Err(
            "governed repository binding Git top-level is not the supplied project_root or one of its ancestors"
                .to_string(),
        );
    }
    let common_dir_raw = git_value(&repository_root, &["rev-parse", "--git-common-dir"])?;
    let common_dir_candidate = PathBuf::from(&common_dir_raw);
    let common_dir_path = if common_dir_candidate.is_absolute() {
        common_dir_candidate
    } else {
        repository_root.join(common_dir_candidate)
    };
    let git_common_dir = canonical_git_path(&common_dir_path, "git common directory")?;
    let object_format = git_value(&repository_root, &["rev-parse", "--show-object-format"])?;
    if !matches!(object_format.as_str(), "sha1" | "sha256") {
        return Err(format!(
            "governed repository binding rejected unsupported Git object format {object_format:?}"
        ));
    }
    let target_ref = git_value(&repository_root, &["symbolic-ref", "-q", "HEAD"])?;
    if !target_ref.starts_with("refs/heads/") || target_ref.len() <= "refs/heads/".len() {
        return Err(
            "governed repository binding requires an attached local refs/heads branch".to_string(),
        );
    }
    let origin_url_digest =
        match git_optional_value(&repository_root, &["config", "--get", "remote.origin.url"])? {
            Some(origin_url) => Some(sha256_digest(&format!(
                "{ORIGIN_URL_DIGEST_DOMAIN_V1}{origin_url}"
            ))),
            None => None,
        };
    let material = RepositoryBindingMaterialV1 {
        schema_version: 1,
        repository_root: path_to_utf8(&repository_root, "repository root")?,
        git_common_dir: path_to_utf8(&git_common_dir, "git common directory")?,
        object_format,
        target_ref,
        origin_url_digest,
    };
    let canonical = serde_json::to_string(&material)
        .map_err(|error| format!("serializing governed repository binding: {error}"))?;
    Ok(sha256_digest(&format!(
        "{REPOSITORY_BINDING_DOMAIN_V1}{canonical}"
    )))
}

fn canonical_git_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|error| format!("could not canonicalize governed {label}: {error}"))
}

fn path_to_utf8(path: &Path, label: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("governed {label} is not valid UTF-8"))
}

fn git_value(project_root: &Path, args: &[&str]) -> Result<String, String> {
    let output = governed_git_command()?
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
        .map_err(|error| format!("running Git {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "governed repository binding Git query failed ({}): {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    git_output_value(output.stdout, args)
}

fn git_optional_value(project_root: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let output = governed_git_command()?
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
        .map_err(|error| format!("running Git {}: {error}", args.join(" ")))?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(format!(
            "governed repository binding Git query failed ({}): {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    git_output_value(output.stdout, args).map(Some)
}

/// Run Git identity probes with no job/worker-controlled Git environment or
/// PATH lookup. This is deliberately Linux/WSL-only, matching the governed
/// OCI lane; raw commands retain their normal host command discovery.
fn governed_git_command() -> Result<Command, String> {
    if !cfg!(target_os = "linux") {
        return Err(
            "governed repository binding requires Linux/WSL; no host Git fallback is permitted"
                .to_string(),
        );
    }
    let executable = Path::new("/usr/bin/git");
    let canonical = std::fs::canonicalize(executable)
        .map_err(|error| format!("canonicalizing pinned governed Git executable: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("reading pinned governed Git executable metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("pinned governed Git executable is not a regular file".to_string());
    }
    let mut command = Command::new(&canonical);
    command
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("commit.gpgSign=false")
        .arg("-c")
        .arg("gpg.program=false")
        .arg("-c")
        .arg("gpg.ssh.program=false")
        .arg("-c")
        .arg("diff.external=false")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("TZ", "UTC")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    Ok(command)
}

fn git_output_value(output: Vec<u8>, args: &[&str]) -> Result<String, String> {
    let value = String::from_utf8(output).map_err(|_| {
        format!(
            "governed repository binding Git query {} returned non-UTF-8",
            args.join(" ")
        )
    })?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!(
            "governed repository binding Git query {} returned an empty value",
            args.join(" ")
        ));
    }
    Ok(value)
}

fn sha256_digest(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

fn project_governed_dispatch_resolution(
    dispatch_event_ref: String,
    trusted_kernel_signer: ActorKeyRef,
    workflow: WorkflowInstanceV1,
    tape_integrity: TapeIntegrityReportV1,
) -> GovernedDispatchResolutionV1 {
    let recovery = project_governed_dispatch_recovery(&workflow);

    GovernedDispatchResolutionV1 {
        schema_version: 1,
        dispatch_event_ref,
        trusted_kernel_signer,
        dispatch: ResolvedGovernedDispatchV3 {
            run_id: workflow.run_id,
            workflow_id: workflow.workflow_id,
            workflow_revision: workflow.workflow_revision,
            unit_id: workflow.unit_id,
            attempt: workflow.attempt,
            envelope: workflow.dispatch,
        },
        tape_integrity,
        recovery,
    }
}

fn project_governed_dispatch_recovery(workflow: &WorkflowInstanceV1) -> GovernedDispatchRecoveryV1 {
    let action_evidence = workflow.action_evidence.as_ref();
    let mut requests = Vec::new();
    let mut activity_claims = Vec::new();
    let mut receipts = Vec::new();
    if let Some(action_evidence) = action_evidence {
        for action in action_evidence.actions.values() {
            requests.push(action.request.clone());
            if let Some(claim) = &action.activity_claim {
                activity_claims.push(claim.clone());
            }
            if let Some(receipt) = &action.receipt {
                receipts.push(receipt.clone());
            }
        }
    }

    GovernedDispatchRecoveryV1 {
        phase: workflow.phase,
        requests,
        activity_claims,
        receipts,
        receipt_set: action_evidence.and_then(|evidence| evidence.sealed_receipt_set.clone()),
        candidates: workflow.candidate.clone().into_iter().collect(),
        candidate_completion: workflow.candidate_completion.clone(),
        acceptance: workflow.acceptance.clone(),
        reviews: workflow.reviews.values().cloned().collect(),
        promotion_approval: workflow.promotion_approval.clone(),
        promotion: workflow.promotion.clone(),
        terminal: workflow.terminal.clone(),
        timers: workflow.timers.values().cloned().collect(),
        cancellation: workflow.cancellation.clone(),
        pending_action_ids: action_evidence
            .map(|evidence| evidence.pending_action_ids.clone())
            .unwrap_or_default(),
        unknown_action_ids: action_evidence
            .map(|evidence| evidence.unknown_action_ids.clone())
            .unwrap_or_default(),
        failed_action_ids: action_evidence
            .map(|evidence| evidence.failed_action_ids.clone())
            .unwrap_or_default(),
    }
}

/// Execute the `ledger replay` command.
pub fn run_replay(args: ReplayArgs) -> Result<(), String> {
    let db_path = args
        .workspace
        .join(".buildplane")
        .join("ledger")
        .join("events.db");
    let mut engine =
        ReplayEngine::open(&args.run_id, &db_path).map_err(|e| format!("open events.db: {e}"))?;

    if let Some(target) = &args.at {
        let target_id = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str(target).map_err(|e| format!("--at parse: {e}"))?,
        );
        match engine.fast_forward_to(target_id) {
            Some(step) => {
                emit_step(&step, args.format)?;
                return Ok(());
            }
            None => {
                return Err(format!("event {target} not found in run {}", args.run_id));
            }
        }
    }

    let mut count = 0usize;
    let mut printed_lineage_header = false;

    for step in engine.by_ref() {
        if !printed_lineage_header && args.format == ReplayFormat::Human {
            if let (Some(parent), Some(event)) = (
                &step.state_after.parent_run_id,
                &step.state_after.parent_event_id,
            ) {
                println!("forked from {} at {}", parent, event);
            } else if let Some(parent) = &step.state_after.parent_run_id {
                println!("forked from {}", parent);
            }
            printed_lineage_header = true;
        }
        emit_step(&step, args.format)?;
        count += 1;
        if let Some(limit) = args.limit {
            if count >= limit {
                break;
            }
        }
    }

    if args.format == ReplayFormat::Human {
        println!(
            "\nSnapshots: git -C <workspace> log refs/buildplane/run/{}",
            args.run_id
        );
    }

    let issues = &engine.state().issues;
    if !issues.is_empty() {
        eprintln!("{} issues surfaced during replay", issues.len());
        if args.format == ReplayFormat::Human {
            for issue in issues {
                eprintln!("  - {:?}", issue);
            }
        }
    }

    Ok(())
}

/// Execute the `ledger export-signed-tape` command.
///
/// Read-only: opens the run's `events.db`, serializes its signed tape into the
/// `buildplane.signed-tape.v1` envelope, and writes `<out>/tape.json`. The
/// external verifier (`scripts/verify-signed-tape.mjs`) validates the result.
pub fn run_export_signed_tape(args: ExportSignedTapeArgs) -> Result<(), String> {
    let db_path = args
        .workspace
        .join(".buildplane")
        .join("ledger")
        .join("events.db");
    let store = SqliteStore::open(&db_path).map_err(|e| format!("opening events.db: {e}"))?;
    let keyring_root = bp_ledger::keyring::default_keyring_root()
        .map_err(|e| format!("resolving keyring root: {e}"))?;
    let tape = bp_ledger::tape_export::export_signed_tape(&store, &args.run_id, &keyring_root)
        .map_err(|e| format!("exporting signed tape: {e}"))?;

    std::fs::create_dir_all(&args.out).map_err(|e| format!("creating out dir: {e}"))?;
    let out_path = args.out.join("tape.json");
    let mut content =
        serde_json::to_string_pretty(&tape).map_err(|e| format!("serializing tape: {e}"))?;
    content.push('\n');
    std::fs::write(&out_path, content)
        .map_err(|e| format!("writing {}: {e}", out_path.display()))?;
    println!("wrote signed tape to {}", out_path.display());
    Ok(())
}

fn emit_step(step: &bp_replay::engine::ReplayStep, format: ReplayFormat) -> Result<(), String> {
    match format {
        ReplayFormat::Json => {
            let line = serde_json::to_string(step).map_err(|e| format!("json: {e}"))?;
            println!("{}", line);
        }
        ReplayFormat::Human => {
            let depth = step.state_after.parent_chain.len();
            let indent = "  ".repeat(depth.saturating_sub(1));
            let kind = step.event.kind_str();
            let short_id = &step.event.id.to_string()[..8];
            println!(
                "{}{} {}{}",
                indent,
                kind,
                short_id,
                step.state_after
                    .current_unit
                    .as_ref()
                    .map(|u| format!(" unit={}", u))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}

pub fn usage_text() -> String {
    r#"usage: buildplane-native ledger <subcommand>

subcommands:
  serve               Legacy/non-governed ledger ingest loop against stdin (JSONL events).
  serve-governed-v1  Protected run-bound activity control loop; caller events are rejected.
  replay              Replay a run's events with optional fast-forward.
  governed-authority-v1
                      Reserved for an isolated governed authority broker.
  provision-governed-authority-v1
                      Closed bootstrap command; production requires a broker.
  resolve-governed-dispatch-v3
                      Resolve one signed sealed_v3 governed dispatch through local kernel trust.
  governed-verifier-v1
                      Claim or record the fixed read-only reviewer verifier activity.
  governed-model-intent-v1
                      Create immutable evidence for one signed implementer model action.
  provision-governed-reviewer-authority-v1
                       Explicitly provision the separately protected reviewer signer.
  provision-governed-operator-authority-v1
                       Explicitly provision the separately protected operator signer.
  export-signed-tape  Export a run's signed tape (buildplane.signed-tape.v1).

flags for `serve`:
  This is a legacy/non-governed ingest surface. It cannot create a trusted
  governed dispatch, review, or promotion authority record.
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --schema-version <n>      wire schema version (default: 1)
  --sign                    sign each appended event with the configured actor key (default: off)
  --signing-actor-id <id>   legacy signer actor (default: kernel)
  --signing-key-id <id>     key id under the configured actor directory (default: kernel-main)
  --enable-activity-claims  enable signed ActivityClaim V1 controls; requires --sign and all authority identities
  --activity-claim-dispatch-actor-id <id>       trusted dispatch signer actor (required with --enable-activity-claims)
  --activity-claim-dispatch-key-id <id>         trusted dispatch signer key (required with --enable-activity-claims)
  --activity-claim-action-request-actor-id <id> trusted action-request signer actor (required with --enable-activity-claims)
  --activity-claim-action-request-key-id <id>   trusted action-request signer key (required with --enable-activity-claims)

flags for `replay`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --format <json|human>     output format (default: json)
  --limit <n>               stop after n events
  --at <event-id>           fast-forward to event-id, emit state there, exit

flags for `serve-governed-v1`:
  Uses the host-protected authority realm; no workspace, signer, or authority
  flags are accepted. Caller-supplied event lines are rejected. Only closed
  activity claim, heartbeat, and result controls for this exact run may reach
  the signed tape; it does not admit or issue a dispatch/action request.
  --run-id <id>             exact host-bound run identifier (required)
  --schema-version <n>      wire schema version (must be 1)

flags for `resolve-governed-dispatch-v3`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --dispatch-event-ref <id> exact V3 dispatch event UUID (required)
  --kernel-actor-id <id>    explicit locally trusted kernel signer actor (required)
  --kernel-key-id <id>      explicit locally trusted kernel signer key (required)

flags for `governed-verifier-v1 claim`:
  --run-id <id>                     run identifier (required)
  --project-root <path>             absolute target repository root (required)
  --dispatch-event-ref <id>         exact governed V3 dispatch UUID (required)
  --action-request-event-ref <id>   exact signed reviewer process request UUID (required)
  --lease-duration-ms <n>           bounded lease duration (required)

flags for `governed-verifier-v1 result`:
  --run-id <id>                     run identifier (required)
  --lease-id <id>                   opaque lease from a granted claim (required)
  --outcome <succeeded|failed|unknown>
  --result-digest <sha256>          required with succeeded; paired with --result-ref
  --result-ref <ref>                paired with --result-digest
  --evidence-digest <sha256>        verifier evidence digest (required)
  --evidence-ref <ref>              verifier evidence reference (required)

flags for `governed-model-intent-v1 issue`:
  --run-id <id>                     run identifier (required)
  --dispatch-event-ref <id>         exact governed V3 dispatch UUID (required)
  --action-request-event-ref <id>   exact signed implementer model request UUID (required)
                                  No workspace, signer, provider request, or evidence descriptor is accepted.

flags for `governed-authority-v1`:
  No flags are accepted. Production returns GOVERNED_AUTHORITY_BROKER_REQUIRED.

flags for `provision-governed-authority-v1`:
  --confirm                 closed bootstrap syntax; production requires a broker

flags for `provision-governed-reviewer-authority-v1`:
  --confirm                 closed bootstrap syntax; production requires a broker

flags for `provision-governed-operator-authority-v1`:
  --confirm                 closed bootstrap syntax; production requires a broker

flags for `export-signed-tape`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --out <dir>               directory to write tape.json into (required)
"#
    .to_string()
}
