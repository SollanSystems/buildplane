//! Stdin JSONL ingest loop.
//!
//! Reads newline-delimited JSON events from a reader, deserializes them as
//! `Event`, canonicalizes, and appends to the SQLite store. Phase A: no
//! handshake, no control messages, no CAS integration for file-hash events.
//! Phase B adds `_handshake`/`_flush`/`_close` and wires CAS.

use crate::canonicalize::canonicalize;
use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::id::{EventId, RunId};
use crate::keyring::{load_signing_key, KeyringRef};
use crate::kind::EventKind;
use crate::payload::activity_claim::ActivityResultOutcomeV1;
use crate::signing::ActorKeyRef;
use crate::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimDispositionV1, ActivityClaimRequestV1,
    ActivityHeartbeatDispositionV1, ActivityHeartbeatRequestV1, ActivityResultDispositionV1,
    ActivityResultRequestV1, CheckpointPolicy, SqliteStore,
};
use crate::storage::Cas;
use ed25519_dalek::SigningKey;
use std::io::{BufRead, BufReader, Read, Write};

/// Whether the ingest loop signs events on append.
///
/// Default is [`SigningConfig::Unsigned`], preserving pre-M1-S4 behavior.
/// `Signed` loads the configured actor key locally (only a key *reference*
/// crosses the config boundary) and signs every ingested event under that actor.
///
/// Held by reference for the lifetime of a serve loop, so the inter-variant
/// size difference is not a concern.
#[derive(Default)]
#[allow(clippy::large_enum_variant)]
pub enum SigningConfig {
    /// Append events without producing detached signatures (legacy/default).
    #[default]
    Unsigned,
    /// Sign each ingested event with the loaded configured actor key, atomically
    /// with the event-row insert. Append fails closed on any signing or insert
    /// error.
    ///
    /// Emits tape-root checkpoints per `checkpoint_policy` (default cadence:
    /// 256 signed events per run, plus a final checkpoint at `run_completed`).
    Signed {
        // TODO(M2 R-003): wrap the loaded seed in a zeroizing container so the
        // private key material is scrubbed from memory on drop. ed25519-dalek's
        // `SigningKey` does not zeroize on drop by default; deferred this slice.
        signing_key: SigningKey,
        signer: ActorKeyRef,
        checkpoint_policy: CheckpointPolicy,
    },
}

impl SigningConfig {
    /// Build a signed-mode config by loading the configured actor key referenced by
    /// `key_ref` from the default keyring (`~/.buildplane/keys`).
    ///
    /// Only the key reference is passed in; key bytes are loaded locally and
    /// errors redact secret-shaped material.
    pub fn signed_from_keyring(key_ref: &KeyringRef) -> Result<Self> {
        let signing_key = load_signing_key(key_ref)?;
        Ok(SigningConfig::Signed {
            signing_key,
            signer: ActorKeyRef {
                actor_id: key_ref.actor_id.clone(),
                key_id: key_ref.key_id.clone(),
                public_key_hash: None,
            },
            checkpoint_policy: CheckpointPolicy::default(),
        })
    }
}

impl std::fmt::Debug for SigningConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never render key material.
        match self {
            SigningConfig::Unsigned => f.write_str("SigningConfig::Unsigned"),
            SigningConfig::Signed {
                signer,
                checkpoint_policy,
                ..
            } => f
                .debug_struct("SigningConfig::Signed")
                .field("actor_id", &signer.actor_id)
                .field("key_id", &signer.key_id)
                .field("checkpoint_policy", checkpoint_policy)
                .finish_non_exhaustive(),
        }
    }
}

/// Independent trusted authority required by the native activity-claim
/// controls. It is intentionally separate from [`SigningConfig`]: possessing
/// an append key must never implicitly authorize dispatch replay or effect
/// execution.
#[derive(Clone, Debug, Default)]
pub enum ActivityClaimProtocolConfig {
    /// Legacy/default mode. Activity claim and result controls return a typed,
    /// fail-closed rejection and create no rows or events.
    #[default]
    Disabled,
    /// Explicit trust configuration for a future governed dispatch bridge.
    /// The serve loop additionally requires [`SigningConfig::Signed`] and
    /// checks that its key is the configured claim signer.
    Signed(ActivityClaimAuthorityV1),
}

/// Configuration for the protected governed serve lane.
///
/// Unlike the legacy [`serve_with_protocol`] surface, this lane is bound to
/// one already-admitted run and refuses every caller-supplied event. The only
/// records it may append are produced by the typed activity controls after
/// they re-derive their dispatch/action authority from the protected tape.
///
/// This is intentionally a narrow lifecycle boundary, not an admission or
/// dispatch issuer. A pipe holder cannot turn a signed append key into a
/// dispatch, action request, candidate, review, or promotion record.
#[derive(Clone, Debug)]
pub struct GovernedServeProtocolConfigV1 {
    pub expected_run_id: RunId,
    pub activity_claim_authority: ActivityClaimAuthorityV1,
}

/// A single stdin line, interpreted as either a control message or an event envelope.
#[derive(Debug)]
pub enum Line {
    Control(ControlMessage),
    Event(Event),
}

/// Control messages received on stdin.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "control", rename_all = "snake_case")]
pub enum ControlMessage {
    Handshake {
        protocol: u32,
        run_id: crate::id::RunId,
        started_at: String,
        schema_version: u32,
    },
    Flush {
        seq: u64,
    },
    Close {
        seq: u64,
    },
    /// Reserved same-process operation for resolving or issuing a native
    /// `ModelActionAuthorizedV1` record.
    ///
    /// This serve loop deliberately returns a closed rejection for this
    /// operation today. `SigningConfig` supplies an append signer, but it does
    /// not configure the independent trusted public keys and Kernel role
    /// bindings needed to replay a governed V3 dispatch safely. Inferring
    /// replay authority from that signing key would let append configuration
    /// mint authority. A live implementation requires an explicit
    /// trusted-replay-authority configuration plus an atomic replay/append path
    /// under the ledger lock before this variant may return an authorization.
    /// It must also atomically claim/consume that authorization's reference or
    /// idempotency identity at the provider effect boundary (or use provider
    /// idempotency), reconciling a crash after claim rather than retrying it.
    ResolveOrAuthorizeModelActionV1 {
        /// Opaque caller correlation id. No action inputs are accepted until
        /// the trusted replay authority contract exists.
        request_id: String,
    },
    /// Atomically reserve a lease for an already signed governed V3 action
    /// request. The request shape is validated as closed before deserialization;
    /// all authority digests are re-derived from referenced tape events.
    ClaimActivityV1 {
        request_id: String,
        run_id: crate::id::RunId,
        activity_id: String,
        idempotency_key: String,
        dispatch_event_id: EventId,
        action_request_event_id: EventId,
        lease_duration_ms: u64,
    },
    /// Extend an already-granted activity lease. The control cannot name a
    /// dispatch or action request because those identities are re-derived from
    /// the original signed claim under the configured native authority.
    HeartbeatActivityV1 {
        request_id: String,
        run_id: crate::id::RunId,
        activity_id: String,
        idempotency_key: String,
        lease_id: String,
        heartbeat_id: String,
    },
    /// Atomically record a terminal result (or safe `unknown` reconciliation)
    /// for a previously granted activity lease.
    RecordActivityResultV1 {
        request_id: String,
        run_id: crate::id::RunId,
        activity_id: String,
        idempotency_key: String,
        lease_id: String,
        outcome: ActivityResultOutcomeV1,
        result_digest: Option<String>,
        result_ref: Option<String>,
        evidence_digest: String,
        evidence_ref: String,
    },
}

/// Parse a JSON line as either a control message or an event envelope.
pub fn parse_control_or_event(line: &str) -> Result<Line> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| LedgerError::InvalidPayload {
            kind: "<line>".into(),
            reason: format!("invalid json: {e}"),
        })?;
    if value.get("control").is_some() {
        validate_closed_authority_controls(&value)?;
        let ctl: ControlMessage = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Control(ctl))
    } else {
        let evt: Event = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Event(evt))
    }
}

/// Reject records whose semantics are reducer or action authority rather than
/// legacy observational telemetry. This guard sits before canonicalization and
/// signing so a generic stdin writer cannot choose timestamps, lineage, or
/// result fields and have the configured ledger signer bless them.
///
/// Historical tapes remain readable through replay/export paths; this applies
/// only to new caller-supplied events on the generic legacy ingest endpoint.
///
/// New trust-spine records are never valid on the generic endpoint, even when
/// it is unsigned. Older lifecycle records remain available to the explicitly
/// unsafe unsigned lane for compatibility, but a signed append key must never
/// attest caller-chosen lifecycle, acceptance, or recovery evidence. Governed
/// code must use a dedicated control that derives those records from trusted
/// state instead.
fn reject_caller_supplied_authority_event(event: &Event, signed_append: bool) -> Result<()> {
    if matches!(
        event.kind,
        EventKind::DispatchEnvelope
            | EventKind::DispatchEnvelopeV2
            | EventKind::DispatchEnvelopeV3
            | EventKind::DispatchEnvelopeV4
            | EventKind::WorkflowGraphDeclaredV1
            | EventKind::WorkflowGraphDeclaredV2
            | EventKind::ActionRequestedV2
            | EventKind::ModelActionIntentV1
            | EventKind::ModelActionAuthorizedV1
            | EventKind::ModelActionAuthorizedV2
            | EventKind::ActivityClaimedV1
            | EventKind::ActivityHeartbeatRecordedV1
            | EventKind::ActivityResultRecordedV1
            | EventKind::ActionReceiptRecordedV2
            | EventKind::ActionReceiptSetRecordedV1
            | EventKind::AttemptContextRecordedV1
            | EventKind::CandidateCreated
            | EventKind::CandidateCreatedV2
            | EventKind::CandidateCompletionRecordedV1
            | EventKind::CandidateAcceptanceRecorded
            | EventKind::ReviewVerdictRecorded
            | EventKind::ReviewVerdictRecordedV2
            | EventKind::PromotionApprovalRequested
            | EventKind::PromotionDecisionRecorded
            | EventKind::PromotionExecutionClaimedV1
            | EventKind::PromotionResultRecorded
            | EventKind::PromotionReconciliationResolved
            | EventKind::WorkflowTimerScheduledV1
            | EventKind::WorkflowTimerFiredV1
            | EventKind::WorkflowCancellationRequestedV1
            | EventKind::WorkflowTerminal
            | EventKind::WorkflowTerminalV2
    ) {
        return Err(LedgerError::CallerSuppliedTrustSpineEvent {
            kind: event.kind.as_wire().to_string(),
        });
    }

    if signed_append
        && matches!(
            event.kind,
            // These legacy events are still consumed as durable workflow
            // state by replay, fork, PlanForge resume/recovery, and
            // operator-decision reconciliation. A configured append signer
            // must not turn arbitrary pipe input into evidence those paths
            // trust. Tool request/results are included because the legacy
            // `buildplane fork --vcr` recovery path replays their recorded
            // output instead of re-executing the command.
            EventKind::RunStarted
                | EventKind::RunCompleted
                | EventKind::RunFailed
                | EventKind::RunAdmissionRecorded
                | EventKind::PlanAdmitted
                | EventKind::PlanReceiptRecorded
                | EventKind::ActivityStarted
                | EventKind::ActivityCompleted
                | EventKind::UnitStarted
                | EventKind::UnitCompleted
                | EventKind::UnitFailed
                | EventKind::UnitCancelled
                | EventKind::GitCheckpoint
                | EventKind::ToolRequest
                | EventKind::ToolResult
                | EventKind::AcceptanceRecorded
                | EventKind::OperatorDecisionRecorded
                | EventKind::ResultReady
        )
    {
        return Err(LedgerError::CallerSuppliedSignedAuthorityEvent {
            kind: event.kind.as_wire().to_string(),
        });
    }

    Ok(())
}

/// Authority-bearing controls have deliberately closed wire shapes. Existing
/// handshake/flush/close messages retain their historical parser for
/// compatibility, but these V1 endpoints must not silently accept future
/// authority-bearing fields before the native contract defines them.
fn validate_closed_authority_controls(value: &serde_json::Value) -> Result<()> {
    let control = value
        .get("control")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match control {
        "resolve_or_authorize_model_action_v1" => {
            validate_closed_control_fields(value, control, &["control", "request_id"])?;
            if value
                .get("request_id")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|request_id| request_id.trim().is_empty())
            {
                return Err(LedgerError::InvalidPayload {
                    kind: control.into(),
                    reason: "request_id must be a non-empty string".into(),
                });
            }
        }
        "claim_activity_v1" => validate_closed_control_fields(
            value,
            control,
            &[
                "control",
                "request_id",
                "run_id",
                "activity_id",
                "idempotency_key",
                "dispatch_event_id",
                "action_request_event_id",
                "lease_duration_ms",
            ],
        )?,
        "heartbeat_activity_v1" => validate_closed_control_fields(
            value,
            control,
            &[
                "control",
                "request_id",
                "run_id",
                "activity_id",
                "idempotency_key",
                "lease_id",
                "heartbeat_id",
            ],
        )?,
        "record_activity_result_v1" => validate_closed_control_fields(
            value,
            control,
            &[
                "control",
                "request_id",
                "run_id",
                "activity_id",
                "idempotency_key",
                "lease_id",
                "outcome",
                "result_digest",
                "result_ref",
                "evidence_digest",
                "evidence_ref",
            ],
        )?,
        _ => return Ok(()),
    }
    if value
        .get("request_id")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|request_id| request_id.trim().is_empty())
    {
        return Err(LedgerError::InvalidPayload {
            kind: control.into(),
            reason: "request_id must be a non-empty string".into(),
        });
    }
    Ok(())
}

fn validate_closed_control_fields(
    value: &serde_json::Value,
    control: &str,
    expected_fields: &[&str],
) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| LedgerError::InvalidPayload {
            kind: control.into(),
            reason: "control request must be a JSON object".into(),
        })?;
    if object.len() != expected_fields.len()
        || object
            .keys()
            .any(|key| !expected_fields.contains(&key.as_str()))
        || expected_fields
            .iter()
            .any(|field| !object.contains_key(*field))
    {
        return Err(LedgerError::InvalidPayload {
            kind: control.into(),
            reason: "control request has unknown or missing fields".into(),
        });
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct ServeOutcome {
    pub events_written: u64,
    pub last_event_id: Option<EventId>,
}

/// Run the full protocol state machine against the provided reader/writer.
///
/// This legacy surface leaves activity claims disabled. Call
/// [`serve_with_protocol_with_activity_claims`] with an explicit independent
/// trust configuration to enable the new authority-bearing controls.
pub fn serve_with_protocol<R: Read, W: Write>(
    stdin: R,
    stderr: W,
    store: &SqliteStore,
    cas: &Cas,
    declared_schema_version: u32,
    signing: &SigningConfig,
) -> Result<ServeOutcome> {
    serve_with_protocol_inner(
        stdin,
        stderr,
        store,
        cas,
        declared_schema_version,
        signing,
        &ActivityClaimProtocolConfig::Disabled,
        None,
    )
}

/// Run the full protocol state machine with an independently configured,
/// signed activity-claim authority. `SigningConfig::Signed` is necessary but
/// not sufficient: the supplied config also names trusted dispatch and action
/// request signers and the only key allowed to sign claim/result events.
pub fn serve_with_protocol_with_activity_claims<R: Read, W: Write>(
    stdin: R,
    stderr: W,
    store: &SqliteStore,
    cas: &Cas,
    declared_schema_version: u32,
    signing: &SigningConfig,
    activity_claims: &ActivityClaimProtocolConfig,
) -> Result<ServeOutcome> {
    serve_with_protocol_inner(
        stdin,
        stderr,
        store,
        cas,
        declared_schema_version,
        signing,
        activity_claims,
        None,
    )
}

/// Run a host-owned governed activity session for exactly one run.
///
/// The caller must supply a protected signed append configuration and an
/// independently configured activity authority. Any event presented on stdin
/// is rejected before canonicalization or storage; only closed controls may
/// create a native claim, heartbeat, or result record.
pub fn serve_governed_with_protocol<R: Read, W: Write>(
    stdin: R,
    stderr: W,
    store: &SqliteStore,
    cas: &Cas,
    declared_schema_version: u32,
    signing: &SigningConfig,
    config: &GovernedServeProtocolConfigV1,
) -> Result<ServeOutcome> {
    match signing {
        SigningConfig::Unsigned => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed serve requires a protected signed append configuration".into(),
            });
        }
        SigningConfig::Signed {
            checkpoint_policy: CheckpointPolicy::Disabled,
            ..
        } => {
            return Err(LedgerError::ActivityClaimAuthorityRejected {
                reason: "governed serve requires an enabled tape checkpoint policy".into(),
            });
        }
        SigningConfig::Signed { .. } => {}
    }
    let activity_claims =
        ActivityClaimProtocolConfig::Signed(config.activity_claim_authority.clone());
    serve_with_protocol_inner(
        stdin,
        stderr,
        store,
        cas,
        declared_schema_version,
        signing,
        &activity_claims,
        Some(config.expected_run_id),
    )
}

fn serve_with_protocol_inner<R: Read, W: Write>(
    stdin: R,
    mut stderr: W,
    store: &SqliteStore,
    _cas: &Cas,
    declared_schema_version: u32,
    signing: &SigningConfig,
    activity_claims: &ActivityClaimProtocolConfig,
    governed_expected_run_id: Option<RunId>,
) -> Result<ServeOutcome> {
    let mut buf = BufReader::new(stdin);
    let mut outcome = ServeOutcome::default();

    // Phase: AwaitingHandshake
    let mut first_line = String::new();
    if buf.read_line(&mut first_line)? == 0 {
        write_error(
            &mut stderr,
            "handshake_missing",
            1,
            "stdin closed before handshake",
        )?;
        return Err(LedgerError::InvalidPayload {
            kind: "<handshake>".into(),
            reason: "stdin closed before handshake".into(),
        });
    }

    let line = first_line.trim();
    let parsed = match parse_control_or_event(line) {
        Ok(l) => l,
        Err(_) => {
            write_error(
                &mut stderr,
                "handshake_malformed",
                1,
                "first line not valid json",
            )?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line not valid json".into(),
            });
        }
    };

    match parsed {
        Line::Control(ControlMessage::Handshake {
            protocol,
            schema_version,
            run_id,
            ..
        }) => {
            if protocol != 1 {
                write_handshake_ack(
                    &mut stderr,
                    false,
                    &format!("protocol {} not supported", protocol),
                    declared_schema_version,
                )?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: format!("protocol {protocol} not supported"),
                });
            }
            if schema_version != declared_schema_version {
                write_handshake_ack(
                    &mut stderr,
                    false,
                    &format!("schema version {schema_version} not supported (supported: {declared_schema_version})"),
                    declared_schema_version,
                )?;
                return Err(LedgerError::UnsupportedSchemaVersion {
                    received: schema_version,
                    supported: declared_schema_version,
                });
            }
            if let Some(expected_run_id) = governed_expected_run_id {
                if run_id != expected_run_id {
                    let reason = format!(
                        "governed serve is bound to run {}, not {}",
                        expected_run_id, run_id
                    );
                    write_handshake_ack(&mut stderr, false, &reason, declared_schema_version)?;
                    return Err(LedgerError::GovernedServeRunMismatch {
                        expected_run_id: expected_run_id.to_string(),
                        received_run_id: run_id.to_string(),
                    });
                }
            }
            write_handshake_ack(&mut stderr, true, "", declared_schema_version)?;
        }
        _ => {
            write_error(
                &mut stderr,
                "handshake_required",
                1,
                "first line must be a handshake",
            )?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line must be a handshake".into(),
            });
        }
    }

    // Phase: Ingesting
    let mut line_no: u64 = 1;
    loop {
        line_no += 1;
        let mut s = String::new();
        let n = buf.read_line(&mut s)?;
        if n == 0 {
            break;
        }
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        let parsed = match parse_control_or_event(s) {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("line {}: {}", line_no, e);
                write_error(&mut stderr, "malformed_event", line_no, &msg)?;
                return Err(e);
            }
        };
        if let Some(expected_run_id) = governed_expected_run_id {
            if let Some(received_run_id) = control_run_id(&parsed) {
                if received_run_id != expected_run_id {
                    let error = LedgerError::GovernedServeRunMismatch {
                        expected_run_id: expected_run_id.to_string(),
                        received_run_id: received_run_id.to_string(),
                    };
                    write_error(
                        &mut stderr,
                        "governed_run_mismatch",
                        line_no,
                        &error.to_string(),
                    )?;
                    return Err(error);
                }
            }
        }
        match parsed {
            Line::Event(event) => {
                if governed_expected_run_id.is_some() {
                    let error = LedgerError::CallerSuppliedGovernedEvent {
                        kind: event.kind.as_wire().to_string(),
                    };
                    write_error(
                        &mut stderr,
                        "caller_supplied_governed_event",
                        line_no,
                        &error.to_string(),
                    )?;
                    return Err(error);
                }
                // Generic `ledger serve` is a legacy/non-governed ingest lane. It
                // may never turn pipe-controlled JSON into a signed trust-spine
                // authority record; those effects must use a dedicated native
                // control that replays and verifies the preceding evidence.
                if let Err(e) = reject_caller_supplied_authority_event(
                    &event,
                    matches!(signing, SigningConfig::Signed { .. }),
                ) {
                    write_error(
                        &mut stderr,
                        "caller_supplied_authority_event",
                        line_no,
                        &e.to_string(),
                    )?;
                    return Err(e);
                }
                let canonical = canonicalize(event)?;
                let event_id = canonical.id;
                let append_result = match signing {
                    SigningConfig::Unsigned => store.append(&canonical),
                    SigningConfig::Signed {
                        signing_key,
                        signer,
                        checkpoint_policy,
                    } => store
                        .append_signed_with_checkpoint(
                            &canonical,
                            signing_key,
                            signer,
                            checkpoint_policy,
                        )
                        .map(|_| ()),
                };
                if let Err(e) = append_result {
                    write_error(&mut stderr, "storage_failure", line_no, &format!("{}", e))?;
                    return Err(e);
                }
                outcome.events_written += 1;
                outcome.last_event_id = Some(event_id);
            }
            Line::Control(ControlMessage::Flush { seq }) => {
                let last = store.flush_fsync()?;
                write_flush_ack(&mut stderr, seq, last)?;
            }
            Line::Control(ControlMessage::Close { seq: _ }) => {
                let last = store.flush_fsync()?;
                write_close_ack(&mut stderr, outcome.events_written, last)?;
                return Ok(outcome);
            }
            Line::Control(ControlMessage::ResolveOrAuthorizeModelActionV1 { request_id }) => {
                // Do not derive trust from `signing`: signing controls how new
                // rows are appended, while this operation needs independently
                // configured verification keys and Kernel role authority for
                // every replayed trust-spine record.
                write_model_action_authority_unavailable(&mut stderr, &request_id)?;
            }
            Line::Control(ControlMessage::ClaimActivityV1 {
                request_id,
                run_id,
                activity_id,
                idempotency_key,
                dispatch_event_id,
                action_request_event_id,
                lease_duration_ms,
            }) => {
                let request = ActivityClaimRequestV1 {
                    run_id,
                    activity_id,
                    idempotency_key,
                    dispatch_event_id,
                    action_request_event_id,
                    lease_duration_ms,
                };
                match activity_claims {
                    ActivityClaimProtocolConfig::Disabled => {
                        write_activity_claim_rejected(
                            &mut stderr,
                            "claim_activity_v1_result",
                            &request_id,
                            "trusted_activity_authority_unconfigured",
                            "activity claims require independent trusted authority configuration",
                        )?;
                    }
                    ActivityClaimProtocolConfig::Signed(authority) => match signing {
                        SigningConfig::Unsigned => {
                            write_activity_claim_rejected(
                                &mut stderr,
                                "claim_activity_v1_result",
                                &request_id,
                                "signed_append_required",
                                "activity claims require a signed ledger append configuration",
                            )?;
                        }
                        SigningConfig::Signed {
                            signing_key,
                            signer,
                            ..
                        } => {
                            // A corrupt checkpoint chain must fail before a
                            // fresh claim can expand activity authority. Keep
                            // the post-mutation seal below as the response
                            // gate for the newly written claim.
                            seal_governed_control_prefix(
                                store,
                                governed_expected_run_id,
                                signing_key,
                                signer,
                            )?;
                            match store.claim_activity_v1(&request, authority, signing_key, signer)
                            {
                                Ok(disposition) => {
                                    seal_governed_control_prefix(
                                        store,
                                        governed_expected_run_id,
                                        signing_key,
                                        signer,
                                    )?;
                                    write_activity_claim_disposition(
                                        &mut stderr,
                                        &request_id,
                                        disposition,
                                    )?;
                                }
                                Err(error) => {
                                    write_activity_claim_rejected(
                                        &mut stderr,
                                        "claim_activity_v1_result",
                                        &request_id,
                                        activity_claim_error_code(&error),
                                        &error.to_string(),
                                    )?;
                                }
                            }
                        }
                    },
                }
            }
            Line::Control(ControlMessage::RecordActivityResultV1 {
                request_id,
                run_id,
                activity_id,
                idempotency_key,
                lease_id,
                outcome,
                result_digest,
                result_ref,
                evidence_digest,
                evidence_ref,
            }) => {
                let request = ActivityResultRequestV1 {
                    run_id,
                    activity_id,
                    idempotency_key,
                    lease_id,
                    outcome,
                    result_digest,
                    result_ref,
                    evidence_digest,
                    evidence_ref,
                };
                match activity_claims {
                    ActivityClaimProtocolConfig::Disabled => {
                        write_activity_claim_rejected(
                            &mut stderr,
                            "record_activity_result_v1_result",
                            &request_id,
                            "trusted_activity_authority_unconfigured",
                            "activity results require independent trusted authority configuration",
                        )?;
                    }
                    ActivityClaimProtocolConfig::Signed(authority) => match signing {
                        SigningConfig::Unsigned => {
                            write_activity_claim_rejected(
                                &mut stderr,
                                "record_activity_result_v1_result",
                                &request_id,
                                "signed_append_required",
                                "activity results require a signed ledger append configuration",
                            )?;
                        }
                        SigningConfig::Signed {
                            signing_key,
                            signer,
                            ..
                        } => {
                            // A corrupt checkpoint chain must fail before a
                            // fresh terminal result can expand activity
                            // authority. Keep the post-mutation seal below as
                            // the response gate for the newly written result.
                            seal_governed_control_prefix(
                                store,
                                governed_expected_run_id,
                                signing_key,
                                signer,
                            )?;
                            match store.record_activity_result_v1(
                                &request,
                                authority,
                                signing_key,
                                signer,
                            ) {
                                Ok(disposition) => {
                                    seal_governed_control_prefix(
                                        store,
                                        governed_expected_run_id,
                                        signing_key,
                                        signer,
                                    )?;
                                    write_activity_result_disposition(
                                        &mut stderr,
                                        &request_id,
                                        disposition,
                                    )?;
                                }
                                Err(error) => {
                                    write_activity_claim_rejected(
                                        &mut stderr,
                                        "record_activity_result_v1_result",
                                        &request_id,
                                        activity_claim_error_code(&error),
                                        &error.to_string(),
                                    )?;
                                }
                            }
                        }
                    },
                }
            }
            Line::Control(ControlMessage::HeartbeatActivityV1 {
                request_id,
                run_id,
                activity_id,
                idempotency_key,
                lease_id,
                heartbeat_id,
            }) => {
                let request = ActivityHeartbeatRequestV1 {
                    run_id,
                    activity_id,
                    idempotency_key,
                    lease_id,
                    heartbeat_id,
                };
                match activity_claims {
                    ActivityClaimProtocolConfig::Disabled => {
                        write_activity_claim_rejected(
                            &mut stderr,
                            "heartbeat_activity_v1_result",
                            &request_id,
                            "trusted_activity_authority_unconfigured",
                            "activity heartbeats require independent trusted authority configuration",
                        )?;
                    }
                    ActivityClaimProtocolConfig::Signed(authority) => match signing {
                        SigningConfig::Unsigned => {
                            write_activity_claim_rejected(
                                &mut stderr,
                                "heartbeat_activity_v1_result",
                                &request_id,
                                "signed_append_required",
                                "activity heartbeats require a signed ledger append configuration",
                            )?;
                        }
                        SigningConfig::Signed {
                            signing_key,
                            signer,
                            ..
                        } => {
                            // A corrupt checkpoint chain must fail before a
                            // fresh heartbeat can expand activity authority.
                            // Keep the post-mutation seal below as the
                            // response gate for the newly written heartbeat.
                            seal_governed_control_prefix(
                                store,
                                governed_expected_run_id,
                                signing_key,
                                signer,
                            )?;
                            match store.heartbeat_activity_v1(
                                &request,
                                authority,
                                signing_key,
                                signer,
                            ) {
                                Ok(disposition) => {
                                    seal_governed_control_prefix(
                                        store,
                                        governed_expected_run_id,
                                        signing_key,
                                        signer,
                                    )?;
                                    write_activity_heartbeat_disposition(
                                        &mut stderr,
                                        &request_id,
                                        disposition,
                                    )?;
                                }
                                Err(error) => {
                                    write_activity_claim_rejected(
                                        &mut stderr,
                                        "heartbeat_activity_v1_result",
                                        &request_id,
                                        activity_claim_error_code(&error),
                                        &error.to_string(),
                                    )?;
                                }
                            }
                        }
                    },
                }
            }
            Line::Control(ControlMessage::Handshake { .. }) => {
                write_error(
                    &mut stderr,
                    "unexpected_handshake",
                    line_no,
                    "handshake after initial setup",
                )?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: "unexpected second handshake".into(),
                });
            }
        }
    }

    Ok(outcome)
}

fn control_run_id(line: &Line) -> Option<RunId> {
    match line {
        Line::Control(ControlMessage::ClaimActivityV1 { run_id, .. })
        | Line::Control(ControlMessage::HeartbeatActivityV1 { run_id, .. })
        | Line::Control(ControlMessage::RecordActivityResultV1 { run_id, .. }) => Some(*run_id),
        _ => None,
    }
}

/// Seal the configured governed run before reporting a control disposition.
///
/// The bound run comes from the trusted serve configuration, never the wire
/// control. Legacy activity-control endpoints pass `None` and preserve their
/// existing no-forced-checkpoint behavior.
fn seal_governed_control_prefix(
    store: &SqliteStore,
    governed_expected_run_id: Option<RunId>,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) -> Result<()> {
    if let Some(expected_run_id) = governed_expected_run_id {
        let _ = store.seal_governed_signed_prefix(&expected_run_id, signing_key, signer)?;
    }
    Ok(())
}

fn write_handshake_ack<W: Write>(
    stderr: &mut W,
    ready: bool,
    reason: &str,
    declared_schema_version: u32,
) -> std::io::Result<()> {
    let line = if ready {
        format!(
            r#"{{"control":"handshake_ack","ready":true,"ledger_version":"{}","schema_version":{}}}{}"#,
            env!("CARGO_PKG_VERSION"),
            declared_schema_version,
            '\n'
        )
    } else {
        format!(
            r#"{{"control":"handshake_ack","ready":false,"reason":{}}}{}"#,
            serde_json::to_string(reason).unwrap_or_else(|_| "\"error\"".to_string()),
            '\n'
        )
    };
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_flush_ack<W: Write>(
    stderr: &mut W,
    seq: u64,
    last: Option<EventId>,
) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"flush_ack","seq":{},"last_event_id":"{}"}}{}"#,
        seq, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_close_ack<W: Write>(
    stderr: &mut W,
    events_written: u64,
    last: Option<EventId>,
) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"close_ack","events_written":{},"last_event_id":"{}"}}{}"#,
        events_written, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

/// Return a typed, closed response for the reserved native authority RPC.
///
/// This is intentionally not a generic protocol error: callers must be able
/// to distinguish unavailable authority infrastructure from a malformed
/// stream, while the serve loop remains compatible with existing
/// handshake/event/flush/close clients. It performs no replay and no write.
fn write_model_action_authority_unavailable<W: Write>(
    stderr: &mut W,
    request_id: &str,
) -> std::io::Result<()> {
    let request_id = serde_json::to_string(request_id).unwrap_or_else(|_| "\"\"".to_string());
    let message = serde_json::to_string(
        "native model-action authority is unavailable: ledger serve has no configured trusted replay authorities (trusted public keys plus Kernel role bindings)",
    )
    .unwrap_or_else(|_| "\"error\"".to_string());
    let line = format!(
        r#"{{"control":"resolve_or_authorize_model_action_v1_result","request_id":{},"outcome":"rejected","code":"trusted_replay_authority_unconfigured","message":{}}}{}"#,
        request_id, message, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_activity_claim_disposition<W: Write>(
    stderr: &mut W,
    request_id: &str,
    disposition: ActivityClaimDispositionV1,
) -> std::io::Result<()> {
    let value = match disposition {
        ActivityClaimDispositionV1::Granted {
            claim_event_id,
            claim_event_digest,
            lease_id,
            lease_expires_at,
        } => serde_json::json!({
            "control": "claim_activity_v1_result",
            "request_id": request_id,
            "outcome": "granted",
            "claim_event_id": claim_event_id.to_string(),
            "claim_event_digest": claim_event_digest,
            "lease_id": lease_id,
            "lease_expires_at": lease_expires_at,
        }),
        ActivityClaimDispositionV1::Pending {
            claim_event_id,
            lease_expires_at,
        } => serde_json::json!({
            "control": "claim_activity_v1_result",
            "request_id": request_id,
            "outcome": "pending",
            "claim_event_id": claim_event_id.to_string(),
            "lease_expires_at": lease_expires_at,
        }),
        ActivityClaimDispositionV1::Recorded {
            claim_event_id,
            result_event_id,
            result_event_digest,
            outcome,
        } => serde_json::json!({
            "control": "claim_activity_v1_result",
            "request_id": request_id,
            "outcome": "recorded",
            "claim_event_id": claim_event_id.to_string(),
            "result_event_id": result_event_id.to_string(),
            "result_event_digest": result_event_digest,
            "result_outcome": outcome,
        }),
        ActivityClaimDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => serde_json::json!({
            "control": "claim_activity_v1_result",
            "request_id": request_id,
            "outcome": "lease_expired",
            "claim_event_id": claim_event_id.to_string(),
            "lease_expires_at": lease_expires_at,
        }),
    };
    write_json_line(stderr, &value)
}

fn write_activity_heartbeat_disposition<W: Write>(
    stderr: &mut W,
    request_id: &str,
    disposition: ActivityHeartbeatDispositionV1,
) -> std::io::Result<()> {
    let value = match disposition {
        ActivityHeartbeatDispositionV1::Recorded {
            heartbeat_event_id,
            heartbeat_event_digest,
            lease_expires_at,
        } => serde_json::json!({
            "control": "heartbeat_activity_v1_result",
            "request_id": request_id,
            "outcome": "recorded",
            "heartbeat_event_id": heartbeat_event_id.to_string(),
            "heartbeat_event_digest": heartbeat_event_digest,
            "lease_expires_at": lease_expires_at,
        }),
        ActivityHeartbeatDispositionV1::Existing {
            heartbeat_event_id,
            heartbeat_event_digest,
            lease_expires_at,
        } => serde_json::json!({
            "control": "heartbeat_activity_v1_result",
            "request_id": request_id,
            "outcome": "existing",
            "heartbeat_event_id": heartbeat_event_id.to_string(),
            "heartbeat_event_digest": heartbeat_event_digest,
            "lease_expires_at": lease_expires_at,
        }),
        ActivityHeartbeatDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => serde_json::json!({
            "control": "heartbeat_activity_v1_result",
            "request_id": request_id,
            "outcome": "lease_expired",
            "claim_event_id": claim_event_id.to_string(),
            "lease_expires_at": lease_expires_at,
        }),
    };
    write_json_line(stderr, &value)
}

fn write_activity_result_disposition<W: Write>(
    stderr: &mut W,
    request_id: &str,
    disposition: ActivityResultDispositionV1,
) -> std::io::Result<()> {
    let value = match disposition {
        ActivityResultDispositionV1::Recorded {
            result_event_id,
            result_event_digest,
            outcome,
        } => serde_json::json!({
            "control": "record_activity_result_v1_result",
            "request_id": request_id,
            "outcome": "recorded",
            "result_event_id": result_event_id.to_string(),
            "result_event_digest": result_event_digest,
            "result_outcome": outcome,
        }),
        ActivityResultDispositionV1::LeaseExpired {
            claim_event_id,
            lease_expires_at,
        } => serde_json::json!({
            "control": "record_activity_result_v1_result",
            "request_id": request_id,
            "outcome": "lease_expired",
            "claim_event_id": claim_event_id.to_string(),
            "lease_expires_at": lease_expires_at,
        }),
    };
    write_json_line(stderr, &value)
}

fn write_activity_claim_rejected<W: Write>(
    stderr: &mut W,
    control: &str,
    request_id: &str,
    code: &str,
    message: &str,
) -> std::io::Result<()> {
    write_json_line(
        stderr,
        &serde_json::json!({
            "control": control,
            "request_id": request_id,
            "outcome": "rejected",
            "code": code,
            "message": message,
        }),
    )
}

fn write_json_line<W: Write>(stderr: &mut W, value: &serde_json::Value) -> std::io::Result<()> {
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| {
        r#"{"control":"error","kind":"serialization","message":"response encoding failed"}"#
            .to_string()
    });
    stderr.write_all(encoded.as_bytes())?;
    stderr.write_all(b"\n")?;
    stderr.flush()
}

fn activity_claim_error_code(error: &LedgerError) -> &'static str {
    match error {
        LedgerError::ActivityClaimAuthorityRejected { .. } => "trusted_activity_authority_rejected",
        LedgerError::ActivityClaimIdempotencyConflict { .. } => "idempotency_conflict",
        LedgerError::ActivityClaimNotFound { .. } => "activity_claim_not_found",
        LedgerError::ActivityClaimLeaseMismatch { .. } => "lease_mismatch",
        LedgerError::ActivityHeartbeatIdempotencyConflict { .. } => {
            "heartbeat_idempotency_conflict"
        }
        LedgerError::InvalidPayload { .. } => "invalid_activity_request",
        LedgerError::NonMonotonicEventId { .. } => "non_monotonic_event_id",
        _ => "activity_claim_storage_failure",
    }
}

fn write_error<W: Write>(
    stderr: &mut W,
    kind: &str,
    line_no: u64,
    message: &str,
) -> std::io::Result<()> {
    let line = format!(
        r#"{{"control":"error","kind":"{}","line":{},"message":{}}}{}"#,
        kind,
        line_no,
        serde_json::to_string(message).unwrap_or_else(|_| "\"error\"".to_string()),
        '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

/// Ingest events from `reader` and append to `store` until EOF.
///
/// Returns the number of events successfully appended. The first malformed
/// line aborts ingestion with an error — this matches the spec's "malformed
/// line is a protocol violation" requirement.
pub fn ingest<R: Read>(reader: R, store: &SqliteStore) -> Result<u64> {
    let buf = BufReader::new(reader);
    let mut count: u64 = 0;
    for (idx, line) in buf.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: Event =
            serde_json::from_str(&line).map_err(|e| LedgerError::InvalidPayload {
                kind: "<unknown>".to_string(),
                reason: format!("line {}: {e}", idx + 1),
            })?;
        let canonical = canonicalize(event)?;
        store.append(&canonical)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{EventId, RunId};
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use crate::payload::Payload;
    use chrono::Utc;

    fn encode(event: &Event) -> String {
        serde_json::to_string(event).unwrap() + "\n"
    }

    fn sample(run_id: RunId) -> Event {
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "0".into(),
                event_count: "1".into(),
                unit_count: "0".into(),
            }),
        }
    }

    #[test]
    fn ingests_single_event_to_sqlite() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = encode(&event);
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn ingests_multiple_events_in_order() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let e1 = sample(run_id);
        let e2 = sample(run_id);
        let e3 = sample(run_id);
        let input = format!("{}{}{}", encode(&e1), encode(&e2), encode(&e3));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 3);
        let rows = store.events_for_run(&run_id.to_string()).unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn skips_blank_lines() {
        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::new();
        let event = sample(run_id);
        let input = format!("\n{}  \n\n", encode(&event));
        let n = ingest(input.as_bytes(), &store).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn malformed_line_aborts_with_error() {
        let store = SqliteStore::open_in_memory().unwrap();
        let input = b"not-valid-json\n";
        let err = ingest(&input[..], &store).unwrap_err();
        assert!(matches!(err, LedgerError::InvalidPayload { .. }));
        assert_eq!(store.event_count().unwrap(), 0);
    }
}

#[cfg(test)]
mod control_message_tests {
    use super::*;

    #[test]
    fn control_handshake_parses() {
        let line = r#"{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":1}"#;
        let msg = parse_control_or_event(line).unwrap();
        match msg {
            Line::Control(ControlMessage::Handshake {
                protocol,
                schema_version,
                ..
            }) => {
                assert_eq!(protocol, 1);
                assert_eq!(schema_version, 1);
            }
            _ => panic!("expected Handshake"),
        }
    }

    #[test]
    fn control_flush_parses() {
        let line = r#"{"control":"flush","seq":42}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Flush { seq }) => assert_eq!(seq, 42),
            _ => panic!("expected Flush"),
        }
    }

    #[test]
    fn control_close_parses() {
        let line = r#"{"control":"close","seq":43}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Close { seq }) => assert_eq!(seq, 43),
            _ => panic!("expected Close"),
        }
    }

    #[test]
    fn heartbeat_activity_control_is_closed_and_rejects_unknown_fields() {
        let line = r#"{"control":"heartbeat_activity_v1","request_id":"heartbeat-1","run_id":"01919000-0000-7000-8000-000000000000","activity_id":"action-1","idempotency_key":"action:1","lease_id":"lease-1","heartbeat_id":"heartbeat:1","forged_authority":true}"#;
        let error = parse_control_or_event(line)
            .expect_err("authority-bearing heartbeat controls must reject unknown fields");
        assert!(matches!(error, LedgerError::InvalidPayload { .. }));
        assert!(error.to_string().contains("unknown or missing fields"));
    }

    #[test]
    fn generic_ingest_rejects_caller_supplied_trust_spine_activity_events() {
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::activity_claim::ActivityHeartbeatRecordedV1;
        use crate::payload::trust_spine::{
            promotion_execution_claimed_v1_digest, PromotionExecutionClaimedV1,
        };
        use crate::payload::Payload;
        use chrono::Utc;

        let run_id = RunId::new();
        let event = crate::event::Event {
            id: EventId::new(),
            run_id,
            parent_event_id: Some(EventId::new()),
            schema_version: 1,
            kind: EventKind::ActivityHeartbeatRecordedV1,
            occurred_at: Utc::now(),
            payload: Payload::ActivityHeartbeatRecordedV1(ActivityHeartbeatRecordedV1 {
                run_id,
                activity_id: "action-1".into(),
                idempotency_key: "action-key-1".into(),
                heartbeat_id: Some("heartbeat-1".into()),
                heartbeat_request_digest: Some(
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .into(),
                ),
                claim_event_id: EventId::new(),
                claim_event_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                lease_id: "lease-1".into(),
                dispatch_event_id: EventId::new(),
                dispatch_envelope_digest:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
                lease_expires_at: "2026-07-20T01:00:00Z".into(),
                heartbeat_at: "2026-07-20T00:30:00Z".into(),
            }),
        };

        let error = reject_caller_supplied_authority_event(&event, false)
            .expect_err("legacy generic ingest must not sign authority events");
        assert!(matches!(
            error,
            LedgerError::CallerSuppliedTrustSpineEvent { .. }
        ));

        let mut claim = PromotionExecutionClaimedV1 {
            run_id: run_id.to_string(),
            promotion_decision_event_ref: EventId::new(),
            promotion_decision_event_digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            dispatch_event_ref: EventId::new(),
            dispatch_envelope_digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            candidate_digest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".into(),
            candidate_commit_sha: "1".repeat(40),
            candidate_tree_digest:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".into(),
            base_commit_sha: "2".repeat(40),
            target_ref: "refs/heads/main".into(),
            idempotency_key: "promotion:candidate-1".into(),
            authority_actor: "kernel".into(),
            lease_id: "promotion-lease-1".into(),
            claimed_at: "2026-07-20T00:30:00Z".into(),
            lease_expires_at: "2026-07-20T00:31:00Z".into(),
            promotion_execution_claim_digest: String::new(),
        };
        claim.promotion_execution_claim_digest =
            promotion_execution_claimed_v1_digest(&claim).expect("hash promotion claim");
        let claim_event = crate::event::Event {
            id: EventId::new(),
            run_id,
            parent_event_id: Some(claim.promotion_decision_event_ref),
            schema_version: 1,
            kind: EventKind::PromotionExecutionClaimedV1,
            occurred_at: Utc::now(),
            payload: Payload::PromotionExecutionClaimedV1(claim),
        };
        let error = reject_caller_supplied_authority_event(&claim_event, false)
            .expect_err("generic ingest must not mint a promotion execution lease");
        assert!(matches!(
            error,
            LedgerError::CallerSuppliedTrustSpineEvent { .. }
        ));
    }

    #[test]
    fn signed_generic_ingest_rejects_legacy_lifecycle_authority_events() {
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        for kind in [
            EventKind::RunCompleted,
            EventKind::ActivityCompleted,
            EventKind::AcceptanceRecorded,
            EventKind::OperatorDecisionRecorded,
            EventKind::ResultReady,
            EventKind::ToolRequest,
            EventKind::ToolResult,
        ] {
            let event = crate::event::Event {
                id: EventId::new(),
                run_id: RunId::new(),
                parent_event_id: None,
                schema_version: 1,
                kind,
                occurred_at: Utc::now(),
                payload: Payload::RunCompletedV1(RunCompletedV1 {
                    outcome: RunOutcome::Passed,
                    duration_ms: "0".into(),
                    event_count: "1".into(),
                    unit_count: "0".into(),
                }),
            };
            // The guard classifies envelope kind before payload
            // canonicalization. Reusing a valid run-completed payload here
            // intentionally keeps this focused on the ingress classification
            // table.
            let error = reject_caller_supplied_authority_event(&event, true)
                .expect_err("signed generic ingest must not mint workflow lifecycle evidence");
            assert!(matches!(
                error,
                LedgerError::CallerSuppliedSignedAuthorityEvent { .. }
            ));

            reject_caller_supplied_authority_event(&event, false)
                .expect("the explicitly unsafe unsigned lane retains legacy compatibility");
        }
    }

    #[test]
    fn event_envelope_parses_as_event() {
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let event = crate::event::Event {
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
        let line = serde_json::to_string(&event).unwrap();
        match parse_control_or_event(&line).unwrap() {
            Line::Event(e) => assert_eq!(e.id, event.id),
            _ => panic!("expected Event"),
        }
    }
}
