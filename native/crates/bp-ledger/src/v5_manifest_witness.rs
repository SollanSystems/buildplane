//! Pure cross-event V5 manifest-declaration binding validation.
//!
//! This module deliberately validates only whether already-resolved V5
//! declaration payloads bind one [`DispatchEnvelopeV5`] exactly. Callers must
//! validate canonical payload shapes and detached digests, signatures and
//! signer purpose, and tape ordering before invoking this API. A successful
//! [`V5ManifestDeclarationBinding`] is therefore binding evidence, not an
//! authorization decision or an attestation of tape order.

use crate::id::EventId;
use crate::payload::trust_spine::{
    AttemptContextDeclaredV1, ContextManifestDeclaredV1, DispatchEnvelopeV5, ExecutionRoleV1,
    SandboxProfileDeclaredV1, WorkerManifestDeclaredV1,
};
use std::fmt;

/// The immutable identity fields a V5 declaration must share with its
/// dispatch. This is a borrowed view, not a signer or tape-order attestation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V5ManifestDeclarationIdentity<'a> {
    pub run_id: &'a str,
    pub workflow_id: &'a str,
    pub workflow_revision: &'a str,
    pub unit_id: &'a str,
    pub attempt: u32,
    pub provenance_ref: &'a str,
}

/// Borrowed context-manifest declaration witness fields.
///
/// [`Self::from_declaration`] is the direct constructor for a raw ledger
/// payload. Replay and protected-host callers that already hold a validated
/// projection may construct this view from references to the same immutable
/// fields, without rebuilding a declaration payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V5ContextManifestDeclarationWitness<'a> {
    pub event_id: &'a EventId,
    pub identity: V5ManifestDeclarationIdentity<'a>,
    pub digest: &'a str,
}

impl<'a> V5ContextManifestDeclarationWitness<'a> {
    /// Construct a witness view directly from a raw declaration payload.
    pub fn from_declaration(
        event_id: &'a EventId,
        declaration: &'a ContextManifestDeclaredV1,
    ) -> Self {
        Self {
            event_id,
            identity: V5ManifestDeclarationIdentity {
                run_id: &declaration.run_id,
                workflow_id: &declaration.workflow_id,
                workflow_revision: &declaration.workflow_revision,
                unit_id: &declaration.unit_id,
                attempt: declaration.attempt,
                provenance_ref: &declaration.provenance_ref,
            },
            digest: &declaration.context_manifest_digest,
        }
    }
}

/// Borrowed worker-manifest declaration witness fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V5WorkerManifestDeclarationWitness<'a> {
    pub event_id: &'a EventId,
    pub identity: V5ManifestDeclarationIdentity<'a>,
    pub digest: &'a str,
    pub execution_role: ExecutionRoleV1,
    pub capability_bundle_digest: &'a str,
    pub image_digest: &'a str,
}

impl<'a> V5WorkerManifestDeclarationWitness<'a> {
    /// Construct a witness view directly from a raw declaration payload.
    pub fn from_declaration(
        event_id: &'a EventId,
        declaration: &'a WorkerManifestDeclaredV1,
    ) -> Self {
        Self {
            event_id,
            identity: V5ManifestDeclarationIdentity {
                run_id: &declaration.run_id,
                workflow_id: &declaration.workflow_id,
                workflow_revision: &declaration.workflow_revision,
                unit_id: &declaration.unit_id,
                attempt: declaration.attempt,
                provenance_ref: &declaration.provenance_ref,
            },
            digest: &declaration.worker_manifest_digest,
            execution_role: declaration.worker_manifest.execution_role,
            capability_bundle_digest: &declaration.worker_manifest.capability_bundle_digest,
            image_digest: &declaration.worker_manifest.image_digest,
        }
    }
}

/// Borrowed sandbox-profile declaration witness fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V5SandboxProfileDeclarationWitness<'a> {
    pub event_id: &'a EventId,
    pub identity: V5ManifestDeclarationIdentity<'a>,
    pub digest: &'a str,
    pub image_digest: &'a str,
}

impl<'a> V5SandboxProfileDeclarationWitness<'a> {
    /// Construct a witness view directly from a raw declaration payload.
    pub fn from_declaration(
        event_id: &'a EventId,
        declaration: &'a SandboxProfileDeclaredV1,
    ) -> Self {
        Self {
            event_id,
            identity: V5ManifestDeclarationIdentity {
                run_id: &declaration.run_id,
                workflow_id: &declaration.workflow_id,
                workflow_revision: &declaration.workflow_revision,
                unit_id: &declaration.unit_id,
                attempt: declaration.attempt,
                provenance_ref: &declaration.provenance_ref,
            },
            digest: &declaration.sandbox_profile_digest,
            image_digest: &declaration.sandbox_profile.image_digest,
        }
    }
}

/// Borrowed retry attempt-context declaration witness fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V5AttemptContextDeclarationWitness<'a> {
    pub event_id: &'a EventId,
    pub identity: V5ManifestDeclarationIdentity<'a>,
    pub digest: &'a str,
    pub attempt_context_attempt: u32,
}

impl<'a> V5AttemptContextDeclarationWitness<'a> {
    /// Construct a witness view directly from a raw declaration payload.
    pub fn from_declaration(
        event_id: &'a EventId,
        declaration: &'a AttemptContextDeclaredV1,
    ) -> Self {
        Self {
            event_id,
            identity: V5ManifestDeclarationIdentity {
                run_id: &declaration.run_id,
                workflow_id: &declaration.workflow_id,
                workflow_revision: &declaration.workflow_revision,
                unit_id: &declaration.unit_id,
                attempt: declaration.attempt,
                provenance_ref: &declaration.provenance_ref,
            },
            digest: &declaration.attempt_context_digest,
            attempt_context_attempt: declaration.attempt_context.attempt,
        }
    }
}

/// The declaration witnesses a V5 dispatch is expected to bind.
///
/// The first three witnesses are optional only so a caller that has already
/// resolved a projection can report an absent declaration through the same
/// pure validation result. A valid V5 dispatch always requires all three.
/// The retry witness is absent only for attempt one.
#[derive(Debug)]
pub struct V5ManifestDeclarationWitnesses<'a> {
    pub context_manifest: Option<V5ContextManifestDeclarationWitness<'a>>,
    pub worker_manifest: Option<V5WorkerManifestDeclarationWitness<'a>>,
    pub sandbox_profile: Option<V5SandboxProfileDeclarationWitness<'a>>,
    pub attempt_context: Option<V5AttemptContextDeclarationWitness<'a>>,
}

/// One exact declaration reference and detached digest validated against V5.
///
/// This value intentionally does not carry signer, signature, or tape-order
/// information; those are caller-owned checks outside this pure validator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V5ManifestDeclarationBindingWitness {
    pub event_id: EventId,
    pub digest: String,
}

/// Structured evidence returned after a V5 dispatch binds its declaration
/// witnesses exactly.
///
/// This is not sufficient to authorize a dispatch. In particular, it makes no
/// statement about canonical payload validation, signatures/signer purpose,
/// or whether the witnessed events precede the dispatch on a tape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V5ManifestDeclarationBinding {
    pub context_manifest: V5ManifestDeclarationBindingWitness,
    pub worker_manifest: V5ManifestDeclarationBindingWitness,
    pub sandbox_profile: V5ManifestDeclarationBindingWitness,
    pub attempt_context: Option<V5ManifestDeclarationBindingWitness>,
}

/// A failed pure V5 declaration-binding check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum V5ManifestDeclarationWitnessError {
    MissingContextManifest,
    ContextManifestBindingMismatch,
    MissingWorkerManifest,
    WorkerManifestBindingMismatch,
    WorkerManifestAuthorityMismatch,
    MissingSandboxProfile,
    SandboxProfileBindingMismatch,
    SandboxProfileImageMismatch,
    FirstAttemptHasRetryDeclaration,
    RetryDeclarationPairRequired,
    MissingAttemptContext,
    AttemptContextBindingMismatch,
}

impl fmt::Display for V5ManifestDeclarationWitnessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::MissingContextManifest => {
                "manifest-bound V5 dispatch requires a context manifest declaration witness"
            }
            Self::ContextManifestBindingMismatch => {
                "manifest-bound V5 dispatch context manifest declaration does not bind the exact run/workflow/revision/unit/attempt/provenance digest"
            }
            Self::MissingWorkerManifest => {
                "manifest-bound V5 dispatch requires a worker manifest declaration witness"
            }
            Self::WorkerManifestBindingMismatch => {
                "manifest-bound V5 dispatch worker manifest declaration does not bind the exact run/workflow/revision/unit/attempt/provenance digest"
            }
            Self::WorkerManifestAuthorityMismatch => {
                "manifest-bound V5 dispatch worker manifest execution role or capability bundle does not match its V4 authority"
            }
            Self::MissingSandboxProfile => {
                "manifest-bound V5 dispatch requires a sandbox profile declaration witness"
            }
            Self::SandboxProfileBindingMismatch => {
                "manifest-bound V5 dispatch sandbox profile declaration does not bind the exact run/workflow/revision/unit/attempt/provenance digest"
            }
            Self::SandboxProfileImageMismatch => {
                "manifest-bound V5 dispatch sandbox profile image does not match its worker manifest image"
            }
            Self::FirstAttemptHasRetryDeclaration => {
                "manifest-bound V5 first attempt must not bind an attempt context declaration"
            }
            Self::RetryDeclarationPairRequired => {
                "manifest-bound V5 retry dispatch requires paired attempt context declaration reference and digest"
            }
            Self::MissingAttemptContext => {
                "manifest-bound V5 retry dispatch requires an attempt context declaration witness"
            }
            Self::AttemptContextBindingMismatch => {
                "manifest-bound V5 retry declaration does not bind the exact run/workflow/revision/unit/attempt/provenance digest"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for V5ManifestDeclarationWitnessError {}

fn identity_matches(
    expected: &V5ManifestDeclarationIdentity<'_>,
    actual: &V5ManifestDeclarationIdentity<'_>,
) -> bool {
    expected == actual
}

fn binding_witness(event_id: &EventId, digest: &str) -> V5ManifestDeclarationBindingWitness {
    V5ManifestDeclarationBindingWitness {
        event_id: *event_id,
        digest: digest.to_owned(),
    }
}

/// Validate pure cross-event V5 declaration bindings.
///
/// `dispatch_run_id` is the run identity of the V5 dispatch event. This
/// function does not accept V4 or V3 dispatches and never downcasts V5
/// authority. It does not canonicalize payloads, attest signatures or signer
/// purpose, or establish tape ordering; callers must complete those checks
/// before treating a successful result as part of admission or recovery.
pub fn validate_v5_manifest_declaration_witnesses(
    dispatch: &DispatchEnvelopeV5,
    dispatch_run_id: &str,
    witnesses: V5ManifestDeclarationWitnesses<'_>,
) -> Result<V5ManifestDeclarationBinding, V5ManifestDeclarationWitnessError> {
    let body = &dispatch.dispatch_v4.dispatch_v3.body;
    let expected_identity = V5ManifestDeclarationIdentity {
        run_id: dispatch_run_id,
        workflow_id: &body.workflow_id,
        workflow_revision: &body.workflow_revision,
        unit_id: &body.unit_id,
        attempt: body.attempt,
        provenance_ref: &body.provenance_ref,
    };

    let context_manifest = witnesses
        .context_manifest
        .ok_or(V5ManifestDeclarationWitnessError::MissingContextManifest)?;
    if context_manifest.event_id != &dispatch.context_manifest_declaration_event_ref
        || context_manifest.digest != dispatch.context_manifest_digest
        || dispatch.context_manifest_digest != body.context_manifest_digest
        || !identity_matches(&expected_identity, &context_manifest.identity)
    {
        return Err(V5ManifestDeclarationWitnessError::ContextManifestBindingMismatch);
    }

    let worker_manifest = witnesses
        .worker_manifest
        .ok_or(V5ManifestDeclarationWitnessError::MissingWorkerManifest)?;
    if worker_manifest.event_id != &dispatch.worker_manifest_declaration_event_ref
        || worker_manifest.digest != dispatch.worker_manifest_digest
        || dispatch.worker_manifest_digest != body.worker_manifest_digest
        || !identity_matches(&expected_identity, &worker_manifest.identity)
    {
        return Err(V5ManifestDeclarationWitnessError::WorkerManifestBindingMismatch);
    }
    if worker_manifest.execution_role != body.execution_role
        || worker_manifest.capability_bundle_digest != body.capability_bundle_digest
    {
        return Err(V5ManifestDeclarationWitnessError::WorkerManifestAuthorityMismatch);
    }

    let sandbox_profile = witnesses
        .sandbox_profile
        .ok_or(V5ManifestDeclarationWitnessError::MissingSandboxProfile)?;
    if sandbox_profile.event_id != &dispatch.sandbox_profile_declaration_event_ref
        || sandbox_profile.digest != dispatch.sandbox_profile_digest
        || dispatch.sandbox_profile_digest != body.sandbox_profile_digest
        || !identity_matches(&expected_identity, &sandbox_profile.identity)
    {
        return Err(V5ManifestDeclarationWitnessError::SandboxProfileBindingMismatch);
    }
    if sandbox_profile.image_digest != worker_manifest.image_digest {
        return Err(V5ManifestDeclarationWitnessError::SandboxProfileImageMismatch);
    }

    let attempt_context = match (
        body.attempt,
        dispatch.attempt_context_declaration_event_ref.as_ref(),
        dispatch.attempt_context_digest.as_deref(),
        witnesses.attempt_context,
    ) {
        (1, None, None, None) => None,
        (1, _, _, _) => {
            return Err(V5ManifestDeclarationWitnessError::FirstAttemptHasRetryDeclaration);
        }
        (_, Some(event_ref), Some(digest), Some(declaration)) => {
            if declaration.event_id != event_ref
                || declaration.digest != digest
                || declaration.attempt_context_attempt != body.attempt
                || !identity_matches(&expected_identity, &declaration.identity)
            {
                return Err(V5ManifestDeclarationWitnessError::AttemptContextBindingMismatch);
            }
            Some(binding_witness(declaration.event_id, declaration.digest))
        }
        (_, Some(_), Some(_), None) => {
            return Err(V5ManifestDeclarationWitnessError::MissingAttemptContext);
        }
        _ => {
            return Err(V5ManifestDeclarationWitnessError::RetryDeclarationPairRequired);
        }
    };

    Ok(V5ManifestDeclarationBinding {
        context_manifest: binding_witness(context_manifest.event_id, context_manifest.digest),
        worker_manifest: binding_witness(worker_manifest.event_id, worker_manifest.digest),
        sandbox_profile: binding_witness(sandbox_profile.event_id, sandbox_profile.digest),
        attempt_context,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        validate_v5_manifest_declaration_witnesses, V5AttemptContextDeclarationWitness,
        V5ContextManifestDeclarationWitness, V5ManifestDeclarationWitnessError,
        V5ManifestDeclarationWitnesses, V5SandboxProfileDeclarationWitness,
        V5WorkerManifestDeclarationWitness,
    };
    use crate::id::EventId;
    use crate::payload::trust_spine::{
        ActionEvidenceVersionV1, AttemptContextContentV1, AttemptContextDeclaredV1, CommitModeV1,
        ContextManifestContentV1, ContextManifestDeclaredV1, DispatchBudgetV1,
        DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5,
        ExecutionRoleV1, SandboxProfileContentV1, SandboxProfileDeclaredV1, SandboxRuntimeV1,
        TrustTierV1, WorkerHarnessV1, WorkerManifestContentV1, WorkerManifestDeclaredV1,
        WorkerProviderV1,
    };

    struct Fixture {
        dispatch: DispatchEnvelopeV5,
        context_manifest_event_id: EventId,
        context_manifest: ContextManifestDeclaredV1,
        worker_manifest_event_id: EventId,
        worker_manifest: WorkerManifestDeclaredV1,
        sandbox_profile_event_id: EventId,
        sandbox_profile: SandboxProfileDeclaredV1,
        attempt_context_event_id: EventId,
        attempt_context: AttemptContextDeclaredV1,
    }

    impl Fixture {
        fn witnesses(&self) -> V5ManifestDeclarationWitnesses<'_> {
            V5ManifestDeclarationWitnesses {
                context_manifest: Some(V5ContextManifestDeclarationWitness::from_declaration(
                    &self.context_manifest_event_id,
                    &self.context_manifest,
                )),
                worker_manifest: Some(V5WorkerManifestDeclarationWitness::from_declaration(
                    &self.worker_manifest_event_id,
                    &self.worker_manifest,
                )),
                sandbox_profile: Some(V5SandboxProfileDeclarationWitness::from_declaration(
                    &self.sandbox_profile_event_id,
                    &self.sandbox_profile,
                )),
                attempt_context: Some(V5AttemptContextDeclarationWitness::from_declaration(
                    &self.attempt_context_event_id,
                    &self.attempt_context,
                )),
            }
        }
    }

    fn fixture() -> Fixture {
        const CONTEXT_DIGEST: &str = "context-digest";
        const WORKER_DIGEST: &str = "worker-digest";
        const SANDBOX_DIGEST: &str = "sandbox-digest";
        const ATTEMPT_CONTEXT_DIGEST: &str = "attempt-context-digest";
        const CAPABILITY_BUNDLE_DIGEST: &str = "capability-bundle-digest";
        const IMAGE_DIGEST: &str = "worker-image-digest";

        let context_manifest_event_id = EventId::new();
        let worker_manifest_event_id = EventId::new();
        let sandbox_profile_event_id = EventId::new();
        let attempt_context_event_id = EventId::new();
        let body = DispatchEnvelopeBodyV2 {
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 2,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: "admission:1".into(),
            base_commit_sha: "base".into(),
            capability_bundle_digest: CAPABILITY_BUNDLE_DIGEST.into(),
            acceptance_contract_digest: "acceptance".into(),
            context_manifest_digest: CONTEXT_DIGEST.into(),
            worker_manifest_digest: WORKER_DIGEST.into(),
            sandbox_profile_digest: SANDBOX_DIGEST.into(),
            budget: DispatchBudgetV1 {
                max_tokens: None,
                max_compute_time_ms: None,
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch:workflow-1:unit-1:2".into(),
            issued_at: "issued".into(),
            expires_at: "expires".into(),
        };
        let dispatch = DispatchEnvelopeV5 {
            dispatch_v4: DispatchEnvelopeV4 {
                dispatch_v3: DispatchEnvelopeV3 {
                    body,
                    action_evidence_version: ActionEvidenceVersionV1::SealedV3,
                    repository_binding_digest: "repository".into(),
                    ledger_authority_realm_digest: "realm".into(),
                    governed_packet_digest: Some("packet".into()),
                    envelope_digest: "v3".into(),
                },
                workflow_graph_digest: "graph".into(),
                workflow_graph_declaration_event_ref: EventId::new(),
                envelope_digest: "v4".into(),
            },
            context_manifest_declaration_event_ref: context_manifest_event_id,
            context_manifest_digest: CONTEXT_DIGEST.into(),
            worker_manifest_declaration_event_ref: worker_manifest_event_id,
            worker_manifest_digest: WORKER_DIGEST.into(),
            sandbox_profile_declaration_event_ref: sandbox_profile_event_id,
            sandbox_profile_digest: SANDBOX_DIGEST.into(),
            attempt_context_declaration_event_ref: Some(attempt_context_event_id),
            attempt_context_digest: Some(ATTEMPT_CONTEXT_DIGEST.into()),
            envelope_digest: "v5".into(),
        };
        let context_manifest = ContextManifestDeclaredV1 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 2,
            provenance_ref: "admission:1".into(),
            context_manifest: ContextManifestContentV1 { entries: vec![] },
            context_manifest_digest: CONTEXT_DIGEST.into(),
            idempotency_key: "context".into(),
            declared_at: "declared".into(),
        };
        let worker_manifest = WorkerManifestDeclaredV1 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 2,
            provenance_ref: "admission:1".into(),
            worker_manifest: WorkerManifestContentV1 {
                provider: WorkerProviderV1::OpenAi,
                model: "model".into(),
                harness: WorkerHarnessV1::OpenAiApiSdk,
                image_digest: IMAGE_DIGEST.into(),
                tool_manifest_digest: "tools".into(),
                skill_manifest_digest: "skills".into(),
                capability_bundle_digest: CAPABILITY_BUNDLE_DIGEST.into(),
                execution_role: ExecutionRoleV1::Implementer,
            },
            worker_manifest_digest: WORKER_DIGEST.into(),
            idempotency_key: "worker".into(),
            declared_at: "declared".into(),
        };
        let sandbox_profile = SandboxProfileDeclaredV1 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 2,
            provenance_ref: "admission:1".into(),
            sandbox_profile: SandboxProfileContentV1 {
                runtime: SandboxRuntimeV1::RootlessOci,
                rootless: true,
                image_digest: IMAGE_DIGEST.into(),
                read_only_rootfs: true,
                writable_overlay_digest: "overlay".into(),
                mount_manifest_digest: "mounts".into(),
                environment_manifest_digest: "environment".into(),
                network_policy_digest: "network".into(),
                resource_policy_digest: "resources".into(),
                secret_handle_manifest_digest: "secrets".into(),
            },
            sandbox_profile_digest: SANDBOX_DIGEST.into(),
            idempotency_key: "sandbox".into(),
            declared_at: "declared".into(),
        };
        let attempt_context = AttemptContextDeclaredV1 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 2,
            provenance_ref: "admission:1".into(),
            attempt_context: AttemptContextContentV1 {
                attempt: 2,
                retry_feedback: vec![],
                prior_candidates: vec![],
            },
            attempt_context_digest: ATTEMPT_CONTEXT_DIGEST.into(),
            idempotency_key: "attempt-context".into(),
            declared_at: "declared".into(),
        };
        Fixture {
            dispatch,
            context_manifest_event_id,
            context_manifest,
            worker_manifest_event_id,
            worker_manifest,
            sandbox_profile_event_id,
            sandbox_profile,
            attempt_context_event_id,
            attempt_context,
        }
    }

    #[test]
    fn binds_exact_v5_manifest_declaration_witnesses() {
        let fixture = fixture();

        let binding = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect("valid declarations bind the dispatch");

        assert_eq!(
            binding.context_manifest.event_id,
            fixture.context_manifest_event_id
        );
        assert_eq!(
            binding.attempt_context.expect("retry binding").event_id,
            fixture.attempt_context_event_id
        );
    }

    #[test]
    fn rejects_a_missing_context_manifest_witness() {
        let fixture = fixture();
        let mut witnesses = fixture.witnesses();
        witnesses.context_manifest = None;

        let error =
            validate_v5_manifest_declaration_witnesses(&fixture.dispatch, "run-1", witnesses)
                .expect_err("context witness is required");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::MissingContextManifest
        );
    }

    #[test]
    fn rejects_a_mismatched_context_manifest_event_reference() {
        let mut fixture = fixture();
        fixture.context_manifest_event_id = EventId::new();

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("context witness event id must match V5");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::ContextManifestBindingMismatch
        );
    }

    #[test]
    fn rejects_a_context_manifest_with_a_different_provenance_identity() {
        let mut fixture = fixture();
        fixture.context_manifest.provenance_ref = "admission:other".into();

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("context witness identity must match the dispatch");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::ContextManifestBindingMismatch
        );
    }

    #[test]
    fn rejects_an_outer_manifest_digest_that_differs_from_nested_v4_authority() {
        let mut fixture = fixture();
        fixture.dispatch.context_manifest_digest = "other-context-digest".into();

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("outer V5 digest must match nested V4 authority");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::ContextManifestBindingMismatch
        );
    }

    #[test]
    fn rejects_a_worker_manifest_with_different_role_or_capability_authority() {
        let mut fixture = fixture();
        fixture.worker_manifest.worker_manifest.execution_role = ExecutionRoleV1::Reviewer;

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("worker authority must match nested V4 authority");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::WorkerManifestAuthorityMismatch
        );
    }

    #[test]
    fn rejects_a_worker_manifest_with_a_different_capability_bundle() {
        let mut fixture = fixture();
        fixture
            .worker_manifest
            .worker_manifest
            .capability_bundle_digest = "other-capability-bundle".into();

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("worker capability bundle must match nested V4 authority");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::WorkerManifestAuthorityMismatch
        );
    }

    #[test]
    fn rejects_a_sandbox_profile_with_a_different_worker_image() {
        let mut fixture = fixture();
        fixture.sandbox_profile.sandbox_profile.image_digest = "other-image".into();

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("sandbox image must match worker image");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::SandboxProfileImageMismatch
        );
    }

    #[test]
    fn rejects_an_unpaired_retry_reference_and_digest() {
        let mut fixture = fixture();
        fixture.dispatch.attempt_context_digest = None;

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("retry reference and digest must be paired");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::RetryDeclarationPairRequired
        );
    }

    #[test]
    fn rejects_a_retry_context_with_a_different_attempt() {
        let mut fixture = fixture();
        fixture.attempt_context.attempt_context.attempt = 1;

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("retry context attempt must match dispatch attempt");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::AttemptContextBindingMismatch
        );
    }

    #[test]
    fn rejects_any_retry_declaration_on_the_first_attempt() {
        let mut fixture = fixture();
        fixture.dispatch.dispatch_v4.dispatch_v3.body.attempt = 1;
        fixture.context_manifest.attempt = 1;
        fixture.worker_manifest.attempt = 1;
        fixture.sandbox_profile.attempt = 1;

        let error = validate_v5_manifest_declaration_witnesses(
            &fixture.dispatch,
            "run-1",
            fixture.witnesses(),
        )
        .expect_err("first attempts cannot bind retry declarations");

        assert_eq!(
            error,
            V5ManifestDeclarationWitnessError::FirstAttemptHasRetryDeclaration
        );
    }
}
