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
use crate::payload::command_evidence::{
    canonical_command_action_input_v1_bytes, command_intent_evidence_document_v1_bytes,
    parse_verified_canonical_command_action_input_v1,
    parse_verified_command_intent_evidence_document_v1, CanonicalCommandActionInputV1,
    CommandActionEvidenceBindingV1, CommandIntentEvidenceDocumentV1,
    VerifiedCanonicalCommandActionInputV1, VerifiedCommandIntentEvidenceDocumentV1,
};
use crate::payload::governed_packet::GovernedCommandPacketV1;
use crate::payload::model_evidence::{
    derive_model_action_scope_constraints_v1, model_request_evidence_document_v1_bytes,
    model_request_evidence_v1_descriptor, parse_verified_canonical_model_action_input_v1,
    parse_verified_model_provider_result_document_v1,
    parse_verified_model_provider_unknown_evidence_document_v1,
    parse_verified_model_request_evidence_document_v1,
    parse_verified_model_result_evidence_document_v1,
    parse_verified_provider_token_preflight_input_v1,
    parse_verified_provider_token_preflight_result_v1,
    parse_verified_trust_scope_evidence_document_v1, provider_token_preflight_input_v1_bytes,
    trust_scope_evidence_document_v1_bytes, trust_scope_evidence_v1_descriptor,
    validate_model_action_binding_against_replayed_dispatch_v3,
    verify_model_request_evidence_matches_canonical_input,
    verify_trust_scope_evidence_matches_model_request, ModelActionEvidenceBindingV1,
    ModelProviderV1, ModelRequestEvidenceDocumentV1, ProviderTokenPreflightInputV1,
    TrustScopeEvidenceDocumentV1, VerifiedModelRequestEvidenceDocumentV1,
    VerifiedProviderTokenPreflightInputV1, VerifiedProviderTokenPreflightResultV1,
    VerifiedTrustScopeEvidenceDocumentV1,
};
use crate::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, candidate_completion_recorded_v1_digest,
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest, dispatch_envelope_v5_digest,
    governed_dispatch_policy_digest_v1, model_action_authorized_v2_digest,
    model_action_intent_v1_digest, promotion_execution_claimed_v1_digest, workflow_graph_v2_digest,
    ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    AttemptContextRecordedV1, CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1,
    CandidateCompletionRecordedV1, CandidateCreatedV2, CandidateViewV1, CommitModeV1,
    ContextManifestDeclaredV1, DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5,
    ExecutionRoleV1, GovernedDispatchV5AdmissionRecordedV1, ModelActionAuthorizedV1,
    ModelActionAuthorizedV2, ModelActionCandidateBindingV1, ModelActionIntentV1,
    ModelRequestEvidenceV1, PromotionApprovalRequestedV1, PromotionDecisionKindV1,
    PromotionDecisionRecordedV1, PromotionExecutionClaimedV1, PromotionExecutionLeaseBindingV1,
    PromotionGitBindingV1, PromotionReconciliationResolvedV1, PromotionResultOutcomeV1,
    PromotionResultRecordedV1, PromotionWorktreeSyncStateV1, ReconciliationResolutionOutcomeV1,
    ReviewDecisionV1, ReviewVerdictRecordedV2, SandboxProfileDeclaredV1, TrustScopeEvidenceV1,
    TrustTierV1, WorkerManifestDeclaredV1, WorkflowGraphDeclaredV2, WorkflowTerminalOutcomeV1,
};
use crate::payload::Payload;
use crate::signing::{
    public_key_hash, sign_event, verify_event_signature, ActorKeyRef, EventSignatureV1,
    SignatureAlgorithm, TrustedPublicKeys, VerificationStatus,
};
use crate::storage::cas::{CanonicalCasRef, Cas};
use crate::v5_manifest_witness::{
    validate_v5_manifest_declaration_witnesses, V5ContextManifestDeclarationWitness,
    V5ManifestDeclarationWitnesses, V5SandboxProfileDeclarationWitness,
    V5WorkerManifestDeclarationWitness,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};
#[cfg(any(test, feature = "test-support"))]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const V5_SOURCE_SCAN_BATCH_LIMIT: usize = 64;
const V5_SOURCE_AUTHORITY_FINGERPRINT_DOMAIN_V1: &[u8] =
    b"buildplane.governed-dispatch-v5-source-authority.v1\0";
const V5_SOURCE_EVENT_BOOTSTRAP_QUERY_V1: &str = r#"
    SELECT e.rowid, e.id
    FROM events e INDEXED BY idx_events_v5_envelope_digest
    WHERE e.run_id = ?1
      AND e.kind = 'dispatch_envelope_v5'
      AND json_extract(
            e.payload,
            '$.DispatchEnvelopeV5.envelope_digest'
          ) = ?2
      AND e.rowid > ?3
      AND e.rowid <= ?4
    ORDER BY e.rowid ASC
    LIMIT ?5
"#;
const V5_SOURCE_SCAN_QUERY_V1: &str = r#"
    SELECT
        i.signature_rowid,
        e.id, e.run_id, e.parent_event_id, e.schema_version,
        e.kind, e.occurred_at, e.payload,
        s.event_id, s.canonical_event_hash, s.actor_id, s.key_id,
        s.public_key_hash, s.algorithm, s.signature, s.signed_at
    FROM governed_dispatch_v5_signature_scan_index i
         INDEXED BY idx_governed_dispatch_v5_signature_scan_exact
    JOIN event_signatures s
      ON s.rowid = i.signature_rowid
     AND s.event_id = i.event_id
    JOIN events e ON e.rowid = i.event_rowid AND e.id = i.event_id
    WHERE i.run_id = ?1
      AND i.v5_envelope_digest = ?2
      AND i.actor_id = ?3
      AND i.key_id = ?4
      AND i.public_key_hash = ?5
      AND i.algorithm = 'ed25519'
      AND i.signature_rowid > ?6
      AND i.signature_rowid <= ?7
    ORDER BY i.signature_rowid ASC
    LIMIT ?8
"#;

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

    /// Read-only startup identity accessors for the sibling protected broker
    /// composition. They expose no key material and let a broker reject a
    /// locally injected signer that differs from the authority realm before an
    /// `Existing` recovery path can bypass the writer's signer validation.
    #[doc(hidden)]
    pub fn configured_kernel_signer(&self) -> &ActorKeyRef {
        &self.kernel_signer
    }

    /// See [`Self::configured_kernel_signer`].
    #[doc(hidden)]
    pub fn configured_operator_signer(&self) -> &ActorKeyRef {
        &self.operator_signer
    }
}

/// Distinct protected identities for a governed V3 dispatch admission and its
/// recovery checkpoint. The dispatch signer can create only the immutable
/// admission event; a separately configured kernel signer is required to make
/// that record usable by a recovery-aware caller.
#[derive(Clone, Debug)]
pub struct GovernedDispatchAdmissionAuthorityV1 {
    trusted_keys: TrustedPublicKeys,
    dispatch_signer: ActorKeyRef,
    checkpoint_signer: ActorKeyRef,
    ledger_authority_realm_digest: String,
}

impl GovernedDispatchAdmissionAuthorityV1 {
    /// Construct the narrowly scoped authority for one protected governed
    /// realm. The issuance and checkpoint identities must be independently
    /// trusted, so the admission issuer cannot self-certify its own record.
    pub fn new_governed_realm(
        trusted_keys: TrustedPublicKeys,
        dispatch_signer: ActorKeyRef,
        checkpoint_signer: ActorKeyRef,
        ledger_authority_realm_digest: String,
    ) -> Result<Self> {
        if !is_canonical_sha256_digest(&ledger_authority_realm_digest) {
            return Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason:
                    "governed dispatch admission authority realm digest must be canonical sha256"
                        .into(),
            });
        }
        for (label, signer) in [
            ("dispatch_signer", &dispatch_signer),
            ("checkpoint_signer", &checkpoint_signer),
        ] {
            validate_governed_dispatch_admission_trusted_actor(label, signer)?;
            if trusted_keys.public_key_for(signer).is_none() {
                return Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                    reason: format!("{label} does not have a configured trusted public key"),
                });
            }
        }
        if dispatch_signer.actor_id == checkpoint_signer.actor_id
            || signer_identity_key(&dispatch_signer) == signer_identity_key(&checkpoint_signer)
            || dispatch_signer.public_key_hash == checkpoint_signer.public_key_hash
        {
            return Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: "governed dispatch admission and checkpoint authorities must use distinct actor identities and public keys".into(),
            });
        }
        Ok(Self {
            trusted_keys,
            dispatch_signer,
            checkpoint_signer,
            ledger_authority_realm_digest,
        })
    }
}

/// Three independently configured protected identities for a V5 admission
/// receipt. The source-dispatch signer can prove only the pre-existing V5
/// envelope; a distinct host admission signer can record one receipt, and a
/// third identity must seal the resulting complete tape prefix.
///
/// This authority is deliberately narrower than any effect authority. A
/// sealed V5 admission remains inert unless the separately configured action
/// authority reopens it, verifies its checkpoint, and binds a typed action to
/// the exact nested dispatch.
#[derive(Clone, Debug)]
pub struct GovernedDispatchV5AdmissionAuthorityV1 {
    trusted_keys: TrustedPublicKeys,
    source_dispatch_signer: ActorKeyRef,
    admission_record_signer: ActorKeyRef,
    checkpoint_signer: ActorKeyRef,
    ledger_authority_realm_digest: String,
}

impl GovernedDispatchV5AdmissionAuthorityV1 {
    /// Construct the narrowly scoped authority for one protected V5
    /// admission realm. No identity or public key may serve more than one
    /// role, preventing a source dispatch issuer from self-admitting or
    /// self-sealing its own V5 envelope.
    pub fn new_governed_realm(
        trusted_keys: TrustedPublicKeys,
        source_dispatch_signer: ActorKeyRef,
        admission_record_signer: ActorKeyRef,
        checkpoint_signer: ActorKeyRef,
        ledger_authority_realm_digest: String,
    ) -> Result<Self> {
        if !is_canonical_sha256_digest(&ledger_authority_realm_digest) {
            return governed_dispatch_admission_authority_rejected(
                "governed V5 admission authority realm digest must be canonical sha256",
            );
        }

        let mut actor_ids = HashSet::new();
        let mut signer_identities = HashSet::new();
        let mut public_key_hashes = HashSet::new();
        for (label, signer) in [
            ("source_dispatch_signer", &source_dispatch_signer),
            ("admission_record_signer", &admission_record_signer),
            ("checkpoint_signer", &checkpoint_signer),
        ] {
            validate_governed_dispatch_admission_trusted_actor(label, signer)?;
            if trusted_keys.public_key_for(signer).is_none() {
                return governed_dispatch_admission_authority_rejected(format!(
                    "{label} does not have a configured trusted public key"
                ));
            }
            if !actor_ids.insert(signer.actor_id.clone()) {
                return governed_dispatch_admission_authority_rejected(
                    "governed V5 source-dispatch, admission-record, and checkpoint authorities must use distinct actor identities",
                );
            }
            if !signer_identities.insert(signer_identity_key(signer)) {
                return governed_dispatch_admission_authority_rejected(
                    "governed V5 source-dispatch, admission-record, and checkpoint authorities must use distinct signer identities",
                );
            }
            let public_key_hash = signer
                .public_key_hash
                .as_ref()
                .expect("V5 admission trusted actor was validated")
                .clone();
            if !public_key_hashes.insert(public_key_hash) {
                return governed_dispatch_admission_authority_rejected(
                    "governed V5 source-dispatch, admission-record, and checkpoint authorities must use distinct public keys",
                );
            }
        }

        Ok(Self {
            trusted_keys,
            source_dispatch_signer,
            admission_record_signer,
            checkpoint_signer,
            ledger_authority_realm_digest,
        })
    }
}

/// Closed, read-only request to derive the one candidate-create action
/// identity for a sealed-V3 governed retry. The caller can name only a signed
/// dispatch event and a canonical Buildplane candidate ref; retry namespace,
/// action id, activity id, and idempotency key are re-derived from verified
/// tape and are never accepted as caller input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub candidate_ref: String,
}

/// Exact retry candidate-create identity derived from a sealed-V3 dispatch
/// and its signed retry context. This is an observation-only result: it does
/// not append an action request, claim a lease, or authorize a Git effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedGovernedV3RetryCandidateActionIdentityV1 {
    pub action_id: String,
    pub activity_id: String,
    pub idempotency_key: String,
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

/// Closed terminal result for a protected governed command lease. The caller
/// supplies only the opaque lease and fixed terminal evidence; action and
/// idempotency identity are recovered from the signed claim lineage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedCommandActionResultRequestV1 {
    pub run_id: RunId,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    pub result_digest: Option<String>,
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
}

/// Closed protected-host request to record the succeeded command activity's
/// immutable receipt. This deliberately does not seal an action-receipt set:
/// candidate Git finalization is a later separately authorized activity, and
/// only the complete process-plus-Git set may be sealed for candidate creation.
/// The caller may name only the signed action request; dispatch, admission,
/// claim, result, receipt contents, timestamps, references, and digests are
/// reconstructed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CommandActionReceiptRequestV1 {
    pub run_id: RunId,
    pub action_request_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedV5CommandActionReceiptDispositionV1 {
    Recorded {
        action_receipt_event_id: EventId,
        action_receipt_ref: String,
        action_receipt_digest: String,
    },
    Existing {
        action_receipt_event_id: EventId,
        action_receipt_ref: String,
        action_receipt_digest: String,
    },
}

/// Closed request to issue the Git write-ahead action that materializes one
/// immutable candidate after the implementer process has a signed succeeded
/// receipt. The caller cannot supply candidate identity, ref, Git inputs, or
/// idempotency identity; all are derived from the sealed V5 dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CandidateFinalizeActionIssueRequestV1 {
    pub run_id: RunId,
    pub process_action_request_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedV5CandidateFinalizeActionIssueDispositionV1 {
    Recorded {
        action_request_event_id: EventId,
        action_request_digest: String,
        action_id: String,
        idempotency_key: String,
        candidate_ref: String,
    },
    Existing {
        action_request_event_id: EventId,
        action_request_digest: String,
        action_id: String,
        idempotency_key: String,
        candidate_ref: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernedV5CandidateFinalizeInputV1 {
    schema_version: u8,
    action: String,
    candidate_id: String,
    run_id: String,
    attempt: u32,
    candidate_key: String,
    candidate_ref: String,
    base_sha: String,
}

/// Closed request for the only lease that may execute a V5 candidate Git
/// finalization. Every action and candidate field is reconstructed from signed
/// tape and strict CAS evidence before a purpose-bound claim can be appended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub admission_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Closed terminal-result input for the purpose-bound candidate Git lease.
/// The opaque lease is the only activity selector exposed to the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CandidateFinalizeResultRequestV1 {
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

/// Closed host-private request for the only governed process-effect authority
/// transition. All executable bytes and action identity are reconstructed
/// from signed tape and protected CAS; the caller may select only the already
/// recorded dispatch/action pair and the bounded startup lease duration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedCommandActionAuthorizeAndClaimRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// V5-only process-effect transition. The admission event is an explicit
/// authority input because a raw manifest-bound dispatch remains unusable even
/// when a correctly signed action request happens to reference it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CommandActionAuthorizeAndClaimRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub admission_event_id: EventId,
    pub action_request_event_id: EventId,
    pub lease_duration_ms: u64,
}

/// Closed protected request that turns one signed dispatch plus untrusted
/// packet source into the sole process `ActionRequestedV2` for that dispatch.
///
/// The caller cannot select action identity, executable digests, policy,
/// manifests, role, or timestamp. Native code normalizes the packet, verifies
/// its capability/acceptance bindings against signed dispatch authority, and
/// persists the exact executable bytes to protected CAS before appending.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedCommandActionIssueRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub packet_source: String,
}

/// V5-only command issuance request. The separately signed and checkpointed
/// admission receipt is mandatory; naming the source V5 dispatch alone never
/// reaches the action plane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedV5CommandActionIssueRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub admission_event_id: EventId,
    pub packet_source: String,
}

/// Closed read-only request used by the protected candidate host to identify
/// one sealed V5 dispatch from normalized packet bytes. Event identities are
/// deliberately not caller inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveGovernedV5CandidateAuthorityRequestV1 {
    pub run_id: RunId,
    pub packet_source: String,
}

/// Exact candidate-opening authority recovered from one checkpoint-sealed V5
/// admission. This contains no signer or lease capability; it lets the host
/// verify the local repository and derive fixed candidate/session identities
/// before issuing the separately signed command action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedGovernedV5CandidateAuthorityV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub admission_event_id: EventId,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub base_commit_sha: String,
    pub repository_binding_digest: String,
    pub dispatch_envelope_digest: String,
    pub governed_packet_digest: String,
    pub sandbox_profile_digest: String,
}

/// Restart-safe execution authority recovered from the dispatch identity in a
/// signed candidate-session token. The action identity is selected from the
/// signed tape, never supplied by the reconnecting client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedGovernedV5CandidateExecutionAuthorityV1 {
    pub candidate: ResolvedGovernedV5CandidateAuthorityV1,
    pub action_request_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedCommandActionIssueDispositionV1 {
    Issued {
        action_request_event_id: EventId,
        canonical_input_ref: String,
        canonical_input_digest: String,
        verified_input: VerifiedCanonicalCommandActionInputV1,
    },
    Existing {
        action_request_event_id: EventId,
        canonical_input_ref: String,
        canonical_input_digest: String,
        verified_input: VerifiedCanonicalCommandActionInputV1,
    },
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

/// Read-only request to reconstruct one completed provider token-count
/// activity from signed tape and protected CAS. Every dynamic field is derived
/// from the already-issued model intent and the preflight action it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderTokenPreflightRecordingRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub model_action_request_event_id: EventId,
    pub preflight_action_request_event_id: EventId,
}

/// Read-only request that locates the one provider token-count activity
/// derived from a verified model action. The caller cannot select an
/// alternate preflight action or result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderTokenPreflightForModelActionRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub model_action_request_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderTokenPreflightActionIssueRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
    pub model_action_request_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderTokenPreflightActionIssueDispositionV1 {
    Issued {
        action_request_event_id: EventId,
        canonical_input_ref: String,
        canonical_input_digest: String,
        verified_input: VerifiedProviderTokenPreflightInputV1,
        dispatch: DispatchEnvelopeV3,
        model_request: VerifiedModelRequestEvidenceDocumentV1,
        trust_scope: VerifiedTrustScopeEvidenceDocumentV1,
        candidate_binding: Option<ModelActionCandidateBindingV1>,
    },
    Existing {
        action_request_event_id: EventId,
        canonical_input_ref: String,
        canonical_input_digest: String,
        verified_input: VerifiedProviderTokenPreflightInputV1,
        dispatch: DispatchEnvelopeV3,
        model_request: VerifiedModelRequestEvidenceDocumentV1,
        trust_scope: VerifiedTrustScopeEvidenceDocumentV1,
        candidate_binding: Option<ModelActionCandidateBindingV1>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedProviderTokenPreflightRecordingV1 {
    input: VerifiedProviderTokenPreflightInputV1,
    result: VerifiedProviderTokenPreflightResultV1,
    dispatch: DispatchEnvelopeV3,
    model_request: VerifiedModelRequestEvidenceDocumentV1,
    trust_scope: VerifiedTrustScopeEvidenceDocumentV1,
    candidate_binding: Option<ModelActionCandidateBindingV1>,
}

impl VerifiedProviderTokenPreflightRecordingV1 {
    #[cfg(any(test, feature = "test-support"))]
    pub fn from_verified_parts_for_tests(
        input: VerifiedProviderTokenPreflightInputV1,
        result: VerifiedProviderTokenPreflightResultV1,
        dispatch: DispatchEnvelopeV3,
        model_request: VerifiedModelRequestEvidenceDocumentV1,
        trust_scope: VerifiedTrustScopeEvidenceDocumentV1,
        candidate_binding: Option<ModelActionCandidateBindingV1>,
    ) -> Self {
        Self {
            input,
            result,
            dispatch,
            model_request,
            trust_scope,
            candidate_binding,
        }
    }

    pub fn input(&self) -> &VerifiedProviderTokenPreflightInputV1 {
        &self.input
    }

    pub fn result(&self) -> &VerifiedProviderTokenPreflightResultV1 {
        &self.result
    }

    pub fn dispatch(&self) -> &DispatchEnvelopeV3 {
        &self.dispatch
    }

    pub fn model_request(&self) -> &VerifiedModelRequestEvidenceDocumentV1 {
        &self.model_request
    }

    pub fn trust_scope(&self) -> &VerifiedTrustScopeEvidenceDocumentV1 {
        &self.trust_scope
    }

    pub fn candidate_binding(&self) -> Option<&ModelActionCandidateBindingV1> {
        self.candidate_binding.as_ref()
    }
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

/// Closed broker-private input for one governed V3 dispatch admission. The
/// full signed authority material is supplied as a typed V3 envelope, while
/// its event identity, detached signature, immutable projection, and later
/// checkpoint evidence are all generated by the ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedDispatchAdmissionRequestV1 {
    pub run_id: RunId,
    pub dispatch: DispatchEnvelopeV3,
}

/// Broker-private request to seal one previously recorded V3 admission. The
/// caller can name only the immutable dispatch event; checkpoint bytes, roots,
/// and coverage are re-derived by the ledger under the configured checkpoint
/// authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedDispatchAdmissionSealRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
}

/// Closed protected-host request to record a V5 admission receipt. Callers
/// name only an already signed V5 dispatch event; every nested graph and
/// manifest witness is re-derived inside the immediate ledger transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedDispatchV5AdmissionRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
}

/// Closed protected-host request to seal an already-recorded V5 admission.
/// The admission receipt, source dispatch, complete signed prefix, and
/// checkpoint coverage are all re-derived by the ledger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedDispatchV5AdmissionSealRequestV1 {
    pub run_id: RunId,
    pub admission_event_id: EventId,
}

/// Closed, observation-only read of one already-persisted manifest-bound V5
/// dispatch. The caller can name only the tape event; storage reconstructs and
/// verifies every graph and manifest witness before it creates an immutable
/// non-authoritative shadow row.
///
/// This is deliberately not a V5 admission or execution capability. In
/// particular, it never signs a dispatch, emits a checkpoint, or enables a
/// claim, candidate, promotion, or action path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedDispatchV5ObservationRequestV1 {
    pub run_id: RunId,
    pub dispatch_event_id: EventId,
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

/// Closed broker-only request to abandon one already-recorded governed
/// promotion reconciliation. Every payload field is re-derived from the
/// sealed decision and immutable result; the caller cannot choose an outcome,
/// receipt, candidate, signer, or timestamp.
///
/// This stays out of the generic ledger-server protocol. It is public only so
/// the sibling broker crate can hold the protected startup composition.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernedPromotionReconciliationRequestV1 {
    pub run_id: RunId,
    pub promotion_decision_event_id: EventId,
    pub promotion_result_event_id: EventId,
}

/// Exact durable resolution returned by the broker-only reconciliation writer.
/// A retry resolves the existing signed event and never emits a second
/// operator abandonment.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedPromotionReconciliationDispositionV1 {
    Recorded {
        promotion_reconciliation_event_id: EventId,
        promotion_reconciliation_event_digest: String,
        outcome: ReconciliationResolutionOutcomeV1,
    },
    Existing {
        promotion_reconciliation_event_id: EventId,
        promotion_reconciliation_event_digest: String,
        outcome: ReconciliationResolutionOutcomeV1,
    },
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

/// Result of the protected command authorization transition. Only a fresh
/// grant contains verified executable evidence and an opaque lease. Duplicate,
/// completed, and expired calls never receive either again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedCommandActionAuthorizeAndClaimDispositionV1 {
    Granted {
        claim_event_id: EventId,
        claim_event_digest: String,
        lease_id: String,
        lease_expires_at: String,
        command_intent: VerifiedCommandIntentEvidenceDocumentV1,
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
    LeaseExpired {
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

/// Durable state of a governed V3 dispatch admission. An
/// `AwaitingCheckpoint` record is recovery evidence only; callers must not
/// treat it as dispatch success until the exact admission-specific seal has
/// associated a verified kernel checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedDispatchAdmissionDispositionV1 {
    AwaitingCheckpoint {
        dispatch_event_id: EventId,
        dispatch_event_digest: String,
        semantic_identity_digest: String,
        idempotency_key: String,
    },
    Sealed {
        dispatch_event_id: EventId,
        dispatch_event_digest: String,
        semantic_identity_digest: String,
        idempotency_key: String,
        checkpoint_event_id: EventId,
        checkpoint_event_digest: String,
    },
}

/// Durable state of a protected V5 admission record. Both variants are
/// non-effect evidence: V5 remains intentionally absent from
/// `dispatch_authority_material()` and cannot claim activities, create
/// candidates, promote, or otherwise mutate a target branch in this slice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedDispatchV5AdmissionDispositionV1 {
    AwaitingCheckpoint {
        source_dispatch_event_id: EventId,
        source_dispatch_event_digest: String,
        admission_event_id: EventId,
        admission_event_digest: String,
        v5_envelope_digest: String,
        witness_evidence_digest: String,
        semantic_identity_digest: String,
        idempotency_key: String,
    },
    Sealed {
        source_dispatch_event_id: EventId,
        source_dispatch_event_digest: String,
        admission_event_id: EventId,
        admission_event_digest: String,
        v5_envelope_digest: String,
        witness_evidence_digest: String,
        semantic_identity_digest: String,
        idempotency_key: String,
        checkpoint_event_id: EventId,
        checkpoint_event_digest: String,
    },
}

/// Result of resolving a tape-backed V5 observation shadow. Neither variant
/// conveys live dispatch authority; a later protected-host proof must be
/// designed as a distinct, explicit transition before V5 can reach any effect
/// consumer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernedDispatchV5ObservationDispositionV1 {
    Observed {
        dispatch_event_id: EventId,
        dispatch_event_digest: String,
        v5_envelope_digest: String,
    },
    Existing {
        dispatch_event_id: EventId,
        dispatch_event_digest: String,
        v5_envelope_digest: String,
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

/// Upgrade the governed-dispatch projection identity without rewriting legacy
/// tape-backed rows.
///
/// Early V3 stores keyed the projection identity by workflow revision. A later
/// revision-free unique index is correct for new writes, but SQLite cannot add
/// it to a legacy database that already has cross-revision siblings. Keep that
/// evidence readable, record the ambiguous identities immutably, and block all
/// future duplicate projection inserts instead of choosing a historical row.
fn ensure_governed_dispatch_admission_identity_guard_v2(conn: &Connection) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS governed_dispatch_admission_identity_conflicts_v2 (
            run_id                      TEXT NOT NULL,
            workflow_id                 TEXT NOT NULL,
            unit_id                     TEXT NOT NULL,
            attempt                     INTEGER NOT NULL CHECK(attempt > 0),
            observed_projection_count   INTEGER NOT NULL CHECK(observed_projection_count > 1),
            detected_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (run_id, workflow_id, unit_id, attempt)
        );

        CREATE TRIGGER IF NOT EXISTS governed_dispatch_admission_identity_conflicts_v2_no_update
            BEFORE UPDATE ON governed_dispatch_admission_identity_conflicts_v2
            BEGIN
                SELECT RAISE(ABORT, 'governed dispatch admission identity conflicts are immutable: UPDATE forbidden');
            END;

        CREATE TRIGGER IF NOT EXISTS governed_dispatch_admission_identity_conflicts_v2_no_delete
            BEFORE DELETE ON governed_dispatch_admission_identity_conflicts_v2
            BEGIN
                SELECT RAISE(ABORT, 'governed dispatch admission identity conflicts are immutable: DELETE forbidden');
            END;

        -- The V2 trigger is intentionally installed even when a historical
        -- conflict prevents the corresponding unique index from being
        -- created. It stops an older writer from growing an ambiguous identity
        -- into a third projection.
        CREATE TRIGGER IF NOT EXISTS governed_dispatch_admissions_reject_duplicate_identity_v2
            BEFORE INSERT ON governed_dispatch_admissions
            WHEN EXISTS (
                SELECT 1
                FROM governed_dispatch_admissions AS existing
                WHERE existing.run_id = NEW.run_id
                  AND existing.workflow_id = NEW.workflow_id
                  AND existing.unit_id = NEW.unit_id
                  AND existing.attempt = NEW.attempt
            )
            BEGIN
                SELECT RAISE(ABORT, 'governed dispatch admission identity already exists');
            END;
        "#,
    )?;

    let conflicting_identity_count: i64 = tx.query_row(
        r#"SELECT COUNT(*)
           FROM (
               SELECT 1
               FROM governed_dispatch_admissions
               GROUP BY run_id, workflow_id, unit_id, attempt
               HAVING COUNT(*) > 1
           )"#,
        [],
        |row| row.get(0),
    )?;
    if conflicting_identity_count == 0 {
        tx.execute_batch(
            r#"
            CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_dispatch_admissions_workflow_attempt
                ON governed_dispatch_admissions(run_id, workflow_id, unit_id, attempt);
            "#,
        )?;
    } else {
        tx.execute(
            r#"INSERT OR IGNORE INTO governed_dispatch_admission_identity_conflicts_v2 (
                    run_id, workflow_id, unit_id, attempt, observed_projection_count
                )
                SELECT run_id, workflow_id, unit_id, attempt, COUNT(*)
                FROM governed_dispatch_admissions
                GROUP BY run_id, workflow_id, unit_id, attempt
                HAVING COUNT(*) > 1"#,
            [],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// SQLite connection wrapping the events + runs schema.
pub struct SqliteStore {
    conn: Connection,
    /// Canonical durable identity captured from the connection when it opens.
    /// It is intentionally not re-resolved later: a changed symlink must not
    /// make an already-open store appear to be a different database.
    database_path: Option<PathBuf>,
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
    /// Test-only count of V5 digest-index candidates that reached canonical
    /// reconstruction/signature verification. It proves unrelated tape rows
    /// do not regress the protected resolver to a per-event scan.
    #[cfg(any(test, feature = "test-support"))]
    v5_source_candidate_verification_count: Cell<u64>,
    /// Test-only count of signer-filtered V5 candidates loaded from SQLite.
    #[cfg(any(test, feature = "test-support"))]
    v5_source_candidate_loaded_count: Cell<u64>,
}

fn canonical_database_path_for_connection(conn: &Connection) -> Option<PathBuf> {
    let mut statement = conn.prepare("PRAGMA database_list").ok()?;
    let mut rows = statement.query([]).ok()?;
    while let Some(row) = rows.next().ok()? {
        let schema: String = row.get(1).ok()?;
        if schema != "main" {
            continue;
        }
        let path: String = row.get(2).ok()?;
        return (!path.is_empty())
            .then(|| std::fs::canonicalize(path).ok())
            .flatten();
    }
    None
}

impl SqliteStore {
    /// Open or create a ledger database at `path`. Creates tables and the
    /// append-only trigger on first open.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        let database_path = canonical_database_path_for_connection(&conn);
        Self::init(&conn)?;
        Ok(Self {
            conn,
            database_path,
            ordinary_id_high_water: RefCell::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            fail_next_checkpoint_signature_insert: Cell::new(false),
            #[cfg(any(test, feature = "test-support"))]
            v5_source_candidate_verification_count: Cell::new(0),
            #[cfg(any(test, feature = "test-support"))]
            v5_source_candidate_loaded_count: Cell::new(0),
        })
    }

    /// Open an in-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(&conn)?;
        Ok(Self {
            conn,
            database_path: None,
            ordinary_id_high_water: RefCell::new(HashMap::new()),
            #[cfg(any(test, feature = "test-support"))]
            fail_next_checkpoint_signature_insert: Cell::new(false),
            #[cfg(any(test, feature = "test-support"))]
            v5_source_candidate_verification_count: Cell::new(0),
            #[cfg(any(test, feature = "test-support"))]
            v5_source_candidate_loaded_count: Cell::new(0),
        })
    }

    /// Return the canonical durable file identity captured when this store
    /// opened. In-memory, unnamed, and non-canonicalizable databases
    /// deliberately have no usable identity for a cross-connection trusted
    /// recovery proof.
    pub fn canonical_database_path(&self) -> Result<PathBuf> {
        self.database_path
            .clone()
            .ok_or_else(|| LedgerError::DatabaseIdentityUnavailable {
                reason: "the opened SQLite connection has no canonical durable primary path".into(),
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
            CREATE INDEX IF NOT EXISTS idx_events_v5_envelope_digest
                ON events(
                    run_id,
                    kind,
                    json_extract(payload, '$.DispatchEnvelopeV5.envelope_digest')
                )
                WHERE kind = 'dispatch_envelope_v5';

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

            -- The implicit rowid appended to this equality-prefix index is the
            -- trusted monotonic cursor for bounded V5 source scans.
            CREATE INDEX IF NOT EXISTS idx_event_signatures_v5_source_scan
                ON event_signatures(actor_id, key_id, public_key_hash, algorithm);

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

            -- Append-derived lookup metadata only. These rows narrow bounded
            -- scans but are never authority: the referenced event and
            -- signature are reloaded from the append-only tape and verified.
            CREATE TABLE IF NOT EXISTS governed_dispatch_v5_signature_scan_index (
                signature_rowid       INTEGER PRIMARY KEY CHECK(signature_rowid > 0),
                event_rowid           INTEGER NOT NULL CHECK(event_rowid > 0),
                event_id              TEXT NOT NULL UNIQUE,
                run_id                TEXT NOT NULL,
                v5_envelope_digest    TEXT NOT NULL,
                actor_id              TEXT NOT NULL,
                key_id                TEXT NOT NULL,
                public_key_hash       TEXT,
                algorithm             TEXT NOT NULL,
                FOREIGN KEY(event_id) REFERENCES events(id)
            );

            CREATE INDEX IF NOT EXISTS idx_governed_dispatch_v5_signature_scan_exact
                ON governed_dispatch_v5_signature_scan_index(
                    run_id,
                    v5_envelope_digest,
                    actor_id,
                    key_id,
                    public_key_hash,
                    algorithm,
                    signature_rowid
                );

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_signature_scan_after_insert
                AFTER INSERT ON event_signatures
                BEGIN
                    INSERT INTO governed_dispatch_v5_signature_scan_index (
                        signature_rowid, event_rowid, event_id, run_id,
                        v5_envelope_digest, actor_id, key_id,
                        public_key_hash, algorithm
                    )
                    SELECT
                        NEW.rowid, e.rowid, e.id, e.run_id,
                        json_extract(
                            e.payload,
                            '$.DispatchEnvelopeV5.envelope_digest'
                        ),
                        NEW.actor_id, NEW.key_id, NEW.public_key_hash,
                        NEW.algorithm
                    FROM events e
                    WHERE e.id = NEW.event_id
                      AND e.kind = 'dispatch_envelope_v5';
                END;

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_signature_scan_no_update
                BEFORE UPDATE ON governed_dispatch_v5_signature_scan_index
                BEGIN
                    SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_signature_scan_no_delete
                BEFORE DELETE ON governed_dispatch_v5_signature_scan_index
                BEGIN
                    SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: DELETE forbidden');
                END;

            -- Mutable, broker-private scan state. It is not tape evidence and
            -- grants no authority by itself: every projected candidate is
            -- reloaded and cryptographically reverified before use.
            CREATE TABLE IF NOT EXISTS governed_dispatch_v5_source_scans (
                run_id                              TEXT NOT NULL,
                v5_envelope_digest                  TEXT NOT NULL,
                source_authority_fingerprint        TEXT NOT NULL,
                scan_schema_version                 INTEGER NOT NULL CHECK(scan_schema_version = 1),
                event_cursor_rowid                  INTEGER NOT NULL CHECK(event_cursor_rowid >= 0),
                observed_event_high_water_rowid     INTEGER NOT NULL CHECK(observed_event_high_water_rowid >= 0),
                event_complete_through_rowid        INTEGER,
                cursor_signature_rowid              INTEGER NOT NULL CHECK(cursor_signature_rowid >= 0),
                observed_high_water_rowid           INTEGER NOT NULL CHECK(observed_high_water_rowid >= 0),
                complete_through_signature_rowid    INTEGER,
                candidate_signature_rowid           INTEGER,
                candidate_event_id                  TEXT,
                candidate_event_digest              TEXT,
                ambiguous                           INTEGER NOT NULL CHECK(ambiguous IN (0, 1)),
                PRIMARY KEY (
                    run_id,
                    v5_envelope_digest,
                    source_authority_fingerprint
                ),
                FOREIGN KEY(candidate_event_id) REFERENCES events(id),
                CHECK(event_cursor_rowid <= observed_event_high_water_rowid),
                CHECK(
                    event_complete_through_rowid IS NULL
                    OR (
                        event_complete_through_rowid = event_cursor_rowid
                        AND event_complete_through_rowid =
                            observed_event_high_water_rowid
                    )
                ),
                CHECK(cursor_signature_rowid <= observed_high_water_rowid),
                CHECK(
                    complete_through_signature_rowid IS NULL
                    OR (
                        complete_through_signature_rowid = cursor_signature_rowid
                        AND complete_through_signature_rowid = observed_high_water_rowid
                    )
                ),
                CHECK(
                    (
                        candidate_signature_rowid IS NULL
                        AND candidate_event_id IS NULL
                        AND candidate_event_digest IS NULL
                    )
                    OR
                    (
                        candidate_signature_rowid IS NOT NULL
                        AND candidate_signature_rowid > 0
                        AND candidate_signature_rowid <= cursor_signature_rowid
                        AND candidate_event_id IS NOT NULL
                        AND candidate_event_digest IS NOT NULL
                    )
                )
            );

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

            -- Broker-private projection for one signed governed V3 dispatch
            -- admission. The durable row is keyed by the dispatch
            -- idempotency key but also prevents two different envelopes from
            -- claiming the same workflow/unit/attempt, irrespective of
            -- workflow revision. It begins as
            -- recovery-only evidence and may advance exactly once when a
            -- distinct kernel checkpoint seals the complete signed prefix.
            CREATE TABLE IF NOT EXISTS governed_dispatch_admissions (
                run_id                              TEXT NOT NULL,
                idempotency_key                     TEXT NOT NULL,
                workflow_id                         TEXT NOT NULL,
                workflow_revision                   TEXT NOT NULL,
                unit_id                             TEXT NOT NULL,
                attempt                             INTEGER NOT NULL CHECK(attempt > 0),
                envelope_digest                     TEXT NOT NULL,
                governed_packet_digest              TEXT NOT NULL,
                semantic_identity_digest            TEXT NOT NULL,
                dispatch_event_id                   TEXT NOT NULL UNIQUE,
                dispatch_event_digest               TEXT NOT NULL,
                state                               TEXT NOT NULL CHECK(state IN ('awaiting_checkpoint', 'sealed')),
                sealed_checkpoint_event_id          TEXT,
                sealed_checkpoint_event_digest      TEXT,
                created_at                          TEXT NOT NULL,
                sealed_at                           TEXT,
                PRIMARY KEY (run_id, idempotency_key),
                UNIQUE (run_id, semantic_identity_digest),
                FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(sealed_checkpoint_event_id) REFERENCES events(id),
                CHECK(
                    (state = 'awaiting_checkpoint'
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

            CREATE INDEX IF NOT EXISTS idx_governed_dispatch_admissions_state
                ON governed_dispatch_admissions(run_id, state);

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_admissions_no_delete
                BEFORE DELETE ON governed_dispatch_admissions
                BEGIN
                    SELECT RAISE(ABORT, 'governed dispatch admissions are tape-backed: DELETE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_admissions_seal_only
                BEFORE UPDATE ON governed_dispatch_admissions
                WHEN OLD.state != 'awaiting_checkpoint'
                  OR NEW.state != 'sealed'
                  OR OLD.run_id != NEW.run_id
                  OR OLD.idempotency_key != NEW.idempotency_key
                  OR OLD.workflow_id != NEW.workflow_id
                  OR OLD.workflow_revision != NEW.workflow_revision
                  OR OLD.unit_id != NEW.unit_id
                  OR OLD.attempt != NEW.attempt
                  OR OLD.envelope_digest != NEW.envelope_digest
                  OR OLD.governed_packet_digest != NEW.governed_packet_digest
                  OR OLD.semantic_identity_digest != NEW.semantic_identity_digest
                  OR OLD.dispatch_event_id != NEW.dispatch_event_id
                  OR OLD.dispatch_event_digest != NEW.dispatch_event_digest
                  OR OLD.created_at != NEW.created_at
                BEGIN
                    SELECT RAISE(ABORT, 'governed dispatch admissions permit only one checkpoint-seal transition');
                END;

            -- Immutable, observation-only shadow for a manifest-bound V5
            -- dispatch. It records fully re-verified tape witnesses for audit
            -- and later protected-host proof, but cannot become dispatch or
            -- effect authority: no state transition exists in this slice.
            CREATE TABLE IF NOT EXISTS governed_dispatch_v5_observations (
                authority                              TEXT NOT NULL CHECK(authority = 'non_authoritative_v5_observation'),
                observation_schema_version             INTEGER NOT NULL CHECK(observation_schema_version = 1),
                run_id                                 TEXT NOT NULL,
                idempotency_key                        TEXT NOT NULL,
                workflow_id                            TEXT NOT NULL,
                workflow_revision                      TEXT NOT NULL,
                unit_id                                TEXT NOT NULL,
                attempt                                INTEGER NOT NULL CHECK(attempt > 0),
                semantic_identity_digest               TEXT NOT NULL,
                dispatch_event_id                      TEXT NOT NULL UNIQUE,
                dispatch_event_digest                  TEXT NOT NULL,
                v5_envelope_digest                     TEXT NOT NULL,
                v4_envelope_digest                     TEXT NOT NULL,
                v4_graph_declaration_event_id          TEXT NOT NULL,
                v4_graph_declaration_event_digest      TEXT NOT NULL,
                v4_graph_digest                        TEXT NOT NULL,
                context_manifest_event_id              TEXT NOT NULL,
                context_manifest_event_digest          TEXT NOT NULL,
                context_manifest_digest                TEXT NOT NULL,
                worker_manifest_event_id               TEXT NOT NULL,
                worker_manifest_event_digest           TEXT NOT NULL,
                worker_manifest_digest                 TEXT NOT NULL,
                sandbox_profile_event_id               TEXT NOT NULL,
                sandbox_profile_event_digest           TEXT NOT NULL,
                sandbox_profile_digest                 TEXT NOT NULL,
                retry_context_event_id                 TEXT,
                retry_context_event_digest             TEXT,
                retry_context_digest                   TEXT,
                observed_at                            TEXT NOT NULL,
                PRIMARY KEY (run_id, dispatch_event_id),
                UNIQUE (run_id, idempotency_key),
                UNIQUE (run_id, workflow_id, unit_id, attempt),
                UNIQUE (run_id, semantic_identity_digest),
                FOREIGN KEY(dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(v4_graph_declaration_event_id) REFERENCES events(id),
                FOREIGN KEY(context_manifest_event_id) REFERENCES events(id),
                FOREIGN KEY(worker_manifest_event_id) REFERENCES events(id),
                FOREIGN KEY(sandbox_profile_event_id) REFERENCES events(id),
                FOREIGN KEY(retry_context_event_id) REFERENCES events(id),
                CHECK(
                    (retry_context_event_id IS NULL
                        AND retry_context_event_digest IS NULL
                        AND retry_context_digest IS NULL)
                    OR
                    (retry_context_event_id IS NOT NULL
                        AND retry_context_event_digest IS NOT NULL
                        AND retry_context_digest IS NOT NULL)
                )
            );

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_observations_no_update
                BEFORE UPDATE ON governed_dispatch_v5_observations
                BEGIN
                    SELECT RAISE(ABORT, 'governed V5 dispatch observations are immutable: UPDATE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_observations_no_delete
                BEFORE DELETE ON governed_dispatch_v5_observations
                BEGIN
                    SELECT RAISE(ABORT, 'governed V5 dispatch observations are immutable: DELETE forbidden');
                END;

            -- Broker-private projection for one protected-host V5 admission
            -- receipt. This is intentionally distinct from the observation
            -- shadow: it is signed by a separately configured admission
            -- identity and may advance once when a third checkpoint identity
            -- seals the complete signed prefix. It is not effect authority on
            -- its own: the candidate/action plane reopens this evidence only
            -- together with a separately configured activity authority.
            CREATE TABLE IF NOT EXISTS governed_dispatch_v5_admissions (
                run_id                              TEXT NOT NULL,
                idempotency_key                     TEXT NOT NULL,
                workflow_id                         TEXT NOT NULL,
                workflow_revision                   TEXT NOT NULL,
                unit_id                             TEXT NOT NULL,
                attempt                             INTEGER NOT NULL CHECK(attempt > 0),
                semantic_identity_digest            TEXT NOT NULL,
                source_dispatch_event_id            TEXT NOT NULL UNIQUE,
                source_dispatch_event_digest        TEXT NOT NULL,
                v5_envelope_digest                  TEXT NOT NULL,
                v4_envelope_digest                  TEXT NOT NULL,
                v4_graph_declaration_event_id       TEXT NOT NULL,
                v4_graph_declaration_event_digest   TEXT NOT NULL,
                v4_graph_digest                     TEXT NOT NULL,
                context_manifest_event_id           TEXT NOT NULL,
                context_manifest_event_digest       TEXT NOT NULL,
                context_manifest_digest             TEXT NOT NULL,
                worker_manifest_event_id            TEXT NOT NULL,
                worker_manifest_event_digest        TEXT NOT NULL,
                worker_manifest_digest              TEXT NOT NULL,
                sandbox_profile_event_id            TEXT NOT NULL,
                sandbox_profile_event_digest        TEXT NOT NULL,
                sandbox_profile_digest              TEXT NOT NULL,
                retry_context_event_id              TEXT,
                retry_context_event_digest          TEXT,
                retry_context_digest                TEXT,
                witness_evidence_digest             TEXT NOT NULL,
                ledger_authority_realm_digest       TEXT NOT NULL,
                admission_event_id                  TEXT NOT NULL UNIQUE,
                admission_event_digest              TEXT NOT NULL,
                state                               TEXT NOT NULL CHECK(state IN ('awaiting_checkpoint', 'sealed')),
                sealed_checkpoint_event_id          TEXT,
                sealed_checkpoint_event_digest      TEXT,
                created_at                          TEXT NOT NULL,
                sealed_at                           TEXT,
                PRIMARY KEY (run_id, source_dispatch_event_id),
                UNIQUE (run_id, idempotency_key),
                UNIQUE (run_id, workflow_id, unit_id, attempt),
                UNIQUE (run_id, semantic_identity_digest),
                FOREIGN KEY(source_dispatch_event_id) REFERENCES events(id),
                FOREIGN KEY(admission_event_id) REFERENCES events(id),
                FOREIGN KEY(v4_graph_declaration_event_id) REFERENCES events(id),
                FOREIGN KEY(context_manifest_event_id) REFERENCES events(id),
                FOREIGN KEY(worker_manifest_event_id) REFERENCES events(id),
                FOREIGN KEY(sandbox_profile_event_id) REFERENCES events(id),
                FOREIGN KEY(retry_context_event_id) REFERENCES events(id),
                FOREIGN KEY(sealed_checkpoint_event_id) REFERENCES events(id),
                CHECK(
                    (state = 'awaiting_checkpoint'
                        AND sealed_checkpoint_event_id IS NULL
                        AND sealed_checkpoint_event_digest IS NULL
                        AND sealed_at IS NULL)
                    OR
                    (state = 'sealed'
                        AND sealed_checkpoint_event_id IS NOT NULL
                        AND sealed_checkpoint_event_digest IS NOT NULL
                        AND sealed_at IS NOT NULL)
                ),
                CHECK(
                    (retry_context_event_id IS NULL
                        AND retry_context_event_digest IS NULL
                        AND retry_context_digest IS NULL)
                    OR
                    (retry_context_event_id IS NOT NULL
                        AND retry_context_event_digest IS NOT NULL
                        AND retry_context_digest IS NOT NULL)
                )
            );

            CREATE INDEX IF NOT EXISTS idx_governed_dispatch_v5_admissions_state
                ON governed_dispatch_v5_admissions(run_id, state);

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_admissions_no_delete
                BEFORE DELETE ON governed_dispatch_v5_admissions
                BEGIN
                    SELECT RAISE(ABORT, 'governed V5 dispatch admissions are tape-backed: DELETE forbidden');
                END;

            CREATE TRIGGER IF NOT EXISTS governed_dispatch_v5_admissions_seal_only
                BEFORE UPDATE ON governed_dispatch_v5_admissions
                WHEN OLD.state != 'awaiting_checkpoint'
                  OR NEW.state != 'sealed'
                  OR OLD.run_id != NEW.run_id
                  OR OLD.idempotency_key != NEW.idempotency_key
                  OR OLD.workflow_id != NEW.workflow_id
                  OR OLD.workflow_revision != NEW.workflow_revision
                  OR OLD.unit_id != NEW.unit_id
                  OR OLD.attempt != NEW.attempt
                  OR OLD.semantic_identity_digest != NEW.semantic_identity_digest
                  OR OLD.source_dispatch_event_id != NEW.source_dispatch_event_id
                  OR OLD.source_dispatch_event_digest != NEW.source_dispatch_event_digest
                  OR OLD.v5_envelope_digest != NEW.v5_envelope_digest
                  OR OLD.v4_envelope_digest != NEW.v4_envelope_digest
                  OR OLD.v4_graph_declaration_event_id != NEW.v4_graph_declaration_event_id
                  OR OLD.v4_graph_declaration_event_digest != NEW.v4_graph_declaration_event_digest
                  OR OLD.v4_graph_digest != NEW.v4_graph_digest
                  OR OLD.context_manifest_event_id != NEW.context_manifest_event_id
                  OR OLD.context_manifest_event_digest != NEW.context_manifest_event_digest
                  OR OLD.context_manifest_digest != NEW.context_manifest_digest
                  OR OLD.worker_manifest_event_id != NEW.worker_manifest_event_id
                  OR OLD.worker_manifest_event_digest != NEW.worker_manifest_event_digest
                  OR OLD.worker_manifest_digest != NEW.worker_manifest_digest
                  OR OLD.sandbox_profile_event_id != NEW.sandbox_profile_event_id
                  OR OLD.sandbox_profile_event_digest != NEW.sandbox_profile_event_digest
                  OR OLD.sandbox_profile_digest != NEW.sandbox_profile_digest
                  OR OLD.retry_context_event_id IS NOT NEW.retry_context_event_id
                  OR OLD.retry_context_event_digest IS NOT NEW.retry_context_event_digest
                  OR OLD.retry_context_digest IS NOT NEW.retry_context_digest
                  OR OLD.witness_evidence_digest != NEW.witness_evidence_digest
                  OR OLD.ledger_authority_realm_digest != NEW.ledger_authority_realm_digest
                  OR OLD.admission_event_id != NEW.admission_event_id
                  OR OLD.admission_event_digest != NEW.admission_event_digest
                  OR OLD.created_at != NEW.created_at
                BEGIN
                    SELECT RAISE(ABORT, 'governed V5 dispatch admissions permit only one checkpoint-seal transition');
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
        ensure_governed_dispatch_admission_identity_guard_v2(conn)?;
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
    /// (b) Reject caller-supplied protected-host V5 admission receipts. They
    ///     are minted only by [`Self::record_governed_dispatch_v5_admission_v1`]
    ///     after it re-derives raw signed V5 witness evidence; allowing the
    ///     generic path to append one could poison receipt reconciliation.
    /// (c) Per-run strictly-monotonic ordinary-event id: reject an ordinary
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
        if matches!(
            event.kind,
            EventKind::GovernedDispatchV5AdmissionRecordedV1
                | EventKind::PromotionReconciliationResolved
        ) {
            return Err(LedgerError::CallerSuppliedTrustSpineEvent {
                kind: event.kind.as_wire().to_string(),
            });
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
                | EventKind::DispatchEnvelopeV5
                | EventKind::ContextManifestDeclaredV1
                | EventKind::WorkerManifestDeclaredV1
                | EventKind::SandboxProfileDeclaredV1
                | EventKind::AttemptContextDeclaredV1
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
        authority: &GovernedPromotionAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        require_candidate_completion_event_projection(
            &tx,
            request,
            Some(expected_completion_event_id),
        )?;
        // Candidate proof creation and its response-gating checkpoint use
        // separate commits. Reconstruct the V4 singleton closure again while
        // this transaction owns the run writer lock so a raw or semantically
        // competing tail cannot enter between those two boundaries.
        verify_governed_candidate_completion_evidence(
            &tx,
            request,
            authority,
            signing_key,
            signer,
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
        for (event, signature) in checkpoint_events_for_run_for_connection(conn, run_id)? {
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

    /// Resolve the one candidate-create identity that a sealed-V3 governed
    /// retry may use. This is deliberately read-only: a later action-request
    /// issuer and activity-claim operation must each re-verify their own
    /// boundaries before a Git effect can begin.
    ///
    /// The candidate ref is validated before any tape lookup, then its run and
    /// retry-attempt segments are bound to the signed dispatch. Candidate ID
    /// remains a canonical safe target until the dispatch schema carries an
    /// immutable candidate binding. No mutable workspace state,
    /// caller-supplied namespace, action id, or idempotency key participates
    /// in the result.
    pub fn resolve_governed_v3_retry_candidate_action_identity_v1(
        &self,
        request: &ResolveGovernedV3RetryCandidateActionIdentityRequestV1,
        authority: &ActivityClaimAuthorityV1,
    ) -> Result<ResolvedGovernedV3RetryCandidateActionIdentityV1> {
        let candidate_suffix = canonical_buildplane_candidate_ref_suffix(&request.candidate_ref)
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed retry candidate identity requires a canonical Buildplane candidate ref"
                    .into(),
            })?;

        let dispatch_event = load_verified_authority_event(
            &self.conn,
            request.dispatch_event_id,
            &authority.trusted_keys,
            &authority.dispatch_signer,
            "governed retry candidate identity dispatch",
        )?;
        if dispatch_event.run_id != request.run_id {
            return governed_retry_candidate_identity_rejected(
                "governed retry candidate identity dispatch run_id does not match the request",
            );
        }
        let dispatch = match (&dispatch_event.kind, &dispatch_event.payload) {
            (EventKind::DispatchEnvelopeV3, Payload::DispatchEnvelopeV3(dispatch)) => dispatch,
            (EventKind::DispatchEnvelopeV4, Payload::DispatchEnvelopeV4(_)) => {
                return governed_retry_candidate_identity_rejected(
                    "governed retry candidate identity supports only outer sealed-V3 dispatch envelopes; graph-bound V4 retries remain rejected",
                );
            }
            (EventKind::DispatchEnvelopeV5, Payload::DispatchEnvelopeV5(_)) => {
                return governed_retry_candidate_identity_rejected(
                    "governed retry candidate identity supports only outer sealed-V3 dispatch envelopes; manifest-bound V5 retries remain rejected",
                );
            }
            _ => {
                return governed_retry_candidate_identity_rejected(
                    "governed retry candidate identity dispatch is not a sealed-V3 dispatch envelope",
                );
            }
        };
        if dispatch.body.attempt <= 1 {
            return governed_retry_candidate_identity_rejected(
                "governed retry candidate identity requires a dispatch attempt greater than one",
            );
        }
        let configured_realm = authority
            .ledger_authority_realm_digest
            .as_deref()
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed retry candidate identity requires a configured protected activity authority realm"
                    .into(),
            })?;
        let retry_authority = GovernedPromotionAuthorityV1 {
            trusted_keys: authority.trusted_keys.clone(),
            kernel_signer: authority.dispatch_signer.clone(),
            reviewer_signers: Vec::new(),
            operator_signer: authority.claim_signer.clone(),
            ledger_authority_realm_digest: configured_realm.into(),
        };
        validate_static_governed_candidate_completion_dispatch(dispatch, &retry_authority).map_err(
            |error| LedgerError::ActivityClaimAuthorityRejected {
                reason: format!(
                    "governed retry candidate identity dispatch is outside the configured sealed-V3 realm: {error}"
                ),
            },
        )?;
        if !candidate_ref_suffix_binds_run_and_attempt(
            candidate_suffix,
            request.run_id,
            dispatch.body.attempt,
        ) {
            return governed_retry_candidate_identity_rejected(
                "governed retry candidate identity candidate_ref must bind the signed run and attempt",
            );
        }
        let retry_context = verify_governed_sealed_v3_retry_context(
            &self.conn,
            request.run_id,
            &retry_authority,
            &dispatch_event,
            dispatch,
        )
        .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
            reason: format!(
                "governed retry candidate identity cannot resolve its signed retry context: {error}"
            ),
        })?;
        let (action_id, Some(idempotency_key)) = candidate_create_action_identity_for_suffix(
            candidate_suffix,
            Some(&retry_context.retry_action_namespace),
        ) else {
            unreachable!("a verified retry context always derives an idempotency key")
        };

        Ok(ResolvedGovernedV3RetryCandidateActionIdentityV1 {
            activity_id: action_id.clone(),
            action_id,
            idempotency_key,
        })
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
        self.claim_activity_v1_at_with_evidence_authority(
            request,
            authority,
            signing_key,
            signer,
            now,
            purpose,
            ActivityClaimEvidenceAuthorityV1::V3OrV4,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn claim_activity_v1_at_with_evidence_authority(
        &self,
        request: &ActivityClaimRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
        purpose: ActivityClaimPurposeV1,
        evidence_authority: ActivityClaimEvidenceAuthorityV1<'_>,
    ) -> Result<ActivityClaimDispositionV1> {
        validate_activity_claim_request(request)?;
        validate_claim_signer(authority, signing_key, signer)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let sealed_v5_material = match evidence_authority {
            ActivityClaimEvidenceAuthorityV1::V3OrV4 => None,
            ActivityClaimEvidenceAuthorityV1::SealedV5 {
                admission_event_id,
                authority: v5_authority,
            } => Some(verified_sealed_v5_dispatch_action_material(
                &tx,
                request.run_id,
                request.dispatch_event_id,
                admission_event_id,
                v5_authority,
                authority,
            )?),
        };

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

        let evidence = match sealed_v5_material {
            Some(dispatch_material) => {
                let dispatch_event = load_verified_authority_event(
                    &tx,
                    request.dispatch_event_id,
                    &authority.trusted_keys,
                    &authority.dispatch_signer,
                    "sealed V5 claim dispatch",
                )?;
                verify_claim_evidence_from_dispatch_material(
                    &tx,
                    request,
                    authority,
                    now,
                    &dispatch_event,
                    dispatch_material,
                )?
            }
            None => verify_claim_evidence(&tx, request, authority, now)?,
        };
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

    /// Reconstruct and lease one governed process action through the protected
    /// command authority. Executable bytes are loaded from the exact strict
    /// CAS object named by the signed action, converted into replay-bound
    /// intent evidence, and retained in memory before the claim transaction.
    /// The claim transaction then independently reopens the signed
    /// dispatch/action chain and current authority window.
    ///
    /// Only the first durable grant receives the executable evidence and
    /// opaque lease. Replays return status without either value, preventing a
    /// second host process from acquiring the same effect capability.
    pub fn authorize_and_claim_governed_command_action_v1(
        &self,
        request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        self.authorize_and_claim_governed_command_action_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn authorize_and_claim_governed_command_action_v1_at_for_tests(
        &self,
        request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        self.authorize_and_claim_governed_command_action_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            now,
        )
    }

    fn authorize_and_claim_governed_command_action_v1_at(
        &self,
        request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        require_protected_governed_realm(authority)?;
        validate_claim_signer(authority, signing_key, signer)?;
        if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&request.lease_duration_ms) {
            return Err(command_action_authority_rejected(format!(
                "lease_duration_ms must be in {MIN_ACTIVITY_LEASE_MS}..={MAX_ACTIVITY_LEASE_MS}",
            )));
        }

        let (claim, command_intent) =
            reconstruct_governed_command_action(&self.conn, request, cas, authority, now)?;
        let disposition = self.claim_activity_v1_at(
            &claim,
            authority,
            signing_key,
            signer,
            now,
            ActivityClaimPurposeV1::GovernedCommandActionV1,
        )?;
        Ok(governed_command_claim_disposition(
            disposition,
            command_intent,
        ))
    }

    /// Reconstruct and lease one manifest-bound V5 process action. Both the
    /// read-only reconstruction and the durable claim transaction independently
    /// reopen the sealed admission proof; neither accepts the nested V3/V4
    /// envelope as standalone effect authority.
    pub fn authorize_and_claim_governed_v5_command_action_v1(
        &self,
        request: &GovernedV5CommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        self.authorize_and_claim_governed_v5_command_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_and_claim_governed_v5_command_action_v1_at_for_tests(
        &self,
        request: &GovernedV5CommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        self.authorize_and_claim_governed_v5_command_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn authorize_and_claim_governed_v5_command_action_v1_at(
        &self,
        request: &GovernedV5CommandActionAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionAuthorizeAndClaimDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_claim_signer(activity_authority, signing_key, signer)?;
        if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&request.lease_duration_ms) {
            return Err(command_action_authority_rejected(format!(
                "lease_duration_ms must be in {MIN_ACTIVITY_LEASE_MS}..={MAX_ACTIVITY_LEASE_MS}",
            )));
        }
        let base_request = GovernedCommandActionAuthorizeAndClaimRequestV1 {
            run_id: request.run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms: request.lease_duration_ms,
        };
        let (claim, command_intent) = reconstruct_governed_v5_command_action(
            &self.conn,
            &base_request,
            request.admission_event_id,
            cas,
            v5_authority,
            activity_authority,
            now,
        )?;
        let disposition = self.claim_activity_v1_at_with_evidence_authority(
            &claim,
            activity_authority,
            signing_key,
            signer,
            now,
            ActivityClaimPurposeV1::GovernedCommandActionV1,
            ActivityClaimEvidenceAuthorityV1::SealedV5 {
                admission_event_id: request.admission_event_id,
                authority: v5_authority,
            },
        )?;
        Ok(governed_command_claim_disposition(
            disposition,
            command_intent,
        ))
    }

    /// Reconstruct and lease the Git activity that finalizes one immutable V5
    /// candidate. Generic claim entry points cannot mint this purpose, and an
    /// exact retry never receives the original opaque lease again.
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_and_claim_governed_v5_candidate_finalize_v1(
        &self,
        request: &GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityClaimDispositionV1> {
        self.authorize_and_claim_governed_v5_candidate_finalize_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_and_claim_governed_v5_candidate_finalize_v1_at_for_tests(
        &self,
        request: &GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityClaimDispositionV1> {
        self.authorize_and_claim_governed_v5_candidate_finalize_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn authorize_and_claim_governed_v5_candidate_finalize_v1_at(
        &self,
        request: &GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityClaimDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_claim_signer(activity_authority, signing_key, signer)?;
        if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&request.lease_duration_ms) {
            return Err(command_action_authority_rejected(format!(
                "lease_duration_ms must be in {MIN_ACTIVITY_LEASE_MS}..={MAX_ACTIVITY_LEASE_MS}",
            )));
        }
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)?;
        let action_event = load_verified_authority_event(
            &tx,
            request.action_request_event_id,
            &activity_authority.trusted_keys,
            &activity_authority.action_request_signer,
            "V5 candidate finalization action",
        )?;
        if action_event.run_id != request.run_id
            || action_event.parent_event_id != Some(request.dispatch_event_id)
        {
            return Err(command_action_authority_rejected(
                "candidate finalization action does not bind the requested run and dispatch",
            ));
        }
        let Payload::ActionRequestedV2(action) = &action_event.payload else {
            return Err(command_action_authority_rejected(
                "candidate finalization lease requires ActionRequestedV2",
            ));
        };
        let action = action.clone();
        if action.action_kind != ActionKindV1::Git
            || action.execution_role != ExecutionRoleV1::Implementer
        {
            return Err(command_action_authority_rejected(
                "candidate finalization lease requires an implementer Git action",
            ));
        }
        let material = verified_sealed_v5_dispatch_action_material(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            request.admission_event_id,
            v5_authority,
            activity_authority,
        )?;
        let bytes = cas.get_verified_canonical_bytes(
            &action.canonical_input_ref,
            &action.canonical_input_digest,
        )?;
        let input: GovernedV5CandidateFinalizeInputV1 =
            serde_json::from_slice(&bytes).map_err(|error| {
                command_action_authority_rejected(format!(
                    "candidate finalization CAS input is invalid: {error}",
                ))
            })?;
        let canonical = serde_json::to_vec(&input).map_err(|error| {
            command_action_authority_rejected(format!(
                "candidate finalization CAS input cannot be canonicalized: {error}",
            ))
        })?;
        let dispatch_envelope_digest = material.lineage_envelope_digest.clone();
        let dispatch = material.dispatch;
        let candidate_suffix = input
            .candidate_ref
            .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
            .ok_or_else(|| {
                command_action_authority_rejected(
                    "candidate finalization input has a non-Buildplane ref",
                )
            })?;
        let expected_action_id = format!("{RETRY_CANDIDATE_ACTION_KIND}:{candidate_suffix}");
        if canonical != bytes
            || input.schema_version != 1
            || input.action != "create-immutable-candidate"
            || input.run_id != request.run_id.to_string()
            || input.attempt != dispatch.body.attempt
            || input.candidate_key != candidate_suffix
            || input.candidate_ref
                != format!("{BUILDPANE_CANDIDATE_REF_PREFIX}{}", input.candidate_key)
            || input.candidate_key
                != format!(
                    "{}/{}/{}",
                    input.candidate_id, request.run_id, dispatch.body.attempt
                )
            || input.base_sha != dispatch.body.base_commit_sha
            || action.action_id != expected_action_id
            || action.idempotency_key
                != format!(
                    "{}:{RETRY_CANDIDATE_ACTION_KIND}",
                    dispatch.body.idempotency_key
                )
            || action.dispatch_envelope_digest != dispatch_envelope_digest
        {
            return Err(command_action_authority_rejected(
                "candidate finalization action or CAS input was substituted",
            ));
        }
        let claim = ActivityClaimRequestV1 {
            run_id: request.run_id,
            activity_id: action.action_id.clone(),
            idempotency_key: action.idempotency_key.clone(),
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms: request.lease_duration_ms,
        };
        tx.commit()?;
        self.claim_activity_v1_at_with_evidence_authority(
            &claim,
            activity_authority,
            signing_key,
            signer,
            now,
            ActivityClaimPurposeV1::GovernedCandidateFinalizeV1,
            ActivityClaimEvidenceAuthorityV1::SealedV5 {
                admission_event_id: request.admission_event_id,
                authority: v5_authority,
            },
        )
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
            ModelActionIntentAuthorityLane::Implementer,
            clock,
        )?;
        tx.commit()?;
        if let Some(event) = issued.appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        Ok(issued.into_public_disposition())
    }

    pub fn issue_provider_token_preflight_action_v1(
        &self,
        request: &ProviderTokenPreflightActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ProviderTokenPreflightActionIssueDispositionV1> {
        self.issue_provider_token_preflight_action_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn issue_provider_token_preflight_action_v1_at_for_tests(
        &self,
        request: &ProviderTokenPreflightActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ProviderTokenPreflightActionIssueDispositionV1> {
        self.issue_provider_token_preflight_action_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            now,
        )
    }

    fn issue_provider_token_preflight_action_v1_at(
        &self,
        request: &ProviderTokenPreflightActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ProviderTokenPreflightActionIssueDispositionV1> {
        require_protected_model_intent_realm(authority)?;
        validate_action_request_signer(authority, signing_key, signer)?;
        let now = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let issue = ModelActionIntentIssueRequestV1 {
            run_id: request.run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.model_action_request_event_id,
        };
        let stored_intent = model_action_intent_by_action_request(
            &tx,
            request.run_id,
            request.model_action_request_event_id,
        )?
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "provider token preflight action requires an existing verified model intent"
                .into(),
        })?;
        let intent = verify_signed_model_action_intent_projection(
            &tx,
            &stored_intent,
            cas,
            authority,
            &issue,
            ModelActionIntentAuthorityLane::Existing,
        )?;
        let model_request_bytes = cas.get_verified_canonical_bytes(
            &intent.model_request_evidence.cas_ref,
            &intent.model_request_evidence.digest,
        )?;
        let model_request = parse_verified_model_request_evidence_document_v1(
            &model_request_bytes,
            &intent.model_request_evidence,
        )?;
        let trust_scope_bytes = cas.get_verified_canonical_bytes(
            &intent.trust_scope_evidence.cas_ref,
            &intent.trust_scope_evidence.digest,
        )?;
        let trust_scope = parse_verified_trust_scope_evidence_document_v1(
            &trust_scope_bytes,
            &intent.trust_scope_evidence,
        )?;
        verify_trust_scope_evidence_matches_model_request(trust_scope.document(), &model_request)?;
        let dispatch_event = load_verified_authority_event(
            &tx,
            request.dispatch_event_id,
            &authority.trusted_keys,
            &authority.dispatch_signer,
            "provider token preflight dispatch",
        )?;
        if dispatch_event.run_id != request.run_id {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight dispatch belongs to another run".into(),
            });
        }
        let dispatch = dispatch_authority_material(&dispatch_event.payload)
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires a governed dispatch envelope".into(),
            })?
            .dispatch;
        validate_governed_dispatch(&dispatch, now)?;
        let max_total_tokens = dispatch
            .body
            .budget
            .max_tokens
            .and_then(|tokens| u32::try_from(tokens).ok())
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires a signed u32 total-token budget".into(),
            })?;
        let preflight_input = ProviderTokenPreflightInputV1::from_verified_model_request(
            &model_request,
            max_total_tokens,
        )?;
        let input_bytes = provider_token_preflight_input_v1_bytes(&preflight_input)?;
        let input_ref = cas.put_canonical_bytes(&input_bytes)?;
        let verified_input = parse_verified_provider_token_preflight_input_v1(
            &input_bytes,
            &input_ref.to_cas_ref(),
            input_ref.digest(),
            &model_request,
        )?;

        let model_action_event = load_verified_authority_event(
            &tx,
            request.model_action_request_event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "provider token preflight model action",
        )?;
        let Payload::ActionRequestedV2(mut preflight_action) = model_action_event.payload else {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires a model action_requested_v2 event"
                    .into(),
            });
        };
        preflight_action.action_id = format!("{}:provider-token-preflight", intent.action_id);
        preflight_action.idempotency_key = preflight_action.action_id.clone();
        preflight_action.action_kind = ActionKindV1::Network;
        preflight_action.canonical_input_ref = input_ref.to_cas_ref();
        preflight_action.canonical_input_digest = input_ref.digest().into();
        preflight_action.requested_at = timestamp(now);

        let mut statement =
            tx.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
        let ids = statement
            .query_map(
                params![
                    request.run_id.to_string(),
                    EventKind::ActionRequestedV2.as_wire()
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut existing = None;
        for id in ids {
            let event_id = parse_event_id(&id, "provider token preflight action")?;
            let event = load_verified_authority_event(
                &tx,
                event_id,
                &authority.trusted_keys,
                &authority.action_request_signer,
                "provider token preflight action",
            )?;
            let Payload::ActionRequestedV2(action) = &event.payload else {
                unreachable!("action-request query returns only action_requested_v2 events")
            };
            let action = action.clone();
            if action.action_id != preflight_action.action_id {
                continue;
            }
            if existing.replace((event, action)).is_some() {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "provider token preflight has duplicate signed action requests".into(),
                });
            }
        }
        if let Some((event, action)) = existing {
            let mut expected = preflight_action;
            expected.requested_at = action.requested_at.clone();
            if event.parent_event_id != Some(request.dispatch_event_id)
                || event.occurred_at != parse_claim_timestamp(&action.requested_at)?
                || action != expected
            {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason:
                        "existing provider token preflight action conflicts with verified evidence"
                            .into(),
                });
            }
            tx.commit()?;
            return Ok(ProviderTokenPreflightActionIssueDispositionV1::Existing {
                action_request_event_id: event.id,
                canonical_input_ref: action.canonical_input_ref,
                canonical_input_digest: action.canonical_input_digest,
                verified_input,
                dispatch,
                model_request,
                trust_scope,
                candidate_binding: intent.candidate_binding,
            });
        }

        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(request.dispatch_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionRequestedV2,
            occurred_at: now,
            payload: Payload::ActionRequestedV2(preflight_action.clone()),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, signer, now)?;
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        tx.commit()?;
        self.record_ordinary_append(&event);
        Ok(ProviderTokenPreflightActionIssueDispositionV1::Issued {
            action_request_event_id: event.id,
            canonical_input_ref: preflight_action.canonical_input_ref,
            canonical_input_digest: preflight_action.canonical_input_digest,
            verified_input,
            dispatch,
            model_request,
            trust_scope,
            candidate_binding: intent.candidate_binding,
        })
    }

    /// Locate and verify the token-count activity whose identity is derived
    /// from the signed model intent. The durable claim projection is used only
    /// to find its action event; the complete signed tape/CAS lineage is then
    /// reopened by the exact-record verifier.
    pub fn verify_recorded_provider_token_preflight_for_model_action_v1(
        &self,
        request: &ProviderTokenPreflightForModelActionRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
    ) -> Result<VerifiedProviderTokenPreflightRecordingV1> {
        require_protected_model_intent_realm(authority)?;
        let issue = ModelActionIntentIssueRequestV1 {
            run_id: request.run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.model_action_request_event_id,
        };
        let stored_intent = model_action_intent_by_action_request(
            &self.conn,
            request.run_id,
            request.model_action_request_event_id,
        )?
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "provider token preflight has no verified model intent".into(),
        })?;
        let intent = verify_signed_model_action_intent_projection(
            &self.conn,
            &stored_intent,
            cas,
            authority,
            &issue,
            ModelActionIntentAuthorityLane::Existing,
        )?;
        let expected_action_id = format!("{}:provider-token-preflight", intent.action_id);
        let claim = activity_claim_by_activity_id(&self.conn, request.run_id, &expected_action_id)?
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight has no derived activity claim".into(),
            })?;
        self.verify_recorded_provider_token_preflight_v1(
            &ProviderTokenPreflightRecordingRequestV1 {
                run_id: request.run_id,
                dispatch_event_id: request.dispatch_event_id,
                model_action_request_event_id: request.model_action_request_event_id,
                preflight_action_request_event_id: claim.action_request_event_id,
            },
            cas,
            authority,
        )
    }

    /// Reconstruct a completed provider token-count activity without issuing
    /// new authority. A caller can name tape records, but cannot supply token
    /// counts, provider/model settings, CAS descriptors, or action identity.
    pub fn verify_recorded_provider_token_preflight_v1(
        &self,
        request: &ProviderTokenPreflightRecordingRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
    ) -> Result<VerifiedProviderTokenPreflightRecordingV1> {
        require_protected_model_intent_realm(authority)?;
        if request.model_action_request_event_id == request.preflight_action_request_event_id {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight must be a distinct recorded network action"
                    .into(),
            });
        }
        let issue = ModelActionIntentIssueRequestV1 {
            run_id: request.run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.model_action_request_event_id,
        };
        let stored_intent = model_action_intent_by_action_request(
            &self.conn,
            request.run_id,
            request.model_action_request_event_id,
        )?
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "provider token preflight has no verified model intent".into(),
        })?;
        let intent = verify_signed_model_action_intent_projection(
            &self.conn,
            &stored_intent,
            cas,
            authority,
            &issue,
            ModelActionIntentAuthorityLane::Existing,
        )?;
        let model_request_bytes = cas.get_verified_canonical_bytes(
            &intent.model_request_evidence.cas_ref,
            &intent.model_request_evidence.digest,
        )?;
        let model_request = parse_verified_model_request_evidence_document_v1(
            &model_request_bytes,
            &intent.model_request_evidence,
        )?;
        let trust_scope_bytes = cas.get_verified_canonical_bytes(
            &intent.trust_scope_evidence.cas_ref,
            &intent.trust_scope_evidence.digest,
        )?;
        let trust_scope = parse_verified_trust_scope_evidence_document_v1(
            &trust_scope_bytes,
            &intent.trust_scope_evidence,
        )?;
        verify_trust_scope_evidence_matches_model_request(trust_scope.document(), &model_request)?;

        let dispatch_event = load_verified_authority_event(
            &self.conn,
            request.dispatch_event_id,
            &authority.trusted_keys,
            &authority.dispatch_signer,
            "provider token preflight dispatch",
        )?;
        if dispatch_event.run_id != request.run_id {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight dispatch belongs to another run".into(),
            });
        }
        let dispatch = dispatch_authority_material(&dispatch_event.payload)
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires a governed dispatch envelope".into(),
            })?
            .dispatch;
        let max_total_tokens = dispatch
            .body
            .budget
            .max_tokens
            .and_then(|tokens| u32::try_from(tokens).ok())
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires a signed u32 total-token budget".into(),
            })?;

        let action_event = load_verified_authority_event(
            &self.conn,
            request.preflight_action_request_event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "provider token preflight action request",
        )?;
        if action_event.run_id != request.run_id
            || action_event.parent_event_id != Some(request.dispatch_event_id)
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight action does not bind the signed dispatch".into(),
            });
        }
        let Payload::ActionRequestedV2(preflight_action) = action_event.payload else {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight requires an action_requested_v2 event".into(),
            });
        };
        let expected_action_id = format!("{}:provider-token-preflight", intent.action_id);
        if preflight_action.action_id != expected_action_id
            || preflight_action.idempotency_key != expected_action_id
            || preflight_action.action_kind != ActionKindV1::Network
            || preflight_action.execution_role != model_request.document().binding.execution_role
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight action identity, kind, or role is not derived from the model intent".into(),
            });
        }
        let input_bytes = cas.get_verified_canonical_bytes(
            &preflight_action.canonical_input_ref,
            &preflight_action.canonical_input_digest,
        )?;
        let input = parse_verified_provider_token_preflight_input_v1(
            &input_bytes,
            &preflight_action.canonical_input_ref,
            &preflight_action.canonical_input_digest,
            &model_request,
        )?;
        if input.document().max_total_tokens != max_total_tokens {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason:
                    "provider token preflight input does not equal the signed total-token budget"
                        .into(),
            });
        }

        let claim = activity_claim_by_activity_id(&self.conn, request.run_id, &expected_action_id)?
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight has no signed activity claim".into(),
            })?;
        let signed_claim = verify_signed_claim_projection(&self.conn, &claim, authority)?;
        let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
        let claim_request = ActivityClaimRequestV1 {
            run_id: claim.run_id,
            activity_id: claim.activity_id.clone(),
            idempotency_key: claim.idempotency_key.clone(),
            dispatch_event_id: claim.dispatch_event_id,
            action_request_event_id: claim.action_request_event_id,
            lease_duration_ms: claim.lease_duration_ms,
        };
        let claim_evidence =
            verify_claim_evidence(&self.conn, &claim_request, authority, claimed_at)?;
        if signed_claim.purpose != ActivityClaimPurposeV1::Generic
            || claim.action_kind != ActionKindV1::Network
            || claim_evidence.action_kind != claim.action_kind
            || claim_evidence.action_request_digest != claim.action_request_digest
            || claim_evidence.dispatch_envelope_digest != claim.dispatch_envelope_digest
            || claim.action_request_event_id != request.preflight_action_request_event_id
            || claim.dispatch_event_id != request.dispatch_event_id
            || claim.activity_id != expected_action_id
            || claim.idempotency_key != expected_action_id
            || claim.state != StoredActivityClaimState::Recorded
            || claim.result_outcome != Some(ActivityResultOutcomeV1::Succeeded)
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "provider token preflight claim/result projection is not the exact successful network activity".into(),
            });
        }
        verify_signed_activity_result_projection(&self.conn, &claim, authority)?;
        let result_ref = required_claim_string(claim.result_ref.as_deref(), "result_ref")?;
        let result_digest = required_claim_string(claim.result_digest.as_deref(), "result_digest")?;
        let result_bytes = cas.get_verified_canonical_bytes(&result_ref, &result_digest)?;
        let result = parse_verified_provider_token_preflight_result_v1(
            &result_bytes,
            &result_ref,
            &result_digest,
            &input,
        )?;
        Ok(VerifiedProviderTokenPreflightRecordingV1 {
            input,
            result,
            dispatch,
            model_request,
            trust_scope,
            candidate_binding: intent.candidate_binding,
        })
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
            ModelActionIntentAuthorityLane::Implementer,
            &mut clock,
        )
    }

    /// Authorize a review-like provider action only from a pre-existing,
    /// kernel-signed candidate-bound intent. Unlike the implementer lane this
    /// operation never creates an intent from caller-supplied request fields.
    pub fn authorize_and_claim_governed_reviewer_model_action_v1(
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
            ModelActionIntentAuthorityLane::Reviewer,
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
            ModelActionIntentAuthorityLane::Implementer,
            &mut clock,
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn authorize_and_claim_governed_reviewer_model_action_v1_at_for_tests(
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
            ModelActionIntentAuthorityLane::Reviewer,
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
        lane: ModelActionIntentAuthorityLane,
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
                &tx, &existing, request, cas, authority, lane, clock,
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
            lane,
            clock,
        )?;

        // Re-read signed dispatch/action evidence after CAS work and before
        // signing either authorization record. This prevents an expired or
        // changed admission window from being backdated through a slow CAS
        // operation, while an already-recorded authorization above remains
        // recoverable after expiry.
        let now = canonical_ledger_timestamp(clock())?;
        let evidence =
            verify_model_action_intent_issue_evidence(&tx, &issue_request, authority, lane, now)?;
        if !model_action_intent_matches_issue_evidence(
            &issued_intent.intent,
            &issue_request,
            &evidence,
            lane,
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
        if request.outcome == ActivityResultOutcomeV1::Succeeded {
            let result_digest = request.result_digest.as_deref().ok_or_else(|| {
                LedgerError::ActivityClaimAuthorityRejected {
                    reason: "successful governed model result is missing its result digest".into(),
                }
            })?;
            let result_ref = request.result_ref.as_deref().ok_or_else(|| {
                LedgerError::ActivityClaimAuthorityRejected {
                    reason: "successful governed model result is missing its result reference"
                        .into(),
                }
            })?;
            let evidence_bytes =
                cas.get_verified_canonical_bytes(&request.evidence_ref, &request.evidence_digest)?;
            let evidence = parse_verified_model_result_evidence_document_v1(
                &evidence_bytes,
                &request.evidence_ref,
                &request.evidence_digest,
            )?;
            let model_request_bytes = cas.get_verified_canonical_bytes(
                &verified.intent.model_request_evidence.cas_ref,
                &verified.intent.model_request_evidence.digest,
            )?;
            let model_request = parse_verified_model_request_evidence_document_v1(
                &model_request_bytes,
                &verified.intent.model_request_evidence,
            )?;
            let result_bytes = cas.get_verified_canonical_bytes(result_ref, result_digest)?;
            let result = parse_verified_model_provider_result_document_v1(
                &result_bytes,
                result_ref,
                result_digest,
            )?;
            let expected_provider_request_id = format!(
                "{}:{}",
                match model_request
                    .document()
                    .normalized_provider_request
                    .provider
                {
                    ModelProviderV1::Anthropic => "anthropic",
                    ModelProviderV1::Openai => "openai",
                },
                verified.intent.action_id
            );
            let expected_candidate_digest = verified
                .intent
                .candidate_binding
                .as_ref()
                .map(|candidate| candidate.candidate_digest.as_str());
            let result = result.document();
            if result.action_id != verified.intent.action_id
                || result.provider_request_id != expected_provider_request_id
                || result.model_request_digest != model_request.document().model_request_digest
                || result.execution_role != model_request.document().binding.execution_role
                || result.candidate_digest.as_deref() != expected_candidate_digest
                || result.worker_manifest_digest
                    != model_request.document().binding.worker_manifest_digest
            {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "successful governed model result does not bind the exact signed role, candidate, worker, request, and provider route".into(),
                });
            }
            let evidence = evidence.document();
            if evidence.action_id != verified.intent.action_id
                || evidence.action_request_ref
                    != verified.intent.action_request_event_ref.to_string()
                || evidence.action_request_digest != verified.intent.action_request_digest
                || evidence.model_request_digest != model_request.document().model_request_digest
                || evidence.authorization_ref != verified.authorization.authorization_ref
                || evidence.authorization_digest != verified.authorization.authorization_digest
                || evidence.result_ref != result_ref
                || evidence.result_digest != result_digest
            {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "successful governed model evidence does not bind the exact signed action, authorization, model request, and result".into(),
                });
            }
        } else if request.outcome == ActivityResultOutcomeV1::Unknown {
            let evidence_bytes =
                cas.get_verified_canonical_bytes(&request.evidence_ref, &request.evidence_digest)?;
            let evidence = parse_verified_model_provider_unknown_evidence_document_v1(
                &evidence_bytes,
                &request.evidence_ref,
                &request.evidence_digest,
            )?;
            let model_request_bytes = cas.get_verified_canonical_bytes(
                &verified.intent.model_request_evidence.cas_ref,
                &verified.intent.model_request_evidence.digest,
            )?;
            let model_request = parse_verified_model_request_evidence_document_v1(
                &model_request_bytes,
                &verified.intent.model_request_evidence,
            )?;
            let expected_provider_request_id = format!(
                "{}:{}",
                match model_request
                    .document()
                    .normalized_provider_request
                    .provider
                {
                    ModelProviderV1::Anthropic => "anthropic",
                    ModelProviderV1::Openai => "openai",
                },
                verified.intent.action_id
            );
            let evidence = evidence.document();
            if request.result_digest.is_some()
                || request.result_ref.is_some()
                || evidence.action_id != verified.intent.action_id
                || evidence.provider_request_id != expected_provider_request_id
                || evidence.model_request_digest != model_request.document().model_request_digest
                || evidence.authorization_ref != verified.authorization.authorization_ref
                || evidence.authorization_digest != verified.authorization.authorization_digest
            {
                return Err(LedgerError::ActivityClaimAuthorityRejected {
                    reason: "unknown governed model evidence does not bind the exact signed action, authorization, model request, and provider route".into(),
                });
            }
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

    /// Record one immutable, non-authoritative observation shadow for a
    /// manifest-bound V5 dispatch.
    ///
    /// This method intentionally does not share the V3 admission or any live
    /// authority path. It re-verifies the V5 event plus its graph and manifest
    /// witnesses from the signed tape, then writes an audit projection only.
    /// In particular, it neither signs an event nor emits a checkpoint, so a
    /// successful result cannot be replayed as dispatch, claim, candidate, or
    /// promotion authority.
    pub fn observe_governed_dispatch_v5_admission_v1(
        &self,
        request: &GovernedDispatchV5ObservationRequestV1,
        authority: &GovernedDispatchAdmissionAuthorityV1,
    ) -> Result<GovernedDispatchV5ObservationDispositionV1> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let evidence = v5_observation_proof::verify_observation_evidence_in_tx(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            authority,
        )?;

        if let Some(stored) = governed_dispatch_v5_observation_by_event(
            &tx,
            request.run_id,
            request.dispatch_event_id,
        )? {
            if !stored.matches(&evidence) {
                return governed_dispatch_admission_authority_rejected(
                    "stored V5 observation does not exactly match its re-verified tape witnesses",
                );
            }
            tx.commit()?;
            return Ok(GovernedDispatchV5ObservationDispositionV1::Existing {
                dispatch_event_id: evidence.dispatch_event_id,
                dispatch_event_digest: evidence.dispatch_event_digest,
                v5_envelope_digest: evidence.v5_envelope_digest,
            });
        }

        for collision in [
            governed_dispatch_v5_observation_by_idempotency(
                &tx,
                request.run_id,
                &evidence.idempotency_key,
            )?,
            governed_dispatch_v5_observation_by_workflow_attempt(
                &tx,
                request.run_id,
                &evidence.workflow_id,
                &evidence.unit_id,
                evidence.attempt,
            )?,
            governed_dispatch_v5_observation_by_semantic_identity(
                &tx,
                request.run_id,
                &evidence.semantic_identity_digest,
            )?,
        ] {
            if let Some(stored) = collision {
                if !stored.matches(&evidence) {
                    return governed_dispatch_admission_authority_rejected(
                        "V5 observation identity is already bound to different immutable tape evidence",
                    );
                }
                return governed_dispatch_admission_authority_rejected(
                    "V5 observation idempotency resolution did not find the exact dispatch event",
                );
            }
        }

        insert_governed_dispatch_v5_observation(&tx, &evidence)?;
        tx.commit()?;
        Ok(GovernedDispatchV5ObservationDispositionV1::Observed {
            dispatch_event_id: evidence.dispatch_event_id,
            dispatch_event_digest: evidence.dispatch_event_digest,
            v5_envelope_digest: evidence.v5_envelope_digest,
        })
    }

    /// Resolve the sole already-signed V5 source dispatch named by its
    /// canonical envelope digest.
    ///
    /// This is an observation-only helper for the protected admission host.
    /// It never accepts an event ID from the caller and never appends. The
    /// subsequent admission transaction still re-verifies the returned event
    /// and all of its graph/manifest witnesses under the same authority.
    pub fn resolve_unique_governed_dispatch_v5_source_by_digest_v1(
        &self,
        run_id: RunId,
        v5_envelope_digest: &str,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
    ) -> Result<EventId> {
        if !is_canonical_sha256_digest(v5_envelope_digest) {
            return Err(governed_dispatch_v5_admission_reconciliation_required(
                run_id,
                "unresolved",
                "V5 source envelope digest is not canonical sha256",
            ));
        }
        let authority_fingerprint =
            governed_dispatch_v5_source_authority_fingerprint_v1(authority)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        require_governed_dispatch_v5_source_scan_schema(&tx, run_id)?;
        let event_high_water =
            governed_dispatch_v5_source_event_high_water(&tx, run_id, v5_envelope_digest)?;
        let mut projection = governed_dispatch_v5_source_scan_projection(
            &tx,
            run_id,
            v5_envelope_digest,
            &authority_fingerprint,
        )?
        .unwrap_or_else(|| {
            StoredGovernedDispatchV5SourceScan::new(
                run_id,
                v5_envelope_digest,
                &authority_fingerprint,
            )
        });
        validate_governed_dispatch_v5_source_scan_projection(
            &tx,
            &projection,
            run_id,
            v5_envelope_digest,
            &authority_fingerprint,
            authority,
        )?;
        if event_high_water < projection.event_cursor_rowid
            || event_high_water < projection.observed_event_high_water_rowid
        {
            return Err(governed_dispatch_v5_admission_reconciliation_required(
                run_id,
                "unresolved",
                "V5 source event high-water regressed below durable scan state",
            ));
        }
        if event_high_water > projection.observed_event_high_water_rowid {
            projection.observed_event_high_water_rowid = event_high_water;
            projection.event_complete_through_rowid = None;
        }

        let mut loaded = bootstrap_governed_dispatch_v5_signature_scan_index(
            &tx,
            &mut projection,
            run_id,
            v5_envelope_digest,
            V5_SOURCE_SCAN_BATCH_LIMIT,
        )?;
        #[cfg(any(test, feature = "test-support"))]
        self.v5_source_candidate_loaded_count
            .set(u64::try_from(loaded).unwrap_or(u64::MAX));
        if projection.event_cursor_rowid == event_high_water {
            projection.event_complete_through_rowid = Some(event_high_water);
        }

        let mut signature_high_water = projection.observed_high_water_rowid;
        if projection.event_complete_through_rowid == Some(event_high_water) {
            signature_high_water = governed_dispatch_v5_source_signature_high_water(
                &tx,
                run_id,
                v5_envelope_digest,
                authority,
            )?;
            if signature_high_water < projection.cursor_signature_rowid
                || signature_high_water < projection.observed_high_water_rowid
            {
                return Err(governed_dispatch_v5_admission_reconciliation_required(
                    run_id,
                    "unresolved",
                    "V5 source signature high-water regressed below durable scan state",
                ));
            }
            if signature_high_water > projection.observed_high_water_rowid {
                projection.observed_high_water_rowid = signature_high_water;
                projection.complete_through_signature_rowid = None;
            }
        }

        let remaining_budget = V5_SOURCE_SCAN_BATCH_LIMIT.saturating_sub(loaded);
        if projection.event_complete_through_rowid == Some(event_high_water)
            && projection.cursor_signature_rowid < signature_high_water
            && remaining_budget > 0
        {
            let source_hash = authority
                .source_dispatch_signer
                .public_key_hash
                .as_deref()
                .ok_or_else(|| {
                    governed_dispatch_v5_admission_reconciliation_required(
                        run_id,
                        "unresolved",
                        "configured V5 source signer has no public key hash",
                    )
                })?;
            let mut statement = tx.prepare(V5_SOURCE_SCAN_QUERY_V1)?;
            let mut rows = statement.query(params![
                run_id.to_string(),
                v5_envelope_digest,
                authority.source_dispatch_signer.actor_id,
                authority.source_dispatch_signer.key_id,
                source_hash,
                projection.cursor_signature_rowid,
                signature_high_water,
                i64::try_from(remaining_budget).unwrap_or(i64::MAX),
            ])?;
            let loaded_before_signature_scan = loaded;
            while let Some(row) = rows.next()? {
                loaded = loaded.saturating_add(1);
                if loaded > V5_SOURCE_SCAN_BATCH_LIMIT {
                    return Err(governed_dispatch_v5_admission_reconciliation_required(
                        run_id,
                        "unresolved",
                        "V5 source scan exceeded its fixed row budget",
                    ));
                }
                let signature_rowid: i64 = row.get(0)?;
                if signature_rowid <= projection.cursor_signature_rowid
                    || signature_rowid > signature_high_water
                {
                    return Err(governed_dispatch_v5_admission_reconciliation_required(
                        run_id,
                        "unresolved",
                        "V5 source scan returned a non-monotonic signature row",
                    ));
                }
                projection.cursor_signature_rowid = signature_rowid;
                #[cfg(any(test, feature = "test-support"))]
                self.v5_source_candidate_loaded_count
                    .set(u64::try_from(loaded).unwrap_or(u64::MAX));

                let event_row = StoredEventRow {
                    id: row.get(1)?,
                    run_id: row.get(2)?,
                    parent_event_id: row.get(3)?,
                    schema_version: row.get(4)?,
                    kind: row.get(5)?,
                    occurred_at: row.get(6)?,
                    payload: row.get(7)?,
                };
                let signature_row = StoredEventSignatureRow {
                    event_id: row.get(8)?,
                    canonical_event_hash: row.get(9)?,
                    actor_id: row.get(10)?,
                    key_id: row.get(11)?,
                    public_key_hash: row.get(12)?,
                    algorithm: row.get(13)?,
                    signature: row.get(14)?,
                    signed_at: row.get(15)?,
                };
                if let Some((event_id, event_digest)) =
                    verified_governed_dispatch_v5_source_scan_candidate(
                        &event_row,
                        &signature_row,
                        run_id,
                        v5_envelope_digest,
                        authority,
                        || {
                            #[cfg(any(test, feature = "test-support"))]
                            self.v5_source_candidate_verification_count.set(
                                self.v5_source_candidate_verification_count
                                    .get()
                                    .saturating_add(1),
                            );
                        },
                    )?
                {
                    match projection.candidate_event_id {
                        None => {
                            projection.candidate_signature_rowid = Some(signature_rowid);
                            projection.candidate_event_id = Some(event_id);
                            projection.candidate_event_digest = Some(event_digest);
                        }
                        Some(existing) if existing == event_id => {}
                        Some(_) => projection.ambiguous = true,
                    }
                }
            }
            if loaded == loaded_before_signature_scan {
                return Err(governed_dispatch_v5_admission_reconciliation_required(
                    run_id,
                    "unresolved",
                    "V5 source scan could not advance to its captured signature high-water",
                ));
            }
        }
        if projection.event_complete_through_rowid == Some(event_high_water)
            && projection.cursor_signature_rowid == signature_high_water
        {
            projection.complete_through_signature_rowid = Some(signature_high_water);
        }
        persist_governed_dispatch_v5_source_scan_projection(&tx, &projection)?;
        let resolved = resolved_governed_dispatch_v5_source_from_projection(
            &tx,
            &projection,
            run_id,
            v5_envelope_digest,
            &authority_fingerprint,
            authority,
            event_high_water,
            signature_high_water,
        );
        tx.commit()?;
        resolved
    }

    /// Reset the resolver instrumentation used by large-run regression tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn reset_v5_source_candidate_verification_count_for_tests(&self) {
        self.v5_source_candidate_verification_count.set(0);
        self.v5_source_candidate_loaded_count.set(0);
    }

    /// Return how many digest-index candidates reached V5 source verification.
    #[cfg(any(test, feature = "test-support"))]
    pub fn v5_source_candidate_verification_count_for_tests(&self) -> u64 {
        self.v5_source_candidate_verification_count.get()
    }

    /// Return how many signer-filtered rows the bounded resolver loaded.
    #[cfg(any(test, feature = "test-support"))]
    pub fn v5_source_candidate_loaded_count_for_tests(&self) -> u64 {
        self.v5_source_candidate_loaded_count.get()
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn v5_source_scan_batch_limit_for_tests(&self) -> usize {
        V5_SOURCE_SCAN_BATCH_LIMIT
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn v5_source_projection_state_for_tests(
        &self,
        run_id: RunId,
        v5_envelope_digest: &str,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
    ) -> Result<Option<(i64, i64, Option<i64>, bool, Option<EventId>)>> {
        let fingerprint = governed_dispatch_v5_source_authority_fingerprint_v1(authority)?;
        Ok(governed_dispatch_v5_source_scan_projection(
            &self.conn,
            run_id,
            v5_envelope_digest,
            &fingerprint,
        )?
        .map(|projection| {
            (
                projection.cursor_signature_rowid,
                projection.observed_high_water_rowid,
                projection.complete_through_signature_rowid,
                projection.ambiguous,
                projection.candidate_event_id,
            )
        }))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn v5_source_scan_query_plan_for_tests(
        &self,
        run_id: RunId,
        v5_envelope_digest: &str,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
    ) -> Result<Vec<String>> {
        let source_hash = authority
            .source_dispatch_signer
            .public_key_hash
            .as_deref()
            .ok_or_else(|| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: "configured V5 source signer has no public key hash".into(),
            })?;
        let mut statement = self
            .conn
            .prepare(&format!("EXPLAIN QUERY PLAN {V5_SOURCE_SCAN_QUERY_V1}"))?;
        let details = statement
            .query_map(
                params![
                    run_id.to_string(),
                    v5_envelope_digest,
                    authority.source_dispatch_signer.actor_id,
                    authority.source_dispatch_signer.key_id,
                    source_hash,
                    0_i64,
                    i64::MAX,
                    i64::try_from(V5_SOURCE_SCAN_BATCH_LIMIT).unwrap_or(i64::MAX),
                ],
                |row| row.get::<_, String>(3),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(details)
    }

    /// Record (or resolve) one separately signed protected-host V5 admission
    /// receipt. The request names only a pre-existing source dispatch; this
    /// immediate transaction re-derives raw V5 graph and manifest witnesses
    /// directly from the signed tape and never reads the observation shadow.
    ///
    /// The returned record is intentionally recovery evidence, not effect
    /// authority. V5 remains denied by `dispatch_authority_material()` until a
    /// later, explicitly reviewed action-plane transition is introduced.
    pub fn record_governed_dispatch_v5_admission_v1(
        &self,
        request: &GovernedDispatchV5AdmissionRequestV1,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
        admission_signing_key: &SigningKey,
        admission_signer: &ActorKeyRef,
    ) -> Result<GovernedDispatchV5AdmissionDispositionV1> {
        validate_governed_dispatch_v5_admission_record_signer(
            authority,
            admission_signing_key,
            admission_signer,
        )?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let evidence = v5_observation_proof::verify_admission_evidence_in_tx(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            authority,
        )?;
        require_complete_governed_dispatch_v5_source_projection(
            &tx, request, &evidence, authority,
        )?;

        if let Some(stored) = governed_dispatch_v5_admission_by_source(
            &tx,
            request.run_id,
            request.dispatch_event_id,
        )? {
            let disposition = resolve_existing_governed_dispatch_v5_admission(
                &tx, &stored, request, &evidence, authority,
            )?;
            tx.commit()?;
            return Ok(disposition);
        }

        for collision in [
            governed_dispatch_v5_admission_by_idempotency(
                &tx,
                request.run_id,
                &evidence.idempotency_key,
            )?,
            governed_dispatch_v5_admission_by_workflow_attempt(
                &tx,
                request.run_id,
                &evidence.workflow_id,
                &evidence.unit_id,
                evidence.attempt,
            )?,
            governed_dispatch_v5_admission_by_semantic_identity(
                &tx,
                request.run_id,
                &evidence.semantic_identity_digest,
            )?,
        ] {
            if collision.is_some() {
                return Err(LedgerError::GovernedDispatchAdmissionConflict {
                    run_id: request.run_id.to_string(),
                    idempotency_key: evidence.idempotency_key.clone(),
                });
            }
        }
        require_governed_dispatch_v5_admission_receipt_projection(&tx, request, &evidence, None)?;

        let occurred_at = canonical_ledger_timestamp(Utc::now())?;
        let witness_evidence_digest =
            governed_dispatch_v5_admission_witness_evidence_digest_v1(&evidence, authority)?;
        let receipt = GovernedDispatchV5AdmissionRecordedV1 {
            run_id: request.run_id.to_string(),
            source_dispatch_event_ref: evidence.dispatch_event_id,
            source_dispatch_event_digest: evidence.dispatch_event_digest.clone(),
            dispatch_envelope_digest: evidence.v5_envelope_digest.clone(),
            witness_evidence_digest: witness_evidence_digest.clone(),
            semantic_identity_digest: evidence.semantic_identity_digest.clone(),
            idempotency_key: evidence.idempotency_key.clone(),
            ledger_authority_realm_digest: authority.ledger_authority_realm_digest.clone(),
            admitted_at: timestamp(occurred_at.clone()),
        };
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(evidence.dispatch_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::GovernedDispatchV5AdmissionRecordedV1,
            occurred_at,
            payload: Payload::GovernedDispatchV5AdmissionRecordedV1(receipt),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, admission_signing_key, admission_signer, occurred_at)?;
        let admission_event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        insert_governed_dispatch_v5_admission(
            &tx,
            &evidence,
            authority,
            &event,
            &admission_event_digest,
        )?;
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(
            GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
                source_dispatch_event_id: evidence.dispatch_event_id,
                source_dispatch_event_digest: evidence.dispatch_event_digest,
                admission_event_id: event.id,
                admission_event_digest,
                v5_envelope_digest: evidence.v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest: evidence.semantic_identity_digest,
                idempotency_key: evidence.idempotency_key,
            },
        )
    }

    /// Seal one protected-host V5 admission receipt with the exact current
    /// signed tape prefix. The receipt remains non-effect evidence after
    /// sealing; this only makes recovery and duplicate delivery verifiable.
    pub fn seal_governed_dispatch_v5_admission_v1(
        &self,
        request: &GovernedDispatchV5AdmissionSealRequestV1,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
    ) -> Result<GovernedDispatchV5AdmissionDispositionV1> {
        validate_governed_dispatch_v5_admission_checkpoint_signer(
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let stored = governed_dispatch_v5_admission_by_admission_event(
            &tx,
            request.run_id,
            request.admission_event_id,
        )?
        .ok_or_else(
            || LedgerError::GovernedDispatchAdmissionReconciliationRequired {
                run_id: request.run_id.to_string(),
                idempotency_key: "unknown".into(),
                reason: "governed V5 admission has no native projection".into(),
            },
        )?;
        verify_stored_governed_dispatch_v5_admission(&tx, &stored, authority)?;
        if stored.state == StoredGovernedDispatchV5AdmissionState::Sealed {
            let disposition =
                sealed_governed_dispatch_v5_admission_disposition(&tx, &stored, authority)?;
            tx.commit()?;
            return Ok(disposition);
        }
        tx.commit()?;

        let seal = self.seal_governed_dispatch_v5_admission_prefix(
            &stored,
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        let checkpoint_event_id = match seal {
            GovernedCheckpointSealOutcome::AlreadySealed {
                checkpoint_event_id,
            }
            | GovernedCheckpointSealOutcome::Emitted {
                checkpoint_event_id,
            } => checkpoint_event_id,
            GovernedCheckpointSealOutcome::EmptyPrefix => {
                return Err(governed_dispatch_v5_admission_reconciliation_required(
                    stored.run_id,
                    &stored.idempotency_key,
                    "V5 admission checkpoint sealing found no signed ordinary-event prefix",
                ));
            }
        };
        let checkpoint = fully_covering_governed_dispatch_v5_admission_checkpoint(
            &self.conn,
            request.run_id,
            request.admission_event_id,
            authority,
        )?
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                stored.run_id,
                &stored.idempotency_key,
                "V5 admission checkpoint sealing did not cover the current complete signed prefix",
            )
        })?;
        if checkpoint.event_id != checkpoint_event_id {
            return Err(governed_dispatch_v5_admission_reconciliation_required(
                stored.run_id,
                &stored.idempotency_key,
                "a concurrent checkpoint changed the sealed V5 admission prefix; reopen trusted recovery before proceeding",
            ));
        }
        self.mark_governed_dispatch_v5_admission_sealed(&stored, authority, &checkpoint)
    }

    fn seal_governed_dispatch_v5_admission_prefix(
        &self,
        expected: &StoredGovernedDispatchV5Admission,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = governed_dispatch_v5_admission_by_admission_event(
            &tx,
            expected.run_id,
            expected.admission_event_id,
        )?
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                expected.run_id,
                &expected.idempotency_key,
                "V5 admission projection disappeared before checkpoint sealing",
            )
        })?;
        verify_stored_governed_dispatch_v5_admission(&tx, &current, authority)?;
        let outcome = self.seal_governed_signed_prefix_in_transaction(
            &tx,
            &current.run_id,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        tx.commit()?;
        Ok(outcome)
    }

    fn mark_governed_dispatch_v5_admission_sealed(
        &self,
        expected: &StoredGovernedDispatchV5Admission,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
        checkpoint: &GovernedDispatchV5AdmissionCheckpointEvidence,
    ) -> Result<GovernedDispatchV5AdmissionDispositionV1> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = governed_dispatch_v5_admission_by_admission_event(
            &tx,
            expected.run_id,
            expected.admission_event_id,
        )?
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                expected.run_id,
                &expected.idempotency_key,
                "V5 admission projection disappeared before checkpoint association",
            )
        })?;
        verify_stored_governed_dispatch_v5_admission(&tx, &current, authority)?;
        match current.state {
            StoredGovernedDispatchV5AdmissionState::Sealed => {
                let current_checkpoint =
                    sealed_governed_dispatch_v5_admission_checkpoint(&tx, &current, authority)?;
                if current_checkpoint != *checkpoint {
                    return Err(governed_dispatch_v5_admission_reconciliation_required(
                        current.run_id,
                        &current.idempotency_key,
                        "V5 admission was sealed by a different checkpoint; reopen trusted recovery before proceeding",
                    ));
                }
            }
            StoredGovernedDispatchV5AdmissionState::AwaitingCheckpoint => {
                let current_complete_checkpoint =
                    fully_covering_governed_dispatch_v5_admission_checkpoint(
                        &tx,
                        current.run_id,
                        current.admission_event_id,
                        authority,
                    )?
                    .ok_or_else(|| {
                        governed_dispatch_v5_admission_reconciliation_required(
                            current.run_id,
                            &current.idempotency_key,
                            "checkpoint no longer covers the current complete V5 admission prefix",
                        )
                    })?;
                if current_complete_checkpoint != *checkpoint {
                    return Err(governed_dispatch_v5_admission_reconciliation_required(
                        current.run_id,
                        &current.idempotency_key,
                        "checkpoint changed before the V5 admission seal transition",
                    ));
                }
                verify_governed_dispatch_v5_admission_checkpoint_covers(
                    &tx, &current, checkpoint, authority,
                )?;
                let updated = tx.execute(
                    r#"UPDATE governed_dispatch_v5_admissions
                       SET state = 'sealed',
                           sealed_checkpoint_event_id = ?1,
                           sealed_checkpoint_event_digest = ?2,
                           sealed_at = ?3
                       WHERE run_id = ?4
                         AND admission_event_id = ?5
                         AND state = 'awaiting_checkpoint'"#,
                    params![
                        checkpoint.event_id.to_string(),
                        &checkpoint.event_digest,
                        timestamp(Utc::now()),
                        current.run_id.to_string(),
                        current.admission_event_id.to_string(),
                    ],
                )?;
                if updated != 1 {
                    return Err(governed_dispatch_v5_admission_reconciliation_required(
                        current.run_id,
                        &current.idempotency_key,
                        "checkpoint seal did not advance exactly one V5 admission projection",
                    ));
                }
            }
        }
        let sealed = governed_dispatch_v5_admission_by_admission_event(
            &tx,
            expected.run_id,
            expected.admission_event_id,
        )?
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                expected.run_id,
                &expected.idempotency_key,
                "V5 admission projection disappeared after checkpoint association",
            )
        })?;
        let disposition =
            sealed_governed_dispatch_v5_admission_disposition(&tx, &sealed, authority)?;
        tx.commit()?;
        Ok(disposition)
    }

    /// Record (or resolve) the one signed governed V3 admission for an exact
    /// workflow attempt. This is not the generic signed append path: it
    /// validates the closed V3 posture, writes the detached signature and
    /// immutable admission projection in one immediate transaction, and
    /// returns only `AwaitingCheckpoint` until a separate checkpoint seal
    /// proves the current complete signed prefix.
    pub fn record_governed_dispatch_admission_v1(
        &self,
        request: &GovernedDispatchAdmissionRequestV1,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        dispatch_signing_key: &SigningKey,
        dispatch_signer: &ActorKeyRef,
    ) -> Result<GovernedDispatchAdmissionDispositionV1> {
        validate_governed_dispatch_admission_request(request, authority)?;
        validate_governed_dispatch_admission_dispatch_signer(
            authority,
            dispatch_signing_key,
            dispatch_signer,
        )?;
        let semantic_identity_digest =
            governed_dispatch_admission_semantic_identity_digest_v1(request)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        require_governed_dispatch_admission_request_identity_not_conflicted(&tx, request)?;
        if let Some(existing) = governed_dispatch_admission_by_idempotency(
            &tx,
            request.run_id,
            &request.dispatch.body.idempotency_key,
        )? {
            let disposition = resolve_existing_governed_dispatch_admission(
                &tx,
                &existing,
                request,
                &semantic_identity_digest,
                authority,
            )?;
            tx.commit()?;
            return Ok(disposition);
        }
        if governed_dispatch_admission_by_workflow_attempt(
            &tx,
            request.run_id,
            &request.dispatch.body.workflow_id,
            &request.dispatch.body.unit_id,
            request.dispatch.body.attempt,
        )?
        .is_some()
        {
            return Err(LedgerError::GovernedDispatchAdmissionConflict {
                run_id: request.run_id.to_string(),
                idempotency_key: request.dispatch.body.idempotency_key.clone(),
            });
        }
        require_governed_dispatch_admission_event_projection(&tx, request, None)?;

        let occurred_at = canonical_ledger_timestamp(Utc::now())?;
        validate_governed_dispatch(&request.dispatch, occurred_at.clone()).map_err(|error| {
            LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: format!(
                    "governed dispatch admission does not have a live sealed V3 authority window: {error}"
                ),
            }
        })?;
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::DispatchEnvelopeV3,
            occurred_at,
            payload: Payload::DispatchEnvelopeV3(request.dispatch.clone()),
        })?;
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, dispatch_signing_key, dispatch_signer, occurred_at)?;
        let dispatch_event_digest = signature.canonical_event_hash.clone();
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        insert_governed_dispatch_admission(
            &tx,
            request,
            &semantic_identity_digest,
            &event,
            &dispatch_event_digest,
        )?;
        tx.commit()?;
        self.record_ordinary_append(&event);

        Ok(GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id: event.id,
            dispatch_event_digest,
            semantic_identity_digest,
            idempotency_key: request.dispatch.body.idempotency_key.clone(),
        })
    }

    /// Seal one previously recorded admission with an exact checkpoint signed
    /// by the independently configured kernel identity. This is deliberately
    /// admission-specific: it reconstructs the immutable V3 dispatch and its
    /// projection before sealing, then records the verified checkpoint event
    /// reference in the one permitted state transition. It never treats
    /// `append_signed_with_checkpoint` as admission success.
    pub fn seal_governed_dispatch_admission_v1(
        &self,
        request: &GovernedDispatchAdmissionSealRequestV1,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
    ) -> Result<GovernedDispatchAdmissionDispositionV1> {
        self.seal_governed_dispatch_admission_v1_inner(
            request,
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
            || {},
        )
    }

    /// Test-only scheduling seam after a sealed-admission disposition is
    /// materialized and committed.
    ///
    /// The callback receives no authority, store, or result and cannot alter
    /// the ledger directly. It lets an integration test schedule a real second
    /// store append at the boundary; it is absent from release builds.
    #[cfg(any(test, feature = "test-support"))]
    pub fn seal_governed_dispatch_admission_v1_with_after_transition_hook_for_tests<F>(
        &self,
        request: &GovernedDispatchAdmissionSealRequestV1,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
        after_transition: F,
    ) -> Result<GovernedDispatchAdmissionDispositionV1>
    where
        F: FnOnce(),
    {
        self.seal_governed_dispatch_admission_v1_inner(
            request,
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
            after_transition,
        )
    }

    fn seal_governed_dispatch_admission_v1_inner<F>(
        &self,
        request: &GovernedDispatchAdmissionSealRequestV1,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
        after_transition: F,
    ) -> Result<GovernedDispatchAdmissionDispositionV1>
    where
        F: FnOnce(),
    {
        validate_governed_dispatch_admission_checkpoint_signer(
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let stored =
            governed_dispatch_admission_by_event(&tx, request.run_id, request.dispatch_event_id)?
                .ok_or_else(
                || LedgerError::GovernedDispatchAdmissionReconciliationRequired {
                    run_id: request.run_id.to_string(),
                    idempotency_key: "unknown".into(),
                    reason: "governed dispatch admission has no native projection".into(),
                },
            )?;
        verify_stored_governed_dispatch_admission(&tx, &stored, authority)?;

        if stored.state == StoredGovernedDispatchAdmissionState::Sealed {
            let disposition =
                sealed_governed_dispatch_admission_disposition(&tx, &stored, authority)?;
            tx.commit()?;
            after_transition();
            return Ok(disposition);
        }
        tx.commit()?;

        let seal = self.seal_governed_dispatch_admission_prefix(
            &stored,
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        let checkpoint_event_id = match seal {
            GovernedCheckpointSealOutcome::AlreadySealed {
                checkpoint_event_id,
            }
            | GovernedCheckpointSealOutcome::Emitted {
                checkpoint_event_id,
            } => checkpoint_event_id,
            GovernedCheckpointSealOutcome::EmptyPrefix => {
                return Err(stored_governed_dispatch_admission_reconciliation_required(
                    &stored,
                    "admission checkpoint sealing found no signed ordinary-event prefix",
                ));
            }
        };
        let checkpoint = fully_covering_governed_dispatch_admission_checkpoint(
            &self.conn,
            request.run_id,
            request.dispatch_event_id,
            authority,
        )?
        .ok_or_else(|| {
            stored_governed_dispatch_admission_reconciliation_required(
                &stored,
                "admission checkpoint sealing did not cover the current complete signed prefix",
            )
        })?;
        if checkpoint.event_id != checkpoint_event_id {
            return Err(stored_governed_dispatch_admission_reconciliation_required(
                &stored,
                "a concurrent checkpoint changed the sealed admission prefix; reopen trusted recovery before proceeding",
            ));
        }
        let disposition =
            self.mark_governed_dispatch_admission_sealed(&stored, authority, &checkpoint)?;
        after_transition();
        Ok(disposition)
    }

    fn seal_governed_dispatch_admission_prefix(
        &self,
        expected: &StoredGovernedDispatchAdmission,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        checkpoint_signing_key: &SigningKey,
        checkpoint_signer: &ActorKeyRef,
    ) -> Result<GovernedCheckpointSealOutcome> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current =
            governed_dispatch_admission_by_event(&tx, expected.run_id, expected.dispatch_event_id)?
                .ok_or_else(|| {
                    stored_governed_dispatch_admission_reconciliation_required(
                        expected,
                        "admission projection disappeared before checkpoint sealing",
                    )
                })?;
        verify_stored_governed_dispatch_admission(&tx, &current, authority)?;
        let dispatch = verified_governed_dispatch_admission_dispatch(&tx, &current, authority)?;
        let admission_request = GovernedDispatchAdmissionRequestV1 {
            run_id: current.run_id,
            dispatch,
        };
        require_governed_dispatch_admission_event_projection(
            &tx,
            &admission_request,
            Some(current.dispatch_event_id),
        )?;
        let outcome = self.seal_governed_signed_prefix_in_transaction(
            &tx,
            &current.run_id,
            checkpoint_signing_key,
            checkpoint_signer,
        )?;
        tx.commit()?;
        Ok(outcome)
    }

    fn mark_governed_dispatch_admission_sealed(
        &self,
        expected: &StoredGovernedDispatchAdmission,
        authority: &GovernedDispatchAdmissionAuthorityV1,
        checkpoint: &GovernedDispatchAdmissionCheckpointEvidence,
    ) -> Result<GovernedDispatchAdmissionDispositionV1> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current =
            governed_dispatch_admission_by_event(&tx, expected.run_id, expected.dispatch_event_id)?
                .ok_or_else(|| {
                    stored_governed_dispatch_admission_reconciliation_required(
                        expected,
                        "admission projection disappeared before checkpoint association",
                    )
                })?;
        verify_stored_governed_dispatch_admission(&tx, &current, authority)?;
        match current.state {
            StoredGovernedDispatchAdmissionState::Sealed => {
                let current_checkpoint =
                    sealed_governed_dispatch_admission_checkpoint(&tx, &current, authority)?;
                if current_checkpoint != *checkpoint {
                    return Err(stored_governed_dispatch_admission_reconciliation_required(
                        &current,
                        "admission was sealed by a different checkpoint; reopen trusted recovery before proceeding",
                    ));
                }
            }
            StoredGovernedDispatchAdmissionState::AwaitingCheckpoint => {
                let current_complete_checkpoint =
                    fully_covering_governed_dispatch_admission_checkpoint(
                        &tx,
                        current.run_id,
                        current.dispatch_event_id,
                        authority,
                    )?
                    .ok_or_else(|| {
                        stored_governed_dispatch_admission_reconciliation_required(
                            &current,
                            "checkpoint no longer covers the current complete admission prefix",
                        )
                    })?;
                if current_complete_checkpoint != *checkpoint {
                    return Err(stored_governed_dispatch_admission_reconciliation_required(
                        &current,
                        "checkpoint changed before the admission seal transition",
                    ));
                }
                verify_governed_dispatch_admission_checkpoint_covers(
                    &tx, &current, checkpoint, authority,
                )?;
                let updated = tx.execute(
                    r#"UPDATE governed_dispatch_admissions
                       SET state = 'sealed',
                           sealed_checkpoint_event_id = ?1,
                           sealed_checkpoint_event_digest = ?2,
                           sealed_at = ?3
                       WHERE run_id = ?4
                         AND dispatch_event_id = ?5
                         AND state = 'awaiting_checkpoint'"#,
                    params![
                        checkpoint.event_id.to_string(),
                        &checkpoint.event_digest,
                        Utc::now().to_rfc3339(),
                        current.run_id.to_string(),
                        current.dispatch_event_id.to_string(),
                    ],
                )?;
                if updated != 1 {
                    return Err(stored_governed_dispatch_admission_reconciliation_required(
                        &current,
                        "checkpoint seal did not advance exactly one admission projection",
                    ));
                }
            }
        }
        let sealed =
            governed_dispatch_admission_by_event(&tx, expected.run_id, expected.dispatch_event_id)?
                .ok_or_else(|| {
                    stored_governed_dispatch_admission_reconciliation_required(
                        expected,
                        "admission projection disappeared after checkpoint association",
                    )
                })?;
        let disposition = sealed_governed_dispatch_admission_disposition(&tx, &sealed, authority)?;
        tx.commit()?;
        Ok(disposition)
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
            let disposition = resolve_existing_governed_candidate_completion(
                &tx,
                &existing,
                request,
                authority,
                kernel_signing_key,
                kernel_signer,
            )?;
            tx.commit()?;
            disposition
        } else {
            require_candidate_completion_event_projection(&tx, request, None)?;

            let evidence = verify_governed_candidate_completion_evidence(
                &tx,
                request,
                authority,
                kernel_signing_key,
                kernel_signer,
                None,
            )?;
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
                authority,
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

    /// Append or resolve one operator-owned `Abandon` event for an already
    /// recorded, target-bound promotion reconciliation.
    ///
    /// The immutable promotion result remains historical evidence. This
    /// method never performs Git work, never reissues a promotion lease, and
    /// never exposes a caller-selected reconciliation outcome. It is a narrow
    /// protected-host primitive used only after a broker has reopened trusted
    /// replay and completed a read-only receipt observation.
    ///
    /// The ordinary reconciliation event and the kernel checkpoint are one
    /// SQLite transaction. A checkpoint failure therefore rolls the event back
    /// instead of leaving an unsealed governed tail that trusted replay cannot
    /// resume through this broker boundary. A retry either observes the exact
    /// sealed event or records one new atomically sealed abandonment.
    ///
    /// The generic append paths reject this event kind, so no generic
    /// ledger-server request can race in a second reconciliation record.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn record_governed_promotion_reconciliation_abandon_v1(
        &self,
        request: &GovernedPromotionReconciliationRequestV1,
        authority: &GovernedPromotionAuthorityV1,
        operator_signing_key: &SigningKey,
        operator_signer: &ActorKeyRef,
        kernel_signing_key: &SigningKey,
        kernel_signer: &ActorKeyRef,
    ) -> Result<GovernedPromotionReconciliationDispositionV1> {
        validate_governed_promotion_signer(
            authority,
            operator_signing_key,
            operator_signer,
            PromotionSignerRoleV1::Operator,
        )?;
        validate_governed_promotion_signer(
            authority,
            kernel_signing_key,
            kernel_signer,
            PromotionSignerRoleV1::Kernel,
        )?;
        let now = canonical_ledger_timestamp(Utc::now())?;

        let (disposition, appended_event) = {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            let decision = governed_promotion_decision_by_event(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )?
            .ok_or_else(|| {
                promotion_reconciliation_authority_rejected(
                    "promotion reconciliation has no native decision projection",
                )
            })?;
            if decision.state != StoredGovernedPromotionDecisionState::Sealed {
                return Err(promotion_reconciliation_authority_rejected(
                    "promotion reconciliation requires a kernel-sealed decision",
                ));
            }
            let verified =
                verified_governed_promotion_decision_from_stored(&tx, &decision, authority)?;
            verify_stored_governed_promotion_decision_seal(&tx, &decision, authority)?;
            let result = governed_promotion_result_by_decision(
                &tx,
                request.run_id,
                request.promotion_decision_event_id,
            )?
            .ok_or_else(|| {
                promotion_reconciliation_authority_rejected(
                    "promotion reconciliation has no native result projection",
                )
            })?;
            if result.promotion_result_event_id != request.promotion_result_event_id {
                return Err(promotion_reconciliation_authority_rejected(
                    "promotion reconciliation result reference does not match the sealed decision",
                ));
            }
            let resolution = governed_promotion_reconciliation_abandon_payload(
                &tx, request, &decision, &verified, &result, authority, now,
            )?;

            let (disposition, appended_event) = if let Some((event_id, event_digest)) =
                existing_governed_promotion_reconciliation_abandon(
                    &tx,
                    request.run_id,
                    result.promotion_result_event_id,
                    &resolution,
                    authority,
                )? {
                (
                    GovernedPromotionReconciliationDispositionV1::Existing {
                        promotion_reconciliation_event_id: event_id,
                        promotion_reconciliation_event_digest: event_digest,
                        outcome: ReconciliationResolutionOutcomeV1::Abandon,
                    },
                    None,
                )
            } else {
                let event = canonicalize(Event {
                    id: EventId::new(),
                    run_id: request.run_id,
                    parent_event_id: Some(result.promotion_result_event_id),
                    schema_version: Event::CURRENT_SCHEMA_VERSION,
                    kind: EventKind::PromotionReconciliationResolved,
                    occurred_at: now,
                    payload: Payload::PromotionReconciliationResolvedV1(resolution),
                })?;
                validate_new_ordinary_event_id(&tx, &event)?;
                let signature = sign_event(&event, operator_signing_key, operator_signer, now)?;
                let event_digest = signature.canonical_event_hash.clone();
                insert_event(&tx, &event)?;
                insert_event_signature(&tx, &signature)?;
                (
                    GovernedPromotionReconciliationDispositionV1::Recorded {
                        promotion_reconciliation_event_id: event.id,
                        promotion_reconciliation_event_digest: event_digest,
                        outcome: ReconciliationResolutionOutcomeV1::Abandon,
                    },
                    Some(event),
                )
            };

            match self.seal_governed_signed_prefix_in_transaction(
                &tx,
                &request.run_id,
                kernel_signing_key,
                kernel_signer,
            )? {
                GovernedCheckpointSealOutcome::AlreadySealed { .. }
                | GovernedCheckpointSealOutcome::Emitted { .. } => {}
                GovernedCheckpointSealOutcome::EmptyPrefix => {
                    return Err(promotion_reconciliation_authority_rejected(
                        "promotion reconciliation sealing found no signed governed prefix",
                    ));
                }
            }
            tx.commit()?;
            (disposition, appended_event)
        };
        if let Some(event) = appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        Ok(disposition)
    }

    /// Create or recover the single native process write-ahead action for one
    /// governed command dispatch.
    pub fn issue_governed_command_action_v1(
        &self,
        request: &GovernedCommandActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        self.issue_governed_command_action_v1_at(
            request,
            cas,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn issue_governed_command_action_v1_at_for_tests(
        &self,
        request: &GovernedCommandActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        self.issue_governed_command_action_v1_at(request, cas, authority, signing_key, signer, now)
    }

    fn issue_governed_command_action_v1_at(
        &self,
        request: &GovernedCommandActionIssueRequestV1,
        cas: &Cas,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        require_protected_governed_realm(authority)?;
        validate_action_request_signer(authority, signing_key, signer)?;
        let now = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let dispatch_event = load_verified_authority_event(
            &tx,
            request.dispatch_event_id,
            &authority.trusted_keys,
            &authority.dispatch_signer,
            "governed command dispatch",
        )?;
        if dispatch_event.run_id != request.run_id {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed command dispatch belongs to another run".into(),
            });
        }
        let dispatch_material =
            dispatch_authority_material(&dispatch_event.payload).ok_or_else(|| {
                LedgerError::ActivityClaimAuthorityRejected {
                    reason:
                        "governed command issuance requires a signed V3 or graph-bound V4 dispatch"
                            .into(),
                }
            })?;
        let issued = issue_governed_command_action_from_dispatch_in_tx(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            &request.packet_source,
            dispatch_material,
            cas,
            authority,
            signing_key,
            signer,
            now,
        )?;
        tx.commit()?;
        if let Some(event) = issued.appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        Ok(issued.disposition)
    }

    /// Create or recover the single native process write-ahead action for one
    /// manifest-bound V5 dispatch after its independently signed admission
    /// receipt has been sealed by a complete tape checkpoint.
    ///
    /// Unlike the V3/V4 entry point, the raw source dispatch is never
    /// downcast directly. This method reopens the stored admission, re-verifies
    /// every graph/manifest/retry witness, proves checkpoint coverage, and only
    /// then derives the nested execution authority inside the same immediate
    /// transaction that appends the action request.
    pub fn issue_governed_v5_command_action_v1(
        &self,
        request: &GovernedV5CommandActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        self.issue_governed_v5_command_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn issue_governed_v5_command_action_v1_at_for_tests(
        &self,
        request: &GovernedV5CommandActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        self.issue_governed_v5_command_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn issue_governed_v5_command_action_v1_at(
        &self,
        request: &GovernedV5CommandActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedCommandActionIssueDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_action_request_signer(activity_authority, signing_key, signer)?;
        let now = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let dispatch_material = verified_sealed_v5_dispatch_action_material(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            request.admission_event_id,
            v5_authority,
            activity_authority,
        )?;
        let issued = issue_governed_command_action_from_dispatch_in_tx(
            &tx,
            request.run_id,
            request.dispatch_event_id,
            &request.packet_source,
            dispatch_material,
            cas,
            activity_authority,
            signing_key,
            signer,
            now,
        )?;
        tx.commit()?;
        if let Some(event) = issued.appended_event.as_ref() {
            self.record_ordinary_append(event);
        }
        Ok(issued.disposition)
    }

    /// Resolve the single live, checkpoint-sealed V5 admission whose signed
    /// dispatch exactly binds the supplied normalized packet. The caller
    /// cannot choose either tape event identity.
    pub fn resolve_governed_v5_candidate_authority_v1(
        &self,
        request: &ResolveGovernedV5CandidateAuthorityRequestV1,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
    ) -> Result<ResolvedGovernedV5CandidateAuthorityV1> {
        self.resolve_governed_v5_candidate_authority_v1_at(
            request,
            v5_authority,
            activity_authority,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn resolve_governed_v5_candidate_authority_v1_at_for_tests(
        &self,
        request: &ResolveGovernedV5CandidateAuthorityRequestV1,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        now: DateTime<Utc>,
    ) -> Result<ResolvedGovernedV5CandidateAuthorityV1> {
        self.resolve_governed_v5_candidate_authority_v1_at(
            request,
            v5_authority,
            activity_authority,
            now,
        )
    }

    fn resolve_governed_v5_candidate_authority_v1_at(
        &self,
        request: &ResolveGovernedV5CandidateAuthorityRequestV1,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        now: DateTime<Utc>,
    ) -> Result<ResolvedGovernedV5CandidateAuthorityV1> {
        let now = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)?;
        let admissions = sealed_governed_dispatch_v5_admissions_for_run(&tx, request.run_id)?;
        let mut resolved = None;

        for admission in admissions {
            let material = verified_sealed_v5_dispatch_action_material(
                &tx,
                request.run_id,
                admission.source_dispatch_event_id,
                admission.admission_event_id,
                v5_authority,
                activity_authority,
            )?;
            let packet = match verified_governed_command_packet_for_dispatch(
                &request.packet_source,
                &material.dispatch,
            ) {
                Ok(packet) => packet,
                Err(LedgerError::ActivityClaimAuthorityRejected { .. }) => continue,
                Err(error) => return Err(error),
            };
            validate_governed_dispatch(&material.dispatch, now).map_err(|error| {
                LedgerError::ActivityClaimAuthorityRejected {
                    reason: format!(
                        "candidate opening requires a live signed V5 dispatch authority window: {error}"
                    ),
                }
            })?;

            if resolved.is_some() {
                return Err(governed_dispatch_v5_admission_reconciliation_required(
                    request.run_id,
                    "candidate-authority",
                    "multiple sealed V5 admissions bind the same candidate packet",
                ));
            }

            let dispatch = material.dispatch;
            resolved = Some(ResolvedGovernedV5CandidateAuthorityV1 {
                run_id: request.run_id,
                dispatch_event_id: admission.source_dispatch_event_id,
                admission_event_id: admission.admission_event_id,
                workflow_id: dispatch.body.workflow_id,
                unit_id: dispatch.body.unit_id,
                attempt: dispatch.body.attempt,
                provenance_ref: dispatch.body.provenance_ref,
                base_commit_sha: dispatch.body.base_commit_sha,
                repository_binding_digest: dispatch.repository_binding_digest,
                dispatch_envelope_digest: material.lineage_envelope_digest,
                governed_packet_digest: packet.canonical_digest()?,
                sandbox_profile_digest: dispatch.body.sandbox_profile_digest,
            });
        }

        tx.commit()?;
        resolved.ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "candidate opening requires exactly one live sealed V5 admission for this packet"
                    .into(),
        })
    }

    pub fn resolve_governed_v5_candidate_execution_authority_v1(
        &self,
        run_id: RunId,
        dispatch_event_id: EventId,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
    ) -> Result<ResolvedGovernedV5CandidateExecutionAuthorityV1> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)?;
        let admission = governed_dispatch_v5_admission_by_source(&tx, run_id, dispatch_event_id)?
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "candidate execution requires a recorded V5 admission for its dispatch".into(),
        })?;
        let material = verified_sealed_v5_dispatch_action_material(
            &tx,
            run_id,
            dispatch_event_id,
            admission.admission_event_id,
            v5_authority,
            activity_authority,
        )?;
        let dispatch = material.dispatch;
        let governed_packet_digest = dispatch.governed_packet_digest.clone().ok_or_else(|| {
            LedgerError::ActivityClaimAuthorityRejected {
                reason: "candidate execution dispatch has no governed packet digest".into(),
            }
        })?;
        let expected_action_id = format!(
            "governed:{}:{}",
            run_id,
            material
                .lineage_envelope_digest
                .strip_prefix("sha256:")
                .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                    reason: "candidate execution dispatch digest is not canonical sha256".into(),
                })?
        );
        let mut statement = tx.prepare(
            "SELECT id FROM events \
             WHERE run_id = ?1 AND kind = ?2 AND parent_event_id = ?3 \
             ORDER BY id ASC",
        )?;
        let ids = statement
            .query_map(
                params![
                    run_id.to_string(),
                    EventKind::ActionRequestedV2.as_wire(),
                    dispatch_event_id.to_string()
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut action_request_event_id = None;
        for raw_id in ids {
            let event_id = parse_event_id(&raw_id, "candidate execution action")?;
            let event = load_verified_authority_event(
                &tx,
                event_id,
                &activity_authority.trusted_keys,
                &activity_authority.action_request_signer,
                "candidate execution action",
            )?;
            let Payload::ActionRequestedV2(action) = event.payload else {
                unreachable!("action-request query returns only action_requested_v2 events");
            };
            if action.action_id != expected_action_id {
                continue;
            }
            if action_request_event_id.replace(event_id).is_some() {
                return Err(governed_dispatch_v5_admission_reconciliation_required(
                    run_id,
                    &admission.idempotency_key,
                    "candidate execution has duplicate signed action requests",
                ));
            }
        }
        let action_request_event_id =
            action_request_event_id.ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "candidate execution has no signed V5 action request".into(),
            })?;
        tx.commit()?;
        Ok(ResolvedGovernedV5CandidateExecutionAuthorityV1 {
            candidate: ResolvedGovernedV5CandidateAuthorityV1 {
                run_id,
                dispatch_event_id,
                admission_event_id: admission.admission_event_id,
                workflow_id: dispatch.body.workflow_id,
                unit_id: dispatch.body.unit_id,
                attempt: dispatch.body.attempt,
                provenance_ref: dispatch.body.provenance_ref,
                base_commit_sha: dispatch.body.base_commit_sha,
                repository_binding_digest: dispatch.repository_binding_digest,
                dispatch_envelope_digest: material.lineage_envelope_digest,
                governed_packet_digest,
                sandbox_profile_digest: dispatch.body.sandbox_profile_digest,
            },
            action_request_event_id,
        })
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
        verify_purpose_bound_process_claim_lineage(
            &self.conn,
            &claim,
            authority,
            ActivityClaimPurposeV1::GovernedVerifierV1,
            "governed verifier",
        )?;
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

    /// Record one command result through the opaque lease returned by the
    /// protected command authority. The lease must resolve to the dedicated
    /// command purpose and an implementer process action; a generic or
    /// verifier lease cannot be relabeled as command execution.
    pub fn record_governed_command_action_result_v1(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_command_action_result_v1_at(
            request,
            authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn record_governed_command_action_result_v1_at_for_tests(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_command_action_result_v1_at(
            request,
            authority,
            signing_key,
            signer,
            now,
        )
    }

    fn record_governed_command_action_result_v1_at(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        require_protected_governed_realm(authority)?;
        if request.lease_id.trim().is_empty() {
            return Err(LedgerError::InvalidPayload {
                kind: "record_governed_command_action_result_v1".into(),
                reason: "lease_id must be non-empty".into(),
            });
        }
        let claim = activity_claim_by_lease(&self.conn, request.run_id, &request.lease_id)?
            .ok_or_else(|| {
                command_action_authority_rejected(
                    "command result lease does not name a signed activity claim",
                )
            })?;
        verify_purpose_bound_process_claim_lineage(
            &self.conn,
            &claim,
            authority,
            ActivityClaimPurposeV1::GovernedCommandActionV1,
            "governed command",
        )?;
        if claim.action_kind != ActionKindV1::Process {
            return Err(command_action_authority_rejected(
                "command result lease does not name a process action",
            ));
        }
        let action_request_event = load_verified_authority_event(
            &self.conn,
            claim.action_request_event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "governed command action request",
        )?;
        let Payload::ActionRequestedV2(action_request) = action_request_event.payload else {
            return Err(command_action_authority_rejected(
                "command result lease action is not action_requested_v2",
            ));
        };
        if action_request.action_kind != ActionKindV1::Process
            || action_request.execution_role != ExecutionRoleV1::Implementer
            || action_request.action_id != claim.activity_id
            || action_request.idempotency_key != claim.idempotency_key
        {
            return Err(command_action_authority_rejected(
                "command result lease does not bind a signed implementer process action",
            ));
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

    /// Record the terminal result for a command lease whose authority comes
    /// from a checkpoint-sealed V5 admission. The admission identity is
    /// recovered from the claim's signed source dispatch, not supplied by the
    /// worker reconnecting with the opaque lease.
    pub fn record_governed_v5_command_action_result_v1(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_v5_command_action_result_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn record_governed_v5_command_action_result_v1_at_for_tests(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_v5_command_action_result_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_governed_v5_command_action_result_v1_at(
        &self,
        request: &GovernedCommandActionResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_claim_signer(activity_authority, signing_key, signer)?;
        if request.lease_id.trim().is_empty() {
            return Err(LedgerError::InvalidPayload {
                kind: "record_governed_v5_command_action_result_v1".into(),
                reason: "lease_id must be non-empty".into(),
            });
        }
        let stored = activity_claim_by_lease(&self.conn, request.run_id, &request.lease_id)?
            .ok_or_else(|| {
                command_action_authority_rejected(
                    "V5 command result lease does not name a signed activity claim",
                )
            })?;
        let signed_claim = verify_signed_claim_projection(&self.conn, &stored, activity_authority)?;
        if stored.action_kind != ActionKindV1::Process
            || signed_claim.purpose != ActivityClaimPurposeV1::GovernedCommandActionV1
        {
            return Err(command_action_authority_rejected(
                "V5 command result requires a protected process-command lease",
            ));
        }
        let admission = governed_dispatch_v5_admission_by_source(
            &self.conn,
            request.run_id,
            stored.dispatch_event_id,
        )?
        .ok_or_else(|| {
            command_action_authority_rejected(
                "V5 command result requires a recorded admission for its source dispatch",
            )
        })?;
        let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
        let reconstruction_request = GovernedCommandActionAuthorizeAndClaimRequestV1 {
            run_id: stored.run_id,
            dispatch_event_id: stored.dispatch_event_id,
            action_request_event_id: stored.action_request_event_id,
            lease_duration_ms: stored.lease_duration_ms,
        };
        let (derived_claim, _) = reconstruct_governed_v5_command_action(
            &self.conn,
            &reconstruction_request,
            admission.admission_event_id,
            cas,
            v5_authority,
            activity_authority,
            claimed_at,
        )?;
        if derived_claim.activity_id != stored.activity_id
            || derived_claim.idempotency_key != stored.idempotency_key
            || derived_claim.dispatch_event_id != stored.dispatch_event_id
            || derived_claim.action_request_event_id != stored.action_request_event_id
        {
            return Err(command_action_authority_rejected(
                "V5 command result lease does not match reconstructed admission authority",
            ));
        }
        if !activity_heartbeats_for_claim(&self.conn, stored.run_id, stored.claim_event_id)?
            .is_empty()
        {
            return Err(command_action_authority_rejected(
                "V5 command result does not admit heartbeat-extended leases",
            ));
        }
        let derived = ActivityResultRequestV1 {
            run_id: request.run_id,
            activity_id: stored.activity_id.clone(),
            idempotency_key: stored.idempotency_key.clone(),
            lease_id: request.lease_id.clone(),
            outcome: request.outcome,
            result_digest: request.result_digest.clone(),
            result_ref: request.result_ref.clone(),
            evidence_digest: request.evidence_digest.clone(),
            evidence_ref: request.evidence_ref.clone(),
        };
        validate_activity_result_request(&derived)?;

        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = activity_claim_by_idempotency(&tx, request.run_id, &stored.idempotency_key)?
            .ok_or_else(|| LedgerError::ActivityClaimNotFound {
                run_id: request.run_id.to_string(),
                idempotency_key: stored.idempotency_key.clone(),
            })?;
        verify_signed_claim_projection(&tx, &current, activity_authority)?;
        if current.claim_event_id != stored.claim_event_id
            || current.claim_event_digest != stored.claim_event_digest
            || current.activity_id != stored.activity_id
            || current.action_request_event_id != stored.action_request_event_id
            || current.dispatch_event_id != stored.dispatch_event_id
            || current.lease_id != stored.lease_id
            || current.lease_expires_at != stored.lease_expires_at
        {
            return Err(command_action_authority_rejected(
                "V5 command result claim projection changed during authority reconstruction",
            ));
        }
        if current.state == StoredActivityClaimState::Recorded {
            verify_signed_activity_result_projection(&tx, &current, activity_authority)?;
            let disposition = existing_result_disposition(&current, &derived)?;
            tx.commit()?;
            return Ok(disposition);
        }
        if current.lease_id != request.lease_id {
            return Err(LedgerError::ActivityClaimLeaseMismatch {
                run_id: request.run_id.to_string(),
                idempotency_key: current.idempotency_key,
            });
        }
        let lease_expires_at = parse_claim_timestamp(&current.lease_expires_at)?;
        if now >= lease_expires_at && request.outcome != ActivityResultOutcomeV1::Unknown {
            tx.commit()?;
            return Ok(ActivityResultDispositionV1::LeaseExpired {
                claim_event_id: current.claim_event_id,
                lease_expires_at: timestamp(lease_expires_at),
            });
        }

        let now = canonical_ledger_timestamp(now)?;
        let recorded_at = timestamp(now);
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(current.claim_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActivityResultRecordedV1,
            occurred_at: now,
            payload: Payload::ActivityResultRecordedV1(ActivityResultRecordedV1 {
                run_id: request.run_id,
                activity_id: current.activity_id.clone(),
                idempotency_key: current.idempotency_key.clone(),
                claim_event_id: current.claim_event_id,
                claim_event_digest: current.claim_event_digest.clone(),
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
                &current.idempotency_key,
            ],
        )?;
        if updated != 1 {
            return Err(command_action_authority_rejected(
                "V5 command result did not close exactly one granted lease",
            ));
        }
        tx.commit()?;
        self.record_ordinary_append(&event);
        Ok(ActivityResultDispositionV1::Recorded {
            result_event_id: event.id,
            result_event_digest,
            outcome: request.outcome,
        })
    }

    /// Record the terminal outcome of the one purpose-bound candidate Git
    /// lease. The signed claim and sealed V5 admission are reconstructed
    /// before the result transaction; a terminal retry reuses the exact event.
    #[allow(clippy::too_many_arguments)]
    pub fn record_governed_v5_candidate_finalize_result_v1(
        &self,
        request: &GovernedV5CandidateFinalizeResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_v5_candidate_finalize_result_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn record_governed_v5_candidate_finalize_result_v1_at_for_tests(
        &self,
        request: &GovernedV5CandidateFinalizeResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        self.record_governed_v5_candidate_finalize_result_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_governed_v5_candidate_finalize_result_v1_at(
        &self,
        request: &GovernedV5CandidateFinalizeResultRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<ActivityResultDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_claim_signer(activity_authority, signing_key, signer)?;
        if request.lease_id.trim().is_empty() {
            return Err(LedgerError::InvalidPayload {
                kind: "record_governed_v5_candidate_finalize_result_v1".into(),
                reason: "lease_id must be non-empty".into(),
            });
        }
        let stored = activity_claim_by_lease(&self.conn, request.run_id, &request.lease_id)?
            .ok_or_else(|| {
                command_action_authority_rejected(
                    "candidate finalization result lease does not name a signed claim",
                )
            })?;
        let signed_claim = verify_signed_claim_projection(&self.conn, &stored, activity_authority)?;
        if stored.action_kind != ActionKindV1::Git
            || signed_claim.purpose != ActivityClaimPurposeV1::GovernedCandidateFinalizeV1
        {
            return Err(command_action_authority_rejected(
                "candidate finalization result requires its purpose-bound Git lease",
            ));
        }
        let admission = governed_dispatch_v5_admission_by_source(
            &self.conn,
            request.run_id,
            stored.dispatch_event_id,
        )?
        .ok_or_else(|| {
            command_action_authority_rejected(
                "candidate finalization result requires a recorded V5 admission",
            )
        })?;
        let claimed_at = parse_claim_timestamp(&signed_claim.claimed_at)?;
        let reconstruction = GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1 {
            run_id: stored.run_id,
            dispatch_event_id: stored.dispatch_event_id,
            admission_event_id: admission.admission_event_id,
            action_request_event_id: stored.action_request_event_id,
            lease_duration_ms: stored.lease_duration_ms,
        };
        let derived_claim = reconstruct_governed_v5_candidate_finalize_claim_v1(
            &self.conn,
            &reconstruction,
            cas,
            v5_authority,
            activity_authority,
            claimed_at,
        )?;
        if derived_claim.activity_id != stored.activity_id
            || derived_claim.idempotency_key != stored.idempotency_key
            || derived_claim.dispatch_event_id != stored.dispatch_event_id
            || derived_claim.action_request_event_id != stored.action_request_event_id
        {
            return Err(command_action_authority_rejected(
                "candidate finalization result lease does not match reconstructed authority",
            ));
        }
        if !activity_heartbeats_for_claim(&self.conn, stored.run_id, stored.claim_event_id)?
            .is_empty()
        {
            return Err(command_action_authority_rejected(
                "candidate finalization result does not admit heartbeat-extended leases",
            ));
        }
        let derived = ActivityResultRequestV1 {
            run_id: request.run_id,
            activity_id: stored.activity_id.clone(),
            idempotency_key: stored.idempotency_key.clone(),
            lease_id: request.lease_id.clone(),
            outcome: request.outcome,
            result_digest: request.result_digest.clone(),
            result_ref: request.result_ref.clone(),
            evidence_digest: request.evidence_digest.clone(),
            evidence_ref: request.evidence_ref.clone(),
        };
        validate_activity_result_request(&derived)?;
        record_reconstructed_v5_activity_result_in_tx(
            self,
            &stored,
            &derived,
            activity_authority,
            signing_key,
            signer,
            now,
            "candidate finalization",
        )
    }

    /// Convert one succeeded, checkpoint-admitted V5 command into its exact
    /// immutable receipt evidence.
    ///
    /// This is intentionally not a receipt-set seal. Candidate finalization is
    /// a separate Git activity and the complete set is sealed only after that
    /// activity has a succeeded terminal receipt. An exact retry returns the
    /// existing receipt; substituted evidence requires reconciliation.
    #[allow(clippy::too_many_arguments)]
    pub fn record_succeeded_governed_v5_command_action_receipt_v1(
        &self,
        request: &GovernedV5CommandActionReceiptRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        receipt_signer: &ActorKeyRef,
    ) -> Result<GovernedV5CommandActionReceiptDispositionV1> {
        self.record_succeeded_governed_v5_command_action_receipt_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            receipt_signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn record_succeeded_governed_v5_command_action_receipt_v1_at_for_tests(
        &self,
        request: &GovernedV5CommandActionReceiptRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        receipt_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedV5CommandActionReceiptDispositionV1> {
        self.record_succeeded_governed_v5_command_action_receipt_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            signing_key,
            receipt_signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_succeeded_governed_v5_command_action_receipt_v1_at(
        &self,
        request: &GovernedV5CommandActionReceiptRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        signing_key: &SigningKey,
        receipt_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedV5CommandActionReceiptDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_governed_action_receipt_signer(activity_authority, signing_key, receipt_signer)?;
        let signed_at = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let action_event = load_verified_authority_event(
            &tx,
            request.action_request_event_id,
            &activity_authority.trusted_keys,
            &activity_authority.action_request_signer,
            "V5 command receipt action request",
        )?;
        if action_event.run_id != request.run_id {
            return Err(action_receipt_authority_rejected(
                "command receipt action request belongs to another run",
            ));
        }
        let dispatch_event_id = action_event.parent_event_id.ok_or_else(|| {
            action_receipt_authority_rejected(
                "command receipt action request has no parent dispatch",
            )
        })?;
        let Payload::ActionRequestedV2(action) = &action_event.payload else {
            return Err(action_receipt_authority_rejected(
                "command receipt requires a signed action_requested_v2 event",
            ));
        };
        let action = action.clone();
        if action.action_kind != ActionKindV1::Process
            || action.execution_role != ExecutionRoleV1::Implementer
            || action.authority_actor != activity_authority.action_request_signer.actor_id
        {
            return Err(action_receipt_authority_rejected(
                "command receipt action is not a protected implementer process action",
            ));
        }
        let admission =
            governed_dispatch_v5_admission_by_source(&tx, request.run_id, dispatch_event_id)?
                .ok_or_else(|| {
                    action_receipt_authority_rejected(
                        "command receipt requires a recorded V5 admission for its dispatch",
                    )
                })?;
        let dispatch_material = verified_sealed_v5_dispatch_action_material(
            &tx,
            request.run_id,
            dispatch_event_id,
            admission.admission_event_id,
            v5_authority,
            activity_authority,
        )?;
        let requested_at = parse_claim_timestamp(&action.requested_at).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt action timestamp is not canonical RFC3339 UTC",
            )
        })?;
        let reconstruction_request = GovernedCommandActionAuthorizeAndClaimRequestV1 {
            run_id: request.run_id,
            dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms: MIN_ACTIVITY_LEASE_MS,
        };
        let (derived_claim, _) = reconstruct_governed_v5_command_action_in_tx(
            &tx,
            &reconstruction_request,
            admission.admission_event_id,
            cas,
            v5_authority,
            activity_authority,
            requested_at,
        )
        .map_err(|error| {
            action_receipt_authority_rejected(format!(
                "command receipt could not reconstruct signed V5 command authority: {error}"
            ))
        })?;
        if derived_claim.activity_id != action.action_id
            || derived_claim.idempotency_key != action.idempotency_key
            || dispatch_material.lineage_envelope_digest != action.dispatch_envelope_digest
        {
            return Err(action_receipt_authority_rejected(
                "command receipt reconstruction changed immutable action identity",
            ));
        }
        let action_request_digest = action_requested_v2_digest(&action).map_err(|error| {
            action_receipt_authority_rejected(format!(
                "command receipt could not canonicalize its action request: {error}"
            ))
        })?;

        let claim_event = unique_signed_child_event(
            &tx,
            request.run_id,
            request.action_request_event_id,
            EventKind::ActivityClaimedV1,
            activity_authority,
            &activity_authority.claim_signer,
            &action.action_id,
            "V5 command receipt activity claim",
        )?;
        let Payload::ActivityClaimedV1(claim) = &claim_event.payload else {
            unreachable!("activity-claim query returns only ActivityClaimedV1")
        };
        let claim = claim.clone();
        let claim_event_digest = canonical_event_hash(&claim_event).map_err(|error| {
            action_receipt_authority_rejected(format!(
                "command receipt could not canonicalize its activity claim: {error}"
            ))
        })?;
        if claim.run_id != request.run_id
            || claim.activity_id != action.action_id
            || claim.idempotency_key != action.idempotency_key
            || claim.action_kind != ActionKindV1::Process
            || claim.action_request_event_id != request.action_request_event_id
            || claim.action_request_digest != action_request_digest
            || claim.dispatch_event_id != dispatch_event_id
            || claim.dispatch_envelope_digest != action.dispatch_envelope_digest
            || claim.authority_actor != activity_authority.claim_signer.actor_id
            || claim.purpose != ActivityClaimPurposeV1::GovernedCommandActionV1
            || !tape_event_precedes(&action_event, &claim_event)
        {
            return Err(action_receipt_authority_rejected(
                "command receipt claim does not exactly bind its signed action",
            ));
        }
        let claimed_at = parse_claim_timestamp(&claim.claimed_at).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt claim timestamp is not canonical RFC3339 UTC",
            )
        })?;
        let lease_expires_at = parse_claim_timestamp(&claim.lease_expires_at).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt lease expiry is not canonical RFC3339 UTC",
            )
        })?;

        let result_event = unique_signed_child_event(
            &tx,
            request.run_id,
            claim_event.id,
            EventKind::ActivityResultRecordedV1,
            activity_authority,
            &activity_authority.claim_signer,
            &action.action_id,
            "V5 command receipt activity result",
        )?;
        let Payload::ActivityResultRecordedV1(result) = &result_event.payload else {
            unreachable!("activity-result query returns only ActivityResultRecordedV1")
        };
        let result = result.clone();
        let recorded_at = parse_claim_timestamp(&result.recorded_at).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt result timestamp is not canonical RFC3339 UTC",
            )
        })?;
        if result.run_id != request.run_id
            || result.activity_id != action.action_id
            || result.idempotency_key != action.idempotency_key
            || result.claim_event_id != claim_event.id
            || result.claim_event_digest != claim_event_digest
            || result.lease_id != claim.lease_id
            || result.outcome != ActivityResultOutcomeV1::Succeeded
            || result.result_digest.is_none()
            || result.result_ref.is_none()
            || recorded_at != result_event.occurred_at
            || recorded_at < claimed_at
            || recorded_at >= lease_expires_at
            || !tape_event_precedes(&claim_event, &result_event)
        {
            return Err(action_receipt_authority_rejected(
                "command receipt requires one succeeded result inside its exact signed lease",
            ));
        }
        let canonical_input = cas
            .get_verified_canonical_bytes(
                &action.canonical_input_ref,
                &action.canonical_input_digest,
            )
            .map_err(|error| {
                action_receipt_authority_rejected(format!(
                    "command receipt canonical input is unavailable or corrupt: {error}"
                ))
            })?;
        let evidence = cas
            .get_verified_canonical_bytes(&result.evidence_ref, &result.evidence_digest)
            .map_err(|error| {
                action_receipt_authority_rejected(format!(
                    "command receipt terminal evidence is unavailable or corrupt: {error}"
                ))
            })?;
        if let (Some(result_ref), Some(result_digest)) = (
            result.result_ref.as_deref(),
            result.result_digest.as_deref(),
        ) {
            cas.get_verified_canonical_bytes(result_ref, result_digest)
                .map_err(|error| {
                    action_receipt_authority_rejected(format!(
                        "command receipt result evidence is unavailable or corrupt: {error}"
                    ))
                })?;
        }

        let result_event_digest = canonical_event_hash(&result_event).map_err(|error| {
            action_receipt_authority_rejected(format!(
                "command receipt could not canonicalize its activity result: {error}"
            ))
        })?;
        let action_receipt_ref = governed_action_receipt_ref_v1(
            request.run_id,
            &action.action_id,
            &action_request_digest,
            &result_event_digest,
        );
        let wall_time_ms = recorded_at
            .signed_duration_since(claimed_at)
            .num_milliseconds()
            .try_into()
            .map_err(|_| {
                action_receipt_authority_rejected(
                    "command receipt signed activity duration is outside the supported range",
                )
            })?;
        let input_bytes = u64::try_from(canonical_input.len()).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt canonical input length is outside the supported range",
            )
        })?;
        let output_bytes = u64::try_from(evidence.len()).map_err(|_| {
            action_receipt_authority_rejected(
                "command receipt evidence length is outside the supported range",
            )
        })?;
        let receipt = ActionReceiptRecordedV2 {
            run_id: action.run_id.clone(),
            workflow_id: action.workflow_id.clone(),
            unit_id: action.unit_id.clone(),
            attempt: action.attempt,
            provenance_ref: action.provenance_ref.clone(),
            action_id: action.action_id.clone(),
            idempotency_key: action.idempotency_key.clone(),
            action_request_digest,
            dispatch_envelope_digest: action.dispatch_envelope_digest.clone(),
            capability_bundle_digest: action.capability_bundle_digest.clone(),
            policy_digest: action.policy_digest.clone(),
            context_manifest_digest: action.context_manifest_digest.clone(),
            worker_manifest_digest: action.worker_manifest_digest.clone(),
            sandbox_profile_digest: action.sandbox_profile_digest.clone(),
            authority_actor: action.authority_actor.clone(),
            execution_role: action.execution_role,
            outcome: ActionReceiptOutcomeV2::Succeeded,
            result_digest: result.result_digest.clone(),
            result_ref: result.result_ref.clone(),
            evidence_digest: result.evidence_digest.clone(),
            evidence_ref: result.evidence_ref.clone(),
            resource_usage: ActionResourceUsageV1 {
                wall_time_ms,
                cpu_time_ms: None,
                peak_memory_bytes: None,
                input_bytes: Some(input_bytes),
                output_bytes: Some(output_bytes),
                input_tokens: None,
                output_tokens: None,
            },
            redactions: Vec::new(),
            failure: None,
            authorization_ref: None,
            action_receipt_ref,
            completed_at: result.recorded_at.clone(),
        };
        let action_receipt_digest =
            action_receipt_recorded_v2_digest(&receipt).map_err(|error| {
                action_receipt_authority_rejected(format!(
                    "command receipt could not derive its canonical digest: {error}"
                ))
            })?;
        let existing_receipt = matching_signed_action_receipt(
            &tx,
            request.run_id,
            receipt_signer,
            activity_authority,
            &action.action_id,
        )?;
        if let Some(receipt_event) = existing_receipt {
            let Payload::ActionReceiptRecordedV2(existing_receipt) = &receipt_event.payload else {
                unreachable!("receipt matcher returns only ActionReceiptRecordedV2")
            };
            if existing_receipt != &receipt
                || receipt_event.parent_event_id != Some(result_event.id)
                || !tape_event_precedes(&result_event, &receipt_event)
            {
                return Err(action_receipt_reconciliation_required(
                    request.run_id,
                    &action.action_id,
                    "existing receipt conflicts with the reconstructed command result",
                ));
            }
            tx.commit()?;
            return Ok(GovernedV5CommandActionReceiptDispositionV1::Existing {
                action_receipt_event_id: receipt_event.id,
                action_receipt_ref: receipt.action_receipt_ref,
                action_receipt_digest,
            });
        }

        let receipt_event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(result_event.id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionReceiptRecordedV2,
            occurred_at: recorded_at,
            payload: Payload::ActionReceiptRecordedV2(receipt.clone()),
        })?;
        validate_new_ordinary_event_id(&tx, &receipt_event)?;
        let receipt_signature = sign_event(&receipt_event, signing_key, receipt_signer, signed_at)?;
        insert_event(&tx, &receipt_event)?;
        insert_event_signature(&tx, &receipt_signature)?;
        tx.commit()?;
        self.record_ordinary_append(&receipt_event);
        Ok(GovernedV5CommandActionReceiptDispositionV1::Recorded {
            action_receipt_event_id: receipt_event.id,
            action_receipt_ref: receipt.action_receipt_ref,
            action_receipt_digest,
        })
    }

    /// Issue or recover the one Git candidate-finalization intent for a sealed
    /// V5 implementer dispatch. A succeeded process receipt must already exist,
    /// while any prematurely sealed receipt set blocks the transition.
    #[allow(clippy::too_many_arguments)]
    pub fn issue_governed_v5_candidate_finalize_action_v1(
        &self,
        request: &GovernedV5CandidateFinalizeActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        receipt_signer: &ActorKeyRef,
        signing_key: &SigningKey,
        action_signer: &ActorKeyRef,
    ) -> Result<GovernedV5CandidateFinalizeActionIssueDispositionV1> {
        self.issue_governed_v5_candidate_finalize_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            receipt_signer,
            signing_key,
            action_signer,
            Utc::now(),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::too_many_arguments)]
    pub fn issue_governed_v5_candidate_finalize_action_v1_at_for_tests(
        &self,
        request: &GovernedV5CandidateFinalizeActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        receipt_signer: &ActorKeyRef,
        signing_key: &SigningKey,
        action_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedV5CandidateFinalizeActionIssueDispositionV1> {
        self.issue_governed_v5_candidate_finalize_action_v1_at(
            request,
            cas,
            v5_authority,
            activity_authority,
            receipt_signer,
            signing_key,
            action_signer,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn issue_governed_v5_candidate_finalize_action_v1_at(
        &self,
        request: &GovernedV5CandidateFinalizeActionIssueRequestV1,
        cas: &Cas,
        v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
        activity_authority: &ActivityClaimAuthorityV1,
        receipt_signer: &ActorKeyRef,
        signing_key: &SigningKey,
        action_signer: &ActorKeyRef,
        now: DateTime<Utc>,
    ) -> Result<GovernedV5CandidateFinalizeActionIssueDispositionV1> {
        require_protected_governed_realm(activity_authority)?;
        validate_action_request_signer(activity_authority, signing_key, action_signer)?;
        let now = canonical_ledger_timestamp(now)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let process_event = load_verified_authority_event(
            &tx,
            request.process_action_request_event_id,
            &activity_authority.trusted_keys,
            &activity_authority.action_request_signer,
            "V5 candidate process action",
        )?;
        if process_event.run_id != request.run_id {
            return Err(command_action_authority_rejected(
                "candidate finalization process action belongs to another run",
            ));
        }
        let dispatch_event_id = process_event.parent_event_id.ok_or_else(|| {
            command_action_authority_rejected(
                "candidate finalization process action has no parent dispatch",
            )
        })?;
        let Payload::ActionRequestedV2(process_action) = &process_event.payload else {
            return Err(command_action_authority_rejected(
                "candidate finalization requires a signed process action request",
            ));
        };
        if process_action.action_kind != ActionKindV1::Process
            || process_action.execution_role != ExecutionRoleV1::Implementer
        {
            return Err(command_action_authority_rejected(
                "candidate finalization requires the protected implementer process action",
            ));
        }
        let admission =
            governed_dispatch_v5_admission_by_source(&tx, request.run_id, dispatch_event_id)?
                .ok_or_else(|| {
                    command_action_authority_rejected(
                        "candidate finalization requires a recorded V5 admission",
                    )
                })?;
        let material = verified_sealed_v5_dispatch_action_material(
            &tx,
            request.run_id,
            dispatch_event_id,
            admission.admission_event_id,
            v5_authority,
            activity_authority,
        )?;
        let dispatch = material.dispatch;
        if dispatch.body.execution_role != ExecutionRoleV1::Implementer
            || process_action.dispatch_envelope_digest != material.lineage_envelope_digest
        {
            return Err(command_action_authority_rejected(
                "candidate finalization process action does not bind its sealed V5 dispatch",
            ));
        }
        let process_receipt = matching_signed_action_receipt(
            &tx,
            request.run_id,
            receipt_signer,
            activity_authority,
            &process_action.action_id,
        )?
        .ok_or_else(|| {
            action_receipt_authority_rejected(
                "candidate finalization requires the succeeded process receipt",
            )
        })?;
        let Payload::ActionReceiptRecordedV2(process_receipt_payload) = &process_receipt.payload
        else {
            unreachable!("receipt matcher returns only ActionReceiptRecordedV2")
        };
        let process_action_digest =
            action_requested_v2_digest(process_action).map_err(|error| {
                action_receipt_authority_rejected(format!(
                    "candidate finalization could not canonicalize process action: {error}"
                ))
            })?;
        if process_receipt_payload.outcome != ActionReceiptOutcomeV2::Succeeded
            || process_receipt_payload.action_request_digest != process_action_digest
            || process_receipt_payload.dispatch_envelope_digest != material.lineage_envelope_digest
            || process_receipt_payload.execution_role != ExecutionRoleV1::Implementer
            || process_receipt_payload.result_digest.is_none()
            || process_receipt_payload.result_ref.is_none()
            || !tape_event_precedes(&process_event, &process_receipt)
        {
            return Err(action_receipt_authority_rejected(
                "candidate finalization process receipt does not close the signed command",
            ));
        }
        if matching_signed_action_receipt_set(
            &tx,
            request.run_id,
            receipt_signer,
            activity_authority,
            process_action,
        )?
        .is_some()
        {
            return Err(action_receipt_reconciliation_required(
                request.run_id,
                &process_action.action_id,
                "candidate finalization found a receipt set sealed before the Git activity",
            ));
        }

        let digest_hex = material
            .lineage_envelope_digest
            .strip_prefix("sha256:")
            .filter(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            .ok_or_else(|| {
                command_action_authority_rejected(
                    "candidate finalization dispatch digest is not canonical sha256",
                )
            })?;
        let candidate_id = format!("c-{digest_hex}");
        let candidate_key = format!(
            "{candidate_id}/{}/{}",
            request.run_id, dispatch.body.attempt
        );
        let candidate_ref = format!("{BUILDPANE_CANDIDATE_REF_PREFIX}{candidate_key}");
        let action_id = format!("{RETRY_CANDIDATE_ACTION_KIND}:{candidate_key}");
        let idempotency_key = format!(
            "{}:{RETRY_CANDIDATE_ACTION_KIND}",
            dispatch.body.idempotency_key
        );
        let input_bytes = serde_json::to_vec(&GovernedV5CandidateFinalizeInputV1 {
            schema_version: 1,
            action: "create-immutable-candidate".into(),
            candidate_id: candidate_id.clone(),
            run_id: request.run_id.to_string(),
            attempt: dispatch.body.attempt,
            candidate_key: candidate_key.clone(),
            candidate_ref: candidate_ref.clone(),
            base_sha: dispatch.body.base_commit_sha.clone(),
        })
        .map_err(|error| {
            command_action_authority_rejected(format!(
                "candidate finalization input cannot be canonicalized: {error}"
            ))
        })?;
        let input_ref = cas.put_canonical_bytes(&input_bytes)?;
        let policy_digest =
            governed_dispatch_policy_digest_v1(&dispatch.body.acceptance_contract_digest)
                .map_err(command_action_authority_rejected)?;
        let expected = ActionRequestedV2 {
            run_id: request.run_id.to_string(),
            workflow_id: dispatch.body.workflow_id.clone(),
            unit_id: dispatch.body.unit_id.clone(),
            attempt: dispatch.body.attempt,
            provenance_ref: dispatch.body.provenance_ref.clone(),
            action_id: action_id.clone(),
            idempotency_key: idempotency_key.clone(),
            action_kind: ActionKindV1::Git,
            canonical_input_digest: input_ref.digest().into(),
            canonical_input_ref: input_ref.to_cas_ref(),
            dispatch_envelope_digest: material.lineage_envelope_digest.clone(),
            repository_binding_digest: dispatch.repository_binding_digest.clone(),
            ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
            governed_packet_digest: dispatch.governed_packet_digest.clone(),
            capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
            policy_digest,
            context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
            worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
            sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
            authority_actor: activity_authority.action_request_signer.actor_id.clone(),
            execution_role: dispatch.body.execution_role,
            requested_at: timestamp(now),
        };

        let mut statement =
            tx.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
        let ids = statement
            .query_map(
                params![
                    request.run_id.to_string(),
                    EventKind::ActionRequestedV2.as_wire()
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut existing = None;
        for raw_id in ids {
            let event_id = parse_event_id(&raw_id, "V5 candidate finalization action")?;
            let event = load_verified_authority_event(
                &tx,
                event_id,
                &activity_authority.trusted_keys,
                &activity_authority.action_request_signer,
                "V5 candidate finalization action",
            )?;
            let Payload::ActionRequestedV2(action) = &event.payload else {
                unreachable!("action request query returns only ActionRequestedV2")
            };
            let action = action.clone();
            if action.action_id != action_id {
                continue;
            }
            if existing.replace((event, action)).is_some() {
                return Err(action_receipt_reconciliation_required(
                    request.run_id,
                    &action_id,
                    "candidate finalization has duplicate signed Git actions",
                ));
            }
        }
        if let Some((event, action)) = existing {
            let mut exact = expected;
            exact.requested_at = action.requested_at.clone();
            if action != exact
                || event.parent_event_id != Some(dispatch_event_id)
                || !tape_event_precedes(&process_receipt, &event)
            {
                return Err(action_receipt_reconciliation_required(
                    request.run_id,
                    &action_id,
                    "existing candidate finalization action conflicts with sealed authority",
                ));
            }
            let action_request_digest = action_requested_v2_digest(&action).map_err(|error| {
                command_action_authority_rejected(format!(
                    "candidate finalization action cannot be canonicalized: {error}"
                ))
            })?;
            tx.commit()?;
            return Ok(
                GovernedV5CandidateFinalizeActionIssueDispositionV1::Existing {
                    action_request_event_id: event.id,
                    action_request_digest,
                    action_id,
                    idempotency_key,
                    candidate_ref,
                },
            );
        }

        validate_governed_dispatch(&dispatch, now).map_err(|error| {
            command_action_authority_rejected(format!(
                "candidate finalization requires a live sealed dispatch: {error}"
            ))
        })?;
        let event = canonicalize(Event {
            id: EventId::new(),
            run_id: request.run_id,
            parent_event_id: Some(dispatch_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionRequestedV2,
            occurred_at: now,
            payload: Payload::ActionRequestedV2(expected.clone()),
        })?;
        if !tape_event_precedes(&process_receipt, &event) {
            return Err(action_receipt_reconciliation_required(
                request.run_id,
                &action_id,
                "candidate finalization action does not follow its process receipt",
            ));
        }
        validate_new_ordinary_event_id(&tx, &event)?;
        let signature = sign_event(&event, signing_key, action_signer, now)?;
        let action_request_digest = action_requested_v2_digest(&expected).map_err(|error| {
            command_action_authority_rejected(format!(
                "candidate finalization action cannot be canonicalized: {error}"
            ))
        })?;
        insert_event(&tx, &event)?;
        insert_event_signature(&tx, &signature)?;
        tx.commit()?;
        self.record_ordinary_append(&event);
        Ok(
            GovernedV5CandidateFinalizeActionIssueDispositionV1::Recorded {
                action_request_event_id: event.id,
                action_request_digest,
                action_id,
                idempotency_key,
                candidate_ref,
            },
        )
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

#[derive(Clone, Copy)]
enum ActivityClaimEvidenceAuthorityV1<'a> {
    V3OrV4,
    SealedV5 {
        admission_event_id: EventId,
        authority: &'a GovernedDispatchV5AdmissionAuthorityV1,
    },
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
        // V5 is deliberately unsupported by storage authority writers until
        // they can verify its complete signed declaration witness set through
        // the authoritative reducer. Never downcast V5 to V4/V3 here: doing
        // so would discard the manifest and retry-context bindings that V5
        // exists to make mandatory before claims, completion, or promotion.
        Payload::DispatchEnvelopeV5(_) => None,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelActionIntentAuthorityLane {
    Implementer,
    Reviewer,
    Existing,
}

impl ModelActionIntentAuthorityLane {
    fn permits_role(self, role: ExecutionRoleV1) -> bool {
        match self {
            Self::Implementer => role == ExecutionRoleV1::Implementer,
            Self::Reviewer => matches!(
                role,
                ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
            ),
            Self::Existing => role != ExecutionRoleV1::Candidate,
        }
    }

    fn permits(self, role: ExecutionRoleV1, has_candidate_binding: bool) -> bool {
        match self {
            Self::Implementer => role == ExecutionRoleV1::Implementer && !has_candidate_binding,
            Self::Reviewer => {
                matches!(
                    role,
                    ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
                ) && has_candidate_binding
            }
            Self::Existing => match role {
                ExecutionRoleV1::Implementer => !has_candidate_binding,
                ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge => {
                    has_candidate_binding
                }
                ExecutionRoleV1::Candidate => false,
            },
        }
    }
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
    lane: ModelActionIntentAuthorityLane,
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
        let existing_intent = verify_signed_model_action_intent_projection(
            conn, &existing, cas, authority, request, lane,
        )?;
        return Ok(ModelActionIntentInTx {
            intent_event_id: existing.intent_event_id,
            intent: existing_intent,
            appended_event: None,
        });
    }

    if lane == ModelActionIntentAuthorityLane::Reviewer {
        return adopt_signed_reviewer_model_action_intent_v1_in_tx(
            conn, request, cas, authority, lane,
        );
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
        verify_model_action_intent_issue_evidence(conn, request, authority, lane, initial_now)?;
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
    let evidence = verify_model_action_intent_issue_evidence(conn, request, authority, lane, now)?;
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

fn validate_action_request_signer(
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let expected = &authority.action_request_signer;
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "append signer does not match the explicitly configured action-request authority"
                    .into(),
        });
    }
    Ok(())
}

fn validate_governed_action_receipt_signer(
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    validate_trusted_actor("action receipt signer", signer)
        .map_err(|error| action_receipt_authority_rejected(error.to_string()))?;
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    let trusted_bytes = authority
        .trusted_keys
        .public_key_for(signer)
        .ok_or_else(|| action_receipt_authority_rejected("action receipt signer is not trusted"))?;
    if signer.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
        || trusted_bytes != signing_key.verifying_key().as_bytes()
        || actor_matches(signer, &authority.dispatch_signer)
        || actor_matches(signer, &authority.action_request_signer)
        || actor_matches(signer, &authority.claim_signer)
    {
        return Err(action_receipt_authority_rejected(
            "action receipt signer must be one distinct trusted protected-host identity",
        ));
    }
    Ok(())
}

fn action_receipt_authority_rejected(reason: impl Into<String>) -> LedgerError {
    LedgerError::ActionReceiptAuthorityRejected {
        reason: reason.into(),
    }
}

fn action_receipt_reconciliation_required(
    run_id: RunId,
    action_id: &str,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::ActionReceiptReconciliationRequired {
        run_id: run_id.to_string(),
        action_id: action_id.into(),
        reason: reason.into(),
    }
}

fn governed_action_receipt_ref_v1(
    run_id: RunId,
    action_id: &str,
    action_request_digest: &str,
    result_event_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.governed-action-receipt-ref.v1\0");
    let run_id = run_id.to_string();
    for value in [
        run_id.as_str(),
        action_id,
        action_request_digest,
        result_event_digest,
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!(
        "buildplane:action-receipt:v2:sha256:{:x}",
        hasher.finalize()
    )
}

fn governed_action_receipt_set_ref_v1(
    run_id: RunId,
    dispatch_envelope_digest: &str,
    action_receipt_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"buildplane.governed-action-receipt-set-ref.v1\0");
    let run_id = run_id.to_string();
    for value in [
        run_id.as_str(),
        dispatch_envelope_digest,
        action_receipt_digest,
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!(
        "buildplane:action-receipt-set:v1:sha256:{:x}",
        hasher.finalize()
    )
}

#[allow(clippy::too_many_arguments)]
fn unique_signed_child_event(
    conn: &Connection,
    run_id: RunId,
    parent_event_id: EventId,
    kind: EventKind,
    authority: &ActivityClaimAuthorityV1,
    signer: &ActorKeyRef,
    action_id: &str,
    label: &str,
) -> Result<Event> {
    let mut statement = conn.prepare(
        "SELECT id FROM events \
         WHERE run_id = ?1 AND kind = ?2 AND parent_event_id = ?3 \
         ORDER BY id ASC",
    )?;
    let ids = statement
        .query_map(
            params![
                run_id.to_string(),
                kind.as_wire(),
                parent_event_id.to_string()
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    let [raw_id] = ids.as_slice() else {
        return if ids.is_empty() {
            Err(action_receipt_authority_rejected(format!(
                "{label} is missing"
            )))
        } else {
            Err(action_receipt_reconciliation_required(
                run_id,
                action_id,
                format!("{label} has duplicate signed children"),
            ))
        };
    };
    let event_id = parse_event_id(raw_id, label)?;
    load_verified_authority_event(conn, event_id, &authority.trusted_keys, signer, label).map_err(
        |error| action_receipt_authority_rejected(format!("{label} is not trusted: {error}")),
    )
}

fn signed_events_for_run_kind_by_signer(
    conn: &Connection,
    run_id: RunId,
    kind: EventKind,
    authority: &ActivityClaimAuthorityV1,
    signer: &ActorKeyRef,
    label: &str,
) -> Result<Vec<Event>> {
    let mut statement =
        conn.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
    let ids = statement
        .query_map(params![run_id.to_string(), kind.as_wire()], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    ids.into_iter()
        .map(|raw_id| {
            let event_id = parse_event_id(&raw_id, label)?;
            load_verified_authority_event(conn, event_id, &authority.trusted_keys, signer, label)
                .map_err(|error| {
                    action_receipt_authority_rejected(format!("{label} is not trusted: {error}"))
                })
        })
        .collect()
}

fn matching_signed_action_receipt(
    conn: &Connection,
    run_id: RunId,
    receipt_signer: &ActorKeyRef,
    authority: &ActivityClaimAuthorityV1,
    action_id: &str,
) -> Result<Option<Event>> {
    let mut matching = signed_events_for_run_kind_by_signer(
        conn,
        run_id,
        EventKind::ActionReceiptRecordedV2,
        authority,
        receipt_signer,
        "V5 command action receipt",
    )?
    .into_iter()
    .filter(|event| {
        matches!(
            &event.payload,
            Payload::ActionReceiptRecordedV2(receipt) if receipt.action_id == action_id
        )
    });
    let first = matching.next();
    if matching.next().is_some() {
        return Err(action_receipt_reconciliation_required(
            run_id,
            action_id,
            "multiple signed receipts name the same action",
        ));
    }
    Ok(first)
}

fn matching_signed_action_receipt_set(
    conn: &Connection,
    run_id: RunId,
    receipt_signer: &ActorKeyRef,
    authority: &ActivityClaimAuthorityV1,
    action: &ActionRequestedV2,
) -> Result<Option<Event>> {
    let mut matching = signed_events_for_run_kind_by_signer(
        conn,
        run_id,
        EventKind::ActionReceiptSetRecordedV1,
        authority,
        receipt_signer,
        "V5 command action receipt set",
    )?
    .into_iter()
    .filter(|event| {
        matches!(
            &event.payload,
            Payload::ActionReceiptSetRecordedV1(set)
                if set.workflow_id == action.workflow_id
                    && set.unit_id == action.unit_id
                    && set.attempt == action.attempt
                    && set.dispatch_envelope_digest == action.dispatch_envelope_digest
        )
    });
    let first = matching.next();
    if matching.next().is_some() {
        return Err(action_receipt_reconciliation_required(
            run_id,
            &action.action_id,
            "multiple signed receipt sets name the same workflow attempt",
        ));
    }
    Ok(first)
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

fn governed_dispatch_admission_authority_rejected<T>(reason: impl Into<String>) -> Result<T> {
    Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected {
        reason: reason.into(),
    })
}

fn governed_dispatch_admission_reconciliation_required(
    request: &GovernedDispatchAdmissionRequestV1,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::GovernedDispatchAdmissionReconciliationRequired {
        run_id: request.run_id.to_string(),
        idempotency_key: request.dispatch.body.idempotency_key.clone(),
        reason: reason.into(),
    }
}

fn validate_governed_dispatch_admission_trusted_actor(
    label: &str,
    actor: &ActorKeyRef,
) -> Result<()> {
    if actor.actor_id.trim().is_empty() || actor.key_id.trim().is_empty() {
        return governed_dispatch_admission_authority_rejected(format!(
            "{label} must include non-empty actor_id and key_id"
        ));
    }
    let Some(public_key_hash) = actor.public_key_hash.as_deref() else {
        return governed_dispatch_admission_authority_rejected(format!(
            "{label} must include an explicit public_key_hash"
        ));
    };
    if !is_canonical_sha256_digest(public_key_hash) {
        return governed_dispatch_admission_authority_rejected(format!(
            "{label} public_key_hash must be a canonical sha256 digest"
        ));
    }
    Ok(())
}

fn validate_governed_dispatch_admission_dispatch_signer(
    authority: &GovernedDispatchAdmissionAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    let expected = &authority.dispatch_signer;
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return governed_dispatch_admission_authority_rejected(
            "append signer does not match the explicitly configured dispatch admission authority",
        );
    }
    Ok(())
}

fn validate_governed_dispatch_admission_checkpoint_signer(
    authority: &GovernedDispatchAdmissionAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    let expected = &authority.checkpoint_signer;
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return governed_dispatch_admission_authority_rejected(
            "checkpoint signer does not match the explicitly configured governed admission checkpoint authority",
        );
    }
    Ok(())
}

fn validate_governed_dispatch_v5_admission_record_signer(
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    let expected = &authority.admission_record_signer;
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return governed_dispatch_admission_authority_rejected(
            "append signer does not match the explicitly configured governed V5 admission-record authority",
        );
    }
    Ok(())
}

fn validate_governed_dispatch_v5_admission_checkpoint_signer(
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    let actual_public_key_hash = public_key_hash(&signing_key.verifying_key());
    let expected = &authority.checkpoint_signer;
    if signer.actor_id != expected.actor_id
        || signer.key_id != expected.key_id
        || expected.public_key_hash.as_deref() != Some(actual_public_key_hash.as_str())
    {
        return governed_dispatch_admission_authority_rejected(
            "checkpoint signer does not match the explicitly configured governed V5 admission checkpoint authority",
        );
    }
    Ok(())
}

fn validate_governed_dispatch_admission_request(
    request: &GovernedDispatchAdmissionRequestV1,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<()> {
    let dispatch = &request.dispatch;
    let body = &dispatch.body;
    if body.workflow_id.trim().is_empty()
        || body.workflow_revision.trim().is_empty()
        || body.unit_id.trim().is_empty()
        || body.idempotency_key.trim().is_empty()
        || body.attempt == 0
    {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission requires non-empty workflow, revision, unit, idempotency key, and a positive attempt",
        );
    }
    let Some(governed_packet_digest) = dispatch.governed_packet_digest.as_deref() else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission requires a governed packet digest",
        );
    };
    if dispatch.body.execution_role != ExecutionRoleV1::Implementer
        || dispatch.body.trust_tier != TrustTierV1::Governed
        || dispatch.body.commit_mode != CommitModeV1::Atomic
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        || dispatch.ledger_authority_realm_digest != authority.ledger_authority_realm_digest
        || !is_canonical_sha256_digest(&dispatch.repository_binding_digest)
        || !is_canonical_sha256_digest(&dispatch.ledger_authority_realm_digest)
        || !is_canonical_sha256_digest(governed_packet_digest)
    {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission requires a sealed-V3 governed atomic implementer dispatch in the configured protected realm",
        );
    }
    let expected_envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .map_err(
        |error| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: format!("could not canonicalize governed V3 dispatch envelope: {error}"),
        },
    )?;
    if dispatch.envelope_digest != expected_envelope_digest {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission envelope digest does not match its immutable V3 authority material",
        );
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

fn verified_sealed_v5_dispatch_action_material(
    tx: &Transaction<'_>,
    run_id: RunId,
    dispatch_event_id: EventId,
    admission_event_id: EventId,
    v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
    activity_authority: &ActivityClaimAuthorityV1,
) -> Result<DispatchAuthorityMaterialV1> {
    require_protected_governed_realm(activity_authority)?;
    if activity_authority.ledger_authority_realm_digest.as_deref()
        != Some(v5_authority.ledger_authority_realm_digest.as_str())
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "V5 admission and activity authorities do not name the same protected host realm"
                    .into(),
        });
    }
    if !actor_matches(
        &v5_authority.source_dispatch_signer,
        &activity_authority.dispatch_signer,
    ) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "V5 admission and activity authorities do not trust the same source-dispatch signer"
                    .into(),
        });
    }

    let stored = governed_dispatch_v5_admission_by_admission_event(tx, run_id, admission_event_id)?
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "V5 command issuance requires a recorded admission receipt for this run".into(),
        })?;
    if stored.source_dispatch_event_id != dispatch_event_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "V5 admission receipt belongs to a different source dispatch".into(),
        });
    }
    if stored.state != StoredGovernedDispatchV5AdmissionState::Sealed {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "V5 command issuance requires a checkpoint-sealed admission receipt".into(),
        });
    }

    let evidence = verify_stored_governed_dispatch_v5_admission(tx, &stored, v5_authority)?;
    let _checkpoint = sealed_governed_dispatch_v5_admission_checkpoint(tx, &stored, v5_authority)?;
    if evidence.run_id != run_id
        || evidence.dispatch_event_id != dispatch_event_id
        || evidence.dispatch_event_digest != stored.source_dispatch_event_digest
        || evidence.v5_envelope_digest != stored.v5_envelope_digest
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            &stored.idempotency_key,
            "sealed V5 admission re-derived different source dispatch authority",
        ));
    }

    let source_event = load_verified_authority_event(
        tx,
        dispatch_event_id,
        &v5_authority.trusted_keys,
        &v5_authority.source_dispatch_signer,
        "sealed V5 command source dispatch",
    )?;
    if source_event.run_id != run_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "sealed V5 command source dispatch belongs to another run".into(),
        });
    }
    let source_event_digest = canonical_event_hash(&source_event)?;
    if source_event_digest != stored.source_dispatch_event_digest {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            &stored.idempotency_key,
            "sealed V5 admission source event digest no longer matches the signed tape",
        ));
    }
    let Payload::DispatchEnvelopeV5(dispatch_v5) = source_event.payload else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "sealed V5 admission source is not a V5 dispatch envelope".into(),
        });
    };
    let recomputed_v5_digest = dispatch_envelope_v5_digest(&dispatch_v5).map_err(|error| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: format!(
                "sealed V5 command source envelope could not be canonicalized: {error}"
            ),
        }
    })?;
    if recomputed_v5_digest != dispatch_v5.envelope_digest
        || dispatch_v5.envelope_digest != stored.v5_envelope_digest
        || dispatch_v5.envelope_digest != evidence.v5_envelope_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "sealed V5 command source envelope digest is substituted or corrupt".into(),
        });
    }

    let dispatch_v3 = dispatch_v5.dispatch_v4.dispatch_v3.clone();
    if dispatch_v3.ledger_authority_realm_digest != v5_authority.ledger_authority_realm_digest
        || dispatch_v5.context_manifest_digest != dispatch_v3.body.context_manifest_digest
        || dispatch_v5.worker_manifest_digest != dispatch_v3.body.worker_manifest_digest
        || dispatch_v5.sandbox_profile_digest != dispatch_v3.body.sandbox_profile_digest
        || dispatch_v5.context_manifest_digest != evidence.context_manifest_digest
        || dispatch_v5.worker_manifest_digest != evidence.worker_manifest_digest
        || dispatch_v5.sandbox_profile_digest != evidence.sandbox_profile_digest
        || dispatch_v5.dispatch_v4.envelope_digest != evidence.v4_envelope_digest
        || dispatch_v5.dispatch_v4.workflow_graph_digest != evidence.v4_graph_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "sealed V5 command source does not exactly bind its admitted realm and witnesses"
                    .into(),
        });
    }

    Ok(DispatchAuthorityMaterialV1 {
        dispatch: dispatch_v3,
        lineage_envelope_digest: dispatch_v5.envelope_digest,
        is_graph_bound_v4: true,
    })
}

struct GovernedCommandActionIssueInTx {
    disposition: GovernedCommandActionIssueDispositionV1,
    appended_event: Option<Event>,
}

fn verified_governed_command_packet_for_dispatch(
    packet_source: &str,
    dispatch: &DispatchEnvelopeV3,
) -> Result<GovernedCommandPacketV1> {
    let governed_packet_digest = dispatch.governed_packet_digest.as_deref().ok_or_else(|| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed command dispatch does not bind a normalized packet".into(),
        }
    })?;
    let packet = GovernedCommandPacketV1::parse_and_verify(packet_source, governed_packet_digest)
        .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
        reason: format!("governed command packet authority is invalid: {error}"),
    })?;
    if packet.unit.id != dispatch.body.unit_id
        || packet.execution_role != dispatch.body.execution_role
        || packet.provenance_ref != dispatch.body.provenance_ref
        || packet.capability_bundle_digest != dispatch.body.capability_bundle_digest
        || packet.acceptance_contract_digest()? != dispatch.body.acceptance_contract_digest
    {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed command packet does not exactly bind the signed dispatch authority"
                .into(),
        });
    }
    Ok(packet)
}

#[allow(clippy::too_many_arguments)]
fn issue_governed_command_action_from_dispatch_in_tx(
    tx: &Transaction<'_>,
    run_id: RunId,
    dispatch_event_id: EventId,
    packet_source: &str,
    dispatch_material: DispatchAuthorityMaterialV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    now: DateTime<Utc>,
) -> Result<GovernedCommandActionIssueInTx> {
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    let packet = verified_governed_command_packet_for_dispatch(packet_source, &dispatch)?;
    let governed_packet_digest = packet.canonical_digest()?;
    let action_id = format!(
        "governed:{}:{}",
        run_id,
        dispatch_envelope_digest
            .strip_prefix("sha256:")
            .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed command dispatch digest is not canonical sha256".into(),
            })?
    );
    let idempotency_key = format!("{}:command", dispatch.body.idempotency_key);
    let input = CanonicalCommandActionInputV1::new(
        run_id.to_string(),
        action_id.clone(),
        packet.execution.command.clone(),
        packet.command_args().to_vec(),
        packet.execution.cwd.clone(),
    )
    .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
        reason: format!("governed command executable material is invalid: {error}"),
    })?;
    let input_bytes = canonical_command_action_input_v1_bytes(&input).map_err(|error| {
        LedgerError::ActivityClaimAuthorityRejected {
            reason: format!("governed command executable could not be canonicalized: {error}"),
        }
    })?;
    let input_ref = cas.put_canonical_bytes(&input_bytes)?;
    let verified_input = parse_verified_canonical_command_action_input_v1(
        &input_bytes,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    )?;
    let policy_digest = governed_dispatch_policy_digest_v1(
        &dispatch.body.acceptance_contract_digest,
    )
    .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
        reason: format!("governed command policy binding could not be derived: {error}"),
    })?;
    let expected_action = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.clone(),
        idempotency_key: idempotency_key.clone(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: input_ref.digest().into(),
        canonical_input_ref: input_ref.to_cas_ref(),
        dispatch_envelope_digest: dispatch_envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: Some(governed_packet_digest),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest,
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: authority.action_request_signer.actor_id.clone(),
        execution_role: dispatch.body.execution_role,
        requested_at: timestamp(now),
    };

    let mut statement =
        tx.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
    let ids = statement
        .query_map(
            params![run_id.to_string(), EventKind::ActionRequestedV2.as_wire()],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    let mut existing = None;
    for id in ids {
        let event_id = parse_event_id(&id, "governed command action")?;
        let event = load_verified_authority_event(
            tx,
            event_id,
            &authority.trusted_keys,
            &authority.action_request_signer,
            "governed command action",
        )?;
        let action = match &event.payload {
            Payload::ActionRequestedV2(action) => action.clone(),
            _ => unreachable!("action-request query returns only action_requested_v2 events"),
        };
        if action.action_id != action_id {
            continue;
        }
        if existing.replace((event, action)).is_some() {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed command dispatch has duplicate signed action requests".into(),
            });
        }
    }
    if let Some((event, action)) = existing {
        let mut expected = expected_action;
        expected.requested_at = action.requested_at.clone();
        let requested_at = parse_claim_timestamp(&action.requested_at)?;
        let dispatch_window = validate_governed_dispatch(&dispatch, requested_at)?;
        let claim = ActivityClaimRequestV1 {
            run_id,
            activity_id: action_id,
            idempotency_key,
            dispatch_event_id,
            action_request_event_id: event.id,
            lease_duration_ms: MIN_ACTIVITY_LEASE_MS,
        };
        validate_action_request_matches_dispatch(
            &claim,
            &action,
            &dispatch,
            &dispatch_envelope_digest,
            authority,
            dispatch_window.issued_at,
            requested_at,
        )?;
        if event.parent_event_id != Some(dispatch_event_id)
            || event.occurred_at != requested_at
            || action != expected
        {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "existing governed command action conflicts with verified packet authority"
                    .into(),
            });
        }
        return Ok(GovernedCommandActionIssueInTx {
            disposition: GovernedCommandActionIssueDispositionV1::Existing {
                action_request_event_id: event.id,
                canonical_input_ref: action.canonical_input_ref,
                canonical_input_digest: action.canonical_input_digest,
                verified_input,
            },
            appended_event: None,
        });
    }

    let dispatch_window = validate_governed_dispatch(&dispatch, now)?;
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: action_id,
        idempotency_key,
        dispatch_event_id,
        action_request_event_id: EventId::new(),
        lease_duration_ms: MIN_ACTIVITY_LEASE_MS,
    };
    validate_action_request_matches_dispatch(
        &claim,
        &expected_action,
        &dispatch,
        &dispatch_envelope_digest,
        authority,
        dispatch_window.issued_at,
        now,
    )?;
    let event = canonicalize(Event {
        id: claim.action_request_event_id,
        run_id,
        parent_event_id: Some(dispatch_event_id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(expected_action.clone()),
    })?;
    validate_new_ordinary_event_id(tx, &event)?;
    let signature = sign_event(&event, signing_key, signer, now)?;
    insert_event(tx, &event)?;
    insert_event_signature(tx, &signature)?;
    Ok(GovernedCommandActionIssueInTx {
        disposition: GovernedCommandActionIssueDispositionV1::Issued {
            action_request_event_id: event.id,
            canonical_input_ref: expected_action.canonical_input_ref,
            canonical_input_digest: expected_action.canonical_input_digest,
            verified_input,
        },
        appended_event: Some(event),
    })
}

fn reconstruct_governed_command_action(
    conn: &Connection,
    request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<(
    ActivityClaimRequestV1,
    VerifiedCommandIntentEvidenceDocumentV1,
)> {
    reconstruct_governed_command_action_with_verifier(conn, request, cas, authority, |claim| {
        verify_claim_evidence(conn, claim, authority, now).map_err(|error| {
            command_action_authority_rejected(format!(
                "command action does not bind active signed dispatch authority: {error}",
            ))
        })?;
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_governed_v5_candidate_finalize_claim_v1(
    conn: &Connection,
    request: &GovernedV5CandidateFinalizeAuthorizeAndClaimRequestV1,
    cas: &Cas,
    v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
    activity_authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<ActivityClaimRequestV1> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let action_event = load_verified_authority_event(
        &tx,
        request.action_request_event_id,
        &activity_authority.trusted_keys,
        &activity_authority.action_request_signer,
        "V5 candidate finalization action",
    )?;
    if action_event.run_id != request.run_id
        || action_event.parent_event_id != Some(request.dispatch_event_id)
    {
        return Err(command_action_authority_rejected(
            "candidate finalization action does not bind the requested run and dispatch",
        ));
    }
    let Payload::ActionRequestedV2(action) = &action_event.payload else {
        return Err(command_action_authority_rejected(
            "candidate finalization requires ActionRequestedV2",
        ));
    };
    let action = action.clone();
    let material = verified_sealed_v5_dispatch_action_material(
        &tx,
        request.run_id,
        request.dispatch_event_id,
        request.admission_event_id,
        v5_authority,
        activity_authority,
    )?;
    let bytes = cas.get_verified_canonical_bytes(
        &action.canonical_input_ref,
        &action.canonical_input_digest,
    )?;
    let input: GovernedV5CandidateFinalizeInputV1 =
        serde_json::from_slice(&bytes).map_err(|error| {
            command_action_authority_rejected(format!(
                "candidate finalization CAS input is invalid: {error}",
            ))
        })?;
    let canonical = serde_json::to_vec(&input).map_err(|error| {
        command_action_authority_rejected(format!(
            "candidate finalization CAS input cannot be canonicalized: {error}",
        ))
    })?;
    let dispatch_envelope_digest = material.lineage_envelope_digest.clone();
    let dispatch = material.dispatch;
    validate_governed_dispatch(&dispatch, now).map_err(|error| {
        command_action_authority_rejected(format!(
            "candidate finalization requires live sealed authority: {error}",
        ))
    })?;
    let candidate_suffix = input
        .candidate_ref
        .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
        .ok_or_else(|| {
            command_action_authority_rejected("candidate finalization input has an invalid ref")
        })?;
    if canonical != bytes
        || input.schema_version != 1
        || input.action != "create-immutable-candidate"
        || input.run_id != request.run_id.to_string()
        || input.attempt != dispatch.body.attempt
        || input.candidate_key != candidate_suffix
        || input.candidate_ref != format!("{BUILDPANE_CANDIDATE_REF_PREFIX}{}", input.candidate_key)
        || input.candidate_key
            != format!(
                "{}/{}/{}",
                input.candidate_id, request.run_id, dispatch.body.attempt
            )
        || input.base_sha != dispatch.body.base_commit_sha
        || action.action_kind != ActionKindV1::Git
        || action.execution_role != ExecutionRoleV1::Implementer
        || action.action_id != format!("{RETRY_CANDIDATE_ACTION_KIND}:{candidate_suffix}")
        || action.idempotency_key
            != format!(
                "{}:{RETRY_CANDIDATE_ACTION_KIND}",
                dispatch.body.idempotency_key
            )
        || action.dispatch_envelope_digest != dispatch_envelope_digest
    {
        return Err(command_action_authority_rejected(
            "candidate finalization action or CAS input was substituted",
        ));
    }
    let claim = ActivityClaimRequestV1 {
        run_id: request.run_id,
        activity_id: action.action_id,
        idempotency_key: action.idempotency_key,
        dispatch_event_id: request.dispatch_event_id,
        action_request_event_id: request.action_request_event_id,
        lease_duration_ms: request.lease_duration_ms,
    };
    tx.commit()?;
    Ok(claim)
}

#[allow(clippy::too_many_arguments)]
fn record_reconstructed_v5_activity_result_in_tx(
    store: &SqliteStore,
    stored: &StoredActivityClaim,
    request: &ActivityResultRequestV1,
    authority: &ActivityClaimAuthorityV1,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
    now: DateTime<Utc>,
    lane: &str,
) -> Result<ActivityResultDispositionV1> {
    let tx = Transaction::new_unchecked(&store.conn, TransactionBehavior::Immediate)?;
    let current = activity_claim_by_idempotency(&tx, request.run_id, &stored.idempotency_key)?
        .ok_or_else(|| LedgerError::ActivityClaimNotFound {
            run_id: request.run_id.to_string(),
            idempotency_key: stored.idempotency_key.clone(),
        })?;
    verify_signed_claim_projection(&tx, &current, authority)?;
    if current.claim_event_id != stored.claim_event_id
        || current.claim_event_digest != stored.claim_event_digest
        || current.activity_id != stored.activity_id
        || current.action_request_event_id != stored.action_request_event_id
        || current.dispatch_event_id != stored.dispatch_event_id
        || current.lease_id != stored.lease_id
        || current.lease_expires_at != stored.lease_expires_at
    {
        return Err(command_action_authority_rejected(format!(
            "{lane} result claim changed during authority reconstruction",
        )));
    }
    if current.state == StoredActivityClaimState::Recorded {
        verify_signed_activity_result_projection(&tx, &current, authority)?;
        let disposition = existing_result_disposition(&current, request)?;
        tx.commit()?;
        return Ok(disposition);
    }
    if current.lease_id != request.lease_id {
        return Err(LedgerError::ActivityClaimLeaseMismatch {
            run_id: request.run_id.to_string(),
            idempotency_key: current.idempotency_key,
        });
    }
    let lease_expires_at = parse_claim_timestamp(&current.lease_expires_at)?;
    if now >= lease_expires_at && request.outcome != ActivityResultOutcomeV1::Unknown {
        tx.commit()?;
        return Ok(ActivityResultDispositionV1::LeaseExpired {
            claim_event_id: current.claim_event_id,
            lease_expires_at: timestamp(lease_expires_at),
        });
    }
    let now = canonical_ledger_timestamp(now)?;
    let recorded_at = timestamp(now);
    let event = canonicalize(Event {
        id: EventId::new(),
        run_id: request.run_id,
        parent_event_id: Some(current.claim_event_id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActivityResultRecordedV1,
        occurred_at: now,
        payload: Payload::ActivityResultRecordedV1(ActivityResultRecordedV1 {
            run_id: request.run_id,
            activity_id: current.activity_id.clone(),
            idempotency_key: current.idempotency_key.clone(),
            claim_event_id: current.claim_event_id,
            claim_event_digest: current.claim_event_digest.clone(),
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
            &current.idempotency_key,
        ],
    )?;
    if updated != 1 {
        return Err(command_action_authority_rejected(format!(
            "{lane} result did not close exactly one granted lease",
        )));
    }
    tx.commit()?;
    store.record_ordinary_append(&event);
    Ok(ActivityResultDispositionV1::Recorded {
        result_event_id: event.id,
        result_event_digest,
        outcome: request.outcome,
    })
}

fn reconstruct_governed_v5_command_action(
    conn: &Connection,
    request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
    admission_event_id: EventId,
    cas: &Cas,
    v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
    activity_authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<(
    ActivityClaimRequestV1,
    VerifiedCommandIntentEvidenceDocumentV1,
)> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let reconstructed = reconstruct_governed_v5_command_action_in_tx(
        &tx,
        request,
        admission_event_id,
        cas,
        v5_authority,
        activity_authority,
        now,
    )?;
    tx.commit()?;
    Ok(reconstructed)
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_governed_v5_command_action_in_tx(
    tx: &Transaction<'_>,
    request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
    admission_event_id: EventId,
    cas: &Cas,
    v5_authority: &GovernedDispatchV5AdmissionAuthorityV1,
    activity_authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
) -> Result<(
    ActivityClaimRequestV1,
    VerifiedCommandIntentEvidenceDocumentV1,
)> {
    let reconstructed = reconstruct_governed_command_action_with_verifier(
        tx,
        request,
        cas,
        activity_authority,
        |claim| {
            let dispatch_material = verified_sealed_v5_dispatch_action_material(
                tx,
                claim.run_id,
                claim.dispatch_event_id,
                admission_event_id,
                v5_authority,
                activity_authority,
            )?;
            let dispatch_event = load_verified_authority_event(
                tx,
                claim.dispatch_event_id,
                &activity_authority.trusted_keys,
                &activity_authority.dispatch_signer,
                "sealed V5 command reconstruction dispatch",
            )?;
            verify_claim_evidence_from_dispatch_material(
                tx,
                claim,
                activity_authority,
                now,
                &dispatch_event,
                dispatch_material,
            )
            .map_err(|error| {
                command_action_authority_rejected(format!(
                    "V5 command action does not bind active sealed admission authority: {error}",
                ))
            })?;
            Ok(())
        },
    )?;
    Ok(reconstructed)
}

fn reconstruct_governed_command_action_with_verifier(
    conn: &Connection,
    request: &GovernedCommandActionAuthorizeAndClaimRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    verify_claim_authority: impl FnOnce(&ActivityClaimRequestV1) -> Result<()>,
) -> Result<(
    ActivityClaimRequestV1,
    VerifiedCommandIntentEvidenceDocumentV1,
)> {
    let action_event = load_verified_authority_event(
        conn,
        request.action_request_event_id,
        &authority.trusted_keys,
        &authority.action_request_signer,
        "governed command action request",
    )
    .map_err(|error| {
        command_action_authority_rejected(format!(
            "could not verify the signed command action request: {error}",
        ))
    })?;
    if action_event.run_id != request.run_id {
        return Err(command_action_authority_rejected(
            "command action request run_id does not match the authority request",
        ));
    }
    if action_event.parent_event_id != Some(request.dispatch_event_id) {
        return Err(command_action_authority_rejected(
            "command action request does not name the selected dispatch as parent",
        ));
    }
    let action = match action_event.payload {
        Payload::ActionRequestedV2(action) => action,
        _ => {
            return Err(command_action_authority_rejected(
                "command authority requires a signed action_requested_v2 event",
            ));
        }
    };
    if action.action_kind != ActionKindV1::Process {
        return Err(command_action_authority_rejected(
            "command authority accepts only process actions",
        ));
    }
    if action.execution_role != ExecutionRoleV1::Implementer {
        return Err(command_action_authority_rejected(
            "command authority requires the signed implementer role",
        ));
    }

    let claim = ActivityClaimRequestV1 {
        run_id: request.run_id,
        activity_id: action.action_id.clone(),
        idempotency_key: action.idempotency_key.clone(),
        dispatch_event_id: request.dispatch_event_id,
        action_request_event_id: request.action_request_event_id,
        lease_duration_ms: request.lease_duration_ms,
    };
    verify_claim_authority(&claim)?;

    let input_bytes = cas
        .get_verified_canonical_bytes(&action.canonical_input_ref, &action.canonical_input_digest)
        .map_err(|error| {
            command_action_authority_rejected(format!(
                "command canonical input is unavailable or corrupt: {error}",
            ))
        })?;
    let verified_input = parse_verified_canonical_command_action_input_v1(
        &input_bytes,
        &action.canonical_input_ref,
        &action.canonical_input_digest,
    )
    .map_err(|error| {
        command_action_authority_rejected(format!(
            "command canonical input is not closed executable evidence: {error}",
        ))
    })?;
    let binding = CommandActionEvidenceBindingV1::from_action_requested_v2(
        &action,
        request.dispatch_event_id,
        request.action_request_event_id,
    )
    .map_err(|error| {
        command_action_authority_rejected(format!(
            "command evidence binding could not be reconstructed: {error}",
        ))
    })?;
    let intent =
        CommandIntentEvidenceDocumentV1::from_verified_canonical_input(binding, &verified_input)
            .map_err(|error| {
                command_action_authority_rejected(format!(
                    "command executable material does not match signed action identity: {error}",
                ))
            })?;
    let intent_bytes = command_intent_evidence_document_v1_bytes(&intent).map_err(|error| {
        command_action_authority_rejected(format!(
            "command intent evidence could not be canonicalized: {error}",
        ))
    })?;
    let intent_ref = cas.put_canonical_bytes(&intent_bytes).map_err(|error| {
        command_action_authority_rejected(format!(
            "command intent evidence could not be durably stored: {error}",
        ))
    })?;
    let verified_intent = parse_verified_command_intent_evidence_document_v1(
        &intent_bytes,
        &intent_ref.to_cas_ref(),
        intent_ref.digest(),
    )
    .map_err(|error| {
        command_action_authority_rejected(format!(
            "stored command intent evidence failed verification: {error}",
        ))
    })?;
    Ok((claim, verified_intent))
}

fn governed_command_claim_disposition(
    disposition: ActivityClaimDispositionV1,
    command_intent: VerifiedCommandIntentEvidenceDocumentV1,
) -> GovernedCommandActionAuthorizeAndClaimDispositionV1 {
    match disposition {
        ActivityClaimDispositionV1::Granted {
            claim_event_id,
            claim_event_digest,
            lease_id,
            lease_expires_at,
        } => GovernedCommandActionAuthorizeAndClaimDispositionV1::Granted {
            claim_event_id,
            claim_event_digest,
            lease_id,
            lease_expires_at,
            command_intent,
        },
        ActivityClaimDispositionV1::Pending {
            claim_event_id,
            lease_expires_at,
        } => GovernedCommandActionAuthorizeAndClaimDispositionV1::Pending {
            claim_event_id,
            lease_expires_at,
        },
        ActivityClaimDispositionV1::Recorded {
            claim_event_id,
            result_event_id,
            result_event_digest,
            outcome,
        } => GovernedCommandActionAuthorizeAndClaimDispositionV1::Recorded {
            claim_event_id,
            result_event_id,
            result_event_digest,
            outcome,
        },
        ActivityClaimDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => GovernedCommandActionAuthorizeAndClaimDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        },
    }
}

fn command_action_authority_rejected(reason: impl Into<String>) -> LedgerError {
    LedgerError::ActivityClaimAuthorityRejected {
        reason: format!(
            "governed command action authority rejected: {}",
            reason.into()
        ),
    }
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
    verify_claim_evidence_from_dispatch_material(
        conn,
        request,
        authority,
        now,
        &dispatch_event,
        dispatch_material,
    )
}

fn verify_claim_evidence_from_dispatch_material(
    conn: &Connection,
    request: &ActivityClaimRequestV1,
    authority: &ActivityClaimAuthorityV1,
    now: DateTime<Utc>,
    dispatch_event: &Event,
    dispatch_material: DispatchAuthorityMaterialV1,
) -> Result<VerifiedClaimEvidence> {
    if dispatch_event.run_id != request.run_id || dispatch_event.id != request.dispatch_event_id {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "verified dispatch event does not match the activity claim".into(),
        });
    }
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
            });
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
    verify_governed_v3_retry_candidate_claim_identity(
        conn,
        request,
        authority,
        dispatch_event,
        &dispatch,
        &action_request,
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

/// A retry candidate-create Git effect has a durable context-bound identity.
/// The generic claim lane normally accepts arbitrary Git work, but it must not
/// turn a caller-selected retry namespace into a lease for the action that
/// materializes an immutable candidate. Reuse the same complete, signed V3
/// predecessor proof as candidate completion before minting that effect.
fn verify_governed_v3_retry_candidate_claim_identity(
    conn: &Connection,
    request: &ActivityClaimRequestV1,
    authority: &ActivityClaimAuthorityV1,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    action_request: &ActionRequestedV2,
) -> Result<()> {
    let looks_like_candidate_create = action_request.action_kind == ActionKindV1::Git
        && (action_request
            .action_id
            .starts_with("git-candidate-create:")
            || action_request.action_id.contains(":git-candidate-create:"));
    if !looks_like_candidate_create || dispatch.body.attempt <= 1 {
        return Ok(());
    }

    match &dispatch_event.payload {
        Payload::DispatchEnvelopeV3(_) => {}
        Payload::DispatchEnvelopeV4(_) => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed retry candidate-create claims support only outer sealed-V3 dispatch envelopes; graph-bound V4 retries remain rejected".into(),
            });
        }
        Payload::DispatchEnvelopeV5(_) => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed retry candidate-create claims support only outer sealed-V3 dispatch envelopes; manifest-bound V5 retries remain rejected".into(),
            });
        }
        _ => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason:
                    "governed retry candidate-create claim does not reference a dispatch envelope"
                        .into(),
            });
        }
    }

    // The retry proof itself is a kernel/dispatch authority record. The
    // generic claim authority can have a distinct action-request or claim
    // signer, so construct only the verifier view required by the shared
    // sealed-V3 predecessor validator; no promotion authority is granted.
    // This special effect is nevertheless available only to a configured host
    // realm: a signed dispatch cannot select its own verifier realm.
    let configured_realm = authority
        .ledger_authority_realm_digest
        .as_deref()
        .ok_or_else(|| LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed retry candidate-create claim requires a configured protected activity authority realm"
                .into(),
        })?;
    let retry_authority = GovernedPromotionAuthorityV1 {
        trusted_keys: authority.trusted_keys.clone(),
        kernel_signer: authority.dispatch_signer.clone(),
        reviewer_signers: Vec::new(),
        operator_signer: authority.claim_signer.clone(),
        ledger_authority_realm_digest: configured_realm.into(),
    };
    validate_static_governed_candidate_completion_dispatch(dispatch, &retry_authority).map_err(
        |error| LedgerError::ActivityClaimAuthorityRejected {
            reason: format!(
                "governed retry candidate-create claim dispatch is outside the configured sealed-V3 realm: {error}"
            ),
        },
    )?;
    let retry_context = verify_governed_sealed_v3_retry_context(
        conn,
        request.run_id,
        &retry_authority,
        dispatch_event,
        dispatch,
    )
    .map_err(|error| LedgerError::ActivityClaimAuthorityRejected {
        reason: format!(
            "governed retry candidate-create claim cannot resolve its signed retry context: {error}"
        ),
    })?;
    let expected_prefix = format!(
        "{}:{RETRY_CANDIDATE_ACTION_KIND}:",
        retry_context.retry_action_namespace
    );
    let Some(candidate_key) = action_request.action_id.strip_prefix(&expected_prefix) else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed retry candidate-create action_id must derive from the exact signed retry action namespace".into(),
        });
    };
    if candidate_key.is_empty() {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed retry candidate-create action_id requires a non-empty candidate key"
                .into(),
        });
    }
    if action_request.idempotency_key != format!("{}:idempotency", action_request.action_id) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed retry candidate-create idempotency_key must exactly derive from its action_id".into(),
        });
    }
    let candidate_ref = format!("{BUILDPANE_CANDIDATE_REF_PREFIX}{candidate_key}");
    let Some(candidate_suffix) = canonical_buildplane_candidate_ref_suffix(&candidate_ref) else {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: "governed retry candidate-create candidate key must form a canonical Buildplane candidate ref".into(),
        });
    };
    if !candidate_ref_suffix_binds_run_and_attempt(
        candidate_suffix,
        request.run_id,
        dispatch.body.attempt,
    ) {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason:
                "governed retry candidate-create candidate key must bind the signed run and attempt"
                    .into(),
        });
    }
    Ok(())
}

/// Reconstruct the exact model action from signed tape before the native
/// issuer creates its evidence descriptors. This is intentionally independent
/// of the generic activity-claim flow: a model intent is write-ahead evidence,
/// not a lease or provider-effect authorization.
fn verify_model_action_intent_issue_evidence(
    conn: &Connection,
    issue: &ModelActionIntentIssueRequestV1,
    authority: &ActivityClaimAuthorityV1,
    lane: ModelActionIntentAuthorityLane,
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
            });
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
    if !lane.permits_role(action_request.execution_role) {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "model action execution role is not permitted by the selected protected authority lane"
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

fn adopt_signed_reviewer_model_action_intent_v1_in_tx(
    conn: &Connection,
    request: &ModelActionIntentIssueRequestV1,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    lane: ModelActionIntentAuthorityLane,
) -> Result<ModelActionIntentInTx> {
    let mut statement = conn.prepare(
        "SELECT id FROM events \
         WHERE run_id = ?1 AND parent_event_id = ?2 AND kind = 'model_action_intent_v1' \
         ORDER BY id ASC",
    )?;
    let raw_ids = statement
        .query_map(
            params![
                request.run_id.to_string(),
                request.action_request_event_id.to_string()
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let [raw_id] = raw_ids.as_slice() else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: if raw_ids.is_empty() {
                "reviewer model authority requires a pre-existing signed candidate-bound intent"
                    .into()
            } else {
                "reviewer model authority found multiple candidate-bound intents for one action"
                    .into()
            },
        });
    };
    let intent_event_id = parse_event_id(raw_id, "reviewer model action intent")?;
    let event = load_verified_authority_event(
        conn,
        intent_event_id,
        &authority.trusted_keys,
        &authority.claim_signer,
        "reviewer model action intent",
    )?;
    if event.run_id != request.run_id
        || event.parent_event_id != Some(request.action_request_event_id)
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer model intent does not bind the requested run and action".into(),
        });
    }
    let Payload::ModelActionIntentV1(intent) = event.payload else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer model intent event has the wrong payload kind".into(),
        });
    };
    let recomputed = model_action_intent_v1_digest(&intent).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("could not canonicalize reviewer model intent: {error}"),
        }
    })?;
    let intended_at = parse_claim_timestamp(&intent.intended_at).map_err(|error| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: format!("reviewer model intent timestamp is invalid: {error}"),
        }
    })?;
    if intent.intent_digest != recomputed
        || intent.intent_actor != authority.claim_signer.actor_id
        || intended_at != event.occurred_at
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer model intent does not exactly match its signed tape event".into(),
        });
    }
    let evidence =
        verify_model_action_intent_issue_evidence(conn, request, authority, lane, intended_at)?;
    if !model_action_intent_matches_issue_evidence(&intent, request, &evidence, lane) {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer model intent does not bind the verified dispatch/action evidence"
                .into(),
        });
    }
    verify_reviewer_candidate_binding(conn, cas, authority, &evidence, &intent)?;
    verify_model_action_intent_evidence_documents(
        cas,
        request,
        &evidence,
        &intent.model_request_evidence,
        &intent.trust_scope_evidence,
    )?;
    insert_model_action_intent_projection(
        conn,
        request,
        &evidence.action_request_digest,
        &Event {
            id: intent_event_id,
            run_id: request.run_id,
            parent_event_id: Some(request.action_request_event_id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ModelActionIntentV1,
            occurred_at: intended_at,
            payload: Payload::ModelActionIntentV1(intent.clone()),
        },
        &intent,
        &intent.intended_at,
    )?;
    Ok(ModelActionIntentInTx {
        intent_event_id,
        intent,
        appended_event: None,
    })
}

fn verify_reviewer_candidate_binding(
    conn: &Connection,
    cas: &Cas,
    authority: &ActivityClaimAuthorityV1,
    evidence: &VerifiedModelActionIntentIssueEvidence,
    intent: &ModelActionIntentV1,
) -> Result<()> {
    let binding = intent.candidate_binding.as_ref().ok_or_else(|| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer model intent is missing its immutable candidate binding".into(),
        }
    })?;
    let candidate_event = load_verified_authority_event(
        conn,
        binding.candidate_created_event_ref,
        &authority.trusted_keys,
        &authority.claim_signer,
        "reviewer candidate artifact",
    )?;
    if candidate_event.run_id.to_string() != intent.run_id {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate artifact belongs to a different run".into(),
        });
    }
    let Payload::CandidateCreatedV2(candidate) = candidate_event.payload else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate binding does not reference candidate_created_v2".into(),
        });
    };
    if candidate.workflow_id == intent.workflow_id
        || candidate.candidate_digest != binding.candidate_digest
        || candidate.candidate_commit_sha != binding.candidate_commit_sha
        || candidate.candidate_ref != binding.candidate_view.candidate_ref
        || candidate.tree_digest != binding.candidate_view.tree_digest
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate binding does not match the signed immutable candidate"
                .into(),
        });
    }
    let completions = verified_claim_events_for_run_kind(
        conn,
        candidate_event.run_id,
        EventKind::CandidateCompletionRecordedV1,
        authority,
        "reviewer candidate completion",
    )?;
    let matching_completions = completions
        .into_iter()
        .filter(|event| {
            matches!(
                &event.payload,
                Payload::CandidateCompletionRecordedV1(completion)
                    if completion.candidate_created_event_ref
                        == binding.candidate_created_event_ref
                        && completion.candidate_digest == binding.candidate_digest
            )
        })
        .collect::<Vec<_>>();
    let [completion_event] = matching_completions.as_slice() else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate requires exactly one signed immutable completion proof"
                .into(),
        });
    };
    let Payload::CandidateCompletionRecordedV1(completion) = &completion_event.payload else {
        unreachable!("candidate completion query filtered payload kind");
    };
    let recomputed_completion =
        candidate_completion_recorded_v1_digest(completion).map_err(|error| {
            LedgerError::ModelActionIntentAuthorityRejected {
                reason: format!("could not canonicalize reviewer candidate completion: {error}"),
            }
        })?;
    if completion_event.parent_event_id != Some(binding.candidate_created_event_ref)
        || completion.completion_digest != recomputed_completion
        || completion.workflow_id != candidate.workflow_id
        || completion.unit_id != candidate.unit_id
        || completion.attempt != candidate.attempt
        || completion.provenance_ref != candidate.provenance_ref
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate completion does not close the exact signed candidate"
                .into(),
        });
    }
    let acceptances = verified_claim_events_for_run_kind(
        conn,
        candidate_event.run_id,
        EventKind::CandidateAcceptanceRecorded,
        authority,
        "reviewer candidate acceptance",
    )?;
    let matching_acceptances = acceptances
        .into_iter()
        .filter(|event| {
            matches!(
                &event.payload,
                Payload::CandidateAcceptanceRecordedV1(acceptance)
                    if acceptance.candidate_digest == binding.candidate_digest
            )
        })
        .collect::<Vec<_>>();
    let [acceptance_event] = matching_acceptances.as_slice() else {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason:
                "reviewer candidate requires exactly one signed deterministic acceptance record"
                    .into(),
        });
    };
    let Payload::CandidateAcceptanceRecordedV1(acceptance) = &acceptance_event.payload else {
        unreachable!("candidate acceptance query filtered payload kind");
    };
    if acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
        || acceptance.candidate_commit_sha != binding.candidate_commit_sha
        || acceptance.acceptance_contract_digest
            != evidence.dispatch.body.acceptance_contract_digest
        || acceptance_event.parent_event_id != Some(completion_event.id)
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate acceptance is not a passed check over the exact candidate and contract"
                .into(),
        });
    }
    if binding.candidate_view.reviewer_context_manifest_digest
        != evidence.dispatch.body.context_manifest_digest
        || binding.candidate_view.reviewer_sandbox_profile_digest
            != evidence.dispatch.body.sandbox_profile_digest
        || !binding.candidate_view.read_only
        || !binding.candidate_view.network_disabled
    {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason:
                "reviewer candidate view does not match the signed read-only reviewer authority"
                    .into(),
        });
    }
    let candidate_view_ref = CanonicalCasRef::parse(&binding.candidate_view_ref).map_err(|_| {
        LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate view reference is not a strict protected-CAS reference"
                .into(),
        }
    })?;
    let candidate_view_bytes = cas
        .get_verified_canonical_bytes(&binding.candidate_view_ref, candidate_view_ref.digest())
        .map_err(model_action_intent_evidence_rejected)?;
    let stored_view: CandidateViewV1 =
        serde_json::from_slice(&candidate_view_bytes).map_err(|error| {
            LedgerError::ModelActionIntentAuthorityRejected {
                reason: format!("reviewer candidate view object is invalid: {error}"),
            }
        })?;
    if stored_view != binding.candidate_view {
        return Err(LedgerError::ModelActionIntentAuthorityRejected {
            reason: "reviewer candidate view object does not equal the signed closed view".into(),
        });
    }
    Ok(())
}

fn verified_claim_events_for_run_kind(
    conn: &Connection,
    run_id: RunId,
    kind: EventKind,
    authority: &ActivityClaimAuthorityV1,
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
            load_verified_authority_event(
                conn,
                event_id,
                &authority.trusted_keys,
                &authority.claim_signer,
                label,
            )
        })
        .collect()
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
fn verify_purpose_bound_process_claim_lineage(
    conn: &Connection,
    stored: &StoredActivityClaim,
    authority: &ActivityClaimAuthorityV1,
    expected_purpose: ActivityClaimPurposeV1,
    lane: &str,
) -> Result<()> {
    let signed_claim = verify_signed_claim_projection(conn, stored, authority)?;
    if signed_claim.purpose != expected_purpose {
        return Err(LedgerError::ActivityClaimAuthorityRejected {
            reason: if expected_purpose == ActivityClaimPurposeV1::GovernedVerifierV1 {
                "governed verifier result requires a lease minted by the fixed verifier claim lane"
                    .into()
            } else {
                format!("{lane} result requires a lease minted by its fixed-purpose claim lane")
            },
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
            reason: format!(
                "{lane} lease does not match its historical signed dispatch/action evidence"
            ),
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
    stored_event_and_signature_by_id(conn, event_id)?
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

fn stored_event_and_signature_by_id(
    conn: &Connection,
    event_id: EventId,
) -> Result<Option<(StoredEventRow, Option<StoredEventSignatureRow>)>> {
    conn
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
        .optional()
        .map_err(LedgerError::from)
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
    let Some(candidate_ref_suffix) =
        canonical_buildplane_candidate_ref_suffix(&candidate.candidate_ref)
    else {
        return promotion_authority_rejected(
            "promotion decision requires a canonical Buildplane candidate ref",
        );
    };
    if !candidate_ref_suffix_binds_candidate_id_run_and_attempt(
        candidate_ref_suffix,
        &candidate.candidate_id,
        request.run_id,
        dispatch.body.attempt,
    ) {
        return promotion_authority_rejected(
            "promotion candidate ref must bind the signed candidate id, run, and attempt",
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

const GOVERNED_DISPATCH_ADMISSION_SEMANTIC_IDENTITY_DIGEST_DOMAIN_V1: &[u8] =
    b"buildplane.governed-dispatch-admission.semantic-identity.v1\0";

#[derive(serde::Serialize)]
struct GovernedDispatchAdmissionSemanticIdentityMaterial<'a> {
    run_id: String,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    unit_id: &'a str,
    attempt: u32,
    idempotency_key: &'a str,
    envelope_digest: &'a str,
    repository_binding_digest: &'a str,
    ledger_authority_realm_digest: &'a str,
    governed_packet_digest: &'a str,
}

/// Return a stable, domain-separated identity for one closed V3 admission.
/// Event ids and wall-clock times are deliberately absent: an exact retry must
/// resolve the original projection even when it arrives after a process crash.
pub fn governed_dispatch_admission_semantic_identity_digest_v1(
    request: &GovernedDispatchAdmissionRequestV1,
) -> Result<String> {
    let governed_packet_digest = request
        .dispatch
        .governed_packet_digest
        .as_deref()
        .ok_or_else(|| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason:
                "governed dispatch admission semantic identity requires a governed packet digest"
                    .into(),
        })?;
    let material = GovernedDispatchAdmissionSemanticIdentityMaterial {
        run_id: request.run_id.to_string(),
        workflow_id: &request.dispatch.body.workflow_id,
        workflow_revision: &request.dispatch.body.workflow_revision,
        unit_id: &request.dispatch.body.unit_id,
        attempt: request.dispatch.body.attempt,
        idempotency_key: &request.dispatch.body.idempotency_key,
        envelope_digest: &request.dispatch.envelope_digest,
        repository_binding_digest: &request.dispatch.repository_binding_digest,
        ledger_authority_realm_digest: &request.dispatch.ledger_authority_realm_digest,
        governed_packet_digest,
    };
    let bytes = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(GOVERNED_DISPATCH_ADMISSION_SEMANTIC_IDENTITY_DIGEST_DOMAIN_V1);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredGovernedDispatchAdmissionState {
    AwaitingCheckpoint,
    Sealed,
}

#[derive(Clone, Debug)]
struct StoredGovernedDispatchAdmission {
    run_id: RunId,
    idempotency_key: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    envelope_digest: String,
    governed_packet_digest: String,
    semantic_identity_digest: String,
    dispatch_event_id: EventId,
    dispatch_event_digest: String,
    state: StoredGovernedDispatchAdmissionState,
    sealed_checkpoint_event_id: Option<EventId>,
    sealed_checkpoint_event_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GovernedDispatchAdmissionCheckpointEvidence {
    event_id: EventId,
    event_digest: String,
}

const GOVERNED_DISPATCH_ADMISSION_COLUMNS: &str =
    "run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt, \
     envelope_digest, governed_packet_digest, semantic_identity_digest, dispatch_event_id, \
     dispatch_event_digest, state, sealed_checkpoint_event_id, sealed_checkpoint_event_digest";

fn governed_dispatch_admission_by_idempotency(
    conn: &Connection,
    run_id: RunId,
    idempotency_key: &str,
) -> Result<Option<StoredGovernedDispatchAdmission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_ADMISSION_COLUMNS} \
         FROM governed_dispatch_admissions \
         WHERE run_id = ?1 AND idempotency_key = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), idempotency_key],
        stored_governed_dispatch_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_admission_by_workflow_attempt(
    conn: &Connection,
    run_id: RunId,
    workflow_id: &str,
    unit_id: &str,
    attempt: u32,
) -> Result<Option<StoredGovernedDispatchAdmission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_ADMISSION_COLUMNS} \
         FROM governed_dispatch_admissions \
         WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), workflow_id, unit_id, attempt],
        stored_governed_dispatch_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_admission_identity_is_conflicted(
    conn: &Connection,
    run_id: RunId,
    workflow_id: &str,
    unit_id: &str,
    attempt: u32,
) -> Result<bool> {
    let marker_count: i64 = conn.query_row(
        r#"SELECT COUNT(*)
           FROM governed_dispatch_admission_identity_conflicts_v2
           WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4"#,
        params![run_id.to_string(), workflow_id, unit_id, attempt],
        |row| row.get(0),
    )?;
    if marker_count > 0 {
        return Ok(true);
    }
    let projection_count: i64 = conn.query_row(
        r#"SELECT COUNT(*)
           FROM governed_dispatch_admissions
           WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4"#,
        params![run_id.to_string(), workflow_id, unit_id, attempt],
        |row| row.get(0),
    )?;
    Ok(projection_count > 1)
}

fn require_governed_dispatch_admission_request_identity_not_conflicted(
    conn: &Connection,
    request: &GovernedDispatchAdmissionRequestV1,
) -> Result<()> {
    if governed_dispatch_admission_identity_is_conflicted(
        conn,
        request.run_id,
        &request.dispatch.body.workflow_id,
        &request.dispatch.body.unit_id,
        request.dispatch.body.attempt,
    )? {
        return Err(governed_dispatch_admission_reconciliation_required(
            request,
            "legacy revision-free admission identity has multiple historical projections",
        ));
    }
    Ok(())
}

fn require_stored_governed_dispatch_admission_identity_not_conflicted(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
) -> Result<()> {
    if governed_dispatch_admission_identity_is_conflicted(
        conn,
        stored.run_id,
        &stored.workflow_id,
        &stored.unit_id,
        stored.attempt,
    )? {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "legacy revision-free admission identity has multiple historical projections",
        ));
    }
    Ok(())
}

fn governed_dispatch_admission_by_event(
    conn: &Connection,
    run_id: RunId,
    dispatch_event_id: EventId,
) -> Result<Option<StoredGovernedDispatchAdmission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_ADMISSION_COLUMNS} \
         FROM governed_dispatch_admissions \
         WHERE run_id = ?1 AND dispatch_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), dispatch_event_id.to_string()],
        stored_governed_dispatch_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn stored_governed_dispatch_admission_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedDispatchAdmission> {
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
                    "invalid governed dispatch admission {field} event id: {error}"
                ))
            })
    };
    let run_id: String = row.get(0)?;
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| {
            to_sql_error(format!(
                "invalid governed dispatch admission run id: {error}"
            ))
        })?;
    let attempt: i64 = row.get(5)?;
    let attempt = u32::try_from(attempt)
        .map_err(|_| to_sql_error("invalid governed dispatch admission attempt".into()))?;
    let state: String = row.get(11)?;
    let state = match state.as_str() {
        "awaiting_checkpoint" => StoredGovernedDispatchAdmissionState::AwaitingCheckpoint,
        "sealed" => StoredGovernedDispatchAdmissionState::Sealed,
        _ => {
            return Err(to_sql_error(
                "invalid governed dispatch admission state".into(),
            ));
        }
    };
    let sealed_checkpoint_event_id: Option<String> = row.get(12)?;
    let sealed_checkpoint_event_id = sealed_checkpoint_event_id
        .map(|value| parse_event(value, "sealed checkpoint"))
        .transpose()?;
    Ok(StoredGovernedDispatchAdmission {
        run_id,
        idempotency_key: row.get(1)?,
        workflow_id: row.get(2)?,
        workflow_revision: row.get(3)?,
        unit_id: row.get(4)?,
        attempt,
        envelope_digest: row.get(6)?,
        governed_packet_digest: row.get(7)?,
        semantic_identity_digest: row.get(8)?,
        dispatch_event_id: parse_event(row.get(9)?, "dispatch")?,
        dispatch_event_digest: row.get(10)?,
        state,
        sealed_checkpoint_event_id,
        sealed_checkpoint_event_digest: row.get(13)?,
    })
}

fn require_governed_dispatch_admission_event_projection(
    conn: &Connection,
    request: &GovernedDispatchAdmissionRequestV1,
    expected_event_id: Option<EventId>,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
         FROM events \
         WHERE run_id = ?1 AND kind = 'dispatch_envelope_v3' \
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
                governed_dispatch_admission_reconciliation_required(
                    request,
                    format!(
                        "admission reconciliation scan could not canonicalize a V3 dispatch event: {error}"
                    ),
                )
            })?;
            let matches_identity = matches!(
                &event.payload,
                Payload::DispatchEnvelopeV3(dispatch)
                    if dispatch.body.idempotency_key == request.dispatch.body.idempotency_key
                        || (dispatch.body.workflow_id == request.dispatch.body.workflow_id
                            && dispatch.body.unit_id == request.dispatch.body.unit_id
                            && dispatch.body.attempt == request.dispatch.body.attempt)
            );
            Ok(matches_identity.then_some(event.id))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    match expected_event_id {
        None if event_ids.is_empty() => Ok(()),
        Some(expected) if event_ids.as_slice() == [expected] => Ok(()),
        None => Err(governed_dispatch_admission_reconciliation_required(
            request,
            "a V3 dispatch event exists without a trusted native admission projection",
        )),
        Some(_) => Err(governed_dispatch_admission_reconciliation_required(
            request,
            "admission projection does not name the only V3 dispatch event for its identity",
        )),
    }
}

fn load_verified_governed_dispatch_admission_event(
    conn: &Connection,
    event_id: EventId,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, event_id)? else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission event is missing from the tape",
        );
    };
    let Some(signature) = signature else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission event is unsigned",
        );
    };
    if !actor_matches(&authority.dispatch_signer, &signature.signer)
        || verify_event_signature(&event, &signature, &authority.trusted_keys)
            != VerificationStatus::Verified
    {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission signature is not verified for the configured dispatch authority",
        );
    }
    Ok(event)
}

fn stored_governed_dispatch_admission_reconciliation_required(
    stored: &StoredGovernedDispatchAdmission,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::GovernedDispatchAdmissionReconciliationRequired {
        run_id: stored.run_id.to_string(),
        idempotency_key: stored.idempotency_key.clone(),
        reason: reason.into(),
    }
}

fn verified_governed_dispatch_admission_dispatch(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<DispatchEnvelopeV3> {
    require_stored_governed_dispatch_admission_identity_not_conflicted(conn, stored)?;
    let event =
        load_verified_governed_dispatch_admission_event(conn, stored.dispatch_event_id, authority)?;
    let event_digest = canonical_event_hash(&event).map_err(|error| {
        stored_governed_dispatch_admission_reconciliation_required(
            stored,
            format!("could not canonicalize stored V3 dispatch event: {error}"),
        )
    })?;
    let Payload::DispatchEnvelopeV3(dispatch) = event.payload else {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "admission projection points to a non-V3-dispatch tape event",
        ));
    };
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: stored.run_id,
        dispatch: dispatch.clone(),
    };
    validate_governed_dispatch_admission_request(&request, authority)?;
    let semantic_identity_digest =
        governed_dispatch_admission_semantic_identity_digest_v1(&request)?;
    let governed_packet_digest = dispatch
        .governed_packet_digest
        .as_deref()
        .unwrap_or_default();
    if event.run_id != stored.run_id
        || event.parent_event_id.is_some()
        || event.kind != EventKind::DispatchEnvelopeV3
        || event_digest != stored.dispatch_event_digest
        || stored.idempotency_key != dispatch.body.idempotency_key
        || stored.workflow_id != dispatch.body.workflow_id
        || stored.workflow_revision != dispatch.body.workflow_revision
        || stored.unit_id != dispatch.body.unit_id
        || stored.attempt != dispatch.body.attempt
        || stored.envelope_digest != dispatch.envelope_digest
        || stored.governed_packet_digest != governed_packet_digest
        || stored.semantic_identity_digest != semantic_identity_digest
    {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "admission projection or signed V3 dispatch event is substituted or corrupt",
        ));
    }
    Ok(dispatch)
}

fn verify_stored_governed_dispatch_admission(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<()> {
    verified_governed_dispatch_admission_dispatch(conn, stored, authority).map(|_| ())
}

fn load_verified_governed_dispatch_admission_checkpoint_event(
    conn: &Connection,
    checkpoint_event_id: EventId,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, checkpoint_event_id)? else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission checkpoint is missing from the tape",
        );
    };
    let Some(signature) = signature else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission checkpoint is unsigned",
        );
    };
    if !actor_matches(&authority.checkpoint_signer, &signature.signer)
        || verify_event_signature(&event, &signature, &authority.trusted_keys)
            != VerificationStatus::Verified
    {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission checkpoint signature is not verified for the configured checkpoint authority",
        );
    }
    Ok(event)
}

fn verified_governed_dispatch_admission_checkpoint_by_id(
    conn: &Connection,
    run_id: RunId,
    checkpoint_event_id: EventId,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<GovernedDispatchAdmissionCheckpointEvidence> {
    let event = load_verified_governed_dispatch_admission_checkpoint_event(
        conn,
        checkpoint_event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint) = &event.payload else {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission seal does not reference a TapeCheckpointV1 event",
        );
    };
    if event.run_id != run_id
        || checkpoint.run_id != run_id
        || event.parent_event_id != Some(checkpoint.through_event_id)
    {
        return governed_dispatch_admission_authority_rejected(
            "governed dispatch admission checkpoint does not anchor its signed run and covered event",
        );
    }
    Ok(GovernedDispatchAdmissionCheckpointEvidence {
        event_id: checkpoint_event_id,
        event_digest: canonical_event_hash(&event)?,
    })
}

fn verify_governed_dispatch_admission_checkpoint_covers(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    checkpoint: &GovernedDispatchAdmissionCheckpointEvidence,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<()> {
    let verified = verified_governed_dispatch_admission_checkpoint_by_id(
        conn,
        stored.run_id,
        checkpoint.event_id,
        authority,
    )?;
    if verified != *checkpoint {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint digest does not match the immutable admission sealing evidence",
        ));
    }
    let checkpoint_event = load_verified_governed_dispatch_admission_checkpoint_event(
        conn,
        checkpoint.event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = checkpoint_event.payload else {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint evidence no longer carries TapeCheckpointV1 payload",
        ));
    };
    let signed = signed_ordinary_events_for_connection(conn, &stored.run_id)?;
    let Some(dispatch_index) = signed
        .iter()
        .position(|event| event.event_id == stored.dispatch_event_id)
    else {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "admission dispatch is absent from the signed ordinary-event prefix",
        ));
    };
    let through_count = usize::try_from(checkpoint_payload.through_event_count).map_err(|_| {
        stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint through-event count is not representable on this host",
        )
    })?;
    if through_count == 0
        || through_count > signed.len()
        || through_count <= dispatch_index
        || checkpoint_payload.algorithm != TapeRootAlgorithm::Sha256Linear
    {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint does not cover the exact governed dispatch admission",
        ));
    }
    let covered = &signed[..through_count];
    let Some(last) = covered.last() else {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint coverage became empty while verifying admission seal",
        ));
    };
    let expected_root = tape_root_hash(
        &covered
            .iter()
            .map(|event| event.canonical_event_hash.clone())
            .collect::<Vec<_>>(),
    );
    if checkpoint_payload.through_event_id != last.event_id
        || checkpoint_payload.tape_root_hash != expected_root
    {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "checkpoint root does not verify the admission's signed event prefix",
        ));
    }
    Ok(())
}

fn fully_covering_governed_dispatch_admission_checkpoint(
    conn: &Connection,
    run_id: RunId,
    dispatch_event_id: EventId,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<Option<GovernedDispatchAdmissionCheckpointEvidence>> {
    let signed = signed_ordinary_events_for_connection(conn, &run_id)?;
    let Some(dispatch_index) = signed
        .iter()
        .position(|event| event.event_id == dispatch_event_id)
    else {
        return governed_dispatch_admission_authority_rejected(
            "admission dispatch is absent from the signed ordinary-event prefix",
        );
    };
    let Some(latest) = latest_checkpoint_for_connection(conn, &run_id)? else {
        return Ok(None);
    };
    let Some(last) = signed.last() else {
        return Ok(None);
    };
    if latest.through_event_count != signed.len() as u64
        || latest.through_event_id != last.event_id
        || latest.through_event_count <= dispatch_index as u64
    {
        return Ok(None);
    }
    let checkpoint = verified_governed_dispatch_admission_checkpoint_by_id(
        conn,
        run_id,
        latest.event_id,
        authority,
    )?;
    let checkpoint_event = load_verified_governed_dispatch_admission_checkpoint_event(
        conn,
        checkpoint.event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = checkpoint_event.payload else {
        return governed_dispatch_admission_authority_rejected(
            "latest admission checkpoint does not carry TapeCheckpointV1 payload",
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
        return governed_dispatch_admission_authority_rejected(
            "latest admission checkpoint does not verify the complete signed prefix",
        );
    }
    Ok(Some(checkpoint))
}

fn sealed_governed_dispatch_admission_checkpoint(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<GovernedDispatchAdmissionCheckpointEvidence> {
    if stored.state != StoredGovernedDispatchAdmissionState::Sealed {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "unsealed admission lacks checkpoint evidence",
        ));
    }
    let checkpoint_event_id = stored.sealed_checkpoint_event_id.ok_or_else(|| {
        stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "sealed admission lacks its checkpoint event reference",
        )
    })?;
    let expected_digest = stored
        .sealed_checkpoint_event_digest
        .as_deref()
        .ok_or_else(|| {
            stored_governed_dispatch_admission_reconciliation_required(
                stored,
                "sealed admission lacks its checkpoint digest",
            )
        })?;
    let checkpoint = verified_governed_dispatch_admission_checkpoint_by_id(
        conn,
        stored.run_id,
        checkpoint_event_id,
        authority,
    )?;
    if checkpoint.event_digest != expected_digest {
        return Err(stored_governed_dispatch_admission_reconciliation_required(
            stored,
            "sealed admission checkpoint digest does not match its immutable projection",
        ));
    }
    verify_governed_dispatch_admission_checkpoint_covers(conn, stored, &checkpoint, authority)?;
    Ok(checkpoint)
}

fn sealed_governed_dispatch_admission_disposition(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<GovernedDispatchAdmissionDispositionV1> {
    let admission_request = GovernedDispatchAdmissionRequestV1 {
        run_id: stored.run_id,
        dispatch: verified_governed_dispatch_admission_dispatch(conn, stored, authority)?,
    };
    require_governed_dispatch_admission_event_projection(
        conn,
        &admission_request,
        Some(stored.dispatch_event_id),
    )?;
    let checkpoint = sealed_governed_dispatch_admission_checkpoint(conn, stored, authority)?;
    Ok(GovernedDispatchAdmissionDispositionV1::Sealed {
        dispatch_event_id: stored.dispatch_event_id,
        dispatch_event_digest: stored.dispatch_event_digest.clone(),
        semantic_identity_digest: stored.semantic_identity_digest.clone(),
        idempotency_key: stored.idempotency_key.clone(),
        checkpoint_event_id: checkpoint.event_id,
        checkpoint_event_digest: checkpoint.event_digest,
    })
}

fn resolve_existing_governed_dispatch_admission(
    conn: &Connection,
    stored: &StoredGovernedDispatchAdmission,
    request: &GovernedDispatchAdmissionRequestV1,
    semantic_identity_digest: &str,
    authority: &GovernedDispatchAdmissionAuthorityV1,
) -> Result<GovernedDispatchAdmissionDispositionV1> {
    if stored.semantic_identity_digest != semantic_identity_digest
        || stored.idempotency_key != request.dispatch.body.idempotency_key
        || stored.workflow_id != request.dispatch.body.workflow_id
        || stored.workflow_revision != request.dispatch.body.workflow_revision
        || stored.unit_id != request.dispatch.body.unit_id
        || stored.attempt != request.dispatch.body.attempt
        || stored.envelope_digest != request.dispatch.envelope_digest
        || stored.governed_packet_digest
            != request
                .dispatch
                .governed_packet_digest
                .as_deref()
                .unwrap_or_default()
    {
        return Err(LedgerError::GovernedDispatchAdmissionConflict {
            run_id: request.run_id.to_string(),
            idempotency_key: request.dispatch.body.idempotency_key.clone(),
        });
    }
    let dispatch = verified_governed_dispatch_admission_dispatch(conn, stored, authority)?;
    if stored.run_id != request.run_id || dispatch != request.dispatch {
        return Err(governed_dispatch_admission_reconciliation_required(
            request,
            "admission projection or signed V3 dispatch event is substituted or corrupt",
        ));
    }
    require_governed_dispatch_admission_event_projection(
        conn,
        request,
        Some(stored.dispatch_event_id),
    )?;
    match stored.state {
        StoredGovernedDispatchAdmissionState::AwaitingCheckpoint => {
            Ok(GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
                dispatch_event_id: stored.dispatch_event_id,
                dispatch_event_digest: stored.dispatch_event_digest.clone(),
                semantic_identity_digest: stored.semantic_identity_digest.clone(),
                idempotency_key: stored.idempotency_key.clone(),
            })
        }
        StoredGovernedDispatchAdmissionState::Sealed => {
            sealed_governed_dispatch_admission_disposition(conn, stored, authority)
        }
    }
}

fn insert_governed_dispatch_admission(
    conn: &Connection,
    request: &GovernedDispatchAdmissionRequestV1,
    semantic_identity_digest: &str,
    event: &Event,
    event_digest: &str,
) -> Result<()> {
    let governed_packet_digest = request
        .dispatch
        .governed_packet_digest
        .as_deref()
        .ok_or_else(|| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: "governed dispatch admission projection requires a governed packet digest"
                .into(),
        })?;
    conn.execute(
        r#"INSERT INTO governed_dispatch_admissions (
                run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt,
                envelope_digest, governed_packet_digest, semantic_identity_digest,
                dispatch_event_id, dispatch_event_digest, state, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                'awaiting_checkpoint', ?12
            )"#,
        params![
            request.run_id.to_string(),
            &request.dispatch.body.idempotency_key,
            &request.dispatch.body.workflow_id,
            &request.dispatch.body.workflow_revision,
            &request.dispatch.body.unit_id,
            request.dispatch.body.attempt,
            &request.dispatch.envelope_digest,
            governed_packet_digest,
            semantic_identity_digest,
            event.id.to_string(),
            event_digest,
            event.occurred_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

const GOVERNED_DISPATCH_V5_OBSERVATION_SEMANTIC_IDENTITY_DIGEST_DOMAIN_V1: &[u8] =
    b"buildplane.governed-dispatch-v5-observation.semantic-identity.v1\0";

/// Identity for an immutable V5 observation shadow. This is deliberately
/// distinct from V3 admission identity: it binds the complete V5/V4 envelope
/// lineage and exact declaration references, but does not expose any nested
/// dispatch as executable authority.
#[derive(serde::Serialize)]
struct GovernedDispatchV5ObservationSemanticIdentityMaterial<'a> {
    run_id: String,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    unit_id: &'a str,
    attempt: u32,
    idempotency_key: &'a str,
    v5_envelope_digest: &'a str,
    v4_envelope_digest: &'a str,
    workflow_graph_digest: &'a str,
    workflow_graph_declaration_event_ref: String,
    context_manifest_declaration_event_ref: String,
    context_manifest_digest: &'a str,
    worker_manifest_declaration_event_ref: String,
    worker_manifest_digest: &'a str,
    sandbox_profile_declaration_event_ref: String,
    sandbox_profile_digest: &'a str,
}

fn governed_dispatch_v5_observation_semantic_identity_digest_v1(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV5,
) -> Result<String> {
    let body = &dispatch.dispatch_v4.dispatch_v3.body;
    let material = GovernedDispatchV5ObservationSemanticIdentityMaterial {
        run_id: run_id.to_string(),
        workflow_id: &body.workflow_id,
        workflow_revision: &body.workflow_revision,
        unit_id: &body.unit_id,
        attempt: body.attempt,
        idempotency_key: &body.idempotency_key,
        v5_envelope_digest: &dispatch.envelope_digest,
        v4_envelope_digest: &dispatch.dispatch_v4.envelope_digest,
        workflow_graph_digest: &dispatch.dispatch_v4.workflow_graph_digest,
        workflow_graph_declaration_event_ref: dispatch
            .dispatch_v4
            .workflow_graph_declaration_event_ref
            .to_string(),
        context_manifest_declaration_event_ref: dispatch
            .context_manifest_declaration_event_ref
            .to_string(),
        context_manifest_digest: &dispatch.context_manifest_digest,
        worker_manifest_declaration_event_ref: dispatch
            .worker_manifest_declaration_event_ref
            .to_string(),
        worker_manifest_digest: &dispatch.worker_manifest_digest,
        sandbox_profile_declaration_event_ref: dispatch
            .sandbox_profile_declaration_event_ref
            .to_string(),
        sandbox_profile_digest: &dispatch.sandbox_profile_digest,
    };
    let bytes = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(GOVERNED_DISPATCH_V5_OBSERVATION_SEMANTIC_IDENTITY_DIGEST_DOMAIN_V1);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

#[derive(Clone, Debug)]
struct VerifiedGovernedDispatchV5ObservationEvidence {
    run_id: RunId,
    idempotency_key: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    semantic_identity_digest: String,
    dispatch_event_id: EventId,
    dispatch_event_digest: String,
    v5_envelope_digest: String,
    v4_envelope_digest: String,
    v4_graph_declaration_event_id: EventId,
    v4_graph_declaration_event_digest: String,
    v4_graph_digest: String,
    context_manifest_event_id: EventId,
    context_manifest_event_digest: String,
    context_manifest_digest: String,
    worker_manifest_event_id: EventId,
    worker_manifest_event_digest: String,
    worker_manifest_digest: String,
    sandbox_profile_event_id: EventId,
    sandbox_profile_event_digest: String,
    sandbox_profile_digest: String,
    retry_context_event_id: Option<EventId>,
    retry_context_event_digest: Option<String>,
    retry_context_digest: Option<String>,
}

/// Stored V5 observation material is deliberately string-backed: the shadow
/// is an audit projection, and every use re-derives typed tape evidence before
/// comparing these immutable bytes.
#[derive(Clone, Debug)]
struct StoredGovernedDispatchV5Observation {
    authority: String,
    observation_schema_version: i64,
    run_id: String,
    idempotency_key: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    semantic_identity_digest: String,
    dispatch_event_id: String,
    dispatch_event_digest: String,
    v5_envelope_digest: String,
    v4_envelope_digest: String,
    v4_graph_declaration_event_id: String,
    v4_graph_declaration_event_digest: String,
    v4_graph_digest: String,
    context_manifest_event_id: String,
    context_manifest_event_digest: String,
    context_manifest_digest: String,
    worker_manifest_event_id: String,
    worker_manifest_event_digest: String,
    worker_manifest_digest: String,
    sandbox_profile_event_id: String,
    sandbox_profile_event_digest: String,
    sandbox_profile_digest: String,
    retry_context_event_id: Option<String>,
    retry_context_event_digest: Option<String>,
    retry_context_digest: Option<String>,
}

impl StoredGovernedDispatchV5Observation {
    fn matches(&self, evidence: &VerifiedGovernedDispatchV5ObservationEvidence) -> bool {
        self.authority == "non_authoritative_v5_observation"
            && self.observation_schema_version == 1
            && self.run_id == evidence.run_id.to_string()
            && self.idempotency_key == evidence.idempotency_key
            && self.workflow_id == evidence.workflow_id
            && self.workflow_revision == evidence.workflow_revision
            && self.unit_id == evidence.unit_id
            && self.attempt == evidence.attempt
            && self.semantic_identity_digest == evidence.semantic_identity_digest
            && self.dispatch_event_id == evidence.dispatch_event_id.to_string()
            && self.dispatch_event_digest == evidence.dispatch_event_digest
            && self.v5_envelope_digest == evidence.v5_envelope_digest
            && self.v4_envelope_digest == evidence.v4_envelope_digest
            && self.v4_graph_declaration_event_id
                == evidence.v4_graph_declaration_event_id.to_string()
            && self.v4_graph_declaration_event_digest == evidence.v4_graph_declaration_event_digest
            && self.v4_graph_digest == evidence.v4_graph_digest
            && self.context_manifest_event_id == evidence.context_manifest_event_id.to_string()
            && self.context_manifest_event_digest == evidence.context_manifest_event_digest
            && self.context_manifest_digest == evidence.context_manifest_digest
            && self.worker_manifest_event_id == evidence.worker_manifest_event_id.to_string()
            && self.worker_manifest_event_digest == evidence.worker_manifest_event_digest
            && self.worker_manifest_digest == evidence.worker_manifest_digest
            && self.sandbox_profile_event_id == evidence.sandbox_profile_event_id.to_string()
            && self.sandbox_profile_event_digest == evidence.sandbox_profile_event_digest
            && self.sandbox_profile_digest == evidence.sandbox_profile_digest
            && self.retry_context_event_id
                == evidence
                    .retry_context_event_id
                    .map(|event_id| event_id.to_string())
            && self.retry_context_event_digest == evidence.retry_context_event_digest
            && self.retry_context_digest == evidence.retry_context_digest
    }
}

const GOVERNED_DISPATCH_V5_OBSERVATION_COLUMNS: &str =
    "authority, observation_schema_version, run_id, idempotency_key, workflow_id, \
     workflow_revision, unit_id, attempt, semantic_identity_digest, dispatch_event_id, \
     dispatch_event_digest, v5_envelope_digest, v4_envelope_digest, \
     v4_graph_declaration_event_id, v4_graph_declaration_event_digest, v4_graph_digest, \
     context_manifest_event_id, context_manifest_event_digest, context_manifest_digest, \
     worker_manifest_event_id, worker_manifest_event_digest, worker_manifest_digest, \
     sandbox_profile_event_id, sandbox_profile_event_digest, sandbox_profile_digest, \
     retry_context_event_id, retry_context_event_digest, retry_context_digest";

fn governed_dispatch_v5_observation_by_event(
    conn: &Connection,
    run_id: RunId,
    dispatch_event_id: EventId,
) -> Result<Option<StoredGovernedDispatchV5Observation>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_OBSERVATION_COLUMNS} \
         FROM governed_dispatch_v5_observations \
         WHERE run_id = ?1 AND dispatch_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), dispatch_event_id.to_string()],
        stored_governed_dispatch_v5_observation_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_observation_by_idempotency(
    conn: &Connection,
    run_id: RunId,
    idempotency_key: &str,
) -> Result<Option<StoredGovernedDispatchV5Observation>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_OBSERVATION_COLUMNS} \
         FROM governed_dispatch_v5_observations \
         WHERE run_id = ?1 AND idempotency_key = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), idempotency_key],
        stored_governed_dispatch_v5_observation_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_observation_by_workflow_attempt(
    conn: &Connection,
    run_id: RunId,
    workflow_id: &str,
    unit_id: &str,
    attempt: u32,
) -> Result<Option<StoredGovernedDispatchV5Observation>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_OBSERVATION_COLUMNS} \
         FROM governed_dispatch_v5_observations \
         WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), workflow_id, unit_id, attempt],
        stored_governed_dispatch_v5_observation_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_observation_by_semantic_identity(
    conn: &Connection,
    run_id: RunId,
    semantic_identity_digest: &str,
) -> Result<Option<StoredGovernedDispatchV5Observation>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_OBSERVATION_COLUMNS} \
         FROM governed_dispatch_v5_observations \
         WHERE run_id = ?1 AND semantic_identity_digest = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), semantic_identity_digest],
        stored_governed_dispatch_v5_observation_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn stored_governed_dispatch_v5_observation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedDispatchV5Observation> {
    let attempt: i64 = row.get(7)?;
    let attempt = u32::try_from(attempt).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid governed V5 observation attempt",
            )),
        )
    })?;
    Ok(StoredGovernedDispatchV5Observation {
        authority: row.get(0)?,
        observation_schema_version: row.get(1)?,
        run_id: row.get(2)?,
        idempotency_key: row.get(3)?,
        workflow_id: row.get(4)?,
        workflow_revision: row.get(5)?,
        unit_id: row.get(6)?,
        attempt,
        semantic_identity_digest: row.get(8)?,
        dispatch_event_id: row.get(9)?,
        dispatch_event_digest: row.get(10)?,
        v5_envelope_digest: row.get(11)?,
        v4_envelope_digest: row.get(12)?,
        v4_graph_declaration_event_id: row.get(13)?,
        v4_graph_declaration_event_digest: row.get(14)?,
        v4_graph_digest: row.get(15)?,
        context_manifest_event_id: row.get(16)?,
        context_manifest_event_digest: row.get(17)?,
        context_manifest_digest: row.get(18)?,
        worker_manifest_event_id: row.get(19)?,
        worker_manifest_event_digest: row.get(20)?,
        worker_manifest_digest: row.get(21)?,
        sandbox_profile_event_id: row.get(22)?,
        sandbox_profile_event_digest: row.get(23)?,
        sandbox_profile_digest: row.get(24)?,
        retry_context_event_id: row.get(25)?,
        retry_context_event_digest: row.get(26)?,
        retry_context_digest: row.get(27)?,
    })
}

fn insert_governed_dispatch_v5_observation(
    conn: &Connection,
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
) -> Result<()> {
    let observed_at = canonical_ledger_timestamp(Utc::now())?.to_rfc3339();
    conn.execute(
        r#"INSERT INTO governed_dispatch_v5_observations (
                authority, observation_schema_version, run_id, idempotency_key,
                workflow_id, workflow_revision, unit_id, attempt,
                semantic_identity_digest, dispatch_event_id, dispatch_event_digest,
                v5_envelope_digest, v4_envelope_digest,
                v4_graph_declaration_event_id, v4_graph_declaration_event_digest, v4_graph_digest,
                context_manifest_event_id, context_manifest_event_digest, context_manifest_digest,
                worker_manifest_event_id, worker_manifest_event_digest, worker_manifest_digest,
                sandbox_profile_event_id, sandbox_profile_event_digest, sandbox_profile_digest,
                retry_context_event_id, retry_context_event_digest, retry_context_digest, observed_at
            ) VALUES (
                'non_authoritative_v5_observation', 1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                ?25, ?26, ?27
            )"#,
        params![
            evidence.run_id.to_string(),
            &evidence.idempotency_key,
            &evidence.workflow_id,
            &evidence.workflow_revision,
            &evidence.unit_id,
            evidence.attempt,
            &evidence.semantic_identity_digest,
            evidence.dispatch_event_id.to_string(),
            &evidence.dispatch_event_digest,
            &evidence.v5_envelope_digest,
            &evidence.v4_envelope_digest,
            evidence.v4_graph_declaration_event_id.to_string(),
            &evidence.v4_graph_declaration_event_digest,
            &evidence.v4_graph_digest,
            evidence.context_manifest_event_id.to_string(),
            &evidence.context_manifest_event_digest,
            &evidence.context_manifest_digest,
            evidence.worker_manifest_event_id.to_string(),
            &evidence.worker_manifest_event_digest,
            &evidence.worker_manifest_digest,
            evidence.sandbox_profile_event_id.to_string(),
            &evidence.sandbox_profile_event_digest,
            &evidence.sandbox_profile_digest,
            evidence.retry_context_event_id.map(|event_id| event_id.to_string()),
            &evidence.retry_context_event_digest,
            &evidence.retry_context_digest,
            observed_at,
        ],
    )?;
    Ok(())
}

const GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS: &str =
    "run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt, \
     semantic_identity_digest, source_dispatch_event_id, source_dispatch_event_digest, \
     v5_envelope_digest, v4_envelope_digest, v4_graph_declaration_event_id, \
     v4_graph_declaration_event_digest, v4_graph_digest, context_manifest_event_id, \
     context_manifest_event_digest, context_manifest_digest, worker_manifest_event_id, \
     worker_manifest_event_digest, worker_manifest_digest, sandbox_profile_event_id, \
     sandbox_profile_event_digest, sandbox_profile_digest, retry_context_event_id, \
     retry_context_event_digest, retry_context_digest, witness_evidence_digest, \
     ledger_authority_realm_digest, admission_event_id, admission_event_digest, state, \
     sealed_checkpoint_event_id, sealed_checkpoint_event_digest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredGovernedDispatchV5AdmissionState {
    AwaitingCheckpoint,
    Sealed,
}

#[derive(Clone, Debug)]
struct StoredGovernedDispatchV5Admission {
    run_id: RunId,
    idempotency_key: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    semantic_identity_digest: String,
    source_dispatch_event_id: EventId,
    source_dispatch_event_digest: String,
    v5_envelope_digest: String,
    v4_envelope_digest: String,
    v4_graph_declaration_event_id: EventId,
    v4_graph_declaration_event_digest: String,
    v4_graph_digest: String,
    context_manifest_event_id: EventId,
    context_manifest_event_digest: String,
    context_manifest_digest: String,
    worker_manifest_event_id: EventId,
    worker_manifest_event_digest: String,
    worker_manifest_digest: String,
    sandbox_profile_event_id: EventId,
    sandbox_profile_event_digest: String,
    sandbox_profile_digest: String,
    retry_context_event_id: Option<EventId>,
    retry_context_event_digest: Option<String>,
    retry_context_digest: Option<String>,
    witness_evidence_digest: String,
    ledger_authority_realm_digest: String,
    admission_event_id: EventId,
    admission_event_digest: String,
    state: StoredGovernedDispatchV5AdmissionState,
    sealed_checkpoint_event_id: Option<EventId>,
    sealed_checkpoint_event_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GovernedDispatchV5AdmissionCheckpointEvidence {
    event_id: EventId,
    event_digest: String,
}

impl StoredGovernedDispatchV5Admission {
    fn matches_evidence(
        &self,
        evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
        witness_evidence_digest: &str,
    ) -> bool {
        self.run_id == evidence.run_id
            && self.idempotency_key == evidence.idempotency_key
            && self.workflow_id == evidence.workflow_id
            && self.workflow_revision == evidence.workflow_revision
            && self.unit_id == evidence.unit_id
            && self.attempt == evidence.attempt
            && self.semantic_identity_digest == evidence.semantic_identity_digest
            && self.source_dispatch_event_id == evidence.dispatch_event_id
            && self.source_dispatch_event_digest == evidence.dispatch_event_digest
            && self.v5_envelope_digest == evidence.v5_envelope_digest
            && self.v4_envelope_digest == evidence.v4_envelope_digest
            && self.v4_graph_declaration_event_id == evidence.v4_graph_declaration_event_id
            && self.v4_graph_declaration_event_digest == evidence.v4_graph_declaration_event_digest
            && self.v4_graph_digest == evidence.v4_graph_digest
            && self.context_manifest_event_id == evidence.context_manifest_event_id
            && self.context_manifest_event_digest == evidence.context_manifest_event_digest
            && self.context_manifest_digest == evidence.context_manifest_digest
            && self.worker_manifest_event_id == evidence.worker_manifest_event_id
            && self.worker_manifest_event_digest == evidence.worker_manifest_event_digest
            && self.worker_manifest_digest == evidence.worker_manifest_digest
            && self.sandbox_profile_event_id == evidence.sandbox_profile_event_id
            && self.sandbox_profile_event_digest == evidence.sandbox_profile_event_digest
            && self.sandbox_profile_digest == evidence.sandbox_profile_digest
            && self.retry_context_event_id == evidence.retry_context_event_id
            && self.retry_context_event_digest == evidence.retry_context_event_digest
            && self.retry_context_digest == evidence.retry_context_digest
            && self.witness_evidence_digest == witness_evidence_digest
            && self.ledger_authority_realm_digest == authority.ledger_authority_realm_digest
    }
}

fn governed_dispatch_v5_admission_reconciliation_required(
    run_id: RunId,
    idempotency_key: &str,
    reason: impl Into<String>,
) -> LedgerError {
    LedgerError::GovernedDispatchAdmissionReconciliationRequired {
        run_id: run_id.to_string(),
        idempotency_key: idempotency_key.to_owned(),
        reason: reason.into(),
    }
}

/// Domain separator for the storage-private full raw-witness proof carried by
/// a compact V5 admission receipt. The public receipt intentionally exposes
/// only the resulting digest; the immutable projection and this proof bind
/// every graph, manifest, and retry witness underneath it.
const GOVERNED_DISPATCH_V5_ADMISSION_WITNESS_EVIDENCE_DIGEST_DOMAIN_V1: &[u8] =
    b"buildplane.governed-dispatch-v5-admission.witness-evidence.v1\0";

#[derive(serde::Serialize)]
struct GovernedDispatchV5AdmissionWitnessEvidenceDigestMaterial<'a> {
    run_id: String,
    idempotency_key: &'a str,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    unit_id: &'a str,
    attempt: u32,
    semantic_identity_digest: &'a str,
    source_dispatch_event_id: String,
    source_dispatch_event_digest: &'a str,
    v5_envelope_digest: &'a str,
    v4_envelope_digest: &'a str,
    v4_graph_declaration_event_id: String,
    v4_graph_declaration_event_digest: &'a str,
    v4_graph_digest: &'a str,
    context_manifest_event_id: String,
    context_manifest_event_digest: &'a str,
    context_manifest_digest: &'a str,
    worker_manifest_event_id: String,
    worker_manifest_event_digest: &'a str,
    worker_manifest_digest: &'a str,
    sandbox_profile_event_id: String,
    sandbox_profile_event_digest: &'a str,
    sandbox_profile_digest: &'a str,
    retry_context_event_id: Option<String>,
    retry_context_event_digest: Option<&'a str>,
    retry_context_digest: Option<&'a str>,
    ledger_authority_realm_digest: &'a str,
}

/// Derive a compact receipt digest only after the private raw-tape proof has
/// rechecked every V4 graph and V5 manifest witness. Unlike an ordinary
/// receipt-field hash, this digest includes each raw witness event reference
/// and canonical digest, so a durable row or receipt cannot be rebound to a
/// different declaration without changing the signed evidence.
fn governed_dispatch_v5_admission_witness_evidence_digest_v1(
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<String> {
    for (label, digest) in [
        (
            "source dispatch event",
            evidence.dispatch_event_digest.as_str(),
        ),
        ("V5 envelope", evidence.v5_envelope_digest.as_str()),
        ("V4 envelope", evidence.v4_envelope_digest.as_str()),
        (
            "V5 semantic identity",
            evidence.semantic_identity_digest.as_str(),
        ),
        ("V5 graph", evidence.v4_graph_digest.as_str()),
        (
            "context manifest",
            evidence.context_manifest_digest.as_str(),
        ),
        ("worker manifest", evidence.worker_manifest_digest.as_str()),
        ("sandbox profile", evidence.sandbox_profile_digest.as_str()),
        (
            "ledger authority realm",
            authority.ledger_authority_realm_digest.as_str(),
        ),
    ] {
        if !is_canonical_sha256_digest(digest) {
            return governed_dispatch_admission_authority_rejected(format!(
                "re-derived V5 admission {label} digest is not canonical sha256"
            ));
        }
    }
    if let Some(retry_digest) = evidence.retry_context_digest.as_deref() {
        if !is_canonical_sha256_digest(retry_digest) {
            return governed_dispatch_admission_authority_rejected(
                "re-derived V5 admission retry context digest is not canonical sha256",
            );
        }
    }
    for (label, digest) in [
        (
            "V4 graph declaration event",
            evidence.v4_graph_declaration_event_digest.as_str(),
        ),
        (
            "context manifest declaration event",
            evidence.context_manifest_event_digest.as_str(),
        ),
        (
            "worker manifest declaration event",
            evidence.worker_manifest_event_digest.as_str(),
        ),
        (
            "sandbox profile declaration event",
            evidence.sandbox_profile_event_digest.as_str(),
        ),
    ] {
        if !is_canonical_sha256_digest(digest) {
            return governed_dispatch_admission_authority_rejected(format!(
                "re-derived V5 admission {label} digest is not canonical sha256"
            ));
        }
    }
    match (
        evidence.retry_context_event_id,
        evidence.retry_context_event_digest.as_deref(),
        evidence.retry_context_digest.as_deref(),
    ) {
        (None, None, None) | (Some(_), Some(_), Some(_)) => {}
        _ => {
            return governed_dispatch_admission_authority_rejected(
                "re-derived V5 admission retry witness fields are incomplete",
            );
        }
    }
    if let Some(retry_event_digest) = evidence.retry_context_event_digest.as_deref() {
        if !is_canonical_sha256_digest(retry_event_digest) {
            return governed_dispatch_admission_authority_rejected(
                "re-derived V5 admission retry context event digest is not canonical sha256",
            );
        }
    }

    let material = GovernedDispatchV5AdmissionWitnessEvidenceDigestMaterial {
        run_id: evidence.run_id.to_string(),
        idempotency_key: &evidence.idempotency_key,
        workflow_id: &evidence.workflow_id,
        workflow_revision: &evidence.workflow_revision,
        unit_id: &evidence.unit_id,
        attempt: evidence.attempt,
        semantic_identity_digest: &evidence.semantic_identity_digest,
        source_dispatch_event_id: evidence.dispatch_event_id.to_string(),
        source_dispatch_event_digest: &evidence.dispatch_event_digest,
        v5_envelope_digest: &evidence.v5_envelope_digest,
        v4_envelope_digest: &evidence.v4_envelope_digest,
        v4_graph_declaration_event_id: evidence.v4_graph_declaration_event_id.to_string(),
        v4_graph_declaration_event_digest: &evidence.v4_graph_declaration_event_digest,
        v4_graph_digest: &evidence.v4_graph_digest,
        context_manifest_event_id: evidence.context_manifest_event_id.to_string(),
        context_manifest_event_digest: &evidence.context_manifest_event_digest,
        context_manifest_digest: &evidence.context_manifest_digest,
        worker_manifest_event_id: evidence.worker_manifest_event_id.to_string(),
        worker_manifest_event_digest: &evidence.worker_manifest_event_digest,
        worker_manifest_digest: &evidence.worker_manifest_digest,
        sandbox_profile_event_id: evidence.sandbox_profile_event_id.to_string(),
        sandbox_profile_event_digest: &evidence.sandbox_profile_event_digest,
        sandbox_profile_digest: &evidence.sandbox_profile_digest,
        retry_context_event_id: evidence
            .retry_context_event_id
            .map(|event_id| event_id.to_string()),
        retry_context_event_digest: evidence.retry_context_event_digest.as_deref(),
        retry_context_digest: evidence.retry_context_digest.as_deref(),
        ledger_authority_realm_digest: &authority.ledger_authority_realm_digest,
    };
    let bytes = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(GOVERNED_DISPATCH_V5_ADMISSION_WITNESS_EVIDENCE_DIGEST_DOMAIN_V1);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn governed_dispatch_v5_admission_by_source(
    conn: &Connection,
    run_id: RunId,
    source_dispatch_event_id: EventId,
) -> Result<Option<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND source_dispatch_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), source_dispatch_event_id.to_string()],
        stored_governed_dispatch_v5_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn sealed_governed_dispatch_v5_admissions_for_run(
    conn: &Connection,
    run_id: RunId,
) -> Result<Vec<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND state = 'sealed' \
         ORDER BY admission_event_id ASC"
    );
    let mut statement = conn.prepare(&query)?;
    let admissions = statement
        .query_map(
            params![run_id.to_string()],
            stored_governed_dispatch_v5_admission_from_row,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(LedgerError::from)?;
    Ok(admissions)
}

fn governed_dispatch_v5_admission_by_admission_event(
    conn: &Connection,
    run_id: RunId,
    admission_event_id: EventId,
) -> Result<Option<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND admission_event_id = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), admission_event_id.to_string()],
        stored_governed_dispatch_v5_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_admission_by_idempotency(
    conn: &Connection,
    run_id: RunId,
    idempotency_key: &str,
) -> Result<Option<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND idempotency_key = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), idempotency_key],
        stored_governed_dispatch_v5_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_admission_by_workflow_attempt(
    conn: &Connection,
    run_id: RunId,
    workflow_id: &str,
    unit_id: &str,
    attempt: u32,
) -> Result<Option<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND workflow_id = ?2 AND unit_id = ?3 AND attempt = ?4"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), workflow_id, unit_id, attempt],
        stored_governed_dispatch_v5_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn governed_dispatch_v5_admission_by_semantic_identity(
    conn: &Connection,
    run_id: RunId,
    semantic_identity_digest: &str,
) -> Result<Option<StoredGovernedDispatchV5Admission>> {
    let query = format!(
        "SELECT {GOVERNED_DISPATCH_V5_ADMISSION_COLUMNS} \
         FROM governed_dispatch_v5_admissions \
         WHERE run_id = ?1 AND semantic_identity_digest = ?2"
    );
    conn.query_row(
        &query,
        params![run_id.to_string(), semantic_identity_digest],
        stored_governed_dispatch_v5_admission_from_row,
    )
    .optional()
    .map_err(LedgerError::from)
}

fn stored_governed_dispatch_v5_admission_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredGovernedDispatchV5Admission> {
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
                    "invalid governed V5 admission {field} event id: {error}"
                ))
            })
    };
    let run_id: String = row.get(0)?;
    let run_id = Uuid::parse_str(&run_id)
        .map(RunId::from_uuid)
        .map_err(|error| to_sql_error(format!("invalid governed V5 admission run id: {error}")))?;
    let attempt: i64 = row.get(5)?;
    let attempt = u32::try_from(attempt)
        .map_err(|_| to_sql_error("invalid governed V5 admission attempt".into()))?;
    let state: String = row.get(30)?;
    let state = match state.as_str() {
        "awaiting_checkpoint" => StoredGovernedDispatchV5AdmissionState::AwaitingCheckpoint,
        "sealed" => StoredGovernedDispatchV5AdmissionState::Sealed,
        _ => return Err(to_sql_error("invalid governed V5 admission state".into())),
    };
    let retry_context_event_id: Option<String> = row.get(23)?;
    let retry_context_event_id = retry_context_event_id
        .map(|value| parse_event(value, "retry context"))
        .transpose()?;
    let sealed_checkpoint_event_id: Option<String> = row.get(31)?;
    let sealed_checkpoint_event_id = sealed_checkpoint_event_id
        .map(|value| parse_event(value, "sealed checkpoint"))
        .transpose()?;
    Ok(StoredGovernedDispatchV5Admission {
        run_id,
        idempotency_key: row.get(1)?,
        workflow_id: row.get(2)?,
        workflow_revision: row.get(3)?,
        unit_id: row.get(4)?,
        attempt,
        semantic_identity_digest: row.get(6)?,
        source_dispatch_event_id: parse_event(row.get(7)?, "source dispatch")?,
        source_dispatch_event_digest: row.get(8)?,
        v5_envelope_digest: row.get(9)?,
        v4_envelope_digest: row.get(10)?,
        v4_graph_declaration_event_id: parse_event(row.get(11)?, "V4 graph declaration")?,
        v4_graph_declaration_event_digest: row.get(12)?,
        v4_graph_digest: row.get(13)?,
        context_manifest_event_id: parse_event(row.get(14)?, "context manifest")?,
        context_manifest_event_digest: row.get(15)?,
        context_manifest_digest: row.get(16)?,
        worker_manifest_event_id: parse_event(row.get(17)?, "worker manifest")?,
        worker_manifest_event_digest: row.get(18)?,
        worker_manifest_digest: row.get(19)?,
        sandbox_profile_event_id: parse_event(row.get(20)?, "sandbox profile")?,
        sandbox_profile_event_digest: row.get(21)?,
        sandbox_profile_digest: row.get(22)?,
        retry_context_event_id,
        retry_context_event_digest: row.get(24)?,
        retry_context_digest: row.get(25)?,
        witness_evidence_digest: row.get(26)?,
        ledger_authority_realm_digest: row.get(27)?,
        admission_event_id: parse_event(row.get(28)?, "admission")?,
        admission_event_digest: row.get(29)?,
        state,
        sealed_checkpoint_event_id,
        sealed_checkpoint_event_digest: row.get(32)?,
    })
}

#[derive(Clone, Debug)]
struct StoredGovernedDispatchV5SourceScan {
    run_id: String,
    v5_envelope_digest: String,
    source_authority_fingerprint: String,
    scan_schema_version: i64,
    event_cursor_rowid: i64,
    observed_event_high_water_rowid: i64,
    event_complete_through_rowid: Option<i64>,
    cursor_signature_rowid: i64,
    observed_high_water_rowid: i64,
    complete_through_signature_rowid: Option<i64>,
    candidate_signature_rowid: Option<i64>,
    candidate_event_id: Option<EventId>,
    candidate_event_digest: Option<String>,
    ambiguous: bool,
}

impl StoredGovernedDispatchV5SourceScan {
    fn new(run_id: RunId, v5_envelope_digest: &str, source_authority_fingerprint: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            v5_envelope_digest: v5_envelope_digest.to_owned(),
            source_authority_fingerprint: source_authority_fingerprint.to_owned(),
            scan_schema_version: 1,
            event_cursor_rowid: 0,
            observed_event_high_water_rowid: 0,
            event_complete_through_rowid: None,
            cursor_signature_rowid: 0,
            observed_high_water_rowid: 0,
            complete_through_signature_rowid: None,
            candidate_signature_rowid: None,
            candidate_event_id: None,
            candidate_event_digest: None,
            ambiguous: false,
        }
    }
}

fn governed_dispatch_v5_source_authority_fingerprint_v1(
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<String> {
    #[derive(serde::Serialize)]
    struct FingerprintMaterial<'a> {
        schema_version: u8,
        algorithm: &'static str,
        actor_id: &'a str,
        key_id: &'a str,
        public_key_hash: &'a str,
        ledger_authority_realm_digest: &'a str,
    }

    let public_key_hash = authority
        .source_dispatch_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: "configured V5 source signer has no public key hash".into(),
        })?;
    let encoded = serde_json::to_vec(&FingerprintMaterial {
        schema_version: 1,
        algorithm: "ed25519",
        actor_id: &authority.source_dispatch_signer.actor_id,
        key_id: &authority.source_dispatch_signer.key_id,
        public_key_hash,
        ledger_authority_realm_digest: &authority.ledger_authority_realm_digest,
    })?;
    let mut hasher = Sha256::new();
    hasher.update(V5_SOURCE_AUTHORITY_FINGERPRINT_DOMAIN_V1);
    hasher.update(encoded);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn governed_dispatch_v5_source_event_high_water(
    conn: &Connection,
    run_id: RunId,
    v5_envelope_digest: &str,
) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(rowid), 0)
         FROM events INDEXED BY idx_events_v5_envelope_digest
         WHERE run_id = ?1
           AND kind = 'dispatch_envelope_v5'
           AND json_extract(
                 payload,
                 '$.DispatchEnvelopeV5.envelope_digest'
               ) = ?2",
        params![run_id.to_string(), v5_envelope_digest],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn governed_dispatch_v5_source_signature_high_water(
    conn: &Connection,
    run_id: RunId,
    v5_envelope_digest: &str,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<i64> {
    let public_key_hash = authority
        .source_dispatch_signer
        .public_key_hash
        .as_deref()
        .ok_or_else(|| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: "configured V5 source signer has no public key hash".into(),
        })?;
    conn.query_row(
        "SELECT COALESCE(MAX(signature_rowid), 0)
         FROM governed_dispatch_v5_signature_scan_index
              INDEXED BY idx_governed_dispatch_v5_signature_scan_exact
         WHERE run_id = ?1
           AND v5_envelope_digest = ?2
           AND actor_id = ?3
           AND key_id = ?4
           AND public_key_hash = ?5
           AND algorithm = 'ed25519'",
        params![
            run_id.to_string(),
            v5_envelope_digest,
            authority.source_dispatch_signer.actor_id,
            authority.source_dispatch_signer.key_id,
            public_key_hash,
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

const GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_INDEX_TABLE_SQL: &str = r#"
    CREATE TABLE governed_dispatch_v5_signature_scan_index (
        signature_rowid       INTEGER PRIMARY KEY CHECK(signature_rowid > 0),
        event_rowid           INTEGER NOT NULL CHECK(event_rowid > 0),
        event_id              TEXT NOT NULL UNIQUE,
        run_id                TEXT NOT NULL,
        v5_envelope_digest    TEXT NOT NULL,
        actor_id              TEXT NOT NULL,
        key_id                TEXT NOT NULL,
        public_key_hash       TEXT,
        algorithm             TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES events(id)
    )
"#;

const GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_EXACT_INDEX_SQL: &str = r#"
    CREATE INDEX idx_governed_dispatch_v5_signature_scan_exact
    ON governed_dispatch_v5_signature_scan_index(
        run_id,
        v5_envelope_digest,
        actor_id,
        key_id,
        public_key_hash,
        algorithm,
        signature_rowid
    )
"#;

const GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_AFTER_INSERT_SQL: &str = r#"
    CREATE TRIGGER governed_dispatch_v5_signature_scan_after_insert
    AFTER INSERT ON event_signatures
    BEGIN
        INSERT INTO governed_dispatch_v5_signature_scan_index (
            signature_rowid, event_rowid, event_id, run_id,
            v5_envelope_digest, actor_id, key_id,
            public_key_hash, algorithm
        )
        SELECT
            NEW.rowid, e.rowid, e.id, e.run_id,
            json_extract(
                e.payload,
                '$.DispatchEnvelopeV5.envelope_digest'
            ),
            NEW.actor_id, NEW.key_id, NEW.public_key_hash,
            NEW.algorithm
        FROM events e
        WHERE e.id = NEW.event_id
          AND e.kind = 'dispatch_envelope_v5';
    END
"#;

const GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_NO_UPDATE_SQL: &str = r#"
    CREATE TRIGGER governed_dispatch_v5_signature_scan_no_update
    BEFORE UPDATE ON governed_dispatch_v5_signature_scan_index
    BEGIN
        SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: UPDATE forbidden');
    END
"#;

const GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_NO_DELETE_SQL: &str = r#"
    CREATE TRIGGER governed_dispatch_v5_signature_scan_no_delete
    BEFORE DELETE ON governed_dispatch_v5_signature_scan_index
    BEGIN
        SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: DELETE forbidden');
    END
"#;

/// Tokenize SQLite-owned schema text without weakening lexical boundaries.
///
/// SQLite removes `IF NOT EXISTS` and may preserve arbitrary insignificant
/// formatting in `sqlite_master.sql`. Unquoted tokens are ASCII
/// case-insensitive, while quoted strings and identifiers remain byte-for-byte
/// bound. Whitespace separates tokens but is otherwise insignificant.
///
/// Returning a token sequence (rather than deleting whitespace) is essential:
/// SQLite accepts type names such as `INTEGERPRIMARYKEY`, which must never
/// compare equal to the three authoritative tokens `INTEGER PRIMARY KEY`.
fn tokenize_sqlite_schema_sql(sql: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut chars = sql.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }

        if matches!(ch, '\'' | '"' | '`' | '[') {
            let end_quote = if ch == '[' { ']' } else { ch };
            let mut token = String::from(ch);
            let mut closed = false;
            while let Some(quoted) = chars.next() {
                token.push(quoted);
                if quoted == end_quote {
                    if end_quote != ']' && chars.peek() == Some(&end_quote) {
                        token.push(chars.next().expect("peeked escaped quote"));
                    } else {
                        closed = true;
                        break;
                    }
                }
            }
            if !closed {
                return None;
            }
            tokens.push(token);
            continue;
        }

        if ch.is_alphanumeric() || matches!(ch, '_' | '$') {
            let mut token = String::new();
            token.push(ch.to_ascii_lowercase());
            while let Some(next) = chars.peek().copied() {
                if next.is_alphanumeric() || matches!(next, '_' | '$') {
                    token.push(
                        chars
                            .next()
                            .expect("peeked unquoted token")
                            .to_ascii_lowercase(),
                    );
                } else {
                    break;
                }
            }
            tokens.push(token);
        } else {
            tokens.push(ch.to_string());
        }
    }
    Some(tokens)
}

fn require_governed_dispatch_v5_source_scan_schema(conn: &Connection, run_id: RunId) -> Result<()> {
    let required = [
        (
            "table",
            "governed_dispatch_v5_signature_scan_index",
            GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_INDEX_TABLE_SQL,
        ),
        (
            "index",
            "idx_governed_dispatch_v5_signature_scan_exact",
            GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_EXACT_INDEX_SQL,
        ),
        (
            "trigger",
            "governed_dispatch_v5_signature_scan_after_insert",
            GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_AFTER_INSERT_SQL,
        ),
        (
            "trigger",
            "governed_dispatch_v5_signature_scan_no_update",
            GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_NO_UPDATE_SQL,
        ),
        (
            "trigger",
            "governed_dispatch_v5_signature_scan_no_delete",
            GOVERNED_DISPATCH_V5_SIGNATURE_SCAN_NO_DELETE_SQL,
        ),
    ];
    for (object_type, name, expected_sql) in required {
        let sql = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2",
                params![object_type, name],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let expected_tokens = tokenize_sqlite_schema_sql(expected_sql)
            .expect("static V5 source scan schema SQL must be lexically closed");
        if !sql
            .as_deref()
            .and_then(tokenize_sqlite_schema_sql)
            .is_some_and(|tokens| tokens == expected_tokens)
        {
            return Err(governed_dispatch_v5_admission_reconciliation_required(
                run_id,
                "unresolved",
                format!("required V5 source scan schema object {name} is missing or corrupt"),
            ));
        }
    }
    Ok(())
}

fn require_governed_dispatch_v5_signature_scan_index_row(
    conn: &Connection,
    run_id: RunId,
    event_rowid: i64,
    event_id: &str,
) -> Result<()> {
    let source = conn
        .query_row(
            "SELECT
                 s.rowid, e.rowid, e.id, e.run_id,
                 json_extract(
                     e.payload,
                     '$.DispatchEnvelopeV5.envelope_digest'
                 ),
                 s.actor_id, s.key_id, s.public_key_hash, s.algorithm
             FROM events e
             JOIN event_signatures s ON s.event_id = e.id
             WHERE e.rowid = ?1 AND e.id = ?2",
            params![event_rowid, event_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?;
    let Some(source) = source else {
        return Ok(());
    };
    let indexed = conn
        .query_row(
            "SELECT
                 signature_rowid, event_rowid, event_id, run_id,
                 v5_envelope_digest, actor_id, key_id,
                 public_key_hash, algorithm
             FROM governed_dispatch_v5_signature_scan_index
             WHERE signature_rowid = ?1",
            params![source.0],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?;
    if indexed.as_ref() != Some(&source) {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "append-derived V5 signature scan index row is missing or corrupt",
        ));
    }
    Ok(())
}

fn bootstrap_governed_dispatch_v5_signature_scan_index(
    tx: &Transaction<'_>,
    projection: &mut StoredGovernedDispatchV5SourceScan,
    run_id: RunId,
    v5_envelope_digest: &str,
    budget: usize,
) -> Result<usize> {
    if budget == 0 || projection.event_cursor_rowid >= projection.observed_event_high_water_rowid {
        return Ok(0);
    }
    let mut statement = tx.prepare(V5_SOURCE_EVENT_BOOTSTRAP_QUERY_V1)?;
    let rows = statement
        .query_map(
            params![
                run_id.to_string(),
                v5_envelope_digest,
                projection.event_cursor_rowid,
                projection.observed_event_high_water_rowid,
                i64::try_from(budget).unwrap_or(i64::MAX),
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > budget {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "V5 source event bootstrap exceeded its fixed row budget",
        ));
    }
    for (event_rowid, event_id) in &rows {
        if *event_rowid <= projection.event_cursor_rowid
            || *event_rowid > projection.observed_event_high_water_rowid
        {
            return Err(governed_dispatch_v5_admission_reconciliation_required(
                run_id,
                "unresolved",
                "V5 source event bootstrap returned a non-monotonic row",
            ));
        }
        tx.execute(
            r#"INSERT OR IGNORE INTO governed_dispatch_v5_signature_scan_index (
                   signature_rowid, event_rowid, event_id, run_id,
                   v5_envelope_digest, actor_id, key_id,
                   public_key_hash, algorithm
               )
               SELECT
                   s.rowid, e.rowid, e.id, e.run_id,
                   json_extract(
                       e.payload,
                       '$.DispatchEnvelopeV5.envelope_digest'
                   ),
                   s.actor_id, s.key_id, s.public_key_hash, s.algorithm
               FROM events e
               JOIN event_signatures s ON s.event_id = e.id
               WHERE e.rowid = ?1 AND e.id = ?2"#,
            params![event_rowid, event_id],
        )?;
        require_governed_dispatch_v5_signature_scan_index_row(tx, run_id, *event_rowid, event_id)?;
        projection.event_cursor_rowid = *event_rowid;
    }
    if projection.event_cursor_rowid == projection.observed_event_high_water_rowid {
        projection.event_complete_through_rowid = Some(projection.observed_event_high_water_rowid);
    }
    Ok(rows.len())
}

fn governed_dispatch_v5_source_scan_projection(
    conn: &Connection,
    run_id: RunId,
    v5_envelope_digest: &str,
    source_authority_fingerprint: &str,
) -> Result<Option<StoredGovernedDispatchV5SourceScan>> {
    conn.query_row(
        "SELECT
             run_id, v5_envelope_digest, source_authority_fingerprint,
             scan_schema_version, event_cursor_rowid,
             observed_event_high_water_rowid, event_complete_through_rowid,
             cursor_signature_rowid, observed_high_water_rowid,
             complete_through_signature_rowid, candidate_signature_rowid,
             candidate_event_id, candidate_event_digest, ambiguous
         FROM governed_dispatch_v5_source_scans
         WHERE run_id = ?1
           AND v5_envelope_digest = ?2
           AND source_authority_fingerprint = ?3",
        params![
            run_id.to_string(),
            v5_envelope_digest,
            source_authority_fingerprint
        ],
        |row| {
            let candidate_event_id = row
                .get::<_, Option<String>>(11)?
                .map(|value| parse_event_id(&value, "V5 source scan candidate"))
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        11,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(StoredGovernedDispatchV5SourceScan {
                run_id: row.get(0)?,
                v5_envelope_digest: row.get(1)?,
                source_authority_fingerprint: row.get(2)?,
                scan_schema_version: row.get(3)?,
                event_cursor_rowid: row.get(4)?,
                observed_event_high_water_rowid: row.get(5)?,
                event_complete_through_rowid: row.get(6)?,
                cursor_signature_rowid: row.get(7)?,
                observed_high_water_rowid: row.get(8)?,
                complete_through_signature_rowid: row.get(9)?,
                candidate_signature_rowid: row.get(10)?,
                candidate_event_id,
                candidate_event_digest: row.get(12)?,
                ambiguous: row.get::<_, i64>(13)? == 1,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn persist_governed_dispatch_v5_source_scan_projection(
    tx: &Transaction<'_>,
    projection: &StoredGovernedDispatchV5SourceScan,
) -> Result<()> {
    tx.execute(
        r#"INSERT INTO governed_dispatch_v5_source_scans (
               run_id, v5_envelope_digest, source_authority_fingerprint,
               scan_schema_version, event_cursor_rowid,
               observed_event_high_water_rowid, event_complete_through_rowid,
               cursor_signature_rowid, observed_high_water_rowid,
               complete_through_signature_rowid, candidate_signature_rowid,
               candidate_event_id, candidate_event_digest, ambiguous
           ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
           )
           ON CONFLICT(run_id, v5_envelope_digest, source_authority_fingerprint)
           DO UPDATE SET
               scan_schema_version = excluded.scan_schema_version,
               event_cursor_rowid = excluded.event_cursor_rowid,
               observed_event_high_water_rowid =
                   excluded.observed_event_high_water_rowid,
               event_complete_through_rowid =
                   excluded.event_complete_through_rowid,
               cursor_signature_rowid = excluded.cursor_signature_rowid,
               observed_high_water_rowid = excluded.observed_high_water_rowid,
               complete_through_signature_rowid =
                   excluded.complete_through_signature_rowid,
               candidate_signature_rowid = excluded.candidate_signature_rowid,
               candidate_event_id = excluded.candidate_event_id,
               candidate_event_digest = excluded.candidate_event_digest,
               ambiguous = excluded.ambiguous"#,
        params![
            projection.run_id,
            projection.v5_envelope_digest,
            projection.source_authority_fingerprint,
            projection.scan_schema_version,
            projection.event_cursor_rowid,
            projection.observed_event_high_water_rowid,
            projection.event_complete_through_rowid,
            projection.cursor_signature_rowid,
            projection.observed_high_water_rowid,
            projection.complete_through_signature_rowid,
            projection.candidate_signature_rowid,
            projection
                .candidate_event_id
                .map(|event_id| event_id.to_string()),
            projection.candidate_event_digest,
            i64::from(projection.ambiguous),
        ],
    )?;
    Ok(())
}

fn verified_governed_dispatch_v5_source_scan_candidate(
    event_row: &StoredEventRow,
    signature_row: &StoredEventSignatureRow,
    run_id: RunId,
    v5_envelope_digest: &str,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    mut on_cryptographic_verification: impl FnMut(),
) -> Result<Option<(EventId, String)>> {
    if event_row.run_id != run_id.to_string()
        || event_row.kind != "dispatch_envelope_v5"
        || signature_row.algorithm != "ed25519"
    {
        return Ok(None);
    }
    let Ok(event) = event_row.to_event().and_then(canonicalize) else {
        return Ok(None);
    };
    let Payload::DispatchEnvelopeV5(dispatch) = &event.payload else {
        return Ok(None);
    };
    if dispatch.envelope_digest != v5_envelope_digest {
        return Ok(None);
    }
    let Ok(signature) = signature_row.to_event_signature() else {
        return Ok(None);
    };
    if !actor_matches(&authority.source_dispatch_signer, &signature.signer) {
        return Ok(None);
    }
    on_cryptographic_verification();
    if verify_event_signature(&event, &signature, &authority.trusted_keys)
        != VerificationStatus::Verified
    {
        return Ok(None);
    }
    let event_digest = canonical_event_hash(&event).map_err(|error| {
        governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            format!("verified V5 source event hash could not be recomputed: {error}"),
        )
    })?;
    if signature.canonical_event_hash != event_digest {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "verified V5 source signature carries a mismatched canonical event hash",
        ));
    }
    let recomputed = dispatch_envelope_v5_digest(dispatch).map_err(|error| {
        governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            format!("verified V5 source envelope digest could not be recomputed: {error}"),
        )
    })?;
    if recomputed != v5_envelope_digest {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "verified V5 source carries a noncanonical detached envelope digest",
        ));
    }
    Ok(Some((event.id, event_digest)))
}

fn reverify_governed_dispatch_v5_projected_candidate(
    conn: &Connection,
    projection: &StoredGovernedDispatchV5SourceScan,
    run_id: RunId,
    v5_envelope_digest: &str,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<Option<EventId>> {
    let (Some(signature_rowid), Some(event_id), Some(expected_event_digest)) = (
        projection.candidate_signature_rowid,
        projection.candidate_event_id,
        projection.candidate_event_digest.as_deref(),
    ) else {
        return Ok(None);
    };
    let mut statement = conn.prepare(
        "SELECT
             e.id, e.run_id, e.parent_event_id, e.schema_version,
             e.kind, e.occurred_at, e.payload,
             s.event_id, s.canonical_event_hash, s.actor_id, s.key_id,
             s.public_key_hash, s.algorithm, s.signature, s.signed_at
         FROM event_signatures s
         JOIN events e ON e.id = s.event_id
         WHERE s.rowid = ?1 AND s.event_id = ?2",
    )?;
    let row = statement
        .query_row(params![signature_rowid, event_id.to_string()], |row| {
            Ok((
                StoredEventRow {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    parent_event_id: row.get(2)?,
                    schema_version: row.get(3)?,
                    kind: row.get(4)?,
                    occurred_at: row.get(5)?,
                    payload: row.get(6)?,
                },
                StoredEventSignatureRow {
                    event_id: row.get(7)?,
                    canonical_event_hash: row.get(8)?,
                    actor_id: row.get(9)?,
                    key_id: row.get(10)?,
                    public_key_hash: row.get(11)?,
                    algorithm: row.get(12)?,
                    signature: row.get(13)?,
                    signed_at: row.get(14)?,
                },
            ))
        })
        .optional()?
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                run_id,
                "unresolved",
                "projected V5 source candidate row is missing",
            )
        })?;
    let verified = verified_governed_dispatch_v5_source_scan_candidate(
        &row.0,
        &row.1,
        run_id,
        v5_envelope_digest,
        authority,
        || {},
    )?
    .ok_or_else(|| {
        governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "projected V5 source candidate no longer verifies",
        )
    })?;
    if verified.0 != event_id || verified.1 != expected_event_digest {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "projected V5 source candidate identity is corrupt",
        ));
    }
    Ok(Some(event_id))
}

fn validate_governed_dispatch_v5_source_scan_projection(
    conn: &Connection,
    projection: &StoredGovernedDispatchV5SourceScan,
    run_id: RunId,
    v5_envelope_digest: &str,
    source_authority_fingerprint: &str,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<()> {
    let candidate_fields_present = [
        projection.candidate_signature_rowid.is_some(),
        projection.candidate_event_id.is_some(),
        projection.candidate_event_digest.is_some(),
    ];
    if projection.scan_schema_version != 1
        || projection.run_id != run_id.to_string()
        || projection.v5_envelope_digest != v5_envelope_digest
        || projection.source_authority_fingerprint != source_authority_fingerprint
        || projection.event_cursor_rowid < 0
        || projection.observed_event_high_water_rowid < projection.event_cursor_rowid
        || projection
            .event_complete_through_rowid
            .is_some_and(|complete| {
                complete != projection.event_cursor_rowid
                    || complete != projection.observed_event_high_water_rowid
            })
        || projection.cursor_signature_rowid < 0
        || projection.observed_high_water_rowid < projection.cursor_signature_rowid
        || !matches!(
            candidate_fields_present,
            [false, false, false] | [true, true, true]
        )
        || projection
            .candidate_signature_rowid
            .is_some_and(|rowid| rowid <= 0 || rowid > projection.cursor_signature_rowid)
        || projection
            .candidate_event_digest
            .as_deref()
            .is_some_and(|digest| !is_canonical_sha256_digest(digest))
        || projection
            .complete_through_signature_rowid
            .is_some_and(|complete| {
                complete != projection.cursor_signature_rowid
                    || complete != projection.observed_high_water_rowid
            })
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "durable V5 source scan projection is corrupt or authority-mismatched",
        ));
    }
    if projection.candidate_event_id.is_some() {
        reverify_governed_dispatch_v5_projected_candidate(
            conn,
            projection,
            run_id,
            v5_envelope_digest,
            authority,
        )?;
    }
    Ok(())
}

fn resolved_governed_dispatch_v5_source_from_projection(
    conn: &Connection,
    projection: &StoredGovernedDispatchV5SourceScan,
    run_id: RunId,
    v5_envelope_digest: &str,
    source_authority_fingerprint: &str,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    current_event_high_water: i64,
    current_signature_high_water: i64,
) -> Result<EventId> {
    validate_governed_dispatch_v5_source_scan_projection(
        conn,
        projection,
        run_id,
        v5_envelope_digest,
        source_authority_fingerprint,
        authority,
    )?;
    if projection.event_cursor_rowid != current_event_high_water
        || projection.observed_event_high_water_rowid != current_event_high_water
        || projection.event_complete_through_rowid != Some(current_event_high_water)
        || projection.cursor_signature_rowid != current_signature_high_water
        || projection.observed_high_water_rowid != current_signature_high_water
        || projection.complete_through_signature_rowid != Some(current_signature_high_water)
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "durable V5 source scan has not reached its stable signature high-water",
        ));
    }
    if projection.ambiguous {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "more than one verified V5 source event has the requested envelope digest",
        ));
    }
    reverify_governed_dispatch_v5_projected_candidate(
        conn,
        projection,
        run_id,
        v5_envelope_digest,
        authority,
    )?
    .ok_or_else(|| {
        governed_dispatch_v5_admission_reconciliation_required(
            run_id,
            "unresolved",
            "completed V5 source scan did not find one verified source event",
        )
    })
}

fn require_complete_governed_dispatch_v5_source_projection(
    tx: &Transaction<'_>,
    request: &GovernedDispatchV5AdmissionRequestV1,
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<()> {
    require_governed_dispatch_v5_source_scan_schema(tx, request.run_id)?;
    let authority_fingerprint = governed_dispatch_v5_source_authority_fingerprint_v1(authority)?;
    let event_high_water = governed_dispatch_v5_source_event_high_water(
        tx,
        request.run_id,
        &evidence.v5_envelope_digest,
    )?;
    let signature_high_water = governed_dispatch_v5_source_signature_high_water(
        tx,
        request.run_id,
        &evidence.v5_envelope_digest,
        authority,
    )?;
    let projection = governed_dispatch_v5_source_scan_projection(
        tx,
        request.run_id,
        &evidence.v5_envelope_digest,
        &authority_fingerprint,
    )?
    .ok_or_else(|| {
        governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "V5 admission has no completed authoritative source scan",
        )
    })?;
    let projected_event_id = resolved_governed_dispatch_v5_source_from_projection(
        tx,
        &projection,
        request.run_id,
        &evidence.v5_envelope_digest,
        &authority_fingerprint,
        authority,
        event_high_water,
        signature_high_water,
    )?;
    if projected_event_id != evidence.dispatch_event_id {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "V5 admission request does not name the completed authoritative source projection",
        ));
    }
    Ok(())
}

fn require_governed_dispatch_v5_admission_receipt_projection(
    conn: &Connection,
    request: &GovernedDispatchV5AdmissionRequestV1,
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
    expected_admission_event_id: Option<EventId>,
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id FROM events
         WHERE run_id = ?1
           AND kind = 'governed_dispatch_v5_admission_recorded_v1'
           AND parent_event_id = ?2
         ORDER BY id ASC",
    )?;
    let event_ids = statement
        .query_map(
            params![
                request.run_id.to_string(),
                evidence.dispatch_event_id.to_string()
            ],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| -> Result<EventId> { parse_event_id(&row?, "V5 admission receipt") })
        .collect::<Result<Vec<_>>>()?;
    match (expected_admission_event_id, event_ids.as_slice()) {
        (None, []) => Ok(()),
        (Some(expected), [actual]) if *actual == expected => Ok(()),
        (None, _) => Err(governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "a V5 admission receipt exists without a native admission projection",
        )),
        (Some(_), _) => Err(governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "V5 admission projection does not name the only receipt parented to its source dispatch",
        )),
    }
}

fn insert_governed_dispatch_v5_admission(
    conn: &Connection,
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    event: &Event,
    event_digest: &str,
) -> Result<()> {
    let witness_evidence_digest =
        governed_dispatch_v5_admission_witness_evidence_digest_v1(evidence, authority)?;
    conn.execute(
        r#"INSERT INTO governed_dispatch_v5_admissions (
                run_id, idempotency_key, workflow_id, workflow_revision, unit_id, attempt,
                semantic_identity_digest, source_dispatch_event_id, source_dispatch_event_digest,
                v5_envelope_digest, v4_envelope_digest,
                v4_graph_declaration_event_id, v4_graph_declaration_event_digest, v4_graph_digest,
                context_manifest_event_id, context_manifest_event_digest, context_manifest_digest,
                worker_manifest_event_id, worker_manifest_event_digest, worker_manifest_digest,
                sandbox_profile_event_id, sandbox_profile_event_digest, sandbox_profile_digest,
                retry_context_event_id, retry_context_event_digest, retry_context_digest,
                witness_evidence_digest, ledger_authority_realm_digest,
                admission_event_id, admission_event_digest, state, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
                ?27, ?28, ?29, ?30, 'awaiting_checkpoint', ?31
            )"#,
        params![
            evidence.run_id.to_string(),
            &evidence.idempotency_key,
            &evidence.workflow_id,
            &evidence.workflow_revision,
            &evidence.unit_id,
            evidence.attempt,
            &evidence.semantic_identity_digest,
            evidence.dispatch_event_id.to_string(),
            &evidence.dispatch_event_digest,
            &evidence.v5_envelope_digest,
            &evidence.v4_envelope_digest,
            evidence.v4_graph_declaration_event_id.to_string(),
            &evidence.v4_graph_declaration_event_digest,
            &evidence.v4_graph_digest,
            evidence.context_manifest_event_id.to_string(),
            &evidence.context_manifest_event_digest,
            &evidence.context_manifest_digest,
            evidence.worker_manifest_event_id.to_string(),
            &evidence.worker_manifest_event_digest,
            &evidence.worker_manifest_digest,
            evidence.sandbox_profile_event_id.to_string(),
            &evidence.sandbox_profile_event_digest,
            &evidence.sandbox_profile_digest,
            evidence
                .retry_context_event_id
                .map(|event_id| event_id.to_string()),
            &evidence.retry_context_event_digest,
            &evidence.retry_context_digest,
            witness_evidence_digest,
            &authority.ledger_authority_realm_digest,
            event.id.to_string(),
            event_digest,
            event.occurred_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn load_verified_governed_dispatch_v5_admission_event(
    conn: &Connection,
    admission_event_id: EventId,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, admission_event_id)? else {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission receipt is missing from the tape",
        );
    };
    let Some(signature) = signature else {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission receipt is unsigned",
        );
    };
    let event = canonicalize(event).map_err(|error| {
        LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: format!("governed V5 admission receipt is not canonical: {error}"),
        }
    })?;
    if !actor_matches(&authority.admission_record_signer, &signature.signer)
        || verify_event_signature(&event, &signature, &authority.trusted_keys)
            != VerificationStatus::Verified
    {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission receipt signature is not verified for the configured admission-record authority",
        );
    }
    let event_digest = canonical_event_hash(&event).map_err(|error| {
        LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: format!("could not canonicalize governed V5 admission receipt: {error}"),
        }
    })?;
    if signature.canonical_event_hash != event_digest {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission receipt signature hash does not match its canonical event",
        );
    }
    Ok(event)
}

fn verify_stored_governed_dispatch_v5_admission(
    tx: &Transaction<'_>,
    stored: &StoredGovernedDispatchV5Admission,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<VerifiedGovernedDispatchV5ObservationEvidence> {
    let evidence = v5_observation_proof::verify_admission_evidence_in_tx(
        tx,
        stored.run_id,
        stored.source_dispatch_event_id,
        authority,
    )?;
    let request = GovernedDispatchV5AdmissionRequestV1 {
        run_id: stored.run_id,
        dispatch_event_id: stored.source_dispatch_event_id,
    };
    require_complete_governed_dispatch_v5_source_projection(tx, &request, &evidence, authority)?;
    let witness_evidence_digest =
        governed_dispatch_v5_admission_witness_evidence_digest_v1(&evidence, authority)?;
    if !stored.matches_evidence(&evidence, authority, &witness_evidence_digest) {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission projection does not exactly match its re-derived raw-tape witnesses",
        ));
    }
    if stored.source_dispatch_event_id.as_uuid() >= stored.admission_event_id.as_uuid() {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission receipt does not follow its source dispatch in tape order",
        ));
    }
    let event = load_verified_governed_dispatch_v5_admission_event(
        &*tx,
        stored.admission_event_id,
        authority,
    )?;
    let event_digest = canonical_event_hash(&event).map_err(|error| {
        governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            format!("could not canonicalize stored V5 admission receipt: {error}"),
        )
    })?;
    let Payload::GovernedDispatchV5AdmissionRecordedV1(receipt) = event.payload else {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission projection points to a non-admission-receipt tape event",
        ));
    };
    if event.run_id != stored.run_id
        || event.parent_event_id != Some(stored.source_dispatch_event_id)
        || event.kind != EventKind::GovernedDispatchV5AdmissionRecordedV1
        || event_digest != stored.admission_event_digest
        || receipt.run_id != stored.run_id.to_string()
        || receipt.source_dispatch_event_ref != stored.source_dispatch_event_id
        || receipt.source_dispatch_event_digest != stored.source_dispatch_event_digest
        || receipt.dispatch_envelope_digest != stored.v5_envelope_digest
        || receipt.witness_evidence_digest != stored.witness_evidence_digest
        || receipt.witness_evidence_digest != witness_evidence_digest
        || receipt.semantic_identity_digest != stored.semantic_identity_digest
        || receipt.idempotency_key != stored.idempotency_key
        || receipt.ledger_authority_realm_digest != authority.ledger_authority_realm_digest
        || receipt.ledger_authority_realm_digest != stored.ledger_authority_realm_digest
        || receipt.admitted_at != timestamp(event.occurred_at.clone())
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission projection or signed admission receipt is substituted or corrupt",
        ));
    }
    require_governed_dispatch_v5_admission_receipt_projection(
        &*tx,
        &request,
        &evidence,
        Some(stored.admission_event_id),
    )?;
    Ok(evidence)
}

fn awaiting_governed_dispatch_v5_admission_disposition(
    stored: &StoredGovernedDispatchV5Admission,
) -> GovernedDispatchV5AdmissionDispositionV1 {
    GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
        source_dispatch_event_id: stored.source_dispatch_event_id,
        source_dispatch_event_digest: stored.source_dispatch_event_digest.clone(),
        admission_event_id: stored.admission_event_id,
        admission_event_digest: stored.admission_event_digest.clone(),
        v5_envelope_digest: stored.v5_envelope_digest.clone(),
        witness_evidence_digest: stored.witness_evidence_digest.clone(),
        semantic_identity_digest: stored.semantic_identity_digest.clone(),
        idempotency_key: stored.idempotency_key.clone(),
    }
}

fn resolve_existing_governed_dispatch_v5_admission(
    tx: &Transaction<'_>,
    stored: &StoredGovernedDispatchV5Admission,
    request: &GovernedDispatchV5AdmissionRequestV1,
    evidence: &VerifiedGovernedDispatchV5ObservationEvidence,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<GovernedDispatchV5AdmissionDispositionV1> {
    if stored.run_id != request.run_id
        || stored.source_dispatch_event_id != request.dispatch_event_id
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "V5 admission source dispatch does not match its native projection",
        ));
    }
    let rederived = verify_stored_governed_dispatch_v5_admission(tx, stored, authority)?;
    if rederived.dispatch_event_id != evidence.dispatch_event_id
        || rederived.dispatch_event_digest != evidence.dispatch_event_digest
        || rederived.semantic_identity_digest != evidence.semantic_identity_digest
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            request.run_id,
            &evidence.idempotency_key,
            "V5 admission replay re-derived different source witness evidence",
        ));
    }
    match stored.state {
        StoredGovernedDispatchV5AdmissionState::AwaitingCheckpoint => {
            Ok(awaiting_governed_dispatch_v5_admission_disposition(stored))
        }
        StoredGovernedDispatchV5AdmissionState::Sealed => {
            sealed_governed_dispatch_v5_admission_disposition(tx, stored, authority)
        }
    }
}

fn load_verified_governed_dispatch_v5_admission_checkpoint_event(
    conn: &Connection,
    checkpoint_event_id: EventId,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<Event> {
    let Some((event, signature)) = event_and_signature_by_id(conn, checkpoint_event_id)? else {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission checkpoint is missing from the tape",
        );
    };
    let Some(signature) = signature else {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission checkpoint is unsigned",
        );
    };
    let event = canonicalize(event).map_err(|error| {
        LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: format!("governed V5 admission checkpoint is not canonical: {error}"),
        }
    })?;
    if !actor_matches(&authority.checkpoint_signer, &signature.signer)
        || verify_event_signature(&event, &signature, &authority.trusted_keys)
            != VerificationStatus::Verified
    {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission checkpoint signature is not verified for the configured checkpoint authority",
        );
    }
    let event_digest = canonical_event_hash(&event).map_err(|error| {
        LedgerError::GovernedDispatchAdmissionAuthorityRejected {
            reason: format!("could not canonicalize governed V5 admission checkpoint: {error}"),
        }
    })?;
    if signature.canonical_event_hash != event_digest {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission checkpoint signature hash does not match its canonical event",
        );
    }
    Ok(event)
}

fn verified_governed_dispatch_v5_admission_checkpoint_by_id(
    conn: &Connection,
    run_id: RunId,
    checkpoint_event_id: EventId,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<GovernedDispatchV5AdmissionCheckpointEvidence> {
    let event = load_verified_governed_dispatch_v5_admission_checkpoint_event(
        conn,
        checkpoint_event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint) = &event.payload else {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission seal does not reference a TapeCheckpointV1 event",
        );
    };
    if event.run_id != run_id
        || checkpoint.run_id != run_id
        || event.parent_event_id != Some(checkpoint.through_event_id)
    {
        return governed_dispatch_admission_authority_rejected(
            "governed V5 admission checkpoint does not anchor its signed run and covered event",
        );
    }
    Ok(GovernedDispatchV5AdmissionCheckpointEvidence {
        event_id: checkpoint_event_id,
        event_digest: canonical_event_hash(&event)?,
    })
}

fn verify_governed_dispatch_v5_admission_checkpoint_covers(
    conn: &Connection,
    stored: &StoredGovernedDispatchV5Admission,
    checkpoint: &GovernedDispatchV5AdmissionCheckpointEvidence,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<()> {
    let verified = verified_governed_dispatch_v5_admission_checkpoint_by_id(
        conn,
        stored.run_id,
        checkpoint.event_id,
        authority,
    )?;
    if verified != *checkpoint {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission checkpoint digest does not match the immutable sealing evidence",
        ));
    }
    let checkpoint_event = load_verified_governed_dispatch_v5_admission_checkpoint_event(
        conn,
        checkpoint.event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = checkpoint_event.payload else {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission checkpoint evidence no longer carries TapeCheckpointV1 payload",
        ));
    };
    let signed = signed_ordinary_events_for_connection(conn, &stored.run_id)?;
    let Some(admission_index) = signed
        .iter()
        .position(|event| event.event_id == stored.admission_event_id)
    else {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission receipt is absent from the signed ordinary-event prefix",
        ));
    };
    let through_count = usize::try_from(checkpoint_payload.through_event_count).map_err(|_| {
        governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "V5 admission checkpoint through-event count is not representable on this host",
        )
    })?;
    if through_count == 0
        || through_count > signed.len()
        || through_count <= admission_index
        || checkpoint_payload.algorithm != TapeRootAlgorithm::Sha256Linear
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "checkpoint does not cover the exact governed V5 admission receipt",
        ));
    }
    let covered = &signed[..through_count];
    let Some(last) = covered.last() else {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "checkpoint coverage became empty while verifying V5 admission seal",
        ));
    };
    let expected_root = tape_root_hash(
        &covered
            .iter()
            .map(|event| event.canonical_event_hash.clone())
            .collect::<Vec<_>>(),
    );
    if checkpoint_payload.through_event_id != last.event_id
        || checkpoint_payload.tape_root_hash != expected_root
    {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "checkpoint root does not verify the V5 admission receipt signed event prefix",
        ));
    }
    Ok(())
}

fn fully_covering_governed_dispatch_v5_admission_checkpoint(
    conn: &Connection,
    run_id: RunId,
    admission_event_id: EventId,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<Option<GovernedDispatchV5AdmissionCheckpointEvidence>> {
    let signed = signed_ordinary_events_for_connection(conn, &run_id)?;
    let Some(admission_index) = signed
        .iter()
        .position(|event| event.event_id == admission_event_id)
    else {
        return governed_dispatch_admission_authority_rejected(
            "V5 admission receipt is absent from the signed ordinary-event prefix",
        );
    };
    let Some(latest) = latest_checkpoint_for_connection(conn, &run_id)? else {
        return Ok(None);
    };
    let Some(last) = signed.last() else {
        return Ok(None);
    };
    if latest.through_event_count != signed.len() as u64
        || latest.through_event_id != last.event_id
        || latest.through_event_count <= admission_index as u64
    {
        return Ok(None);
    }
    let checkpoint = verified_governed_dispatch_v5_admission_checkpoint_by_id(
        conn,
        run_id,
        latest.event_id,
        authority,
    )?;
    let checkpoint_event = load_verified_governed_dispatch_v5_admission_checkpoint_event(
        conn,
        checkpoint.event_id,
        authority,
    )?;
    let Payload::TapeCheckpointV1(checkpoint_payload) = checkpoint_event.payload else {
        return governed_dispatch_admission_authority_rejected(
            "latest V5 admission checkpoint does not carry TapeCheckpointV1 payload",
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
        return governed_dispatch_admission_authority_rejected(
            "latest V5 admission checkpoint does not verify the complete signed prefix",
        );
    }
    Ok(Some(checkpoint))
}

fn sealed_governed_dispatch_v5_admission_checkpoint(
    conn: &Connection,
    stored: &StoredGovernedDispatchV5Admission,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<GovernedDispatchV5AdmissionCheckpointEvidence> {
    if stored.state != StoredGovernedDispatchV5AdmissionState::Sealed {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "unsealed V5 admission lacks checkpoint evidence",
        ));
    }
    let checkpoint_event_id = stored.sealed_checkpoint_event_id.ok_or_else(|| {
        governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "sealed V5 admission lacks its checkpoint event reference",
        )
    })?;
    let expected_digest = stored
        .sealed_checkpoint_event_digest
        .as_deref()
        .ok_or_else(|| {
            governed_dispatch_v5_admission_reconciliation_required(
                stored.run_id,
                &stored.idempotency_key,
                "sealed V5 admission lacks its checkpoint digest",
            )
        })?;
    let checkpoint = verified_governed_dispatch_v5_admission_checkpoint_by_id(
        conn,
        stored.run_id,
        checkpoint_event_id,
        authority,
    )?;
    if checkpoint.event_digest != expected_digest {
        return Err(governed_dispatch_v5_admission_reconciliation_required(
            stored.run_id,
            &stored.idempotency_key,
            "sealed V5 admission checkpoint digest does not match its immutable projection",
        ));
    }
    verify_governed_dispatch_v5_admission_checkpoint_covers(conn, stored, &checkpoint, authority)?;
    Ok(checkpoint)
}

fn sealed_governed_dispatch_v5_admission_disposition(
    tx: &Transaction<'_>,
    stored: &StoredGovernedDispatchV5Admission,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
) -> Result<GovernedDispatchV5AdmissionDispositionV1> {
    verify_stored_governed_dispatch_v5_admission(tx, stored, authority)?;
    let checkpoint = sealed_governed_dispatch_v5_admission_checkpoint(&*tx, stored, authority)?;
    Ok(GovernedDispatchV5AdmissionDispositionV1::Sealed {
        source_dispatch_event_id: stored.source_dispatch_event_id,
        source_dispatch_event_digest: stored.source_dispatch_event_digest.clone(),
        admission_event_id: stored.admission_event_id,
        admission_event_digest: stored.admission_event_digest.clone(),
        v5_envelope_digest: stored.v5_envelope_digest.clone(),
        witness_evidence_digest: stored.witness_evidence_digest.clone(),
        semantic_identity_digest: stored.semantic_identity_digest.clone(),
        idempotency_key: stored.idempotency_key.clone(),
        checkpoint_event_id: checkpoint.event_id,
        checkpoint_event_digest: checkpoint.event_digest,
    })
}

/// Private proof boundary for V5 observation witnesses. Keeping the proof in
/// its own module prevents unrelated storage code from fabricating it by
/// struct literal; the parent can receive only the non-authoritative audit
/// evidence yielded by `verify_observation_evidence_in_tx`.
mod v5_observation_proof {
    use super::*;

    /// The exact source-event verification material consumed by the private
    /// raw V5 witness proof. Both the observation shadow and the later
    /// protected-host admission receipt use this same tape proof, while their
    /// distinct outer authorities remain unable to mint one another's events.
    struct V5WitnessVerificationAuthority<'a> {
        trusted_keys: &'a TrustedPublicKeys,
        source_dispatch_signer: &'a ActorKeyRef,
        ledger_authority_realm_digest: &'a str,
    }

    /// Storage-private, transaction-scoped witness proof for one first-attempt
    /// V5 dispatch. It is deliberately neither serializable nor cloneable, and
    /// it has no conversion to a V3/V4 dispatch capability.
    #[must_use = "verified V5 witness material must be consumed by a storage-local proof writer"]
    struct VerifiedV5DispatchWitnesses<'tx, 'conn> {
        run_id: RunId,
        dispatch: VerifiedV5TapeEvent<DispatchEnvelopeV5>,
        graph: VerifiedV5TapeEvent<WorkflowGraphDeclaredV2>,
        context: VerifiedV5TapeEvent<ContextManifestDeclaredV1>,
        worker: VerifiedV5TapeEvent<WorkerManifestDeclaredV1>,
        sandbox: VerifiedV5TapeEvent<SandboxProfileDeclaredV1>,
        attempt: VerifiedV5FirstAttempt,
        _transaction: PhantomData<&'tx Transaction<'conn>>,
    }

    /// Marker proving that the private witness constructor rejected every
    /// retry. Retrying requires an outer-V5 recorded-context proof and must
    /// not be inferred from the nested V4 envelope.
    struct VerifiedV5FirstAttempt;

    /// One raw-tape event re-canonicalized and signature-verified inside the
    /// current SQLite transaction. `tape_position` intentionally uses the
    /// ledger's established UUIDv7 append order, not a payload timestamp.
    struct VerifiedV5TapeEvent<T> {
        run_id: RunId,
        event_id: EventId,
        canonical_event_hash: String,
        tape_position: EventId,
        signer: ActorKeyRef,
        kind: EventKind,
        payload: T,
    }

    impl VerifiedV5DispatchWitnesses<'_, '_> {
        /// Convert already-verified private tape material into the immutable
        /// audit projection. This method deliberately exposes only observation
        /// fields; it does not yield a nested dispatch or an executable
        /// capability.
        fn into_observation_evidence(
            self,
        ) -> Result<VerifiedGovernedDispatchV5ObservationEvidence> {
            let dispatch = &self.dispatch.payload;
            let body = &dispatch.dispatch_v4.dispatch_v3.body;

            // Keep the proof self-consistent even if a future change attempts
            // to extend the constructor. Signature validity itself is proven
            // only by `verify_v5_dispatch_witnesses_in_tx` below.
            if self.dispatch.run_id != self.run_id
                || self.graph.run_id != self.run_id
                || self.context.run_id != self.run_id
                || self.worker.run_id != self.run_id
                || self.sandbox.run_id != self.run_id
                || self.dispatch.kind != EventKind::DispatchEnvelopeV5
                || self.graph.kind != EventKind::WorkflowGraphDeclaredV2
                || self.context.kind != EventKind::ContextManifestDeclaredV1
                || self.worker.kind != EventKind::WorkerManifestDeclaredV1
                || self.sandbox.kind != EventKind::SandboxProfileDeclaredV1
                || !verified_v5_tape_event_precedes(&self.graph, &self.dispatch)
                || !verified_v5_tape_event_precedes(&self.context, &self.dispatch)
                || !verified_v5_tape_event_precedes(&self.worker, &self.dispatch)
                || !verified_v5_tape_event_precedes(&self.sandbox, &self.dispatch)
                || !actor_matches(&self.dispatch.signer, &self.graph.signer)
                || !actor_matches(&self.dispatch.signer, &self.context.signer)
                || !actor_matches(&self.dispatch.signer, &self.worker.signer)
                || !actor_matches(&self.dispatch.signer, &self.sandbox.signer)
                || body.attempt != 1
                || dispatch.attempt_context_declaration_event_ref.is_some()
                || dispatch.attempt_context_digest.is_some()
            {
                return governed_dispatch_admission_authority_rejected(
                    "V5 observation witness proof is internally inconsistent",
                );
            }
            match self.attempt {
                VerifiedV5FirstAttempt => {}
            }

            Ok(VerifiedGovernedDispatchV5ObservationEvidence {
                run_id: self.run_id,
                idempotency_key: body.idempotency_key.clone(),
                workflow_id: body.workflow_id.clone(),
                workflow_revision: body.workflow_revision.clone(),
                unit_id: body.unit_id.clone(),
                attempt: body.attempt,
                semantic_identity_digest:
                    governed_dispatch_v5_observation_semantic_identity_digest_v1(
                        self.run_id,
                        dispatch,
                    )?,
                dispatch_event_id: self.dispatch.event_id,
                dispatch_event_digest: self.dispatch.canonical_event_hash.clone(),
                v5_envelope_digest: dispatch.envelope_digest.clone(),
                v4_envelope_digest: dispatch.dispatch_v4.envelope_digest.clone(),
                v4_graph_declaration_event_id: self.graph.event_id,
                v4_graph_declaration_event_digest: self.graph.canonical_event_hash.clone(),
                v4_graph_digest: self.graph.payload.graph_digest.clone(),
                context_manifest_event_id: self.context.event_id,
                context_manifest_event_digest: self.context.canonical_event_hash.clone(),
                context_manifest_digest: self.context.payload.context_manifest_digest.clone(),
                worker_manifest_event_id: self.worker.event_id,
                worker_manifest_event_digest: self.worker.canonical_event_hash.clone(),
                worker_manifest_digest: self.worker.payload.worker_manifest_digest.clone(),
                sandbox_profile_event_id: self.sandbox.event_id,
                sandbox_profile_event_digest: self.sandbox.canonical_event_hash.clone(),
                sandbox_profile_digest: self.sandbox.payload.sandbox_profile_digest.clone(),
                retry_context_event_id: None,
                retry_context_event_digest: None,
                retry_context_digest: None,
            })
        }
    }

    fn verified_v5_tape_event_precedes<T, U>(
        before: &VerifiedV5TapeEvent<T>,
        after: &VerifiedV5TapeEvent<U>,
    ) -> bool {
        before.tape_position.as_uuid() < after.tape_position.as_uuid()
    }

    /// Read one raw V5 witness from the tape. The returned record has been
    /// canonicalized again after SQLite deserialization, is signed by the exact
    /// configured dispatch identity, and is tied to the ledger's canonical append
    /// position. It remains private until the transaction-scoped proof constructor
    /// has checked its type, identity, ordering, and cross-witness bindings.
    fn load_verified_v5_tape_event(
        conn: &Connection,
        event_id: EventId,
        authority: &V5WitnessVerificationAuthority<'_>,
        label: &str,
    ) -> Result<VerifiedV5TapeEvent<Payload>> {
        let Some((event, signature)) = event_and_signature_by_id(conn, event_id)? else {
            return governed_dispatch_admission_authority_rejected(format!(
                "{label} is missing from the tape"
            ));
        };
        let Some(signature) = signature else {
            return governed_dispatch_admission_authority_rejected(format!("{label} is unsigned"));
        };
        let event = canonicalize(event).map_err(|error| {
            LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: format!("{label} is not canonical: {error}"),
            }
        })?;
        if !actor_matches(authority.source_dispatch_signer, &signature.signer)
            || verify_event_signature(&event, &signature, authority.trusted_keys)
                != VerificationStatus::Verified
        {
            return governed_dispatch_admission_authority_rejected(format!(
            "{label} does not carry a verified detached signature from the configured dispatch authority"
        ));
        }
        let event_digest = canonical_event_hash(&event).map_err(|error| {
            LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: format!("{label} could not produce a canonical event hash: {error}"),
            }
        })?;
        if signature.canonical_event_hash != event_digest {
            return governed_dispatch_admission_authority_rejected(format!(
                "{label} detached signature hash does not match its canonical event"
            ));
        }
        Ok(VerifiedV5TapeEvent {
            run_id: event.run_id,
            event_id: event.id,
            canonical_event_hash: event_digest,
            tape_position: event.id,
            signer: signature.signer,
            kind: event.kind,
            payload: event.payload,
        })
    }

    fn expect_verified_v5_tape_payload<T>(
        event: VerifiedV5TapeEvent<Payload>,
        expected_kind: EventKind,
        label: &str,
        extract: impl FnOnce(Payload) -> Option<T>,
    ) -> Result<VerifiedV5TapeEvent<T>> {
        let VerifiedV5TapeEvent {
            run_id,
            event_id,
            canonical_event_hash,
            tape_position,
            signer,
            kind,
            payload,
        } = event;
        if kind != expected_kind {
            return governed_dispatch_admission_authority_rejected(format!(
                "{label} has an unexpected signed tape event kind"
            ));
        }
        let Some(payload) = extract(payload) else {
            return governed_dispatch_admission_authority_rejected(format!(
                "{label} has an unexpected signed tape payload"
            ));
        };
        Ok(VerifiedV5TapeEvent {
            run_id,
            event_id,
            canonical_event_hash,
            tape_position,
            signer,
            kind,
            payload,
        })
    }

    /// Build the sole current V5 witness proof from raw tape inside one immediate
    /// transaction. A successful result is observation material only: no public
    /// dispatch authority, replay projection, or nested V3/V4 capability escapes
    /// this function.
    fn verify_v5_dispatch_witnesses_in_tx<'tx, 'conn>(
        tx: &'tx Transaction<'conn>,
        run_id: RunId,
        dispatch_event_id: EventId,
        authority: &V5WitnessVerificationAuthority<'_>,
    ) -> Result<VerifiedV5DispatchWitnesses<'tx, 'conn>> {
        let dispatch = expect_verified_v5_tape_payload(
            load_verified_v5_tape_event(&*tx, dispatch_event_id, authority, "V5 dispatch")?,
            EventKind::DispatchEnvelopeV5,
            "V5 dispatch",
            |payload| match payload {
                Payload::DispatchEnvelopeV5(dispatch) => Some(dispatch),
                _ => None,
            },
        )?;
        if dispatch.run_id != run_id {
            return governed_dispatch_admission_authority_rejected(
                "V5 observation request does not name a V5 dispatch in its requested run",
            );
        }
        let body = &dispatch.payload.dispatch_v4.dispatch_v3.body;
        if dispatch
            .payload
            .dispatch_v4
            .dispatch_v3
            .ledger_authority_realm_digest
            != authority.ledger_authority_realm_digest
        {
            return governed_dispatch_admission_authority_rejected(
                "V5 observation dispatch does not belong to the configured protected ledger realm",
            );
        }

        // No observation of a retry may be mistaken for proof that the complete
        // outer-V5 retry lineage (including feedback inclusion) was verified.
        // Keep all retries fail-closed until that reducer exists at this storage
        // boundary. We deliberately do not issue a retry witness shadow here.
        if body.attempt != 1 {
            return governed_dispatch_admission_authority_rejected(
                "V5 retry observations require complete outer-V5 retry proof and are unsupported",
            );
        }
        if dispatch
            .payload
            .attempt_context_declaration_event_ref
            .is_some()
            || dispatch.payload.attempt_context_digest.is_some()
        {
            return governed_dispatch_admission_authority_rejected(
                "first-attempt V5 observation cannot carry retry declaration material",
            );
        }

        let graph = expect_verified_v5_tape_payload(
            load_verified_v5_tape_event(
                &*tx,
                dispatch
                    .payload
                    .dispatch_v4
                    .workflow_graph_declaration_event_ref,
                authority,
                "V5 workflow graph declaration",
            )?,
            EventKind::WorkflowGraphDeclaredV2,
            "V5 workflow graph declaration",
            |payload| match payload {
                Payload::WorkflowGraphDeclaredV2(graph) => Some(graph),
                _ => None,
            },
        )?;
        if graph.run_id != run_id || !verified_v5_tape_event_precedes(&graph, &dispatch) {
            return governed_dispatch_admission_authority_rejected(
            "V5 workflow graph declaration must be a signed preceding event in the dispatch run",
        );
        }
        let expected_graph_digest = workflow_graph_v2_digest(&graph.payload).map_err(|error| {
            LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: format!("V5 workflow graph declaration digest is not canonical: {error}"),
            }
        })?;
        if graph.payload.run_id != run_id.to_string()
            || graph.payload.workflow_id != body.workflow_id
            || graph.payload.workflow_revision != body.workflow_revision
            || graph.payload.graph_digest != expected_graph_digest
            || graph.payload.graph_digest != dispatch.payload.dispatch_v4.workflow_graph_digest
        {
            return governed_dispatch_admission_authority_rejected(
                "V5 graph witness does not exactly bind the nested V4 workflow authority",
            );
        }
        let mut graph_nodes = graph
            .payload
            .nodes
            .iter()
            .filter(|node| node.unit_id == body.unit_id);
        let Some(graph_node) = graph_nodes.next() else {
            return governed_dispatch_admission_authority_rejected(
                "V5 graph witness has no node for the nested dispatch unit",
            );
        };
        if graph_nodes.next().is_some()
            || graph_node.execution_role != body.execution_role
            || Some(graph_node.governed_packet_digest.as_str())
                != dispatch
                    .payload
                    .dispatch_v4
                    .dispatch_v3
                    .governed_packet_digest
                    .as_deref()
        {
            return governed_dispatch_admission_authority_rejected(
            "V5 graph witness node does not exactly bind the nested V4 dispatch role and governed packet",
        );
        }

        let context = expect_verified_v5_tape_payload(
            load_verified_v5_tape_event(
                &*tx,
                dispatch.payload.context_manifest_declaration_event_ref,
                authority,
                "V5 context manifest declaration",
            )?,
            EventKind::ContextManifestDeclaredV1,
            "V5 context manifest declaration",
            |payload| match payload {
                Payload::ContextManifestDeclaredV1(context) => Some(context),
                _ => None,
            },
        )?;
        if context.run_id != run_id || !verified_v5_tape_event_precedes(&context, &dispatch) {
            return governed_dispatch_admission_authority_rejected(
            "V5 context manifest declaration must be a signed preceding event in the dispatch run",
        );
        }

        let worker = expect_verified_v5_tape_payload(
            load_verified_v5_tape_event(
                &*tx,
                dispatch.payload.worker_manifest_declaration_event_ref,
                authority,
                "V5 worker manifest declaration",
            )?,
            EventKind::WorkerManifestDeclaredV1,
            "V5 worker manifest declaration",
            |payload| match payload {
                Payload::WorkerManifestDeclaredV1(worker) => Some(worker),
                _ => None,
            },
        )?;
        if worker.run_id != run_id || !verified_v5_tape_event_precedes(&worker, &dispatch) {
            return governed_dispatch_admission_authority_rejected(
            "V5 worker manifest declaration must be a signed preceding event in the dispatch run",
        );
        }

        let sandbox = expect_verified_v5_tape_payload(
            load_verified_v5_tape_event(
                &*tx,
                dispatch.payload.sandbox_profile_declaration_event_ref,
                authority,
                "V5 sandbox profile declaration",
            )?,
            EventKind::SandboxProfileDeclaredV1,
            "V5 sandbox profile declaration",
            |payload| match payload {
                Payload::SandboxProfileDeclaredV1(sandbox) => Some(sandbox),
                _ => None,
            },
        )?;
        if sandbox.run_id != run_id || !verified_v5_tape_event_precedes(&sandbox, &dispatch) {
            return governed_dispatch_admission_authority_rejected(
            "V5 sandbox profile declaration must be a signed preceding event in the dispatch run",
        );
        }

        validate_v5_manifest_declaration_witnesses(
            &dispatch.payload,
            &run_id.to_string(),
            V5ManifestDeclarationWitnesses {
                context_manifest: Some(V5ContextManifestDeclarationWitness::from_declaration(
                    &context.event_id,
                    &context.payload,
                )),
                worker_manifest: Some(V5WorkerManifestDeclarationWitness::from_declaration(
                    &worker.event_id,
                    &worker.payload,
                )),
                sandbox_profile: Some(V5SandboxProfileDeclarationWitness::from_declaration(
                    &sandbox.event_id,
                    &sandbox.payload,
                )),
                attempt_context: None,
            },
        )
        .map_err(
            |error| LedgerError::GovernedDispatchAdmissionAuthorityRejected {
                reason: format!(
                    "V5 manifest declaration witnesses do not bind the dispatch: {error}"
                ),
            },
        )?;

        Ok(VerifiedV5DispatchWitnesses {
            run_id,
            dispatch,
            graph,
            context,
            worker,
            sandbox,
            attempt: VerifiedV5FirstAttempt,
            _transaction: PhantomData,
        })
    }

    /// The sole parent-visible V5 proof operation. It returns only immutable
    /// observation fields, never the private witness proof or nested V3/V4
    /// authority material.
    pub(super) fn verify_observation_evidence_in_tx(
        tx: &Transaction<'_>,
        run_id: RunId,
        dispatch_event_id: EventId,
        authority: &GovernedDispatchAdmissionAuthorityV1,
    ) -> Result<VerifiedGovernedDispatchV5ObservationEvidence> {
        let source_authority = V5WitnessVerificationAuthority {
            trusted_keys: &authority.trusted_keys,
            source_dispatch_signer: &authority.dispatch_signer,
            ledger_authority_realm_digest: &authority.ledger_authority_realm_digest,
        };
        verify_v5_dispatch_witnesses_in_tx(tx, run_id, dispatch_event_id, &source_authority)?
            .into_observation_evidence()
    }

    /// Re-derive the same raw V5 witnesses for a protected admission record.
    /// This intentionally bypasses the observation table: the table is an
    /// audit cache, never a source of admission authority.
    pub(super) fn verify_admission_evidence_in_tx(
        tx: &Transaction<'_>,
        run_id: RunId,
        dispatch_event_id: EventId,
        authority: &GovernedDispatchV5AdmissionAuthorityV1,
    ) -> Result<VerifiedGovernedDispatchV5ObservationEvidence> {
        let source_authority = V5WitnessVerificationAuthority {
            trusted_keys: &authority.trusted_keys,
            source_dispatch_signer: &authority.source_dispatch_signer,
            ledger_authority_realm_digest: &authority.ledger_authority_realm_digest,
        };
        verify_v5_dispatch_witnesses_in_tx(tx, run_id, dispatch_event_id, &source_authority)?
            .into_observation_evidence()
    }
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

fn promotion_reconciliation_authority_rejected(reason: impl Into<String>) -> LedgerError {
    LedgerError::PromotionAuthorityRejected {
        reason: reason.into(),
    }
}

#[allow(clippy::too_many_arguments)]
fn governed_promotion_reconciliation_abandon_payload(
    conn: &Connection,
    request: &GovernedPromotionReconciliationRequestV1,
    decision: &StoredGovernedPromotionDecision,
    verified: &VerifiedStoredGovernedPromotionDecision,
    result: &StoredGovernedPromotionResult,
    authority: &GovernedPromotionAuthorityV1,
    now: DateTime<Utc>,
) -> Result<PromotionReconciliationResolvedV1> {
    if result.run_id != request.run_id
        || result.promotion_decision_event_id != request.promotion_decision_event_id
        || result.promotion_result_event_id != request.promotion_result_event_id
        || result.candidate_digest != decision.candidate_digest
        || result.idempotency_key != decision.idempotency_key
        || result.promotion_decision_event_digest != decision.promotion_decision_event_digest
    {
        return Err(promotion_reconciliation_authority_rejected(
            "promotion reconciliation result projection identity does not match the sealed decision",
        ));
    }
    let event = load_verified_promotion_event(
        conn,
        result.promotion_result_event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "promotion result",
    )?;
    if event.run_id != request.run_id
        || event.parent_event_id != Some(decision.promotion_decision_event_id)
        || canonical_event_hash(&event)? != result.promotion_result_event_digest
    {
        return Err(promotion_reconciliation_authority_rejected(
            "promotion reconciliation result event does not bind its native projection",
        ));
    }
    let Payload::PromotionResultRecordedV1(payload) = &event.payload else {
        return Err(promotion_reconciliation_authority_rejected(
            "promotion reconciliation projection does not reference a promotion result event",
        ));
    };
    if payload.candidate_digest != result.candidate_digest
        || payload.idempotency_key != result.idempotency_key
        || payload.promotion_decision_ref != decision.promotion_decision_event_id.to_string()
        || payload.outcome != result.outcome
        || payload.merged_head_sha != result.merged_head_sha
        || payload.promotion_git_binding != result.promotion_git_binding
        || payload.completed_at != result.completed_at
    {
        return Err(promotion_reconciliation_authority_rejected(
            "promotion reconciliation result projection does not match its signed tape event",
        ));
    }
    let result_request = GovernedPromotionResultRequestV1 {
        run_id: request.run_id,
        promotion_decision_event_id: request.promotion_decision_event_id,
        outcome: payload.outcome,
        merged_head_sha: payload.merged_head_sha.clone(),
        promotion_git_binding: payload.promotion_git_binding.clone(),
        promotion_execution_lease_binding: payload.promotion_execution_lease_binding.clone(),
    };
    validate_governed_promotion_result_against_decision(&result_request, decision, verified)?;
    validate_governed_promotion_result_execution_lease(
        conn,
        &result_request,
        decision,
        verified,
        authority,
        None,
    )?;
    if payload.outcome != PromotionResultOutcomeV1::ReconciliationRequired {
        return Err(promotion_reconciliation_authority_rejected(
            "promotion reconciliation requires a recorded reconciliation-required result",
        ));
    }
    let receipt_ref = payload
        .promotion_git_binding
        .as_ref()
        .and_then(|binding| binding.promotion_receipt_ref.as_ref())
        .filter(|receipt_ref| !receipt_ref.trim().is_empty())
        .ok_or_else(|| {
            promotion_reconciliation_authority_rejected(
                "promotion reconciliation requires the recorded immutable promotion receipt",
            )
        })?;
    let authority_actor = authority.operator_signer.actor_id.clone();
    Ok(PromotionReconciliationResolvedV1 {
        candidate_digest: result.candidate_digest.clone(),
        promotion_decision_ref: decision.promotion_decision_event_id.to_string(),
        promotion_result_ref: result.promotion_result_event_id.to_string(),
        promotion_receipt_ref: receipt_ref.clone(),
        outcome: ReconciliationResolutionOutcomeV1::Abandon,
        authority: authority_actor.clone(),
        resolved_by: authority_actor,
        idempotency_key: format!(
            "promotion-reconciliation-abandon:{}",
            result.idempotency_key
        ),
        resolved_at: timestamp(now),
    })
}

fn existing_governed_promotion_reconciliation_abandon(
    conn: &Connection,
    run_id: RunId,
    promotion_result_event_id: EventId,
    expected: &PromotionReconciliationResolvedV1,
    authority: &GovernedPromotionAuthorityV1,
) -> Result<Option<(EventId, String)>> {
    let mut statement =
        conn.prepare("SELECT id FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY id ASC")?;
    let ids = statement
        .query_map(
            params![
                run_id.to_string(),
                EventKind::PromotionReconciliationResolved.as_wire()
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut existing = None;
    for id in ids {
        let event_id = parse_event_id(&id, "promotion reconciliation")?;
        let event = load_verified_promotion_event(
            conn,
            event_id,
            &authority.trusted_keys,
            &authority.operator_signer,
            "promotion reconciliation",
        )?;
        let Payload::PromotionReconciliationResolvedV1(payload) = &event.payload else {
            return Err(promotion_reconciliation_authority_rejected(
                "promotion reconciliation event has an unexpected payload",
            ));
        };
        let binds_same_promotion = payload.promotion_result_ref == expected.promotion_result_ref
            || payload.promotion_decision_ref == expected.promotion_decision_ref
            || payload.candidate_digest == expected.candidate_digest;
        if !binds_same_promotion {
            continue;
        }
        if event.parent_event_id != Some(promotion_result_event_id)
            || payload.candidate_digest != expected.candidate_digest
            || payload.promotion_decision_ref != expected.promotion_decision_ref
            || payload.promotion_result_ref != expected.promotion_result_ref
            || payload.promotion_receipt_ref != expected.promotion_receipt_ref
            || payload.outcome != ReconciliationResolutionOutcomeV1::Abandon
            || payload.authority != expected.authority
            || payload.resolved_by != expected.resolved_by
            || payload.idempotency_key != expected.idempotency_key
            || payload.resolved_at != timestamp(event.occurred_at)
        {
            return Err(promotion_reconciliation_authority_rejected(
                "a different promotion reconciliation event already binds this immutable promotion",
            ));
        }
        let event_digest = canonical_event_hash(&event)?;
        if existing.replace((event.id, event_digest)).is_some() {
            return Err(promotion_reconciliation_authority_rejected(
                "more than one matching promotion reconciliation event exists",
            ));
        }
    }
    Ok(existing)
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
         WHERE e.run_id = ?1
           AND e.kind != 'tape_checkpoint'
           AND s.algorithm = 'ed25519'
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

fn checkpoint_events_for_run_for_connection(
    conn: &Connection,
    run_id: &RunId,
) -> Result<Vec<(Event, Option<EventSignatureV1>)>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload
         FROM events
         WHERE run_id = ?1 AND kind = 'tape_checkpoint'
         ORDER BY id ASC",
    )?;
    let rows = statement.query_map(params![run_id.to_string()], |row| {
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
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
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
    lane: ModelActionIntentAuthorityLane,
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
    let evidence =
        verify_model_action_intent_issue_evidence(conn, issue, authority, lane, intended_at)?;
    if !model_action_intent_matches_issue_evidence(&intent, issue, &evidence, lane) {
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
    lane: ModelActionIntentAuthorityLane,
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
        lane,
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
    let evidence =
        verify_model_action_intent_issue_evidence(conn, issue, authority, lane, intended_at)?;
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
        ModelActionIntentAuthorityLane::Existing,
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
    lane: ModelActionIntentAuthorityLane,
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
        conn, stored, &issue, cas, authority, lane,
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
    lane: ModelActionIntentAuthorityLane,
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
        && lane.permits(
            evidence.action_request.execution_role,
            intent.candidate_binding.is_some(),
        )
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

/// Signed retry authority reconstructed entirely from the tape while the
/// candidate-completion writer owns its immediate transaction. The caller never
/// supplies this material: retry action identities derive only from this proof.
#[derive(Clone, Debug)]
struct VerifiedGovernedCandidateRetryContextV1 {
    retry_action_namespace: String,
    prior_action_ids: HashSet<String>,
    prior_action_idempotency_keys: HashSet<String>,
}

const RETRY_ACTION_NAMESPACE_DELIMITER: &str = ":";
const RETRY_CANDIDATE_ACTION_KIND: &str = "git-candidate-create";

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

fn governed_retry_candidate_identity_rejected<T>(reason: impl Into<String>) -> Result<T> {
    Err(LedgerError::ActivityClaimAuthorityRejected {
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
    Ok(())
}

fn retry_action_identity_uses_namespace(identity: &str, namespace: &str) -> bool {
    if namespace.trim().is_empty() {
        return false;
    }
    let prefix = format!("{namespace}{RETRY_ACTION_NAMESPACE_DELIMITER}");
    identity
        .strip_prefix(&prefix)
        .is_some_and(|suffix| !suffix.is_empty())
}

fn canonical_governed_candidate_retry_event(event: Event, label: &str) -> Result<Event> {
    canonicalize(event.clone()).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("candidate completion retry {label} event is not canonical: {error}"),
        }
    })?;
    Ok(event)
}

fn load_verified_governed_candidate_retry_event(
    conn: &Connection,
    event_id: EventId,
    authority: &GovernedPromotionAuthorityV1,
    label: &str,
) -> Result<Event> {
    load_verified_promotion_event(
        conn,
        event_id,
        &authority.trusted_keys,
        &authority.kernel_signer,
        label,
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!("candidate completion retry {label} proof is not verified: {error}"),
    })
}

/// Reconstruct the sealed-V3 predecessor chain for a retry dispatch. This is
/// deliberately local to the ledger writer: importing replay would invert the
/// crate dependency, while accepting a caller-provided context would make the
/// completion authority weaker than replay.
#[allow(clippy::too_many_lines)]
fn verify_governed_sealed_v3_retry_context(
    conn: &Connection,
    run_id: RunId,
    authority: &GovernedPromotionAuthorityV1,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
) -> Result<VerifiedGovernedCandidateRetryContextV1> {
    if dispatch.body.attempt <= 1
        || !matches!(dispatch_event.payload, Payload::DispatchEnvelopeV3(_))
    {
        return candidate_completion_authority_rejected(
            "candidate completion retries require an outer sealed-V3 dispatch envelope",
        );
    }
    canonical_governed_candidate_retry_event(dispatch_event.clone(), "dispatch")?;

    let contexts = verified_kernel_events_for_run_kind(
        conn,
        run_id,
        EventKind::AttemptContextRecordedV1,
        authority,
        "retry attempt context",
    )?
    .into_iter()
    .map(|context_event| {
        let context_event = canonical_governed_candidate_retry_event(context_event, "context")?;
        let Payload::AttemptContextRecordedV1(context) = &context_event.payload else {
            unreachable!("attempt-context kind only returns AttemptContextRecordedV1 payloads")
        };
        let context = context.clone();
        Ok((context_event, context))
    })
    .collect::<Result<Vec<_>>>()?;
    let mut context_idempotency_keys = HashMap::<String, EventId>::new();
    let mut next_dispatch_idempotency_keys = HashMap::<String, EventId>::new();
    let mut retry_action_namespaces = HashMap::<String, EventId>::new();
    let mut prior_attempt_owners = HashMap::<(String, String, u32), EventId>::new();
    for (context_event, context) in &contexts {
        if context_event.run_id != run_id || context.run_id != run_id.to_string() {
            return candidate_completion_authority_rejected(
                "candidate completion retry context belongs to a different run",
            );
        }
        if context_idempotency_keys
            .insert(context.idempotency_key.clone(), context_event.id)
            .is_some()
            || next_dispatch_idempotency_keys
                .insert(
                    context.next_dispatch_idempotency_key.clone(),
                    context_event.id,
                )
                .is_some()
            || retry_action_namespaces
                .insert(context.retry_action_namespace.clone(), context_event.id)
                .is_some()
            || prior_attempt_owners
                .insert(
                    (
                        context.workflow_id.clone(),
                        context.unit_id.clone(),
                        context.prior_attempt,
                    ),
                    context_event.id,
                )
                .is_some()
        {
            return candidate_completion_authority_rejected(
                "candidate completion retry contexts reuse a run-global retry idempotency, action namespace, or prior-attempt ownership",
            );
        }
    }

    let mut exact_context: Option<(Event, AttemptContextRecordedV1)> = None;
    let mut saw_same_retry_identity = false;
    for (context_event, context) in contexts {
        let same_retry_identity = context.run_id == run_id.to_string()
            && context.workflow_id == dispatch.body.workflow_id
            && context.workflow_revision == dispatch.body.workflow_revision
            && context.unit_id == dispatch.body.unit_id
            && context.next_attempt == dispatch.body.attempt;
        if !same_retry_identity {
            continue;
        }
        saw_same_retry_identity = true;
        if context.next_dispatch_envelope_digest != dispatch.envelope_digest
            || context.next_dispatch_idempotency_key != dispatch.body.idempotency_key
        {
            return candidate_completion_authority_rejected(
                "candidate completion retry context does not bind the exact next sealed-V3 dispatch envelope digest and idempotency key",
            );
        }
        if exact_context.replace((context_event, context)).is_some() {
            return candidate_completion_authority_rejected(
                "candidate completion retry dispatch has duplicate signed attempt contexts",
            );
        }
    }
    let Some((context_event, context)) = exact_context else {
        let reason = if saw_same_retry_identity {
            "candidate completion retry context did not bind the exact next dispatch"
        } else {
            "candidate completion sealed-V3 retry requires one signed recorded prior-attempt context"
        };
        return candidate_completion_authority_rejected(reason);
    };
    if context.attempt_context_digest
        != attempt_context_recorded_v1_digest(&context).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "candidate completion could not canonicalize retry context digest: {error}"
                ),
            }
        })?
        || context.prior_attempt.checked_add(1) != Some(context.next_attempt)
        || context_event.run_id != run_id
        || !tape_event_precedes(&context_event, dispatch_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context is not an exact, earlier signed retry decision",
        );
    }
    let context_recorded_at = parse_claim_timestamp(&context.recorded_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion retry context recorded_at is not canonical RFC3339 UTC"
                .into(),
        }
    })?;
    if context_recorded_at != context_event.occurred_at {
        return candidate_completion_authority_rejected(
            "candidate completion retry context recorded_at does not match its signed tape event time",
        );
    }

    let prior_dispatch_event = unique_verified_kernel_event_matching(
        conn,
        run_id,
        EventKind::DispatchEnvelopeV3,
        authority,
        "retry prior dispatch",
        |event| {
            matches!(
                &event.payload,
                Payload::DispatchEnvelopeV3(prior)
                    if prior.envelope_digest == context.prior_dispatch_envelope_digest
                        && prior.body.workflow_id == context.workflow_id
                        && prior.body.workflow_revision == context.workflow_revision
                        && prior.body.unit_id == context.unit_id
                        && prior.body.attempt == context.prior_attempt
            )
        },
    )?;
    let prior_dispatch_event =
        canonical_governed_candidate_retry_event(prior_dispatch_event, "prior dispatch")?;
    let Payload::DispatchEnvelopeV3(prior_dispatch) = &prior_dispatch_event.payload else {
        unreachable!("retry prior dispatch matcher returns only DispatchEnvelopeV3")
    };
    validate_static_governed_candidate_completion_dispatch(prior_dispatch, authority)?;
    let prior_dispatch_issued_at =
        parse_claim_timestamp(&prior_dispatch.body.issued_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior dispatch issued_at is not canonical RFC3339 UTC"
                    .into(),
        }
        })?;
    let prior_effective_deadline = validate_governed_dispatch(prior_dispatch, prior_dispatch_issued_at)
        .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not derive the retry prior dispatch authority deadline: {error}"
            ),
        })?
        .effective_deadline;
    if prior_dispatch_event.run_id != run_id
        || !tape_event_precedes(&prior_dispatch_event, &context_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior dispatch is not an earlier signed event in the exact run",
        );
    }

    let prior_terminal_event_id = parse_event_id(
        &context.prior_terminal_event_ref,
        "candidate completion retry prior terminal",
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!(
            "candidate completion retry context has an invalid prior terminal ref: {error}"
        ),
    })?;
    let prior_terminal_event = canonical_governed_candidate_retry_event(
        load_verified_governed_candidate_retry_event(
            conn,
            prior_terminal_event_id,
            authority,
            "prior terminal",
        )?,
        "prior terminal",
    )?;
    let prior_terminal_digest = canonical_event_hash(&prior_terminal_event).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not canonicalize retry prior terminal: {error}"
            ),
        }
    })?;
    let (
        terminal_workflow_id,
        terminal_workflow_revision,
        terminal_unit_id,
        terminal_attempt,
        terminal_outcome,
        terminal_completed_at,
    ) = match &prior_terminal_event.payload {
        Payload::WorkflowTerminalV1(terminal) => (
            terminal.workflow_id.as_str(),
            terminal.workflow_revision.as_str(),
            terminal.unit_id.as_str(),
            terminal.attempt,
            terminal.outcome,
            terminal.completed_at.as_str(),
        ),
        Payload::WorkflowTerminalV2(terminal) => (
            terminal.workflow_id.as_str(),
            terminal.workflow_revision.as_str(),
            terminal.unit_id.as_str(),
            terminal.attempt,
            terminal.outcome,
            terminal.completed_at.as_str(),
        ),
        _ => {
            return candidate_completion_authority_rejected(
                    "candidate completion retry context prior terminal is not a workflow terminal record",
                );
        }
    };
    let terminal_completed_at = parse_claim_timestamp(terminal_completed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: "candidate completion retry prior terminal completed_at is not canonical RFC3339 UTC".into(),
        }
    })?;
    if prior_terminal_event.run_id != run_id
        || prior_terminal_digest != context.prior_terminal_event_digest
        || terminal_workflow_id != prior_dispatch.body.workflow_id
        || terminal_workflow_revision != prior_dispatch.body.workflow_revision
        || terminal_unit_id != prior_dispatch.body.unit_id
        || terminal_attempt != prior_dispatch.body.attempt
        || terminal_outcome != WorkflowTerminalOutcomeV1::Failed
        || terminal_completed_at != prior_terminal_event.occurred_at
        || !tape_event_precedes(&prior_dispatch_event, &prior_terminal_event)
        || !tape_event_precedes(&prior_terminal_event, &context_event)
        || context_recorded_at < terminal_completed_at
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context does not bind the exact failed prior terminal evidence",
        );
    }

    let prior_receipt_event = unique_verified_kernel_event_matching(
        conn,
        run_id,
        EventKind::ActionReceiptRecordedV2,
        authority,
        "retry prior failed action receipt",
        |event| {
            matches!(
                &event.payload,
                Payload::ActionReceiptRecordedV2(receipt)
                    if receipt.action_receipt_ref == context.prior_action_receipt_ref
                        && action_receipt_recorded_v2_digest(receipt)
                            .is_ok_and(|digest| digest == context.prior_action_receipt_digest)
            )
        },
    )?;
    let prior_receipt_event =
        canonical_governed_candidate_retry_event(prior_receipt_event, "prior failed receipt")?;
    let Payload::ActionReceiptRecordedV2(prior_receipt) = &prior_receipt_event.payload else {
        unreachable!("retry prior receipt matcher returns only ActionReceiptRecordedV2")
    };
    let prior_receipt_digest =
        action_receipt_recorded_v2_digest(prior_receipt).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "candidate completion could not canonicalize retry prior receipt: {error}"
                ),
            }
        })?;
    if prior_receipt_digest != context.prior_action_receipt_digest
        || prior_receipt.run_id != run_id.to_string()
        || prior_receipt.workflow_id != prior_dispatch.body.workflow_id
        || prior_receipt.unit_id != prior_dispatch.body.unit_id
        || prior_receipt.attempt != prior_dispatch.body.attempt
        || prior_receipt.provenance_ref != prior_dispatch.body.provenance_ref
        || prior_receipt.dispatch_envelope_digest != prior_dispatch.envelope_digest
        || prior_receipt.authority_actor != authority.kernel_signer.actor_id
        || prior_receipt.execution_role != prior_dispatch.body.execution_role
        || prior_receipt.outcome != ActionReceiptOutcomeV2::Failed
        || !tape_event_precedes(&prior_dispatch_event, &prior_receipt_event)
        || !tape_event_precedes(&prior_receipt_event, &prior_terminal_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior receipt does not bind the failed prior dispatch",
        );
    }

    let prior_request_event = unique_verified_kernel_event_matching(
        conn,
        run_id,
        EventKind::ActionRequestedV2,
        authority,
        "retry prior action request",
        |event| {
            matches!(
                &event.payload,
                Payload::ActionRequestedV2(action)
                    if action.action_id == prior_receipt.action_id
                        && action.idempotency_key == prior_receipt.idempotency_key
                        && action_requested_v2_digest(action)
                            .is_ok_and(|digest| digest == prior_receipt.action_request_digest)
            )
        },
    )?;
    let prior_request_event =
        canonical_governed_candidate_retry_event(prior_request_event, "prior action request")?;
    let Payload::ActionRequestedV2(prior_request) = &prior_request_event.payload else {
        unreachable!("retry prior action request matcher returns only ActionRequestedV2")
    };
    let prior_request_digest = action_requested_v2_digest(prior_request).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not canonicalize retry prior request: {error}"
            ),
        }
    })?;
    let prior_requested_at = parse_claim_timestamp(&prior_request.requested_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior request requested_at is not canonical RFC3339 UTC"
                    .into(),
        }
    })?;
    let expected_prior_policy_digest =
        governed_dispatch_policy_digest_v1(&prior_dispatch.body.acceptance_contract_digest).map_err(
            |error| LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "candidate completion could not derive the retry prior dispatch policy binding: {error}"
                ),
            },
        )?;
    if prior_request_digest != prior_receipt.action_request_digest
        || prior_request.run_id != run_id.to_string()
        || prior_request.workflow_id != prior_dispatch.body.workflow_id
        || prior_request.unit_id != prior_dispatch.body.unit_id
        || prior_request.attempt != prior_dispatch.body.attempt
        || prior_request.provenance_ref != prior_dispatch.body.provenance_ref
        || prior_request.dispatch_envelope_digest != prior_dispatch.envelope_digest
        || prior_request.repository_binding_digest != prior_dispatch.repository_binding_digest
        || prior_request.ledger_authority_realm_digest
            != prior_dispatch.ledger_authority_realm_digest
        || prior_request.governed_packet_digest != prior_dispatch.governed_packet_digest
        || prior_request.capability_bundle_digest != prior_dispatch.body.capability_bundle_digest
        || prior_request.policy_digest != expected_prior_policy_digest
        || prior_request.context_manifest_digest != prior_dispatch.body.context_manifest_digest
        || prior_request.worker_manifest_digest != prior_dispatch.body.worker_manifest_digest
        || prior_request.sandbox_profile_digest != prior_dispatch.body.sandbox_profile_digest
        || prior_request.authority_actor != authority.kernel_signer.actor_id
        || prior_request.execution_role != prior_dispatch.body.execution_role
        || prior_requested_at != prior_request_event.occurred_at
        || prior_requested_at < prior_dispatch_issued_at
        || prior_request_event.parent_event_id != Some(prior_dispatch_event.id)
        || !tape_event_precedes(&prior_dispatch_event, &prior_request_event)
        || !tape_event_precedes(&prior_request_event, &prior_receipt_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior action request does not bind the failed prior dispatch",
        );
    }

    let prior_claim_event = unique_verified_kernel_event_matching(
        conn,
        run_id,
        EventKind::ActivityClaimedV1,
        authority,
        "retry prior action claim",
        |event| event.parent_event_id == Some(prior_request_event.id),
    )?;
    let prior_claim_event =
        canonical_governed_candidate_retry_event(prior_claim_event, "prior action claim")?;
    let Payload::ActivityClaimedV1(prior_claim) = &prior_claim_event.payload else {
        unreachable!("retry prior claim matcher returns only ActivityClaimedV1")
    };
    let prior_claim_digest = canonical_event_hash(&prior_claim_event).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not canonicalize retry prior claim: {error}"
            ),
        }
    })?;
    let prior_claimed_at = parse_claim_timestamp(&prior_claim.claimed_at).map_err(|_| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior claim claimed_at is not canonical RFC3339 UTC"
                    .into(),
        }
    })?;
    let prior_lease_expires_at =
        parse_claim_timestamp(&prior_claim.lease_expires_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior claim lease expiry is not canonical RFC3339 UTC"
                    .into(),
        }
        })?;
    if prior_claim.run_id != run_id
        || prior_claim.activity_id != prior_request.action_id
        || prior_claim.idempotency_key != prior_request.idempotency_key
        || prior_claim.action_kind != prior_request.action_kind
        || prior_claim.action_request_event_id != prior_request_event.id
        || prior_claim.action_request_digest != prior_request_digest
        || prior_claim.dispatch_event_id != prior_dispatch_event.id
        || prior_claim.dispatch_envelope_digest != prior_dispatch.envelope_digest
        || prior_claim.authority_actor != authority.kernel_signer.actor_id
        || prior_claim.purpose != ActivityClaimPurposeV1::Generic
        || prior_claimed_at != prior_claim_event.occurred_at
        || prior_claimed_at < prior_requested_at
        || prior_lease_expires_at <= prior_claimed_at
        || prior_lease_expires_at > prior_effective_deadline
        || prior_claim_event.parent_event_id != Some(prior_request_event.id)
        || !tape_event_precedes(&prior_request_event, &prior_claim_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior claim does not bind the failed action request",
        );
    }

    let prior_result_event = unique_verified_kernel_event_matching(
        conn,
        run_id,
        EventKind::ActivityResultRecordedV1,
        authority,
        "retry prior failed action result",
        |event| event.parent_event_id == Some(prior_claim_event.id),
    )?;
    let prior_result_event =
        canonical_governed_candidate_retry_event(prior_result_event, "prior failed action result")?;
    let Payload::ActivityResultRecordedV1(prior_result) = &prior_result_event.payload else {
        unreachable!("retry prior result matcher returns only ActivityResultRecordedV1")
    };
    let prior_result_recorded_at =
        parse_claim_timestamp(&prior_result.recorded_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior result recorded_at is not canonical RFC3339 UTC"
                    .into(),
        }
        })?;
    let prior_receipt_completed_at =
        parse_claim_timestamp(&prior_receipt.completed_at).map_err(|_| {
            LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion retry prior receipt completed_at is not canonical RFC3339 UTC"
                    .into(),
        }
        })?;
    if prior_result.run_id != run_id
        || prior_result.activity_id != prior_request.action_id
        || prior_result.idempotency_key != prior_request.idempotency_key
        || prior_result.claim_event_id != prior_claim_event.id
        || prior_result.claim_event_digest != prior_claim_digest
        || prior_result.lease_id != prior_claim.lease_id
        || prior_result.outcome != ActivityResultOutcomeV1::Failed
        || prior_result_recorded_at != prior_result_event.occurred_at
        || prior_result_recorded_at < prior_claimed_at
        || prior_result_recorded_at >= prior_lease_expires_at
        || prior_receipt_event.parent_event_id != Some(prior_result_event.id)
        || prior_receipt.result_digest != prior_result.result_digest
        || prior_receipt.result_ref != prior_result.result_ref
        || prior_receipt.evidence_digest != prior_result.evidence_digest
        || prior_receipt.evidence_ref != prior_result.evidence_ref
        || prior_receipt_completed_at < prior_claimed_at
        || prior_receipt_completed_at > prior_result_recorded_at
        || !tape_event_precedes(&prior_claim_event, &prior_result_event)
        || !tape_event_precedes(&prior_result_event, &prior_receipt_event)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior receipt does not bind a failed terminal action result",
        );
    }

    let mut prior_action_ids = HashSet::new();
    let mut prior_action_idempotency_keys = HashSet::new();
    for action_event in verified_kernel_events_for_run_kind(
        conn,
        run_id,
        EventKind::ActionRequestedV2,
        authority,
        "retry prior action identity",
    )? {
        let action_event =
            canonical_governed_candidate_retry_event(action_event, "prior action identity")?;
        let Payload::ActionRequestedV2(action) = &action_event.payload else {
            unreachable!("action-request kind only returns ActionRequestedV2 payloads")
        };
        let same_prior_attempt = action.run_id == run_id.to_string()
            && action.workflow_id == prior_dispatch.body.workflow_id
            && action.unit_id == prior_dispatch.body.unit_id
            && action.attempt == prior_dispatch.body.attempt;
        if !same_prior_attempt {
            continue;
        }
        if action.provenance_ref != prior_dispatch.body.provenance_ref
            || action.dispatch_envelope_digest != prior_dispatch.envelope_digest
            || action.repository_binding_digest != prior_dispatch.repository_binding_digest
            || action.ledger_authority_realm_digest != prior_dispatch.ledger_authority_realm_digest
            || action.governed_packet_digest != prior_dispatch.governed_packet_digest
            || action.capability_bundle_digest != prior_dispatch.body.capability_bundle_digest
            || action.policy_digest != expected_prior_policy_digest
            || action.context_manifest_digest != prior_dispatch.body.context_manifest_digest
            || action.worker_manifest_digest != prior_dispatch.body.worker_manifest_digest
            || action.sandbox_profile_digest != prior_dispatch.body.sandbox_profile_digest
            || action.authority_actor != authority.kernel_signer.actor_id
            || action.execution_role != prior_dispatch.body.execution_role
            || action_event.parent_event_id != Some(prior_dispatch_event.id)
        {
            return candidate_completion_authority_rejected(
                "candidate completion retry predecessor contains a substituted prior action identity",
            );
        }
        if !prior_action_ids.insert(action.action_id.clone())
            || !prior_action_idempotency_keys.insert(action.idempotency_key.clone())
        {
            return candidate_completion_authority_rejected(
                "candidate completion retry predecessor contains duplicate prior action identity or idempotency evidence",
            );
        }
    }
    if !prior_action_ids.contains(&prior_request.action_id)
        || !prior_action_idempotency_keys.contains(&prior_request.idempotency_key)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context prior action identity is absent from the signed predecessor dispatch",
        );
    }
    if context.next_dispatch_idempotency_key == prior_dispatch.body.idempotency_key
        || context.retry_action_namespace == prior_dispatch.body.idempotency_key
        || prior_action_idempotency_keys.contains(&context.next_dispatch_idempotency_key)
        || prior_action_idempotency_keys.contains(&context.retry_action_namespace)
    {
        return candidate_completion_authority_rejected(
            "candidate completion retry context reuses a prior dispatch or action idempotency namespace",
        );
    }

    Ok(VerifiedGovernedCandidateRetryContextV1 {
        retry_action_namespace: context.retry_action_namespace,
        prior_action_ids,
        prior_action_idempotency_keys,
    })
}

/// Reconstruct the only graph-bound V4 admission shape the candidate-completion
/// lane can prove without depending on the replay crate (which already depends
/// on this ledger crate). A singleton, first-attempt graph has no dependency or
/// concurrency state to approximate: its signed V2 declaration is the sole
/// ordinary tape record before the V4 dispatch. Wider graphs and retries stay
/// fail-closed until the shared reducer can be used at this authority boundary.
fn verify_singleton_graph_bound_v4_candidate_completion_admission(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV4,
) -> Result<EventId> {
    canonicalize(dispatch_event.clone()).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion graph-bound V4 dispatch is not canonical: {error}"
            ),
        }
    })?;
    if dispatch_event.run_id != request.run_id || dispatch.dispatch_v3.body.attempt != 1 {
        return candidate_completion_authority_rejected(
            "candidate completion singleton graph-bound V4 admission requires the exact first dispatch attempt in its run",
        );
    }
    let expected_outer_digest = dispatch_envelope_v4_digest(
        &dispatch.dispatch_v3,
        &dispatch.workflow_graph_digest,
        &dispatch.workflow_graph_declaration_event_ref,
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!(
            "candidate completion could not canonicalize graph-bound V4 dispatch digest: {error}"
        ),
    })?;
    if dispatch.envelope_digest != expected_outer_digest {
        return candidate_completion_authority_rejected(
            "candidate completion graph-bound V4 dispatch outer envelope digest is not canonical",
        );
    }

    let graph_event = load_verified_promotion_event(
        conn,
        dispatch.workflow_graph_declaration_event_ref,
        &authority.trusted_keys,
        &authority.kernel_signer,
        "candidate completion graph declaration",
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!(
            "candidate completion could not verify its graph-bound V2 declaration: {error}"
        ),
    })?;
    canonicalize(graph_event.clone()).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!("candidate completion graph declaration is not canonical: {error}"),
        }
    })?;
    if graph_event.run_id != request.run_id || !tape_event_precedes(&graph_event, dispatch_event) {
        return candidate_completion_authority_rejected(
            "candidate completion graph declaration must be a signed earlier event in the exact dispatch run",
        );
    }
    let Payload::WorkflowGraphDeclaredV2(graph) = &graph_event.payload else {
        return candidate_completion_authority_rejected(
            "candidate completion graph-bound V4 dispatch must reference a workflow_graph_declared_v2 event",
        );
    };
    let expected_graph_digest = workflow_graph_v2_digest(graph).map_err(|error| {
        LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not canonicalize graph-bound V2 declaration: {error}"
            ),
        }
    })?;
    let body = &dispatch.dispatch_v3.body;
    if graph.run_id != request.run_id.to_string()
        || graph.workflow_id != body.workflow_id
        || graph.workflow_revision != body.workflow_revision
        || graph.graph_digest != expected_graph_digest
        || graph.graph_digest != dispatch.workflow_graph_digest
    {
        return candidate_completion_authority_rejected(
            "candidate completion graph-bound V4 dispatch does not exactly bind its signed V2 graph identity and digest",
        );
    }
    let [node] = graph.nodes.as_slice() else {
        return candidate_completion_authority_rejected(
            "candidate completion currently supports only singleton graph-bound V4 declarations",
        );
    };
    if graph.max_concurrent != 1 || !node.depends_on.is_empty() {
        return candidate_completion_authority_rejected(
            "candidate completion currently supports only dependency-free graph-bound V4 declarations with max_concurrent 1",
        );
    }
    if node.unit_id != body.unit_id
        || node.execution_role != body.execution_role
        || dispatch.dispatch_v3.governed_packet_digest.as_deref()
            != Some(node.governed_packet_digest.as_str())
    {
        return candidate_completion_authority_rejected(
            "candidate completion graph-bound V4 dispatch does not exactly match its singleton V2 graph node",
        );
    }

    // This strict prefix check deliberately mirrors the singleton boundary:
    // before the V4 dispatch replay may have observed only its exact graph
    // declaration. It rejects prior raw activity brackets, another dispatch,
    // a second graph, and any other ordinary state that would require the full
    // replay reducer to interpret. A verified checkpoint is tape-integrity
    // metadata rather than a workflow transition, so it is allowed here and
    // its complete chain is re-verified by the evidence closure below. The
    // target's later action/candidate records are verified separately below.
    let mut statement =
        conn.prepare("SELECT id FROM events WHERE run_id = ?1 AND id < ?2 ORDER BY id ASC")?;
    let prefix_ids = statement
        .query_map(
            params![request.run_id.to_string(), dispatch_event.id.to_string()],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut saw_exact_graph = false;
    for id in prefix_ids {
        let event_id = parse_event_id(&id, "candidate completion singleton graph prefix")?;
        let event = load_verified_promotion_event(
            conn,
            event_id,
            &authority.trusted_keys,
            &authority.kernel_signer,
            "candidate completion singleton graph prefix",
        )
        .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
            reason: format!(
                "candidate completion could not verify its singleton graph prefix: {error}"
            ),
        })?;
        canonicalize(event.clone()).map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "candidate completion singleton graph prefix contains a non-canonical event: {error}"
                ),
            }
        })?;
        if event.kind == EventKind::TapeCheckpoint {
            continue;
        }
        if event.id == graph_event.id {
            saw_exact_graph = true;
            continue;
        }
        return candidate_completion_authority_rejected(
            "candidate completion singleton graph-bound V4 admission rejects prior run activity or competing dispatch state",
        );
    }
    if !saw_exact_graph {
        return candidate_completion_authority_rejected(
            "candidate completion graph-bound V4 dispatch graph declaration is absent from its tape prefix",
        );
    }
    Ok(graph_event.id)
}

fn canonical_buildplane_candidate_ref_suffix(candidate_ref: &str) -> Option<&str> {
    is_canonical_buildplane_candidate_ref(candidate_ref)
        .then(|| candidate_ref.strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX))
        .flatten()
}

fn candidate_ref_suffix_segments(suffix: &str) -> Option<(&str, &str, &str)> {
    let mut segments = suffix.split('/');
    let (Some(candidate_id), Some(candidate_run_id), Some(candidate_attempt), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return None;
    };
    (!candidate_id.is_empty()).then_some((candidate_id, candidate_run_id, candidate_attempt))
}

/// A retry dispatch has no immutable candidate ID/ref, so pre-effect resolver
/// and claim validation can bind only the canonical run and attempt segments.
fn candidate_ref_suffix_binds_run_and_attempt(suffix: &str, run_id: RunId, attempt: u32) -> bool {
    let Some((_, candidate_run_id, candidate_attempt)) = candidate_ref_suffix_segments(suffix)
    else {
        return false;
    };
    candidate_run_id == run_id.to_string() && candidate_attempt == attempt.to_string()
}

/// Once `CandidateCreatedV2` is signed, its candidate ID is immutable evidence
/// and must bind the first candidate-ref segment in addition to run/attempt.
fn candidate_ref_suffix_binds_candidate_id_run_and_attempt(
    suffix: &str,
    candidate_id: &str,
    run_id: RunId,
    attempt: u32,
) -> bool {
    let Some((candidate_ref_id, candidate_run_id, candidate_attempt)) =
        candidate_ref_suffix_segments(suffix)
    else {
        return false;
    };
    candidate_ref_id == candidate_id
        && candidate_run_id == run_id.to_string()
        && candidate_attempt == attempt.to_string()
}

/// Format candidate-create identities from a previously validated canonical
/// ref suffix. Candidate completion and the pre-effect retry resolver share
/// this exact formatter so no caller can create a second retry namespace
/// convention at the storage boundary.
fn candidate_create_action_identity_for_suffix(
    suffix: &str,
    retry_action_namespace: Option<&str>,
) -> (String, Option<String>) {
    let legacy_action_id = format!("{RETRY_CANDIDATE_ACTION_KIND}:{suffix}");
    let Some(retry_action_namespace) = retry_action_namespace else {
        return (legacy_action_id, None);
    };
    let action_id = format!("{retry_action_namespace}:{RETRY_CANDIDATE_ACTION_KIND}:{suffix}");
    let idempotency_key = format!("{action_id}:idempotency");
    (action_id, Some(idempotency_key))
}

fn candidate_create_action_identity_for(
    candidate: &CandidateCreatedV2,
    retry_context: Option<&VerifiedGovernedCandidateRetryContextV1>,
    expected_run_id: RunId,
    expected_attempt: u32,
) -> Result<(String, Option<String>)> {
    if candidate.candidate_id.trim().is_empty() {
        return candidate_completion_authority_rejected(
            "candidate completion requires a non-empty candidate id and canonical Buildplane candidate ref",
        );
    }
    let suffix =
        canonical_buildplane_candidate_ref_suffix(&candidate.candidate_ref).ok_or_else(|| {
            LedgerError::CandidateCompletionAuthorityRejected {
            reason:
                "candidate completion candidate ref is outside the Buildplane candidate namespace"
                    .into(),
        }
        })?;
    if !candidate_ref_suffix_binds_candidate_id_run_and_attempt(
        suffix,
        &candidate.candidate_id,
        expected_run_id,
        expected_attempt,
    ) {
        return candidate_completion_authority_rejected(
            "candidate completion candidate ref must bind the signed candidate id, run, and attempt",
        );
    }
    Ok(candidate_create_action_identity_for_suffix(
        suffix,
        retry_context.map(|context| context.retry_action_namespace.as_str()),
    ))
}

/// Tape order is the canonical UUIDv7 event-id order used by the ledger's
/// event queries. A candidate-completion proof may only close evidence that
/// was already durably present in that order; payload timestamps alone are
/// not an ordering authority.
fn tape_event_precedes(before: &Event, after: &Event) -> bool {
    before.id.as_uuid() < after.id.as_uuid()
}

/// The effective terminal lease plus the exact heartbeat records that formed
/// it. Singleton V4 closure validation must retain those identities so a
/// second, unrelated heartbeat cannot hide outside the candidate evidence.
struct EffectiveGovernedCandidateActivityLeaseV1 {
    expires_at: DateTime<Utc>,
    heartbeat_event_ids: HashSet<EventId>,
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
) -> Result<EffectiveGovernedCandidateActivityLeaseV1> {
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
    let mut heartbeat_event_ids = HashSet::new();
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
        heartbeat_event_ids.insert(heartbeat_event.id);
    }
    Ok(EffectiveGovernedCandidateActivityLeaseV1 {
        expires_at: current_lease_expires_at,
        heartbeat_event_ids,
    })
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
    dispatch_envelope_digest: &str,
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
                    && cancellation.dispatch_envelope_digest == dispatch_envelope_digest =>
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
                    && prior_set.dispatch_envelope_digest == dispatch_envelope_digest =>
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
    candidate_create_action_idempotency_key: Option<&str>,
    retry_context: Option<&VerifiedGovernedCandidateRetryContextV1>,
) -> Result<HashSet<EventId>> {
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
        if let Some(retry_context) = retry_context {
            if !retry_action_identity_uses_namespace(
                &action.action_id,
                &retry_context.retry_action_namespace,
            ) || !retry_action_identity_uses_namespace(
                &action.idempotency_key,
                &retry_context.retry_action_namespace,
            ) {
                return candidate_completion_authority_rejected(
                    "candidate completion sealed-V3 retry action_id and idempotency_key must each use the signed retry action namespace",
                );
            }
            if retry_context.prior_action_ids.contains(&action.action_id)
                || retry_context
                    .prior_action_idempotency_keys
                    .contains(&action.idempotency_key)
            {
                return candidate_completion_authority_rejected(
                    "candidate completion sealed-V3 retry cannot reuse a prior-attempt action_id or idempotency_key",
                );
            }
        }
        if action.action_id == candidate_create_action_id
            && candidate_create_action_idempotency_key
                .is_some_and(|expected| action.idempotency_key != expected)
        {
            return candidate_completion_authority_rejected(
                "candidate completion sealed-V3 retry candidate action idempotency_key does not match its signed retry namespace and candidate ref",
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

    let mut allowed_event_ids = HashSet::new();
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
        allowed_event_ids.insert(action_event.id);
        allowed_event_ids.insert(claim_event.id);

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
        let effective_lease = effective_governed_candidate_activity_lease_expiry(
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
        allowed_event_ids.extend(effective_lease.heartbeat_event_ids.iter().cloned());
        if result.run_id != request.run_id
            || result.activity_id != *action_id
            || result.idempotency_key != action.idempotency_key
            || result.claim_event_id != claim_event.id
            || result.claim_event_digest != claim_digest
            || result.lease_id != claim.lease_id
            || result.outcome != ActivityResultOutcomeV1::Succeeded
            || result_recorded_at != result_event.occurred_at
            || result_recorded_at < claimed_at
            || result_recorded_at >= effective_lease.expires_at
            || !tape_event_precedes(claim_event, result_event)
        {
            return candidate_completion_authority_rejected(
                "candidate completion receipt set action result is not one successful terminal claim result",
            );
        }
        allowed_event_ids.insert(result_event.id);

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
        allowed_event_ids.insert(receipt_event.id);
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
    Ok(allowed_event_ids)
}

/// The singleton V4 lane is intentionally narrower than the general replay
/// reducer. Once it has admitted exactly one graph declaration and one V4
/// dispatch, every ordinary tape event must be part of the re-derived action
/// chain through the immutable candidate. Rejecting rather than approximating
/// a tail prevents this authority writer from sealing a tape that trusted
/// replay would later reject for an unsigned legacy activity, a second
/// dispatch, a graph change, or any other unmodeled transition.
fn verify_singleton_graph_bound_v4_candidate_completion_closure(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    kernel_signing_key: &SigningKey,
    kernel_signer: &ActorKeyRef,
    allowed_event_ids: &HashSet<EventId>,
) -> Result<()> {
    let covered = signed_ordinary_events_for_connection(conn, &request.run_id)?;
    let prefix_roots = tape_prefix_roots(&covered);
    SqliteStore::verify_governed_checkpoint_chain_for_seal(
        conn,
        &request.run_id,
        &covered,
        &prefix_roots,
        kernel_signing_key,
        kernel_signer,
    )
    .map_err(|error| LedgerError::CandidateCompletionAuthorityRejected {
        reason: format!(
            "candidate completion singleton graph-bound V4 checkpoint chain is not recoverable: {error}"
        ),
    })?;

    for row in events_for_run_for_connection(conn, &request.run_id.to_string())? {
        let event = row.to_event().map_err(|error| {
            LedgerError::CandidateCompletionAuthorityRejected {
                reason: format!(
                    "candidate completion singleton graph-bound V4 tape contains an unreadable event: {error}"
                ),
            }
        })?;
        if event.kind == EventKind::TapeCheckpoint {
            continue;
        }
        if !allowed_event_ids.contains(&event.id) {
            return candidate_completion_authority_rejected(format!(
                "candidate completion singleton graph-bound V4 tape contains an unmodeled ordinary event {} ({})",
                event.id,
                event.kind.as_wire(),
            ));
        }
    }
    Ok(())
}

fn verify_governed_candidate_completion_evidence(
    conn: &Connection,
    request: &GovernedCandidateCompletionRequestV1,
    authority: &GovernedPromotionAuthorityV1,
    kernel_signing_key: &SigningKey,
    kernel_signer: &ActorKeyRef,
    existing_completion_event_id: Option<EventId>,
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
    let singleton_graph_event_id =
        if let Payload::DispatchEnvelopeV4(graph_bound_dispatch) = &dispatch_event.payload {
            Some(
                verify_singleton_graph_bound_v4_candidate_completion_admission(
                    conn,
                    request,
                    authority,
                    &dispatch_event,
                    graph_bound_dispatch,
                )?,
            )
        } else {
            None
        };
    let dispatch = dispatch_material.dispatch;
    let dispatch_envelope_digest = dispatch_material.lineage_envelope_digest;
    validate_static_governed_candidate_completion_dispatch(&dispatch, authority)?;
    let retry_context = if dispatch.body.attempt > 1 {
        match &dispatch_event.payload {
            Payload::DispatchEnvelopeV3(_) => Some(verify_governed_sealed_v3_retry_context(
                conn,
                request.run_id,
                authority,
                &dispatch_event,
                &dispatch,
            )?),
            Payload::DispatchEnvelopeV4(_) => {
                return candidate_completion_authority_rejected(
                    "candidate completion retry support is limited to outer sealed-V3 dispatch envelopes; graph-bound V4 retries remain rejected",
                );
            }
            Payload::DispatchEnvelopeV5(_) => {
                return candidate_completion_authority_rejected(
                    "candidate completion retry support is limited to outer sealed-V3 dispatch envelopes; manifest-bound V5 retries remain rejected",
                );
            }
            _ => unreachable!("dispatch authority material returns only V3 or V4 dispatches"),
        }
    } else {
        None
    };
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
    let (candidate_create_action_id, candidate_create_action_idempotency_key) =
        candidate_create_action_identity_for(
            &candidate,
            retry_context.as_ref(),
            request.run_id,
            dispatch.body.attempt,
        )?;

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
        &dispatch_envelope_digest,
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
    let action_evidence_event_ids = verify_governed_candidate_receipt_set_completeness(
        conn,
        request,
        authority,
        &dispatch_event,
        &dispatch,
        &dispatch_envelope_digest,
        &receipt_set_event,
        receipt_set,
        &candidate_create_action_id,
        candidate_create_action_idempotency_key.as_deref(),
        retry_context.as_ref(),
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
    let effective_lease = effective_governed_candidate_activity_lease_expiry(
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
        || result_recorded_at >= effective_lease.expires_at
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
    if let Some(graph_event_id) = singleton_graph_event_id {
        let mut allowed_event_ids = action_evidence_event_ids;
        allowed_event_ids.insert(graph_event_id);
        allowed_event_ids.insert(dispatch_event.id);
        allowed_event_ids.insert(receipt_set_event.id);
        allowed_event_ids.insert(candidate_event.id);
        if let Some(completion_event_id) = existing_completion_event_id {
            allowed_event_ids.insert(completion_event_id);
        }
        verify_singleton_graph_bound_v4_candidate_completion_closure(
            conn,
            request,
            kernel_signing_key,
            kernel_signer,
            &allowed_event_ids,
        )?;
    }
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
    kernel_signing_key: &SigningKey,
    kernel_signer: &ActorKeyRef,
) -> Result<GovernedCandidateCompletionDispositionV1> {
    let completion_event_id = parse_event_id(
        &stored.candidate_completion_event_id,
        "governed_candidate_completions",
    )?;
    let evidence = verify_governed_candidate_completion_evidence(
        conn,
        request,
        authority,
        kernel_signing_key,
        kernel_signer,
        Some(completion_event_id),
    )?;
    if !stored_governed_candidate_completion_matches(stored, request, &evidence.completion) {
        return Err(candidate_completion_reconciliation_required(
            request,
            "candidate-completion projection does not exactly match the re-derived immutable lineage",
        ));
    }
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
