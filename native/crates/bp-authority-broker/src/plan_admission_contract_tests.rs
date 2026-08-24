//! Contract coverage for the broker-private plan-admission composition.
//!
//! The negatives are asserted against `admit_detailed` on purpose: six
//! different refusals collapsing to one outward `ReconciliationRequired` would
//! make a suite that only asserts the outward disposition pass even if five of
//! the six checks were deleted. A dedicated test pins the collapse itself, so
//! the non-disclosure property is covered without weakening the negatives.

use crate::plan_admission::{
    parse_plan_admission_request_v1, BrokerPlanAdmissionAuthority, BrokerPlanAdmissionDisposition,
    LedgerPlanAdmissionBackend, LoadedPlanContent, ParsedPlanAdmissionRequestV1,
    PlanAdmissionBackend, PlanAdmissionBackendError, PlanAdmissionIdentityError,
    PlanAdmissionIdentityResolver, PlanAdmissionRefusal, PlanAdmissionRequestRejection,
    PlanAdmissionSnapshotError, PlanAdmissionSnapshotVerifier, PlanContentRefV1,
    PlanContentResolver, PlanContentResolverError, PlanRepositoryDescriptorError,
    PlanRepositoryDescriptorResolver, ResolvedOperatorIdentity, ResolvedRepositoryDescriptor,
    SealedPlanAdmissionEvidence, TrustedPlanAdmissionSnapshotVerifier,
};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{PlanAdmissionAuthorityV1, PlanAdmissionRequestV1, SqliteStore};
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tempfile::TempDir;
use uuid::Uuid;

const KERNEL_SEED: [u8; 32] = [131u8; 32];
const RUN_UUID: &str = "01919000-0000-7000-8000-0000000000e1";
const RUN_STARTED_EVENT_UUID: &str = "01919000-0000-7000-8000-0000000000e2";
const REQUEST_UUID: &str = "01919000-0000-7000-8000-0000000000f1";

fn kernel_key() -> SigningKey {
    SigningKey::from_bytes(&KERNEL_SEED)
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&kernel_key().verifying_key())),
    }
}

fn authority() -> PlanAdmissionAuthorityV1 {
    let mut trusted = TrustedPublicKeys::default();
    let verifying = kernel_key().verifying_key();
    trusted.insert_public_key(public_key_hash(&verifying), verifying.to_bytes().to_vec());
    PlanAdmissionAuthorityV1::new_kernel_realm(
        trusted,
        kernel_signer(),
        format!("sha256:{}", "ab".repeat(32)),
    )
    .unwrap()
}

fn run_id() -> RunId {
    RunId::from_uuid(Uuid::parse_str(RUN_UUID).unwrap())
}

fn plan_bytes() -> Vec<u8> {
    b"## Title\nBroker composition\n\n## Goal\nSeal one plan admission.\n".to_vec()
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn trusted_base() -> String {
    "b".repeat(40)
}

fn wire_frame(content_ref: &str, validation_status: &str) -> String {
    serde_json::json!({
        "schema_version": 1,
        "request_id": REQUEST_UUID,
        "run_id": RUN_UUID,
        "plan_content_ref": content_ref,
        "asserted": {
            "validation_status": validation_status,
            "plan_digest": format!("sha256:{}", "cd".repeat(32)),
            "idempotency_key": "planforge:v0:buildplane:deadbeef:abcd1234",
        },
    })
    .to_string()
}

fn parsed(content_ref: &str, validation_status: &str) -> ParsedPlanAdmissionRequestV1 {
    parse_plan_admission_request_v1(&wire_frame(content_ref, validation_status))
        .expect("the fixture frame is a closed schema-1 request")
}

fn happy_parsed() -> ParsedPlanAdmissionRequestV1 {
    parsed(&format!("cas://{}", sha256_digest(&plan_bytes())), "PASS")
}

struct FakeContent {
    outcome: Result<Vec<u8>, PlanContentResolverError>,
}

impl FakeContent {
    fn serving(bytes: Vec<u8>) -> Self {
        Self { outcome: Ok(bytes) }
    }

    fn absent() -> Self {
        Self {
            outcome: Err(PlanContentResolverError::Absent),
        }
    }
}

impl PlanContentResolver for FakeContent {
    fn load_exact_plan_content(
        &mut self,
        _content_ref: &PlanContentRefV1,
    ) -> Result<LoadedPlanContent, PlanContentResolverError> {
        match &self.outcome {
            Ok(bytes) => Ok(LoadedPlanContent::from_protected_store(bytes.clone())),
            Err(PlanContentResolverError::Absent) => Err(PlanContentResolverError::Absent),
            Err(PlanContentResolverError::Rejected { reason }) => {
                Err(PlanContentResolverError::Rejected {
                    reason: reason.clone(),
                })
            }
        }
    }
}

struct FakeRepository {
    descriptor: Option<ResolvedRepositoryDescriptor>,
}

impl FakeRepository {
    fn bound(run_id: RunId, trusted_base: String) -> Self {
        Self {
            descriptor: Some(ResolvedRepositoryDescriptor::from_retained_custody(
                run_id,
                trusted_base,
            )),
        }
    }

    fn unavailable() -> Self {
        Self { descriptor: None }
    }
}

impl PlanRepositoryDescriptorResolver for FakeRepository {
    fn resolve_repository_descriptor(
        &mut self,
        _run_id: RunId,
    ) -> Result<ResolvedRepositoryDescriptor, PlanRepositoryDescriptorError> {
        self.descriptor
            .clone()
            .ok_or_else(|| PlanRepositoryDescriptorError::Rejected {
                reason: "no retained repository descriptor".into(),
            })
    }
}

struct FakeIdentity {
    decided_by: Option<String>,
}

impl FakeIdentity {
    fn authenticated() -> Self {
        Self {
            decided_by: Some("operator:uid-1000".into()),
        }
    }

    fn rejected() -> Self {
        Self { decided_by: None }
    }

    /// A seam that answers, but with nothing that identifies anyone.
    fn anonymous() -> Self {
        Self {
            decided_by: Some("   ".into()),
        }
    }
}

impl PlanAdmissionIdentityResolver for FakeIdentity {
    fn resolve_authenticated_operator(
        &mut self,
    ) -> Result<ResolvedOperatorIdentity, PlanAdmissionIdentityError> {
        self.decided_by
            .clone()
            .map(ResolvedOperatorIdentity::from_authenticated_peer)
            .ok_or(PlanAdmissionIdentityError::PeerRejected)
    }
}

/// Records what the composition handed the ledger so the tests can prove the
/// derived fields never came from the wire.
#[derive(Default)]
struct RecordingBackend {
    seen: Option<PlanAdmissionRequestV1>,
    fail: Option<PlanAdmissionBackendError>,
}

impl PlanAdmissionBackend for RecordingBackend {
    fn record_then_exact_seal(
        &mut self,
        request: &PlanAdmissionRequestV1,
    ) -> Result<SealedPlanAdmissionEvidence, PlanAdmissionBackendError> {
        self.seen = Some(request.clone());
        if let Some(failure) = self.fail.take() {
            return Err(failure);
        }
        Ok(SealedPlanAdmissionEvidence {
            run_id: request.run_id,
            admission_event_id: EventId::new(),
            admission_event_digest: sha256_digest(b"admission"),
            admission_identity_digest: sha256_digest(b"identity"),
            plan_id: "pf-plan-native-0123456789abcdef0123456789abcdef".into(),
            input_digest: sha256_digest(&request.plan_bytes),
            checkpoint_event_id: EventId::new(),
            checkpoint_event_digest: sha256_digest(b"checkpoint"),
        })
    }
}

struct FakeSnapshot {
    accept: bool,
}

impl PlanAdmissionSnapshotVerifier for FakeSnapshot {
    fn verify_fresh_sealed_admission(
        &mut self,
        _request: &PlanAdmissionRequestV1,
        _sealed: &SealedPlanAdmissionEvidence,
    ) -> Result<(), PlanAdmissionSnapshotError> {
        if self.accept {
            Ok(())
        } else {
            Err(PlanAdmissionSnapshotError::Rejected {
                reason: "fixture rejects".into(),
            })
        }
    }
}

fn broker_with(
    content: FakeContent,
    repository: FakeRepository,
    identity: FakeIdentity,
    backend: RecordingBackend,
    snapshot: FakeSnapshot,
) -> BrokerPlanAdmissionAuthority<
    FakeContent,
    FakeRepository,
    FakeIdentity,
    RecordingBackend,
    FakeSnapshot,
> {
    BrokerPlanAdmissionAuthority::new(content, repository, identity, backend, snapshot)
}

fn happy_broker() -> BrokerPlanAdmissionAuthority<
    FakeContent,
    FakeRepository,
    FakeIdentity,
    RecordingBackend,
    FakeSnapshot,
> {
    broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    )
}

#[test]
fn a_sealed_admission_is_composed_only_from_injected_seams() {
    let mut broker = happy_broker();

    let disposition = broker.admit(happy_parsed());

    assert!(matches!(
        disposition,
        BrokerPlanAdmissionDisposition::Sealed(_)
    ));
}

/// The wire never carries the derived fields; they come from the seams.
#[test]
fn the_derived_fields_come_from_the_seams_and_never_from_the_wire() {
    let mut backend = RecordingBackend::default();
    backend.seen = None;
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        backend,
        FakeSnapshot { accept: true },
    );

    broker
        .admit_detailed(happy_parsed())
        .expect("the fixture composes a sealed admission");

    let seen = broker
        .into_backend_for_tests()
        .seen
        .expect("the backend received a request");
    assert_eq!(seen.run_id, run_id());
    assert_eq!(seen.plan_bytes, plan_bytes());
    assert_eq!(seen.trusted_base, trusted_base());
    assert_eq!(seen.decided_by, "operator:uid-1000");
    assert_eq!(seen.asserted_validation_status, "PASS");
}

#[test]
fn an_unknown_wire_field_is_refused_by_the_closed_request_shape() {
    let frame = serde_json::json!({
        "schema_version": 1,
        "request_id": REQUEST_UUID,
        "run_id": RUN_UUID,
        "plan_content_ref": format!("cas://{}", sha256_digest(&plan_bytes())),
        "input_digest": sha256_digest(&plan_bytes()),
        "asserted": {
            "validation_status": "PASS",
            "plan_digest": format!("sha256:{}", "cd".repeat(32)),
            "idempotency_key": "planforge:v0:buildplane:deadbeef:abcd1234",
        },
    })
    .to_string();

    let outcome = parse_plan_admission_request_v1(&frame);

    assert_eq!(outcome, Err(PlanAdmissionRequestRejection::FrameRejected));
}

/// The closed shape is what stops a caller from choosing an authority field.
#[test]
fn no_derived_field_has_a_wire_slot() {
    for smuggled in [
        "input_digest",
        "plan_id",
        "trusted_base",
        "decided_by",
        "decided_at",
    ] {
        let mut frame = serde_json::json!({
            "schema_version": 1,
            "request_id": REQUEST_UUID,
            "run_id": RUN_UUID,
            "plan_content_ref": format!("cas://{}", sha256_digest(&plan_bytes())),
            "asserted": {
                "validation_status": "PASS",
                "plan_digest": format!("sha256:{}", "cd".repeat(32)),
                "idempotency_key": "planforge:v0:buildplane:deadbeef:abcd1234",
            },
        });
        frame[smuggled] = serde_json::Value::String("chosen-by-the-caller".into());

        assert_eq!(
            parse_plan_admission_request_v1(&frame.to_string()),
            Err(PlanAdmissionRequestRejection::FrameRejected),
            "`{smuggled}` must have no wire slot"
        );
    }
}

#[test]
fn a_non_canonical_content_reference_is_refused() {
    for reference in [
        "/var/lib/buildplane/plan.md",
        "cas://not-a-digest",
        "sha256:deadbeef",
    ] {
        let outcome = parse_plan_admission_request_v1(&wire_frame(reference, "PASS"));
        assert_eq!(
            outcome,
            Err(PlanAdmissionRequestRejection::RequestRejected),
            "`{reference}` is not an opaque canonical content reference"
        );
    }
}

#[test]
fn a_non_pass_validation_assertion_is_refused() {
    let mut broker = happy_broker();

    let outcome = broker.admit_detailed(parsed(
        &format!("cas://{}", sha256_digest(&plan_bytes())),
        "BLOCKED",
    ));

    assert_eq!(outcome, Err(PlanAdmissionRefusal::ValidationNotAsserted));
}

#[test]
fn an_absent_content_reference_is_refused() {
    let mut broker = broker_with(
        FakeContent::absent(),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::PlanContentAbsent));
}

#[test]
fn content_that_does_not_hash_to_its_reference_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(b"a substituted object".to_vec()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::PlanInputDigestMismatch));
}

#[test]
fn a_repository_descriptor_bound_to_another_run_is_refused() {
    let other_run =
        RunId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-0000000000ee").unwrap());
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(other_run, trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::TrustedBaseMismatch));
}

#[test]
fn an_unavailable_repository_descriptor_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::unavailable(),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::TrustedBaseMismatch));
}

#[test]
fn a_trusted_base_that_is_not_a_commit_sha_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), "HEAD".into()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::TrustedBaseMismatch));
}

#[test]
fn an_unauthenticated_peer_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::rejected(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::PeerRejected));
}

/// A seam that answers with a blank identity is not an authenticated peer.
/// Without this the recorded `decided_by` could be whitespace.
#[test]
fn a_blank_operator_identity_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::anonymous(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::PeerRejected));
}

/// A content seam that answers with nothing is not evidence. The reference for
/// empty content is a real sha256, so this case clears the digest check and has
/// to be refused on its own.
#[test]
fn empty_plan_content_is_refused() {
    let empty_ref = format!("cas://{}", sha256_digest(b""));
    let mut broker = broker_with(
        FakeContent::serving(Vec::new()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(parsed(&empty_ref, "PASS"));

    assert_eq!(outcome, Err(PlanAdmissionRefusal::PlanInputRejected));
}

#[test]
fn a_ledger_identity_conflict_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend {
            seen: None,
            fail: Some(PlanAdmissionBackendError::Ledger(
                bp_ledger::LedgerError::PlanAdmissionIdempotencyConflict {
                    run_id: run_id().to_string(),
                    request_id: REQUEST_UUID.into(),
                },
            )),
        },
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(
        outcome,
        Err(PlanAdmissionRefusal::PlanAdmissionIdempotencyConflict)
    );
}

#[test]
fn an_admission_left_awaiting_a_checkpoint_never_becomes_authority() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend {
            seen: None,
            fail: Some(PlanAdmissionBackendError::AwaitingCheckpoint),
        },
        FakeSnapshot { accept: true },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(
        outcome,
        Err(PlanAdmissionRefusal::LedgerReconciliationRequired)
    );
}

#[test]
fn a_rejected_fresh_snapshot_is_refused() {
    let mut broker = broker_with(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        RecordingBackend::default(),
        FakeSnapshot { accept: false },
    );

    let outcome = broker.admit_detailed(happy_parsed());

    assert_eq!(outcome, Err(PlanAdmissionRefusal::FreshSnapshotRejected));
}

/// Every refusal — whatever its internal cause — leaves the composition through
/// the same non-disclosing outward vocabulary.
#[test]
fn every_refusal_collapses_to_reconciliation_required_outward() {
    let cases: Vec<(
        &str,
        FakeContent,
        FakeRepository,
        FakeIdentity,
        RecordingBackend,
        FakeSnapshot,
    )> = vec![
        (
            "content absent",
            FakeContent::absent(),
            FakeRepository::bound(run_id(), trusted_base()),
            FakeIdentity::authenticated(),
            RecordingBackend::default(),
            FakeSnapshot { accept: true },
        ),
        (
            "digest mismatch",
            FakeContent::serving(b"substituted".to_vec()),
            FakeRepository::bound(run_id(), trusted_base()),
            FakeIdentity::authenticated(),
            RecordingBackend::default(),
            FakeSnapshot { accept: true },
        ),
        (
            "trusted base mismatch",
            FakeContent::serving(plan_bytes()),
            FakeRepository::unavailable(),
            FakeIdentity::authenticated(),
            RecordingBackend::default(),
            FakeSnapshot { accept: true },
        ),
        (
            "peer rejected",
            FakeContent::serving(plan_bytes()),
            FakeRepository::bound(run_id(), trusted_base()),
            FakeIdentity::rejected(),
            RecordingBackend::default(),
            FakeSnapshot { accept: true },
        ),
        (
            "snapshot rejected",
            FakeContent::serving(plan_bytes()),
            FakeRepository::bound(run_id(), trusted_base()),
            FakeIdentity::authenticated(),
            RecordingBackend::default(),
            FakeSnapshot { accept: false },
        ),
    ];

    for (label, content, repository, identity, backend, snapshot) in cases {
        let mut broker = broker_with(content, repository, identity, backend, snapshot);
        assert_eq!(
            broker.admit(happy_parsed()),
            BrokerPlanAdmissionDisposition::ReconciliationRequired,
            "{label} must not disclose its cause outward"
        );
    }
}

fn seed_run_started(store: &SqliteStore) {
    let event = Event {
        id: EventId::from_uuid(Uuid::parse_str(RUN_STARTED_EVENT_UUID).unwrap()),
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunStarted,
        occurred_at: Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: trusted_base(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    };
    store
        .append_signed(&event, &kernel_key(), &kernel_signer())
        .unwrap();
}

/// The §6.2(4) postcondition on real evidence: the production backend seals
/// against a real store, and the production verifier reopens a FRESH durable
/// connection and re-derives the exact sealed evidence through it.
#[test]
fn the_production_seams_seal_and_reopen_against_a_real_store() {
    let tmp = TempDir::new().unwrap();
    let database_path = tmp.path().join("events.db");
    let store = SqliteStore::open(&database_path).unwrap();
    seed_run_started(&store);
    let authority = authority();
    let key = kernel_key();
    let signer = kernel_signer();

    let mut broker = BrokerPlanAdmissionAuthority::new(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        LedgerPlanAdmissionBackend::from_prevalidated_startup(&store, &authority, &key, &signer),
        TrustedPlanAdmissionSnapshotVerifier::from_prevalidated_startup(
            &store,
            &database_path,
            &authority,
        ),
    );

    let disposition = broker.admit(happy_parsed());

    assert!(
        matches!(disposition, BrokerPlanAdmissionDisposition::Sealed(_)),
        "the production seams must produce sealed recovery evidence, got {disposition:?}"
    );
    let plan_admitted = store
        .events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "plan_admitted")
        .count();
    assert_eq!(plan_admitted, 1);
}

/// A replay of the same request through the production seams resolves to the
/// identical sealed evidence rather than minting a second admission.
#[test]
fn a_replayed_request_through_the_production_seams_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let database_path = tmp.path().join("events.db");
    let store = SqliteStore::open(&database_path).unwrap();
    seed_run_started(&store);
    let authority = authority();
    let key = kernel_key();
    let signer = kernel_signer();

    let mut broker = BrokerPlanAdmissionAuthority::new(
        FakeContent::serving(plan_bytes()),
        FakeRepository::bound(run_id(), trusted_base()),
        FakeIdentity::authenticated(),
        LedgerPlanAdmissionBackend::from_prevalidated_startup(&store, &authority, &key, &signer),
        TrustedPlanAdmissionSnapshotVerifier::from_prevalidated_startup(
            &store,
            &database_path,
            &authority,
        ),
    );

    let first = broker.admit(happy_parsed());
    let second = broker.admit(happy_parsed());

    assert_eq!(first, second);
    assert!(matches!(first, BrokerPlanAdmissionDisposition::Sealed(_)));
    let plan_admitted = store
        .events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "plan_admitted")
        .count();
    assert_eq!(plan_admitted, 1);
}
