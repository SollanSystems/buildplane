//! Replay state types.

use bp_ledger::id::EventId;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, ActionFailureV1, ActionKindV1, ActionReceiptOutcomeV2,
    ActionReceiptSetEntryV1, ActionRedactionV1, ActionResourceUsageV1, AttemptContextRecordedV1,
    CandidateAcceptanceOutcomeV1, CandidateCompletionRecordedV1, CandidateViewV1, CommitModeV1,
    DispatchBudgetV1, ExecutionRoleV1, ModelActionCandidateBindingV1, ModelRequestEvidenceV1,
    PromotionDecisionKindV1, PromotionExecutionClaimedV1, PromotionExecutionLeaseBindingV1,
    PromotionGitBindingV1, PromotionResultOutcomeV1, ReconciliationResolutionOutcomeV1,
    ReviewDecisionV1, ReviewFindingV1, SignatureRefV1, TrustScopeEvidenceV1, TrustTierV1,
    WorkflowCancellationCauseV1, WorkflowGraphNodeV1, WorkflowGraphNodeV2,
    WorkflowTerminalOutcomeV1, WorkflowTimerKindV1,
};
use bp_ledger::signing::{ActorKeyRef, VerificationStatus};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Accumulated state of a run, rebuilt by the ReplayEngine by applying each
/// event's transition function.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReplayState {
    /// Run id. Set on first run_started event.
    pub run_id: Option<String>,
    /// Parent run id if this is a fork. None for top-level runs.
    pub parent_run_id: Option<String>,
    /// Parent event id (unit_started) this fork branched from. None for top-level runs.
    pub parent_event_id: Option<String>,
    /// Currently-active unit. Set on unit_started; cleared on
    /// unit_completed/unit_failed/unit_cancelled.
    pub current_unit: Option<String>,
    /// Causal chain of parent event ids — events "entered" but not yet "exited".
    pub parent_chain: Vec<EventId>,
    /// Current PlanForge admission-cycle phase reconstructed from signed tape
    /// events. Empty means no PlanForge cycle event has been replayed yet.
    #[serde(default)]
    pub plan_cycle_phase: String,
    /// Last signed `plan_admitted` event observed for this run, if any.
    #[serde(default)]
    pub plan_admission: Option<PlanAdmissionReplayState>,
    /// Activity bracket state keyed by stable per-run `activity_id`. Completed
    /// activities retain their recorded result so recovery code can replay the
    /// result without reinvoking the model/tool/command.
    #[serde(default)]
    pub activities: BTreeMap<String, RecordedActivityState>,
    /// Terminal signed `plan_receipt` state, if emitted.
    #[serde(default)]
    pub plan_receipt: Option<PlanReceiptReplayState>,
    /// Last signed `acceptance_recorded` verdict for this run, if emitted.
    #[serde(default)]
    pub plan_acceptance: Option<PlanAcceptanceReplayState>,
    /// Compatibility projection of the most recently updated trust-spine unit
    /// attempt. Historical snapshots expose this singular field, so it remains
    /// readable while `workflow_instances` below is the canonical multi-unit
    /// projection for new replay.
    #[serde(default)]
    pub workflow_instance: Option<WorkflowInstanceV1>,
    /// Canonical governed workflow projection, keyed by
    /// `(workflow_id, unit_id, attempt)`. A graph may dispatch several units
    /// and retry one unit, so a tape can contain multiple concurrent immutable
    /// candidate transactions under one workflow/run.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workflow_instances: BTreeMap<String, WorkflowInstanceV1>,
    /// Declared workflow topology keyed by `(run_id, workflow_id,
    /// workflow_revision)`. This additive projection remains separate from a
    /// dispatched unit snapshot until a future envelope revision binds a graph
    /// digest into dispatch authority.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workflow_graphs: BTreeMap<String, WorkflowGraphReplayState>,
    /// Graph-bound V2 topology remains deliberately separate from the V1
    /// declaration projection. Only an additive V4 dispatch may consume this
    /// map; V3 history remains readable without graph gating.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workflow_graphs_v2: BTreeMap<String, WorkflowGraphV2ReplayState>,
    /// Immutable retry-lineage contexts keyed by the exact next V3 dispatch
    /// envelope digest. A context projects before its replacement dispatch,
    /// and can never be replaced by a distinct physical event.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attempt_contexts: BTreeMap<String, AttemptContextReplayState>,
    /// Last known content hash per observed file path.
    pub observed_files: BTreeMap<String, FileObservation>,
    /// All git checkpoints reachable from the run.
    pub checkpoints: Vec<CheckpointRef>,
    /// Non-fatal issues surfaced during replay.
    pub issues: Vec<ReplayIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanAdmissionReplayState {
    pub event_id: EventId,
    pub plan_id: String,
    pub plan_digest: String,
    pub input_digest: String,
    pub trusted_base: String,
    pub decided_by: String,
    pub decided_at: String,
    pub idempotency_key: String,
    pub authorized_next_step: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordedActivityState {
    pub run_id: Option<String>,
    pub activity_id: String,
    pub activity_type: Option<String>,
    pub input_digest: Option<String>,
    pub started_event_id: Option<EventId>,
    pub completed_event_id: Option<EventId>,
    pub result_digest: Option<String>,
    pub result: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanAcceptanceReplayState {
    pub event_id: EventId,
    pub plan_id: String,
    pub admission_event_id: String,
    pub contract_digest: String,
    pub outcome: String,
    pub diff_scope_status: String,
    pub out_of_scope_files: Vec<String>,
    pub evaluated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanReceiptReplayState {
    pub event_id: EventId,
    pub plan_id: String,
    pub admission_event_id: EventId,
    pub outcome: String,
    pub side_effects: Vec<String>,
    pub result_digest: String,
    pub decided_at: String,
}

/// Closed reducer-owned phase for the governed trust-spine workflow. The
/// reducer advances this only after every evidence reference in the incoming
/// event matches the immutable candidate it already projected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPhaseV1 {
    Dispatched,
    CandidateCreated,
    AcceptancePassed,
    ReviewApproved,
    /// A kernel-signed, candidate-bound request awaits an operator decision.
    /// The request is evidence only and cannot itself authorize promotion.
    PromotionApprovalPending,
    PromotionPending,
    /// The promotion CAS happened, but either the target no longer contains
    /// the candidate merge or the root checkout remains stale. Both cases
    /// require explicit operator reconciliation before terminalization.
    PromotionReconciliationRequired,
    /// An operator has explicitly abandoned or rejected a target-advanced
    /// promotion. A matching workflow terminal record still closes the run.
    PromotionReconciliationResolved,
    Promoted,
    /// A signed cancellation request blocks further worker/effect advancement
    /// until a bound V2 terminal event records the outcome.
    CancellationRequested,
    Rejected,
    Completed,
    Failed,
    Cancelled,
}

impl WorkflowPhaseV1 {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Rejected | Self::Completed | Self::Failed | Self::Cancelled
        )
    }
}

/// Durable, side-effect-free workflow projection rebuilt from trust-spine tape
/// records. This is deliberately a projection rather than a second authority
/// store: the tape remains canonical and replay simply rejects semantically
/// inconsistent records from advancing the phase.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowInstanceV1 {
    /// Run containing the signed workflow records.
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub phase: WorkflowPhaseV1,
    pub dispatch: WorkflowDispatchReplayState,
    /// Present only for V3 dispatches. The reducer derives this state solely
    /// from write-ahead requests, immutable receipts, and one sealed set so
    /// recovery code can expose pending/unknown effects without rerunning an
    /// action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_evidence: Option<ActionEvidenceReplayState>,
    /// Immutable retry lineage consumed when this governed sealed_v3 workflow
    /// attempt was dispatched. Old snapshots predate this projection field and
    /// deserialize with `None`; new retry actions fail closed until replay
    /// supplies the signed namespace again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_context: Option<AttemptContextReplayState>,
    /// Additive timer projection. Old snapshots deserialize without this field;
    /// timer state is always reconstructed from its signed write-ahead events.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub timers: BTreeMap<String, WorkflowTimerReplayState>,
    /// Additive signed cancellation state. The reducer uses this nonterminal
    /// phase to block new worker/effect advancement before terminalization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancellation: Option<WorkflowCancellationReplayState>,
    #[serde(default)]
    pub candidate: Option<CandidateArtifactReplayState>,
    /// Closed action-to-candidate proof required by governed sealed_v3
    /// candidate lifecycles before acceptance, review, or promotion may
    /// advance. Older snapshots deserialize without it and remain readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_completion: Option<CandidateCompletionReplayState>,
    #[serde(default)]
    pub acceptance: Option<CandidateAcceptanceReplayState>,
    /// Reviews are keyed by their durable `review_ref`; promotion decisions
    /// name an exact subset of these records.
    #[serde(default)]
    pub reviews: BTreeMap<String, ReviewVerdictReplayState>,
    /// Present after the kernel has durably requested an operator decision for
    /// an immutable candidate. Older snapshots deserialize without it.
    #[serde(default)]
    pub promotion_approval: Option<PromotionApprovalRequestReplayState>,
    #[serde(default)]
    pub promotion: Option<PromotionReplayState>,
    #[serde(default)]
    pub terminal: Option<WorkflowTerminalReplayState>,
}

/// Durable topology projection for one workflow revision. It records the
/// first valid declaration and intentionally does not mutate the historical
/// [`WorkflowInstanceV1`] snapshot shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphReplayState {
    pub event_id: EventId,
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub nodes: Vec<WorkflowGraphNodeV1>,
    pub max_concurrent: u32,
    pub graph_digest: String,
    pub idempotency_key: String,
    pub declared_at: String,
}

/// Durable graph-bound topology projection for one workflow revision. This is
/// intentionally a separate type/map from [`WorkflowGraphReplayState`] so a
/// V1 declaration can never be mistaken for V4 dispatch authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphV2ReplayState {
    pub event_id: EventId,
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub nodes: Vec<WorkflowGraphNodeV2>,
    pub max_concurrent: u32,
    pub graph_digest: String,
    pub idempotency_key: String,
    pub declared_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowDispatchReplayState {
    /// V1 snapshots predate the detached V2 body and deserialize as version 1.
    #[serde(default = "default_dispatch_version")]
    pub dispatch_version: u8,
    pub event_id: EventId,
    pub envelope_digest: String,
    pub provenance_ref: String,
    pub base_commit_sha: String,
    /// Present only for V3 dispatches. V1/V2 snapshots remain readable without
    /// a repository-instance authority binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_binding_digest: Option<String>,
    /// Present only for V3 dispatches; binds effects to the protected local
    /// ledger realm rather than a copyable repository workspace tape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger_authority_realm_digest: Option<String>,
    /// Present on sealed_v3 dispatches to bind the exact admitted packet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governed_packet_digest: Option<String>,
    /// Present only on V4 graph-bound dispatches. The declaration identity is
    /// preserved with the graph digest so recovery cannot detach a projected
    /// dispatch from the exact signed topology event that authorized it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_graph_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_graph_declaration_event_ref: Option<EventId>,
    pub capability_bundle_digest: String,
    pub acceptance_contract_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub execution_role: ExecutionRoleV1,
    pub commit_mode: CommitModeV1,
    pub budget: DispatchBudgetV1,
    pub trust_tier: TrustTierV1,
    pub idempotency_key: String,
    pub issued_at: String,
    pub expires_at: String,
    /// V1 carries this inner reference. V2 relies on the verified detached
    /// event signer and deliberately has no circular inner signature field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_ref: Option<SignatureRefV1>,
    /// V3 explicitly selects a sealed action-evidence protocol. V1/V2
    /// snapshots intentionally omit this field and stay replay-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_evidence_version: Option<ActionEvidenceVersionV1>,
}

/// One kernel-recorded retry lineage decision. The key in
/// [`ReplayState::attempt_contexts`] is intentionally the future dispatch
/// envelope digest, so a retry cannot consume a context that named another
/// signed envelope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptContextReplayState {
    pub event_id: EventId,
    pub context: AttemptContextRecordedV1,
}

/// One immutable deadline schedule and its optional exact firing record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTimerReplayState {
    pub event_id: EventId,
    pub event_digest: String,
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub timer_id: String,
    pub timer_kind: WorkflowTimerKindV1,
    pub due_at: String,
    pub idempotency_key: String,
    pub scheduled_by: String,
    pub scheduled_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fired: Option<WorkflowTimerFiredReplayState>,
}

/// Exact immutable firing evidence for a workflow timer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTimerFiredReplayState {
    pub event_id: EventId,
    pub event_digest: String,
    pub timer_schedule_event_ref: EventId,
    pub timer_schedule_event_digest: String,
    pub fired_by: String,
    pub fired_at: String,
}

/// Reducer-owned cancellation request that has not yet terminalized the
/// workflow. Its evidence remains available to bind a V2 terminal record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowCancellationReplayState {
    pub event_id: EventId,
    pub event_digest: String,
    pub cancellation_id: String,
    pub cause: WorkflowCancellationCauseV1,
    pub timer_fired_event_ref: Option<EventId>,
    pub timer_fired_event_digest: Option<String>,
    pub requested_by: String,
    pub idempotency_key: String,
    pub requested_at: String,
}

fn default_dispatch_version() -> u8 {
    1
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateArtifactReplayState {
    pub event_id: EventId,
    pub candidate_id: String,
    pub candidate_ref: String,
    pub candidate_digest: String,
    pub base_commit_sha: String,
    pub candidate_commit_sha: String,
    pub commit_digest: String,
    pub tree_digest: String,
    pub patch_digest: String,
    pub changed_files_digest: String,
    pub envelope_digest: String,
    /// V1 candidate lineage is a single legacy receipt digest. V2 replaces it
    /// with a sealed action-receipt set, so this remains optional for backward
    /// replay only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_receipt_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_receipt_set_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_receipt_set_digest: Option<String>,
}

/// Reducer projection of one closed candidate-completion proof. Keeping the
/// full immutable payload makes later lifecycle gates compare the exact signed
/// lineage instead of relying on a mutable boolean.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCompletionReplayState {
    pub event_id: EventId,
    pub completion: CandidateCompletionRecordedV1,
}

/// V3 action-evidence projection for exactly one workflow unit attempt.
/// `pending_action_ids`, `unknown_action_ids`, and `failed_action_ids` are
/// redundant derived fields kept in the snapshot so a resumed host can make a
/// fail-closed recovery decision without scanning every action itself. A
/// failed activity result is terminal evidence, never a retry permit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionEvidenceReplayState {
    pub action_evidence_version: ActionEvidenceVersionV1,
    #[serde(default)]
    pub actions: BTreeMap<String, ActionReplayState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_receipt_set: Option<ActionReceiptSetReplayState>,
    #[serde(default)]
    pub pending_action_ids: Vec<String>,
    #[serde(default)]
    pub unknown_action_ids: Vec<String>,
    /// Terminal activity/receipt failures. Sealed V3 workflows cannot seal a
    /// candidate while this list is non-empty; notably, these actions are not
    /// also presented as pending retry work.
    #[serde(default)]
    pub failed_action_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReplayState {
    pub request: ActionRequestReplayState,
    /// Kernel-signed intent which binds the exact model/trust/candidate evidence
    /// before a sealed_v3 model authorization may be recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_intent: Option<ModelActionIntentReplayState>,
    /// Native, immutable model authority written after the request and before
    /// a successful provider receipt. Non-model actions deliberately omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_authorization: Option<ModelActionAuthorizationReplayState>,
    /// A native write-ahead lease for this exact V3 action. It is optional so
    /// pre-activity-claim V3 tapes remain replayable; once present, the
    /// terminal activity result is immutable and recovery never grants a
    /// replacement effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_claim: Option<ActivityClaimReplayState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ActionReceiptReplayState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRequestReplayState {
    pub event_id: EventId,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_kind: ActionKindV1,
    pub canonical_input_digest: String,
    pub canonical_input_ref: String,
    pub repository_binding_digest: String,
    pub ledger_authority_realm_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governed_packet_digest: Option<String>,
    pub policy_digest: String,
    pub authority_actor: String,
    pub execution_role: ExecutionRoleV1,
    pub requested_at: String,
    /// Canonical domain-separated digest of the full V2 request payload.
    pub action_request_digest: String,
}

/// Signed native write-ahead reservation for exactly one sealed V3 action.
/// The reducer stores this under the action it binds rather than creating an
/// independent authority cache. A terminal result is never a retry permit:
/// `unknown` remains a durable recovery block until an explicit reconciler
/// resolves external reality.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityClaimReplayState {
    pub event_id: EventId,
    /// Canonical digest of the signed claim event. The terminal result repeats
    /// this exact digest, preventing it from being attached to a substituted
    /// claim event with the same user-controlled identifiers.
    pub claim_event_digest: String,
    pub run_id: String,
    pub activity_id: String,
    pub idempotency_key: String,
    pub action_kind: ActionKindV1,
    pub action_request_event_id: EventId,
    pub action_request_digest: String,
    pub dispatch_event_id: EventId,
    pub dispatch_envelope_digest: String,
    pub authority_actor: String,
    pub lease_id: String,
    pub lease_expires_at: String,
    pub claimed_at: String,
    /// Present when the authoritative ReplayEngine supplied the verified
    /// detached signer. Direct reducer tests intentionally leave it absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<ActorKeyRef>,
    /// Durable forward-only lease extensions. This stays a history rather than
    /// a boolean so recovery can show exactly which signed heartbeat made the
    /// current effective expiry valid. Older snapshots predate heartbeats and
    /// deserialize with an empty collection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heartbeats: Vec<ActivityHeartbeatReplayState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ActivityResultReplayState>,
}

/// One accepted, immutable heartbeat extension for an activity claim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityHeartbeatReplayState {
    pub event_id: EventId,
    /// Canonical digest of the heartbeat event. It prevents a resumed host
    /// from treating presentation-level fields as a replacement heartbeat.
    pub event_digest: String,
    pub run_id: String,
    pub activity_id: String,
    pub idempotency_key: String,
    /// Signed request identity for new governed heartbeats. Historical
    /// heartbeat records predate this binding and remain readable as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_id: Option<String>,
    /// Signed canonical digest of the complete heartbeat request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_request_digest: Option<String>,
    pub claim_event_id: EventId,
    pub claim_event_digest: String,
    pub lease_id: String,
    pub dispatch_event_id: EventId,
    pub dispatch_envelope_digest: String,
    /// Effective expiry immediately before this heartbeat was applied.
    pub prior_lease_expires_at: String,
    /// Effective expiry after this heartbeat was applied.
    pub lease_expires_at: String,
    pub heartbeat_at: String,
}

/// Immutable terminal result for an [`ActivityClaimReplayState`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityResultReplayState {
    pub event_id: EventId,
    /// Canonical hash of the exact signed result event. This is additive so
    /// pre-completion snapshots remain readable; a new completion proof fails
    /// closed until a full replay supplies the value.
    #[serde(default)]
    pub event_digest: String,
    pub run_id: String,
    pub activity_id: String,
    pub idempotency_key: String,
    pub claim_event_id: EventId,
    pub claim_event_digest: String,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
    pub recorded_at: String,
}

/// Replay projection of a native model-action authorization record. It is
/// intentionally full-fidelity rather than a boolean so recovery and audit can
/// prove exactly which dispatch, action request, packet, model input, and
/// candidate view were authorized before a provider effect occurred.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionAuthorizationReplayState {
    pub event_id: EventId,
    /// Signed event time at which this native authorization was recorded.
    ///
    /// V2 sealed-v3 recovery uses this to prove the authorization existed
    /// before the activity claim/result it is asked to classify. `None` keeps
    /// historical snapshots readable; current V2 projection always records it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorized_at: Option<String>,
    /// V1 remains readable for historical tapes. V2 is the sealed_v3 authority
    /// path and is always linked to `intent_event_ref`/`intent_digest`.
    #[serde(default = "default_model_authorization_version")]
    pub authorization_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_event_ref: Option<EventId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_digest: Option<String>,
    pub dispatch_event_ref: String,
    pub dispatch_envelope_digest: String,
    pub action_request_ref: String,
    pub action_request_digest: String,
    pub packet_digest: String,
    pub canonical_input_digest: String,
    pub model_request_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_request_evidence_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_request_evidence_schema_version: Option<u32>,
    pub trust_scope_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_scope_evidence_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_scope_evidence_schema_version: Option<u32>,
    pub context_manifest_digest: String,
    pub policy_digest: String,
    pub sandbox_profile_digest: String,
    pub execution_role: ExecutionRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_view_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_binding: Option<ModelActionCandidateBindingV1>,
    pub authorization_actor: String,
    pub expires_at: String,
    pub authorization_ref: String,
    pub authorization_digest: String,
}

fn default_model_authorization_version() -> u8 {
    1
}

/// Replay projection of the parented kernel model-action intent. This stays
/// separate from authorization so a reader can prove that the authorization
/// did not substitute dynamic evidence after the write-ahead decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionIntentReplayState {
    pub event_id: EventId,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub action_request_event_ref: EventId,
    pub action_request_digest: String,
    pub canonical_input_ref: String,
    pub canonical_input_digest: String,
    pub model_request_evidence: ModelRequestEvidenceV1,
    pub trust_scope_evidence: TrustScopeEvidenceV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_binding: Option<ModelActionCandidateBindingV1>,
    pub intent_actor: String,
    pub intended_at: String,
    pub intent_digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptReplayState {
    pub event_id: EventId,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_request_digest: String,
    pub outcome: ActionReceiptOutcomeV2,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
    pub resource_usage: ActionResourceUsageV1,
    pub redactions: Vec<ActionRedactionV1>,
    pub failure: Option<ActionFailureV1>,
    /// Optional only for historical V2 receipt replay. Governed V3 model
    /// actions require an authorization reference before this state is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_ref: Option<String>,
    pub action_receipt_ref: String,
    /// Canonical domain-separated digest of the full V2 receipt payload.
    pub action_receipt_digest: String,
    pub completed_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptSetReplayState {
    pub event_id: EventId,
    pub action_receipt_set_ref: String,
    pub action_receipt_set_digest: String,
    pub receipts: Vec<ActionReceiptSetEntryV1>,
    pub sealed_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAcceptanceReplayState {
    pub event_id: EventId,
    pub candidate_digest: String,
    pub candidate_commit_sha: String,
    pub acceptance_ref: String,
    /// Exact signed dispatch contract used for these deterministic checks.
    pub acceptance_contract_digest: String,
    pub acceptance_digest: String,
    pub outcome: CandidateAcceptanceOutcomeV1,
    pub evaluated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdictReplayState {
    /// V1 reviews are retained for historical replay. V2 adds candidate,
    /// acceptance, reviewer-dispatch, and sealed-action evidence bindings.
    #[serde(default = "default_review_version")]
    pub review_version: u8,
    pub event_id: EventId,
    pub candidate_digest: String,
    pub candidate_commit_sha: String,
    pub review_ref: String,
    pub decision: ReviewDecisionV1,
    pub findings: Vec<ReviewFindingV1>,
    pub confidence: f64,
    pub reviewer_manifest_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_verdict_action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_request_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_output_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_output_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_contract_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_envelope_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_dispatch_envelope_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_unit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_execution_role: Option<ExecutionRoleV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_set_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_set_digest: Option<String>,
    /// The complete, reconstructible read-only candidate mount bound to a V2
    /// verdict. Older V1 reviews deliberately omit it for tape compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_view: Option<CandidateViewV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_view_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_view_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_authority: Option<String>,
    pub reviewed_at: String,
}

fn default_review_version() -> u8 {
    1
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionReplayState {
    pub decision: PromotionDecisionReplayState,
    /// Immutable write-ahead claim for the one promotion effect. This is
    /// replay evidence only: it cannot issue, renew, or exercise the lease.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_claim: Option<PromotionExecutionClaimReplayState>,
    #[serde(default)]
    pub result: Option<PromotionResultReplayState>,
    #[serde(default)]
    pub reconciliation: Option<PromotionReconciliationReplayState>,
}

/// Immutable replay projection of a kernel-signed promotion execution claim.
/// The nested claim retains the complete tape binding so recovery can reject a
/// result tied to a neighbouring decision, dispatch, or candidate. It is not
/// an issuance capability and exposes no effect operation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionExecutionClaimReplayState {
    pub event_id: EventId,
    /// Canonical hash of the signed claim event, distinct from the claim's
    /// domain-specific payload digest.
    pub event_digest: String,
    pub claim: PromotionExecutionClaimedV1,
}

/// Immutable, kernel-signed operator work item for a reviewed candidate. It
/// is intentionally separate from [`PromotionDecisionReplayState`]: a pending
/// request is observable to recovery but grants no target-branch authority.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionApprovalRequestReplayState {
    pub event_id: EventId,
    pub candidate_digest: String,
    pub base_commit_sha: String,
    pub target_ref: String,
    pub envelope_digest: String,
    pub acceptance_ref: String,
    pub review_refs: Vec<String>,
    pub requested_by: String,
    pub requested_at: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionDecisionReplayState {
    pub event_id: EventId,
    /// Canonical hash of the exact signed decision event. Legacy snapshots did
    /// not retain it, so an absent value remains readable but cannot satisfy a
    /// new recovery query that needs to bind an effect decision to its bytes.
    #[serde(default)]
    pub event_digest: String,
    pub candidate_digest: String,
    pub base_commit_sha: String,
    /// Absent only for a historical unbound promotion decision.
    #[serde(default)]
    pub target_ref: Option<String>,
    pub envelope_digest: String,
    pub acceptance_ref: String,
    pub review_refs: Vec<String>,
    /// Exact kernel-signed request event when this decision resolved a durable
    /// approval work item. Absent only for historical direct decisions.
    #[serde(default)]
    pub promotion_approval_request_ref: Option<String>,
    pub decision: PromotionDecisionKindV1,
    pub authority: String,
    pub decided_by: String,
    pub decided_at: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionResultReplayState {
    pub event_id: EventId,
    /// Canonical hash of the exact signed result event. This prevents a
    /// recovery caller from treating a matching event id as evidence for a
    /// substituted promotion outcome.
    #[serde(default)]
    pub event_digest: String,
    pub candidate_digest: String,
    pub idempotency_key: String,
    pub promotion_decision_ref: String,
    pub outcome: PromotionResultOutcomeV1,
    pub merged_head_sha: Option<String>,
    /// Absent only for a result linked to a historical unbound decision.
    #[serde(default)]
    pub promotion_git_binding: Option<PromotionGitBindingV1>,
    /// Present only for results linked to a new write-ahead claim. Historical
    /// pre-claim results remain readable without this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_execution_lease_binding: Option<PromotionExecutionLeaseBindingV1>,
    pub completed_at: String,
}

/// Immutable projection of the one operator-owned resolution for a
/// `reconciliation_required` promotion result. It deliberately retains the original
/// decision/result/receipt references rather than replacing effect evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionReconciliationReplayState {
    pub event_id: EventId,
    /// Canonical hash of the exact signed reconciliation event. Older replay
    /// snapshots deserialize with an empty value and remain displayable, but
    /// are not sufficient to authorize a new recovery classification.
    #[serde(default)]
    pub event_digest: String,
    pub candidate_digest: String,
    pub promotion_decision_ref: String,
    pub promotion_result_ref: String,
    pub promotion_receipt_ref: String,
    pub outcome: ReconciliationResolutionOutcomeV1,
    pub authority: String,
    pub resolved_by: String,
    pub idempotency_key: String,
    pub resolved_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTerminalReplayState {
    pub event_id: EventId,
    /// V1 terminal snapshots did not carry cancellation evidence. Defaulting to
    /// version 1 preserves their historical replay semantics.
    #[serde(default = "default_terminal_version")]
    pub terminal_version: u8,
    /// Canonical digest of the terminal event. Older snapshots may not have
    /// retained it, but a retry context requires this exact value for new tape.
    #[serde(default)]
    pub event_digest: String,
    #[serde(default)]
    pub unit_id: String,
    #[serde(default)]
    pub attempt: u32,
    pub outcome: WorkflowTerminalOutcomeV1,
    pub candidate_digest: Option<String>,
    pub promotion_result_ref: Option<String>,
    #[serde(default)]
    pub reconciliation_resolution_ref: Option<String>,
    #[serde(default)]
    pub cancellation_request_event_ref: Option<EventId>,
    #[serde(default)]
    pub cancellation_request_event_digest: Option<String>,
    pub reason: Option<String>,
    pub idempotency_key: String,
    pub completed_at: String,
}

fn default_terminal_version() -> u8 {
    1
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileObservation {
    pub last_known_hash: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRef {
    pub boundary: String,
    pub reference: String,
    pub commit_sha: String,
    pub unit_id: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayIssue {
    CheckpointFailed {
        unit_id: String,
        step: String,
        error: String,
    },
    UnreadablePostWrite {
        path: String,
        reason: String,
    },
    /// A governed activity record did not preserve the write-ahead intent /
    /// immutable-result bracket required for crash-safe recovery. Legacy
    /// activity tapes remain readable; this issue is emitted only once a
    /// governed V1 dispatch has been projected for the event's run.
    ActivityTransitionRejected {
        event_id: EventId,
        activity_id: String,
        reason: String,
    },
    DanglingParent {
        event_id: EventId,
        parent_event_id: EventId,
    },
    TargetNotFound {
        requested: String,
    },
    /// A trust-spine V1 record could not be cryptographically verified, so
    /// replay left its governed workflow projection unchanged.
    UnverifiedTrustSpineEvent {
        event_id: EventId,
        event_kind: String,
        verification: VerificationStatus,
    },
    /// A detached signature was cryptographically valid but the exact signer
    /// was not authorized for the event's kernel/reviewer/operator purpose, or
    /// did not bind the authority fields it claimed in the payload.
    UnauthorizedTrustSpineSigner {
        event_id: EventId,
        event_kind: String,
        required_role: String,
        signer_actor_id: Option<String>,
        signer_key_id: Option<String>,
        reason: String,
    },
    /// A trust-spine event was syntactically valid but did not bind to the
    /// workflow/candidate state that had already been reconstructed. Keeping
    /// the tape readable while refusing this transition is safer than allowing
    /// an unrelated candidate or result to advance workflow state.
    WorkflowTransitionRejected {
        event_id: EventId,
        event_kind: String,
        phase: Option<WorkflowPhaseV1>,
        reason: String,
    },
}
