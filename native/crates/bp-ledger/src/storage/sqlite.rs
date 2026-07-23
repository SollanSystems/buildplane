//! SQLite-backed event store — append-only, trigger-enforced.

use crate::canonicalize::{
    canonical_event_hash, canonicalize, canonicalize_payload,
    is_canonical_buildplane_candidate_ref, BUILDPANE_CANDIDATE_REF_PREFIX,
};
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::id::{EventId, RunId};
use crate::kind::EventKind;
use crate::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityHeartbeatRecordedV1,
    ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use crate::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use crate::payload::model_evidence::{
    derive_model_action_scope_constraints_v1, model_request_evidence_document_v1_bytes,
    model_request_evidence_v1_descriptor, parse_verified_canonical_model_action_input_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_trust_scope_evidence_document_v1, trust_scope_evidence_document_v1_bytes,
    trust_scope_evidence_v1_descriptor, validate_model_action_binding_against_replayed_dispatch_v3,
    verify_model_request_evidence_matches_canonical_input,
    verify_trust_scope_evidence_matches_model_request, ModelActionEvidenceBindingV1,
    ModelRequestEvidenceDocumentV1, TrustScopeEvidenceDocumentV1,
};
use crate::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    candidate_completion_recorded_v1_digest, governed_dispatch_policy_digest_v1,
    model_action_authorized_v2_digest, model_action_intent_v1_digest,
    promotion_execution_claimed_v1_digest, ActionEvidenceVersionV1, ActionKindV1,
    ActionReceiptOutcomeV2, ActionReceiptRecordedV2, ActionReceiptSetEntryV1,
    ActionReceiptSetRecordedV1, ActionRequestedV2, CandidateAcceptanceOutcomeV1,
    CandidateAcceptanceRecordedV1, CandidateCompletionRecordedV1, CandidateCreatedV2, CommitModeV1,
    DispatchEnvelopeV3, ExecutionRoleV1, ModelActionAuthorizedV1, ModelActionAuthorizedV2,
    ModelActionIntentV1, ModelRequestEvidenceV1, PromotionApprovalRequestedV1,
    PromotionDecisionKindV1, PromotionDecisionRecordedV1, PromotionExecutionClaimedV1,
    PromotionExecutionLeaseBindingV1, PromotionGitBindingV1, PromotionResultOutcomeV1,
    PromotionResultRecordedV1, PromotionWorktreeSyncStateV1, ReviewDecisionV1,
    ReviewVerdictRecordedV2, TrustScopeEvidenceV1, TrustTierV1,
};
use crate::payload::Payload;
use crate::signing::{
    public_key_hash, sign_event, verify_event_signature, ActorKeyRef, EventSignatureV1,
    SignatureAlgorithm, TrustedPublicKeys, VerificationStatus,
};
use crate::storage::cas::{CanonicalCasRef, Cas};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
#[cfg(any(test, feature = "test-support"))]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

/// Default tape-root checkpoint cadence: emit one checkpoint per 256 signed
/// events per run.
pub const DEFAULT_CHECKPOINT_CADENCE: u64 = 256;

/// Minimum duration for a native execution lease. A shorter lease is too easy
/// to expire before a host has even started the effect and would encourage
/// unsafe retries.
pub const MIN_ACTIVITY_LEASE_MS: u64 = 1_000;

/// Maximum duration for a native execution lease. Long-running work must
/// use bounded signed heartbeats/reconciliation rather than hold an indefinite
/// authority grant.
pub const MAX_ACTIVITY_LEASE_MS: u64 = 15 * 60 * 1_000;

/// Explicit trusted authority required to issue signed activity reservations.
///
/// This is deliberately independent of the append signing configuration. A
/// process that can sign new tape rows does not thereby become trusted to
/// replay a dispatch or mint execution authority. The constructor requires
/// exact signer identities and corresponding public keys; every claim
/// re-verifies the referenced dispatch and action-request signatures.
#[derive(Clone, Debug)]
pub struct ActivityClaimAuthorityV1 {
    trusted_keys: TrustedPublicKeys,
    dispatch_signer: ActorKeyRef,
    action_request_signer: ActorKeyRef,
    claim_signer: ActorKeyRef,
    /// Present only for the governed host-realm server. A generic workspace
    /// tape cannot claim this realm merely by copying its signed payload.
    ledger_authority_realm_digest: Option<String>,
}

impl ActivityClaimAuthorityV1 {
    pub fn new(
        trusted_keys: TrustedPublicKeys,
        dispatch_signer: ActorKeyRef,
        action_request_signer: ActorKeyRef,
        claim_signer: ActorKeyRef,
    ) -> Result<Self> {
        for (label, signer) in [
            ("dispatch_signer", &dispatch_signer),
            ("action_request_signer", &action_request_signer),
            ("claim_signer", &claim_signer),
        ] {
            validate_trusted_actor(label, signer)?;
            if trusted_keys.public_key_for(signer).is_none() {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: format!("{label} does not have a configured trusted public key"),
                });
            }
        }
        Ok(Self {
            trusted_keys,
            dispatch_signer,
            action_request_signer,
            claim_signer,
            ledger_authority_realm_digest: None,
        })
    }

    /// Construct an activity authority bound to a single protected host realm.
    /// The realm digest is independently derived by the native host service and
    /// must be copied exactly into the signed V3 dispatch and write-ahead action.
    pub fn new_governed_realm(
        trusted_keys: TrustedPublicKeys,
        dispatch_signer: ActorKeyRef,
        action_request_signer: ActorKeyRef,
        claim_signer: ActorKeyRef,
        ledger_authority_realm_digest: String,
    ) -> Result<Self> {
        if !is_canonical_sha256_digest(&ledger_authority_realm_digest) {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed activity authority realm digest must be canonical sha256".into(),
            });
        }
        let mut authority = Self::new(
            trusted_keys,
            dispatch_signer,
            action_request_signer,
            claim_signer,
        )?;
        authority.ledger_authority_realm_digest = Some(ledger_authority_realm_digest);
        Ok(authority)
    }
}

/// Distinct, protected identities required to record a governed promotion
/// decision. This object deliberately contains public verification material and
/// signer *identities* only; private keys remain at the broker boundary and are
/// supplied only to the narrow decision/seal operations below.
///
/// A decision is not executable merely because this authority can record it:
/// the operator-signed record remains `awaiting_kernel_checkpoint` until a
/// separately configured kernel identity seals the complete tape prefix. The
/// later Git promotion executor must additionally open a trusted recovery
/// snapshot; it must never treat this projection as target-ref authority.
#[derive(Clone, Debug)]
pub struct GovernedPromotionAuthorityV1 {
    trusted_keys: TrustedPublicKeys,
    kernel_signer: ActorKeyRef,
    reviewer_signers: Vec<ActorKeyRef>,
    operator_signer: ActorKeyRef,
    ledger_authority_realm_digest: String,
}

impl GovernedPromotionAuthorityV1 {
    /// Construct an authority for one protected governed realm. All role
    /// identities must be distinct and backed by configured public keys; an
    /// operator key cannot double as kernel or reviewer authority.
    pub fn new_governed_realm(
        trusted_keys: TrustedPublicKeys,
        kernel_signer: ActorKeyRef,
        reviewer_signers: Vec<ActorKeyRef>,
        operator_signer: ActorKeyRef,
        ledger_authority_realm_digest: String,
    ) -> Result<Self> {
        if !is_canonical_sha256_digest(&ledger_authority_realm_digest) {
            return Err(LedgerError::PromotionAuthorityRejected {
                reason: "governed promotion authority realm digest must be canonical sha256".into(),
            });
        }
        validate_promotion_trusted_actor("kernel_signer", &kernel_signer)?;
        validate_promotion_trusted_actor("operator_signer", &operator_signer)?;
        if reviewer_signers.is_empty() {
            return Err(LedgerError::PromotionAuthorityRejected {
                reason: "governed promotion authority requires at least one reviewer signer".into(),
            });
        }

        let mut identities = BTreeSet::new();
        let mut actors = BTreeSet::new();
        let mut public_key_hashes = BTreeSet::new();
        for (label, signer) in std::iter::once(("kernel_signer", &kernel_signer))
            .chain(
                reviewer_signers
                    .iter()
                    .map(|signer| ("reviewer_signer", signer)),
            )
            .chain(std::iter::once(("operator_signer", &operator_signer)))
        {
            validate_promotion_trusted_actor(label, signer)?;
            if trusted_keys.public_key_for(signer).is_none() {
                return Err(LedgerError::PromotionAuthorityRejected {
                    reason: format!("{label} does not have a configured trusted public key"),
                });
            }
            if !identities.insert(signer_identity_key(signer)) {
                return Err(LedgerError::PromotionAuthorityRejected {
                    reason: "kernel, reviewer, and operator promotion authorities must use distinct signer identities".into(),
                });
            }
            // Different key material for the same actor is rotation, not an
            // independent approval authority. Requiring distinct principals
            // keeps a single compromised identity from both requesting and
            // authorizing a governed promotion.
            if !actors.insert(signer.actor_id.clone()) {
                return Err(LedgerError::PromotionAuthorityRejected {
                    reason: "kernel, reviewer, and operator promotion authorities must use distinct actor identities".into(),
                });
            }
            // TrustedPublicKeys is keyed by public-key hash. Merely assigning
            // that same key different actor/key labels would otherwise let one
            // private key act as kernel, reviewer, and operator.
            let public_key_hash = signer
                .public_key_hash
                .as_ref()
                .expect("validate_promotion_trusted_actor requires a public key hash")
                .clone();
            if !public_key_hashes.insert(public_key_hash) {
                return Err(LedgerError::PromotionAuthorityRejected {
                    reason: "kernel, reviewer, and operator promotion authorities must use distinct public keys".into(),
                });
            }
        }

        Ok(Self {
            trusted_keys,
            kernel_signer,
            reviewer_signers,
            operator_signer,
            ledger_authority_realm_digest,
        })
    }
}

/// Closed native request for a write-ahead activity reservation. All authority
/// evidence is referenced by event id and re-derived from the signed tape;
/// callers never provide an authority assertion or digest to be trusted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityClaimRequestV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    pub dispatch_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Closed native request for a terminal result or safe unknown reconciliation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityResultRequestV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
}

/// Closed native request to extend one existing activity lease. The caller
/// must name the same durable action identity and opaque lease returned by
/// the original claim. `heartbeat_id` is a caller-chosen idempotency key for
/// this one extension; it is never an authority assertion and is checked
/// against the signed durable request digest before a duplicate is replayed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityHeartbeatRequestV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    pub lease_id: String,
    pub heartbeat_id: String,
}

/// Closed claim input for the fixed, read-only governed verifier lane.
///
/// Unlike [`ActivityClaimRequestV1`], this intentionally contains no
/// caller-selected action id or idempotency key. Both are re-derived from the
/// already signed action-request event after the protected realm has verified
/// it. The verifier may only claim a `process` action issued for the signed
/// `reviewer` role; command text and sandbox behavior are outside this
/// storage API and must remain pinned by the host runner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedVerifierClaimRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Closed terminal-result input for the fixed governed verifier lane.
///
/// The opaque lease is the only activity selector exposed to the caller. The
/// storage layer looks up the immutable action identity from its signed claim
/// projection before delegating to the normal exactly-once result transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedVerifierResultRequestV1 {
    pub run_id: RunId,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
}

/// Closed native request to create the signed intent that precedes a governed
/// model authorization. Every identity, role, canonical input, and evidence
/// descriptor is re-derived from signed tape plus the protected realm CAS.
/// Callers cannot supply a model request, trust scope, or evidence descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelActionIntentIssueRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub action_request_event_id: EventId,
}

/// Closed host-private request for the only governed model-effect authority
/// transition. The caller may identify the already-signed dispatch/action and
/// request a bounded lease; every other value (role, action identity, model
/// evidence, authorization reference, expiry, and signer) is reconstructed by
/// the protected native authority transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedModelActionAuthorizeAndClaimRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Closed host-private terminal result for a governed model lease. The caller
/// may name only the opaque lease returned to the original provider gateway;
/// action identity and idempotency are recovered from signed tape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedModelActionResultRequestV1 {
    pub run_id: RunId,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
}

/// Broker-private request to record the one closed candidate-completion proof
/// for an immutable governed candidate. Callers can name only prior tape
/// records; the ledger reconstructs every completion field from verified
/// dispatch, candidate, action, claim, result, receipt, and receipt-set
/// evidence before it signs anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedCandidateCompletionRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub candidate_created_event_id: EventId,
}

/// Broker-private request to record one candidate-bound operator promotion
/// decision. The caller may name immutable tape records and choose only the
/// closed `promote | reject` outcome. Candidate, base, target, acceptance,
/// review references, idempotency key, realm, and signer identities are
/// re-derived from those signed records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedPromotionDecisionRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub candidate_created_event_id: EventId,
    pub candidate_completion_event_id: EventId,
    pub acceptance_event_id: EventId,
    pub review_event_ids: Vec<EventId>,
    pub promotion_approval_request_event_id: EventId,
    pub decision: PromotionDecisionKindV1,
}

/// Broker-private request to seal a previously recorded operator decision with
/// a distinct kernel-signed tape checkpoint. It has no Git fields by design:
/// sealing makes a decision recovery-verifiable, not executable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedPromotionDecisionSealRequestV1 {
    pub run_id: RunId,
    pub promotion_decision_event_id: EventId,
}

/// Broker-private request to reserve the one target-ref effect named by a
/// sealed, target-bound promotion decision. All candidate, dispatch, target,
/// idempotency, and authority facts are reconstructed from the signed tape;
/// callers can identify only the decision and request a bounded lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedPromotionExecutionClaimRequestV1 {
    pub run_id: RunId,
    pub promotion_decision_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Broker-private terminal record for one sealed, candidate-bound promotion
/// decision. The candidate identity, idempotency key, decision reference, and
/// completion timestamp are derived inside the protected ledger operation;
/// callers cannot substitute them after the Git boundary has produced its
/// fixed evidence.
///
/// This is deliberately not a generic ledger control. A future native
/// decision-bound Git gateway is its only intended caller, and it must reopen
/// trusted replay before constructing this closed result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedPromotionResultRequestV1 {
    pub run_id: RunId,
    pub promotion_decision_event_id: EventId,
    pub outcome: PromotionResultOutcomeV1,
    pub merged_head_sha: Option<String>,
    pub promotion_git_binding: Option<PromotionGitBindingV1>,
    /// Required for a result that follows a promotion execution claim. The
    /// ledger verifies all three values against the one immutable claim before
    /// it records a target-effect outcome; callers cannot attach a neighbour's
    /// lease to this decision.
    pub promotion_execution_lease_binding: Option<PromotionExecutionLeaseBindingV1>,
}

/// Result of an idempotent model-intent issue operation. Both variants name
/// the one immutable tape event; a duplicate caller never receives a second
/// signed intent for the same action request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelActionIntentIssueDispositionV1 {
    Issued {
        intent_event_id: EventId,
        intent_digest: String,
        model_request_evidence: ModelRequestEvidenceV1,
        trust_scope_evidence: TrustScopeEvidenceV1,
    },
    Existing {
        intent_event_id: EventId,
        intent_digest: String,
        model_request_evidence: ModelRequestEvidenceV1,
        trust_scope_evidence: TrustScopeEvidenceV1,
    },
}

/// Result of atomically issuing (or resolving) a sealed-V3 model
/// authorization and its one provider lease. A retry never receives the
/// opaque lease token a second time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedModelActionAuthorizeAndClaimDispositionV1 {
    Granted {
        intent_event_id: EventId,
        intent_digest: String,
        authorization_event_id: EventId,
        authorization_event_digest: String,
        authorization_ref: String,
        authorization_digest: String,
        authorization_expires_at: String,
        claim_event_id: EventId,
        claim_event_digest: String,
        lease_id: String,
        lease_expires_at: String,
        model_request_evidence: ModelRequestEvidenceV1,
        trust_scope_evidence: TrustScopeEvidenceV1,
    },
    Pending {
        authorization_event_id: EventId,
        authorization_ref: String,
        claim_event_id: EventId,
        lease_expires_at: String,
    },
    Recorded {
        authorization_event_id: EventId,
        authorization_ref: String,
        claim_event_id: EventId,
        result_event_id: EventId,
        result_event_digest: String,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        authorization_event_id: EventId,
        authorization_ref: String,
        claim_event_id: EventId,
        lease_expires_at: String,
    },
}

/// Result of atomically recording or resolving one candidate-completion proof.
/// The durable projection is keyed by the exact candidate-created event, so a
/// retry can return the same proof after a crash without minting a second
/// completion event or caller-selected timestamp.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedCandidateCompletionDispositionV1 {
    Recorded {
        candidate_completion_event_id: EventId,
        candidate_completion_event_digest: String,
        completion_digest: String,
    },
    Existing {
        candidate_completion_event_id: EventId,
        candidate_completion_event_digest: String,
        completion_digest: String,
    },
}

/// Durable state of an operator promotion decision. `AwaitingKernelSeal`
/// cannot be consumed by an action gateway or Git adapter. `Sealed` means a
/// pinned-kernel checkpoint covered the decision at the time of sealing; a
/// later executor must still reopen trusted recovery before any effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedPromotionDecisionDispositionV1 {
    AwaitingKernelSeal {
        promotion_decision_event_id: EventId,
        promotion_decision_event_digest: String,
        candidate_digest: String,
        idempotency_key: String,
    },
    Sealed {
        promotion_decision_event_id: EventId,
        promotion_decision_event_digest: String,
        candidate_digest: String,
        idempotency_key: String,
        checkpoint_event_id: EventId,
        checkpoint_event_digest: String,
    },
}

/// Result of resolving the one durable write-ahead promotion reservation.
/// Only the first `Granted` response exposes the opaque lease and immutable
/// binding needed by the private fixed-Git gateway. Every duplicate, expired,
/// or completed state withholds it, so it cannot become a second target-ref
/// effect capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedPromotionExecutionClaimDispositionV1 {
    Granted {
        promotion_execution_claim_event_id: EventId,
        promotion_execution_claim_event_digest: String,
        claim: PromotionExecutionClaimedV1,
    },
    Pending {
        promotion_execution_claim_event_id: EventId,
        lease_expires_at: String,
    },
    Recorded {
        promotion_result_event_id: EventId,
        promotion_result_event_digest: String,
        outcome: PromotionResultOutcomeV1,
    },
    LeaseExpired {
        promotion_execution_claim_event_id: EventId,
        lease_expires_at: String,
    },
}

/// Result of recording the terminal evidence for a sealed promotion decision.
/// A duplicate can reuse only the exact immutable result already persisted;
/// it never reopens or reissues the target-ref effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedPromotionResultDispositionV1 {
    Recorded {
        promotion_result_event_id: EventId,
        promotion_result_event_digest: String,
        outcome: PromotionResultOutcomeV1,
    },
    Existing {
        promotion_result_event_id: EventId,
        promotion_result_event_digest: String,
        outcome: PromotionResultOutcomeV1,
    },
}

/// Result of an idempotent activity claim. Only the first request receives a
/// lease token. Replays deliberately receive `Pending` without that token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActivityClaimDispositionV1 {
    Granted {
        claim_event_id: EventId,
        claim_event_digest: String,
        lease_id: String,
        lease_expires_at: String,
    },
    Pending {
        claim_event_id: EventId,
        lease_expires_at: String,
    },
    Recorded {
        claim_event_id: EventId,
        result_event_id: EventId,
        result_event_digest: String,
        outcome: ActivityResultOutcomeV1,
    },
    /// Expiry does not mint a replacement lease. A caller must record an
    /// `Unknown` reconciliation or use a future explicit operator procedure.
    LeaseExpired {
        claim_event_id: EventId,
        lease_expires_at: String,
    },
}

/// Result of recording or reconciling an activity outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActivityResultDispositionV1 {
    Recorded {
        result_event_id: EventId,
        result_event_digest: String,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        claim_event_id: EventId,
        lease_expires_at: String,
    },
}

/// Result of one idempotent activity lease extension.
///
/// An existing heartbeat is returned only when its durable request identity
/// matches exactly. A heartbeat never reclaims an expired lease or converts a
/// terminal activity into a new attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActivityHeartbeatDispositionV1 {
    Recorded {
        heartbeat_event_id: EventId,
        heartbeat_event_digest: String,
        lease_expires_at: String,
    },
    Existing {
        heartbeat_event_id: EventId,
        heartbeat_event_digest: String,
        lease_expires_at: String,
    },
    LeaseExpired {
        claim_event_id: EventId,
        lease_expires_at: String,
    },
}

/// Tape-root checkpoint emission policy for the signed-append path.
///
/// Checkpoints belong to signed mode. A `Disabled` policy (the default for the
/// legacy [`SqliteStore::append_signed`] surface) never emits checkpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointPolicy {
    /// Never emit tape-root checkpoints.
    Disabled,
    /// Emit a checkpoint every `cadence` signed ordinary events per run, and a
    /// final checkpoint at `run_completed` when at least one signed ordinary
    /// event is uncheckpointed since the last checkpoint.
    Enabled { cadence: u64 },
}

impl Default for CheckpointPolicy {
    fn default() -> Self {
        CheckpointPolicy::Enabled {
            cadence: DEFAULT_CHECKPOINT_CADENCE,
        }
    }
}

impl CheckpointPolicy {
    /// Enable checkpoints with an explicit per-run cadence. A cadence of 0 is
    /// treated as 1 (emit on every signed event) to avoid a divide-by-never.
    pub fn every(cadence: u64) -> Self {
        CheckpointPolicy::Enabled {
            cadence: cadence.max(1),
        }
    }
}

/// Result of sealing the full signed ordinary-event prefix for a governed run.
///
/// This is crate-private because only the governed protocol owns the recovery
/// boundary that requires an eagerly sealed prefix. Legacy signed append keeps
/// its independent checkpoint policy, including the `Disabled` mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GovernedCheckpointSealOutcome {
    /// The run has no signed ordinary events, so there is no checkpoint to emit.
    EmptyPrefix,
    /// The latest signed checkpoint already exactly covers the current prefix.
    AlreadySealed { checkpoint_event_id: EventId },
    /// A new internal checkpoint was emitted over the current prefix.
    Emitted { checkpoint_event_id: EventId },
}

/// Fixed schema revision for the non-authoritative workflow replay cache.
///
/// The row schema is shared with `bp-replay`, but this crate intentionally
/// exposes no production cache writer: only a fully verified recovery snapshot
/// may publish it.
pub const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_SCHEMA_VERSION_V1: u32 = 1;

/// The fixed, explicit authority marker retained in every cache row.
pub const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_AUTHORITY_V1: &str = "non_authoritative";

const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_KIND: &str = "workflow_instance_snapshot_cache_v1";
const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_WORKFLOW_JSON_DIGEST_DOMAIN_V1: &[u8] =
    b"buildplane.workflow-instance-snapshot-cache.workflow-json.v1\0";
/// Maximum serialized workflow size accepted by the bounded cache table.
///
/// The `bp-replay` publisher checks this before opening its transaction; the
/// table repeats the limit as a SQLite `CHECK` constraint.
pub const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_MAX_WORKFLOW_JSON_BYTES_V1: usize = 256 * 1024;

/// Maximum number of best-effort workflow snapshots retained in one ledger DB.
///
/// The table trigger below repeats this limit so a direct SQLite write cannot
/// exhaust the authoritative event store by bypassing the replay publisher.
pub const WORKFLOW_INSTANCE_SNAPSHOT_CACHE_MAX_ROWS_V1: usize = 128;

/// Closed authority marker for [`WorkflowInstanceSnapshotCacheEntryV1`].
///
/// Cache data is an observation-only optimization. It is never an effect,
/// replay, recovery, promotion, or authorization capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowInstanceSnapshotCacheAuthorityV1 {
    NonAuthoritative,
}

impl WorkflowInstanceSnapshotCacheAuthorityV1 {
    /// Canonical storage representation for the fixed closed authority marker.
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::NonAuthoritative => WORKFLOW_INSTANCE_SNAPSHOT_CACHE_AUTHORITY_V1,
        }
    }
}

/// A closed, evidence-only workflow cache record emitted by trusted replay.
///
/// Constructing this value grants no ability to persist it in production;
/// `TrustedGovernedRecoverySnapshot` in `bp-replay` owns the only supported
/// publication path after complete signed-tape verification.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowInstanceSnapshotCacheEntryV1 {
    pub authority: WorkflowInstanceSnapshotCacheAuthorityV1,
    pub cache_schema_version: u32,
    pub reducer_schema_version: u32,
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub source_event_count: u64,
    pub source_last_event_id: EventId,
    pub checkpoint_event_ref: EventId,
    pub checkpoint_event_digest: String,
    pub through_event_ref: EventId,
    pub signed_non_checkpoint_event_count: u64,
    pub tape_root_hash: String,
    pub tape_root_algorithm: TapeRootAlgorithm,
    pub pinned_kernel_signer_actor_id: String,
    pub pinned_kernel_signer_key_id: String,
    pub pinned_kernel_signer_public_key_hash: Option<String>,
    pub workflow_json: String,
    pub workflow_json_digest: String,
}

/// Validate canonical workflow JSON and derive its domain-separated digest.
/// This detects cache corruption only; it conveys no authority.
pub fn workflow_instance_snapshot_cache_workflow_json_digest_v1(
    workflow_json: &str,
) -> Result<String> {
    let _ = canonical_workflow_instance_snapshot_cache_json(workflow_json)?;
    let mut hasher = Sha256::new();
    hasher.update(WORKFLOW_INSTANCE_SNAPSHOT_CACHE_WORKFLOW_JSON_DIGEST_DOMAIN_V1);
    hasher.update(workflow_json.as_bytes());
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// Create the bounded V1 workflow-snapshot cache schema on an already-open
/// ledger connection.
///
/// This only creates cache storage; it accepts no cache record and grants no
/// authority. The trusted replay publisher calls it only after it has acquired
/// its write transaction and validated its private replay high-water, so a
/// stale publication cannot initialize cache state before rejection.
pub fn ensure_workflow_instance_snapshot_cache_schema_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        -- Mutable replay optimization only. This table intentionally has
        -- NO append-only triggers and never participates in an authority
        -- or effect path: every governed decision must still reopen a live
        -- trusted replay over the signed event tape.
        CREATE TABLE IF NOT EXISTS workflow_instance_snapshot_cache_v1 (
            authority                              TEXT NOT NULL CHECK(authority = 'non_authoritative'),
            cache_schema_version                   INTEGER NOT NULL CHECK(cache_schema_version = 1),
            -- V1 deliberately admits only the V1 reducer. A future reducer
            -- requires a new bounded cache table or an explicit migration;
            -- silently widening this cache would blur historical projection
            -- semantics.
            reducer_schema_version                 INTEGER NOT NULL CHECK(reducer_schema_version = 1),
            run_id                                 TEXT NOT NULL,
            dispatch_event_id                      TEXT NOT NULL,
            workflow_id                            TEXT NOT NULL,
            workflow_revision                      TEXT NOT NULL,
            unit_id                                TEXT NOT NULL,
            attempt                                INTEGER NOT NULL CHECK(attempt > 0),
            source_event_count                     INTEGER NOT NULL CHECK(source_event_count > 0),
            source_last_event_id                   TEXT NOT NULL,
            checkpoint_event_ref                   TEXT NOT NULL,
            checkpoint_event_digest                TEXT NOT NULL,
            through_event_ref                      TEXT NOT NULL,
            signed_non_checkpoint_event_count      INTEGER NOT NULL CHECK(signed_non_checkpoint_event_count > 0),
            tape_root_hash                          TEXT NOT NULL,
            tape_root_algorithm                    TEXT NOT NULL CHECK(tape_root_algorithm = 'sha256_linear'),
            pinned_kernel_signer_actor_id          TEXT NOT NULL,
            pinned_kernel_signer_key_id            TEXT NOT NULL,
            pinned_kernel_signer_public_key_hash   TEXT,
            workflow_json                          TEXT NOT NULL CHECK(length(CAST(workflow_json AS BLOB)) <= 262144),
            workflow_json_digest                   TEXT NOT NULL,
            PRIMARY KEY (run_id, dispatch_event_id, reducer_schema_version),
            FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
            FOREIGN KEY(source_last_event_id) REFERENCES events(id),
            FOREIGN KEY(checkpoint_event_ref) REFERENCES events(id),
            FOREIGN KEY(through_event_ref) REFERENCES events(id)
        );

        -- The cache shares the authoritative ledger database, so retain a
        -- small bounded working set even if another local process writes
        -- directly to SQLite. Newer verified replay replaces an existing
        -- key instead of consuming an additional row.
        CREATE TRIGGER IF NOT EXISTS workflow_instance_snapshot_cache_v1_row_cap
            BEFORE INSERT ON workflow_instance_snapshot_cache_v1
            WHEN (SELECT COUNT(*) FROM workflow_instance_snapshot_cache_v1) >= 128
             AND NOT EXISTS (
                SELECT 1
                FROM workflow_instance_snapshot_cache_v1
                WHERE run_id = NEW.run_id
                  AND dispatch_event_id = NEW.dispatch_event_id
                  AND reducer_schema_version = NEW.reducer_schema_version
             )
        BEGIN
            SELECT RAISE(ABORT, 'workflow snapshot cache capacity exceeded');
        END;
        "#,
    )?;
    Ok(())
}

/// SQLite connection wrapping the events + runs schema.
pub struct SqliteStore {
    conn: Connection,
    /// Per-run high-water mark of the latest NON-checkpoint event id, used by
    /// the monotonic-id guard so it never has to issue a per-append `SELECT`.
    ///
    /// Lazily seeded from the DB the first time a run is touched (one query per
    /// run, via [`Self::latest_ordinary_event_id_for_run`]), then advanced
    /// in-process on every successful ordinary append. This is the O(1) replacement
    /// for a per-event ordinary-id lookup, sound under buildplane's M1
    /// single-writer model (see [`Self::validate_external_append`]). Checkpoint
    /// ids deliberately never advance the mark — checkpoints are minted after the
    /// events they cover and must not constrain the ordinary sequence.
    ///
    /// `RefCell` because the public append entry points take `&self`; the
    /// single-writer model means there is never a concurrent borrow.
    ordinary_id_high_water: RefCell<HashMap<RunId, EventId>>,
    /// Test-only one-shot fault injector for the checkpoint signature insert.
    /// Compiled in only under `cfg(test)` or the `test-support` feature, so it
    /// is wholly absent from default/release builds; armed only by the
    /// `*_for_tests` helper, read only by the `emit_checkpoint` test-fault
    /// branch.
    #[cfg(any(test, feature = "test-support"))]
    fail_next_checkpoint_signature_insert: Cell<bool>,
}

impl SqliteStore {
    /// Open or create a ledger database at `path`. Creates tables and the
    /// append-only trigger on first open.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(&conn)?;
        Ok(Self {
            conn,
            ordinary_id_high_water: RefCell::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            fail_next_checkpoint_signature_insert: Cell::new(false),
        })
    }

    /// Open an in-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self {
            conn,
            ordinary_id_high_water: RefCell::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            fail_next_checkpoint_signature_insert: Cell::new(false),
        })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS events (
                id               TEXT PRIMARY KEY,
                run_id           TEXT NOT NULL,
                parent_event_id  TEXT,
                schema_version   INTEGER NOT NULL,
                kind             TEXT NOT NULL,
                occurred_at      TEXT NOT NULL,
                payload          TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
            CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);

            CREATE TRIGGER IF NOT EXISTS events_no_update
                BEFORE UPDATE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS events_no_delete
                BEFORE DELETE ON events
                BEGIN
                    SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden');
                END;

            CREATE TABLE IF NOT EXISTS event_signatures (
                event_id              TEXT PRIMARY KEY,
                canonical_event_hash  TEXT NOT NULL,
                actor_id              TEXT NOT NULL,
                key_id                TEXT NOT NULL,
                public_key_hash       TEXT,
                algorithm             TEXT NOT NULL,
                signature             TEXT NOT NULL,
                signed_at             TEXT NOT NULL,
                FOREIGN KEY(event_id) REFERENCES events(id)
            );

            CREATE TRIGGER IF NOT EXISTS event_signatures_no_update
                BEFORE UPDATE ON event_signatures
                BEGIN
                    SELECT RAISE(ABORT, 'event_signatures is append-only: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS event_signatures_no_delete
                BEFORE DELETE ON event_signatures
                BEGIN
                    SELECT RAISE(ABORT, 'event_signatures is append-only: DELETE forbidden');
                END;

            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                started_at       TEXT NOT NULL,
                completed_at     TEXT,
                outcome          TEXT,
                workspace_path   TEXT NOT NULL,
                packet_hash      TEXT NOT NULL,
                schema_version   INTEGER NOT NULL
            );

            -- Projection/cache for signed ActivityClaimedV1 and
            -- ActivityResultRecordedV1 tape records. The primary key makes an
            -- idempotency key a durable, cross-process execution reservation.
            CREATE TABLE IF NOT EXISTS activity_claims (
                run_id                    TEXT NOT NULL,
                idempotency_key           TEXT NOT NULL,
                activity_id               TEXT NOT NULL,
                action_kind               TEXT NOT NULL,
                action_request_event_id   TEXT NOT NULL,
                action_request_digest     TEXT NOT NULL,
                dispatch_event_id         TEXT NOT NULL,
                dispatch_envelope_digest  TEXT NOT NULL,
                authority_actor           TEXT NOT NULL,
                claim_event_id            TEXT NOT NULL UNIQUE,
                claim_event_digest        TEXT NOT NULL,
                lease_id                  TEXT NOT NULL,
                lease_expires_at          TEXT NOT NULL,
                lease_duration_ms         INTEGER NOT NULL,
                state                     TEXT NOT NULL CHECK(state IN ('granted', 'recorded')),
                result_event_id           TEXT,
                result_event_digest       TEXT,
                result_outcome            TEXT,
                result_digest             TEXT,
                result_ref                TEXT,
                evidence_digest           TEXT,
                evidence_ref              TEXT,
                created_at                TEXT NOT NULL,
                recorded_at               TEXT,
                PRIMARY KEY (run_id, idempotency_key),
                UNIQUE (run_id, activity_id),
                FOREIGN KEY(claim_event_id) REFERENCES events(id),
                FOREIGN KEY(result_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_activity_claims_state
                ON activity_claims(run_id, state);

            CREATE TRIGGER IF NOT EXISTS activity_claims_no_delete
                BEFORE DELETE ON activity_claims
                BEGIN
                    SELECT RAISE(ABORT, 'activity_claims are tape-backed: DELETE forbidden');
                END;

            -- The projection may advance exactly once, from a signed grant to
            -- a signed terminal result. It can never regress or be edited
            -- after reconciliation.
            CREATE TRIGGER IF NOT EXISTS activity_claims_terminal_only
                BEFORE UPDATE ON activity_claims
                WHEN OLD.state != 'granted'
                  OR NEW.state != 'recorded'
                  OR OLD.run_id != NEW.run_id
                  OR OLD.idempotency_key != NEW.idempotency_key
                  OR OLD.activity_id != NEW.activity_id
                  OR OLD.action_kind != NEW.action_kind
                  OR OLD.action_request_event_id != NEW.action_request_event_id
                  OR OLD.action_request_digest != NEW.action_request_digest
                  OR OLD.dispatch_event_id != NEW.dispatch_event_id
                  OR OLD.dispatch_envelope_digest != NEW.dispatch_envelope_digest
                  OR OLD.authority_actor != NEW.authority_actor
                  OR OLD.claim_event_id != NEW.claim_event_id
                  OR OLD.claim_event_digest != NEW.claim_event_digest
                  OR OLD.lease_id != NEW.lease_id
                  OR OLD.lease_expires_at != NEW.lease_expires_at
                  OR OLD.lease_duration_ms != NEW.lease_duration_ms
                  OR OLD.created_at != NEW.created_at
                BEGIN
                    SELECT RAISE(ABORT, 'activity_claims permit only one terminal record');
                END;

            -- Append-only projection/cache for signed activity lease
            -- heartbeats. The original activity_claims row retains its
            -- immutable claim expiry; recovery derives the effective expiry
            -- by verifying this signed heartbeat history against the tape.
            -- `heartbeat_id` and `request_digest` are cache indexes for the
            -- same signed heartbeat payload fields. The signed event, not
            -- this projection, binds an extension to its exact request.
            CREATE TABLE IF NOT EXISTS activity_claim_heartbeats (
                run_id                     TEXT NOT NULL,
                heartbeat_id               TEXT NOT NULL,
                request_digest             TEXT NOT NULL,
                claim_event_id             TEXT NOT NULL,
                claim_event_digest         TEXT NOT NULL,
                activity_id                TEXT NOT NULL,
                idempotency_key            TEXT NOT NULL,
                lease_id                   TEXT NOT NULL,
                dispatch_event_id          TEXT NOT NULL,
                dispatch_envelope_digest   TEXT NOT NULL,
                heartbeat_event_id         TEXT NOT NULL UNIQUE,
                heartbeat_event_digest     TEXT NOT NULL,
                prior_lease_expires_at     TEXT NOT NULL,
                lease_expires_at           TEXT NOT NULL,
                heartbeat_at               TEXT NOT NULL,
                PRIMARY KEY (run_id, heartbeat_id),
                FOREIGN KEY(claim_event_id) REFERENCES events(id),
                FOREIGN KEY(heartbeat_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_activity_claim_heartbeats_claim
                ON activity_claim_heartbeats(run_id, claim_event_id, heartbeat_at);

            CREATE TRIGGER IF NOT EXISTS activity_claim_heartbeats_no_update
                BEFORE UPDATE ON activity_claim_heartbeats
                BEGIN
                    SELECT RAISE(ABORT, 'activity claim heartbeats are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS activity_claim_heartbeats_no_delete
                BEFORE DELETE ON activity_claim_heartbeats
                BEGIN
                    SELECT RAISE(ABORT, 'activity claim heartbeats are tape-backed: DELETE forbidden');
                END;

            -- Projection/cache for native-issued ModelActionIntentV1 records.
            -- The action-request event is the idempotency boundary: a model
            -- request may have exactly one kernel-signed intent, and an
            -- existing row is re-verified against the immutable tape before
            -- an idempotent result is returned.
            CREATE TABLE IF NOT EXISTS model_action_intents (
                run_id                         TEXT NOT NULL,
                action_request_event_id        TEXT NOT NULL,
                dispatch_event_id              TEXT NOT NULL,
                action_request_digest          TEXT NOT NULL,
                model_request_evidence_digest  TEXT NOT NULL,
                trust_scope_evidence_digest    TEXT NOT NULL,
                intent_event_id                TEXT NOT NULL UNIQUE,
                intent_digest                  TEXT NOT NULL,
                created_at                     TEXT NOT NULL,
                PRIMARY KEY (run_id, action_request_event_id),
                FOREIGN KEY(intent_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_model_action_intents_run_id
                ON model_action_intents(run_id);

            CREATE TRIGGER IF NOT EXISTS model_action_intents_no_update
                BEFORE UPDATE ON model_action_intents
                BEGIN
                    SELECT RAISE(ABORT, 'model_action_intents are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS model_action_intents_no_delete
                BEFORE DELETE ON model_action_intents
                BEGIN
                    SELECT RAISE(ABORT, 'model_action_intents are tape-backed: DELETE forbidden');
                END;

            -- Projection/cache for the sealed-V3 native model authorization.
            -- It records the one V2 authorization and the one resulting
            -- activity claim as a single recoverable authority boundary. The
            -- signed events remain authoritative; every read re-verifies
            -- their signatures and exact bindings before returning a retry
            -- disposition.
            CREATE TABLE IF NOT EXISTS model_action_authorizations (
                run_id                         TEXT NOT NULL,
                action_request_event_id        TEXT NOT NULL,
                dispatch_event_id              TEXT NOT NULL,
                action_request_digest          TEXT NOT NULL,
                intent_event_id                TEXT NOT NULL UNIQUE,
                intent_digest                  TEXT NOT NULL,
                authorization_event_id         TEXT NOT NULL UNIQUE,
                authorization_event_digest     TEXT NOT NULL,
                authorization_ref              TEXT NOT NULL UNIQUE,
                authorization_digest           TEXT NOT NULL,
                authorization_expires_at       TEXT NOT NULL,
                claim_event_id                 TEXT NOT NULL UNIQUE,
                created_at                     TEXT NOT NULL,
                PRIMARY KEY (run_id, action_request_event_id),
                FOREIGN KEY(intent_event_id) REFERENCES events(id),
                FOREIGN KEY(authorization_event_id) REFERENCES events(id),
                FOREIGN KEY(claim_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_model_action_authorizations_run_id
                ON model_action_authorizations(run_id);

            CREATE TRIGGER IF NOT EXISTS model_action_authorizations_no_update
                BEFORE UPDATE ON model_action_authorizations
                BEGIN
                    SELECT RAISE(ABORT, 'model_action_authorizations are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS model_action_authorizations_no_delete
                BEFORE DELETE ON model_action_authorizations
                BEGIN
                    SELECT RAISE(ABORT, 'model_action_authorizations are tape-backed: DELETE forbidden');
                END;

            -- Broker-private, immutable projection for one closed candidate
            -- materialization proof. The signed completion event remains the
            -- authority; this row makes `(run_id, candidate_created_event_id)`
            -- a durable cross-process idempotency boundary. The row stores
            -- every re-derived lineage reference so retry reads can detect a
            -- missing, substituted, or corrupted tape proof before returning
            -- an Existing disposition.
            CREATE TABLE IF NOT EXISTS governed_candidate_completions (
                run_id                              TEXT NOT NULL,
                dispatch_event_id                   TEXT NOT NULL,
                candidate_created_event_id          TEXT NOT NULL,
                candidate_digest                    TEXT NOT NULL,
                candidate_create_action_id          TEXT NOT NULL,
                action_request_event_id             TEXT NOT NULL,
                action_request_digest               TEXT NOT NULL,
                activity_claim_event_id             TEXT NOT NULL,
                activity_claim_event_digest         TEXT NOT NULL,
                activity_result_event_id            TEXT NOT NULL,
                activity_result_event_digest        TEXT NOT NULL,
                action_receipt_ref                  TEXT NOT NULL,
                action_receipt_digest               TEXT NOT NULL,
                candidate_completion_event_id       TEXT NOT NULL UNIQUE,
                candidate_completion_event_digest   TEXT NOT NULL,
                completion_digest                   TEXT NOT NULL,
                completed_at                        TEXT NOT NULL,
                PRIMARY KEY (run_id, candidate_created_event_id),
                FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(candidate_created_event_id) REFERENCES events(id),
                FOREIGN KEY(action_request_event_id) REFERENCES events(id),
                FOREIGN KEY(activity_claim_event_id) REFERENCES events(id),
                FOREIGN KEY(activity_result_event_id) REFERENCES events(id),
                FOREIGN KEY(candidate_completion_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_governed_candidate_completions_digest
                ON governed_candidate_completions(run_id, candidate_digest);

            CREATE TRIGGER IF NOT EXISTS governed_candidate_completions_no_update
                BEFORE UPDATE ON governed_candidate_completions
                BEGIN
                    SELECT RAISE(ABORT, 'governed candidate completions are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_candidate_completions_no_delete
                BEFORE DELETE ON governed_candidate_completions
                BEGIN
                    SELECT RAISE(ABORT, 'governed candidate completions are tape-backed: DELETE forbidden');
                END;

            -- Broker-private projection for one operator promotion decision.
            -- It is intentionally separate from any Git effect receipt: the
            -- first state is merely write-ahead evidence and cannot authorize a
            -- target-ref mutation until a distinct kernel checkpoint seals the
            -- complete signed prefix. The signed decision event remains the
            -- source of truth; this table makes duplicate delivery and crash
            -- reconciliation explicit without allowing rows to be edited.
            CREATE TABLE IF NOT EXISTS governed_promotion_decisions (
                run_id                              TEXT NOT NULL,
                candidate_digest                    TEXT NOT NULL,
                idempotency_key                     TEXT NOT NULL,
                decision_request_digest             TEXT NOT NULL,
                dispatch_event_id                   TEXT NOT NULL,
                candidate_created_event_id          TEXT NOT NULL,
                candidate_completion_event_id       TEXT NOT NULL,
                acceptance_event_id                 TEXT NOT NULL,
                review_event_ids_json               TEXT NOT NULL,
                promotion_approval_request_event_id TEXT NOT NULL,
                decision_kind                       TEXT NOT NULL CHECK(decision_kind IN ('promote', 'reject')),
                promotion_decision_event_id         TEXT NOT NULL UNIQUE,
                promotion_decision_event_digest     TEXT NOT NULL,
                state                               TEXT NOT NULL CHECK(state IN ('awaiting_kernel_checkpoint', 'sealed')),
                sealed_checkpoint_event_id          TEXT,
                sealed_checkpoint_event_digest      TEXT,
                created_at                          TEXT NOT NULL,
                sealed_at                           TEXT,
                PRIMARY KEY (run_id, candidate_digest),
                UNIQUE (run_id, idempotency_key),
                FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(candidate_created_event_id) REFERENCES events(id),
                FOREIGN KEY(candidate_completion_event_id) REFERENCES events(id),
                FOREIGN KEY(acceptance_event_id) REFERENCES events(id),
                FOREIGN KEY(promotion_approval_request_event_id) REFERENCES events(id),
                FOREIGN KEY(promotion_decision_event_id) REFERENCES events(id),
                FOREIGN KEY(sealed_checkpoint_event_id) REFERENCES events(id),
                CHECK(
                    (state = 'awaiting_kernel_checkpoint'
                        AND sealed_checkpoint_event_id IS NULL
                        AND sealed_checkpoint_event_digest IS NULL
                        AND sealed_at IS NULL)
                    OR
                    (state = 'sealed'
                        AND sealed_checkpoint_event_id IS NOT NULL
                        AND sealed_checkpoint_event_digest IS NOT NULL
                        AND sealed_at IS NOT NULL)
                )
            );

            CREATE INDEX IF NOT EXISTS idx_governed_promotion_decisions_state
                ON governed_promotion_decisions(run_id, state);

            CREATE TRIGGER IF NOT EXISTS governed_promotion_decisions_no_delete
                BEFORE DELETE ON governed_promotion_decisions
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion decisions are tape-backed: DELETE forbidden');
                END;

            -- A decision projection may advance once, from a durable operator
            -- decision awaiting a kernel seal to the exact checkpoint that
            -- covers it. All decision identity and evidence fields remain
            -- immutable across that transition.
            CREATE TRIGGER IF NOT EXISTS governed_promotion_decisions_seal_only
                BEFORE UPDATE ON governed_promotion_decisions
                WHEN OLD.state != 'awaiting_kernel_checkpoint'
                  OR NEW.state != 'sealed'
                  OR OLD.run_id != NEW.run_id
                  OR OLD.candidate_digest != NEW.candidate_digest
                  OR OLD.idempotency_key != NEW.idempotency_key
                  OR OLD.decision_request_digest != NEW.decision_request_digest
                  OR OLD.dispatch_event_id != NEW.dispatch_event_id
                  OR OLD.candidate_created_event_id != NEW.candidate_created_event_id
                  OR OLD.candidate_completion_event_id != NEW.candidate_completion_event_id
                  OR OLD.acceptance_event_id != NEW.acceptance_event_id
                  OR OLD.review_event_ids_json != NEW.review_event_ids_json
                  OR OLD.promotion_approval_request_event_id != NEW.promotion_approval_request_event_id
                  OR OLD.decision_kind != NEW.decision_kind
                  OR OLD.promotion_decision_event_id != NEW.promotion_decision_event_id
                  OR OLD.promotion_decision_event_digest != NEW.promotion_decision_event_digest
                  OR OLD.created_at != NEW.created_at
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion decisions permit only one kernel-seal transition');
                END;

            -- Broker-private write-ahead reservation for the one Git effect
            -- named by a sealed, target-bound promotion decision. This is a
            -- durable immutable claim, not an execution capability: callers
            -- receive its opaque lease only from the protected native claim
            -- transition, and terminal results must repeat the exact signed
            -- claim binding. A duplicate or expired claim can therefore never
            -- mint a second target-ref mutation.
            CREATE TABLE IF NOT EXISTS governed_promotion_execution_claims (
                run_id                                  TEXT NOT NULL,
                candidate_digest                        TEXT NOT NULL,
                idempotency_key                         TEXT NOT NULL,
                promotion_decision_event_id             TEXT NOT NULL UNIQUE,
                promotion_decision_event_digest         TEXT NOT NULL,
                dispatch_event_id                       TEXT NOT NULL,
                dispatch_envelope_digest                TEXT NOT NULL,
                candidate_ref                           TEXT NOT NULL,
                candidate_commit_sha                    TEXT NOT NULL,
                candidate_tree_digest                   TEXT NOT NULL,
                base_commit_sha                         TEXT NOT NULL,
                target_ref                              TEXT NOT NULL,
                authority_actor                         TEXT NOT NULL,
                promotion_execution_claim_event_id      TEXT NOT NULL UNIQUE,
                promotion_execution_claim_event_digest  TEXT NOT NULL,
                lease_id                                TEXT NOT NULL UNIQUE,
                claimed_at                              TEXT NOT NULL,
                lease_expires_at                        TEXT NOT NULL,
                PRIMARY KEY (run_id, candidate_digest),
                UNIQUE (run_id, idempotency_key),
                FOREIGN KEY(promotion_decision_event_id) REFERENCES events(id),
                FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(promotion_execution_claim_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_governed_promotion_execution_claims_decision
                ON governed_promotion_execution_claims(run_id, promotion_decision_event_id);

            CREATE TRIGGER IF NOT EXISTS governed_promotion_execution_claims_no_update
                BEFORE UPDATE ON governed_promotion_execution_claims
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion execution claims are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_promotion_execution_claims_no_delete
                BEFORE DELETE ON governed_promotion_execution_claims
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion execution claims are tape-backed: DELETE forbidden');
                END;

            -- Broker-private, terminal projection for the one result bound to
            -- a sealed promotion decision. This stores only a cache of the
            -- signed result event; target-ref authority remains in the
            -- decision-bound native Git gateway, never in this row.
            CREATE TABLE IF NOT EXISTS governed_promotion_results (
                run_id                           TEXT NOT NULL,
                candidate_digest                 TEXT NOT NULL,
                idempotency_key                  TEXT NOT NULL,
                promotion_decision_event_id      TEXT NOT NULL UNIQUE,
                promotion_decision_event_digest  TEXT NOT NULL,
                promotion_result_event_id        TEXT NOT NULL UNIQUE,
                promotion_result_event_digest    TEXT NOT NULL,
                outcome                          TEXT NOT NULL CHECK(outcome IN ('promoted', 'reconciliation_required', 'rejected')),
                merged_head_sha                  TEXT,
                promotion_git_binding_json       TEXT,
                completed_at                     TEXT NOT NULL,
                PRIMARY KEY (run_id, candidate_digest),
                UNIQUE (run_id, idempotency_key),
                FOREIGN KEY(promotion_decision_event_id) REFERENCES events(id),
                FOREIGN KEY(promotion_result_event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_governed_promotion_results_decision
                ON governed_promotion_results(run_id, promotion_decision_event_id);

            CREATE TRIGGER IF NOT EXISTS governed_promotion_results_no_update
                BEFORE UPDATE ON governed_promotion_results
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion results are tape-backed: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_promotion_results_no_delete
                BEFORE DELETE ON governed_promotion_results
                BEGIN
                    SELECT RAISE(ABORT, 'governed promotion results are tape-backed: DELETE forbidden');
                END;

            "#,
        )?;
        ensure_workflow_instance_snapshot_cache_schema_v1(conn)
    }

    /// Append an event to the log. Fails if the id already exists.
    ///
    /// This is the raw/unsigned public append path. It still runs the shared
    /// external-append validation so a caller can never inject a forged
    /// `tape_checkpoint` (checkpoints are ledger-internal in EVERY mode) or an
    /// out-of-order ordinary event id, regardless of signing mode.
    pub fn append(&self, event: &Event) -> Result<()> {
        self.validate_external_append(event)?;
        insert_event(&self.conn, event)?;
        self.record_ordinary_append(event);
        Ok(())
    }

    /// Validation enforced on every public append entry point for events that
    /// arrive from a caller/wire (NOT internal checkpoint creation).
    ///
    /// (a) Reject caller-supplied `tape_checkpoint` events: checkpoints are
    ///     ledger-internal and minted only by [`Self::emit_checkpoint`], which
    ///     inserts directly through the private `insert_event`/
    ///     `insert_event_signature` and so bypasses this helper. Enforced in
    ///     EVERY mode (signed and unsigned).
    /// (b) Per-run strictly-monotonic ordinary-event id: reject an ordinary
    ///     event whose id is `<=` the latest NON-checkpoint event id for the
    ///     same run. Checkpoint ids never constrain the ordinary sequence (an
    ///     internally-minted checkpoint id can exceed a later, pre-generated
    ///     ordinary id), so the comparison deliberately ignores checkpoints.
    ///
    /// Single-writer assumption: the monotonic-id check in (b) compares against
    /// an in-process per-run high-water mark
    /// ([`Self::ordinary_id_high_water`]) and then inserts in two separate steps
    /// rather than inside one transaction. The mark is seeded from the DB once
    /// per run (lazily, on first touch) and advanced in-process on each
    /// successful ordinary append, so the guard runs in O(1) with no per-append
    /// `SELECT`. This is sound under buildplane's M1 single-writer /
    /// single-operator model — one `serve` connection appends to a given run,
    /// and SQLite serializes writers — so no concurrent append can interleave
    /// between the check and the insert, and the in-memory mark cannot drift
    /// from durable state. A fully concurrent multi-writer deployment would need
    /// this guard moved inside the insert transaction (or backed by a DB-level
    /// uniqueness/ordering constraint) to stay race-free; that is deliberately
    /// out of scope here and noted for whoever lifts the single-writer
    /// assumption.
    fn validate_external_append(&self, event: &Event) -> Result<()> {
        if event.kind == EventKind::TapeCheckpoint {
            return Err(LedgerError::CallerSuppliedCheckpoint);
        }
        if let Some(latest) = self.latest_ordinary_id(&event.run_id)? {
            if event.id.as_uuid() <= latest.as_uuid() {
                return Err(LedgerError::NonMonotonicEventId {
                    run_id: event.run_id.to_string(),
                });
            }
        }
        if matches!(
            event.kind,
            EventKind::WorkflowGraphDeclaredV1
                | EventKind::WorkflowGraphDeclaredV2
                | EventKind::DispatchEnvelopeV4
        ) {
            canonicalize(event.clone())?;
        }
        Ok(())
    }

    /// The latest NON-checkpoint event id for `run_id`, served from the
    /// in-process high-water mark and seeded once from the DB on first touch.
    ///
    /// `None` means the run has no ordinary events yet (a fresh run, or a run
    /// whose only rows are checkpoints — which never advance the mark).
    fn latest_ordinary_id(&self, run_id: &RunId) -> Result<Option<EventId>> {
        if let Some(id) = self.ordinary_id_high_water.borrow().get(run_id) {
            return Ok(Some(*id));
        }
        // Cold run: one DB query to seed the mark, then cache it. Subsequent
        // appends for this run are served purely from memory.
        let seeded = self.latest_ordinary_event_id_for_run(run_id)?;
        if let Some(id) = seeded {
            self.ordinary_id_high_water.borrow_mut().insert(*run_id, id);
        }
        Ok(seeded)
    }

    /// Advance the per-run high-water mark after a successful ordinary append.
    /// `validate_external_append` guarantees the new id is strictly greater than
    /// any prior ordinary id for the run, so this is an unconditional set.
    /// Never called for checkpoint events — checkpoints must not constrain the
    /// ordinary id sequence.
    fn record_ordinary_append(&self, event: &Event) {
        debug_assert_ne!(event.kind, EventKind::TapeCheckpoint);
        self.ordinary_id_high_water
            .borrow_mut()
            .insert(event.run_id, event.id);
    }

    /// Append a detached event signature. The `event_signatures` table is
    /// append-only and keyed by `event_id`, so duplicates and missing event ids
    /// fail through SQLite constraints.
    pub fn append_event_signature(&self, signature: &EventSignatureV1) -> Result<()> {
        insert_event_signature(&self.conn, signature)
    }

    /// Append an event and its matching detached signature atomically (signed
    /// mode).
    ///
    /// Within a single SQLite transaction this: (1) signs the canonical event
    /// bytes with `signing_key`, (2) inserts the event row, (3) inserts the
    /// matching `event_signatures` row, and commits only if all three succeed.
    /// If signing fails, the event-row insert fails, or the signature insert
    /// fails, the transaction rolls back and no event row persists — the append
    /// fails closed.
    ///
    /// The signature is produced before the inserts so a signing error never
    /// touches the database. `signer.public_key_hash` is overwritten by
    /// [`sign_event`] with the verifying-key digest.
    ///
    /// On a `COMMIT` failure the transaction is dropped without committing, so
    /// the inserts leave no committed state on this per-process connection; the
    /// error is surfaced to the caller and the append fails closed.
    // The caller supplies the actor/key identity. Authorization remains a
    // replay-time policy decision; this storage primitive only records the
    // detached signature atomically with its event.
    pub fn append_signed(
        &self,
        event: &Event,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<()> {
        self.append_signed_with_checkpoint(event, signing_key, signer, &CheckpointPolicy::Disabled)
            .map(|_| ())
    }

    /// Append a signed event and, per `policy`, emit a tape-root checkpoint.
    ///
    /// This first appends the ordinary event and its detached signature exactly
    /// as [`append_signed`] does (one atomic transaction; fails closed on any
    /// signing or insert error). Then, in signed mode with an enabled policy:
    ///
    /// 1. count the run's uncheckpointed signed ordinary events;
    /// 2. if the cadence boundary is reached — or the event is `run_completed`
    ///    and at least one signed ordinary event is uncheckpointed — build a
    ///    checkpoint over the full prefix of the run's signed ordinary event
    ///    hashes through the latest such event;
    /// 3. sign the checkpoint event and append it together with its signature in
    ///    a single transaction, so a checkpoint never persists without its
    ///    signature (fail closed).
    ///
    /// Returns the ids of any checkpoint events emitted (0 or 1). A failure
    /// while building/appending the checkpoint surfaces as an error; the
    /// ordinary event remains committed (it was its own atomic append), but the
    /// checkpoint event and its signature roll back together.
    ///
    /// `tape_checkpoint` events do not themselves count toward the cadence and
    /// are never checkpointed.
    ///
    /// Two-transaction edge: the ordinary event commits in its own transaction
    /// before checkpoint emission. If checkpoint emission then fails (e.g. its
    /// signature insert aborts), the ordinary event stays committed without its
    /// (final) checkpoint. This is recoverable — a later signed event for the
    /// run re-triggers emission over the still-uncheckpointed prefix — and never
    /// breaks per-event verification, which does not depend on checkpoints.
    pub fn append_signed_with_checkpoint(
        &self,
        event: &Event,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        policy: &CheckpointPolicy,
    ) -> Result<Vec<EventId>> {
        // Shared external-append validation (Codex P1-1 + P1-2): reject a
        // caller-supplied `tape_checkpoint` and any non-monotonic ordinary id
        // for this run, before signing or persisting anything. Centralized in
        // `validate_external_append` so every public append path (raw/unsigned
        // `append`, `append_signed`, this method) stays consistent. Internal
        // checkpoint creation bypasses it (see `emit_checkpoint`).
        self.validate_external_append(event)?;

        // Step 1+2 (spec ordering): append the ordinary event and flush its
        // detached signature atomically. Sign first so a signing failure never
        // reaches the storage transaction.
        let signature = sign_event(event, signing_key, signer, Utc::now())?;
        {
            let tx = self.conn.unchecked_transaction()?;
            insert_event(&tx, event)?;
            insert_event_signature(&tx, &signature)?;
            tx.commit()?;
        }
        // The ordinary event is now durably committed (its own atomic
        // transaction above), so advance the high-water mark before any
        // checkpoint emission. A later checkpoint failure leaves this ordinary
        // event committed, so the mark must reflect it regardless.
        self.record_ordinary_append(event);

        let CheckpointPolicy::Enabled { cadence } = *policy else {
            return Ok(vec![]);
        };

        // Step 3: inspect the current signed prefix and emit a checkpoint
        // under one immediate writer transaction. The ordinary event above is
        // intentionally durable before this step, but every checkpoint writer
        // must serialize its prior/snapshot/insert sequence with every other
        // checkpoint writer. Otherwise a cadence writer and governed sealer
        // could both derive the same predecessor and fork the immutable chain.
        let checkpoint = self.emit_checkpoint_if_due_for_current_signed_prefix(
            &event.run_id,
            cadence,
            event.kind == EventKind::RunCompleted,
            signing_key,
            signer,
        )?;
        Ok(checkpoint.into_iter().collect())
    }

    /// Serialize cadence accounting with every other checkpoint writer. The
    /// ordinary event was committed before this method is called, so a failed
    /// checkpoint leaves it durable and a later append can retry sealing the
    /// same prefix. The checkpoint snapshot, predecessor, and insert are all
    /// nevertheless one `BEGIN IMMEDIATE` transaction.
    fn emit_checkpoint_if_due_for_current_signed_prefix(
        &self,
        run_id: &RunId,
        cadence: u64,
        is_final: bool,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<Option<EventId>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let prior = latest_checkpoint_for_connection(&tx, run_id)?;
        let already_checkpointed = prior.as_ref().map(|p| p.through_event_count).unwrap_or(0);
        let covered = signed_ordinary_events_for_connection(&tx, run_id)?;
        let total = covered.len() as u64;
        let uncheckpointed = total.saturating_sub(already_checkpointed);
        let cadence_due = uncheckpointed >= cadence;
        let final_due = is_final && uncheckpointed >= 1;
        if !cadence_due && !final_due {
            tx.commit()?;
            return Ok(None);
        }

        let checkpoint_event_id =
            self.emit_checkpoint_in_transaction(&tx, run_id, &covered, prior, signing_key, signer)?;
        tx.commit()?;
        Ok(Some(checkpoint_event_id))
    }

    /// Emit a checkpoint over the current non-empty signed prefix with the
    /// same snapshot/insert serialization used by cadence checkpoints. This
    /// is for governed callers which already determined that their particular
    /// control record needs coverage; it intentionally does not infer a
    /// cadence policy.
    fn emit_checkpoint_for_current_signed_prefix(
        &self,
        run_id: &RunId,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<Option<EventId>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let covered = signed_ordinary_events_for_connection(&tx, run_id)?;
        if covered.is_empty() {
            tx.commit()?;
            return Ok(None);
        }
        let prior = latest_checkpoint_for_connection(&tx, run_id)?;
        let checkpoint_event_id =
            self.emit_checkpoint_in_transaction(&tx, run_id, &covered, prior, signing_key, signer)?;
        tx.commit()?;
        Ok(Some(checkpoint_event_id))
    }

    /// Seal the current complete signed ordinary-event prefix for a governed
    /// run.
    ///
    /// This deliberately accepts only the host-trusted run identity and
    /// signing material. Callers cannot choose event bytes, event hashes, a
    /// tape root, or a checkpoint policy. A completed control retry reaches
    /// this same method, allowing a prior post-commit checkpoint failure to
    /// seal its already-durable authority event before another success is
    /// reported.
    pub(crate) fn seal_governed_signed_prefix(
        &self,
        run_id: &RunId,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        // Keep the observed prefix, chain validation, prior checkpoint, and
        // next checkpoint insertion under one writer transaction. Without
        // this boundary two broker connections could validate the same prior
        // checkpoint and permanently append competing checkpoint indexes.
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let outcome =
            self.seal_governed_signed_prefix_in_transaction(&tx, run_id, signing_key, signer)?;
        tx.commit()?;
        Ok(outcome)
    }

    /// Governed checkpoint sealing after the caller has already acquired the
    /// run's immediate writer transaction. Keeping this separate lets a
    /// candidate-completion retry prove that no sibling completion was appended
    /// immediately before it seals the proof.
    fn seal_governed_signed_prefix_in_transaction(
        &self,
        tx: &Transaction<'_>,
        run_id: &RunId,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        let covered = signed_ordinary_events_for_connection(tx, run_id)?;
        let Some(through) = covered.last() else {
            return Ok(GovernedCheckpointSealOutcome::EmptyPrefix);
        };
        // Compute every prefix root once. Rebuilding `tape_root_hash` for each
        // historical checkpoint turns a dense checkpoint chain into quadratic
        // work per seal; this rolling representation preserves the exact
        // newline-joined wire contract while making validation linear.
        let prefix_roots = tape_prefix_roots(&covered);
        let expected_root = prefix_roots
            .last()
            .expect("a non-empty signed prefix has a root");
        Self::verify_governed_checkpoint_chain_for_seal(
            tx,
            run_id,
            &covered,
            &prefix_roots,
            signing_key,
            signer,
        )?;
        let prior = latest_checkpoint_for_connection(tx, run_id)?;
        if let Some(checkpoint) = prior.as_ref() {
            if checkpoint.algorithm == TapeRootAlgorithm::Sha256Linear
                && checkpoint.through_event_count == covered.len() as u64
                && checkpoint.through_event_id == through.event_id
                && checkpoint.tape_root_hash == *expected_root
            {
                return Ok(GovernedCheckpointSealOutcome::AlreadySealed {
                    checkpoint_event_id: checkpoint.event_id,
                });
            }
        }

        let checkpoint_event_id =
            self.emit_checkpoint_in_transaction(tx, run_id, &covered, prior, signing_key, signer)?;
        Ok(GovernedCheckpointSealOutcome::Emitted {
            checkpoint_event_id,
        })
    }

    /// Recheck the append-only candidate-completion lane after acquiring the
    /// same writer transaction that seals its tape prefix. A generic signed
    /// append may have produced a sibling completion after the proof/projection
    /// committed but before a retry reaches this method; that ambiguity must
    /// block rather than become a sealed success.
    fn seal_governed_candidate_completion_prefix(
        &self,
        request: &GovernedCandidateCompletionRequestV1,
        expected_completion_event_id: EventId,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        require_candidate_completion_event_projection(
            &tx,
            request,
            Some(expected_completion_event_id),
        )?;
        let outcome = self.seal_governed_signed_prefix_in_transaction(
            &tx,
            &request.run_id,
            signing_key,
            signer,
        )?;
        tx.commit()?;
        Ok(outcome)
    }

    /// Verify every checkpoint in the governed run before a control response
    /// can reuse or chain from the latest one. A signature-row join is
    /// insufficient: recovery verifies the complete checkpoint chain and must
    /// not discover an earlier corrupt checkpoint after protocol success.
    fn verify_governed_checkpoint_chain_for_seal(
        conn: &Connection,
        run_id: &RunId,
        covered: &[SignedOrdinaryEvent],
        prefix_roots: &[String],
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<()> {
        let rejected = |reason: &str| LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("governed checkpoint seal rejected: {reason}"),
        };
        let expected_public_key_hash = public_key_hash(&signing_key.verifying_key());
        let expected_signer = ActorKeyRef {
            actor_id: signer.actor_id.clone(),
            key_id: signer.key_id.clone(),
            public_key_hash: Some(expected_public_key_hash.clone()),
        };
        let mut trusted_keys = TrustedPublicKeys::default();
        trusted_keys.insert_public_key(
            expected_public_key_hash,
            signing_key.verifying_key().to_bytes().to_vec(),
        );
        if prefix_roots.len() != covered.len() {
            return Err(rejected(
                "checkpoint root index does not cover the signed ordinary-event prefix",
            ));
        }

        let mut expected_index = 0_u64;
        let mut previous_checkpoint: Option<(EventId, usize)> = None;
        for (event, signature) in signed_events_for_run_for_connection(conn, &run_id.to_string())? {
            if event.kind != EventKind::TapeCheckpoint {
                continue;
            }
            let Some(signature) = signature else {
                return Err(rejected("checkpoint lacks a detached signature"));
            };
            if event.run_id != *run_id
                || !actor_matches(&expected_signer, &signature.signer)
                || verify_event_signature(&event, &signature, &trusted_keys)
                    != VerificationStatus::Verified
            {
                return Err(rejected(
                    "checkpoint signature is not verified for the configured governed signer",
                ));
            }
            let Payload::TapeCheckpointV1(payload) = &event.payload else {
                return Err(rejected("checkpoint does not carry TapeCheckpointV1"));
            };
            if payload.run_id != *run_id
                || payload.algorithm != TapeRootAlgorithm::Sha256Linear
                || event.parent_event_id != Some(payload.through_event_id)
            {
                return Err(rejected(
                    "checkpoint payload is not a valid governed tape prefix",
                ));
            }

            let prefix_len = usize::try_from(payload.through_event_count)
                .map_err(|_| rejected("checkpoint count exceeds platform limits"))?;
            if prefix_len == 0 || prefix_len > covered.len() {
                return Err(rejected(
                    "checkpoint count is outside the current signed prefix",
                ));
            }
            let through_position = prefix_len - 1;
            if covered[through_position].event_id != payload.through_event_id {
                return Err(rejected(
                    "checkpoint through-event does not match the signed prefix",
                ));
            }
            if payload.tape_root_hash != prefix_roots[through_position] {
                return Err(rejected(
                    "checkpoint root does not match the signed ordinary-event prefix",
                ));
            }
            if payload.checkpoint_index != expected_index {
                return Err(rejected("checkpoint index is not contiguous"));
            }
            let expected_predecessor = previous_checkpoint.map(|(event_id, _)| event_id);
            if payload.previous_checkpoint_event_id != expected_predecessor {
                return Err(rejected("checkpoint predecessor does not match the chain"));
            }
            if let Some((previous_event_id, previous_through_position)) = previous_checkpoint {
                if through_position <= previous_through_position {
                    return Err(rejected(&format!(
                        "checkpoint does not advance beyond predecessor {previous_event_id}",
                    )));
                }
            }
            previous_checkpoint = Some((event.id, through_position));
            expected_index = expected_index
                .checked_add(1)
                .ok_or_else(|| rejected("checkpoint index overflow"))?;
        }
        Ok(())
    }

    /// Atomically reserve a single execution lease for a signed governed V3
    /// action request.
    ///
    /// The claim projection is never authoritative on its own: this method
    /// writes an `ActivityClaimedV1` event, its detached signature, and the
    /// unique projection row in one `BEGIN IMMEDIATE` transaction. A duplicate
    /// idempotency key is read from that durable projection and never receives
    /// a second lease token.
    pub fn claim_activity_v1(
        &self,
        request: &ActivityClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityClaimDispositionV1> {
        self.claim_activity_v1_at(
            request,
            authority,
            signing_key,
            signer,
            Utc::now(),
            ActivityClaimPurposeV1::Generic,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn claim_activity_v1_at_for_tests(
        &self,
        request: &ActivityClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityClaimDispositionV1> {
        self.claim_activity_v1_at(
            request,
            authority,
            signing_key,
            signer,
            now,
            ActivityClaimPurposeV1::Generic,
        )
    }

    fn claim_activity_v1_at(
        &self,
        request: &ActivityClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
        purpose: ActivityClaimPurposeV1,
    ) -> Result<ActivityClaimDispositionV1> {
        validate_activity_claim_request(request)?;
        validate_claim_signer(authority, signing_key, signer)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;

        if let Some(existing) =
            activity_claim_by_idempotency(&tx, request.run_id, &request.idempotency_key)?
        {
            // The projection is a durable index, never a source of authority.
            // Re-verify the signed grant before using even an idempotent replay
            // result. A damaged or substituted projection must fail closed,
            // rather than return Pending/Recorded as though it were tape-backed.
            let existing_claim = verify_signed_claim_projection(&tx, &existing, authority)?;
            if existing_claim.purpose != purpose {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "activity claim purpose conflicts with the existing signed reservation"
                        .into(),
                });
            }
            if existing.state == StoredActivityClaimState::Recorded {
                verify_signed_activity_result_projection(&tx, &existing, authority)?;
            }
            let effective_lease_expires_at =
                effective_activity_lease_expiry(&tx, &existing, authority)?;
            let disposition =
                existing_claim_disposition(&existing, request, now, effective_lease_expires_at)?;
            tx.commit()?;
            return Ok(disposition);
        }
        if activity_claim_by_activity_id(&tx, request.run_id, &request.activity_id)?.is_some() {
            return Err(activity_claim_conflict(request));
        }

        let evidence = verify_claim_evidence(&tx, request, authority, now)?;
        let claimed_at = timestamp(now);
        // A lease is a narrower reservation derived from the dispatch, never
        // a way to extend its authority. Cap it at the signed effect deadline
        // (dispatch expiry or the shorter signed compute budget) even when a
        // caller asks for a longer duration.
        let requested_lease_expiry = now + Duration::milliseconds(request.lease_duration_ms as i64);
        let lease_expires_at =
            timestamp(requested_lease_expiry.min(evidence.effective_deadline.clone()));
        let lease_id = Uuid::now_v7().to_string();
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(request.action_request_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityClaimedV1,
            occurred_at: now,
            payload: Payload::ActivityClaimedV1(ActivityClaimedV1 {
                run_id: request.run_id,
                activity_id: request.activity_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                action_kind: evidence.action_kind,
                action_request_event_id: request.action_request_event_id,
                action_request_digest: evidence.action_request_digest.clone(),
                dispatch_event_id: request.dispatch_event_id,
                dispatch_envelope_digest: evidence.dispatch_envelope_digest.clone(),
                authority_actor: authority.claim_signer.actor_id.clone(),
                purpose,
                lease_id: lease_id.clone(),
                lease_expires_at: lease_expires_at.clone(),
                claimed_at: claimed_at.clone(),
            }),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, signer, now)?;
        let claim_event_digest = signature.canonical_event_hash.clone();

        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        insert_activity_claim(
            &tx,
            request,
            &evidence,
            &event,
            &claim_event_digest,
            &lease_id,
            &lease_expires_at,
            &claimed_at,
        )?;
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(ActivityClaimDispositionV1::Granted {
            claim_event_id: event.id,
            claim_event_digest,
            lease_id,
            lease_expires_at,
        })
    }

    /// Issue the one signed `ModelActionIntentV1` record for a governed model
    /// action. This is deliberately not a generic append: it reconstructs the
    /// dispatch and write-ahead action from verified tape, requires the
    /// protected realm authority, and records the signed event plus its unique
    /// idempotency projection in one `BEGIN IMMEDIATE` transaction.
    pub fn issue_model_action_intent_v1(
        &self,
        request: &ModelActionIntentIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ModelActionIntentIssueDispositionV1> {
        let mut clock = Utc::now;
        self.issue_model_action_intent_v1_with_clock(
            request,
            cas,
            authority,
            signing_key,
            signer,
            &mut clock,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn issue_model_action_intent_v1_at_for_tests(
        &self,
        request: &ModelActionIntentIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ModelActionIntentIssueDispositionV1> {
        let mut clock = || now;
        self.issue_model_action_intent_v1_with_clock(
            request,
            cas,
            authority,
            signing_key,
            signer,
            &mut clock,
        )
    }

    /// Test-only clock seam for expiry-boundary regressions. Production always
    /// samples the real UTC clock at both the initial replay and immediately
    /// before it signs the new authority record.
    #[cfg(any(test, feature = "test-support"))]
    pub fn issue_model_action_intent_v1_with_clock_for_tests<F>(
        &self,
        request: &ModelActionIntentIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        mut clock: F,
    ) -> Result<ModelActionIntentIssueDispositionV1>
    where
        F: FnMut() -> DateTime<Utc>,
    {
        self.issue_model_action_intent_v1_with_clock(
            request,
            cas,
            authority,
            signing_key,
            signer,
            &mut clock,
        )
    }

    fn issue_model_action_intent_v1_with_clock<F>(
        &self,
        request: &ModelActionIntentIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        clock: &mut F,
    ) -> Result<ModelActionIntentIssueDispositionV1>
    where
        F: FnMut() -> DateTime<Utc>,
    {
        require_protected_model_intent_realm(authority)?;
        validate_claim_signer(authority, signing_key, signer)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let issued = issue_model_action_intent_v1_in_tx(
            &tx,
            request,
            cas,
            authority,
            signing_key,
            signer,
            clock,
        )?;
        tx.commit()?;
        if let Some(event) = issued.appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        Ok(issued.into_public_disposition())
    }

    /// Atomically create (or resolve) the only provider-effect authority for
    /// a governed sealed-V3 model action. This is deliberately a host-private
    /// storage operation rather than a generic ledger control: it accepts only
    /// stable tape references and a bounded lease, derives all dynamic model
    /// evidence from protected CAS, and writes the intent, V2 authorization,
    /// and activity claim in one immediate SQLite transaction.
    pub fn authorize_and_claim_governed_model_action_v1(
        &self,
        request: &GovernedModelActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedModelActionAuthorizeAndClaimDispositionV1> {
        let mut clock = Utc::now;
        self.authorize_and_claim_governed_model_action_v1_with_clock(
            request,
            cas,
            authority,
            signing_key,
            signer,
            &mut clock,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn authorize_and_claim_governed_model_action_v1_at_for_tests(
        &self,
        request: &GovernedModelActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedModelActionAuthorizeAndClaimDispositionV1> {
        let mut clock = || now;
        self.authorize_and_claim_governed_model_action_v1_with_clock(
            request,
            cas,
            authority,
            signing_key,
            signer,
            &mut clock,
        )
    }

    fn authorize_and_claim_governed_model_action_v1_with_clock<F>(
        &self,
        request: &GovernedModelActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        clock: &mut F,
    ) -> Result<GovernedModelActionAuthorizeAndClaimDispositionV1>
    where
        F: FnMut() -> DateTime<Utc>,
    {
        require_protected_model_intent_realm(authority)?;
        validate_claim_signer(authority, signing_key, signer)?;
        validate_governed_model_action_authorize_and_claim_request(request)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;

        // A retry must resolve the durable authority that already exists
        // before evaluating current dispatch expiry. Existing authority is
        // historical evidence; an expired lease is terminally ambiguous, not
        // permission to mint a replacement authorization or provider call.
        if let Some(existing) = model_action_authorization_by_action_request(
            &tx,
            request.run_id,
            request.action_request_event_id,
        )? {
            let disposition = resolve_existing_governed_model_authorization(
                &tx, &existing, request, cas, authority, clock,
            )?;
            tx.commit()?;
            return Ok(disposition);
        }
        if model_action_authorization_event_exists_for_action_request(
            &tx,
            request.run_id,
            request.action_request_event_id,
        )? {
            return Err(model_action_authorization_reconciliation_required(
                request,
                "a V2 model authorization exists without a trusted native authorization projection",
            ));
        }

        let issue_request = ModelActionIntentIssueRequestV1 {
            run_id: request.run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
        };
        let issued_intent = issue_model_action_intent_v1_in_tx(
            &tx,
            &issue_request,
            cas,
            authority,
            signing_key,
            signer,
            clock,
        )?;

        // Re-read signed dispatch/action evidence after CAS work and before
        // signing either authorization record. This prevents an expired or
        // changed admission window from being backdated through a slow CAS
        // operation, while an already-recorded authorization above remains
        // recoverable after expiry.
        let now = canonical_ledger_timestamp(clock())?;
        let evidence =
            verify_model_action_intent_issue_evidence(&tx, &issue_request, authority, now)?;
        if !model_action_intent_matches_issue_evidence(
            &issued_intent.intent,
            &issue_request,
            &evidence,
        ) {
            return Err(model_action_authorization_reconciliation_required(
                request,
                "the model intent no longer exactly binds the replayed dispatch/action evidence",
            ));
        }
        ensure_model_action_intent_lifecycle_is_open(&tx, &issue_request, &evidence)?;

        if let Some(existing_claim) = activity_claim_by_idempotency(
            &tx,
            request.run_id,
            &evidence.action_request.idempotency_key,
        )? {
            return Err(model_action_authorization_reconciliation_required(
                request,
                format!(
                    "activity claim {} already exists without a matching native V2 authorization projection",
                    existing_claim.claim_event_id
                ),
            ));
        }
        if activity_claim_by_activity_id(&tx, request.run_id, &evidence.action_request.action_id)?
            .is_some()
        {
            return Err(model_action_authorization_reconciliation_required(
                request,
                "an activity claim with this model action identity already exists without a matching native V2 authorization projection",
            ));
        }

        let dispatch_window =
            validate_governed_dispatch(&evidence.dispatch, now).map_err(|error| {
                LedgerError::ModelActionIntentAuthorityRejected {
                    reason: format!(
                        "model action authorization dispatch is not governed authority: {error}"
                    ),
                }
            })?;
        let requested_expiry = now + Duration::milliseconds(request.lease_duration_ms as i64);
        let authorization_expires_at = requested_expiry.min(dispatch_window.effective_deadline);
        if authorization_expires_at <= now {
            return Err(LedgerError::ModelActionIntentAuthorityRejected {
                reason: "model action authorization has no remaining signed authority window"
                    .into(),
            });
        }
        let expires_at = timestamp(authorization_expires_at);
        let authorization_ref = governed_model_action_authorization_ref(
            authority,
            request,
            issued_intent.intent_event_id,
            &issued_intent.intent.intent_digest,
        )?;
        let mut authorization = ModelActionAuthorizedV2 {
            intent_event_ref: issued_intent.intent_event_id,
            intent_digest: issued_intent.intent.intent_digest.clone(),
            model_request_evidence: issued_intent.intent.model_request_evidence.clone(),
            trust_scope_evidence: issued_intent.intent.trust_scope_evidence.clone(),
            candidate_binding: issued_intent.intent.candidate_binding.clone(),
            authorization_actor: authority.claim_signer.actor_id.clone(),
            expires_at: expires_at.clone(),
            authorization_ref: authorization_ref.clone(),
            authorization_digest: String::new(),
        };
        authorization.authorization_digest = model_action_authorized_v2_digest(&authorization)
            .map_err(|error| LedgerError::ModelActionIntentAuthorityRejected {
                reason: format!("could not canonicalize model action authorization: {error}"),
            })?;
        let authorization_event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(issued_intent.intent_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ModelActionAuthorizedV2,
            occurred_at: now,
            payload: Payload::ModelActionAuthorizedV2(authorization.clone()),
        })?;
        validate_new_ordinary_event_id(&tx, &authorization_event)?;
        let authorization_signature = sign_event(&authorization_event, signing_key, signer, now)?;
        let authorization_event_digest = authorization_signature.canonical_event_hash.clone();

        let claim_request = ActivityClaimRequestV1 {
            run_id: request.run_id,
            activity_id: evidence.action_request.action_id.clone(),
            idempotency_key: evidence.action_request.idempotency_key.clone(),
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms: request.lease_duration_ms,
        };
        validate_activity_claim_request(&claim_request)?;
        let claimed_at = timestamp(now);
        let lease_id = Uuid::now_v7().to_string();
        // The authorization is inserted before the claim so the ordinary-ID
        // invariant and the reducer both observe the causal order V2 ->
        // ActivityClaimedV1 inside this one committed transaction.
        insert_event(&tx, &authorization_event)?;
        insert_event_signature(&tx, &authorization_signature)?;
        let claim_event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(request.action_request_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityClaimedV1,
            occurred_at: now,
            payload: Payload::ActivityClaimedV1(ActivityClaimedV1 {
                run_id: request.run_id,
                activity_id: claim_request.activity_id.clone(),
                idempotency_key: claim_request.idempotency_key.clone(),
                action_kind: ActionKindV1::Model,
                action_request_event_id: request.action_request_event_id,
                action_request_digest: evidence.action_request_digest.clone(),
                dispatch_event_id: request.dispatch_event_id,
                dispatch_envelope_digest: evidence.dispatch_envelope_digest.clone(),
                authority_actor: authority.claim_signer.actor_id.clone(),
                purpose: ActivityClaimPurposeV1::GovernedModelActionV1,
                lease_id: lease_id.clone(),
                lease_expires_at: expires_at.clone(),
                claimed_at: claimed_at.clone(),
            }),
        })?;
        validate_new_ordinary_event_id(&tx, &claim_event)?;
        let claim_signature = sign_event(&claim_event, signing_key, signer, now)?;
        let claim_event_digest = claim_signature.canonical_event_hash.clone();
        insert_event(&tx, &claim_event)?;
        insert_event_signature(&tx, &claim_signature)?;
        insert_model_action_authorization_projection(
            &tx,
            request,
            &evidence.action_request_digest,
            &issued_intent,
            &authorization_event,
            &authorization_event_digest,
            &authorization,
            &claim_event,
            &claimed_at,
        )?;
        let claim_evidence = VerifiedClaimEvidence {
            action_kind: ActionKindV1::Model,
            action_request_digest: evidence.action_request_digest.clone(),
            dispatch_envelope_digest: evidence.dispatch_envelope_digest.clone(),
            effective_deadline: authorization_expires_at,
        };
        insert_activity_claim(
            &tx,
            &claim_request,
            &claim_evidence,
            &claim_event,
            &claim_event_digest,
            &lease_id,
            &expires_at,
            &claimed_at,
        )?;
        tx.commit()?;

        if let Some(event) = issued_intent.appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        self.record_ordinary_append(&authorization_event);
        self.record_ordinary_append(&claim_event);

        Ok(GovernedModelActionAuthorizeAndClaimDispositionV1::Granted {
            intent_event_id: issued_intent.intent_event_id,
            intent_digest: issued_intent.intent.intent_digest,
            authorization_event_id: authorization_event.id,
            authorization_event_digest,
            authorization_ref,
            authorization_digest: authorization.authorization_digest,
            authorization_expires_at: expires_at.clone(),
            claim_event_id: claim_event.id,
            claim_event_digest,
            lease_id,
            lease_expires_at: expires_at,
            model_request_evidence: issued_intent.intent.model_request_evidence,
            trust_scope_evidence: issued_intent.intent.trust_scope_evidence,
        })
    }

    /// Record or reconcile the terminal outcome of a governed model lease.
    /// This stays on the same protected authority boundary as claim issuance:
    /// it resolves the action identity from the opaque lease and re-verifies
    /// the V2 intent/authorization chain before it signs a result. A timeout
    /// after expiry can record only `Unknown`, never a second provider call.
    pub fn record_governed_model_action_result_v1(
        &self,
        request: &GovernedModelActionResultRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_model_action_result_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_governed_model_action_result_v1_at_for_tests(
        &self,
        request: &GovernedModelActionResultRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_model_action_result_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            now,
        )
    }

    fn record_governed_model_action_result_v1_at(
        &self,
        request: &GovernedModelActionResultRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        require_protected_model_intent_realm(authority)?;
        validate_claim_signer(authority, signing_key, signer)?;
        if request.lease_id.trim().is_empty() {
            return Err(LedgerError::InvalidPayload {
                kind: "record_governed_model_action_result_v1".into(),
                reason: "lease_id must be non-empty".into(),
            });
        }

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let claim =
            activity_claim_by_lease(&tx, request.run_id, &request.lease_id)?.ok_or_else(|| {
                LedgerError::ActivityClaimAuthorityRejected {
                    reason: "governed model lease does not name a signed activity claim".into(),
                }
            })?;
        let verified = verify_governed_model_claim_lineage(&tx, &claim, authority, cas)?;
        if verified.intent.action_id != claim.activity_id
            || verified.intent.idempotency_key != claim.idempotency_key
            || claim.action_kind != ActionKindV1::Model
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed model lease does not bind the expected native model action"
                    .into(),
            });
        }
        let derived = ActivityResultRequestV1 {
            run_id: request.run_id,
            activity_id: claim.activity_id.clone(),
            idempotency_key: claim.idempotency_key.clone(),
            lease_id: request.lease_id.clone(),
            outcome: request.outcome,
            result_digest: request.result_digest.clone(),
            result_ref: request.result_ref.clone(),
            evidence_digest: request.evidence_digest.clone(),
            evidence_ref: request.evidence_ref.clone(),
        };
        validate_activity_result_request(&derived)?;
        if claim.state == StoredActivityClaimState::Recorded {
            verify_signed_activity_result_projection(&tx, &claim, authority)?;
            let disposition = existing_result_disposition(&claim, &derived)?;
            tx.commit()?;
            return Ok(disposition);
        }
        // This first model authority slice intentionally does not extend a
        // provider lease beyond its V2 authorization window. Treat any
        // unexpected heartbeat history as a reconciliation requirement rather
        // than silently using an unimplemented model-heartbeat semantics.
        if !activity_heartbeats_for_claim(&tx, claim.run_id, claim.claim_event_id)?.is_empty() {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed model activity has heartbeat history that requires explicit model-heartbeat reconciliation".into(),
            });
        }
        let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at)?;
        if now >= lease_expires_at && request.outcome != ActivityResultOutcomeV1::Unknown {
            tx.commit()?;
            return Ok(ActivityResultDispositionV1::LeaseExpired {
                claim_event_id: claim.claim_event_id,
                lease_expires_at: timestamp(lease_expires_at),
            });
        }

        let recorded_at = timestamp(now);
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(claim.claim_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityResultRecordedV1,
            occurred_at: now,
            payload: Payload::ActivityResultRecordedV1(ActivityResultRecordedV1 {
                run_id: request.run_id,
                activity_id: derived.activity_id.clone(),
                idempotency_key: derived.idempotency_key.clone(),
                claim_event_id: claim.claim_event_id,
                claim_event_digest: claim.claim_event_digest.clone(),
                lease_id: derived.lease_id.clone(),
                outcome: derived.outcome,
                result_digest: derived.result_digest.clone(),
                result_ref: derived.result_ref.clone(),
                evidence_digest: derived.evidence_digest.clone(),
                evidence_ref: derived.evidence_ref.clone(),
                recorded_at: recorded_at.clone(),
            }),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, signer, now)?;
        let result_event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        let updated = tx.execute(
            r#"UPDATE activity_claims
               SET state = 'recorded',
                   result_event_id = ?1,
                   result_event_digest = ?2,
                   result_outcome = ?3,
                   result_digest = ?4,
                   result_ref = ?5,
                   evidence_digest = ?6,
                   evidence_ref = ?7,
                   recorded_at = ?8
               WHERE run_id = ?9 AND idempotency_key = ?10 AND state = 'granted'"#,
            params![
                event.id.to_string(),
                &result_event_digest,
                activity_result_outcome_wire(derived.outcome),
                &derived.result_digest,
                &derived.result_ref,
                &derived.evidence_digest,
                &derived.evidence_ref,
                &recorded_at,
                request.run_id.to_string(),
                &derived.idempotency_key,
            ],
        )?;
        if updated != 1 {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason:
                    "governed model activity terminal transition did not update exactly one row"
                        .into(),
            });
        }
        tx.commit()?;
        self.record_ordinary_append(&event);
        Ok(ActivityResultDispositionV1::Recorded {
            result_event_id: event.id,
            result_event_digest,
            outcome: derived.outcome,
        })
    }

    /// Record (or resolve) the one closed materialization proof for an
    /// immutable governed candidate. This is deliberately not a generic
    /// append: callers supply only pre-existing event IDs, while the native
    /// transaction reconstructs every completion field from signed tape and
    /// writes its event, detached signature, and unique projection together.
    ///
    /// A retry resolves the durable projection before it inspects any current
    /// execution window. That makes a crash after commit safe: the caller gets
    /// the original immutable proof, never a fresh completion timestamp or a
    /// second event. If the tape contains a completion event without a trusted
    /// projection, the operation blocks for reconciliation instead of trying
    /// to infer which cross-process append won.
    pub fn record_governed_candidate_completion_v1(
        &self,
        request: &GovernedCandidateCompletionRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
    ) -> Result<GovernedCandidateCompletionDispositionV1> {
        validate_governed_candidate_completion_request(request)?;
        validate_governed_promotion_signer(
            authority,
            kernel_signing_key,
            kernel_signer,
            PromotionSignerRoleV1::Kernel,
        )?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let disposition = if let Some(existing) = governed_candidate_completion_by_candidate(
            &tx,
            request.run_id,
            request.candidate_created_event_id,
        )? {
            let disposition =
                resolve_existing_governed_candidate_completion(&tx, &existing, request, authority)?;
            tx.commit()?;
            disposition
        } else {
            require_candidate_completion_event_projection(&tx, request, None)?;

            let evidence = verify_governed_candidate_completion_evidence(&tx, request, authority)?;
            let completed_at = parse_claim_timestamp(&evidence.completion.completed_at).map_err(
                |_| LedgerError::CandidateCompletionAuthorityRejected {
                    reason:
                        "candidate completion immutable candidate timestamp is not canonical RFC3339 UTC"
                            .into(),
                },
            )?;
            let event = canonicalize(Event {
                id: EventId::new(),
                run_id: request.run_id,
                parent_event_id: Some(request.candidate_created_event_id),
                schema_version: Event::CURRENT_SCHEMA_VERSION,
                kind: EventKind::CandidateCompletionRecordedV1,
                occurred_at: completed_at,
                payload: Payload::CandidateCompletionRecordedV1(evidence.completion.clone()),
            })?;
            validate_new_ordinary_event_id(&tx, &event)?;
            let signature = sign_event(&event, kernel_signing_key, kernel_signer, Utc::now())?;
            let candidate_completion_event_digest = signature.canonical_event_hash.clone();

            insert_event(&tx, &event)?;
            insert_event_signature(&tx, &signature)?;
            insert_governed_candidate_completion(
                &tx,
                request,
                &evidence.completion,
                &event,
                &candidate_completion_event_digest,
            )?;
            tx.commit()?;
            self.record_ordinary_append(&event);

            GovernedCandidateCompletionDispositionV1::Recorded {
                candidate_completion_event_id: event.id,
                candidate_completion_event_digest,
                completion_digest: evidence.completion.completion_digest,
            }
        };

        let expected_completion_event_id = match &disposition {
            GovernedCandidateCompletionDispositionV1::Recorded {
                candidate_completion_event_id,
                ..
            }
            | GovernedCandidateCompletionDispositionV1::Existing {
                candidate_completion_event_id,
                ..
            } => *candidate_completion_event_id,
        };

        // A candidate completion is not execution authority, but later
        // acceptance/review/promotion consumers must reopen a complete signed
        // tape. A post-commit seal failure is reconciliation-only: retrying
        // this operation reuses the existing proof and seals it rather than
        // issuing a new completion event. The guarded seal rechecks the
        // candidate-completion projection after it owns the writer lock, so a
        // direct sibling append in the post-commit gap cannot be sealed.
        let seal = self
            .seal_governed_candidate_completion_prefix(
                request,
                expected_completion_event_id,
                kernel_signing_key,
                kernel_signer,
            )
            .map_err(|error| {
                candidate_completion_reconciliation_required(
                    request,
                    format!("candidate completion checkpoint sealing did not complete: {error}"),
                )
            })?;
        match seal {
            GovernedCheckpointSealOutcome::AlreadySealed { .. }
            | GovernedCheckpointSealOutcome::Emitted { .. } => Ok(disposition),
            GovernedCheckpointSealOutcome::EmptyPrefix => {
                Err(candidate_completion_reconciliation_required(
                    request,
                    "candidate completion sealing found no signed governed prefix",
                ))
            }
        }
    }

    /// Record (or resolve) the one operator decision for an immutable governed
    /// candidate. This is a write-ahead decision only: it does not invoke Git,
    /// issue an action lease, return merge authority, or claim that a target
    /// branch changed. A separately configured kernel signer must call
    /// [`Self::seal_governed_promotion_decision_v1`] before trusted recovery may
    /// expose the decision to a future promotion executor.
    pub fn record_governed_promotion_decision_v1(
        &self,
        request: &GovernedPromotionDecisionRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        operator_signing_key: &SigningKey,
        operator_signer: &ActorKeyRef,
    ) -> Result<GovernedPromotionDecisionDispositionV1> {
        self.record_governed_promotion_decision_v1_at(
            request,
            authority,
            operator_signing_key,
            operator_signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_governed_promotion_decision_v1_at_for_tests(
        &self,
        request: &GovernedPromotionDecisionRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        operator_signing_key: &SigningKey,
        operator_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionDecisionDispositionV1> {
        self.record_governed_promotion_decision_v1_at(
            request,
            authority,
            operator_signing_key,
            operator_signer,
            now,
        )
    }

    fn record_governed_promotion_decision_v1_at(
        &self,
        request: &GovernedPromotionDecisionRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        operator_signing_key: &SigningKey,
        operator_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionDecisionDispositionV1> {
        validate_governed_promotion_decision_request(request)?;
        validate_governed_promotion_signer(
            authority,
            operator_signing_key,
            operator_signer,
            PromotionSignerRoleV1::Operator,
        )?;
        let request_digest = governed_promotion_decision_request_digest(request)?;
        let now = canonical_ledger_timestamp(now)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        // Resolve a prior immutable decision before applying the current
        // dispatch expiry. A retry after its authority window closes must
        // return the original durable record, never be treated as permission
        // to mint a second decision or as a reason to lose reconciliation
        // visibility.
        let evidence =
            verify_governed_promotion_decision_evidence(&tx, request, authority, now, false)?;
        if let Some(existing) = governed_promotion_decision_by_candidate(
            &tx,
            request.run_id,
            &evidence.candidate.candidate_digest,
        )? {
            let disposition = resolve_existing_governed_promotion_decision(
                &tx,
                &existing,
                request,
                &request_digest,
                authority,
            )?;
            tx.commit()?;
            return Ok(disposition);
        }
        if let Some(existing) = governed_promotion_decision_by_idempotency(
            &tx,
            request.run_id,
            &evidence.approval.idempotency_key,
        )? {
            let _ = existing;
            return Err(LedgerError::PromotionDecisionIdempotencyConflict {
                run_id: request.run_id.to_string(),
                idempotency_key: evidence.approval.idempotency_key.clone(),
            });
        }
        if promotion_decision_event_exists_for_approval(
            &tx,
            request.run_id,
            request.promotion_approval_request_event_id,
        )? {
            return Err(promotion_decision_reconciliation_required(
                request,
                "a promotion decision event exists without a trusted native decision projection",
            ));
        }

        // Only a first decision consumes live dispatch authority. Re-run the
        // evidence check with the current authority window enabled after all
        // idempotency/reconciliation exits above.
        let evidence =
            verify_governed_promotion_decision_evidence(&tx, request, authority, now, true)?;

        let payload = PromotionDecisionRecordedV1 {
            candidate_digest: evidence.candidate.candidate_digest.clone(),
            base_commit_sha: evidence.candidate.base_commit_sha.clone(),
            target_ref: Some(evidence.approval.target_ref.clone()),
            envelope_digest: evidence.dispatch_envelope_digest.clone(),
            acceptance_ref: evidence.acceptance.acceptance_ref.clone(),
            review_refs: evidence.approval.review_refs.clone(),
            promotion_approval_request_ref: Some(
                request.promotion_approval_request_event_id.to_string(),
            ),
            decision: request.decision,
            authority: authority.operator_signer.actor_id.clone(),
            decided_by: authority.operator_signer.actor_id.clone(),
            decided_at: timestamp(now),
            idempotency_key: evidence.approval.idempotency_key.clone(),
        };
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(request.promotion_approval_request_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::PromotionDecisionRecorded,
            occurred_at: now,
            payload: Payload::PromotionDecisionRecordedV1(payload.clone()),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, operator_signing_key, operator_signer, now)?;
        let event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        insert_governed_promotion_decision(
            &tx,
            request,
            &request_digest,
            &evidence,
            &event,
            &event_digest,
        )?;
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
            promotion_decision_event_id: event.id,
            promotion_decision_event_digest: event_digest,
            candidate_digest: payload.candidate_digest,
            idempotency_key: payload.idempotency_key,
        })
    }

    /// Seal one previously recorded operator decision through a checkpoint
    /// signed by the configured kernel authority. This operation is deliberately
    /// private to the native broker: it accepts no caller-provided event bytes,
    /// hashes, target ref, or Git receipt. A crash before the projection update
    /// is safe—the checkpoint can be discovered and the immutable decision is
    /// never reissued.
    pub fn seal_governed_promotion_decision_v1(
        &self,
        request: &GovernedPromotionDecisionSealRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
    ) -> Result<GovernedPromotionDecisionDispositionV1> {
        validate_governed_promotion_seal_request(request)?;
        validate_governed_promotion_signer(
            authority,
            kernel_signing_key,
            kernel_signer,
            PromotionSignerRoleV1::Kernel,
        )?;

        let stored = {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            let stored = governed_promotion_decision_by_event(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )?
            .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
                run_id: request.run_id.to_string(),
                candidate_digest: "unknown".into(),
                reason: "promotion decision has no native decision projection".into(),
            })?;
            verify_stored_governed_promotion_decision(&tx, &stored, authority)?;
            tx.commit()?;
            stored
        };

        if stored.state == StoredGovernedPromotionDecisionState::Sealed {
            let checkpoint = verified_kernel_checkpoint_by_id(
                &self.conn,
                request.run_id,
                stored.required_sealed_checkpoint_event_id()?,
                authority,
            )?;
            return Ok(GovernedPromotionDecisionDispositionV1::Sealed {
                promotion_decision_event_id: stored.promotion_decision_event_id,
                promotion_decision_event_digest: stored.promotion_decision_event_digest,
                candidate_digest: stored.candidate_digest,
                idempotency_key: stored.idempotency_key,
                checkpoint_event_id: checkpoint.event_id,
                checkpoint_event_digest: checkpoint.event_digest,
            });
        }

        let checkpoint = match fully_covering_kernel_checkpoint(
            &self.conn,
            request.run_id,
            request.promotion_decision_event_id,
            authority,
        )? {
            Some(checkpoint) => checkpoint,
            None => {
                let covered = self.signed_ordinary_events(&request.run_id)?;
                if covered.is_empty()
                    || !covered
                        .iter()
                        .any(|event| event.event_id == request.promotion_decision_event_id)
                {
                    return Err(LedgerError::PromotionDecisionReconciliationRequired {
                        run_id: request.run_id.to_string(),
                        candidate_digest: stored.candidate_digest.clone(),
                        reason:
                            "promotion decision is absent from the signed ordinary-event prefix"
                                .into(),
                    });
                }
                let checkpoint_event_id = self
                    .emit_checkpoint_for_current_signed_prefix(
                        &request.run_id,
                        kernel_signing_key,
                        kernel_signer,
                    )?
                    .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
                        run_id: request.run_id.to_string(),
                        candidate_digest: stored.candidate_digest.clone(),
                        reason:
                            "promotion decision checkpoint snapshot became empty before sealing"
                                .into(),
                    })?;
                self.record_sealed_checkpoint_for_promotion_decision(
                    request,
                    &stored,
                    authority,
                    checkpoint_event_id,
                )?
            }
        };

        self.mark_governed_promotion_decision_sealed(
            request,
            &stored,
            authority,
            checkpoint.event_id,
            &checkpoint.event_digest,
        )?;
        Ok(GovernedPromotionDecisionDispositionV1::Sealed {
            promotion_decision_event_id: stored.promotion_decision_event_id,
            promotion_decision_event_digest: stored.promotion_decision_event_digest,
            candidate_digest: stored.candidate_digest,
            idempotency_key: stored.idempotency_key,
            checkpoint_event_id: checkpoint.event_id,
            checkpoint_event_digest: checkpoint.event_digest,
        })
    }

    /// Reserve the one fixed target-ref effect named by a sealed, target-bound
    /// promotion decision.
    ///
    /// This is deliberately broker-private. It accepts only a decision event
    /// reference and bounded duration, derives every candidate/target fact
    /// from verified signed evidence, and returns the opaque lease only on the
    /// first durable grant. A replay observes `Pending`, `Recorded`, or
    /// `LeaseExpired`; none of those states can be reinterpreted as a fresh
    /// Git capability.
    pub fn claim_governed_promotion_execution_v1(
        &self,
        request: &GovernedPromotionExecutionClaimRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
    ) -> Result<GovernedPromotionExecutionClaimDispositionV1> {
        self.claim_governed_promotion_execution_v1_at(
            request,
            authority,
            kernel_signing_key,
            kernel_signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn claim_governed_promotion_execution_v1_at_for_tests(
        &self,
        request: &GovernedPromotionExecutionClaimRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionExecutionClaimDispositionV1> {
        self.claim_governed_promotion_execution_v1_at(
            request,
            authority,
            kernel_signing_key,
            kernel_signer,
            now,
        )
    }

    fn claim_governed_promotion_execution_v1_at(
        &self,
        request: &GovernedPromotionExecutionClaimRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionExecutionClaimDispositionV1> {
        validate_governed_promotion_execution_claim_request(request)?;
        validate_governed_promotion_signer(
            authority,
            kernel_signing_key,
            kernel_signer,
            PromotionSignerRoleV1::Kernel,
        )?;
        let now = canonical_ledger_timestamp(now)?;

        let granted = {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            let stored = governed_promotion_decision_by_event(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )?
            .ok_or_else(|| {
                promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim has no native decision projection",
                )
            })?;

            // Resolve a terminal result before any current-time validation. A
            // terminal row is immutable recovery evidence and must never be
            // mistaken for permission to issue another effect reservation.
            if let Some(existing_result) = governed_promotion_result_by_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )? {
                verify_existing_governed_promotion_result_for_claim(
                    &tx,
                    &existing_result,
                    &stored,
                    authority,
                )?;
                tx.commit()?;
                return Ok(GovernedPromotionExecutionClaimDispositionV1::Recorded {
                    promotion_result_event_id: existing_result.promotion_result_event_id,
                    promotion_result_event_digest: existing_result.promotion_result_event_digest,
                    outcome: existing_result.outcome,
                });
            }
            if promotion_result_event_exists_for_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )? {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "a promotion result event exists without a trusted native result projection",
                ));
            }

            // A durable claim is a one-shot reservation. Re-verify both the
            // projection and its signed event before classifying it, then
            // withhold the lease from all duplicate paths.
            if let Some(existing) = governed_promotion_execution_claim_by_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )? {
                verify_stored_governed_promotion_execution_claim(
                    &tx, &existing, &stored, authority,
                )?;
                let lease_expires_at = parse_claim_timestamp(&existing.lease_expires_at)?;
                let disposition = if now >= lease_expires_at {
                    GovernedPromotionExecutionClaimDispositionV1::LeaseExpired {
                        promotion_execution_claim_event_id: existing
                            .promotion_execution_claim_event_id,
                        lease_expires_at: existing.lease_expires_at,
                    }
                } else {
                    GovernedPromotionExecutionClaimDispositionV1::Pending {
                        promotion_execution_claim_event_id: existing
                            .promotion_execution_claim_event_id,
                        lease_expires_at: existing.lease_expires_at,
                    }
                };
                tx.commit()?;
                return Ok(disposition);
            }
            if promotion_execution_claim_event_exists_for_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )? {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "a promotion execution claim event exists without a trusted native claim projection",
                ));
            }

            if stored.state != StoredGovernedPromotionDecisionState::Sealed {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim requires a kernel-sealed promotion decision",
                ));
            }
            let verified =
                verified_governed_promotion_decision_from_stored(&tx, &stored, authority)?;
            verify_stored_governed_promotion_decision_seal(&tx, &stored, authority)?;
            if verified.decision.decision != PromotionDecisionKindV1::Promote {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "a rejected promotion decision cannot reserve a target-ref effect",
                ));
            }
            let target_ref = verified.decision.target_ref.as_deref().ok_or_else(|| {
                promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim requires a target-bound decision",
                )
            })?;
            if !is_canonical_target_ref(target_ref) {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim target ref is not canonical",
                ));
            }

            let dispatch_expires_at = parse_claim_timestamp(
                &verified.evidence.dispatch.body.expires_at,
            )
            .map_err(|_| {
                promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion dispatch expiry is not canonical RFC3339 UTC",
                )
            })?;
            let requested_lease_expires_at =
                now + Duration::milliseconds(request.lease_duration_ms as i64);
            let lease_expires_at = requested_lease_expires_at.min(dispatch_expires_at);
            if lease_expires_at <= now {
                return Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim has no remaining signed dispatch authority window",
                ));
            }

            let claimed_at = timestamp(now);
            let lease_expires_at = timestamp(lease_expires_at);
            let lease_id = Uuid::now_v7().to_string();
            let candidate = &verified.evidence.candidate;
            let mut claim = PromotionExecutionClaimedV1 {
                run_id: request.run_id.to_string(),
                promotion_decision_event_ref: stored.promotion_decision_event_id,
                promotion_decision_event_digest: stored.promotion_decision_event_digest.clone(),
                dispatch_event_ref: stored.dispatch_event_id,
                dispatch_envelope_digest: verified.evidence.dispatch_envelope_digest.clone(),
                candidate_digest: candidate.candidate_digest.clone(),
                candidate_ref: candidate.candidate_ref.clone(),
                candidate_commit_sha: candidate.candidate_commit_sha.clone(),
                candidate_tree_digest: candidate.tree_digest.clone(),
                base_commit_sha: candidate.base_commit_sha.clone(),
                target_ref: target_ref.to_string(),
                idempotency_key: stored.idempotency_key.clone(),
                authority_actor: authority.kernel_signer.actor_id.clone(),
                lease_id,
                claimed_at: claimed_at.clone(),
                lease_expires_at: lease_expires_at.clone(),
                promotion_execution_claim_digest: String::new(),
            };
            claim.promotion_execution_claim_digest = promotion_execution_claimed_v1_digest(&claim)
                .map_err(|error| {
                    promotion_execution_claim_reconciliation_required(
                        request,
                        format!("could not canonicalize promotion execution claim: {error}"),
                    )
                })?;
            let event = canonicalize(Event {
                id: EventId::new(),
                run_id: request.run_id,
                parent_event_id: Some(stored.promotion_decision_event_id),
                schema_version: Event::CURRENT_SCHEMA_VERSION,
                kind: EventKind::PromotionExecutionClaimedV1,
                occurred_at: now,
                payload: Payload::PromotionExecutionClaimedV1(claim.clone()),
            })?;
            validate_new_ordinary_event_id(&tx, &event)?;
            let signature = sign_event(&event, kernel_signing_key, kernel_signer, now)?;
            let event_digest = signature.canonical_event_hash.clone();
            insert_event(&tx, &event)?;
            insert_event_signature(&tx, &signature)?;
            insert_governed_promotion_execution_claim(
                &tx,
                &stored,
                &verified,
                &event,
                &event_digest,
                &claim,
            )?;
            tx.commit()?;
            (event, event_digest, claim)
        };
        self.record_ordinary_append(&granted.0);

        // A claim becomes usable only after its exact signed tape prefix is
        // checkpointed. If post-commit sealing fails, the immutable claim is
        // deliberately left visible only as a pending/reconciliation state;
        // this call never releases its lease a second time.
        match self.seal_governed_signed_prefix(
            &request.run_id,
            kernel_signing_key,
            kernel_signer,
        )? {
            GovernedCheckpointSealOutcome::AlreadySealed { .. }
            | GovernedCheckpointSealOutcome::Emitted { .. } => {
                Ok(GovernedPromotionExecutionClaimDispositionV1::Granted {
                    promotion_execution_claim_event_id: granted.0.id,
                    promotion_execution_claim_event_digest: granted.1,
                    claim: granted.2,
                })
            }
            GovernedCheckpointSealOutcome::EmptyPrefix => {
                Err(promotion_execution_claim_reconciliation_required(
                    request,
                    "promotion execution claim sealing found no signed governed prefix",
                ))
            }
        }
    }

    /// Record the one terminal result for a sealed promotion decision.
    ///
    /// This is intentionally a broker-private storage primitive rather than a
    /// generic ledger append: the candidate identity, idempotency key,
    /// decision reference, signer role, and completion time are recovered from
    /// sealed signed evidence. The caller may supply only the Git gateway's
    /// closed outcome and immutable observation. A duplicate request can reuse
    /// the exact prior result, but cannot create a second result or reopen the
    /// target-ref effect.
    ///
    /// The method seals the resulting signed prefix before returning. A crash
    /// after the ordinary result append but before that seal is conservative:
    /// the same result can be discovered and sealed, while a missing native
    /// projection remains reconciliation-only.
    pub fn record_governed_promotion_result_v1(
        &self,
        request: &GovernedPromotionResultRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
    ) -> Result<GovernedPromotionResultDispositionV1> {
        self.record_governed_promotion_result_v1_at(
            request,
            authority,
            kernel_signing_key,
            kernel_signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_governed_promotion_result_v1_at_for_tests(
        &self,
        request: &GovernedPromotionResultRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionResultDispositionV1> {
        self.record_governed_promotion_result_v1_at(
            request,
            authority,
            kernel_signing_key,
            kernel_signer,
            now,
        )
    }

    fn record_governed_promotion_result_v1_at(
        &self,
        request: &GovernedPromotionResultRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedPromotionResultDispositionV1> {
        validate_governed_promotion_result_request(request)?;
        validate_governed_promotion_signer(
            authority,
            kernel_signing_key,
            kernel_signer,
            PromotionSignerRoleV1::Kernel,
        )?;
        let now = canonical_ledger_timestamp(now)?;

        let disposition = {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            let stored = governed_promotion_decision_by_event(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )?
            .ok_or_else(|| {
                promotion_result_reconciliation_required(
                    request,
                    "promotion result has no native decision projection",
                )
            })?;
            if stored.state != StoredGovernedPromotionDecisionState::Sealed {
                return Err(promotion_result_reconciliation_required(
                    request,
                    "promotion result requires a kernel-sealed decision",
                ));
            }
            let verified =
                verified_governed_promotion_decision_from_stored(&tx, &stored, authority)?;
            verify_stored_governed_promotion_decision_seal(&tx, &stored, authority)?;

            if let Some(existing) = governed_promotion_result_by_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )? {
                let disposition = resolve_existing_governed_promotion_result(
                    &tx, &existing, request, &stored, &verified, authority,
                )?;
                tx.commit()?;
                disposition
            } else {
                if promotion_result_event_exists_for_decision(
                    &tx,
                    request.run_id,
                    request.promotion_decision_event_id,
                )? {
                    return Err(promotion_result_reconciliation_required(
                        request,
                        "a promotion result event exists without a trusted native result projection",
                    ));
                }
                validate_governed_promotion_result_against_decision(request, &stored, &verified)?;
                validate_governed_promotion_result_execution_lease(
                    &tx,
                    request,
                    &stored,
                    &verified,
                    authority,
                    Some(now),
                )?;
                let payload = PromotionResultRecordedV1 {
                    candidate_digest: stored.candidate_digest.clone(),
                    idempotency_key: stored.idempotency_key.clone(),
                    promotion_decision_ref: stored.promotion_decision_event_id.to_string(),
                    outcome: request.outcome,
                    merged_head_sha: request.merged_head_sha.clone(),
                    promotion_git_binding: request.promotion_git_binding.clone(),
                    promotion_execution_lease_binding: request
                        .promotion_execution_lease_binding
                        .clone(),
                    completed_at: timestamp(now),
                };
                let event = canonicalize(Event {
                    id: EventId::new(),
                    run_id: request.run_id,
                    parent_event_id: Some(stored.promotion_decision_event_id),
                    schema_version: Event::CURRENT_SCHEMA_VERSION,
                    kind: EventKind::PromotionResultRecorded,
                    occurred_at: now,
                    payload: Payload::PromotionResultRecordedV1(payload.clone()),
                })?;
                validate_new_ordinary_event_id(&tx, &event)?;
                let signature = sign_event(&event, kernel_signing_key, kernel_signer, now)?;
                let event_digest = signature.canonical_event_hash.clone();
                insert_event(&tx, &event)?;
                insert_event_signature(&tx, &signature)?;
                insert_governed_promotion_result(&tx, &stored, &event, &event_digest, &payload)?;
                tx.commit()?;
                self.record_ordinary_append(&event);
                GovernedPromotionResultDispositionV1::Recorded {
                    promotion_result_event_id: event.id,
                    promotion_result_event_digest: event_digest,
                    outcome: payload.outcome,
                }
            }
        };

        // The result is a governed kernel record. Re-open/retry behavior must
        // observe a complete signed prefix, never an unsigned tail. A failure
        // here leaves the immutable result discoverable but returns an error;
        // callers must reconcile/seal rather than issue Git again.
        match self.seal_governed_signed_prefix(
            &request.run_id,
            kernel_signing_key,
            kernel_signer,
        )? {
            GovernedCheckpointSealOutcome::AlreadySealed { .. }
            | GovernedCheckpointSealOutcome::Emitted { .. } => Ok(disposition),
            GovernedCheckpointSealOutcome::EmptyPrefix => {
                Err(promotion_result_reconciliation_required(
                    request,
                    "promotion result sealing found no signed governed prefix",
                ))
            }
        }
    }

    /// Claim the one fixed read-only verifier activity named by signed V3
    /// evidence. This is deliberately narrower than the generic claim API:
    /// callers can name only event references and a bounded lease, while the
    /// action identity is re-derived from a signed `ActionRequestedV2` record.
    ///
    /// It is intended for a host-realm CLI/runner that independently verifies
    /// its target repository binding and pins a read-only verifier command.
    /// This method does not accept command text, paths, environment, or any
    /// action/idempotency strings, so those values cannot be substituted after
    /// the dispatch was signed.
    pub fn claim_governed_verifier_v1(
        &self,
        request: &GovernedVerifierClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityClaimDispositionV1> {
        self.claim_governed_verifier_v1_at(request, authority, signing_key, signer, Utc::now())
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn claim_governed_verifier_v1_at_for_tests(
        &self,
        request: &GovernedVerifierClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityClaimDispositionV1> {
        self.claim_governed_verifier_v1_at(request, authority, signing_key, signer, now)
    }

    fn claim_governed_verifier_v1_at(
        &self,
        request: &GovernedVerifierClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityClaimDispositionV1> {
        require_protected_governed_realm(authority)?;
        let action_request_event = load_verified_authority_event(
            &self.conn,
            request.action_request_event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "governed verifier action request",
        )?;
        if action_request_event.run_id != request.run_id {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier action request run_id does not match the claim".into(),
            });
        }
        let Payload::ActionRequestedV2(action_request) = action_request_event.payload else {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier requires a signed action_requested_v2 event".into(),
            });
        };
        if action_request.action_kind != ActionKindV1::Process
            || action_request.execution_role != ExecutionRoleV1::Reviewer
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier requires a signed reviewer process action".into(),
            });
        }
        let derived = ActivityClaimRequestV1 {
            run_id: request.run_id,
            activity_id: action_request.action_id,
            idempotency_key: action_request.idempotency_key,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms: request.lease_duration_ms,
        };
        self.claim_activity_v1_at(
            &derived,
            authority,
            signing_key,
            signer,
            now,
            ActivityClaimPurposeV1::GovernedVerifierV1,
        )
    }

    /// Atomically record a terminal result for a granted activity lease.
    ///
    /// A result after lease expiry cannot claim success or failure because the
    /// host may already have lost certainty about the effect. The only safe
    /// post-expiry terminal transition is `Unknown`, which blocks replay until
    /// a higher-level reconciliation procedure decides what to do.
    pub fn record_activity_result_v1(
        &self,
        request: &ActivityResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_activity_result_v1_at(request, authority, signing_key, signer, Utc::now())
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_activity_result_v1_at_for_tests(
        &self,
        request: &ActivityResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_activity_result_v1_at(request, authority, signing_key, signer, now)
    }

    fn record_activity_result_v1_at(
        &self,
        request: &ActivityResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        validate_activity_result_request(request)?;
        validate_claim_signer(authority, signing_key, signer)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let existing =
            activity_claim_by_idempotency(&tx, request.run_id, &request.idempotency_key)?
                .ok_or_else(|| LedgerError::ActivityClaimNotFound {
                    run_id: request.run_id.to_string(),
                    idempotency_key: request.idempotency_key.clone(),
                })?;
        if existing.activity_id != request.activity_id {
            return Err(activity_claim_conflict_from_result(request));
        }

        // The SQLite row is an index over signed tape, not a substitute for
        // it. Validate the grant before using its lease and validate a terminal
        // result before replaying it to a duplicate recorder.
        verify_signed_claim_projection(&tx, &existing, authority)?;

        if existing.state == StoredActivityClaimState::Recorded {
            verify_signed_activity_result_projection(&tx, &existing, authority)?;
            let disposition = existing_result_disposition(&existing, request)?;
            tx.commit()?;
            return Ok(disposition);
        }
        if existing.lease_id != request.lease_id {
            return Err(LedgerError::ActivityClaimLeaseMismatch {
                run_id: request.run_id.to_string(),
                idempotency_key: request.idempotency_key.clone(),
            });
        }

        let lease_expires_at = effective_activity_lease_expiry(&tx, &existing, authority)?;
        if now >= lease_expires_at && request.outcome != ActivityResultOutcomeV1::Unknown {
            tx.commit()?;
            return Ok(ActivityResultDispositionV1::LeaseExpired {
                claim_event_id: existing.claim_event_id,
                lease_expires_at: timestamp(lease_expires_at),
            });
        }

        let recorded_at = timestamp(now);
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(existing.claim_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityResultRecordedV1,
            occurred_at: now,
            payload: Payload::ActivityResultRecordedV1(ActivityResultRecordedV1 {
                run_id: request.run_id,
                activity_id: request.activity_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                claim_event_id: existing.claim_event_id,
                claim_event_digest: existing.claim_event_digest.clone(),
                lease_id: request.lease_id.clone(),
                outcome: request.outcome,
                result_digest: request.result_digest.clone(),
                result_ref: request.result_ref.clone(),
                evidence_digest: request.evidence_digest.clone(),
                evidence_ref: request.evidence_ref.clone(),
                recorded_at: recorded_at.clone(),
            }),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, signer, now)?;
        let result_event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        let updated = tx.execute(
            r#"UPDATE activity_claims
               SET state = 'recorded',
                   result_event_id = ?1,
                   result_event_digest = ?2,
                   result_outcome = ?3,
                   result_digest = ?4,
                   result_ref = ?5,
                   evidence_digest = ?6,
                   evidence_ref = ?7,
                   recorded_at = ?8
               WHERE run_id = ?9 AND idempotency_key = ?10 AND state = 'granted'"#,
            params![
                event.id.to_string(),
                &result_event_digest,
                activity_result_outcome_wire(request.outcome),
                &request.result_digest,
                &request.result_ref,
                &request.evidence_digest,
                &request.evidence_ref,
                &recorded_at,
                request.run_id.to_string(),
                &request.idempotency_key,
            ],
        )?;
        if updated != 1 {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity claim terminal transition did not update exactly one row".into(),
            });
        }
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(ActivityResultDispositionV1::Recorded {
            result_event_id: event.id,
            result_event_digest,
            outcome: request.outcome,
        })
    }

    /// Atomically extend a granted activity lease with one signed heartbeat.
    ///
    /// The caller supplies no new dispatch or action authority: the original
    /// claim's signed tape lineage is reconstructed first, then the extension
    /// is capped to the same original lease duration and current signed
    /// dispatch deadline. A repeated `heartbeat_id` replays the one signed
    /// heartbeat only when every request identity field matches exactly.
    pub fn heartbeat_activity_v1(
        &self,
        request: &ActivityHeartbeatRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityHeartbeatDispositionV1> {
        self.heartbeat_activity_v1_at(request, authority, signing_key, signer, Utc::now())
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn heartbeat_activity_v1_at_for_tests(
        &self,
        request: &ActivityHeartbeatRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityHeartbeatDispositionV1> {
        self.heartbeat_activity_v1_at(request, authority, signing_key, signer, now)
    }

    fn heartbeat_activity_v1_at(
        &self,
        request: &ActivityHeartbeatRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityHeartbeatDispositionV1> {
        validate_activity_heartbeat_request(request)?;
        validate_claim_signer(authority, signing_key, signer)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let claim = activity_claim_by_idempotency(&tx, request.run_id, &request.idempotency_key)?
            .ok_or_else(|| LedgerError::ActivityClaimNotFound {
            run_id: request.run_id.to_string(),
            idempotency_key: request.idempotency_key.clone(),
        })?;
        if claim.activity_id != request.activity_id {
            return Err(activity_heartbeat_conflict(request));
        }
        if claim.lease_id != request.lease_id {
            return Err(LedgerError::ActivityClaimLeaseMismatch {
                run_id: request.run_id.to_string(),
                idempotency_key: request.idempotency_key.clone(),
            });
        }

        // The SQLite claim and heartbeat rows are indexes only. Verify the
        // immutable claim before relying on any identity or current expiry.
        verify_signed_claim_projection(&tx, &claim, authority)?;
        let request_digest = activity_heartbeat_request_digest(request)?;

        // Resolve an exact, already-recorded heartbeat before looking at the
        // mutable terminal state or current lease liveness. A caller can lose
        // the response and retry after a result lands or the lease expires;
        // that retry must return the one signed result, never create a new
        // authority event. The signed heartbeat itself binds both cache keys
        // so a damaged projection cannot remap another request here.
        if let Some(existing) =
            activity_heartbeat_by_id(&tx, request.run_id, &request.heartbeat_id)?
        {
            verify_signed_activity_heartbeat_projection(&tx, &claim, &existing, authority, true)?;
            if existing.request_digest != request_digest {
                return Err(activity_heartbeat_conflict(request));
            }
            tx.commit()?;
            return Ok(ActivityHeartbeatDispositionV1::Existing {
                heartbeat_event_id: existing.heartbeat_event_id,
                heartbeat_event_digest: existing.heartbeat_event_digest,
                lease_expires_at: existing.lease_expires_at,
            });
        }

        if claim.state == StoredActivityClaimState::Recorded {
            verify_signed_activity_result_projection(&tx, &claim, authority)?;
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "terminal activity results cannot receive a heartbeat".into(),
            });
        }
        let current_expiry = effective_activity_lease_expiry(&tx, &claim, authority)?;
        if now >= current_expiry {
            tx.commit()?;
            return Ok(ActivityHeartbeatDispositionV1::LeaseExpired {
                claim_event_id: claim.claim_event_id,
                lease_expires_at: timestamp(current_expiry),
            });
        }

        let dispatch_window = verify_current_activity_claim_authority(&tx, &claim, authority, now)?;
        let requested_expiry = now + Duration::milliseconds(claim.lease_duration_ms as i64);
        let next_expiry = requested_expiry.min(dispatch_window.effective_deadline);
        if next_expiry <= current_expiry {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat cannot advance the effective lease before the signed dispatch deadline".into(),
            });
        }

        let heartbeat_at = timestamp(now);
        let prior_lease_expires_at = timestamp(current_expiry);
        let lease_expires_at = timestamp(next_expiry);
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(claim.claim_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityHeartbeatRecordedV1,
            occurred_at: now,
            payload: Payload::ActivityHeartbeatRecordedV1(ActivityHeartbeatRecordedV1 {
                run_id: request.run_id,
                activity_id: request.activity_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                heartbeat_id: Some(request.heartbeat_id.clone()),
                heartbeat_request_digest: Some(request_digest.clone()),
                claim_event_id: claim.claim_event_id,
                claim_event_digest: claim.claim_event_digest.clone(),
                lease_id: request.lease_id.clone(),
                dispatch_event_id: claim.dispatch_event_id,
                dispatch_envelope_digest: claim.dispatch_envelope_digest.clone(),
                lease_expires_at: lease_expires_at.clone(),
                heartbeat_at: heartbeat_at.clone(),
            }),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, signer, now)?;
        let heartbeat_event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        insert_activity_heartbeat(
            &tx,
            request,
            &request_digest,
            &claim,
            &event,
            &heartbeat_event_digest,
            &prior_lease_expires_at,
            &lease_expires_at,
            &heartbeat_at,
        )?;
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(ActivityHeartbeatDispositionV1::Recorded {
            heartbeat_event_id: event.id,
            heartbeat_event_digest,
            lease_expires_at,
        })
    }

    /// Record a fixed-verifier terminal result without exposing the action
    /// identity or idempotency key on the host-facing boundary. The lease is
    /// resolved through the tape-backed claim projection and the normal result
    /// transition still verifies that projection and enforces exactly-once
    /// semantics.
    pub fn record_governed_verifier_result_v1(
        &self,
        request: &GovernedVerifierResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_verifier_result_v1_at(
            request,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_governed_verifier_result_v1_at_for_tests(
        &self,
        request: &GovernedVerifierResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_verifier_result_v1_at(request, authority, signing_key, signer, now)
    }

    fn record_governed_verifier_result_v1_at(
        &self,
        request: &GovernedVerifierResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        require_protected_governed_realm(authority)?;
        if request.lease_id.trim().is_empty() {
            return Err(LedgerError::InvalidPayload {
                kind: "record_governed_verifier_result_v1".into(),
                reason: "lease_id must be non-empty".into(),
            });
        }
        let claim = activity_claim_by_lease(&self.conn, request.run_id, &request.lease_id)?
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier lease does not name a signed activity claim".into(),
            })?;
        verify_governed_verifier_claim_lineage(&self.conn, &claim, authority)?;
        if claim.action_kind != ActionKindV1::Process {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier lease does not name a reviewer process action".into(),
            });
        }
        let action_request_event = load_verified_authority_event(
            &self.conn,
            claim.action_request_event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "governed verifier action request",
        )?;
        let Payload::ActionRequestedV2(action_request) = action_request_event.payload else {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier lease action request is not action_requested_v2".into(),
            });
        };
        if action_request.action_kind != ActionKindV1::Process
            || action_request.execution_role != ExecutionRoleV1::Reviewer
            || action_request.action_id != claim.activity_id
            || action_request.idempotency_key != claim.idempotency_key
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed verifier lease does not bind a signed reviewer process action"
                    .into(),
            });
        }
        let derived = ActivityResultRequestV1 {
            run_id: request.run_id,
            activity_id: claim.activity_id,
            idempotency_key: claim.idempotency_key,
            lease_id: request.lease_id.clone(),
            outcome: request.outcome,
            result_digest: request.result_digest.clone(),
            result_ref: request.result_ref.clone(),
            evidence_digest: request.evidence_digest.clone(),
            evidence_ref: request.evidence_ref.clone(),
        };
        self.record_activity_result_v1_at(&derived, authority, signing_key, signer, now)
    }

    /// Append one already-derived checkpoint inside the caller's transaction.
    /// Every caller acquires an immediate transaction spanning its prefix
    /// snapshot and this insertion, so checkpoint predecessor selection cannot
    /// race another checkpoint writer.
    fn emit_checkpoint_in_transaction(
        &self,
        tx: &Transaction<'_>,
        run_id: &RunId,
        covered: &[SignedOrdinaryEvent],
        prior: Option<StoredCheckpoint>,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<EventId> {
        let through = covered
            .last()
            .expect("checkpoint requires >=1 covered event");
        let hashes: Vec<String> = covered
            .iter()
            .map(|e| e.canonical_event_hash.clone())
            .collect();
        let root = tape_root_hash(&hashes);

        let checkpoint_index = prior.as_ref().map(|p| p.checkpoint_index + 1).unwrap_or(0);
        let previous_checkpoint_event_id = prior.as_ref().map(|p| p.event_id);

        let payload = TapeCheckpointV1 {
            run_id: *run_id,
            checkpoint_index,
            through_event_id: through.event_id,
            through_event_count: covered.len() as u64,
            previous_checkpoint_event_id,
            tape_root_hash: root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        };

        let checkpoint_event = Event {
            id: EventId::new(),
            run_id: *run_id,
            parent_event_id: Some(through.event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::TapeCheckpoint,
            occurred_at: Utc::now(),
            payload: Payload::TapeCheckpointV1(payload),
        };

        // Sign the exact checkpoint payload before inserting it into the
        // caller-owned transaction.
        let signature = sign_event(&checkpoint_event, signing_key, signer, Utc::now())?;

        insert_event(tx, &checkpoint_event)?;
        #[cfg(any(test, feature = "test-support"))]
        if self.fail_next_checkpoint_signature_insert.replace(false) {
            // Test-only injected fault: drop the tx without committing so the
            // checkpoint event row rolls back with its (never-inserted)
            // signature. Mirrors a real signature-insert failure.
            return Err(LedgerError::AppendOnlyViolation(
                "injected checkpoint signature insert failure (test only)".into(),
            ));
        }
        insert_event_signature(tx, &signature)?;
        Ok(checkpoint_event.id)
    }

    /// Arm a one-shot fault that makes the next checkpoint signature insert fail
    /// after the checkpoint event row has been inserted in the same transaction.
    /// Test-only — used to prove the checkpoint's fail-closed rollback. Gated
    /// behind `cfg(test)`/`test-support` so it cannot exist on release builds.
    #[cfg(any(test, feature = "test-support"))]
    pub fn fail_next_checkpoint_signature_insert_for_tests(&self) {
        self.fail_next_checkpoint_signature_insert.set(true);
    }

    /// The id of the most recently appended NON-checkpoint event for a run,
    /// id-ordered (UUIDv7 = time order), or `None` if the run has no ordinary
    /// events. Used ONCE per run to lazily seed the in-memory monotonic-id
    /// high-water mark (`latest_ordinary_id`); the per-append guard then reads
    /// the in-memory mark, so this query never runs on the hot path.
    ///
    /// Checkpoints are excluded deliberately (Codex gate round 2 regression
    /// fix): a `tape_checkpoint` id is minted by `emit_checkpoint` AFTER the
    /// events it covers, so it can be greater than a subsequent legitimate
    /// ordinary event whose id was generated earlier (batched/pre-generated
    /// ids). Comparing the incoming ordinary id against the latest event of ANY
    /// kind would then falsely reject that ordinary event. The ordinary-event
    /// sequence must never be constrained by an internally-minted checkpoint id.
    fn latest_ordinary_event_id_for_run(&self, run_id: &RunId) -> Result<Option<EventId>> {
        let last: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM events
                 WHERE run_id = ?1 AND kind != 'tape_checkpoint'
                 ORDER BY id DESC LIMIT 1",
                params![run_id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        match last {
            Some(s) => Ok(Some(parse_event_id(&s, "events")?)),
            None => Ok(None),
        }
    }

    /// All signed, non-checkpoint events for a run, id-ordered (tape order),
    /// paired with their stored canonical event hash. Only events with a
    /// persisted signature row are returned — checkpoints cover signed events.
    fn signed_ordinary_events(&self, run_id: &RunId) -> Result<Vec<SignedOrdinaryEvent>> {
        signed_ordinary_events_for_connection(&self.conn, run_id)
    }

    #[cfg(test)]
    fn latest_checkpoint(&self, run_id: &RunId) -> Result<Option<StoredCheckpoint>> {
        latest_checkpoint_for_connection(&self.conn, run_id)
    }

    /// Read all events for a run, ordered by id (UUIDv7 = time-ordered).
    pub fn events_for_run(&self, run_id: &str) -> Result<Vec<StoredEventRow>> {
        events_for_run_for_connection(&self.conn, run_id)
    }

    /// Read events with explicit detached-signature verification status.
    pub fn verified_events_for_run(
        &self,
        run_id: &str,
        trusted_keys: &TrustedPublicKeys,
    ) -> Result<Vec<VerifiedEventRow>> {
        let rows = self.events_for_run(run_id)?;
        rows.into_iter()
            .map(|event_row| {
                let event = event_row.to_event()?;
                let Some(signature_row) = self.signature_for_event(&event_row.id)? else {
                    return Ok(VerifiedEventRow {
                        event: event_row,
                        signature: None,
                        verification: VerificationStatus::Unsigned,
                    });
                };

                if signature_row.algorithm != "ed25519" {
                    return Ok(VerifiedEventRow {
                        event: event_row,
                        signature: None,
                        verification: VerificationStatus::UnsupportedAlgorithm,
                    });
                }

                let signature = signature_row.to_event_signature()?;
                let verification = verify_event_signature(&event, &signature, trusted_keys);
                Ok(VerifiedEventRow {
                    event: event_row,
                    signature: Some(signature),
                    verification,
                })
            })
            .collect()
    }

    fn signature_for_event(&self, event_id: &str) -> Result<Option<StoredEventSignatureRow>> {
        signature_for_event_for_connection(&self.conn, event_id)
    }

    /// Read every event of `run_id` in tape order (`id ASC`), each paired with
    /// its detached signature if present. Powers the signed-tape export, which
    /// needs the reconstructed event (to recompute the exact signed canonical
    /// bytes) alongside its stored signature.
    pub fn signed_events_for_run(
        &self,
        run_id: &str,
    ) -> Result<Vec<(Event, Option<EventSignatureV1>)>> {
        signed_events_for_run_for_connection(&self.conn, run_id)
    }

    /// Count events in the store (for test convenience).
    pub fn event_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// Expose the raw connection for use by tests that need to assert
    /// append-only behavior. Not part of the stable API; gated behind
    /// `cfg(test)`/`test-support` so it is absent from release builds.
    #[cfg(any(test, feature = "test-support"))]
    pub fn conn_for_tests(&self) -> &Connection {
        &self.conn
    }

    fn record_sealed_checkpoint_for_promotion_decision(
        &self,
        request: &GovernedPromotionDecisionSealRequestV1,
        stored: &StoredGovernedPromotionDecision,
        authority: &GovernedPromotionAuthorityV1,
        checkpoint_event_id: EventId,
    ) -> Result<PromotionCheckpointEvidence> {
        let checkpoint = fully_covering_kernel_checkpoint(
            &self.conn,
            request.run_id,
            request.promotion_decision_event_id,
            authority,
        )?
        .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
            run_id: request.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "new kernel checkpoint did not cover every signed ordinary event through the promotion decision".into(),
        })?;
        if checkpoint.event_id != checkpoint_event_id {
            return Err(LedgerError::PromotionDecisionReconciliationRequired {
                run_id: request.run_id.to_string(),
                candidate_digest: stored.candidate_digest.clone(),
                reason: "a concurrent checkpoint changed the sealed promotion prefix; reopen trusted recovery before proceeding".into(),
            });
        }
        Ok(checkpoint)
    }

    fn mark_governed_promotion_decision_sealed(
        &self,
        request: &GovernedPromotionDecisionSealRequestV1,
        expected: &StoredGovernedPromotionDecision,
        authority: &GovernedPromotionAuthorityV1,
        checkpoint_event_id: EventId,
        checkpoint_event_digest: &str,
    ) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = governed_promotion_decision_by_event(
            &tx,
            request.run_id,
            request.promotion_decision_event_id,
        )?
        .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
            run_id: request.run_id.to_string(),
            candidate_digest: expected.candidate_digest.clone(),
            reason: "promotion decision projection disappeared before kernel sealing".into(),
        })?;
        verify_stored_governed_promotion_decision(&tx, &current, authority)?;
        match current.state {
            StoredGovernedPromotionDecisionState::Sealed => {
                let current_checkpoint = verified_kernel_checkpoint_by_id(
                    &tx,
                    request.run_id,
                    current.required_sealed_checkpoint_event_id()?,
                    authority,
                )?;
                if current_checkpoint.event_id != checkpoint_event_id
                    || current_checkpoint.event_digest != checkpoint_event_digest
                {
                    return Err(LedgerError::PromotionDecisionReconciliationRequired {
                        run_id: request.run_id.to_string(),
                        candidate_digest: current.candidate_digest,
                        reason: "promotion decision was sealed by a different checkpoint; reopen trusted recovery before proceeding".into(),
                    });
                }
            }
            StoredGovernedPromotionDecisionState::AwaitingKernelCheckpoint => {
                let updated = tx.execute(
                    r#"UPDATE governed_promotion_decisions
                       SET state = 'sealed',
                           sealed_checkpoint_event_id = ?1,
                           sealed_checkpoint_event_digest = ?2,
                           sealed_at = ?3
                       WHERE run_id = ?4
                         AND promotion_decision_event_id = ?5
                         AND state = 'awaiting_kernel_checkpoint'"#,
                    params![
                        checkpoint_event_id.to_string(),
                        checkpoint_event_digest,
                        Utc::now().to_rfc3339(),
                        request.run_id.to_string(),
                        request.promotion_decision_event_id.to_string(),
                    ],
                )?;
                if updated != 1 {
                    return Err(LedgerError::PromotionDecisionReconciliationRequired {
                        run_id: request.run_id.to_string(),
                        candidate_digest: current.candidate_digest,
                        reason:
                            "kernel seal did not advance exactly one promotion decision projection"
                                .into(),
                    });
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Flush the WAL and fsync. Returns the id of the most recently appended
    /// event (useful for flush_ack).
    pub fn flush_fsync(&self) -> Result<Option<crate::id::EventId>> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        let last: Option<String> = self
            .conn
            .query_row("SELECT id FROM events ORDER BY id DESC LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;

        match last {
            Some(s) => {
                let uuid = uuid::Uuid::parse_str(&s).map_err(|e| {
                    LedgerError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    ))
                })?;
                Ok(Some(crate::id::EventId::from_uuid(uuid)))
            }
            None => Ok(None),
        }
    }
}

fn workflow_instance_snapshot_cache_error(reason: impl Into<String>) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: WORKFLOW_INSTANCE_SNAPSHOT_CACHE_KIND.to_string(),
        reason: reason.into(),
    }
}

fn canonical_workflow_instance_snapshot_cache_json(
    workflow_json: &str,
) -> Result<serde_json::Value> {
    if workflow_json.is_empty()
        || workflow_json.len() > WORKFLOW_INSTANCE_SNAPSHOT_CACHE_MAX_WORKFLOW_JSON_BYTES_V1
    {
        return Err(workflow_instance_snapshot_cache_error(
            "workflow_json must be non-empty and within the cache size limit",
        ));
    }
    let value: serde_json::Value = serde_json::from_str(workflow_json).map_err(|error| {
        workflow_instance_snapshot_cache_error(format!("workflow_json is not valid JSON: {error}"))
    })?;
    let canonical = serde_json::to_string(&value).map_err(|error| {
        workflow_instance_snapshot_cache_error(format!(
            "workflow_json could not be serialized canonically: {error}"
        ))
    })?;
    if canonical != workflow_json {
        return Err(workflow_instance_snapshot_cache_error(
            "workflow_json must use the canonical JSON representation",
        ));
    }
    if !value.is_object() {
        return Err(workflow_instance_snapshot_cache_error(
            "workflow_json must be a JSON object",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod flush_fsync_tests {
    use super::*;

    #[test]
    fn flush_fsync_on_empty_store_succeeds() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.flush_fsync().unwrap();
    }

    #[test]
    fn flush_fsync_after_append_returns_last_event_id() {
        use crate::event::Event;
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let store = SqliteStore::open_in_memory().unwrap();
        let event = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "0".into(),
                event_count: "0".into(),
                unit_count: "0".into(),
            }),
        };
        store.append(&event).unwrap();
        let last = store.flush_fsync().unwrap();
        assert_eq!(last, Some(event.id));
    }
}

#[cfg(test)]
mod latest_checkpoint_signature_tests {
    use super::*;
    use crate::payload::checkpoint::{TapeCheckpointV1, TapeRootAlgorithm};

    fn unsigned_checkpoint_event(run_id: RunId) -> Event {
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::TapeCheckpoint,
            occurred_at: Utc::now(),
            payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
                run_id,
                checkpoint_index: 0,
                through_event_id: EventId::new(),
                through_event_count: 7,
                previous_checkpoint_event_id: None,
                tape_root_hash: "sha256:unsigned".into(),
                algorithm: TapeRootAlgorithm::Sha256Linear,
            }),
        }
    }

    #[test]
    fn latest_checkpoint_ignores_unsigned_checkpoint_rows() {
        // Gate round 2, fix #3 (defense-in-depth): even a checkpoint row that
        // somehow lands without a signature must NOT be trusted for cadence.
        // We insert a raw, UNSIGNED tape_checkpoint row directly (bypassing the
        // public guarded entry points) and assert `latest_checkpoint` returns
        // None — the JOIN on event_signatures filters it out.
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();

        let unsigned_cp = unsigned_checkpoint_event(run_id);
        insert_event(&store.conn, &unsigned_cp).unwrap();

        assert!(
            store.latest_checkpoint(&run_id).unwrap().is_none(),
            "an unsigned checkpoint row must never be trusted by latest_checkpoint"
        );
    }

    #[test]
    fn latest_checkpoint_returns_signed_checkpoint_rows() {
        // The JOIN must still surface a properly SIGNED checkpoint. Emit a real
        // one through the signed path, then confirm latest_checkpoint sees it.
        use crate::signing::ActorKeyRef;
        use ed25519_dalek::SigningKey;

        let store = SqliteStore::open_in_memory().unwrap();
        let key = SigningKey::from_bytes(&[21u8; 32]);
        let signer = ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        };
        let run_id = RunId::new();
        let policy = CheckpointPolicy::every(1);

        let event = Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::RunStarted,
            occurred_at: Utc::now(),
            payload: Payload::RunStartedV1(crate::payload::run_lifecycle::RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: std::collections::BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        };
        let emitted = store
            .append_signed_with_checkpoint(&event, &key, &signer, &policy)
            .unwrap();
        assert_eq!(emitted.len(), 1, "cadence-1 must emit a checkpoint");

        let latest = store
            .latest_checkpoint(&run_id)
            .unwrap()
            .expect("a signed checkpoint must be returned");
        assert_eq!(latest.event_id, emitted[0]);
    }
}

#[cfg(test)]
mod tape_prefix_root_tests {
    use super::*;

    #[test]
    fn prefix_roots_match_the_canonical_tape_root_contract() {
        let hashes = vec![
            "sha256:one".to_owned(),
            "sha256:two\nwith-newline".to_owned(),
            "sha256:three".to_owned(),
        ];
        let covered = hashes
            .iter()
            .map(|canonical_event_hash| SignedOrdinaryEvent {
                event_id: EventId::new(),
                canonical_event_hash: canonical_event_hash.clone(),
            })
            .collect::<Vec<_>>();

        assert!(
            tape_prefix_roots(&[]).is_empty(),
            "the empty signed prefix has no checkpointable root"
        );

        let actual = tape_prefix_roots(&covered);
        assert_eq!(actual.len(), hashes.len());
        for (index, root) in actual.iter().enumerate() {
            assert_eq!(
                root,
                &tape_root_hash(&hashes[..=index]),
                "rolling prefix {index} must preserve the exact newline-joined tape-root wire contract",
            );
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredActivityClaimState {
    Granted,
    Recorded,
}

#[derive(Clone, Debug)]
struct StoredActivityClaim {
    run_id: RunId,
    idempotency_key: String,
    activity_id: String,
    action_kind: ActionKindV1,
    action_request_event_id: EventId,
    action_request_digest: String,
    dispatch_event_id: EventId,
    dispatch_envelope_digest: String,
    authority_actor: String,
    claim_event_id: EventId,
    claim_event_digest: String,
    lease_id: String,
    lease_expires_at: String,
    lease_duration_ms: u64,
    state: StoredActivityClaimState,
    result_event_id: Option<EventId>,
    result_event_digest: Option<String>,
    result_outcome: Option<ActivityResultOutcomeV1>,
    result_digest: Option<String>,
    result_ref: Option<String>,
    evidence_digest: Option<String>,
    evidence_ref: Option<String>,
    recorded_at: Option<String>,
}

/// Durable, non-authoritative cache row for one signed heartbeat. Every read
/// path re-verifies its corresponding tape event before using it to derive an
/// effective lease expiry.
#[derive(Clone, Debug)]
struct StoredActivityHeartbeat {
    run_id: RunId,
    heartbeat_id: String,
    request_digest: String,
    claim_event_id: EventId,
    claim_event_digest: String,
    activity_id: String,
    idempotency_key: String,
    lease_id: String,
    dispatch_event_id: EventId,
    dispatch_envelope_digest: String,
    heartbeat_event_id: EventId,
    heartbeat_event_digest: String,
    prior_lease_expires_at: String,
    lease_expires_at: String,
    heartbeat_at: String,
}

#[derive(Clone, Debug)]
struct VerifiedClaimEvidence {
    action_kind: ActionKindV1,
    action_request_digest: String,
    dispatch_envelope_digest: String,
    effective_deadline: DateTime<Utc>,
}

/// Authority fields always come from the immutable V3 envelope. A graph-bound
/// V4 dispatch adds topology around those fields, so its *outer* digest is the
/// lineage value every action, claim, intent, and promotion record must carry.
/// Returning both explicitly prevents a caller from accidentally using the
/// nested V3 digest as an executable V4 capability.
#[derive(Clone, Debug)]
struct DispatchAuthorityMaterialV1 {
    dispatch: DispatchEnvelopeV3,
    lineage_envelope_digest: String,
    is_graph_bound_v4: bool,
}

fn dispatch_authority_material(payload: &Payload) -> Option<DispatchAuthorityMaterialV1> {
    match payload {
        Payload::DispatchEnvelopeV3(dispatch) => Some(DispatchAuthorityMaterialV1 {
            dispatch: dispatch.clone(),
            lineage_envelope_digest: dispatch.envelope_digest.clone(),
            is_graph_bound_v4: false,
        }),
        Payload::DispatchEnvelopeV4(dispatch) => Some(DispatchAuthorityMaterialV1 {
            dispatch: dispatch.dispatch_v3.clone(),
            lineage_envelope_digest: dispatch.envelope_digest.clone(),
            is_graph_bound_v4: true,
        }),
        _ => None,
    }
}

/// Full verified tape material used only while native code issues a
/// `ModelActionIntentV1`. Keeping the original typed payloads private to this
/// module prevents callers from treating a SQLite projection as authority.
#[derive(Clone, Debug)]
struct VerifiedModelActionIntentIssueEvidence {
    dispatch: DispatchEnvelopeV3,
    dispatch_envelope_digest: String,
    dispatch_is_graph_bound_v4: bool,
    action_request: ActionRequestedV2,
    action_request_digest: String,
}

#[derive(Clone, Debug)]
struct StoredModelActionIntent {
    run_id: RunId,
    action_request_event_id: EventId,
    dispatch_event_id: EventId,
    action_request_digest: String,
    model_request_evidence_digest: String,
    trust_scope_evidence_digest: String,
    intent_event_id: EventId,
    intent_digest: String,
    created_at: String,
}

/// Durable cache row for a V2 authorization and the exact model lease it
/// issued. This projection is never authority by itself: retry, result, and
/// heartbeat paths reconstruct and verify the signed intent, V2 event, and
/// claim before using it.
#[derive(Clone, Debug)]
struct StoredModelActionAuthorization {
    run_id: RunId,
    action_request_event_id: EventId,
    dispatch_event_id: EventId,
    action_request_digest: String,
    intent_event_id: EventId,
    intent_digest: String,
    authorization_event_id: EventId,
    authorization_event_digest: String,
    authorization_ref: String,
    authorization_digest: String,
    authorization_expires_at: String,
    claim_event_id: EventId,
    created_at: String,
}

/// Verified, immutable V2 chain returned only to native storage code while it
/// is resolving a retry or deriving current model-lease authority.
#[derive(Clone, Debug)]
struct VerifiedGovernedModelAuthorization {
    intent: ModelActionIntentV1,
    authorization: ModelActionAuthorizedV2,
    dispatch_window: GovernedDispatchWindow,
    authorized_at: DateTime<Utc>,
}

/// The admission window evaluated for one claimed governed dispatch. The
/// window is re-derived from the signed tape at claim time; no mutable
/// projection can move the not-before or effective-deadline boundary.
#[derive(Clone, Debug)]
struct GovernedDispatchWindow {
    issued_at: DateTime<Utc>,
    effective_deadline: DateTime<Utc>,
}

/// Internal result of issuing or recovering the native model write-ahead
/// intent while an outer immediate transaction is still open. Keeping the
/// signed event here lets the caller update the in-process ordinary-event
/// high-water mark only after the enclosing transaction commits.
#[derive(Clone, Debug)]
struct ModelActionIntentInTx {
    intent_event_id: EventId,
    intent: ModelActionIntentV1,
    appended_event: Option<Event>,
}

impl ModelActionIntentInTx {
    fn into_public_disposition(self) -> ModelActionIntentIssueDispositionV1 {
        let disposition = if self.appended_event.is_some() {
            ModelActionIntentIssueDispositionV1::Issued {
                intent_event_id: self.intent_event_id,
                intent_digest: self.intent.intent_digest.clone(),
                model_request_evidence: self.intent.model_request_evidence.clone(),
                trust_scope_evidence: self.intent.trust_scope_evidence.clone(),
            }
        } else {
            ModelActionIntentIssueDispositionV1::Existing {
                intent_event_id: self.intent_event_id,
                intent_digest: self.intent.intent_digest.clone(),
                model_request_evidence: self.intent.model_request_evidence.clone(),
                trust_scope_evidence: self.intent.trust_scope_evidence.clone(),
            }
        };
        disposition
    }
}

/// The transaction-scoped half of model-intent issuance. It is shared by the
/// compatibility `governed-model-intent-v1` control and the model authority
/// operation below so a new intent, V2 authorization, and lease can commit as
/// one SQLite transaction. CAS objects written before a rollback are
/// unreachable by tape and therefore harmless.
fn issue_model_action_intent_v1_in_tx<F>(
    conn: &Connection,
    request: &ModelActionIntentIssueRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    clock: &mut F,
) -> Result<ModelActionIntentInTx>
where
    F: FnMut() -> DateTime<Utc>,
{
    // `ModelActionIntentV1.intended_at` is required by replay to equal the
    // event timestamp. Normalize to the tape's millisecond RFC3339 form
    // before using the value for either field so sub-millisecond clock
    // precision cannot create a self-invalidating signed event.
    let initial_now = canonical_ledger_timestamp(clock())?;

    if let Some(existing) = model_action_intent_by_action_request(
        conn,
        request.run_id,
        request.action_request_event_id,
    )? {
        let existing_intent =
            verify_signed_model_action_intent_projection(conn, &existing, cas, authority, request)?;
        return Ok(ModelActionIntentInTx {
            intent_event_id: existing.intent_event_id,
            intent: existing_intent,
            appended_event: None,
        });
    }

    if model_action_intent_event_exists_for_action_request(
        conn,
        request.run_id,
        request.action_request_event_id,
    )? {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "a model action intent already exists without a trusted native idempotency projection"
                .into(),
        });
    }

    let evidence =
        verify_model_action_intent_issue_evidence(conn, request, authority, initial_now)?;
    ensure_model_action_intent_lifecycle_is_open(conn, request, &evidence)?;
    ensure_single_model_action_intent_for_sealed_dispatch_attempt(conn, request, &evidence)?;
    let (model_request_evidence, trust_scope_evidence) =
        create_model_action_intent_evidence_documents(cas, request, &evidence)?;

    // CAS reads/writes above may take arbitrarily longer than the dispatch's
    // remaining authority window. Re-sample and re-validate the signed
    // authority as the last operation before constructing and signing the
    // event; the timestamp on the intent/event/signature is this fresh value
    // rather than the earlier pre-I/O observation.
    let now = canonical_ledger_timestamp(clock())?;
    let evidence = verify_model_action_intent_issue_evidence(conn, request, authority, now)?;
    let intended_at = timestamp(now);
    let mut intent = ModelActionIntentV1 {
        run_id: request.run_id.to_string(),
        workflow_id: evidence.action_request.workflow_id.clone(),
        unit_id: evidence.action_request.unit_id.clone(),
        attempt: evidence.action_request.attempt,
        provenance_ref: evidence.action_request.provenance_ref.clone(),
        action_id: evidence.action_request.action_id.clone(),
        idempotency_key: evidence.action_request.idempotency_key.clone(),
        dispatch_event_ref: request.dispatch_event_id,
        dispatch_envelope_digest: evidence.dispatch_envelope_digest.clone(),
        action_request_event_ref: request.action_request_event_id,
        action_request_digest: evidence.action_request_digest.clone(),
        canonical_input_ref: evidence.action_request.canonical_input_ref.clone(),
        canonical_input_digest: evidence.action_request.canonical_input_digest.clone(),
        model_request_evidence,
        trust_scope_evidence,
        // The first native issuer supports implementer-only model actions.
        // Review-like roles require a separately native-derived immutable
        // candidate view before they can receive model authority.
        candidate_binding: None,
        intent_actor: authority.claim_signer.actor_id.clone(),
        intended_at: intended_at.clone(),
        intent_digest: String::new(),
    };
    intent.intent_digest = model_action_intent_v1_digest(&intent).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("could not canonicalize model action intent: {error}"),
        }
    })?;
    let event = canonicalize(Event {
        id: EventId::new(),
        run_id: request.run_id,
        parent_event_id: Some(request.action_request_event_id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ModelActionIntentV1,
        occurred_at: now,
        payload: Payload::ModelActionIntentV1(intent.clone()),
    })?;
    validate_new_ordinary_event_id(conn, &event)?;
    let signature = sign_event(&event, signing_key, signer, now)?;
    insert_event(conn, &event)?;
    insert_event_signature(conn, &signature)?;
    insert_model_action_intent_projection(
        conn,
        request,
        &evidence.action_request_digest,
        &event,
        &intent,
        &intended_at,
    )?;

    Ok(ModelActionIntentInTx {
        intent_event_id: event.id,
        intent,
        appended_event: Some(event),
    })
}

fn validate_trusted_actor(label: &str, actor: &ActorKeyRef) -> Result<()> {
    if actor.actor_id.trim().is_empty() || actor.key_id.trim().is_empty() {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} must include non-empty actor_id and key_id"),
        });
    }
    let Some(public_key_hash) = actor.public_key_hash.as_deref() else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} must include an explicit public_key_hash"),
        });
    };
    if !is_canonical_sha256_digest(public_key_hash) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} public_key_hash must be a canonical sha256 digest"),
        });
    }
    Ok(())
}

fn validate_claim_signer(
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let expected = &authority.claim_signer;
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "append signer does not match the explicitly configured claim authority".into(),
        });
    }
    Ok(())
}

fn require_protected_governed_realm(authority: &ActivityClaimAuthorityV1) -> Result<()> {
    if authority.ledger_authority_realm_digest.is_none() {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed verifier requires a protected host-realm activity authority".into(),
        });
    }
    Ok(())
}

fn require_protected_model_intent_realm(authority: &ActivityClaimAuthorityV1) -> Result<()> {
    if authority.ledger_authority_realm_digest.is_none() {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent issuance requires a protected host-realm authority".into(),
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PromotionSignerRoleV1 {
    Kernel,
    Operator,
}

fn signer_identity_key(signer: &ActorKeyRef) -> (String, String, String) {
    (
        signer.actor_id.clone(),
        signer.key_id.clone(),
        signer.public_key_hash.clone().unwrap_or_default(),
    )
}

fn validate_promotion_trusted_actor(label: &str, actor: &ActorKeyRef) -> Result<()> {
    if actor.actor_id.trim().is_empty() || actor.key_id.trim().is_empty() {
        return Err(LedgerError::PromotionAuthorityRejected {
            reason: format!("{label} must include non-empty actor_id and key_id"),
        });
    }
    let Some(public_key_hash) = actor.public_key_hash.as_deref() else {
        return Err(LedgerError::PromotionAuthorityRejected {
            reason: format!("{label} must include an explicit public_key_hash"),
        });
    };
    if !is_canonical_sha256_digest(public_key_hash) {
        return Err(LedgerError::PromotionAuthorityRejected {
            reason: format!("{label} public_key_hash must be a canonical sha256 digest"),
        });
    }
    Ok(())
}

fn validate_governed_promotion_signer(
    authority: &GovernedPromotionAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    role: PromotionSignerRoleV1,
) -> Result<()> {
    let expected = match role {
        PromotionSignerRoleV1::Kernel => &authority.kernel_signer,
        PromotionSignerRoleV1::Operator => &authority.operator_signer,
    };
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return Err(LedgerError::PromotionAuthorityRejected {
            reason: match role {
                PromotionSignerRoleV1::Kernel => {
                    "append signer does not match the explicitly configured kernel promotion authority"
                        .into()
                }
                PromotionSignerRoleV1::Operator => {
                    "append signer does not match the explicitly configured operator promotion authority"
                        .into()
                }
            },
        });
    }
    Ok(())
}

fn validate_governed_promotion_decision_request(
    request: &GovernedPromotionDecisionRequestV1,
) -> Result<()> {
    if request.review_event_ids.is_empty() {
        return Err(LedgerError::PromotionAuthorityRejected {
            reason: "promotion decision requires at least one immutable review event".into(),
        });
    }
    let mut distinct_reviews = HashSet::new();
    for review_event_id in &request.review_event_ids {
        if !distinct_reviews.insert(*review_event_id) {
            return Err(LedgerError::PromotionAuthorityRejected {
                reason: "promotion decision review event ids must be unique".into(),
            });
        }
    }
    Ok(())
}

fn validate_governed_promotion_seal_request(
    _request: &GovernedPromotionDecisionSealRequestV1,
) -> Result<()> {
    // EventId/RunId are typed UUID values, so there is no caller-controlled
    // string grammar to validate here. Retain a dedicated validation hook so a
    // future request revision cannot silently add ambient authority fields.
    Ok(())
}

fn governed_promotion_decision_request_digest(
    request: &GovernedPromotionDecisionRequestV1,
) -> Result<String> {
    #[derive(serde::Serialize)]
    struct Material {
        schema_version: u8,
        run_id: String,
        dispatch_event_id: String,
        candidate_created_event_id: String,
        candidate_completion_event_id: String,
        acceptance_event_id: String,
        review_event_ids: Vec<String>,
        promotion_approval_request_event_id: String,
        decision: PromotionDecisionKindV1,
    }

    let material = Material {
        schema_version: 1,
        run_id: request.run_id.to_string(),
        dispatch_event_id: request.dispatch_event_id.to_string(),
        candidate_created_event_id: request.candidate_created_event_id.to_string(),
        candidate_completion_event_id: request.candidate_completion_event_id.to_string(),
        acceptance_event_id: request.acceptance_event_id.to_string(),
        review_event_ids: request
            .review_event_ids
            .iter()
            .map(ToString::to_string)
            .collect(),
        promotion_approval_request_event_id: request
            .promotion_approval_request_event_id
            .to_string(),
        decision: request.decision,
    };
    let encoded = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.governed-promotion-decision-request.v1\0");
    hasher.update(encoded);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn promotion_decision_reconciliation_required(
    request: &GovernedPromotionDecisionRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::PromotionDecisionReconciliationRequired {
        run_id: request.run_id.to_string(),
        // The candidate digest is deliberately not caller input. Until the
        // signed candidate record has been re-derived, reporting the event id
        // as a digest would turn a diagnostic field into misleading evidence.
        candidate_digest: "unknown".into(),
        reason: reason.into(),
    }
}

fn model_action_authorization_reconciliation_required(
    request: &GovernedModelActionAuthorizeAndClaimRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::ModelActionAuthorizationReconciliationRequired {
        run_id: request.run_id.to_string(),
        action_request_event_id: request.action_request_event_id.to_string(),
        reason: reason.into(),
    }
}

/// Stable provider idempotency key for a native V2 authorization. This is
/// intentionally derived from the protected realm and immutable tape
/// references rather than accepted from a worker, so a retry cannot switch to
/// a second external provider effect.
fn governed_model_action_authorization_ref(
    authority: &ActivityClaimAuthorityV1,
    request: &GovernedModelActionAuthorizeAndClaimRequestV1,
    intent_event_id: EventId,
    intent_digest: &str,
) -> Result<String> {
    let realm = authority
        .ledger_authority_realm_digest
        .as_deref()
        .ok_or_else(|| LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action authorization requires a protected host-realm authority".into(),
        })?;
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.governed-model-authorization-ref.v1\\0");
    let run_id = request.run_id.to_string();
    let dispatch_event_id = request.dispatch_event_id.to_string();
    let action_request_event_id = request.action_request_event_id.to_string();
    let intent_event_id = intent_event_id.to_string();
    for value in [
        realm,
        run_id.as_str(),
        dispatch_event_id.as_str(),
        action_request_event_id.as_str(),
        intent_event_id.as_str(),
        intent_digest,
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    Ok(format!(
        "buildplane:model-action-authorization:v2:sha256:{:x}",
        hasher.finalize()
    ))
}

fn validate_activity_claim_request(request: &ActivityClaimRequestV1) -> Result<()> {
    if request.activity_id.trim().is_empty() || request.idempotency_key.trim().is_empty() {
        return Err(LedgerError::InvalidPayload {
            kind: "claim_activity_v1".into(),
            reason: "activity_id and idempotency_key must be non-empty".into(),
        });
    }
    if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&request.lease_duration_ms) {
        return Err(LedgerError::InvalidPayload {
            kind: "claim_activity_v1".into(),
            reason: format!(
                "lease_duration_ms must be between {MIN_ACTIVITY_LEASE_MS} and {MAX_ACTIVITY_LEASE_MS}"
            ),
        });
    }
    Ok(())
}

fn validate_governed_model_action_authorize_and_claim_request(
    request: &GovernedModelActionAuthorizeAndClaimRequestV1,
) -> Result<()> {
    let derived = ActivityClaimRequestV1 {
        run_id: request.run_id,
        // These values are intentionally placeholders for the shared lease
        // bounds check only. The protected transaction derives the real action
        // identity from signed tape before it creates any event.
        activity_id: "governed-model-action".into(),
        idempotency_key: "governed-model-action".into(),
        dispatch_event_id: request.dispatch_event_id,
        action_request_event_id: request.action_request_event_id,
        lease_duration_ms: request.lease_duration_ms,
    };
    validate_activity_claim_request(&derived).map_err(|error| match error {
        LedgerError::InvalidPayload { reason, .. } => LedgerError::InvalidPayload {
            kind: "authorize_and_claim_governed_model_action_v1".into(),
            reason,
        },
        other => other,
    })
}

fn validate_activity_result_request(request: &ActivityResultRequestV1) -> Result<()> {
    if request.activity_id.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
        || request.lease_id.trim().is_empty()
        || request.evidence_ref.trim().is_empty()
    {
        return Err(LedgerError::InvalidPayload {
            kind: "record_activity_result_v1".into(),
            reason: "activity_id, idempotency_key, lease_id, and evidence_ref must be non-empty"
                .into(),
        });
    }
    if !is_canonical_sha256_digest(&request.evidence_digest) {
        return Err(LedgerError::InvalidPayload {
            kind: "record_activity_result_v1".into(),
            reason: "evidence_digest must be a canonical sha256 digest".into(),
        });
    }
    match (&request.result_digest, &request.result_ref, request.outcome) {
        (Some(digest), Some(reference), _) => {
            if !is_canonical_sha256_digest(digest) || reference.trim().is_empty() {
                return Err(LedgerError::InvalidPayload {
                    kind: "record_activity_result_v1".into(),
                    reason: "result_digest must be canonical and result_ref must be non-empty"
                        .into(),
                });
            }
        }
        (None, None, ActivityResultOutcomeV1::Succeeded) => {
            return Err(LedgerError::InvalidPayload {
                kind: "record_activity_result_v1".into(),
                reason: "succeeded results require result_digest and result_ref".into(),
            })
        }
        (None, None, _) => {}
        _ => {
            return Err(LedgerError::InvalidPayload {
                kind: "record_activity_result_v1".into(),
                reason: "result_digest and result_ref must be present together".into(),
            })
        }
    }
    if request.outcome == ActivityResultOutcomeV1::Unknown
        && (request.result_digest.is_some() || request.result_ref.is_some())
    {
        return Err(LedgerError::InvalidPayload {
            kind: "record_activity_result_v1".into(),
            reason: "unknown results must not assert a result".into(),
        });
    }
    Ok(())
}

fn validate_activity_heartbeat_request(request: &ActivityHeartbeatRequestV1) -> Result<()> {
    if request.activity_id.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
        || request.lease_id.trim().is_empty()
        || request.heartbeat_id.trim().is_empty()
    {
        return Err(LedgerError::InvalidPayload {
            kind: "heartbeat_activity_v1".into(),
            reason: "activity_id, idempotency_key, lease_id, and heartbeat_id must be non-empty"
                .into(),
        });
    }
    Ok(())
}

fn verify_claim_evidence(
    conn: &Connection,
    request: &ActivityClaimRequestV1,
    authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<VerifiedClaimEvidence> {
    let dispatch_event = load_verified_authority_event(
        conn,
        request.dispatch_event_id,
        &authority.trusted_keys,
        &authority.dispatch_signer,
        "dispatch",
    )?;
    if dispatch_event.run_id != request.run_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "dispatch event run_id does not match activity claim".into(),
        });
    }
    let dispatch_material = dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: "claim requires a signed dispatch_envelope_v3 or graph-bound dispatch_envelope_v4 event".into(),
        }
    })?;
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    let dispatch_window = validate_governed_dispatch(&dispatch, now)?;

    let action_request_event = load_verified_authority_event(
        conn,
        request.action_request_event_id,
        &authority.trusted_keys,
        &authority.action_request_signer,
        "action request",
    )?;
    if action_request_event.run_id != request.run_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request event run_id does not match activity claim".into(),
        });
    }
    if action_request_event.parent_event_id != Some(request.dispatch_event_id) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request event does not name the claimed dispatch as its parent".into(),
        });
    }
    let action_request = match action_request_event.payload {
        Payload::ActionRequestedV2(request) => request,
        _ => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "claim requires a signed action_requested_v2 event".into(),
            })
        }
    };
    validate_action_request_matches_dispatch(
        request,
        &action_request,
        &dispatch,
        &dispatch_envelope_digest,
        authority,
        dispatch_window.issued_at,
        now,
    )?;
    // A `ModelActionIntentV1` is write-ahead evidence, not provider-effect
    // authority. The generic claim control cannot validate or consume the
    // intent/authorization/provider idempotency chain atomically, so allowing
    // it to lease `model` would let a host start a model request before the
    // dedicated native model-authority transaction exists. Keep this lane
    // closed until that transaction issues and consumes the exact V2 model
    // authorization under the same protected authority boundary.
    if action_request.action_kind == ActionKindV1::Model {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "model activity claims require the dedicated native model authority transaction; generic activity claims cannot start provider effects".into(),
        });
    }
    let action_request_digest = action_requested_v2_digest(&action_request).map_err(|error| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("could not canonicalize action request: {error}"),
        }
    })?;
    Ok(VerifiedClaimEvidence {
        action_kind: action_request.action_kind,
        action_request_digest,
        dispatch_envelope_digest,
        effective_deadline: dispatch_window.effective_deadline,
    })
}

/// Reconstruct the exact model action from signed tape before the native
/// issuer creates its evidence descriptors. This is intentionally independent
/// of the generic activity-claim flow: a model intent is write-ahead evidence,
/// not a lease or provider-effect authorization.
fn verify_model_action_intent_issue_evidence(
    conn: &Connection,
    issue: &ModelActionIntentIssueRequestV1,
    authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<VerifiedModelActionIntentIssueEvidence> {
    let dispatch_event = load_verified_authority_event(
        conn,
        issue.dispatch_event_id,
        &authority.trusted_keys,
        &authority.dispatch_signer,
        "dispatch",
    )?;
    if dispatch_event.run_id != issue.run_id {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "dispatch event run_id does not match model action intent issue".into(),
        });
    }
    let dispatch_material = dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent requires a signed dispatch_envelope_v3 or graph-bound dispatch_envelope_v4 event".into(),
        }
    })?;
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    let dispatch_is_graph_bound_v4 = dispatch_material.is_graph_bound_v4;
    let dispatch_window = validate_governed_dispatch(&dispatch, now).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("model action intent dispatch is not governed authority: {error}"),
        }
    })?;

    let action_request_event = load_verified_authority_event(
        conn,
        issue.action_request_event_id,
        &authority.trusted_keys,
        &authority.action_request_signer,
        "action request",
    )?;
    if action_request_event.run_id != issue.run_id {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "action request event run_id does not match model action intent issue".into(),
        });
    }
    if action_request_event.parent_event_id != Some(issue.dispatch_event_id) {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "action request event does not name the model intent dispatch as its parent"
                .into(),
        });
    }
    let action_request = match action_request_event.payload {
        Payload::ActionRequestedV2(request) => request,
        _ => {
            return Err(LedgerError::ModelActionIntentAuthorityRejected {
                reason: "model action intent requires a signed action_requested_v2 event".into(),
            })
        }
    };
    let claim = ActivityClaimRequestV1 {
        run_id: issue.run_id,
        activity_id: action_request.action_id.clone(),
        idempotency_key: action_request.idempotency_key.clone(),
        dispatch_event_id: issue.dispatch_event_id,
        action_request_event_id: issue.action_request_event_id,
        lease_duration_ms: MIN_ACTIVITY_LEASE_MS,
    };
    validate_action_request_matches_dispatch(
        &claim,
        &action_request,
        &dispatch,
        &dispatch_envelope_digest,
        authority,
        dispatch_window.issued_at,
        now,
    )
    .map_err(|error| LedgerError::ModelActionIntentAuthorityRejected {
        reason: format!("model action request does not bind the signed governed dispatch: {error}"),
    })?;
    if action_request.action_kind != ActionKindV1::Model {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent may bind only a signed model action request".into(),
        });
    }
    if action_request.execution_role != ExecutionRoleV1::Implementer {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent issuer currently supports only implementer model actions; review roles require a native candidate-view issuer"
                .into(),
        });
    }
    let canonical_input_ref =
        CanonicalCasRef::parse(&action_request.canonical_input_ref).map_err(|_| {
            LedgerError::ModelActionIntentAuthorityRejected {
                reason: "model action canonical_input_ref must be a strict protected-CAS reference"
                    .into(),
            }
        })?;
    let canonical_input_digest = CanonicalCasRef::from_digest(
        action_request.canonical_input_digest.clone(),
    )
    .map_err(|_| LedgerError::ModelActionIntentAuthorityRejected {
        reason: "model action canonical_input_digest must be a canonical raw CAS digest".into(),
    })?;
    if canonical_input_ref.digest() != canonical_input_digest.digest() {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action canonical input reference does not name its raw digest".into(),
        });
    }
    let action_request_digest = action_requested_v2_digest(&action_request).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("could not canonicalize model action request: {error}"),
        }
    })?;
    Ok(VerifiedModelActionIntentIssueEvidence {
        dispatch,
        dispatch_envelope_digest,
        dispatch_is_graph_bound_v4,
        action_request,
        action_request_digest,
    })
}

/// Refuse to introduce a native model intent after the action has reached a
/// terminal or incompatible authority state. The replay reducer rejects this
/// ordering too; enforcing it under the issuer's `BEGIN IMMEDIATE` lock keeps
/// native issuance from appending an event that its own canonical replay can
/// never accept.
///
/// The scan is deliberately fail-closed for every tape record that claims the
/// exact action/workflow lifecycle, even if that record would later prove
/// malformed or untrusted. A corrupt or externally appended terminal record
/// may block this new authority operation, but it cannot cause the issuer to
/// manufacture a second, replay-poisoning transition.
fn ensure_model_action_intent_lifecycle_is_open(
    conn: &Connection,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
         FROM events \
         WHERE run_id = ?1 \
           AND kind IN ( \
             'action_receipt_recorded_v2', \
             'action_receipt_set_recorded_v1', \
             'model_action_authorized_v1', \
             'model_action_authorized_v2' \
           ) \
         ORDER BY id ASC",
    )?;
    let rows = statement.query_map(params![issue.run_id.to_string()], |row| {
        Ok(StoredEventRow {
            id: row.get(0)?,
            run_id: row.get(1)?,
            parent_event_id: row.get(2)?,
            schema_version: row.get(3)?,
            kind: row.get(4)?,
            occurred_at: row.get(5)?,
            payload: row.get(6)?,
        })
    })?;
    for row in rows {
        let event = row?.to_event()?;
        let reason = match &event.payload {
            Payload::ActionReceiptRecordedV2(receipt)
                if action_receipt_targets_model_intent_issue(receipt, evidence) =>
            {
                Some("a terminal action receipt already exists for this model action")
            }
            Payload::ActionReceiptSetRecordedV1(receipt_set)
                if receipt_set_targets_model_intent_issue(receipt_set, evidence) =>
            {
                Some("the action receipt set is already sealed for this workflow attempt")
            }
            Payload::ModelActionAuthorizedV1(authorization)
                if model_authorization_v1_targets_model_intent_issue(
                    authorization,
                    issue,
                    evidence,
                ) =>
            {
                Some("an incompatible prior model authorization already exists for this action")
            }
            // A V2 authorization must parent to a model intent. If a malformed
            // record names the raw action request directly, do not try to
            // repair that tape by appending a later intent.
            Payload::ModelActionAuthorizedV2(_)
                if event.parent_event_id == Some(issue.action_request_event_id) =>
            {
                Some("an incompatible model authorization already parents to this action request")
            }
            _ => None,
        };
        if let Some(reason) = reason {
            return Err(model_action_intent_evidence_rejected_message(format!(
                "cannot issue model action intent because {reason} (event {})",
                event.id
            )));
        }
    }
    Ok(())
}

/// A signed `max_tokens` ceiling cannot safely be reissued in full to more
/// than one provider effect. Until the authority protocol has a transactional
/// token-reservation ledger, a sealed V3 dispatch attempt admits exactly one
/// native model intent. The caller's normal retry is the same action/request
/// idempotency key; an ambiguous or unknown effect must reconcile, never mint
/// a second model request under the same envelope.
///
/// Scan immutable tape events rather than trusting the SQLite projection. A
/// corrupted/missing projection may deny availability but must not expand the
/// number of provider effects the native issuer can authorize.
fn ensure_single_model_action_intent_for_sealed_dispatch_attempt(
    conn: &Connection,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
		 FROM events \
		 WHERE run_id = ?1 AND kind = 'model_action_intent_v1' \
		 ORDER BY id ASC",
    )?;
    let rows = statement.query_map(params![issue.run_id.to_string()], |row| {
        Ok(StoredEventRow {
            id: row.get(0)?,
            run_id: row.get(1)?,
            parent_event_id: row.get(2)?,
            schema_version: row.get(3)?,
            kind: row.get(4)?,
            occurred_at: row.get(5)?,
            payload: row.get(6)?,
        })
    })?;
    for row in rows {
        let event = row?.to_event()?;
        let event_id = event.id;
        let Payload::ModelActionIntentV1(intent) = event.payload else {
            return Err(model_action_intent_evidence_rejected_message(
                "model action intent event query returned a non-intent payload",
            ));
        };
        if intent.dispatch_event_ref == issue.dispatch_event_id
            && intent.dispatch_envelope_digest == evidence.dispatch_envelope_digest
        {
            return Err(model_action_intent_evidence_rejected_message(format!(
				"sealed_v3 dispatch attempt already has a native model intent (event {}); exactly one model provider effect is permitted before token-reservation support exists",
				event_id
			)));
        }
    }
    Ok(())
}

fn action_receipt_targets_model_intent_issue(
    receipt: &ActionReceiptRecordedV2,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> bool {
    let action = &evidence.action_request;
    receipt.run_id == action.run_id
        && receipt.workflow_id == action.workflow_id
        && receipt.unit_id == action.unit_id
        && receipt.attempt == action.attempt
        && receipt.provenance_ref == action.provenance_ref
        && receipt.action_id == action.action_id
        && receipt.idempotency_key == action.idempotency_key
        && receipt.action_request_digest == evidence.action_request_digest
        && receipt.dispatch_envelope_digest == action.dispatch_envelope_digest
        && receipt.capability_bundle_digest == action.capability_bundle_digest
        && receipt.policy_digest == action.policy_digest
        && receipt.context_manifest_digest == action.context_manifest_digest
        && receipt.worker_manifest_digest == action.worker_manifest_digest
        && receipt.sandbox_profile_digest == action.sandbox_profile_digest
        && receipt.authority_actor == action.authority_actor
        && receipt.execution_role == action.execution_role
}

fn receipt_set_targets_model_intent_issue(
    receipt_set: &ActionReceiptSetRecordedV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> bool {
    let action = &evidence.action_request;
    receipt_set.run_id == action.run_id
        && receipt_set.workflow_id == action.workflow_id
        && receipt_set.unit_id == action.unit_id
        && receipt_set.attempt == action.attempt
        && receipt_set.provenance_ref == action.provenance_ref
        && receipt_set.dispatch_envelope_digest == action.dispatch_envelope_digest
}

fn model_authorization_v1_targets_model_intent_issue(
    authorization: &ModelActionAuthorizedV1,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> bool {
    let action = &evidence.action_request;
    authorization.run_id == action.run_id
        && authorization.workflow_id == action.workflow_id
        && authorization.unit_id == action.unit_id
        && authorization.attempt == action.attempt
        && authorization.provenance_ref == action.provenance_ref
        && authorization.action_id == action.action_id
        && authorization.idempotency_key == action.idempotency_key
        && authorization.dispatch_event_ref == issue.dispatch_event_id.to_string()
        && authorization.dispatch_envelope_digest == action.dispatch_envelope_digest
        && authorization.action_request_ref == issue.action_request_event_id.to_string()
        && authorization.action_request_digest == evidence.action_request_digest
        && authorization.canonical_input_digest == action.canonical_input_digest
        && authorization.context_manifest_digest == action.context_manifest_digest
        && authorization.policy_digest == action.policy_digest
        && authorization.sandbox_profile_digest == action.sandbox_profile_digest
        && authorization.execution_role == action.execution_role
}

/// Reuse the established V3 evidence-field verifier while keeping the actual
/// graph-bound V4 digest intact in the evidence document. The verifier's V3
/// digest comparison is an authority-field integrity check, so for V4 it is
/// evaluated against ephemeral normalized copies only after the real binding
/// has proved that both the action and document carry the outer V4 digest.
fn validate_model_action_binding_against_verified_dispatch(
    binding: &ModelActionEvidenceBindingV1,
    action: &ActionRequestedV2,
    dispatch_event_ref: EventId,
    action_request_event_ref: EventId,
    dispatch: &DispatchEnvelopeV3,
    dispatch_envelope_digest: &str,
    dispatch_is_graph_bound_v4: bool,
) -> Result<()> {
    binding.verify_against_action_requested_v2(
        action,
        dispatch_event_ref,
        action_request_event_ref,
    )?;
    if action.dispatch_envelope_digest != dispatch_envelope_digest
        || binding.dispatch_envelope_digest != dispatch_envelope_digest
    {
        return Err(LedgerError::InvalidPayload {
            kind: "model_action_evidence_binding_v1".into(),
            reason: "model action evidence must bind the verified outer dispatch envelope digest"
                .into(),
        });
    }
    if !dispatch_is_graph_bound_v4 {
        return validate_model_action_binding_against_replayed_dispatch_v3(
            binding,
            action,
            dispatch_event_ref,
            action_request_event_ref,
            dispatch,
        );
    }

    let mut normalized_binding = binding.clone();
    normalized_binding.dispatch_envelope_digest = dispatch.envelope_digest.clone();
    let mut normalized_action = action.clone();
    normalized_action.dispatch_envelope_digest = dispatch.envelope_digest.clone();
    normalized_binding.action_request_digest = action_requested_v2_digest(&normalized_action)
        .map_err(|error| LedgerError::InvalidPayload {
            kind: "model_action_evidence_binding_v1".into(),
            reason: format!(
                "could not canonicalize V4-normalized model action request for V3 authority checks: {error}"
            ),
        })?;
    validate_model_action_binding_against_replayed_dispatch_v3(
        &normalized_binding,
        &normalized_action,
        dispatch_event_ref,
        action_request_event_ref,
        dispatch,
    )
}

/// Derive the two immutable evidence documents only after the exact dispatch
/// and action have been reconstructed from signed tape. The raw canonical
/// model-input object must already exist in the protected CAS because its
/// reference and raw digest were sealed into `ActionRequestedV2` before this
/// write-ahead intent is issued.
///
/// CAS writes deliberately happen before the tape append. A crash can leave
/// unreachable immutable blobs, but it can never create a signed intent whose
/// evidence documents were not written, re-read, parsed, and cross-checked.
fn create_model_action_intent_evidence_documents(
    cas: &Cas,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> Result<(ModelRequestEvidenceV1, TrustScopeEvidenceV1)> {
    let input_bytes = cas
        .get_verified_canonical_bytes(
            &evidence.action_request.canonical_input_ref,
            &evidence.action_request.canonical_input_digest,
        )
        .map_err(model_action_intent_evidence_rejected)?;
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &evidence.action_request.canonical_input_ref,
        &evidence.action_request.canonical_input_digest,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    let binding = ModelActionEvidenceBindingV1::from_action_requested_v2(
        &evidence.action_request,
        issue.dispatch_event_id,
        issue.action_request_event_id,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    validate_model_action_binding_against_verified_dispatch(
        &binding,
        &evidence.action_request,
        issue.dispatch_event_id,
        issue.action_request_event_id,
        &evidence.dispatch,
        &evidence.dispatch_envelope_digest,
        evidence.dispatch_is_graph_bound_v4,
    )
    .map_err(model_action_intent_evidence_rejected)?;

    let model_document =
        ModelRequestEvidenceDocumentV1::from_verified_canonical_input(binding, &verified_input)
            .map_err(model_action_intent_evidence_rejected)?;
    let model_bytes = model_request_evidence_document_v1_bytes(&model_document)
        .map_err(model_action_intent_evidence_rejected)?;
    let model_reference = cas
        .put_canonical_bytes(&model_bytes)
        .map_err(model_action_intent_evidence_rejected)?;
    let model_request_evidence = model_request_evidence_v1_descriptor(&model_reference);

    // Re-read the protected object by its new raw descriptor before deriving
    // the dependent scope. This catches a bad CAS implementation or a future
    // refactor that accidentally substitutes a semantic digest for a raw one.
    let stored_model_bytes = cas
        .get_verified_canonical_bytes(
            &model_request_evidence.cas_ref,
            &model_request_evidence.digest,
        )
        .map_err(model_action_intent_evidence_rejected)?;
    let verified_model = parse_verified_model_request_evidence_document_v1(
        &stored_model_bytes,
        &model_request_evidence,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    verify_model_request_evidence_matches_canonical_input(
        verified_model.document(),
        &verified_input,
    )
    .map_err(model_action_intent_evidence_rejected)?;

    let constraints = derive_model_action_scope_constraints_v1(
        evidence.action_request.execution_role,
        &verified_input.document().tool_capabilities,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    let trust_document = TrustScopeEvidenceDocumentV1::from_verified_model_request_evidence(
        &verified_model,
        evidence.dispatch.body.acceptance_contract_digest.clone(),
        constraints,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    let trust_bytes = trust_scope_evidence_document_v1_bytes(&trust_document)
        .map_err(model_action_intent_evidence_rejected)?;
    let trust_reference = cas
        .put_canonical_bytes(&trust_bytes)
        .map_err(model_action_intent_evidence_rejected)?;
    let trust_scope_evidence = trust_scope_evidence_v1_descriptor(&trust_reference);

    verify_model_action_intent_evidence_documents(
        cas,
        issue,
        evidence,
        &model_request_evidence,
        &trust_scope_evidence,
    )?;
    Ok((model_request_evidence, trust_scope_evidence))
}

/// Re-verify evidence named by a newly created or previously recorded model
/// intent. This supplies the semantic half of the binding: the descriptor is
/// not enough unless the protected bytes reproduce the action request, the
/// signed dispatch, the exact model request, and the derived scope.
fn verify_model_action_intent_evidence_documents(
    cas: &Cas,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
    model_request_evidence: &ModelRequestEvidenceV1,
    trust_scope_evidence: &TrustScopeEvidenceV1,
) -> Result<()> {
    let input_bytes = cas
        .get_verified_canonical_bytes(
            &evidence.action_request.canonical_input_ref,
            &evidence.action_request.canonical_input_digest,
        )
        .map_err(model_action_intent_evidence_rejected)?;
    let verified_input = parse_verified_canonical_model_action_input_v1(
        &input_bytes,
        &evidence.action_request.canonical_input_ref,
        &evidence.action_request.canonical_input_digest,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    let binding = ModelActionEvidenceBindingV1::from_action_requested_v2(
        &evidence.action_request,
        issue.dispatch_event_id,
        issue.action_request_event_id,
    )
    .map_err(model_action_intent_evidence_rejected)?;
    validate_model_action_binding_against_verified_dispatch(
        &binding,
        &evidence.action_request,
        issue.dispatch_event_id,
        issue.action_request_event_id,
        &evidence.dispatch,
        &evidence.dispatch_envelope_digest,
        evidence.dispatch_is_graph_bound_v4,
    )
    .map_err(model_action_intent_evidence_rejected)?;

    let model_bytes = cas
        .get_verified_canonical_bytes(
            &model_request_evidence.cas_ref,
            &model_request_evidence.digest,
        )
        .map_err(model_action_intent_evidence_rejected)?;
    let verified_model =
        parse_verified_model_request_evidence_document_v1(&model_bytes, model_request_evidence)
            .map_err(model_action_intent_evidence_rejected)?;
    if &verified_model.document().binding != &binding {
        return Err(model_action_intent_evidence_rejected_message(
            "model request evidence binding does not equal the replayed dispatch/action evidence",
        ));
    }
    verify_model_request_evidence_matches_canonical_input(
        verified_model.document(),
        &verified_input,
    )
    .map_err(model_action_intent_evidence_rejected)?;

    let trust_bytes = cas
        .get_verified_canonical_bytes(&trust_scope_evidence.cas_ref, &trust_scope_evidence.digest)
        .map_err(model_action_intent_evidence_rejected)?;
    let verified_trust =
        parse_verified_trust_scope_evidence_document_v1(&trust_bytes, trust_scope_evidence)
            .map_err(model_action_intent_evidence_rejected)?;
    if &verified_trust.document().binding != &binding
        || &verified_trust.document().model_request_evidence != model_request_evidence
        || verified_trust
            .document()
            .acceptance_contract_digest
            .as_str()
            != evidence.dispatch.body.acceptance_contract_digest.as_str()
    {
        return Err(model_action_intent_evidence_rejected_message(
            "trust scope evidence does not bind the replayed model request and acceptance contract",
        ));
    }
    verify_trust_scope_evidence_matches_model_request(verified_trust.document(), &verified_model)
        .map_err(model_action_intent_evidence_rejected)?;
    Ok(())
}

fn model_action_intent_evidence_rejected(error: LedgerError) -> LedgerError {
    LedgerError::ModelActionIntentAuthorityRejected {
        reason: format!("model action intent evidence is invalid: {error}"),
    }
}

fn model_action_intent_evidence_rejected_message(reason: impl Into<String>) -> LedgerError {
    LedgerError::ModelActionIntentAuthorityRejected {
        reason: reason.into(),
    }
}

fn validate_governed_dispatch(
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
) -> Result<GovernedDispatchWindow> {
    let body = &dispatch.body;
    if body.trust_tier != TrustTierV1::Governed
        || body.commit_mode != CommitModeV1::Atomic
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "dispatch does not authorize governed atomic sealed action evidence".into(),
        });
    }
    if body.workflow_id.trim().is_empty()
        || body.workflow_revision.trim().is_empty()
        || body.unit_id.trim().is_empty()
        || body.provenance_ref.trim().is_empty()
        || body.idempotency_key.trim().is_empty()
        || !is_canonical_git_commit_sha(&body.base_commit_sha)
        || !is_canonical_sha256_digest(&body.capability_bundle_digest)
        || !is_canonical_sha256_digest(&body.acceptance_contract_digest)
        || !is_canonical_sha256_digest(&body.context_manifest_digest)
        || !is_canonical_sha256_digest(&body.worker_manifest_digest)
        || !is_canonical_sha256_digest(&body.sandbox_profile_digest)
        || !dispatch
            .governed_packet_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed dispatch is missing required provenance, base, or manifest authority fields"
                .into(),
        });
    }
    if body.attempt == 0 {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed dispatch attempt must be greater than zero".into(),
        });
    }
    if body
        .budget
        .max_compute_time_ms
        .is_some_and(|milliseconds| milliseconds == 0)
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed dispatch max_compute_time_ms must be greater than zero when present"
                .into(),
        });
    }
    if body.budget.max_tokens.is_some_and(|tokens| tokens == 0) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed dispatch max_tokens must be greater than zero when present".into(),
        });
    }
    let issued_at = parse_claim_timestamp(&body.issued_at)?;
    let expires_at = parse_claim_timestamp(&body.expires_at)?;
    if issued_at >= expires_at {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed dispatch expiry must be after issuance".into(),
        });
    }
    if now < issued_at {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "dispatch authority is not yet active".into(),
        });
    }
    let (effective_deadline, compute_budget_is_limiting) = match body.budget.max_compute_time_ms {
        Some(max_compute_time_ms) => {
            let compute_deadline = issued_at
                .checked_add_signed(Duration::milliseconds(i64::from(max_compute_time_ms)))
                .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                    reason: "governed dispatch compute deadline cannot be represented".into(),
                })?;
            let compute_budget_is_limiting = compute_deadline < expires_at;
            (
                compute_deadline.min(expires_at.clone()),
                compute_budget_is_limiting,
            )
        }
        None => (expires_at.clone(), false),
    };
    if now >= effective_deadline {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: if compute_budget_is_limiting {
                "governed dispatch compute deadline has elapsed".into()
            } else {
                "dispatch authority has expired".into()
            },
        });
    }
    Ok(GovernedDispatchWindow {
        issued_at,
        effective_deadline,
    })
}

fn validate_action_request_matches_dispatch(
    claim: &ActivityClaimRequestV1,
    request: &ActionRequestedV2,
    dispatch: &DispatchEnvelopeV3,
    dispatch_envelope_digest: &str,
    authority: &ActivityClaimAuthorityV1,
    dispatch_issued_at: DateTime<Utc>,
    claimed_at: DateTime<Utc>,
) -> Result<()> {
    let body = &dispatch.body;
    if request.run_id != claim.run_id.to_string()
        || request.action_id != claim.activity_id
        || request.idempotency_key != claim.idempotency_key
        || request.workflow_id != body.workflow_id
        || request.unit_id != body.unit_id
        || request.attempt != body.attempt
        || request.provenance_ref != body.provenance_ref
        || request.dispatch_envelope_digest != dispatch_envelope_digest
        || request.repository_binding_digest != dispatch.repository_binding_digest
        || request.ledger_authority_realm_digest != dispatch.ledger_authority_realm_digest
        || request.governed_packet_digest != dispatch.governed_packet_digest
        || request.capability_bundle_digest != body.capability_bundle_digest
        || request.context_manifest_digest != body.context_manifest_digest
        || request.worker_manifest_digest != body.worker_manifest_digest
        || request.sandbox_profile_digest != body.sandbox_profile_digest
        || request.execution_role != body.execution_role
        || request.authority_actor != authority.action_request_signer.actor_id
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request does not exactly bind the trusted governed dispatch".into(),
        });
    }

    // `policy_digest` is not an independently caller-selectable capability.
    // The signed V3 envelope does not yet contain a policy-manifest field, so
    // derive the only permitted action-plane binding from its signed
    // acceptance-contract digest before issuing a native effect lease.
    let expected_policy_digest =
        governed_dispatch_policy_digest_v1(&body.acceptance_contract_digest).map_err(|_| {
            LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed dispatch acceptance-contract policy binding is invalid".into(),
            }
        })?;
    if request.policy_digest != expected_policy_digest {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request policy_digest does not match the policy binding derived from the signed acceptance contract".into(),
        });
    }
    if let Some(expected_realm_digest) = authority.ledger_authority_realm_digest.as_deref() {
        if dispatch.ledger_authority_realm_digest != expected_realm_digest
            || request.ledger_authority_realm_digest != expected_realm_digest
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason:
                    "action request does not bind this protected governed ledger authority realm"
                        .into(),
            });
        }
    }
    let requested_at = parse_claim_timestamp(&request.requested_at)?;
    if requested_at < dispatch_issued_at {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request predates its governed dispatch authority".into(),
        });
    }
    if requested_at > claimed_at {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "action request timestamp is after the activity claim time".into(),
        });
    }
    Ok(())
}

fn load_verified_authority_event(
    conn: &Connection,
    event_id: EventId,
    trusted_keys: &TrustedPublicKeys,
    expected_signer: &ActorKeyRef,
    label: &str,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, event_id)? else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} event is missing from the tape"),
        });
    };
    let Some(signature) = signature else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} event is unsigned"),
        });
    };
    if !actor_matches(expected_signer, &signature.signer)
        || verify_event_signature(&event, &signature, trusted_keys) != VerificationStatus::Verified
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("{label} event signature is not verified for the configured authority"),
        });
    }
    Ok(event)
}

fn verify_signed_claim_projection(
    conn: &Connection,
    stored: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
) -> Result<ActivityClaimedV1> {
    let event = load_verified_authority_event(
        conn,
        stored.claim_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "activity claim",
    )?;
    if event.run_id != stored.run_id
        || event.parent_event_id != Some(stored.action_request_event_id)
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity claim tape event does not bind the projected run and action request"
                .into(),
        });
    }
    if canonical_event_hash(&event)? != stored.claim_event_digest {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity claim projection digest does not match its signed tape event".into(),
        });
    }
    let Payload::ActivityClaimedV1(claim) = event.payload else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity claim projection does not reference an activity_claimed_v1 event"
                .into(),
        });
    };
    if claim.run_id != stored.run_id
        || claim.activity_id != stored.activity_id
        || claim.idempotency_key != stored.idempotency_key
        || claim.action_kind != stored.action_kind
        || claim.action_request_event_id != stored.action_request_event_id
        || claim.action_request_digest != stored.action_request_digest
        || claim.dispatch_event_id != stored.dispatch_event_id
        || claim.dispatch_envelope_digest != stored.dispatch_envelope_digest
        || claim.authority_actor != stored.authority_actor
        || claim.lease_id != stored.lease_id
        || claim.lease_expires_at != stored.lease_expires_at
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity claim projection does not exactly match its signed tape event".into(),
        });
    }
    Ok(claim)
}

/// Reconstruct the exact authorization chain as it existed when a fixed
/// verifier lease was granted. Result recording must not use `Utc::now()` for
/// this check: an already-authorized verifier may need to record `Unknown`
/// after the envelope expires. Instead, re-check dispatch liveness and action
/// ordering at the signed claim timestamp, while still enforcing the current
/// host realm identity.
fn verify_governed_verifier_claim_lineage(
    conn: &Connection,
    stored: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
) -> Result<()> {
    let signed_claim = verify_signed_claim_projection(conn, stored, authority)?;
    if signed_claim.purpose != ActivityClaimPurposeV1::GovernedVerifierV1 {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "governed verifier result requires a lease minted by the fixed verifier claim lane"
                    .into(),
        });
    }
    let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
    let request = ActivityClaimRequestV1 {
        run_id: stored.run_id,
        activity_id: stored.activity_id.clone(),
        idempotency_key: stored.idempotency_key.clone(),
        dispatch_event_id: stored.dispatch_event_id,
        action_request_event_id: stored.action_request_event_id,
        lease_duration_ms: stored.lease_duration_ms,
    };
    let evidence = verify_claim_evidence(conn, &request, authority, claimed_at)?;
    if evidence.action_kind != stored.action_kind
        || evidence.action_request_digest != stored.action_request_digest
        || evidence.dispatch_envelope_digest != stored.dispatch_envelope_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed verifier lease does not match its historical signed dispatch/action evidence"
                .into(),
        });
    }
    Ok(())
}

/// Verify that a recorded terminal projection is backed by the one signed
/// result event for the already-verified grant. This is deliberately separate
/// from [`verify_signed_claim_projection`]: a projection can have an intact
/// grant yet a forged or incomplete terminal result after a crash or storage
/// corruption. In that state replay must block rather than treat the effect as
/// completed.
fn verify_signed_activity_result_projection(
    conn: &Connection,
    stored: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
) -> Result<()> {
    if stored.state != StoredActivityClaimState::Recorded {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "attempted to verify a non-terminal activity result projection".into(),
        });
    }
    let result_event_id = required_claim_field(stored.result_event_id, "result_event_id")?;
    let result_event_digest =
        required_claim_string(stored.result_event_digest.as_deref(), "result_event_digest")?;
    let result_outcome = required_claim_field(stored.result_outcome, "result_outcome")?;
    let evidence_digest =
        required_claim_string(stored.evidence_digest.as_deref(), "evidence_digest")?;
    let evidence_ref = required_claim_string(stored.evidence_ref.as_deref(), "evidence_ref")?;
    let recorded_at = required_claim_string(stored.recorded_at.as_deref(), "recorded_at")?;
    let event = load_verified_authority_event(
        conn,
        result_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "activity result",
    )?;
    if event.run_id != stored.run_id || event.parent_event_id != Some(stored.claim_event_id) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity result tape event does not bind the projected run and claim".into(),
        });
    }
    if canonical_event_hash(&event)? != result_event_digest {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity result projection digest does not match its signed tape event".into(),
        });
    }
    let Payload::ActivityResultRecordedV1(result) = event.payload else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "activity result projection does not reference an activity_result_recorded_v1 event"
                    .into(),
        });
    };
    if result.run_id != stored.run_id
        || result.activity_id != stored.activity_id
        || result.idempotency_key != stored.idempotency_key
        || result.claim_event_id != stored.claim_event_id
        || result.claim_event_digest != stored.claim_event_digest
        || result.lease_id != stored.lease_id
        || result.outcome != result_outcome
        || result.result_digest != stored.result_digest
        || result.result_ref != stored.result_ref
        || result.evidence_digest != evidence_digest
        || result.evidence_ref != evidence_ref
        || result.recorded_at != recorded_at
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity result projection does not exactly match its signed tape event"
                .into(),
        });
    }
    Ok(())
}

/// Reconstruct a claim's original signed dispatch/action lineage and then
/// evaluate the same dispatch at `now`. This deliberately keeps historical
/// claim validation separate from current liveness: a prior valid claim is
/// not permission to heartbeat after its dispatch deadline.
fn verify_current_activity_claim_authority(
    conn: &Connection,
    stored: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<GovernedDispatchWindow> {
    let signed_claim = verify_signed_claim_projection(conn, stored, authority)?;
    let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
    let request = ActivityClaimRequestV1 {
        run_id: stored.run_id,
        activity_id: stored.activity_id.clone(),
        idempotency_key: stored.idempotency_key.clone(),
        dispatch_event_id: stored.dispatch_event_id,
        action_request_event_id: stored.action_request_event_id,
        lease_duration_ms: stored.lease_duration_ms,
    };
    let historical = verify_claim_evidence(conn, &request, authority, claimed_at)?;
    if historical.action_kind != stored.action_kind
        || historical.action_request_digest != stored.action_request_digest
        || historical.dispatch_envelope_digest != stored.dispatch_envelope_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat claim does not match its historical signed dispatch/action evidence".into(),
        });
    }

    let dispatch_event = load_verified_authority_event(
        conn,
        stored.dispatch_event_id,
        &authority.trusted_keys,
        &authority.dispatch_signer,
        "activity heartbeat dispatch",
    )?;
    if dispatch_event.run_id != stored.run_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat dispatch run_id does not match the signed claim".into(),
        });
    }
    let dispatch_material = dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat requires the claim's signed dispatch_envelope_v3 or graph-bound dispatch_envelope_v4".into(),
        }
    })?;
    if dispatch_material.lineage_envelope_digest != stored.dispatch_envelope_digest {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat dispatch digest does not match the signed claim".into(),
        });
    }
    validate_governed_dispatch(&dispatch_material.dispatch, now)
}

/// Derive a claim's effective expiry from the signed heartbeat chain. The
/// SQLite rows speed lookup but can never extend authority on their own: every
/// row is verified against its signed event, claim binding, and predecessor.
fn effective_activity_lease_expiry(
    conn: &Connection,
    claim: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
) -> Result<DateTime<Utc>> {
    let mut effective_expiry = parse_claim_timestamp(&claim.lease_expires_at)?;
    for heartbeat in activity_heartbeats_for_claim(conn, claim.run_id, claim.claim_event_id)? {
        verify_signed_activity_heartbeat_projection(conn, claim, &heartbeat, authority, false)?;
        let prior_expiry = parse_claim_timestamp(&heartbeat.prior_lease_expires_at)?;
        let heartbeat_at = parse_claim_timestamp(&heartbeat.heartbeat_at)?;
        let next_expiry = parse_claim_timestamp(&heartbeat.lease_expires_at)?;
        let dispatch_window =
            verify_current_activity_claim_authority(conn, claim, authority, heartbeat_at)?;
        if prior_expiry != effective_expiry {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason:
                    "activity heartbeat projection does not bind the prior effective lease expiry"
                        .into(),
            });
        }
        if heartbeat_at >= effective_expiry {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat was recorded after its prior lease expired".into(),
            });
        }
        if next_expiry <= effective_expiry {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat does not move the effective lease expiry forward"
                    .into(),
            });
        }
        if next_expiry > dispatch_window.effective_deadline {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat exceeds the signed dispatch authority window".into(),
            });
        }
        effective_expiry = next_expiry;
    }
    Ok(effective_expiry)
}

fn verify_signed_activity_heartbeat_projection(
    conn: &Connection,
    claim: &StoredActivityClaim,
    stored: &StoredActivityHeartbeat,
    authority: &ActivityClaimAuthorityV1,
    require_signed_request_binding: bool,
) -> Result<()> {
    if stored.run_id != claim.run_id
        || stored.claim_event_id != claim.claim_event_id
        || stored.claim_event_digest != claim.claim_event_digest
        || stored.activity_id != claim.activity_id
        || stored.idempotency_key != claim.idempotency_key
        || stored.lease_id != claim.lease_id
        || stored.dispatch_event_id != claim.dispatch_event_id
        || stored.dispatch_envelope_digest != claim.dispatch_envelope_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat projection does not bind the signed activity claim".into(),
        });
    }
    let event = load_verified_authority_event(
        conn,
        stored.heartbeat_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "activity heartbeat",
    )?;
    if event.run_id != claim.run_id || event.parent_event_id != Some(claim.claim_event_id) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat tape event does not bind the projected run and claim"
                .into(),
        });
    }
    if canonical_event_hash(&event)? != stored.heartbeat_event_digest {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat projection digest does not match its signed tape event"
                .into(),
        });
    }
    let Payload::ActivityHeartbeatRecordedV1(heartbeat) = event.payload else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat projection does not reference an activity_heartbeat_recorded_v1 event".into(),
        });
    };
    if heartbeat.run_id != claim.run_id
        || heartbeat.activity_id != claim.activity_id
        || heartbeat.idempotency_key != claim.idempotency_key
        || heartbeat.claim_event_id != claim.claim_event_id
        || heartbeat.claim_event_digest != claim.claim_event_digest
        || heartbeat.lease_id != claim.lease_id
        || heartbeat.dispatch_event_id != claim.dispatch_event_id
        || heartbeat.dispatch_envelope_digest != claim.dispatch_envelope_digest
        || heartbeat.lease_expires_at != stored.lease_expires_at
        || heartbeat.heartbeat_at != stored.heartbeat_at
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity heartbeat projection does not exactly match its signed tape event"
                .into(),
        });
    }
    match (
        heartbeat.heartbeat_id.as_deref(),
        heartbeat.heartbeat_request_digest.as_deref(),
    ) {
        (Some(heartbeat_id), Some(request_digest)) => {
            if heartbeat_id != stored.heartbeat_id || request_digest != stored.request_digest {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "activity heartbeat cache identity does not exactly match its signed tape event".into(),
                });
            }
        }
        (None, None) if !require_signed_request_binding => {
            // Historical signed heartbeat events predate request-identity
            // binding. They remain usable for replayed lease reconstruction,
            // but cannot answer a modern idempotency retry.
        }
        (None, None) => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat lacks the signed request identity required for idempotency replay".into(),
            });
        }
        _ => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "activity heartbeat has a partial signed request identity".into(),
            });
        }
    }
    Ok(())
}

fn event_and_signature_by_id(
    conn: &Connection,
    event_id: EventId,
) -> Result<Option<(Event, Option<EventSignatureV1>)>> {
    let stored = conn
        .query_row(
            r#"SELECT
                    e.id, e.run_id, e.parent_event_id, e.schema_version, e.kind, e.occurred_at, e.payload,
                    s.event_id, s.canonical_event_hash, s.actor_id, s.key_id, s.public_key_hash,
                    s.algorithm, s.signature, s.signed_at
                FROM events e
                LEFT JOIN event_signatures s ON s.event_id = e.id
                WHERE e.id = ?1"#,
            params![event_id.to_string()],
            |row| {
                let event = StoredEventRow {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    parent_event_id: row.get(2)?,
                    schema_version: row.get(3)?,
                    kind: row.get(4)?,
                    occurred_at: row.get(5)?,
                    payload: row.get(6)?,
                };
                let signature_event_id: Option<String> = row.get(7)?;
                let signature = match signature_event_id {
                    Some(event_id) => Some(StoredEventSignatureRow {
                        event_id,
                        canonical_event_hash: row.get(8)?,
                        actor_id: row.get(9)?,
                        key_id: row.get(10)?,
                        public_key_hash: row.get(11)?,
                        algorithm: row.get(12)?,
                        signature: row.get(13)?,
                        signed_at: row.get(14)?,
                    }),
                    None => None,
                };
                Ok((event, signature))
            },
        )
        .optional()?;
    stored
        .map(|(event, signature)| {
            Ok((
                event.to_event()?,
                signature
                    .map(|signature| signature.to_event_signature())
                    .transpose()?,
            ))
        })
        .transpose()
}

#[derive(Clone, Debug)]
struct VerifiedGovernedPromotionDecisionEvidence {
    dispatch: DispatchEnvelopeV3,
    dispatch_envelope_digest: String,
    candidate: CandidateCreatedV2,
    acceptance: CandidateAcceptanceRecordedV1,
    approval: PromotionApprovalRequestedV1,
}

fn verify_governed_promotion_decision_evidence(
    conn: &Connection,
    request: &GovernedPromotionDecisionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
    now: DateTime<Utc>,
    enforce_current_authority_window: bool,
) -> Result<VerifiedGovernedPromotionDecisionEvidence> {
    let dispatch_event = load_verified_promotion_event(
        conn,
        request.dispatch_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "governed dispatch",
    )?;
    if dispatch_event.run_id != request.run_id {
        return promotion_authority_rejected("governed dispatch belongs to a different run");
    }
    let dispatch_material = dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
        LedgerError::PromotionAuthorityRejected {
            reason: "promotion decision requires an immutable sealed-V3 or graph-bound V4 dispatch envelope".into(),
        }
    })?;
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    validate_static_governed_promotion_dispatch(&dispatch, authority)?;
    let dispatch_expires_at = parse_claim_timestamp(&dispatch.body.expires_at).map_err(|_| {
        LedgerError::PromotionAuthorityRejected {
            reason: "governed dispatch expiry is not canonical RFC3339 UTC".into(),
        }
    })?;
    if enforce_current_authority_window && now >= dispatch_expires_at {
        return promotion_authority_rejected(
            "promotion decision requires an unexpired governed dispatch authority window",
        );
    }

    let candidate_event = load_verified_promotion_event(
        conn,
        request.candidate_created_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate artifact",
    )?;
    if candidate_event.run_id != request.run_id {
        return promotion_authority_rejected("candidate artifact belongs to a different run");
    }
    let Payload::CandidateCreatedV2(candidate) = &candidate_event.payload else {
        return promotion_authority_rejected(
            "promotion decision requires an immutable candidate_created_v2 record",
        );
    };
    let candidate = candidate.clone();
    if candidate.run_id != request.run_id.to_string()
        || candidate.workflow_id != dispatch.body.workflow_id
        || candidate.unit_id != dispatch.body.unit_id
        || candidate.attempt != dispatch.body.attempt
        || candidate.provenance_ref != dispatch.body.provenance_ref
        || candidate.base_commit_sha != dispatch.body.base_commit_sha
        || candidate.envelope_digest != dispatch_envelope_digest
    {
        return promotion_authority_rejected(
            "candidate artifact does not exactly bind the governed dispatch lineage",
        );
    }

    let completion_event = load_verified_promotion_event(
        conn,
        request.candidate_completion_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate completion",
    )?;
    if completion_event.run_id != request.run_id {
        return promotion_authority_rejected("candidate completion belongs to a different run");
    }
    let Payload::CandidateCompletionRecordedV1(completion) = &completion_event.payload else {
        return promotion_authority_rejected(
            "promotion decision requires a candidate_completion_recorded_v1 proof",
        );
    };
    let completion = completion.clone();
    if completion.run_id != request.run_id.to_string()
        || completion.workflow_id != candidate.workflow_id
        || completion.unit_id != candidate.unit_id
        || completion.attempt != candidate.attempt
        || completion.provenance_ref != candidate.provenance_ref
        || completion.candidate_created_event_ref != request.candidate_created_event_id
        || completion.candidate_digest != candidate.candidate_digest
        || completion_event.parent_event_id != Some(request.candidate_created_event_id)
    {
        return promotion_authority_rejected(
            "candidate completion does not close the exact immutable candidate",
        );
    }
    let completed_at = parse_claim_timestamp(&completion.completed_at).map_err(|_| {
        LedgerError::PromotionAuthorityRejected {
            reason: "candidate completion timestamp is not canonical RFC3339 UTC".into(),
        }
    })?;
    if completed_at != completion_event.occurred_at {
        return promotion_authority_rejected(
            "candidate completion timestamp does not equal its signed tape event time",
        );
    }

    let acceptance_event = load_verified_promotion_event(
        conn,
        request.acceptance_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate acceptance",
    )?;
    if acceptance_event.run_id != request.run_id {
        return promotion_authority_rejected("candidate acceptance belongs to a different run");
    }
    let Payload::CandidateAcceptanceRecordedV1(acceptance) = &acceptance_event.payload else {
        return promotion_authority_rejected(
            "promotion decision requires a candidate_acceptance_recorded record",
        );
    };
    let acceptance = acceptance.clone();
    if acceptance.candidate_digest != candidate.candidate_digest
        || acceptance.candidate_commit_sha != candidate.candidate_commit_sha
        || acceptance.acceptance_contract_digest != dispatch.body.acceptance_contract_digest
    {
        return promotion_authority_rejected(
            "candidate acceptance does not bind the exact candidate and dispatch contract",
        );
    }

    let approval_event = load_verified_promotion_event(
        conn,
        request.promotion_approval_request_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "promotion approval request",
    )?;
    if approval_event.run_id != request.run_id {
        return promotion_authority_rejected(
            "promotion approval request belongs to a different run",
        );
    }
    let Payload::PromotionApprovalRequestedV1(approval) = &approval_event.payload else {
        return promotion_authority_rejected(
            "promotion decision requires a promotion_approval_requested record",
        );
    };
    let approval = approval.clone();
    if approval.candidate_digest != candidate.candidate_digest
        || approval.base_commit_sha != candidate.base_commit_sha
        || approval.envelope_digest != dispatch_envelope_digest
        || approval.acceptance_ref != acceptance.acceptance_ref
        || approval.requested_by != authority.kernel_signer.actor_id
        || !is_canonical_target_ref(&approval.target_ref)
        || approval.idempotency_key.trim().is_empty()
    {
        return promotion_authority_rejected(
            "promotion approval request does not exactly bind the candidate, passed acceptance, and kernel authority",
        );
    }
    if approval.review_refs.len() != request.review_event_ids.len() {
        return promotion_authority_rejected(
            "promotion approval review references do not match the supplied immutable review events",
        );
    }
    if request.decision == PromotionDecisionKindV1::Promote
        && acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
    {
        return promotion_authority_rejected(
            "promotion requires a passed deterministic candidate acceptance record",
        );
    }

    for (index, review_event_id) in request.review_event_ids.iter().enumerate() {
        let (review_event, reviewer_signer) = load_verified_promotion_reviewer_event(
            conn,
            *review_event_id,
            authority,
            "promotion review",
        )?;
        if review_event.run_id != request.run_id {
            return promotion_authority_rejected("promotion review belongs to a different run");
        }
        let Payload::ReviewVerdictRecordedV2(review) = &review_event.payload else {
            return promotion_authority_rejected(
                "governed promotion requires closed review_verdict_recorded_v2 evidence",
            );
        };
        if review.run_id != request.run_id.to_string()
            || review.workflow_id != candidate.workflow_id
            || review.unit_id != candidate.unit_id
            || review.attempt != candidate.attempt
            || review.provenance_ref != candidate.provenance_ref
            || review.candidate_digest != candidate.candidate_digest
            || review.candidate_commit_sha != candidate.candidate_commit_sha
            || review.candidate_envelope_digest != dispatch_envelope_digest
            || review.acceptance_ref != acceptance.acceptance_ref
            || review.acceptance_digest != acceptance.acceptance_digest
            || review.acceptance_contract_digest != acceptance.acceptance_contract_digest
            || review.review_ref != approval.review_refs[index]
            || review.reviewer_authority != reviewer_signer.actor_id
            || !matches!(
                review.reviewer_execution_role,
                ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
            )
            || review.candidate_view.candidate_ref != candidate.candidate_ref
            || review.candidate_view.candidate_digest != candidate.candidate_digest
            || review.candidate_view.candidate_commit_sha != candidate.candidate_commit_sha
            || review.candidate_view.tree_digest != candidate.tree_digest
            || !review.candidate_view.read_only
            || !review.candidate_view.network_disabled
        {
            return promotion_authority_rejected(
                "promotion review does not bind the exact candidate, passed acceptance, and read-only reviewer view",
            );
        }
        if request.decision == PromotionDecisionKindV1::Promote
            && review.decision != ReviewDecisionV1::Approve
        {
            return promotion_authority_rejected(
                "promotion requires every referenced structured review to approve",
            );
        }
        verify_governed_reviewer_dispatch_for_promotion(
            conn,
            request.run_id,
            &review,
            &candidate,
            authority,
        )?;
    }

    if completion_event.occurred_at < candidate_event.occurred_at
        || acceptance_event.occurred_at < candidate_event.occurred_at
        || approval_event.occurred_at < completion_event.occurred_at
        || approval_event.occurred_at < acceptance_event.occurred_at
        || (enforce_current_authority_window && now < approval_event.occurred_at)
    {
        return promotion_authority_rejected(
            "promotion decision evidence has an impossible causal timestamp ordering",
        );
    }

    Ok(VerifiedGovernedPromotionDecisionEvidence {
        dispatch,
        dispatch_envelope_digest,
        candidate,
        acceptance,
        approval,
    })
}

fn validate_static_governed_promotion_dispatch(
    dispatch: &DispatchEnvelopeV3,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    if dispatch.body.trust_tier != TrustTierV1::Governed
        || dispatch.body.execution_role != ExecutionRoleV1::Implementer
        || dispatch.body.commit_mode != CommitModeV1::Atomic
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        || dispatch.ledger_authority_realm_digest != authority.ledger_authority_realm_digest
        || dispatch
            .governed_packet_digest
            .as_deref()
            .is_none_or(|digest| digest.trim().is_empty())
    {
        return promotion_authority_rejected(
            "promotion decision requires a sealed-V3 governed atomic implementer dispatch in this protected realm",
        );
    }
    Ok(())
}

fn promotion_authority_rejected<T>(reason: impl Into<String>) -> Result<T> {
    Err(LedgerError::PromotionAuthorityRejected {
        reason: reason.into(),
    })
}

fn load_verified_promotion_event(
    conn: &Connection,
    event_id: EventId,
    trusted_keys: &TrustedPublicKeys,
    expected_signer: &ActorKeyRef,
    label: &str,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, event_id)? else {
        return promotion_authority_rejected(format!("{label} event is missing from the tape"));
    };
    let Some(signature) = signature else {
        return promotion_authority_rejected(format!("{label} event is unsigned"));
    };
    if !actor_matches(expected_signer, &signature.signer)
        || verify_event_signature(&event, &signature, trusted_keys) != VerificationStatus::Verified
    {
        return promotion_authority_rejected(format!(
            "{label} event signature is not verified for the configured promotion authority"
        ));
    }
    Ok(event)
}

fn load_verified_promotion_reviewer_event(
    conn: &Connection,
    event_id: EventId,
    authority: &GovernedPromotionAuthorityV1,
    label: &str,
) -> Result<(Event, ActorKeyRef)> {
    let Some((event, signature)) = event_and_signature_by_id(conn, event_id)? else {
        return promotion_authority_rejected(format!("{label} event is missing from the tape"));
    };
    let Some(signature) = signature else {
        return promotion_authority_rejected(format!("{label} event is unsigned"));
    };
    let Some(expected) = authority
        .reviewer_signers
        .iter()
        .find(|expected| actor_matches(expected, &signature.signer))
    else {
        return promotion_authority_rejected(
            "promotion review signer is not an independently configured reviewer authority",
        );
    };
    if verify_event_signature(&event, &signature, &authority.trusted_keys)
        != VerificationStatus::Verified
    {
        return promotion_authority_rejected(
            "promotion review signature failed verification for its configured reviewer authority",
        );
    }
    Ok((event, expected.clone()))
}

/// A V2 review verdict is not authority merely because a reviewer key signed
/// it. It must name an independently dispatched governed reviewer unit whose
/// manifest and read-only sandbox are the ones represented in the candidate
/// view. The full action/receipt lineage is still rechecked by trusted replay
/// before any future Git effect; this storage-local check closes the more
/// immediate role and mount substitution avenue at decision time.
fn verify_governed_reviewer_dispatch_for_promotion(
    conn: &Connection,
    run_id: RunId,
    review: &ReviewVerdictRecordedV2,
    candidate: &CandidateCreatedV2,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    if review.reviewer_unit_id == candidate.unit_id
        && review.reviewer_workflow_id == candidate.workflow_id
        && review.reviewer_attempt == candidate.attempt
    {
        return promotion_authority_rejected(
            "promotion review must be produced by an independent reviewer dispatch",
        );
    }

    let mut statement = conn.prepare(
        "SELECT id FROM events
         WHERE run_id = ?1 AND kind IN ('dispatch_envelope_v3', 'dispatch_envelope_v4')
         ORDER BY id ASC",
    )?;
    let event_ids = statement
        .query_map(params![run_id.to_string()], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    for raw_event_id in event_ids {
        let event_id = parse_event_id(&raw_event_id, "reviewer dispatch")?;
        let event = load_verified_promotion_event(
            conn,
            event_id,
            &authority.trusted_keys,
            &authority.kernel_signer,
            "reviewer dispatch",
        )?;
        let dispatch_material = dispatch_authority_material(&event.payload).ok_or_else(|| {
            LedgerError::PromotionAuthorityRejected {
                reason: "reviewer dispatch index referenced a non-V3/non-V4 dispatch event".into(),
            }
        })?;
        let dispatch = dispatch_material.dispatch;
        if dispatch_material.lineage_envelope_digest != review.reviewer_dispatch_envelope_digest
            || dispatch.body.workflow_id != review.reviewer_workflow_id
            || dispatch.body.unit_id != review.reviewer_unit_id
            || dispatch.body.attempt != review.reviewer_attempt
        {
            continue;
        }

        if dispatch.body.trust_tier != TrustTierV1::Governed
            || dispatch.body.commit_mode != CommitModeV1::Atomic
            || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
            || dispatch.ledger_authority_realm_digest != authority.ledger_authority_realm_digest
            || dispatch
                .governed_packet_digest
                .as_deref()
                .is_none_or(|digest| digest.trim().is_empty())
            || dispatch.body.execution_role != review.reviewer_execution_role
            || !matches!(
                dispatch.body.execution_role,
                ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
            )
            || dispatch.body.worker_manifest_digest != review.reviewer_manifest_digest
            || dispatch.body.context_manifest_digest
                != review.candidate_view.reviewer_context_manifest_digest
            || dispatch.body.sandbox_profile_digest
                != review.candidate_view.reviewer_sandbox_profile_digest
        {
            return promotion_authority_rejected(
                "reviewer dispatch does not bind the governed read-only role, manifests, and candidate view",
            );
        }
        return Ok(());
    }

    promotion_authority_rejected(
        "review verdict does not reference an independently signed governed reviewer dispatch",
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredGovernedPromotionDecisionState {
    AwaitingKernelCheckpoint,
    Sealed,
}

#[derive(Clone, Debug)]
struct StoredGovernedPromotionDecision {
    run_id: RunId,
    candidate_digest: String,
    idempotency_key: String,
    decision_request_digest: String,
    dispatch_event_id: EventId,
    candidate_created_event_id: EventId,
    candidate_completion_event_id: EventId,
    acceptance_event_id: EventId,
    review_event_ids: Vec<EventId>,
    promotion_approval_request_event_id: EventId,
    decision_kind: PromotionDecisionKindV1,
    promotion_decision_event_id: EventId,
    promotion_decision_event_digest: String,
    state: StoredGovernedPromotionDecisionState,
    sealed_checkpoint_event_id: Option<EventId>,
    sealed_checkpoint_event_digest: Option<String>,
}

impl StoredGovernedPromotionDecision {
    fn required_sealed_checkpoint_event_id(&self) -> Result<EventId> {
        self.sealed_checkpoint_event_id.ok_or_else(|| {
            LedgerError::PromotionDecisionReconciliationRequired {
                run_id: self.run_id.to_string(),
                candidate_digest: self.candidate_digest.clone(),
                reason: "sealed promotion decision lacks its checkpoint event reference".into(),
            }
        })
    }
}

/// Immutable SQLite cache of one signed promotion execution reservation.
/// The cache is never an authority source: every branch that reads it
/// re-verifies the exact signed claim event and decision binding first.
#[derive(Clone, Debug)]
struct StoredGovernedPromotionExecutionClaim {
    run_id: RunId,
    candidate_digest: String,
    idempotency_key: String,
    promotion_decision_event_id: EventId,
    promotion_decision_event_digest: String,
    dispatch_event_id: EventId,
    dispatch_envelope_digest: String,
    candidate_ref: String,
    candidate_commit_sha: String,
    candidate_tree_digest: String,
    base_commit_sha: String,
    target_ref: String,
    authority_actor: String,
    promotion_execution_claim_event_id: EventId,
    promotion_execution_claim_event_digest: String,
    lease_id: String,
    claimed_at: String,
    lease_expires_at: String,
}

#[derive(Clone, Debug)]
struct StoredGovernedPromotionResult {
    run_id: RunId,
    candidate_digest: String,
    idempotency_key: String,
    promotion_decision_event_id: EventId,
    promotion_decision_event_digest: String,
    promotion_result_event_id: EventId,
    promotion_result_event_digest: String,
    outcome: PromotionResultOutcomeV1,
    merged_head_sha: Option<String>,
    promotion_git_binding: Option<PromotionGitBindingV1>,
    completed_at: String,
}

#[derive(Clone, Debug)]
struct PromotionCheckpointEvidence {
    event_id: EventId,
    event_digest: String,
}

const GOVERNED_PROMOTION_DECISION_COLUMNS: &str =
    "run_id, candidate_digest, idempotency_key, decision_request_digest, \
     dispatch_event_id, candidate_created_event_id, candidate_completion_event_id, \
     acceptance_event_id, review_event_ids_json, promotion_approval_request_event_id, \
     decision_kind, promotion_decision_event_id, promotion_decision_event_digest, state, \
     sealed_checkpoint_event_id, sealed_checkpoint_event_digest";

const GOVERNED_PROMOTION_EXECUTION_CLAIM_COLUMNS: &str =
    "run_id, candidate_digest, idempotency_key, promotion_decision_event_id, \
     promotion_decision_event_digest, dispatch_event_id, dispatch_envelope_digest, \
     candidate_ref, candidate_commit_sha, candidate_tree_digest, base_commit_sha, target_ref, \
     authority_actor, promotion_execution_claim_event_id, promotion_execution_claim_event_digest, \
     lease_id, claimed_at, lease_expires_at";

const GOVERNED_PROMOTION_RESULT_COLUMNS: &str =
    "run_id, candidate_digest, idempotency_key, promotion_decision_event_id, \
     promotion_decision_event_digest, promotion_result_event_id, promotion_result_event_digest, \
     outcome, merged_head_sha, promotion_git_binding_json, completed_at";

fn governed_promotion_decision_by_candidate(
    conn: &Connection,
    run_id: RunId,
    candidate_digest: &str,
) -> Result<Option<StoredGovernedPromotionDecision>> {
    let query = format!(
        "SELECT {GOVERNED_PROMOTION_DECISION_COLUMNS} \
         FROM governed_promotion_decisions \
         WHERE run_id = ?1 AND candidate_digest = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), candidate_digest],
        stored_governed_promotion_decision_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_promotion_decision_by_idempotency(
    conn: &Connection,
    run_id: RunId,
    idempotency_key: &str,
) -> Result<Option<StoredGovernedPromotionDecision>> {
    let query = format!(
        "SELECT {GOVERNED_PROMOTION_DECISION_COLUMNS} \
         FROM governed_promotion_decisions \
         WHERE run_id = ?1 AND idempotency_key = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), idempotency_key],
        stored_governed_promotion_decision_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_promotion_decision_by_event(
    conn: &Connection,
    run_id: RunId,
    promotion_decision_event_id: EventId,
) -> Result<Option<StoredGovernedPromotionDecision>> {
    let query = format!(
        "SELECT {GOVERNED_PROMOTION_DECISION_COLUMNS} \
         FROM governed_promotion_decisions \
         WHERE run_id = ?1 AND promotion_decision_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), promotion_decision_event_id.to_string()],
        stored_governed_promotion_decision_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_promotion_execution_claim_by_decision(
    conn: &Connection,
    run_id: RunId,
    promotion_decision_event_id: EventId,
) -> Result<Option<StoredGovernedPromotionExecutionClaim>> {
    let query = format!(
        "SELECT {GOVERNED_PROMOTION_EXECUTION_CLAIM_COLUMNS} \
         FROM governed_promotion_execution_claims \
         WHERE run_id = ?1 AND promotion_decision_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), promotion_decision_event_id.to_string()],
        stored_governed_promotion_execution_claim_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_promotion_result_by_decision(
    conn: &Connection,
    run_id: RunId,
    promotion_decision_event_id: EventId,
) -> Result<Option<StoredGovernedPromotionResult>> {
    let query = format!(
        "SELECT {GOVERNED_PROMOTION_RESULT_COLUMNS} \
         FROM governed_promotion_results \
         WHERE run_id = ?1 AND promotion_decision_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), promotion_decision_event_id.to_string()],
        stored_governed_promotion_result_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn stored_governed_promotion_decision_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedPromotionDecision> {
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: String, field: &str| {
        Uuid::parse_str(&value)
            .map(EventId::from_uuid)
            .map_err(|error| {
                to_sql_error(format!(
                    "invalid governed promotion {field} event id: {error}"
                ))
            })
    };
    let run_id: String = row.get(0)?;
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| to_sql_error(format!("invalid governed promotion run id: {error}")))?;
    let review_event_ids_json: String = row.get(8)?;
    let review_event_ids = serde_json::from_str::<Vec<String>>(&review_event_ids_json)
        .map_err(|error| {
            to_sql_error(format!(
                "invalid governed promotion review event ids: {error}"
            ))
        })?
        .into_iter()
        .map(|value| parse_event(value, "review"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let decision_kind: String = row.get(10)?;
    let decision_kind =
        serde_json::from_value(serde_json::Value::String(decision_kind)).map_err(|error| {
            to_sql_error(format!("invalid governed promotion decision kind: {error}"))
        })?;
    let state: String = row.get(13)?;
    let state = match state.as_str() {
        "awaiting_kernel_checkpoint" => {
            StoredGovernedPromotionDecisionState::AwaitingKernelCheckpoint
        }
        "sealed" => StoredGovernedPromotionDecisionState::Sealed,
        _ => {
            return Err(to_sql_error(
                "invalid governed promotion decision state".into(),
            ))
        }
    };
    let sealed_checkpoint_event_id: Option<String> = row.get(14)?;
    let sealed_checkpoint_event_id = sealed_checkpoint_event_id
        .map(|value| parse_event(value, "sealed checkpoint"))
        .transpose()?;
    Ok(StoredGovernedPromotionDecision {
        run_id,
        candidate_digest: row.get(1)?,
        idempotency_key: row.get(2)?,
        decision_request_digest: row.get(3)?,
        dispatch_event_id: parse_event(row.get(4)?, "dispatch")?,
        candidate_created_event_id: parse_event(row.get(5)?, "candidate created")?,
        candidate_completion_event_id: parse_event(row.get(6)?, "candidate completion")?,
        acceptance_event_id: parse_event(row.get(7)?, "acceptance")?,
        review_event_ids,
        promotion_approval_request_event_id: parse_event(row.get(9)?, "approval request")?,
        decision_kind,
        promotion_decision_event_id: parse_event(row.get(11)?, "decision")?,
        promotion_decision_event_digest: row.get(12)?,
        state,
        sealed_checkpoint_event_id,
        sealed_checkpoint_event_digest: row.get(15)?,
    })
}

fn stored_governed_promotion_execution_claim_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedPromotionExecutionClaim> {
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: String, field: &str| {
        Uuid::parse_str(&value)
            .map(EventId::from_uuid)
            .map_err(|error| {
                to_sql_error(format!(
                    "invalid governed promotion execution claim {field} event id: {error}"
                ))
            })
    };
    let run_id: String = row.get(0)?;
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| {
            to_sql_error(format!(
                "invalid governed promotion execution claim run id: {error}"
            ))
        })?;
    Ok(StoredGovernedPromotionExecutionClaim {
        run_id,
        candidate_digest: row.get(1)?,
        idempotency_key: row.get(2)?,
        promotion_decision_event_id: parse_event(row.get(3)?, "decision")?,
        promotion_decision_event_digest: row.get(4)?,
        dispatch_event_id: parse_event(row.get(5)?, "dispatch")?,
        dispatch_envelope_digest: row.get(6)?,
        candidate_ref: row.get(7)?,
        candidate_commit_sha: row.get(8)?,
        candidate_tree_digest: row.get(9)?,
        base_commit_sha: row.get(10)?,
        target_ref: row.get(11)?,
        authority_actor: row.get(12)?,
        promotion_execution_claim_event_id: parse_event(row.get(13)?, "claim")?,
        promotion_execution_claim_event_digest: row.get(14)?,
        lease_id: row.get(15)?,
        claimed_at: row.get(16)?,
        lease_expires_at: row.get(17)?,
    })
}

fn stored_governed_promotion_result_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedPromotionResult> {
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: String, field: &str| {
        Uuid::parse_str(&value)
            .map(EventId::from_uuid)
            .map_err(|error| {
                to_sql_error(format!(
                    "invalid governed promotion result {field} event id: {error}"
                ))
            })
    };
    let run_id: String = row.get(0)?;
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| {
            to_sql_error(format!("invalid governed promotion result run id: {error}"))
        })?;
    let outcome: String = row.get(7)?;
    let outcome = serde_json::from_value(serde_json::Value::String(outcome)).map_err(|error| {
        to_sql_error(format!(
            "invalid governed promotion result outcome: {error}"
        ))
    })?;
    let promotion_git_binding_json: Option<String> = row.get(9)?;
    let promotion_git_binding = promotion_git_binding_json
        .map(|json| serde_json::from_str::<PromotionGitBindingV1>(&json))
        .transpose()
        .map_err(|error| {
            to_sql_error(format!(
                "invalid governed promotion result Git binding: {error}"
            ))
        })?;
    Ok(StoredGovernedPromotionResult {
        run_id,
        candidate_digest: row.get(1)?,
        idempotency_key: row.get(2)?,
        promotion_decision_event_id: parse_event(row.get(3)?, "decision")?,
        promotion_decision_event_digest: row.get(4)?,
        promotion_result_event_id: parse_event(row.get(5)?, "result")?,
        promotion_result_event_digest: row.get(6)?,
        outcome,
        merged_head_sha: row.get(8)?,
        promotion_git_binding,
        completed_at: row.get(10)?,
    })
}

fn insert_governed_promotion_decision(
    conn: &Connection,
    request: &GovernedPromotionDecisionRequestV1,
    request_digest: &str,
    evidence: &VerifiedGovernedPromotionDecisionEvidence,
    event: &Event,
    event_digest: &str,
) -> Result<()> {
    let review_event_ids_json = serde_json::to_string(
        &request
            .review_event_ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
    )?;
    conn.execute(
        r#"INSERT INTO governed_promotion_decisions (
                run_id, candidate_digest, idempotency_key, decision_request_digest,
                dispatch_event_id, candidate_created_event_id, candidate_completion_event_id,
                acceptance_event_id, review_event_ids_json, promotion_approval_request_event_id,
                decision_kind, promotion_decision_event_id, promotion_decision_event_digest,
                state, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                'awaiting_kernel_checkpoint', ?14
            )"#,
        params![
            request.run_id.to_string(),
            &evidence.candidate.candidate_digest,
            &evidence.approval.idempotency_key,
            request_digest,
            request.dispatch_event_id.to_string(),
            request.candidate_created_event_id.to_string(),
            request.candidate_completion_event_id.to_string(),
            request.acceptance_event_id.to_string(),
            review_event_ids_json,
            request.promotion_approval_request_event_id.to_string(),
            promotion_decision_kind_wire(request.decision),
            event.id.to_string(),
            event_digest,
            event.occurred_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn insert_governed_promotion_execution_claim(
    conn: &Connection,
    decision: &StoredGovernedPromotionDecision,
    verified: &VerifiedStoredGovernedPromotionDecision,
    event: &Event,
    event_digest: &str,
    claim: &PromotionExecutionClaimedV1,
) -> Result<()> {
    let candidate = &verified.evidence.candidate;
    if claim.run_id != decision.run_id.to_string()
        || claim.promotion_decision_event_ref != decision.promotion_decision_event_id
        || claim.promotion_decision_event_digest != decision.promotion_decision_event_digest
        || claim.dispatch_event_ref != decision.dispatch_event_id
        || claim.dispatch_envelope_digest != verified.evidence.dispatch_envelope_digest
        || claim.candidate_digest != candidate.candidate_digest
        || claim.candidate_ref != candidate.candidate_ref
        || claim.candidate_commit_sha != candidate.candidate_commit_sha
        || claim.candidate_tree_digest != candidate.tree_digest
        || claim.base_commit_sha != candidate.base_commit_sha
        || claim.target_ref != verified.decision.target_ref.as_deref().unwrap_or_default()
        || claim.idempotency_key != decision.idempotency_key
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim does not exactly bind its sealed decision evidence"
                .into(),
        });
    }
    conn.execute(
        r#"INSERT INTO governed_promotion_execution_claims (
                run_id, candidate_digest, idempotency_key,
                promotion_decision_event_id, promotion_decision_event_digest,
                dispatch_event_id, dispatch_envelope_digest,
                candidate_ref, candidate_commit_sha, candidate_tree_digest, base_commit_sha,
                target_ref, authority_actor,
                promotion_execution_claim_event_id, promotion_execution_claim_event_digest,
                lease_id, claimed_at, lease_expires_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18
            )"#,
        params![
            decision.run_id.to_string(),
            &claim.candidate_digest,
            &claim.idempotency_key,
            claim.promotion_decision_event_ref.to_string(),
            &claim.promotion_decision_event_digest,
            claim.dispatch_event_ref.to_string(),
            &claim.dispatch_envelope_digest,
            &claim.candidate_ref,
            &claim.candidate_commit_sha,
            &claim.candidate_tree_digest,
            &claim.base_commit_sha,
            &claim.target_ref,
            &claim.authority_actor,
            event.id.to_string(),
            event_digest,
            &claim.lease_id,
            &claim.claimed_at,
            &claim.lease_expires_at,
        ],
    )?;
    Ok(())
}

fn insert_governed_promotion_result(
    conn: &Connection,
    decision: &StoredGovernedPromotionDecision,
    event: &Event,
    event_digest: &str,
    payload: &PromotionResultRecordedV1,
) -> Result<()> {
    let promotion_git_binding_json = payload
        .promotion_git_binding
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    conn.execute(
        r#"INSERT INTO governed_promotion_results (
                run_id, candidate_digest, idempotency_key,
                promotion_decision_event_id, promotion_decision_event_digest,
                promotion_result_event_id, promotion_result_event_digest,
                outcome, merged_head_sha, promotion_git_binding_json, completed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
            )"#,
        params![
            decision.run_id.to_string(),
            &decision.candidate_digest,
            &decision.idempotency_key,
            decision.promotion_decision_event_id.to_string(),
            &decision.promotion_decision_event_digest,
            event.id.to_string(),
            event_digest,
            promotion_result_outcome_wire(payload.outcome),
            &payload.merged_head_sha,
            promotion_git_binding_json,
            &payload.completed_at,
        ],
    )?;
    Ok(())
}

fn promotion_decision_event_exists_for_approval(
    conn: &Connection,
    run_id: RunId,
    approval_event_id: EventId,
) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE run_id = ?1 AND parent_event_id = ?2 AND kind = 'promotion_decision_recorded')",
        params![run_id.to_string(), approval_event_id.to_string()],
        |row| row.get(0),
    )
    .map_err(LedgerError::from)
}

fn promotion_result_event_exists_for_decision(
    conn: &Connection,
    run_id: RunId,
    promotion_decision_event_id: EventId,
) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE run_id = ?1 AND parent_event_id = ?2 AND kind = 'promotion_result_recorded')",
        params![run_id.to_string(), promotion_decision_event_id.to_string()],
        |row| row.get(0),
    )
    .map_err(LedgerError::from)
}

fn promotion_execution_claim_event_exists_for_decision(
    conn: &Connection,
    run_id: RunId,
    promotion_decision_event_id: EventId,
) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE run_id = ?1 AND parent_event_id = ?2 AND kind = 'promotion_execution_claimed_v1')",
        params![run_id.to_string(), promotion_decision_event_id.to_string()],
        |row| row.get(0),
    )
    .map_err(LedgerError::from)
}

fn verify_existing_governed_promotion_result_for_claim(
    conn: &Connection,
    stored: &StoredGovernedPromotionResult,
    decision: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    if stored.run_id != decision.run_id
        || stored.candidate_digest != decision.candidate_digest
        || stored.idempotency_key != decision.idempotency_key
        || stored.promotion_decision_event_id != decision.promotion_decision_event_id
        || stored.promotion_decision_event_digest != decision.promotion_decision_event_digest
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "terminal promotion result projection does not bind the requested decision"
                .into(),
        });
    }
    let event = load_verified_promotion_event(
        conn,
        stored.promotion_result_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "promotion result",
    )?;
    if event.run_id != decision.run_id
        || event.parent_event_id != Some(decision.promotion_decision_event_id)
        || canonical_event_hash(&event)? != stored.promotion_result_event_digest
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "terminal promotion result event does not bind its immutable projection".into(),
        });
    }
    let Payload::PromotionResultRecordedV1(payload) = &event.payload else {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "terminal promotion result projection references the wrong event payload"
                .into(),
        });
    };
    if payload.candidate_digest != stored.candidate_digest
        || payload.idempotency_key != stored.idempotency_key
        || payload.promotion_decision_ref != decision.promotion_decision_event_id.to_string()
        || payload.outcome != stored.outcome
        || payload.merged_head_sha != stored.merged_head_sha
        || payload.promotion_git_binding != stored.promotion_git_binding
        || payload.completed_at != stored.completed_at
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "terminal promotion result signed payload does not match its projection".into(),
        });
    }
    Ok(())
}

fn verify_stored_governed_promotion_execution_claim(
    conn: &Connection,
    stored: &StoredGovernedPromotionExecutionClaim,
    decision: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<PromotionExecutionClaimedV1> {
    if stored.run_id != decision.run_id
        || stored.candidate_digest != decision.candidate_digest
        || stored.idempotency_key != decision.idempotency_key
        || stored.promotion_decision_event_id != decision.promotion_decision_event_id
        || stored.promotion_decision_event_digest != decision.promotion_decision_event_digest
        || stored.dispatch_event_id != decision.dispatch_event_id
        || stored.authority_actor != authority.kernel_signer.actor_id
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim projection does not bind the sealed decision".into(),
        });
    }
    verify_stored_governed_promotion_decision_seal(conn, decision, authority)?;
    let verified = verified_governed_promotion_decision_from_stored(conn, decision, authority)?;
    if verified.decision.decision != PromotionDecisionKindV1::Promote {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "a rejected promotion decision cannot have an execution claim".into(),
        });
    }
    let target_ref = verified.decision.target_ref.as_deref().ok_or_else(|| {
        LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim decision has no target ref".into(),
        }
    })?;
    let candidate = &verified.evidence.candidate;
    if stored.dispatch_envelope_digest != verified.evidence.dispatch_envelope_digest
        || stored.candidate_ref != candidate.candidate_ref
        || stored.candidate_commit_sha != candidate.candidate_commit_sha
        || stored.candidate_tree_digest != candidate.tree_digest
        || stored.base_commit_sha != candidate.base_commit_sha
        || stored.target_ref != target_ref
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim projection does not bind the current candidate and target facts".into(),
        });
    }
    let event = load_verified_promotion_event(
        conn,
        stored.promotion_execution_claim_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "promotion execution claim",
    )?;
    if event.run_id != decision.run_id
        || event.parent_event_id != Some(decision.promotion_decision_event_id)
        || canonical_event_hash(&event)? != stored.promotion_execution_claim_event_digest
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim event does not bind its immutable projection".into(),
        });
    }
    let Payload::PromotionExecutionClaimedV1(payload) = &event.payload else {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim projection references the wrong event payload"
                .into(),
        });
    };
    let expected_claim_digest =
        promotion_execution_claimed_v1_digest(payload).map_err(|error| {
            LedgerError::PromotionExecutionClaimReconciliationRequired {
                run_id: decision.run_id.to_string(),
                candidate_digest: decision.candidate_digest.clone(),
                reason: format!("could not canonicalize stored promotion execution claim: {error}"),
            }
        })?;
    if payload.promotion_execution_claim_digest != expected_claim_digest
        || payload.run_id != stored.run_id.to_string()
        || payload.promotion_decision_event_ref != stored.promotion_decision_event_id
        || payload.promotion_decision_event_digest != stored.promotion_decision_event_digest
        || payload.dispatch_event_ref != stored.dispatch_event_id
        || payload.dispatch_envelope_digest != stored.dispatch_envelope_digest
        || payload.candidate_digest != stored.candidate_digest
        || payload.candidate_ref != stored.candidate_ref
        || payload.candidate_commit_sha != stored.candidate_commit_sha
        || payload.candidate_tree_digest != stored.candidate_tree_digest
        || payload.base_commit_sha != stored.base_commit_sha
        || payload.target_ref != stored.target_ref
        || payload.idempotency_key != stored.idempotency_key
        || payload.authority_actor != stored.authority_actor
        || payload.lease_id != stored.lease_id
        || payload.claimed_at != stored.claimed_at
        || payload.lease_expires_at != stored.lease_expires_at
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim signed payload does not match its projection".into(),
        });
    }
    let claimed_at = parse_claim_timestamp(&payload.claimed_at).map_err(|_| {
        LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim timestamp is malformed".into(),
        }
    })?;
    let lease_expires_at = parse_claim_timestamp(&payload.lease_expires_at).map_err(|_| {
        LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim expiry is malformed".into(),
        }
    })?;
    let dispatch_expires_at = parse_claim_timestamp(&verified.evidence.dispatch.body.expires_at)
        .map_err(
            |_| LedgerError::PromotionExecutionClaimReconciliationRequired {
                run_id: decision.run_id.to_string(),
                candidate_digest: decision.candidate_digest.clone(),
                reason: "promotion execution claim dispatch expiry is malformed".into(),
            },
        )?;
    if claimed_at != event.occurred_at
        || lease_expires_at <= claimed_at
        || lease_expires_at > dispatch_expires_at
        || payload.lease_id.trim().is_empty()
        || !is_canonical_target_ref(&payload.target_ref)
    {
        return Err(LedgerError::PromotionExecutionClaimReconciliationRequired {
            run_id: decision.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason: "promotion execution claim timestamp, lease, or target binding is invalid"
                .into(),
        });
    }
    Ok(payload.clone())
}

fn resolve_existing_governed_promotion_result(
    conn: &Connection,
    stored: &StoredGovernedPromotionResult,
    request: &GovernedPromotionResultRequestV1,
    decision: &StoredGovernedPromotionDecision,
    verified: &VerifiedStoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<GovernedPromotionResultDispositionV1> {
    if stored.run_id != request.run_id
        || stored.promotion_decision_event_id != request.promotion_decision_event_id
        || stored.candidate_digest != decision.candidate_digest
        || stored.idempotency_key != decision.idempotency_key
        || stored.promotion_decision_event_digest != decision.promotion_decision_event_digest
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result projection identity does not match the sealed decision",
        ));
    }
    let event = load_verified_promotion_event(
        conn,
        stored.promotion_result_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "promotion result",
    )?;
    if event.run_id != request.run_id
        || event.parent_event_id != Some(decision.promotion_decision_event_id)
        || canonical_event_hash(&event)? != stored.promotion_result_event_digest
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result tape event does not bind its immutable native projection",
        ));
    }
    let Payload::PromotionResultRecordedV1(payload) = &event.payload else {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result projection does not reference a promotion_result_recorded event",
        ));
    };
    if payload.candidate_digest != stored.candidate_digest
        || payload.idempotency_key != stored.idempotency_key
        || payload.promotion_decision_ref != decision.promotion_decision_event_id.to_string()
        || payload.outcome != stored.outcome
        || payload.merged_head_sha != stored.merged_head_sha
        || payload.promotion_git_binding != stored.promotion_git_binding
        || payload.completed_at != stored.completed_at
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result projection does not match its signed tape event",
        ));
    }
    validate_governed_promotion_result_against_decision(
        &GovernedPromotionResultRequestV1 {
            run_id: request.run_id,
            promotion_decision_event_id: request.promotion_decision_event_id,
            outcome: payload.outcome,
            merged_head_sha: payload.merged_head_sha.clone(),
            promotion_git_binding: payload.promotion_git_binding.clone(),
            promotion_execution_lease_binding: payload.promotion_execution_lease_binding.clone(),
        },
        decision,
        verified,
    )?;
    validate_governed_promotion_result_execution_lease(
        conn, request, decision, verified, authority, None,
    )?;
    if request.outcome != payload.outcome
        || request.merged_head_sha != payload.merged_head_sha
        || request.promotion_git_binding != payload.promotion_git_binding
        || request.promotion_execution_lease_binding != payload.promotion_execution_lease_binding
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result retry differs from the immutable recorded outcome",
        ));
    }
    Ok(GovernedPromotionResultDispositionV1::Existing {
        promotion_result_event_id: stored.promotion_result_event_id,
        promotion_result_event_digest: stored.promotion_result_event_digest.clone(),
        outcome: stored.outcome,
    })
}

fn resolve_existing_governed_promotion_decision(
    conn: &Connection,
    stored: &StoredGovernedPromotionDecision,
    request: &GovernedPromotionDecisionRequestV1,
    request_digest: &str,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<GovernedPromotionDecisionDispositionV1> {
    if stored.decision_request_digest != request_digest {
        return Err(LedgerError::PromotionDecisionIdempotencyConflict {
            run_id: request.run_id.to_string(),
            idempotency_key: stored.idempotency_key.clone(),
        });
    }
    verify_stored_governed_promotion_decision(conn, stored, authority)?;
    match stored.state {
        StoredGovernedPromotionDecisionState::AwaitingKernelCheckpoint => {
            Ok(GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
                promotion_decision_event_id: stored.promotion_decision_event_id,
                promotion_decision_event_digest: stored.promotion_decision_event_digest.clone(),
                candidate_digest: stored.candidate_digest.clone(),
                idempotency_key: stored.idempotency_key.clone(),
            })
        }
        StoredGovernedPromotionDecisionState::Sealed => {
            let checkpoint = verified_kernel_checkpoint_by_id(
                conn,
                request.run_id,
                stored.required_sealed_checkpoint_event_id()?,
                authority,
            )?;
            let expected_digest = stored
                .sealed_checkpoint_event_digest
                .as_deref()
                .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
                    run_id: request.run_id.to_string(),
                    candidate_digest: stored.candidate_digest.clone(),
                    reason: "sealed promotion decision lacks its checkpoint digest".into(),
                })?;
            if checkpoint.event_digest != expected_digest {
                return Err(LedgerError::PromotionDecisionReconciliationRequired {
                    run_id: request.run_id.to_string(),
                    candidate_digest: stored.candidate_digest.clone(),
                    reason:
                        "sealed promotion checkpoint digest does not match its immutable projection"
                            .into(),
                });
            }
            Ok(GovernedPromotionDecisionDispositionV1::Sealed {
                promotion_decision_event_id: stored.promotion_decision_event_id,
                promotion_decision_event_digest: stored.promotion_decision_event_digest.clone(),
                candidate_digest: stored.candidate_digest.clone(),
                idempotency_key: stored.idempotency_key.clone(),
                checkpoint_event_id: checkpoint.event_id,
                checkpoint_event_digest: checkpoint.event_digest,
            })
        }
    }
}

#[derive(Clone, Debug)]
struct VerifiedStoredGovernedPromotionDecision {
    evidence: VerifiedGovernedPromotionDecisionEvidence,
    decision: PromotionDecisionRecordedV1,
}

fn verify_stored_governed_promotion_decision(
    conn: &Connection,
    stored: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    verified_governed_promotion_decision_from_stored(conn, stored, authority).map(|_| ())
}

/// Re-check the projection-side seal immediately before the result writer
/// accepts terminal effect evidence. A copied/corrupted `sealed` state must
/// never let a result skip the exact kernel checkpoint that covered the
/// operator decision.
fn verify_stored_governed_promotion_decision_seal(
    conn: &Connection,
    stored: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    if stored.state != StoredGovernedPromotionDecisionState::Sealed {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion result requires a sealed decision projection".into(),
        });
    }
    let checkpoint_event_id = stored.required_sealed_checkpoint_event_id()?;
    let expected_digest = stored
        .sealed_checkpoint_event_digest
        .as_deref()
        .ok_or_else(|| LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "sealed promotion decision lacks its checkpoint digest".into(),
        })?;
    let checkpoint =
        verified_kernel_checkpoint_by_id(conn, stored.run_id, checkpoint_event_id, authority)?;
    if checkpoint.event_digest != expected_digest {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "sealed promotion decision checkpoint digest does not match its projection"
                .into(),
        });
    }
    let checkpoint_event = load_verified_promotion_event(
        conn,
        checkpoint_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "sealed promotion checkpoint",
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = &checkpoint_event.payload else {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "sealed promotion decision checkpoint has the wrong payload".into(),
        });
    };
    let signed = signed_ordinary_events_for_connection(conn, &stored.run_id)?;
    let Some(decision_index) = signed
        .iter()
        .position(|event| event.event_id == stored.promotion_decision_event_id)
    else {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "sealed promotion decision is absent from the signed prefix".into(),
        });
    };
    let checkpoint_count =
        usize::try_from(checkpoint_payload.through_event_count).map_err(|_| {
            LedgerError::PromotionDecisionReconciliationRequired {
                run_id: stored.run_id.to_string(),
                candidate_digest: stored.candidate_digest.clone(),
                reason: "sealed promotion decision checkpoint count exceeds platform limits".into(),
            }
        })?;
    if checkpoint_payload.run_id != stored.run_id
        || checkpoint_payload.algorithm != TapeRootAlgorithm::Sha256Linear
        || checkpoint_event.parent_event_id != Some(checkpoint_payload.through_event_id)
        || checkpoint_count == 0
        || checkpoint_count > signed.len()
        || decision_index >= checkpoint_count
        || signed[checkpoint_count - 1].event_id != checkpoint_payload.through_event_id
        || tape_root_hash(
            &signed[..checkpoint_count]
                .iter()
                .map(|event| event.canonical_event_hash.clone())
                .collect::<Vec<_>>(),
        ) != checkpoint_payload.tape_root_hash
    {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "sealed promotion decision is not covered by its exact kernel checkpoint"
                .into(),
        });
    }
    Ok(())
}

fn verified_governed_promotion_decision_from_stored(
    conn: &Connection,
    stored: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<VerifiedStoredGovernedPromotionDecision> {
    let request = GovernedPromotionDecisionRequestV1 {
        run_id: stored.run_id,
        dispatch_event_id: stored.dispatch_event_id,
        candidate_created_event_id: stored.candidate_created_event_id,
        candidate_completion_event_id: stored.candidate_completion_event_id,
        acceptance_event_id: stored.acceptance_event_id,
        review_event_ids: stored.review_event_ids.clone(),
        promotion_approval_request_event_id: stored.promotion_approval_request_event_id,
        decision: stored.decision_kind,
    };
    validate_governed_promotion_decision_request(&request)?;
    if governed_promotion_decision_request_digest(&request)? != stored.decision_request_digest {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision projection request digest does not match its immutable references".into(),
        });
    }
    let event = load_verified_promotion_event(
        conn,
        stored.promotion_decision_event_id,
        &authority.trusted_keys,
        &authority.operator_signer,
        "promotion decision",
    )?;
    if event.run_id != stored.run_id
        || event.parent_event_id != Some(stored.promotion_approval_request_event_id)
        || canonical_event_hash(&event)? != stored.promotion_decision_event_digest
    {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision tape event does not bind its immutable native projection"
                .into(),
        });
    }
    let Payload::PromotionDecisionRecordedV1(decision) = &event.payload else {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision projection does not reference a promotion_decision_recorded event".into(),
        });
    };
    let decision = decision.clone();
    let decided_at = parse_claim_timestamp(&decision.decided_at).map_err(|_| {
        LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision timestamp is not canonical RFC3339 UTC".into(),
        }
    })?;
    let evidence =
        verify_governed_promotion_decision_evidence(conn, &request, authority, decided_at, true)?;
    let approval_request_ref = stored.promotion_approval_request_event_id.to_string();
    if decision.candidate_digest != evidence.candidate.candidate_digest
        || decision.base_commit_sha != evidence.candidate.base_commit_sha
        || decision.target_ref.as_deref() != Some(evidence.approval.target_ref.as_str())
        || decision.envelope_digest != evidence.dispatch_envelope_digest
        || decision.acceptance_ref != evidence.acceptance.acceptance_ref
        || decision.review_refs != evidence.approval.review_refs
        || decision.promotion_approval_request_ref.as_deref() != Some(approval_request_ref.as_str())
        || decision.decision != stored.decision_kind
        || decision.authority != authority.operator_signer.actor_id
        || decision.decided_by != authority.operator_signer.actor_id
        || decision.idempotency_key != evidence.approval.idempotency_key
    {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision does not exactly bind its approval request and operator authority".into(),
        });
    }
    if stored.candidate_digest != evidence.candidate.candidate_digest
        || stored.idempotency_key != evidence.approval.idempotency_key
    {
        return Err(LedgerError::PromotionDecisionReconciliationRequired {
            run_id: stored.run_id.to_string(),
            candidate_digest: stored.candidate_digest.clone(),
            reason: "promotion decision projection candidate or idempotency key does not match signed evidence".into(),
        });
    }
    Ok(VerifiedStoredGovernedPromotionDecision { evidence, decision })
}

fn validate_governed_promotion_execution_claim_request(
    request: &GovernedPromotionExecutionClaimRequestV1,
) -> Result<()> {
    if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&request.lease_duration_ms) {
        return Err(LedgerError::InvalidPayload {
            kind: "claim_governed_promotion_execution_v1".into(),
            reason: format!(
                "lease_duration_ms must be between {MIN_ACTIVITY_LEASE_MS} and {MAX_ACTIVITY_LEASE_MS}"
            ),
        });
    }
    Ok(())
}

fn validate_governed_promotion_result_request(
    request: &GovernedPromotionResultRequestV1,
) -> Result<()> {
    let has_merged_head = request.merged_head_sha.is_some();
    let has_git_binding = request.promotion_git_binding.is_some();
    match request.outcome {
        PromotionResultOutcomeV1::Rejected if has_merged_head || has_git_binding => {
            Err(LedgerError::InvalidPayload {
                kind: "record_governed_promotion_result_v1".into(),
                reason: "rejected promotion result must omit Git merge evidence".into(),
            })
        }
        PromotionResultOutcomeV1::Promoted | PromotionResultOutcomeV1::ReconciliationRequired
            if !has_merged_head || !has_git_binding =>
        {
            Err(LedgerError::InvalidPayload {
                kind: "record_governed_promotion_result_v1".into(),
                reason: "promotion result with a merge outcome requires merged_head_sha and promotion_git_binding".into(),
            })
        }
        _ => Ok(()),
    }
}

fn promotion_execution_claim_reconciliation_required(
    request: &GovernedPromotionExecutionClaimRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::PromotionExecutionClaimReconciliationRequired {
        run_id: request.run_id.to_string(),
        candidate_digest: "unknown".into(),
        reason: reason.into(),
    }
}

fn promotion_result_reconciliation_required(
    request: &GovernedPromotionResultRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::PromotionResultReconciliationRequired {
        run_id: request.run_id.to_string(),
        candidate_digest: "unknown".into(),
        reason: reason.into(),
    }
}

fn validate_governed_promotion_result_against_decision(
    request: &GovernedPromotionResultRequestV1,
    stored: &StoredGovernedPromotionDecision,
    verified: &VerifiedStoredGovernedPromotionDecision,
) -> Result<()> {
    let candidate = &verified.evidence.candidate;
    let decision = &verified.decision;
    if request.run_id != stored.run_id
        || request.promotion_decision_event_id != stored.promotion_decision_event_id
        || decision.candidate_digest != candidate.candidate_digest
        || decision.candidate_digest != stored.candidate_digest
        || decision.idempotency_key != stored.idempotency_key
        || decision.base_commit_sha != candidate.base_commit_sha
        || decision.envelope_digest != candidate.envelope_digest
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "promotion result does not bind the sealed candidate decision",
        ));
    }

    match (decision.decision, request.outcome) {
        (PromotionDecisionKindV1::Reject, PromotionResultOutcomeV1::Rejected) => return Ok(()),
        (PromotionDecisionKindV1::Reject, _) => {
            return Err(promotion_result_reconciliation_required(
                request,
                "a rejected promotion decision cannot record a Git effect",
            ))
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Rejected) => {
            // A native preflight can reject a stale/invalid target before it
            // enters the Git effect. It still carries no merge evidence.
            return Ok(());
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Promoted) => {
            // New governed decisions are target-bound. A target ref update
            // deliberately leaves the root checkout untouched, so it must
            // remain reconciliation-required until a separate reconciler
            // proves the checkout can move safely. `Promoted` stays only for
            // historical unbound records, which this protected writer never
            // emits.
            return Err(promotion_result_reconciliation_required(
                request,
                "target-bound governed promotion must await root reconciliation",
            ));
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::ReconciliationRequired) => {}
    }

    let Some(target_ref) = decision.target_ref.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "new governed promotion result requires a target-bound decision",
        ));
    };
    let Some(merged_head_sha) = request.merged_head_sha.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "reconciliation result lacks a merged head",
        ));
    };
    let Some(binding) = request.promotion_git_binding.as_ref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "reconciliation result lacks Git binding evidence",
        ));
    };
    let expected_receipt_ref = candidate
        .candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .map(|suffix| format!("refs/buildplane/promotions/{suffix}"))
        .ok_or_else(|| {
            promotion_result_reconciliation_required(
                request,
                "candidate reference cannot derive a canonical promotion receipt ref",
            )
        })?;
    let Some(binding_merged_head_sha) = binding.merged_head_sha.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks the observed merge object",
        ));
    };
    let Some(target_head_after_sha) = binding.target_head_after_sha.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks the observed target head",
        ));
    };
    let Some(merge_parent_shas) = binding.merge_parent_shas.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks ordered merge parent evidence",
        ));
    };
    let Some(merged_tree_sha) = binding.merged_tree_sha.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks the observed merge tree",
        ));
    };
    let Some(receipt_ref) = binding.promotion_receipt_ref.as_deref() else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks the immutable promotion receipt ref",
        ));
    };
    let Some(sync_state) = binding.worktree_sync_state else {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding lacks explicit checkout reconciliation state",
        ));
    };
    if !is_canonical_target_ref(target_ref)
        || !is_canonical_git_commit_sha(merged_head_sha)
        || !is_canonical_git_commit_sha(target_head_after_sha)
        || !is_canonical_git_commit_sha(binding_merged_head_sha)
        || !is_canonical_git_commit_sha(&binding.target_head_before_sha)
        || !is_canonical_git_commit_sha(&binding.candidate_commit_sha)
        || !is_canonical_git_commit_sha(merged_tree_sha)
        || !is_canonical_sha256_digest(&binding.merged_tree_digest)
        || merge_parent_shas
            .iter()
            .any(|parent_sha| !is_canonical_git_commit_sha(parent_sha))
        || binding.target_ref != target_ref
        || binding.target_head_before_sha != candidate.base_commit_sha
        || binding.candidate_commit_sha != candidate.candidate_commit_sha
        || binding.merged_tree_digest != candidate.tree_digest
        || binding_merged_head_sha != merged_head_sha
        || merge_parent_shas.len() != 2
        || merge_parent_shas[0] != candidate.base_commit_sha.as_str()
        || merge_parent_shas[1] != candidate.candidate_commit_sha.as_str()
        || receipt_ref != expected_receipt_ref.as_str()
    {
        return Err(promotion_result_reconciliation_required(
            request,
            "Git binding does not exactly bind the candidate, target, and merge evidence",
        ));
    }
    match sync_state {
        PromotionWorktreeSyncStateV1::RootCheckoutStale
            if target_head_after_sha == merged_head_sha =>
        {
            Ok(())
        }
        PromotionWorktreeSyncStateV1::TargetAdvanced
            if target_head_after_sha != merged_head_sha =>
        {
            Ok(())
        }
        PromotionWorktreeSyncStateV1::PendingReconciliation => {
            Err(promotion_result_reconciliation_required(
                request,
                "native target-bound writer must classify an untouched root as root_checkout_stale",
            ))
        }
        _ => Err(promotion_result_reconciliation_required(
            request,
            "Git binding target observation conflicts with its reconciliation state",
        )),
    }
}

/// Bind every new target-effect result to the one signed promotion execution
/// claim. A sealed decision by itself is intentionally insufficient: only the
/// opaque lease from the durable claim can close an effect-bearing result.
///
/// `observed_at` is supplied only while writing a fresh result. Exact replay
/// of an already-recorded result validates the immutable binding without
/// retroactively treating an elapsed lease as a new effect attempt.
fn validate_governed_promotion_result_execution_lease(
    conn: &Connection,
    request: &GovernedPromotionResultRequestV1,
    decision: &StoredGovernedPromotionDecision,
    verified: &VerifiedStoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
    observed_at: Option<DateTime<Utc>>,
) -> Result<()> {
    let claim = governed_promotion_execution_claim_by_decision(
        conn,
        request.run_id,
        request.promotion_decision_event_id,
    )?;
    let reject = |reason: &str| LedgerError::PromotionResultReconciliationRequired {
        run_id: request.run_id.to_string(),
        candidate_digest: decision.candidate_digest.clone(),
        reason: reason.into(),
    };

    match (verified.decision.decision, request.outcome) {
        // A negative operator decision has no target-ref effect and must not
        // acquire or consume a promotion lease.
        (PromotionDecisionKindV1::Reject, PromotionResultOutcomeV1::Rejected) => {
            if claim.is_some() || request.promotion_execution_lease_binding.is_some() {
                return Err(reject(
                    "a rejected promotion decision must not carry a promotion execution lease",
                ));
            }
            return Ok(());
        }
        (PromotionDecisionKindV1::Reject, _) => {
            return Err(reject(
                "a rejected promotion decision cannot record a target-effect result",
            ));
        }
        // A no-Git preflight rejection is deliberately lease-free. Once a
        // claim exists, however, the terminal record must name it exactly so
        // recovery cannot lose an in-flight reservation.
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Rejected)
            if claim.is_none() =>
        {
            if request.promotion_execution_lease_binding.is_some() {
                return Err(reject(
                    "a lease binding was supplied but no promotion execution claim exists",
                ));
            }
            return Ok(());
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Promoted) => {
            return Err(reject(
                "target-bound governed promotion cannot record a promoted terminal result",
            ));
        }
        _ => {}
    }

    let claim = claim.ok_or_else(|| {
        reject("a promotion effect result requires a durable promotion execution claim")
    })?;
    let payload =
        verify_stored_governed_promotion_execution_claim(conn, &claim, decision, authority)?;
    if observed_at.is_some() {
        verify_stored_governed_promotion_execution_claim_seal(conn, &claim, decision, authority)?;
    }
    let binding = request
        .promotion_execution_lease_binding
        .as_ref()
        .ok_or_else(|| reject("promotion effect result is missing its execution lease binding"))?;
    if binding.promotion_execution_claim_event_ref != claim.promotion_execution_claim_event_id
        || binding.promotion_execution_claim_event_digest
            != claim.promotion_execution_claim_event_digest
        || binding.lease_id != claim.lease_id
        || binding.lease_id != payload.lease_id
    {
        return Err(reject(
            "promotion effect result does not bind the exact immutable execution lease",
        ));
    }

    if request.outcome == PromotionResultOutcomeV1::Rejected {
        let Some(observed_at) = observed_at else {
            return Ok(());
        };
        let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at)
            .map_err(|_| reject("promotion execution claim expiry is malformed"))?;
        if observed_at >= lease_expires_at {
            return Err(reject(
                "an expired promotion lease may be reconciled only with proof-bearing reconciliation-required Git evidence",
            ));
        }
    }
    Ok(())
}

/// A signed claim is not usable merely because its projection committed. The
/// claim writer deliberately commits the immutable event before it emits the
/// response-gating checkpoint, so a crash at that boundary leaves recovery
/// evidence but must not permit a fresh target effect. Before a *new* result
/// is written, require the current verified kernel checkpoint to cover the
/// exact claim event. Existing terminal records use their own immutable signed
/// result path and do not retroactively impose this requirement on historical
/// pre-claim tapes.
fn verify_stored_governed_promotion_execution_claim_seal(
    conn: &Connection,
    claim: &StoredGovernedPromotionExecutionClaim,
    decision: &StoredGovernedPromotionDecision,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    let checkpoint = fully_covering_kernel_checkpoint(
        conn,
        claim.run_id,
        claim.promotion_execution_claim_event_id,
        authority,
    )?;
    if checkpoint.is_none() {
        return Err(LedgerError::PromotionResultReconciliationRequired {
            run_id: claim.run_id.to_string(),
            candidate_digest: decision.candidate_digest.clone(),
            reason:
                "promotion execution claim is not covered by the current exact kernel checkpoint"
                    .into(),
        });
    }
    Ok(())
}

fn fully_covering_kernel_checkpoint(
    conn: &Connection,
    run_id: RunId,
    covered_event_id: EventId,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<Option<PromotionCheckpointEvidence>> {
    let signed = signed_ordinary_events_for_connection(conn, &run_id)?;
    let Some(covered_event_index) = signed
        .iter()
        .position(|event| event.event_id == covered_event_id)
    else {
        return promotion_authority_rejected(
            "governed event is absent from the signed ordinary-event prefix",
        );
    };
    let Some(latest) = latest_checkpoint_for_connection(conn, &run_id)? else {
        return Ok(None);
    };
    // A checkpoint is useful to the governed promotion path only when it
    // covers the *current* complete signed prefix. Comparing UUID values alone
    // is not a proof of membership: UUIDs can be pre-generated and the tape
    // root is ordered by event identity. Require the exact final event, count,
    // and root instead.
    let Some(last) = signed.last() else {
        return Ok(None);
    };
    if latest.through_event_count != signed.len() as u64
        || latest.through_event_id != last.event_id
        || latest.through_event_count <= covered_event_index as u64
    {
        return Ok(None);
    }
    let checkpoint = verified_kernel_checkpoint_by_id(conn, run_id, latest.event_id, authority)?;
    let checkpoint_event = load_verified_promotion_event(
        conn,
        checkpoint.event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "kernel tape checkpoint",
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = checkpoint_event.payload else {
        return promotion_authority_rejected(
            "sealed promotion checkpoint does not carry TapeCheckpointV1 payload",
        );
    };
    let expected_root = tape_root_hash(
        &signed
            .iter()
            .map(|event| event.canonical_event_hash.clone())
            .collect::<Vec<_>>(),
    );
    if checkpoint_payload.run_id != run_id
        || checkpoint_payload.algorithm != TapeRootAlgorithm::Sha256Linear
        || checkpoint_payload.through_event_id != last.event_id
        || checkpoint_payload.through_event_count != signed.len() as u64
        || checkpoint_payload.tape_root_hash != expected_root
    {
        return promotion_authority_rejected(
            "kernel tape checkpoint does not verify the complete signed promotion prefix",
        );
    }
    Ok(Some(checkpoint))
}

fn verified_kernel_checkpoint_by_id(
    conn: &Connection,
    run_id: RunId,
    checkpoint_event_id: EventId,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<PromotionCheckpointEvidence> {
    let event = load_verified_promotion_event(
        conn,
        checkpoint_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "kernel tape checkpoint",
    )?;
    if event.run_id != run_id {
        return promotion_authority_rejected("kernel tape checkpoint belongs to a different run");
    }
    let Payload::TapeCheckpointV1(checkpoint) = &event.payload else {
        return promotion_authority_rejected(
            "sealed promotion checkpoint does not carry TapeCheckpointV1 payload",
        );
    };
    if checkpoint.run_id != run_id || event.parent_event_id != Some(checkpoint.through_event_id) {
        return promotion_authority_rejected(
            "kernel tape checkpoint does not anchor its signed run and covered event",
        );
    }
    Ok(PromotionCheckpointEvidence {
        event_id: checkpoint_event_id,
        event_digest: canonical_event_hash(&event)?,
    })
}

fn latest_checkpoint_for_connection(
    conn: &Connection,
    run_id: &RunId,
) -> Result<Option<StoredCheckpoint>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.payload FROM events e
         JOIN event_signatures s ON s.event_id = e.id
         WHERE e.run_id = ?1 AND e.kind = 'tape_checkpoint'
         ORDER BY e.id DESC LIMIT 1",
    )?;
    let row = stmt
        .query_row(params![run_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .optional()?;
    let Some((id, payload_json)) = row else {
        return Ok(None);
    };
    let event_id = parse_event_id(&id, "tape_checkpoint")?;
    let payload: Payload = serde_json::from_str(&payload_json)?;
    let Payload::TapeCheckpointV1(checkpoint) = payload else {
        return Err(invalid_payload(
            "tape_checkpoint",
            "checkpoint row payload is not a TapeCheckpointV1".into(),
        ));
    };
    Ok(Some(StoredCheckpoint {
        event_id,
        checkpoint_index: checkpoint.checkpoint_index,
        through_event_id: checkpoint.through_event_id,
        through_event_count: checkpoint.through_event_count,
        tape_root_hash: checkpoint.tape_root_hash,
        algorithm: checkpoint.algorithm,
    }))
}

fn signed_ordinary_events_for_connection(
    conn: &Connection,
    run_id: &RunId,
) -> Result<Vec<SignedOrdinaryEvent>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, s.canonical_event_hash
         FROM events e
         JOIN event_signatures s ON s.event_id = e.id
         WHERE e.run_id = ?1 AND e.kind != 'tape_checkpoint'
         ORDER BY e.id ASC",
    )?;
    let rows = stmt.query_map(params![run_id.to_string()], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| {
        let (event_id, canonical_event_hash) = row?;
        Ok(SignedOrdinaryEvent {
            event_id: parse_event_id(&event_id, "signed ordinary event")?,
            canonical_event_hash,
        })
    })
    .collect()
}

fn events_for_run_for_connection(conn: &Connection, run_id: &str) -> Result<Vec<StoredEventRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload
         FROM events WHERE run_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![run_id], |row| {
        Ok(StoredEventRow {
            id: row.get(0)?,
            run_id: row.get(1)?,
            parent_event_id: row.get(2)?,
            schema_version: row.get(3)?,
            kind: row.get(4)?,
            occurred_at: row.get(5)?,
            payload: row.get(6)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(LedgerError::from)
}

fn signature_for_event_for_connection(
    conn: &Connection,
    event_id: &str,
) -> Result<Option<StoredEventSignatureRow>> {
    conn.query_row(
        r#"SELECT
                event_id,
                canonical_event_hash,
                actor_id,
                key_id,
                public_key_hash,
                algorithm,
                signature,
                signed_at
            FROM event_signatures
            WHERE event_id = ?1"#,
        params![event_id],
        |row| {
            Ok(StoredEventSignatureRow {
                event_id: row.get(0)?,
                canonical_event_hash: row.get(1)?,
                actor_id: row.get(2)?,
                key_id: row.get(3)?,
                public_key_hash: row.get(4)?,
                algorithm: row.get(5)?,
                signature: row.get(6)?,
                signed_at: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(LedgerError::from)
}

fn signed_events_for_run_for_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<(Event, Option<EventSignatureV1>)>> {
    events_for_run_for_connection(conn, run_id)?
        .into_iter()
        .map(|row| {
            let event = row.to_event()?;
            let signature = match signature_for_event_for_connection(conn, &row.id)? {
                Some(signature_row) => Some(signature_row.to_event_signature()?),
                None => None,
            };
            Ok((event, signature))
        })
        .collect()
}

fn promotion_decision_kind_wire(decision: PromotionDecisionKindV1) -> &'static str {
    match decision {
        PromotionDecisionKindV1::Promote => "promote",
        PromotionDecisionKindV1::Reject => "reject",
    }
}

fn promotion_result_outcome_wire(outcome: PromotionResultOutcomeV1) -> &'static str {
    match outcome {
        PromotionResultOutcomeV1::Promoted => "promoted",
        PromotionResultOutcomeV1::ReconciliationRequired => "reconciliation_required",
        PromotionResultOutcomeV1::Rejected => "rejected",
    }
}

fn is_canonical_target_ref(value: &str) -> bool {
    let Some(branch) = value.strip_prefix("refs/heads/") else {
        return false;
    };
    !branch.is_empty()
        && value.is_ascii()
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        && !value.contains("..")
        && !value.contains("//")
        && !value.contains("@{")
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value.ends_with(".lock")
}

fn model_action_intent_by_action_request(
    conn: &Connection,
    run_id: RunId,
    action_request_event_id: EventId,
) -> Result<Option<StoredModelActionIntent>> {
    conn.query_row(
        "SELECT run_id, action_request_event_id, dispatch_event_id, action_request_digest, \
                model_request_evidence_digest, trust_scope_evidence_digest, intent_event_id, \
                intent_digest, created_at \
         FROM model_action_intents \
         WHERE run_id = ?1 AND action_request_event_id = ?2",
        params![run_id.to_string(), action_request_event_id.to_string()],
        stored_model_action_intent_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn model_action_authorization_by_action_request(
    conn: &Connection,
    run_id: RunId,
    action_request_event_id: EventId,
) -> Result<Option<StoredModelActionAuthorization>> {
    conn.query_row(
        "SELECT run_id, action_request_event_id, dispatch_event_id, action_request_digest, \
                intent_event_id, intent_digest, authorization_event_id, authorization_event_digest, \
                authorization_ref, authorization_digest, authorization_expires_at, claim_event_id, created_at \
         FROM model_action_authorizations \
         WHERE run_id = ?1 AND action_request_event_id = ?2",
        params![run_id.to_string(), action_request_event_id.to_string()],
        stored_model_action_authorization_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

/// Detect a V2 event even when its cache/projection is missing or corrupt.
/// A damaged database may lose availability, but it must never let a new
/// authorization replace a possibly dispatched provider effect.
fn model_action_authorization_event_exists_for_action_request(
    conn: &Connection,
    run_id: RunId,
    action_request_event_id: EventId,
) -> Result<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS( \
             SELECT 1 FROM events authorization \
             WHERE authorization.run_id = ?1 \
               AND authorization.kind = 'model_action_authorized_v2' \
               AND ( \
                 authorization.parent_event_id = ?2 \
                 OR authorization.parent_event_id IN ( \
                   SELECT id FROM events intent \
                   WHERE intent.run_id = ?1 \
                     AND intent.kind = 'model_action_intent_v1' \
                     AND intent.parent_event_id = ?2 \
                 ) \
               ) \
         )",
        params![run_id.to_string(), action_request_event_id.to_string()],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(exists != 0)
}

fn model_action_intent_event_exists_for_action_request(
    conn: &Connection,
    run_id: RunId,
    action_request_event_id: EventId,
) -> Result<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(\
            SELECT 1 FROM events \
            WHERE run_id = ?1 AND parent_event_id = ?2 AND kind = 'model_action_intent_v1'\
        )",
        params![run_id.to_string(), action_request_event_id.to_string()],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(exists != 0)
}

fn stored_model_action_intent_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredModelActionIntent> {
    let run_id: String = row.get(0)?;
    let action_request_event_id: String = row.get(1)?;
    let dispatch_event_id: String = row.get(2)?;
    let intent_event_id: String = row.get(6)?;
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: &str| {
        Uuid::parse_str(value)
            .map(EventId::from_uuid)
            .map_err(|error| to_sql_error(format!("invalid model action intent event id: {error}")))
    };
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| to_sql_error(format!("invalid model action intent run id: {error}")))?;
    Ok(StoredModelActionIntent {
        run_id,
        action_request_event_id: parse_event(&action_request_event_id)?,
        dispatch_event_id: parse_event(&dispatch_event_id)?,
        action_request_digest: row.get(3)?,
        model_request_evidence_digest: row.get(4)?,
        trust_scope_evidence_digest: row.get(5)?,
        intent_event_id: parse_event(&intent_event_id)?,
        intent_digest: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn stored_model_action_authorization_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredModelActionAuthorization> {
    let run_id: String = row.get(0)?;
    let action_request_event_id: String = row.get(1)?;
    let dispatch_event_id: String = row.get(2)?;
    let intent_event_id: String = row.get(4)?;
    let authorization_event_id: String = row.get(6)?;
    let claim_event_id: String = row.get(11)?;
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: &str| {
        Uuid::parse_str(value)
            .map(EventId::from_uuid)
            .map_err(|error| {
                to_sql_error(format!(
                    "invalid model action authorization event id: {error}"
                ))
            })
    };
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| {
            to_sql_error(format!(
                "invalid model action authorization run id: {error}"
            ))
        })?;
    Ok(StoredModelActionAuthorization {
        run_id,
        action_request_event_id: parse_event(&action_request_event_id)?,
        dispatch_event_id: parse_event(&dispatch_event_id)?,
        action_request_digest: row.get(3)?,
        intent_event_id: parse_event(&intent_event_id)?,
        intent_digest: row.get(5)?,
        authorization_event_id: parse_event(&authorization_event_id)?,
        authorization_event_digest: row.get(7)?,
        authorization_ref: row.get(8)?,
        authorization_digest: row.get(9)?,
        authorization_expires_at: row.get(10)?,
        claim_event_id: parse_event(&claim_event_id)?,
        created_at: row.get(12)?,
    })
}

fn insert_model_action_authorization_projection(
    conn: &Connection,
    request: &GovernedModelActionAuthorizeAndClaimRequestV1,
    action_request_digest: &str,
    intent: &ModelActionIntentInTx,
    authorization_event: &Event,
    authorization_event_digest: &str,
    authorization: &ModelActionAuthorizedV2,
    claim_event: &Event,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        r#"INSERT INTO model_action_authorizations (
                run_id, action_request_event_id, dispatch_event_id, action_request_digest,
                intent_event_id, intent_digest, authorization_event_id, authorization_event_digest,
                authorization_ref, authorization_digest, authorization_expires_at, claim_event_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"#,
        params![
            request.run_id.to_string(),
            request.action_request_event_id.to_string(),
            request.dispatch_event_id.to_string(),
            action_request_digest,
            intent.intent_event_id.to_string(),
            &intent.intent.intent_digest,
            authorization_event.id.to_string(),
            authorization_event_digest,
            &authorization.authorization_ref,
            &authorization.authorization_digest,
            &authorization.expires_at,
            claim_event.id.to_string(),
            created_at,
        ],
    )?;
    Ok(())
}

fn verify_signed_model_action_intent_projection(
    conn: &Connection,
    stored: &StoredModelActionIntent,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    issue: &ModelActionIntentIssueRequestV1,
) -> Result<ModelActionIntentV1> {
    if stored.run_id != issue.run_id
        || stored.action_request_event_id != issue.action_request_event_id
        || stored.dispatch_event_id != issue.dispatch_event_id
    {
        return Err(model_action_intent_conflict(issue));
    }
    let event = load_verified_authority_event(
        conn,
        stored.intent_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "model action intent",
    )?;
    if event.run_id != stored.run_id
        || event.parent_event_id != Some(stored.action_request_event_id)
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent projection does not bind its signed tape event".into(),
        });
    }
    let Payload::ModelActionIntentV1(intent) = event.payload else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason:
                "model action intent projection does not reference a model_action_intent_v1 event"
                    .into(),
        });
    };
    let recomputed = model_action_intent_v1_digest(&intent).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("could not canonicalize projected model action intent: {error}"),
        }
    })?;
    if intent.intent_digest != recomputed
        || intent.intent_digest != stored.intent_digest
        || intent.action_request_event_ref != stored.action_request_event_id
        || intent.dispatch_event_ref != stored.dispatch_event_id
        || intent.action_request_digest != stored.action_request_digest
        || intent.model_request_evidence.digest != stored.model_request_evidence_digest
        || intent.trust_scope_evidence.digest != stored.trust_scope_evidence_digest
        || intent.intended_at != stored.created_at
        || intent.intent_actor != authority.claim_signer.actor_id
        || intent.candidate_binding.is_some()
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action intent projection does not exactly match its signed tape event"
                .into(),
        });
    }
    let intended_at = parse_claim_timestamp(&intent.intended_at).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("projected model action intent timestamp is invalid: {error}"),
        }
    })?;
    let evidence = verify_model_action_intent_issue_evidence(conn, issue, authority, intended_at)?;
    if !model_action_intent_matches_issue_evidence(&intent, issue, &evidence) {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason:
                "model action intent projection does not bind the verified dispatch/action evidence"
                    .into(),
        });
    }
    verify_model_action_intent_evidence_documents(
        cas,
        issue,
        &evidence,
        &intent.model_request_evidence,
        &intent.trust_scope_evidence,
    )?;
    Ok(intent)
}

/// Reconstruct the complete signed V3 model authority chain from immutable
/// tape and protected CAS. The SQLite authorization row is only a lookup
/// index; a missing, substituted, or partly committed projection blocks the
/// caller rather than allowing a new provider request.
fn verify_signed_governed_model_authorization_projection(
    conn: &Connection,
    stored: &StoredModelActionAuthorization,
    issue: &ModelActionIntentIssueRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
) -> Result<VerifiedGovernedModelAuthorization> {
    if stored.run_id != issue.run_id
        || stored.action_request_event_id != issue.action_request_event_id
        || stored.dispatch_event_id != issue.dispatch_event_id
    {
        return Err(LedgerError::ModelActionAuthorizationIdempotencyConflict {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
        });
    }
    let intent_projection =
        model_action_intent_by_action_request(conn, issue.run_id, issue.action_request_event_id)?
            .ok_or_else(
            || LedgerError::ModelActionAuthorizationReconciliationRequired {
                run_id: issue.run_id.to_string(),
                action_request_event_id: issue.action_request_event_id.to_string(),
                reason: "a V2 authorization projection exists without its model intent projection"
                    .into(),
            },
        )?;
    let intent = verify_signed_model_action_intent_projection(
        conn,
        &intent_projection,
        cas,
        authority,
        issue,
    )?;
    if intent_projection.intent_event_id != stored.intent_event_id
        || intent_projection.intent_digest != stored.intent_digest
        || intent.intent_digest != stored.intent_digest
        || intent.action_request_digest != stored.action_request_digest
    {
        return Err(
            LedgerError::ModelActionAuthorizationReconciliationRequired {
                run_id: issue.run_id.to_string(),
                action_request_event_id: issue.action_request_event_id.to_string(),
                reason:
                    "the V2 authorization projection does not exactly bind its signed model intent"
                        .into(),
            },
        );
    }

    let event = load_verified_authority_event(
        conn,
        stored.authorization_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "model action authorization",
    )?;
    if event.run_id != stored.run_id || event.parent_event_id != Some(stored.intent_event_id) {
        return Err(
            LedgerError::ModelActionAuthorizationReconciliationRequired {
                run_id: issue.run_id.to_string(),
                action_request_event_id: issue.action_request_event_id.to_string(),
                reason: "the signed V2 model authorization does not parent to its projected intent"
                    .into(),
            },
        );
    }
    if canonical_event_hash(&event)? != stored.authorization_event_digest {
        return Err(LedgerError::ModelActionAuthorizationReconciliationRequired {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
            reason: "the V2 model authorization projection digest does not match its signed tape event".into(),
        });
    }
    let authorized_at = event.occurred_at.clone();
    let Payload::ModelActionAuthorizedV2(authorization) = event.payload else {
        return Err(LedgerError::ModelActionAuthorizationReconciliationRequired {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
            reason: "the V2 model authorization projection does not reference model_action_authorized_v2".into(),
        });
    };
    let recomputed = model_action_authorized_v2_digest(&authorization).map_err(|error| {
        LedgerError::ModelActionAuthorizationReconciliationRequired {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
            reason: format!("could not canonicalize the signed V2 model authorization: {error}"),
        }
    })?;
    let expected_ref = governed_model_action_authorization_ref(
        authority,
        &GovernedModelActionAuthorizeAndClaimRequestV1 {
            run_id: issue.run_id,
            dispatch_event_id: issue.dispatch_event_id,
            action_request_event_id: issue.action_request_event_id,
            // The deterministic authorization ref intentionally does not
            // include lease duration; this field is unused for its derivation.
            lease_duration_ms: MIN_ACTIVITY_LEASE_MS,
        },
        stored.intent_event_id,
        &stored.intent_digest,
    )?;
    if authorization.intent_event_ref != stored.intent_event_id
        || authorization.intent_digest != stored.intent_digest
        || authorization.model_request_evidence != intent.model_request_evidence
        || authorization.trust_scope_evidence != intent.trust_scope_evidence
        || authorization.candidate_binding != intent.candidate_binding
        || authorization.authorization_actor != authority.claim_signer.actor_id
        || authorization.authorization_ref != stored.authorization_ref
        || authorization.authorization_ref != expected_ref
        || authorization.authorization_digest != recomputed
        || authorization.authorization_digest != stored.authorization_digest
        || authorization.expires_at != stored.authorization_expires_at
        || stored.created_at != timestamp(authorized_at.clone())
    {
        return Err(LedgerError::ModelActionAuthorizationReconciliationRequired {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
            reason: "the V2 model authorization projection does not exactly match its signed authority record".into(),
        });
    }
    let intended_at = parse_claim_timestamp(&intent.intended_at)?;
    let expires_at = parse_claim_timestamp(&authorization.expires_at)?;
    let evidence = verify_model_action_intent_issue_evidence(conn, issue, authority, intended_at)?;
    let dispatch_window = validate_governed_dispatch(&evidence.dispatch, intended_at).map_err(|error| {
        LedgerError::ModelActionAuthorizationReconciliationRequired {
            run_id: issue.run_id.to_string(),
            action_request_event_id: issue.action_request_event_id.to_string(),
            reason: format!("the signed V2 authorization no longer has a valid historical dispatch binding: {error}"),
        }
    })?;
    if authorization.expires_at != stored.authorization_expires_at
        || intended_at > authorized_at
        || authorized_at >= expires_at
        || expires_at > dispatch_window.effective_deadline
    {
        return Err(
            LedgerError::ModelActionAuthorizationReconciliationRequired {
                run_id: issue.run_id.to_string(),
                action_request_event_id: issue.action_request_event_id.to_string(),
                reason:
                    "the signed V2 authorization violates the sealed-V3 causal authority window"
                        .into(),
            },
        );
    }
    Ok(VerifiedGovernedModelAuthorization {
        intent,
        authorization,
        dispatch_window,
        authorized_at,
    })
}

/// Validate a model claim against the V2 authority that was committed with
/// it. Unlike generic claims, this intentionally requires the signed
/// intent/authorization chain and never turns an existing model lease into a
/// new authority grant.
fn verify_governed_model_claim_lineage(
    conn: &Connection,
    claim: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
    cas: &Cas,
) -> Result<VerifiedGovernedModelAuthorization> {
    let signed_claim = verify_signed_claim_projection(conn, claim, authority)?;
    if signed_claim.purpose != ActivityClaimPurposeV1::GovernedModelActionV1
        || signed_claim.action_kind != ActionKindV1::Model
        || claim.action_kind != ActionKindV1::Model
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "model activity state requires a lease minted by the dedicated native model authority transaction".into(),
        });
    }
    let issue = ModelActionIntentIssueRequestV1 {
        run_id: claim.run_id,
        dispatch_event_id: claim.dispatch_event_id,
        action_request_event_id: claim.action_request_event_id,
    };
    let authorization = model_action_authorization_by_action_request(
        conn,
        claim.run_id,
        claim.action_request_event_id,
    )?
    .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
        reason: "model activity lease has no trusted native V2 authorization projection".into(),
    })?;
    if authorization.claim_event_id != claim.claim_event_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "model activity lease does not match the V2 authorization projection claim"
                .into(),
        });
    }
    let verified = verify_signed_governed_model_authorization_projection(
        conn,
        &authorization,
        &issue,
        cas,
        authority,
    )?;
    let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
    let lease_expires_at = parse_claim_timestamp(&signed_claim.lease_expires_at)?;
    let authorization_expires_at = parse_claim_timestamp(&verified.authorization.expires_at)?;
    if signed_claim.action_request_digest != authorization.action_request_digest
        || signed_claim.dispatch_envelope_digest != verified.intent.dispatch_envelope_digest
        || signed_claim.dispatch_event_id != claim.dispatch_event_id
        || signed_claim.action_request_event_id != claim.action_request_event_id
        || signed_claim.authority_actor != authority.claim_signer.actor_id
        || claimed_at < verified.authorized_at
        || claimed_at >= authorization_expires_at
        || lease_expires_at > authorization_expires_at
        || lease_expires_at > verified.dispatch_window.effective_deadline
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "model activity lease violates its signed V2 authorization chain".into(),
        });
    }
    Ok(verified)
}

fn resolve_existing_governed_model_authorization<F>(
    conn: &Connection,
    stored: &StoredModelActionAuthorization,
    request: &GovernedModelActionAuthorizeAndClaimRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    clock: &mut F,
) -> Result<GovernedModelActionAuthorizeAndClaimDispositionV1>
where
    F: FnMut() -> DateTime<Utc>,
{
    if stored.run_id != request.run_id
        || stored.action_request_event_id != request.action_request_event_id
        || stored.dispatch_event_id != request.dispatch_event_id
    {
        return Err(LedgerError::ModelActionAuthorizationIdempotencyConflict {
            run_id: request.run_id.to_string(),
            action_request_event_id: request.action_request_event_id.to_string(),
        });
    }
    let issue = ModelActionIntentIssueRequestV1 {
        run_id: request.run_id,
        dispatch_event_id: request.dispatch_event_id,
        action_request_event_id: request.action_request_event_id,
    };
    let verified = verify_signed_governed_model_authorization_projection(
        conn, stored, &issue, cas, authority,
    )?;
    let claim =
        activity_claim_by_idempotency(conn, request.run_id, &verified.intent.idempotency_key)?
            .ok_or_else(|| {
                model_action_authorization_reconciliation_required(
                    request,
                    "the native V2 authorization projection has no activity claim projection",
                )
            })?;
    if claim.claim_event_id != stored.claim_event_id
        || claim.dispatch_event_id != request.dispatch_event_id
        || claim.action_request_event_id != request.action_request_event_id
        || claim.activity_id != verified.intent.action_id
        || claim.idempotency_key != verified.intent.idempotency_key
    {
        return Err(model_action_authorization_reconciliation_required(
            request,
            "the activity claim projection does not exactly bind the native V2 authorization",
        ));
    }
    if claim.lease_duration_ms != request.lease_duration_ms {
        return Err(LedgerError::ModelActionAuthorizationIdempotencyConflict {
            run_id: request.run_id.to_string(),
            action_request_event_id: request.action_request_event_id.to_string(),
        });
    }
    verify_governed_model_claim_lineage(conn, &claim, authority, cas)?;
    if claim.state == StoredActivityClaimState::Recorded {
        verify_signed_activity_result_projection(conn, &claim, authority)?;
        return Ok(
            GovernedModelActionAuthorizeAndClaimDispositionV1::Recorded {
                authorization_event_id: stored.authorization_event_id,
                authorization_ref: stored.authorization_ref.clone(),
                claim_event_id: claim.claim_event_id,
                result_event_id: required_claim_field(claim.result_event_id, "result_event_id")?,
                result_event_digest: required_claim_string(
                    claim.result_event_digest.as_deref(),
                    "result_event_digest",
                )?,
                outcome: required_claim_field(claim.result_outcome, "result_outcome")?,
            },
        );
    }
    let now = canonical_ledger_timestamp(clock())?;
    let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at)?;
    if now >= lease_expires_at {
        return Ok(
            GovernedModelActionAuthorizeAndClaimDispositionV1::LeaseExpired {
                authorization_event_id: stored.authorization_event_id,
                authorization_ref: stored.authorization_ref.clone(),
                claim_event_id: claim.claim_event_id,
                lease_expires_at: claim.lease_expires_at,
            },
        );
    }
    Ok(GovernedModelActionAuthorizeAndClaimDispositionV1::Pending {
        authorization_event_id: stored.authorization_event_id,
        authorization_ref: stored.authorization_ref.clone(),
        claim_event_id: claim.claim_event_id,
        lease_expires_at: claim.lease_expires_at,
    })
}

fn model_action_intent_matches_issue_evidence(
    intent: &ModelActionIntentV1,
    issue: &ModelActionIntentIssueRequestV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
) -> bool {
    intent.run_id == issue.run_id.to_string()
        && intent.workflow_id == evidence.action_request.workflow_id
        && intent.unit_id == evidence.action_request.unit_id
        && intent.attempt == evidence.action_request.attempt
        && intent.provenance_ref == evidence.action_request.provenance_ref
        && intent.action_id == evidence.action_request.action_id
        && intent.idempotency_key == evidence.action_request.idempotency_key
        && intent.dispatch_event_ref == issue.dispatch_event_id
        && intent.dispatch_envelope_digest == evidence.dispatch_envelope_digest
        && intent.action_request_event_ref == issue.action_request_event_id
        && intent.action_request_digest == evidence.action_request_digest
        && intent.canonical_input_ref == evidence.action_request.canonical_input_ref
        && intent.canonical_input_digest == evidence.action_request.canonical_input_digest
        && intent.candidate_binding.is_none()
}

fn insert_model_action_intent_projection(
    conn: &Connection,
    issue: &ModelActionIntentIssueRequestV1,
    action_request_digest: &str,
    event: &Event,
    intent: &ModelActionIntentV1,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        r#"INSERT INTO model_action_intents (
                run_id, action_request_event_id, dispatch_event_id, action_request_digest,
                model_request_evidence_digest, trust_scope_evidence_digest, intent_event_id,
                intent_digest, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
        params![
            issue.run_id.to_string(),
            issue.action_request_event_id.to_string(),
            issue.dispatch_event_id.to_string(),
            action_request_digest,
            &intent.model_request_evidence.digest,
            &intent.trust_scope_evidence.digest,
            event.id.to_string(),
            &intent.intent_digest,
            created_at,
        ],
    )?;
    Ok(())
}

fn activity_claim_by_idempotency(
    conn: &Connection,
    run_id: RunId,
    idempotency_key: &str,
) -> Result<Option<StoredActivityClaim>> {
    activity_claim_query(
        conn,
        "run_id = ?1 AND idempotency_key = ?2",
        params![run_id.to_string(), idempotency_key],
    )
}

fn activity_claim_by_activity_id(
    conn: &Connection,
    run_id: RunId,
    activity_id: &str,
) -> Result<Option<StoredActivityClaim>> {
    activity_claim_query(
        conn,
        "run_id = ?1 AND activity_id = ?2",
        params![run_id.to_string(), activity_id],
    )
}

fn activity_claim_by_lease(
    conn: &Connection,
    run_id: RunId,
    lease_id: &str,
) -> Result<Option<StoredActivityClaim>> {
    activity_claim_query(
        conn,
        "run_id = ?1 AND lease_id = ?2",
        params![run_id.to_string(), lease_id],
    )
}

fn activity_heartbeat_by_id(
    conn: &Connection,
    run_id: RunId,
    heartbeat_id: &str,
) -> Result<Option<StoredActivityHeartbeat>> {
    conn.query_row(
        "SELECT run_id, heartbeat_id, request_digest, claim_event_id, claim_event_digest, \
                activity_id, idempotency_key, lease_id, dispatch_event_id, dispatch_envelope_digest, \
                heartbeat_event_id, heartbeat_event_digest, prior_lease_expires_at, lease_expires_at, \
                heartbeat_at \
         FROM activity_claim_heartbeats \
         WHERE run_id = ?1 AND heartbeat_id = ?2",
        params![run_id.to_string(), heartbeat_id],
        stored_activity_heartbeat_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn activity_heartbeats_for_claim(
    conn: &Connection,
    run_id: RunId,
    claim_event_id: EventId,
) -> Result<Vec<StoredActivityHeartbeat>> {
    let mut statement = conn.prepare(
        "SELECT run_id, heartbeat_id, request_digest, claim_event_id, claim_event_digest, \
                activity_id, idempotency_key, lease_id, dispatch_event_id, dispatch_envelope_digest, \
                heartbeat_event_id, heartbeat_event_digest, prior_lease_expires_at, lease_expires_at, \
                heartbeat_at \
         FROM activity_claim_heartbeats \
         WHERE run_id = ?1 AND claim_event_id = ?2 \
         ORDER BY heartbeat_at ASC, heartbeat_event_id ASC",
    )?;
    let rows = statement.query_map(
        params![run_id.to_string(), claim_event_id.to_string()],
        stored_activity_heartbeat_from_row,
    )?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(LedgerError::from)
}

fn activity_claim_query<P: rusqlite::Params>(
    conn: &Connection,
    predicate: &str,
    params: P,
) -> Result<Option<StoredActivityClaim>> {
    let query = format!(
        "SELECT run_id, idempotency_key, activity_id, action_kind, action_request_event_id, \
                action_request_digest, dispatch_event_id, dispatch_envelope_digest, authority_actor, \
                claim_event_id, claim_event_digest, lease_id, lease_expires_at, lease_duration_ms, state, \
                result_event_id, result_event_digest, result_outcome, result_digest, result_ref, \
                evidence_digest, evidence_ref, recorded_at \
         FROM activity_claims WHERE {predicate}"
    );
    conn.query_row(&query, params, stored_activity_claim_from_row)
        .optional()
        .map_err(LedgerError::from)
}

fn stored_activity_claim_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredActivityClaim> {
    let run_id: String = row.get(0)?;
    let action_kind: String = row.get(3)?;
    let action_request_event_id: String = row.get(4)?;
    let dispatch_event_id: String = row.get(6)?;
    let claim_event_id: String = row.get(9)?;
    let result_event_id: Option<String> = row.get(15)?;
    let state: String = row.get(14)?;
    let outcome: Option<String> = row.get(17)?;
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: &str| {
        Uuid::parse_str(value)
            .map(EventId::from_uuid)
            .map_err(|error| to_sql_error(format!("invalid activity claim event id: {error}")))
    };
    let parse_run = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| to_sql_error(format!("invalid activity claim run id: {error}")))?;
    let action_kind = serde_json::from_value(serde_json::Value::String(action_kind))
        .map_err(|error| to_sql_error(format!("invalid activity claim action kind: {error}")))?;
    let state = match state.as_str() {
        "granted" => StoredActivityClaimState::Granted,
        "recorded" => StoredActivityClaimState::Recorded,
        _ => return Err(to_sql_error("invalid activity claim state".into())),
    };
    let result_outcome = outcome
        .map(|outcome| serde_json::from_value(serde_json::Value::String(outcome)))
        .transpose()
        .map_err(|error| to_sql_error(format!("invalid activity result outcome: {error}")))?;
    let lease_duration_ms: i64 = row.get(13)?;
    let lease_duration_ms = u64::try_from(lease_duration_ms)
        .map_err(|_| to_sql_error("negative activity lease duration".into()))?;
    Ok(StoredActivityClaim {
        run_id: parse_run,
        idempotency_key: row.get(1)?,
        activity_id: row.get(2)?,
        action_kind,
        action_request_event_id: parse_event(&action_request_event_id)?,
        action_request_digest: row.get(5)?,
        dispatch_event_id: parse_event(&dispatch_event_id)?,
        dispatch_envelope_digest: row.get(7)?,
        authority_actor: row.get(8)?,
        claim_event_id: parse_event(&claim_event_id)?,
        claim_event_digest: row.get(10)?,
        lease_id: row.get(11)?,
        lease_expires_at: row.get(12)?,
        lease_duration_ms,
        state,
        result_event_id: result_event_id.as_deref().map(parse_event).transpose()?,
        result_event_digest: row.get(16)?,
        result_outcome,
        result_digest: row.get(18)?,
        result_ref: row.get(19)?,
        evidence_digest: row.get(20)?,
        evidence_ref: row.get(21)?,
        recorded_at: row.get(22)?,
    })
}

fn stored_activity_heartbeat_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredActivityHeartbeat> {
    let run_id: String = row.get(0)?;
    let claim_event_id: String = row.get(3)?;
    let dispatch_event_id: String = row.get(8)?;
    let heartbeat_event_id: String = row.get(10)?;
    let to_sql_error = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let parse_event = |value: &str| {
        Uuid::parse_str(value)
            .map(EventId::from_uuid)
            .map_err(|error| to_sql_error(format!("invalid activity heartbeat event id: {error}")))
    };
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| to_sql_error(format!("invalid activity heartbeat run id: {error}")))?;
    Ok(StoredActivityHeartbeat {
        run_id,
        heartbeat_id: row.get(1)?,
        request_digest: row.get(2)?,
        claim_event_id: parse_event(&claim_event_id)?,
        claim_event_digest: row.get(4)?,
        activity_id: row.get(5)?,
        idempotency_key: row.get(6)?,
        lease_id: row.get(7)?,
        dispatch_event_id: parse_event(&dispatch_event_id)?,
        dispatch_envelope_digest: row.get(9)?,
        heartbeat_event_id: parse_event(&heartbeat_event_id)?,
        heartbeat_event_digest: row.get(11)?,
        prior_lease_expires_at: row.get(12)?,
        lease_expires_at: row.get(13)?,
        heartbeat_at: row.get(14)?,
    })
}

fn existing_claim_disposition(
    stored: &StoredActivityClaim,
    request: &ActivityClaimRequestV1,
    now: DateTime<Utc>,
    effective_lease_expires_at: DateTime<Utc>,
) -> Result<ActivityClaimDispositionV1> {
    if stored.activity_id != request.activity_id
        || stored.dispatch_event_id != request.dispatch_event_id
        || stored.action_request_event_id != request.action_request_event_id
        || stored.lease_duration_ms != request.lease_duration_ms
    {
        return Err(activity_claim_conflict(request));
    }
    match stored.state {
        StoredActivityClaimState::Recorded => Ok(ActivityClaimDispositionV1::Recorded {
            claim_event_id: stored.claim_event_id,
            result_event_id: required_claim_field(stored.result_event_id, "result_event_id")?,
            result_event_digest: required_claim_string(
                stored.result_event_digest.as_deref(),
                "result_event_digest",
            )?,
            outcome: required_claim_field(stored.result_outcome, "result_outcome")?,
        }),
        StoredActivityClaimState::Granted => {
            if now >= effective_lease_expires_at {
                Ok(ActivityClaimDispositionV1::LeaseExpired {
                    claim_event_id: stored.claim_event_id,
                    lease_expires_at: timestamp(effective_lease_expires_at),
                })
            } else {
                Ok(ActivityClaimDispositionV1::Pending {
                    claim_event_id: stored.claim_event_id,
                    lease_expires_at: timestamp(effective_lease_expires_at),
                })
            }
        }
    }
}

fn existing_result_disposition(
    stored: &StoredActivityClaim,
    request: &ActivityResultRequestV1,
) -> Result<ActivityResultDispositionV1> {
    if stored.lease_id != request.lease_id {
        return Err(LedgerError::ActivityClaimLeaseMismatch {
            run_id: request.run_id.to_string(),
            idempotency_key: request.idempotency_key.clone(),
        });
    }
    if stored.result_outcome != Some(request.outcome)
        || stored.result_digest != request.result_digest
        || stored.result_ref != request.result_ref
        || stored.evidence_digest.as_deref() != Some(request.evidence_digest.as_str())
        || stored.evidence_ref.as_deref() != Some(request.evidence_ref.as_str())
    {
        return Err(activity_claim_conflict_from_result(request));
    }
    Ok(ActivityResultDispositionV1::Recorded {
        result_event_id: required_claim_field(stored.result_event_id, "result_event_id")?,
        result_event_digest: required_claim_string(
            stored.result_event_digest.as_deref(),
            "result_event_digest",
        )?,
        outcome: request.outcome,
    })
}

fn insert_activity_claim(
    conn: &Connection,
    request: &ActivityClaimRequestV1,
    evidence: &VerifiedClaimEvidence,
    event: &Event,
    claim_event_digest: &str,
    lease_id: &str,
    lease_expires_at: &str,
    claimed_at: &str,
) -> Result<()> {
    conn.execute(
        r#"INSERT INTO activity_claims (
                run_id, idempotency_key, activity_id, action_kind,
                action_request_event_id, action_request_digest,
                dispatch_event_id, dispatch_envelope_digest, authority_actor,
                claim_event_id, claim_event_digest, lease_id, lease_expires_at,
                lease_duration_ms, state, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'granted', ?15
            )"#,
        params![
            request.run_id.to_string(),
            request.idempotency_key,
            request.activity_id,
            action_kind_wire(evidence.action_kind),
            request.action_request_event_id.to_string(),
            evidence.action_request_digest,
            request.dispatch_event_id.to_string(),
            evidence.dispatch_envelope_digest,
            match &event.payload {
                Payload::ActivityClaimedV1(claim) => &claim.authority_actor,
                _ => unreachable!("claim insert requires ActivityClaimedV1 event"),
            },
            event.id.to_string(),
            claim_event_digest,
            lease_id,
            lease_expires_at,
            request.lease_duration_ms as i64,
            claimed_at,
        ],
    )?;
    Ok(())
}

fn insert_activity_heartbeat(
    conn: &Connection,
    request: &ActivityHeartbeatRequestV1,
    request_digest: &str,
    claim: &StoredActivityClaim,
    event: &Event,
    heartbeat_event_digest: &str,
    prior_lease_expires_at: &str,
    lease_expires_at: &str,
    heartbeat_at: &str,
) -> Result<()> {
    conn.execute(
        r#"INSERT INTO activity_claim_heartbeats (
                run_id, heartbeat_id, request_digest, claim_event_id, claim_event_digest,
                activity_id, idempotency_key, lease_id, dispatch_event_id,
                dispatch_envelope_digest, heartbeat_event_id, heartbeat_event_digest,
                prior_lease_expires_at, lease_expires_at, heartbeat_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
            )"#,
        params![
            request.run_id.to_string(),
            request.heartbeat_id,
            request_digest,
            claim.claim_event_id.to_string(),
            &claim.claim_event_digest,
            request.activity_id,
            request.idempotency_key,
            request.lease_id,
            claim.dispatch_event_id.to_string(),
            &claim.dispatch_envelope_digest,
            event.id.to_string(),
            heartbeat_event_digest,
            prior_lease_expires_at,
            lease_expires_at,
            heartbeat_at,
        ],
    )?;
    Ok(())
}

fn validate_new_ordinary_event_id(conn: &Connection, event: &Event) -> Result<()> {
    if event.kind == EventKind::TapeCheckpoint {
        return Err(LedgerError::CallerSuppliedCheckpoint);
    }
    let latest: Option<String> = conn
        .query_row(
            "SELECT id FROM events WHERE run_id = ?1 AND kind != 'tape_checkpoint' ORDER BY id DESC LIMIT 1",
            params![event.run_id.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(latest) = latest {
        let latest = parse_event_id(&latest, "activity_claims")?;
        if event.id.as_uuid() <= latest.as_uuid() {
            return Err(LedgerError::NonMonotonicEventId {
                run_id: event.run_id.to_string(),
            });
        }
    }
    Ok(())
}

fn activity_claim_conflict(request: &ActivityClaimRequestV1) -> LedgerError {
    LedgerError::ActivityClaimIdempotencyConflict {
        run_id: request.run_id.to_string(),
        idempotency_key: request.idempotency_key.clone(),
    }
}

fn activity_claim_conflict_from_result(request: &ActivityResultRequestV1) -> LedgerError {
    LedgerError::ActivityClaimIdempotencyConflict {
        run_id: request.run_id.to_string(),
        idempotency_key: request.idempotency_key.clone(),
    }
}

/// Canonical digest for a caller's one heartbeat idempotency scope. It is
/// embedded in the signed heartbeat event as well as indexed by the mutable
/// projection, so cache corruption cannot remap an existing heartbeat result.
fn activity_heartbeat_request_digest(request: &ActivityHeartbeatRequestV1) -> Result<String> {
    #[derive(serde::Serialize)]
    struct CanonicalHeartbeatRequest<'a> {
        schema_version: u8,
        run_id: String,
        activity_id: &'a str,
        idempotency_key: &'a str,
        lease_id: &'a str,
        heartbeat_id: &'a str,
    }

    let encoded = serde_json::to_vec(&CanonicalHeartbeatRequest {
        schema_version: 1,
        run_id: request.run_id.to_string(),
        activity_id: &request.activity_id,
        idempotency_key: &request.idempotency_key,
        lease_id: &request.lease_id,
        heartbeat_id: &request.heartbeat_id,
    })?;
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.activity-heartbeat-request.v1\0");
    hasher.update(encoded);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn activity_heartbeat_conflict(request: &ActivityHeartbeatRequestV1) -> LedgerError {
    LedgerError::ActivityHeartbeatIdempotencyConflict {
        run_id: request.run_id.to_string(),
        heartbeat_id: request.heartbeat_id.clone(),
    }
}

fn model_action_intent_conflict(request: &ModelActionIntentIssueRequestV1) -> LedgerError {
    LedgerError::ModelActionIntentIdempotencyConflict {
        run_id: request.run_id.to_string(),
        action_request_event_id: request.action_request_event_id.to_string(),
    }
}

fn required_claim_field<T: Copy>(value: Option<T>, field: &str) -> Result<T> {
    value.ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
        reason: format!("recorded activity claim is missing {field}"),
    })
}

fn required_claim_string(value: Option<&str>, field: &str) -> Result<String> {
    value
        .map(str::to_owned)
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("recorded activity claim is missing {field}"),
        })
}

fn actor_matches(expected: &ActorKeyRef, actual: &ActorKeyRef) -> bool {
    expected.actor_id == actual.actor_id
        && expected.key_id == actual.key_id
        && expected.public_key_hash.is_some()
        && expected.public_key_hash == actual.public_key_hash
}

fn parse_claim_timestamp(value: &str) -> Result<DateTime<Utc>> {
    if !value.ends_with('Z') {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "activity timestamp is not RFC3339 UTC".into(),
        });
    }
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("invalid activity timestamp: {error}"),
        })
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn canonical_ledger_timestamp(value: DateTime<Utc>) -> Result<DateTime<Utc>> {
    parse_claim_timestamp(&timestamp(value))
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_canonical_git_commit_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn action_kind_wire(kind: ActionKindV1) -> &'static str {
    match kind {
        ActionKindV1::Filesystem => "filesystem",
        ActionKindV1::Process => "process",
        ActionKindV1::Git => "git",
        ActionKindV1::Model => "model",
        ActionKindV1::Network => "network",
        ActionKindV1::Secret => "secret",
        ActionKindV1::Mcp => "mcp",
        ActionKindV1::A2a => "a2a",
        ActionKindV1::ExternalService => "external_service",
    }
}

fn activity_result_outcome_wire(outcome: ActivityResultOutcomeV1) -> &'static str {
    match outcome {
        ActivityResultOutcomeV1::Succeeded => "succeeded",
        ActivityResultOutcomeV1::Failed => "failed",
        ActivityResultOutcomeV1::Unknown => "unknown",
    }
}

/// Stored row — textual fields as read from SQLite. Use `canonicalize` to
/// turn this into a typed `Event`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEventRow {
    pub id: String,
    pub run_id: String,
    pub parent_event_id: Option<String>,
    pub schema_version: u32,
    pub kind: String,
    pub occurred_at: String,
    pub payload: String,
}

impl StoredEventRow {
    pub fn to_event(&self) -> Result<Event> {
        let event_id = parse_event_id(&self.id, &self.kind)?;
        let run_id = parse_run_id(&self.run_id, &self.kind)?;
        let parent_event_id = self
            .parent_event_id
            .as_deref()
            .map(|id| parse_event_id(id, &self.kind))
            .transpose()?;
        let kind: EventKind = serde_json::from_value(serde_json::Value::String(self.kind.clone()))?;
        let occurred_at = DateTime::parse_from_rfc3339(&self.occurred_at)
            .map_err(|err| invalid_payload(&self.kind, format!("invalid occurred_at: {err}")))?
            .with_timezone(&Utc);
        let payload_json: serde_json::Value = serde_json::from_str(&self.payload)?;
        let payload = canonicalize_payload(&self.kind, self.schema_version, payload_json)?;
        Ok(Event {
            id: event_id,
            run_id,
            parent_event_id,
            schema_version: self.schema_version,
            kind,
            occurred_at,
            payload,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEventSignatureRow {
    pub event_id: String,
    pub canonical_event_hash: String,
    pub actor_id: String,
    pub key_id: String,
    pub public_key_hash: Option<String>,
    pub algorithm: String,
    pub signature: String,
    pub signed_at: String,
}

impl StoredEventSignatureRow {
    pub fn to_event_signature(&self) -> Result<EventSignatureV1> {
        let event_id = parse_event_id(&self.event_id, "event_signatures")?;
        let algorithm = match self.algorithm.as_str() {
            "ed25519" => SignatureAlgorithm::Ed25519,
            _ => {
                return Err(invalid_payload(
                    "event_signatures",
                    format!(
                        "unsupported signature algorithm '{}'; check status first",
                        self.algorithm
                    ),
                ));
            }
        };
        let signed_at = DateTime::parse_from_rfc3339(&self.signed_at)
            .map_err(|err| {
                invalid_payload("event_signatures", format!("invalid signed_at: {err}"))
            })?
            .with_timezone(&Utc);
        Ok(EventSignatureV1 {
            event_id,
            canonical_event_hash: self.canonical_event_hash.clone(),
            signer: ActorKeyRef {
                actor_id: self.actor_id.clone(),
                key_id: self.key_id.clone(),
                public_key_hash: self.public_key_hash.clone(),
            },
            algorithm,
            signature: self.signature.clone(),
            signed_at,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedEventRow {
    pub event: StoredEventRow,
    pub signature: Option<EventSignatureV1>,
    pub verification: VerificationStatus,
}

/// Minimal projection of the latest checkpoint needed to chain the next one.
///
/// `through_event_id` is retained (alongside `through_event_count`) so the
/// checkpoint chain stays auditable: each checkpoint records the exact last
/// covered event id, not merely how many events it covered.
#[derive(Debug, Clone)]
struct StoredCheckpoint {
    event_id: EventId,
    checkpoint_index: u64,
    /// Last covered event id of the prior checkpoint. Retained for chain
    /// auditability; not yet consumed by emission logic (cadence uses
    /// `through_event_count`).
    #[allow(dead_code)]
    through_event_id: EventId,
    through_event_count: u64,
    tape_root_hash: String,
    algorithm: TapeRootAlgorithm,
}

/// A signed, non-checkpoint event in tape order, with its stored canonical
/// hash — the input to the tape-root computation.
#[derive(Debug, Clone)]
struct SignedOrdinaryEvent {
    event_id: EventId,
    canonical_event_hash: String,
}

/// Compute the exact `tape_root_hash` for every non-empty signed prefix in
/// one forward pass. `tape_root_hash` is SHA-256 over canonical-hash strings
/// joined with one newline and no trailing separator, so cloning the rolling
/// hasher at each prefix preserves the wire result without rehashing prior
/// entries for every checkpoint.
fn tape_prefix_roots(covered: &[SignedOrdinaryEvent]) -> Vec<String> {
    let mut hasher = Sha256::new();
    let mut roots = Vec::with_capacity(covered.len());
    for (index, event) in covered.iter().enumerate() {
        if index > 0 {
            hasher.update(b"\n");
        }
        hasher.update(event.canonical_event_hash.as_bytes());
        roots.push(format!("sha256:{:x}", hasher.clone().finalize()));
    }
    roots
}

fn signature_algorithm_wire(algorithm: SignatureAlgorithm) -> &'static str {
    match algorithm {
        SignatureAlgorithm::Ed25519 => "ed25519",
    }
}

fn insert_event(conn: &Connection, event: &Event) -> Result<()> {
    let payload_json = serde_json::to_string(&event.payload)?;
    conn.execute(
        r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        params![
            event.id.to_string(),
            event.run_id.to_string(),
            event.parent_event_id.map(|e| e.to_string()),
            event.schema_version,
            event.kind_str(),
            event.occurred_at.to_rfc3339(),
            payload_json,
        ],
    )?;
    Ok(())
}

fn insert_event_signature(conn: &Connection, signature: &EventSignatureV1) -> Result<()> {
    conn.execute(
        r#"INSERT INTO event_signatures (
            event_id,
            canonical_event_hash,
            actor_id,
            key_id,
            public_key_hash,
            algorithm,
            signature,
            signed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
        params![
            signature.event_id.to_string(),
            signature.canonical_event_hash,
            signature.signer.actor_id,
            signature.signer.key_id,
            signature.signer.public_key_hash,
            signature_algorithm_wire(signature.algorithm),
            signature.signature,
            signature.signed_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
struct StoredGovernedCandidateCompletion {
    run_id: String,
    dispatch_event_id: String,
    candidate_created_event_id: String,
    candidate_digest: String,
    candidate_create_action_id: String,
    action_request_event_id: String,
    action_request_digest: String,
    activity_claim_event_id: String,
    activity_claim_event_digest: String,
    activity_result_event_id: String,
    activity_result_event_digest: String,
    action_receipt_ref: String,
    action_receipt_digest: String,
    candidate_completion_event_id: String,
    candidate_completion_event_digest: String,
    completion_digest: String,
    completed_at: String,
}

#[derive(Clone, Debug)]
struct VerifiedGovernedCandidateCompletionEvidence {
    completion: CandidateCompletionRecordedV1,
}

fn validate_governed_candidate_completion_request(
    _request: &GovernedCandidateCompletionRequestV1,
) -> Result<()> {
    // Every identifier is a strongly typed UUID. The remaining shape and
    // lineage checks happen against the signed records inside the immediate
    // transaction, rather than accepting a caller-selected completion body.
    Ok(())
}

fn candidate_completion_authority_rejected<T>(reason: impl Into<String>) -> Result<T> {
    Err(LedgerError::CandidateCompletionAuthorityRejected {
        reason: reason.into(),
    })
}

fn candidate_completion_reconciliation_required(
    request: &GovernedCandidateCompletionRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::CandidateCompletionReconciliationRequired {
        run_id: request.run_id.to_string(),
        candidate_created_event_id: request.candidate_created_event_id.to_string(),
        reason: reason.into(),
    }
}

fn validate_static_governed_candidate_completion_dispatch(
    dispatch: &DispatchEnvelopeV3,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<()> {
    if dispatch.body.trust_tier != TrustTierV1::Governed
        || !matches!(
            dispatch.body.execution_role,
            ExecutionRoleV1::Implementer | ExecutionRoleV1::Candidate
        )
        || dispatch.body.commit_mode != CommitModeV1::Atomic
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        || dispatch.ledger_authority_realm_digest != authority.ledger_authority_realm_digest
        || dispatch
            .governed_packet_digest
            .as_deref()
            .is_none_or(|digest| digest.trim().is_empty())
    {
        return candidate_completion_authority_rejected(
            "candidate completion requires a sealed-V3 governed atomic implementer or candidate dispatch in this protected realm",
        );
    }
    // Retry dispatches carry an additional closed AttemptContext plus a
    // namespace rule for every action identity. The native candidate lane has
    // not yet received those replay inputs, so treating a signed retry packet
    // as first-attempt evidence would let it certify a tape that trusted
    // replay rejects. Preserve safety and make the capability boundary
    // explicit until the complete retry reducer is shared here.
    if dispatch.body.attempt != 1 {
        return candidate_completion_authority_rejected(
            "candidate completion currently supports only attempt 1; governed retries require native AttemptContext and action-namespace verification",
        );
    }
    Ok(())
}

fn candidate_create_action_id_for(candidate: &CandidateCreatedV2) -> Result<String> {
    if candidate.candidate_id.trim().is_empty()
        || !is_canonical_buildplane_candidate_ref(&candidate.candidate_ref)
    {
        return candidate_completion_authority_rejected(
            "candidate completion requires a non-empty candidate id and canonical Buildplane candidate ref",
        );
    }
    let suffix = candidate
        .candidate_ref
        .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
        .ok_or_else(|| LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion candidate ref is outside the Buildplane candidate namespace"
                    .into(),
        })?;
    Ok(format!("git-candidate-create:{suffix}"))
}

/// Tape order is the canonical UUIDv7 event-id order used by the ledger's
/// event queries. A candidate-completion proof may only close evidence that
/// was already durably present in that order; payload timestamps alone are
/// not an ordering authority.
fn tape_event_precedes(before: &Event, after: &Event) -> bool {
    before.id.as_uuid() < after.id.as_uuid()
}

/// Reconstruct the effective lease for a terminal action from its signed
/// claim and every signed heartbeat that extends that exact claim. The
/// candidate-completion lane cannot use the mutable heartbeat projection: a
/// damaged or stale cache must not shorten or lengthen authority when it is
/// deciding whether an already-recorded result is certifiable.
#[allow(clippy::too_many_arguments)]
fn effective_governed_candidate_activity_lease_expiry(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
    dispatch_event: &Event,
    dispatch_envelope_digest: &str,
    effective_deadline: DateTime<Utc>,
    action_event: &Event,
    action: &ActionRequestedV2,
    claim_event: &Event,
    claim: &ActivityClaimedV1,
    result_event: &Event,
) -> Result<DateTime<Utc>> {
    let claimed_at = parse_claim_timestamp(&claim.claimed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion activity claim timestamp is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    let mut current_lease_expires_at =
        parse_claim_timestamp(&claim.lease_expires_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion activity claim lease expiry is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
    let claim_event_digest = canonical_event_hash(claim_event).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "could not canonicalize candidate action claim while reconstructing lease heartbeats: {error}"
            ),
        }
    })?;
    let mut prior_heartbeat_at = None;
    for heartbeat_event in verified_kernel_events_for_run_kind(
        conn,
        request.run_id,
        EventKind::ActivityHeartbeatRecordedV1,
        authority,
        "candidate action lease heartbeat",
    )? {
        if heartbeat_event.parent_event_id != Some(claim_event.id) {
            continue;
        }
        let Payload::ActivityHeartbeatRecordedV1(heartbeat) = &heartbeat_event.payload else {
            unreachable!(
                "activity-heartbeat kind only returns ActivityHeartbeatRecordedV1 payloads"
            )
        };
        let heartbeat_at = parse_claim_timestamp(&heartbeat.heartbeat_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: "candidate completion heartbeat timestamp is not canonical RFC3339 UTC"
                    .into(),
            }
        })?;
        let next_lease_expires_at =
            parse_claim_timestamp(&heartbeat.lease_expires_at).map_err(|_| {
                LedgerError::CandidateCompletionAuthorityRejected {
                    reason:
                        "candidate completion heartbeat lease expiry is not canonical RFC3339 UTC"
                            .into(),
                }
            })?;
        let heartbeat_identity_is_closed = match (
            heartbeat.heartbeat_id.as_deref(),
            heartbeat.heartbeat_request_digest.as_deref(),
        ) {
            (Some(heartbeat_id), Some(request_digest)) => {
                !heartbeat_id.trim().is_empty() && is_canonical_sha256_digest(request_digest)
            }
            // Historical records predate heartbeat-request identity. Replay
            // remains able to read them, so retain that narrow compatibility
            // shape while rejecting partial or malformed identities below.
            (None, None) => true,
            _ => false,
        };
        if !heartbeat_identity_is_closed
            || heartbeat.run_id != request.run_id
            || heartbeat.activity_id != action.action_id
            || heartbeat.idempotency_key != action.idempotency_key
            || heartbeat.claim_event_id != claim_event.id
            || heartbeat.claim_event_digest != claim_event_digest
            || heartbeat.lease_id != claim.lease_id
            || heartbeat.dispatch_event_id != dispatch_event.id
            || heartbeat.dispatch_envelope_digest != dispatch_envelope_digest
            || heartbeat_event.parent_event_id != Some(claim_event.id)
            || !tape_event_precedes(action_event, claim_event)
            || !tape_event_precedes(claim_event, &heartbeat_event)
            || !tape_event_precedes(&heartbeat_event, result_event)
            || heartbeat_at != heartbeat_event.occurred_at
            || heartbeat_at < claimed_at
            || heartbeat_at >= current_lease_expires_at
            || next_lease_expires_at <= current_lease_expires_at
            || next_lease_expires_at > effective_deadline
            || prior_heartbeat_at.is_some_and(|previous| previous >= heartbeat_at)
        {
            return candidate_completion_authority_rejected(
                "candidate completion heartbeat does not form one forward, signed lease extension inside its governed dispatch deadline",
            );
        }
        current_lease_expires_at = next_lease_expires_at;
        prior_heartbeat_at = Some(heartbeat_at);
    }
    Ok(current_lease_expires_at)
}

/// A candidate-completion proof is only valid while its workflow remains in
/// the reducer's `CandidateCreated` phase. We do not trust a mutable phase
/// projection for that decision: scan the append-only tape for authoritative
/// lifecycle records that would have made candidate creation or completion
/// replay-invalid before this immutable candidate record.
fn ensure_governed_candidate_completion_lifecycle_is_open(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    candidate_event: &Event,
    candidate: &CandidateCreatedV2,
    receipt_set_event: &Event,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
         FROM events WHERE run_id = ?1 ORDER BY id ASC",
    )?;
    let rows = statement.query_map(params![request.run_id.to_string()], |row| {
        Ok(StoredEventRow {
            id: row.get(0)?,
            run_id: row.get(1)?,
            parent_event_id: row.get(2)?,
            schema_version: row.get(3)?,
            kind: row.get(4)?,
            occurred_at: row.get(5)?,
            payload: row.get(6)?,
        })
    })?;
    for row in rows {
        let event = row?.to_event()?;
        // Candidate completion may be appended only while the reducer is
        // still in `CandidateCreated`. Therefore lifecycle evidence recorded
        // either before *or after* the candidate (but before this atomic
        // operation) can block it. The candidate record itself is the one
        // expected transition and is excluded by identity, not by a loose
        // timestamp/order predicate.
        if event.id == candidate_event.id {
            continue;
        }
        let conflict = match &event.payload {
            Payload::WorkflowCancellationRequestedV1(cancellation)
                if cancellation.run_id == request.run_id.to_string()
                    && cancellation.workflow_id == dispatch.body.workflow_id
                    && cancellation.workflow_revision == dispatch.body.workflow_revision
                    && cancellation.unit_id == dispatch.body.unit_id
                    && cancellation.attempt == dispatch.body.attempt
                    && cancellation.dispatch_event_ref == dispatch_event.id
                    && cancellation.dispatch_envelope_digest == dispatch.envelope_digest =>
            {
                Some("a workflow cancellation was already requested")
            }
            Payload::WorkflowTerminalV1(terminal)
                if terminal.workflow_id == dispatch.body.workflow_id
                    && terminal.workflow_revision == dispatch.body.workflow_revision
                    && terminal.unit_id == dispatch.body.unit_id
                    && terminal.attempt == dispatch.body.attempt =>
            {
                Some("the workflow already has a terminal record")
            }
            Payload::WorkflowTerminalV2(terminal)
                if terminal.workflow_id == dispatch.body.workflow_id
                    && terminal.workflow_revision == dispatch.body.workflow_revision
                    && terminal.unit_id == dispatch.body.unit_id
                    && terminal.attempt == dispatch.body.attempt =>
            {
                Some("the workflow already has a terminal record")
            }
            Payload::CandidateCreatedV1(prior_candidate)
                if prior_candidate.workflow_id == dispatch.body.workflow_id
                    && prior_candidate.unit_id == dispatch.body.unit_id
                    && prior_candidate.attempt == dispatch.body.attempt
                    && prior_candidate.provenance_ref == dispatch.body.provenance_ref =>
            {
                Some("a prior candidate artifact already exists for this workflow attempt")
            }
            Payload::CandidateCreatedV2(prior_candidate)
                if prior_candidate.workflow_id == dispatch.body.workflow_id
                    && prior_candidate.unit_id == dispatch.body.unit_id
                    && prior_candidate.attempt == dispatch.body.attempt
                    && prior_candidate.provenance_ref == dispatch.body.provenance_ref =>
            {
                Some("a prior candidate artifact already exists for this workflow attempt")
            }
            Payload::ActionReceiptSetRecordedV1(prior_set)
                if event.id != receipt_set_event.id
                    && prior_set.run_id == request.run_id.to_string()
                    && prior_set.workflow_id == dispatch.body.workflow_id
                    && prior_set.unit_id == dispatch.body.unit_id
                    && prior_set.attempt == dispatch.body.attempt
                    && prior_set.provenance_ref == dispatch.body.provenance_ref
                    && prior_set.dispatch_envelope_digest == dispatch.envelope_digest =>
            {
                Some("a different receipt set was already sealed for this workflow attempt")
            }
            Payload::CandidateAcceptanceRecordedV1(acceptance)
                if acceptance.candidate_digest == candidate.candidate_digest =>
            {
                Some("candidate acceptance exists before the candidate lifecycle is complete")
            }
            Payload::ReviewVerdictRecordedV1(review)
                if review.candidate_digest == candidate.candidate_digest =>
            {
                Some("candidate review exists before the candidate lifecycle is complete")
            }
            Payload::ReviewVerdictRecordedV2(review)
                if review.candidate_digest == candidate.candidate_digest =>
            {
                Some("candidate review exists before the candidate lifecycle is complete")
            }
            Payload::PromotionApprovalRequestedV1(approval)
                if approval.candidate_digest == candidate.candidate_digest =>
            {
                Some("promotion approval exists before the candidate lifecycle is complete")
            }
            Payload::PromotionDecisionRecordedV1(decision)
                if decision.candidate_digest == candidate.candidate_digest =>
            {
                Some("promotion decision exists before the candidate lifecycle is complete")
            }
            Payload::PromotionExecutionClaimedV1(claim)
                if claim.candidate_digest == candidate.candidate_digest =>
            {
                Some("promotion execution exists before the candidate lifecycle is complete")
            }
            Payload::PromotionResultRecordedV1(result)
                if result.candidate_digest == candidate.candidate_digest =>
            {
                Some("promotion result exists before the candidate lifecycle is complete")
            }
            _ => None,
        };
        if let Some(conflict) = conflict {
            return candidate_completion_authority_rejected(format!(
                "candidate completion cannot certify replay-invalid lifecycle evidence: {conflict} (event {})",
                event.id
            ));
        }
    }
    Ok(())
}

fn verified_kernel_events_for_run_kind(
    conn: &Connection,
    run_id: RunId,
    kind: EventKind,
    authority: &GovernedPromotionAuthorityV1,
    label: &str,
) -> Result<Vec<Event>> {
    let mut statement =
        conn.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
    let ids = statement
        .query_map(params![run_id.to_string(), kind.as_wire()], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            let event_id = parse_event_id(&id, label)?;
            load_verified_promotion_event(
                conn,
                event_id,
                &authority.trusted_keys,
                &authority.kernel_signer,
                label,
            )
        })
        .collect()
}

fn unique_verified_kernel_event_matching<F>(
    conn: &Connection,
    run_id: RunId,
    kind: EventKind,
    authority: &GovernedPromotionAuthorityV1,
    label: &str,
    mut matches: F,
) -> Result<Event>
where
    F: FnMut(&Event) -> bool,
{
    let mut matched = None;
    for event in verified_kernel_events_for_run_kind(conn, run_id, kind, authority, label)? {
        if !matches(&event) {
            continue;
        }
        if matched.replace(event).is_some() {
            return candidate_completion_authority_rejected(format!(
                "candidate completion found more than one matching {label} event"
            ));
        }
    }
    matched.ok_or_else(|| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!("candidate completion requires exactly one matching {label} event"),
    })
}

/// Reconstruct the complete sealed V3 action set that produced a candidate.
/// Candidate completion deliberately fails closed rather than treating the
/// receipt-set payload as an advisory list: every request in the dispatch
/// attempt must reach one successful claimed/result/receipt chain, and the
/// signed set must name those exact receipts in canonical action-id order.
///
/// Model actions are rejected here until this narrow native operation receives
/// the protected CAS/model-authority inputs needed to replay their intent,
/// authorization, and aggregate token-budget contract. A successful model
/// receipt by itself is not authority to certify an implementation candidate.
#[allow(clippy::too_many_arguments)]
fn verify_governed_candidate_receipt_set_completeness(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    dispatch_envelope_digest: &str,
    receipt_set_event: &Event,
    receipt_set: &ActionReceiptSetRecordedV1,
    candidate_create_action_id: &str,
) -> Result<()> {
    let expected_policy_digest = governed_dispatch_policy_digest_v1(
        &dispatch.body.acceptance_contract_digest,
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!(
            "could not derive governed action-set policy binding for candidate completion: {error}"
        ),
    })?;
    let dispatch_issued_at = parse_claim_timestamp(&dispatch.body.issued_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion dispatch issued_at is not canonical RFC3339 UTC".into(),
        }
    })?;
    let effective_deadline = validate_governed_dispatch(dispatch, dispatch_issued_at)
        .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not derive the sealed action-set deadline: {error}"
            ),
        })?
        .effective_deadline;
    let receipt_set_sealed_at = parse_claim_timestamp(&receipt_set.sealed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion receipt set sealed_at is not canonical RFC3339 UTC"
                .into(),
        }
    })?;

    let mut actions = BTreeMap::<String, (Event, ActionRequestedV2, String)>::new();
    let mut idempotency_keys = HashSet::new();
    for event in verified_kernel_events_for_run_kind(
        conn,
        request.run_id,
        EventKind::ActionRequestedV2,
        authority,
        "sealed candidate action request",
    )? {
        let Payload::ActionRequestedV2(action) = &event.payload else {
            unreachable!("action-request kind only returns ActionRequestedV2 payloads")
        };
        let action = action.clone();
        // Replay keys V3 action requests by the workflow attempt and signed
        // lineage fields, not by parent alone. A same-attempt request with a
        // substituted parent therefore poisons the replayed workflow even if
        // it is absent from the candidate's receipt-set payload. Detect that
        // before the ordinary parent filter instead of silently skipping it.
        let same_workflow_attempt = action.run_id == request.run_id.to_string()
            && action.workflow_id == dispatch.body.workflow_id
            && action.unit_id == dispatch.body.unit_id
            && action.attempt == dispatch.body.attempt;
        if !same_workflow_attempt {
            continue;
        }
        if event.parent_event_id != Some(dispatch_event.id) {
            return candidate_completion_authority_rejected(
                "candidate completion found a same-attempt action request that is not parented to its governed dispatch",
            );
        }
        let requested_at = parse_claim_timestamp(&action.requested_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion action request timestamp is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        let action_digest = action_requested_v2_digest(&action).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "could not canonicalize candidate action request while sealing receipt set: {error}"
                ),
            }
        })?;
        if action.run_id != request.run_id.to_string()
            || action.workflow_id != dispatch.body.workflow_id
            || action.unit_id != dispatch.body.unit_id
            || action.attempt != dispatch.body.attempt
            || action.provenance_ref != dispatch.body.provenance_ref
            || action.action_id.trim().is_empty()
            || action.idempotency_key.trim().is_empty()
            || action.dispatch_envelope_digest != dispatch_envelope_digest
            || action.repository_binding_digest != dispatch.repository_binding_digest
            || action.ledger_authority_realm_digest != dispatch.ledger_authority_realm_digest
            || action.governed_packet_digest != dispatch.governed_packet_digest
            || action.capability_bundle_digest != dispatch.body.capability_bundle_digest
            || action.policy_digest != expected_policy_digest
            || action.context_manifest_digest != dispatch.body.context_manifest_digest
            || action.worker_manifest_digest != dispatch.body.worker_manifest_digest
            || action.sandbox_profile_digest != dispatch.body.sandbox_profile_digest
            || action.authority_actor != authority.kernel_signer.actor_id
            || action.execution_role != dispatch.body.execution_role
            || requested_at != event.occurred_at
            || requested_at < dispatch_issued_at
            || !tape_event_precedes(dispatch_event, &event)
            || !tape_event_precedes(&event, receipt_set_event)
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set contains an action request outside its exact sealed dispatch lineage",
            );
        }
        if !idempotency_keys.insert(action.idempotency_key.clone())
            || actions
                .insert(action.action_id.clone(), (event, action, action_digest))
                .is_some()
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set has duplicate action identity or idempotency evidence",
            );
        }
    }
    if actions.is_empty() || !actions.contains_key(candidate_create_action_id) {
        return candidate_completion_authority_rejected(
            "candidate completion receipt set does not derive the candidate-create action from the signed dispatch",
        );
    }

    let mut expected_entries = BTreeMap::<String, &ActionReceiptSetEntryV1>::new();
    let mut previous_action_id: Option<&str> = None;
    for entry in &receipt_set.receipts {
        if entry.action_id.trim().is_empty()
            || entry.action_receipt_ref.trim().is_empty()
            || !is_canonical_sha256_digest(&entry.action_receipt_digest)
            || previous_action_id.is_some_and(|previous| previous >= entry.action_id.as_str())
            || expected_entries
                .insert(entry.action_id.clone(), entry)
                .is_some()
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set entries are not a strict canonical action-id map",
            );
        }
        previous_action_id = Some(entry.action_id.as_str());
    }
    if expected_entries.len() != actions.len()
        || !actions
            .keys()
            .zip(receipt_set.receipts.iter())
            .all(|(action_id, entry)| action_id == &entry.action_id)
    {
        return candidate_completion_authority_rejected(
            "candidate completion receipt set does not name every signed dispatch action exactly once",
        );
    }

    let claims = verified_kernel_events_for_run_kind(
        conn,
        request.run_id,
        EventKind::ActivityClaimedV1,
        authority,
        "sealed candidate activity claim",
    )?;
    let results = verified_kernel_events_for_run_kind(
        conn,
        request.run_id,
        EventKind::ActivityResultRecordedV1,
        authority,
        "sealed candidate activity result",
    )?;
    let receipts = verified_kernel_events_for_run_kind(
        conn,
        request.run_id,
        EventKind::ActionReceiptRecordedV2,
        authority,
        "sealed candidate action receipt",
    )?;

    let mut claims_by_request = HashMap::<EventId, Vec<Event>>::new();
    for event in claims {
        if let Some(parent) = event.parent_event_id {
            claims_by_request.entry(parent).or_default().push(event);
        }
    }
    let mut results_by_claim = HashMap::<EventId, Vec<Event>>::new();
    for event in results {
        if let Some(parent) = event.parent_event_id {
            results_by_claim.entry(parent).or_default().push(event);
        }
    }
    let mut receipts_by_ref = HashMap::<String, Vec<Event>>::new();
    for event in &receipts {
        let Payload::ActionReceiptRecordedV2(receipt) = &event.payload else {
            unreachable!("action-receipt kind only returns ActionReceiptRecordedV2 payloads")
        };
        receipts_by_ref
            .entry(receipt.action_receipt_ref.clone())
            .or_default()
            .push(event.clone());
    }

    for (action_id, (action_event, action, action_digest)) in &actions {
        if action.action_kind == ActionKindV1::Model {
            return candidate_completion_authority_rejected(
                "candidate completion cannot certify a sealed receipt set containing a model action without protected model-authority and CAS replay inputs",
            );
        }
        let entry = expected_entries.get(action_id).copied().ok_or_else(|| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: "candidate completion receipt set omitted a signed dispatch action".into(),
            }
        })?;
        let claim_events = claims_by_request
            .get(&action_event.id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let [claim_event] = claim_events else {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action does not have exactly one terminal activity claim",
            );
        };
        let Payload::ActivityClaimedV1(claim) = &claim_event.payload else {
            unreachable!("activity-claim kind only returns ActivityClaimedV1 payloads")
        };
        let claim_digest = canonical_event_hash(claim_event).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "could not canonicalize candidate action claim while sealing receipt set: {error}"
                ),
            }
        })?;
        let claimed_at = parse_claim_timestamp(&claim.claimed_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion activity claim timestamp is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion activity claim lease expiry is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        let requested_at = parse_claim_timestamp(&action.requested_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion action request timestamp is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        if claim.run_id != request.run_id
            || claim.activity_id != *action_id
            || claim.idempotency_key != action.idempotency_key
            || claim.action_kind != action.action_kind
            || claim.action_request_event_id != action_event.id
            || claim.action_request_digest != *action_digest
            || claim.dispatch_event_id != dispatch_event.id
            || claim.dispatch_envelope_digest != dispatch_envelope_digest
            || claim.authority_actor != authority.kernel_signer.actor_id
            || claim.purpose != ActivityClaimPurposeV1::Generic
            || claimed_at != claim_event.occurred_at
            || claimed_at < requested_at
            || lease_expires_at <= claimed_at
            || lease_expires_at > effective_deadline
            || !tape_event_precedes(action_event, claim_event)
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action claim does not bind the signed governed request",
            );
        }

        let result_events = results_by_claim
            .get(&claim_event.id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let [result_event] = result_events else {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action does not have exactly one terminal activity result",
            );
        };
        let Payload::ActivityResultRecordedV1(result) = &result_event.payload else {
            unreachable!("activity-result kind only returns ActivityResultRecordedV1 payloads")
        };
        let result_recorded_at = parse_claim_timestamp(&result.recorded_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion activity result timestamp is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        let effective_lease_expires_at = effective_governed_candidate_activity_lease_expiry(
            conn,
            request,
            authority,
            dispatch_event,
            dispatch_envelope_digest,
            effective_deadline,
            action_event,
            action,
            claim_event,
            claim,
            result_event,
        )?;
        if result.run_id != request.run_id
            || result.activity_id != *action_id
            || result.idempotency_key != action.idempotency_key
            || result.claim_event_id != claim_event.id
            || result.claim_event_digest != claim_digest
            || result.lease_id != claim.lease_id
            || result.outcome != ActivityResultOutcomeV1::Succeeded
            || result_recorded_at != result_event.occurred_at
            || result_recorded_at < claimed_at
            || result_recorded_at >= effective_lease_expires_at
            || !tape_event_precedes(claim_event, result_event)
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action result is not one successful terminal claim result",
            );
        }

        let receipt_events = receipts_by_ref
            .get(&entry.action_receipt_ref)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let [receipt_event] = receipt_events else {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action does not have exactly one recorded receipt",
            );
        };
        let Payload::ActionReceiptRecordedV2(receipt) = &receipt_event.payload else {
            unreachable!("action-receipt kind only returns ActionReceiptRecordedV2 payloads")
        };
        let receipt_digest = action_receipt_recorded_v2_digest(receipt).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "could not canonicalize candidate action receipt while sealing receipt set: {error}"
                ),
            }
        })?;
        let receipt_completed_at = parse_claim_timestamp(&receipt.completed_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason:
                    "candidate completion action receipt timestamp is not canonical RFC3339 UTC"
                        .into(),
            }
        })?;
        if receipt_digest != entry.action_receipt_digest
            || receipt.run_id != request.run_id.to_string()
            || receipt.workflow_id != dispatch.body.workflow_id
            || receipt.unit_id != dispatch.body.unit_id
            || receipt.attempt != dispatch.body.attempt
            || receipt.provenance_ref != dispatch.body.provenance_ref
            || receipt.action_id != *action_id
            || receipt.idempotency_key != action.idempotency_key
            || receipt.action_request_digest != *action_digest
            || receipt.dispatch_envelope_digest != dispatch_envelope_digest
            || receipt.capability_bundle_digest != dispatch.body.capability_bundle_digest
            || receipt.policy_digest != expected_policy_digest
            || receipt.context_manifest_digest != dispatch.body.context_manifest_digest
            || receipt.worker_manifest_digest != dispatch.body.worker_manifest_digest
            || receipt.sandbox_profile_digest != dispatch.body.sandbox_profile_digest
            || receipt.authority_actor != authority.kernel_signer.actor_id
            || receipt.execution_role != dispatch.body.execution_role
            || receipt.outcome != ActionReceiptOutcomeV2::Succeeded
            || receipt.result_digest != result.result_digest
            || receipt.result_ref != result.result_ref
            || receipt.evidence_digest != result.evidence_digest
            || receipt.evidence_ref != result.evidence_ref
            || receipt_event.parent_event_id != Some(result_event.id)
            || receipt_completed_at < claimed_at
            || receipt_completed_at > result_recorded_at
            || receipt_set_sealed_at < receipt_completed_at
            || !tape_event_precedes(result_event, receipt_event)
            || !tape_event_precedes(receipt_event, receipt_set_event)
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set receipt does not bind one succeeded terminal action",
            );
        }
    }

    // Do not let a second receipt for an already-derived action hide outside
    // the sealed set. Replay would reject that competing terminal record; the
    // native proof must fail before it can checkpoint the same ambiguity.
    for receipt_event in receipts {
        let Payload::ActionReceiptRecordedV2(receipt) = &receipt_event.payload else {
            unreachable!("action-receipt kind only returns ActionReceiptRecordedV2 payloads")
        };
        if receipt.run_id != request.run_id.to_string()
            || receipt.workflow_id != dispatch.body.workflow_id
            || receipt.unit_id != dispatch.body.unit_id
            || receipt.attempt != dispatch.body.attempt
            || receipt.provenance_ref != dispatch.body.provenance_ref
            || receipt.dispatch_envelope_digest != dispatch_envelope_digest
        {
            continue;
        }
        let Some(entry) = expected_entries.get(&receipt.action_id) else {
            return candidate_completion_authority_rejected(
                "candidate completion found a terminal receipt for an action absent from its sealed set",
            );
        };
        let receipt_digest = action_receipt_recorded_v2_digest(receipt).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "could not canonicalize competing candidate action receipt: {error}"
                ),
            }
        })?;
        if receipt.action_receipt_ref != entry.action_receipt_ref
            || receipt_digest != entry.action_receipt_digest
        {
            return candidate_completion_authority_rejected(
                "candidate completion found a competing terminal receipt outside its sealed set",
            );
        }
    }
    Ok(())
}

fn verify_governed_candidate_completion_evidence(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<VerifiedGovernedCandidateCompletionEvidence> {
    let dispatch_event = load_verified_promotion_event(
        conn,
        request.dispatch_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "governed candidate-completion dispatch",
    )?;
    if dispatch_event.run_id != request.run_id {
        return candidate_completion_authority_rejected(
            "candidate completion dispatch belongs to a different run",
        );
    }
    let dispatch_material = dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion requires a signed sealed-V3 or graph-bound V4 dispatch envelope".into(),
        }
    })?;
    if dispatch_material.is_graph_bound_v4 {
        // V4 validity depends on tape-global graph declaration, node
        // scheduling, and retry-context admission. Candidate completion has
        // not yet reconstructed that reducer state from the signed tape, so
        // accepting only the nested V3 authority here could seal a candidate
        // that trusted replay rejects. Until the native verifier ports those
        // V4 admission checks, graph-bound dispatches must fail closed.
        return candidate_completion_authority_rejected(
            "candidate completion does not yet reconstruct graph-bound V4 admission; V4 dispatches are unsupported",
        );
    }
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    validate_static_governed_candidate_completion_dispatch(&dispatch, authority)?;
    let expected_policy_digest = governed_dispatch_policy_digest_v1(
        &dispatch.body.acceptance_contract_digest,
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!("could not derive governed candidate-create policy binding: {error}"),
    })?;

    let candidate_event = load_verified_promotion_event(
        conn,
        request.candidate_created_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate artifact",
    )?;
    if candidate_event.run_id != request.run_id {
        return candidate_completion_authority_rejected(
            "candidate completion candidate artifact belongs to a different run",
        );
    }
    let Payload::CandidateCreatedV2(candidate) = &candidate_event.payload else {
        return candidate_completion_authority_rejected(
            "candidate completion requires an immutable candidate_created_v2 record",
        );
    };
    let candidate = candidate.clone();
    if candidate.run_id != request.run_id.to_string()
        || candidate.workflow_id != dispatch.body.workflow_id
        || candidate.unit_id != dispatch.body.unit_id
        || candidate.attempt != dispatch.body.attempt
        || candidate.provenance_ref != dispatch.body.provenance_ref
        || candidate.base_commit_sha != dispatch.body.base_commit_sha
        || candidate.envelope_digest != dispatch_envelope_digest
    {
        return candidate_completion_authority_rejected(
            "candidate completion candidate artifact does not exactly bind the governed dispatch lineage",
        );
    }
    let candidate_create_action_id = candidate_create_action_id_for(&candidate)?;

    let receipt_set_event = unique_verified_kernel_event_matching(
        conn,
        request.run_id,
        EventKind::ActionReceiptSetRecordedV1,
        authority,
        "candidate receipt set",
        |event| {
            matches!(
                &event.payload,
                Payload::ActionReceiptSetRecordedV1(receipt_set)
                    if receipt_set.run_id == request.run_id.to_string()
                        && receipt_set.workflow_id == candidate.workflow_id
                        && receipt_set.unit_id == candidate.unit_id
                        && receipt_set.attempt == candidate.attempt
                        && receipt_set.provenance_ref == candidate.provenance_ref
                        && receipt_set.dispatch_envelope_digest == dispatch_envelope_digest
                        && receipt_set.action_receipt_set_ref == candidate.action_receipt_set_ref
                        && receipt_set.action_receipt_set_digest == candidate.action_receipt_set_digest
            )
        },
    )?;
    let Payload::ActionReceiptSetRecordedV1(receipt_set) = &receipt_set_event.payload else {
        unreachable!("receipt-set event matcher returns only the expected payload")
    };
    if action_receipt_set_v1_digest(receipt_set).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("could not canonicalize candidate receipt set: {error}"),
        }
    })? != receipt_set.action_receipt_set_digest
    {
        return candidate_completion_authority_rejected(
            "candidate completion receipt set digest does not bind its canonical contents",
        );
    }
    let receipt_set_sealed_at = parse_claim_timestamp(&receipt_set.sealed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion receipt set sealed_at is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    if candidate_event.parent_event_id != Some(receipt_set_event.id)
        || !tape_event_precedes(&receipt_set_event, &candidate_event)
        || receipt_set_sealed_at > candidate_event.occurred_at
    {
        return candidate_completion_authority_rejected(
            "candidate completion candidate artifact must directly follow its sealed receipt set in tape order",
        );
    }
    ensure_governed_candidate_completion_lifecycle_is_open(
        conn,
        request,
        &dispatch_event,
        &dispatch,
        &candidate_event,
        &candidate,
        &receipt_set_event,
    )?;
    // A candidate must be the result of the entire sealed V3 action set, not
    // just the one Git action whose ref becomes the candidate. Reconstruct the
    // complete request/claim/result/receipt set before deriving the focused
    // candidate-create proof below; otherwise a set could omit a pending or
    // failed sibling action and become certifiable here even though trusted
    // replay rejects it.
    verify_governed_candidate_receipt_set_completeness(
        conn,
        request,
        authority,
        &dispatch_event,
        &dispatch,
        &dispatch_envelope_digest,
        &receipt_set_event,
        receipt_set,
        &candidate_create_action_id,
    )?;
    let matching_receipt_entries = receipt_set
        .receipts
        .iter()
        .filter(|entry| entry.action_id == candidate_create_action_id)
        .collect::<Vec<_>>();
    if matching_receipt_entries.len() != 1 {
        return candidate_completion_authority_rejected(
            "candidate completion receipt set must contain exactly one candidate-create receipt entry",
        );
    }
    let receipt_entry = matching_receipt_entries[0];

    let receipt_event = unique_verified_kernel_event_matching(
        conn,
        request.run_id,
        EventKind::ActionReceiptRecordedV2,
        authority,
        "candidate-create receipt",
        |event| {
            matches!(
                &event.payload,
                Payload::ActionReceiptRecordedV2(receipt)
                    if receipt.action_receipt_ref == receipt_entry.action_receipt_ref
            )
        },
    )?;
    let Payload::ActionReceiptRecordedV2(receipt) = &receipt_event.payload else {
        unreachable!("receipt event matcher returns only the expected payload")
    };
    let receipt_digest = action_receipt_recorded_v2_digest(receipt).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("could not canonicalize candidate-create receipt: {error}"),
        }
    })?;
    if receipt_digest != receipt_entry.action_receipt_digest
        || receipt.run_id != request.run_id.to_string()
        || receipt.workflow_id != candidate.workflow_id
        || receipt.unit_id != candidate.unit_id
        || receipt.attempt != candidate.attempt
        || receipt.provenance_ref != candidate.provenance_ref
        || receipt.action_id != candidate_create_action_id
        || receipt.dispatch_envelope_digest != dispatch_envelope_digest
        || receipt.capability_bundle_digest != dispatch.body.capability_bundle_digest
        || receipt.policy_digest != expected_policy_digest
        || receipt.context_manifest_digest != dispatch.body.context_manifest_digest
        || receipt.worker_manifest_digest != dispatch.body.worker_manifest_digest
        || receipt.sandbox_profile_digest != dispatch.body.sandbox_profile_digest
        || receipt.authority_actor != authority.kernel_signer.actor_id
        || receipt.execution_role != dispatch.body.execution_role
        || receipt.outcome != ActionReceiptOutcomeV2::Succeeded
    {
        return candidate_completion_authority_rejected(
            "candidate completion receipt does not bind the succeeded candidate-create action",
        );
    }

    let action_request_event = unique_verified_kernel_event_matching(
        conn,
        request.run_id,
        EventKind::ActionRequestedV2,
        authority,
        "candidate-create action request",
        |event| {
            matches!(
                &event.payload,
                Payload::ActionRequestedV2(action_request)
                    if action_request.run_id == request.run_id.to_string()
                        && action_request.action_id == candidate_create_action_id
            )
        },
    )?;
    let Payload::ActionRequestedV2(action_request) = &action_request_event.payload else {
        unreachable!("action-request event matcher returns only the expected payload")
    };
    let action_request_digest = action_requested_v2_digest(action_request).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("could not canonicalize candidate-create action request: {error}"),
        }
    })?;
    let requested_at = parse_claim_timestamp(&action_request.requested_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion action request timestamp is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    let dispatch_issued_at = parse_claim_timestamp(&dispatch.body.issued_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion dispatch issued_at is not canonical RFC3339 UTC".into(),
        }
    })?;
    // Candidate completion is historical verification, so do not require the
    // dispatch to still be live now. Do re-derive the immutable effective
    // deadline from its issued_at/expiry/compute budget: the original lease
    // must have remained inside that authority window when it was issued.
    let effective_deadline = validate_governed_dispatch(&dispatch, dispatch_issued_at)
        .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not derive the governed dispatch effect deadline: {error}"
            ),
        })?
        .effective_deadline;
    if action_request_digest != receipt.action_request_digest
        || action_request_event.parent_event_id != Some(dispatch_event.id)
        || !tape_event_precedes(&dispatch_event, &action_request_event)
        || action_request.action_kind != ActionKindV1::Git
        || action_request.idempotency_key != receipt.idempotency_key
        || action_request.workflow_id != dispatch.body.workflow_id
        || action_request.unit_id != dispatch.body.unit_id
        || action_request.attempt != dispatch.body.attempt
        || action_request.provenance_ref != dispatch.body.provenance_ref
        || action_request.dispatch_envelope_digest != dispatch_envelope_digest
        || action_request.repository_binding_digest != dispatch.repository_binding_digest
        || action_request.ledger_authority_realm_digest != dispatch.ledger_authority_realm_digest
        || action_request.governed_packet_digest != dispatch.governed_packet_digest
        || action_request.capability_bundle_digest != dispatch.body.capability_bundle_digest
        || action_request.policy_digest != expected_policy_digest
        || action_request.context_manifest_digest != dispatch.body.context_manifest_digest
        || action_request.worker_manifest_digest != dispatch.body.worker_manifest_digest
        || action_request.sandbox_profile_digest != dispatch.body.sandbox_profile_digest
        || action_request.authority_actor != authority.kernel_signer.actor_id
        || action_request.execution_role != dispatch.body.execution_role
        || requested_at != action_request_event.occurred_at
        || requested_at < dispatch_issued_at
    {
        return candidate_completion_authority_rejected(
            "candidate completion request does not exactly bind the governed candidate-create action",
        );
    }

    let claim_event = unique_verified_kernel_event_matching(
        conn,
        request.run_id,
        EventKind::ActivityClaimedV1,
        authority,
        "candidate-create activity claim",
        |event| event.parent_event_id == Some(action_request_event.id),
    )?;
    let Payload::ActivityClaimedV1(claim) = &claim_event.payload else {
        unreachable!("claim event matcher returns only the expected payload")
    };
    let claim_event_digest = canonical_event_hash(&claim_event).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("could not canonicalize candidate-create activity claim: {error}"),
        }
    })?;
    let claimed_at = parse_claim_timestamp(&claim.claimed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion activity claim timestamp is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion activity claim lease expiry is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    if claim.run_id != request.run_id
        || claim_event.parent_event_id != Some(action_request_event.id)
        || !tape_event_precedes(&action_request_event, &claim_event)
        || claim.activity_id != candidate_create_action_id
        || claim.idempotency_key != action_request.idempotency_key
        || claim.action_kind != ActionKindV1::Git
        || claim.action_request_event_id != action_request_event.id
        || claim.action_request_digest != action_request_digest
        || claim.dispatch_event_id != request.dispatch_event_id
        || claim.dispatch_envelope_digest != dispatch_envelope_digest
        || claim.authority_actor != authority.kernel_signer.actor_id
        || claim.purpose != ActivityClaimPurposeV1::Generic
        || claimed_at != claim_event.occurred_at
        || claimed_at < requested_at
        || lease_expires_at <= claimed_at
        || lease_expires_at > effective_deadline
    {
        return candidate_completion_authority_rejected(
            "candidate completion claim does not bind a live governed candidate-create request",
        );
    }

    let result_event = unique_verified_kernel_event_matching(
        conn,
        request.run_id,
        EventKind::ActivityResultRecordedV1,
        authority,
        "candidate-create activity result",
        |event| event.parent_event_id == Some(claim_event.id),
    )?;
    let Payload::ActivityResultRecordedV1(result) = &result_event.payload else {
        unreachable!("result event matcher returns only the expected payload")
    };
    let result_event_digest = canonical_event_hash(&result_event).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("could not canonicalize candidate-create activity result: {error}"),
        }
    })?;
    let result_recorded_at = parse_claim_timestamp(&result.recorded_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion activity result timestamp is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    let effective_lease_expires_at = effective_governed_candidate_activity_lease_expiry(
        conn,
        request,
        authority,
        &dispatch_event,
        &dispatch_envelope_digest,
        effective_deadline,
        &action_request_event,
        action_request,
        &claim_event,
        claim,
        &result_event,
    )?;
    if result.run_id != request.run_id
        || result_event.parent_event_id != Some(claim_event.id)
        || !tape_event_precedes(&claim_event, &result_event)
        || result.activity_id != candidate_create_action_id
        || result.idempotency_key != action_request.idempotency_key
        || result.claim_event_id != claim_event.id
        || result.claim_event_digest != claim_event_digest
        || result.lease_id != claim.lease_id
        || result.outcome != ActivityResultOutcomeV1::Succeeded
        || result_recorded_at != result_event.occurred_at
        || result_recorded_at < claimed_at
        || result_recorded_at >= effective_lease_expires_at
        || receipt.result_digest != result.result_digest
        || receipt.result_ref != result.result_ref
        || receipt.evidence_digest != result.evidence_digest
        || receipt.evidence_ref != result.evidence_ref
    {
        return candidate_completion_authority_rejected(
            "candidate completion result and receipt do not bind one succeeded candidate-create lease",
        );
    }
    let receipt_completed_at = parse_claim_timestamp(&receipt.completed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion receipt timestamp is not canonical RFC3339 UTC".into(),
        }
    })?;
    if receipt_event.parent_event_id != Some(result_event.id)
        || !tape_event_precedes(&result_event, &receipt_event)
        || !tape_event_precedes(&receipt_event, &receipt_set_event)
        || receipt_completed_at < claimed_at
        || receipt_completed_at > result_recorded_at
        || receipt_set_sealed_at < receipt_completed_at
    {
        return candidate_completion_authority_rejected(
            "candidate completion receipt-set timestamps do not follow the candidate-create activity",
        );
    }

    let mut completion = CandidateCompletionRecordedV1 {
        run_id: request.run_id.to_string(),
        workflow_id: candidate.workflow_id,
        unit_id: candidate.unit_id,
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref,
        candidate_created_event_ref: request.candidate_created_event_id,
        candidate_digest: candidate.candidate_digest,
        candidate_create_action_id,
        action_request_ref: action_request_event.id,
        action_request_digest,
        activity_claim_event_ref: claim_event.id,
        activity_claim_event_digest: claim_event_digest,
        activity_result_event_ref: result_event.id,
        activity_result_event_digest: result_event_digest,
        action_receipt_ref: receipt.action_receipt_ref.clone(),
        action_receipt_digest: receipt_digest,
        completion_digest: String::new(),
        // Anchor completion to the already-signed candidate event, not wall
        // clock time or an earlier receipt-set timestamp. Preserve its full
        // nanosecond precision: the generic signed append boundary accepts
        // candidate events more precise than the kernel's usual millisecond
        // clock, and truncating here would create a completion before its
        // parent that trusted promotion replay must reject.
        completed_at: candidate_event
            .occurred_at
            .to_rfc3339_opts(SecondsFormat::Nanos, true),
    };
    completion.completion_digest =
        candidate_completion_recorded_v1_digest(&completion).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!("could not canonicalize candidate completion proof: {error}"),
            }
        })?;
    Ok(VerifiedGovernedCandidateCompletionEvidence { completion })
}

fn governed_candidate_completion_by_candidate(
    conn: &Connection,
    run_id: RunId,
    candidate_created_event_id: EventId,
) -> Result<Option<StoredGovernedCandidateCompletion>> {
    conn.query_row(
        "SELECT run_id, dispatch_event_id, candidate_created_event_id, candidate_digest, \
                candidate_create_action_id, action_request_event_id, action_request_digest, \
                activity_claim_event_id, activity_claim_event_digest, activity_result_event_id, \
                activity_result_event_digest, action_receipt_ref, action_receipt_digest, \
                candidate_completion_event_id, candidate_completion_event_digest, completion_digest, completed_at \
         FROM governed_candidate_completions \
         WHERE run_id = ?1 AND candidate_created_event_id = ?2",
        params![run_id.to_string(), candidate_created_event_id.to_string()],
        |row| {
            Ok(StoredGovernedCandidateCompletion {
                run_id: row.get(0)?,
                dispatch_event_id: row.get(1)?,
                candidate_created_event_id: row.get(2)?,
                candidate_digest: row.get(3)?,
                candidate_create_action_id: row.get(4)?,
                action_request_event_id: row.get(5)?,
                action_request_digest: row.get(6)?,
                activity_claim_event_id: row.get(7)?,
                activity_claim_event_digest: row.get(8)?,
                activity_result_event_id: row.get(9)?,
                activity_result_event_digest: row.get(10)?,
                action_receipt_ref: row.get(11)?,
                action_receipt_digest: row.get(12)?,
                candidate_completion_event_id: row.get(13)?,
                candidate_completion_event_digest: row.get(14)?,
                completion_digest: row.get(15)?,
                completed_at: row.get(16)?,
            })
        },
    )
    .optional()
    .map_err(LedgerError::from)
}

/// Reconciliation guard for the append-only completion lane. A projection may
/// name exactly one completion event; an unprojected or sibling event is
/// ambiguous evidence and must never be silently sealed or ignored.
fn require_candidate_completion_event_projection(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    expected_event_id: Option<EventId>,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
         FROM events \
         WHERE run_id = ?1 \
           AND kind = 'candidate_completion_recorded_v1' \
         ORDER BY id ASC",
    )?;
    let event_ids = statement
        .query_map(params![request.run_id.to_string()], |row| {
            Ok(StoredEventRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                parent_event_id: row.get(2)?,
                schema_version: row.get(3)?,
                kind: row.get(4)?,
                occurred_at: row.get(5)?,
                payload: row.get(6)?,
            })
        })?
        .map(|row| -> Result<Option<EventId>> {
            let event = row?.to_event().map_err(|error| {
                candidate_completion_reconciliation_required(
                    request,
                    format!(
                        "candidate completion reconciliation scan could not canonicalize a completion event: {error}"
                    ),
                )
            })?;
            let directly_parented = event.parent_event_id == Some(request.candidate_created_event_id);
            let payload_names_candidate = matches!(
                &event.payload,
                Payload::CandidateCompletionRecordedV1(completion)
                    if completion.candidate_created_event_ref == request.candidate_created_event_id
            );
            Ok((directly_parented || payload_names_candidate).then_some(event.id))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    match expected_event_id {
        None if event_ids.is_empty() => Ok(()),
        Some(expected) if event_ids.as_slice() == [expected] => Ok(()),
        None => Err(candidate_completion_reconciliation_required(
            request,
            "a candidate completion event exists without a trusted native completion projection",
        )),
        Some(_) => Err(candidate_completion_reconciliation_required(
            request,
            "candidate completion projection does not name the only tape completion event for its candidate",
        )),
    }
}

fn stored_governed_candidate_completion_matches(
    stored: &StoredGovernedCandidateCompletion,
    request: &GovernedCandidateCompletionRequestV1,
    completion: &CandidateCompletionRecordedV1,
) -> bool {
    stored.run_id == request.run_id.to_string()
        && stored.dispatch_event_id == request.dispatch_event_id.to_string()
        && stored.candidate_created_event_id == request.candidate_created_event_id.to_string()
        && stored.candidate_digest == completion.candidate_digest
        && stored.candidate_create_action_id == completion.candidate_create_action_id
        && stored.action_request_event_id == completion.action_request_ref.to_string()
        && stored.action_request_digest == completion.action_request_digest
        && stored.activity_claim_event_id == completion.activity_claim_event_ref.to_string()
        && stored.activity_claim_event_digest == completion.activity_claim_event_digest
        && stored.activity_result_event_id == completion.activity_result_event_ref.to_string()
        && stored.activity_result_event_digest == completion.activity_result_event_digest
        && stored.action_receipt_ref == completion.action_receipt_ref
        && stored.action_receipt_digest == completion.action_receipt_digest
        && stored.completion_digest == completion.completion_digest
        && stored.completed_at == completion.completed_at
}

fn resolve_existing_governed_candidate_completion(
    conn: &Connection,
    stored: &StoredGovernedCandidateCompletion,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<GovernedCandidateCompletionDispositionV1> {
    let evidence = verify_governed_candidate_completion_evidence(conn, request, authority)?;
    if !stored_governed_candidate_completion_matches(stored, request, &evidence.completion) {
        return Err(candidate_completion_reconciliation_required(
            request,
            "candidate-completion projection does not exactly match the re-derived immutable lineage",
        ));
    }
    let completion_event_id = parse_event_id(
        &stored.candidate_completion_event_id,
        "governed_candidate_completions",
    )?;
    let completion_event = load_verified_promotion_event(
        conn,
        completion_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate completion",
    )?;
    let completion_event_digest = canonical_event_hash(&completion_event).map_err(|error| {
        LedgerError::CandidateCompletionReconciliationRequired {
            run_id: request.run_id.to_string(),
            candidate_created_event_id: request.candidate_created_event_id.to_string(),
            reason: format!("could not canonicalize stored candidate-completion event: {error}"),
        }
    })?;
    let Payload::CandidateCompletionRecordedV1(completion) = &completion_event.payload else {
        return Err(candidate_completion_reconciliation_required(
            request,
            "candidate-completion projection points to a non-completion tape event",
        ));
    };
    if completion_event.run_id != request.run_id
        || completion_event.parent_event_id != Some(request.candidate_created_event_id)
        || completion_event.occurred_at
            != parse_claim_timestamp(&evidence.completion.completed_at).map_err(|_| {
                candidate_completion_reconciliation_required(
                    request,
                    "re-derived candidate completion timestamp is invalid",
                )
            })?
        || completion != &evidence.completion
        || completion_event_digest != stored.candidate_completion_event_digest
    {
        return Err(candidate_completion_reconciliation_required(
            request,
            "candidate-completion projection or signed tape event is substituted or corrupt",
        ));
    }
    require_candidate_completion_event_projection(conn, request, Some(completion_event_id))?;
    Ok(GovernedCandidateCompletionDispositionV1::Existing {
        candidate_completion_event_id: completion_event_id,
        candidate_completion_event_digest: completion_event_digest,
        completion_digest: evidence.completion.completion_digest,
    })
}

fn insert_governed_candidate_completion(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    completion: &CandidateCompletionRecordedV1,
    event: &Event,
    event_digest: &str,
) -> Result<()> {
    conn.execute(
        r#"INSERT INTO governed_candidate_completions (
                run_id, dispatch_event_id, candidate_created_event_id, candidate_digest,
                candidate_create_action_id, action_request_event_id, action_request_digest,
                activity_claim_event_id, activity_claim_event_digest,
                activity_result_event_id, activity_result_event_digest,
                action_receipt_ref, action_receipt_digest,
                candidate_completion_event_id, candidate_completion_event_digest,
                completion_digest, completed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
            )"#,
        params![
            request.run_id.to_string(),
            request.dispatch_event_id.to_string(),
            request.candidate_created_event_id.to_string(),
            &completion.candidate_digest,
            &completion.candidate_create_action_id,
            completion.action_request_ref.to_string(),
            &completion.action_request_digest,
            completion.activity_claim_event_ref.to_string(),
            &completion.activity_claim_event_digest,
            completion.activity_result_event_ref.to_string(),
            &completion.activity_result_event_digest,
            &completion.action_receipt_ref,
            &completion.action_receipt_digest,
            event.id.to_string(),
            event_digest,
            &completion.completion_digest,
            &completion.completed_at,
        ],
    )?;
    Ok(())
}

fn parse_event_id(id: &str, kind: &str) -> Result<EventId> {
    Uuid::parse_str(id)
        .map(EventId::from_uuid)
        .map_err(|err| invalid_payload(kind, format!("invalid event id: {err}")))
}

fn parse_run_id(id: &str, kind: &str) -> Result<RunId> {
    Uuid::parse_str(id)
        .map(RunId::from_uuid)
        .map_err(|err| invalid_payload(kind, format!("invalid run id: {err}")))
}

fn invalid_payload(kind: &str, reason: String) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason,
    }
}
