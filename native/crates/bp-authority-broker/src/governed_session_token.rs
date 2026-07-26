//! Signed, restart-stable opaque identities for protected governed sessions.
//!
//! Tokens contain only tape identities, a lane discriminator, and signatures.
//! They contain no paths, prompts, credentials, tools, authority constructors,
//! or promotion handles. Repository identity participates in the recovery
//! signature without being disclosed in the token.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use uuid::{Uuid, Version};

const RECOVERY_PREFIX: &str = "gr1";
const SESSION_PREFIX: &str = "gs1";
const RECOVERY_DOMAIN: &[u8] = b"buildplane.governed-recovery-token.v1\0";
const SESSION_DOMAIN: &[u8] = b"buildplane.governed-session-token.v1\0";
const MAX_TOKEN_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GovernedSessionKindV1 {
    Candidate,
    Reviewer,
}

impl GovernedSessionKindV1 {
    fn code(self) -> &'static str {
        match self {
            Self::Candidate => "c",
            Self::Reviewer => "r",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedRecoveryTokenV1 {
    token: String,
    run_id: String,
    candidate_dispatch_event_ref: String,
}

impl VerifiedRecoveryTokenV1 {
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn candidate_dispatch_event_ref(&self) -> &str {
        &self.candidate_dispatch_event_ref
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedSessionTokenV1 {
    session_nonce: String,
    run_id: String,
    candidate_dispatch_event_ref: String,
}

impl VerifiedSessionTokenV1 {
    pub(crate) fn session_nonce(&self) -> &str {
        &self.session_nonce
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn candidate_dispatch_event_ref(&self) -> &str {
        &self.candidate_dispatch_event_ref
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionTokenErrorV1 {
    #[error("governed session token input is invalid")]
    InvalidInput,
    #[error("governed session token signature is invalid")]
    InvalidSignature,
}

pub(crate) fn issue_recovery_token_v1(
    signing_key: &SigningKey,
    run_id: &str,
    candidate_dispatch_event_ref: &str,
    project_identity_digest: &str,
) -> Result<String, GovernedSessionTokenErrorV1> {
    require_v7_uuid(run_id)?;
    require_v7_uuid(candidate_dispatch_event_ref)?;
    require_digest(project_identity_digest)?;
    let message = recovery_message(
        run_id,
        candidate_dispatch_event_ref,
        project_identity_digest,
    );
    let signature = encode_hex(&signing_key.sign(&message).to_bytes());
    let token = format!("{RECOVERY_PREFIX}.{run_id}.{candidate_dispatch_event_ref}.{signature}");
    require_token_shape(&token)?;
    Ok(token)
}

pub(crate) fn verify_recovery_token_v1(
    verifying_key: &VerifyingKey,
    token: &str,
    project_identity_digest: &str,
) -> Result<VerifiedRecoveryTokenV1, GovernedSessionTokenErrorV1> {
    require_digest(project_identity_digest)?;
    let (run_id, candidate_dispatch_event_ref, signature) = parse_recovery_token(token)?;
    verifying_key
        .verify_strict(
            &recovery_message(
                run_id,
                candidate_dispatch_event_ref,
                project_identity_digest,
            ),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| GovernedSessionTokenErrorV1::InvalidSignature)?;
    Ok(VerifiedRecoveryTokenV1 {
        token: token.into(),
        run_id: run_id.into(),
        candidate_dispatch_event_ref: candidate_dispatch_event_ref.into(),
    })
}

pub(crate) fn issue_session_token_v1(
    signing_key: &SigningKey,
    kind: GovernedSessionKindV1,
    recovery: &VerifiedRecoveryTokenV1,
    session_nonce: &str,
) -> Result<String, GovernedSessionTokenErrorV1> {
    require_v7_uuid(session_nonce)?;
    let signature = encode_hex(
        &signing_key
            .sign(&session_message(kind, &recovery.token, session_nonce))
            .to_bytes(),
    );
    let token = format!(
        "{SESSION_PREFIX}.{}.{session_nonce}.{signature}",
        kind.code()
    );
    require_token_shape(&token)?;
    Ok(token)
}

pub(crate) fn verify_session_token_v1(
    verifying_key: &VerifyingKey,
    token: &str,
    expected_kind: GovernedSessionKindV1,
    recovery_token: &str,
) -> Result<VerifiedSessionTokenV1, GovernedSessionTokenErrorV1> {
    require_token_shape(token)?;
    let (run_id, candidate_dispatch_event_ref, _) = parse_recovery_token(recovery_token)?;
    let mut parts = token.split('.');
    let prefix = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let kind = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let session_nonce = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let signature = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    if prefix != SESSION_PREFIX || kind != expected_kind.code() || parts.next().is_some() {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    require_v7_uuid(session_nonce)?;
    let signature = decode_signature(signature)?;
    verifying_key
        .verify_strict(
            &session_message(expected_kind, recovery_token, session_nonce),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| GovernedSessionTokenErrorV1::InvalidSignature)?;
    Ok(VerifiedSessionTokenV1 {
        session_nonce: session_nonce.into(),
        run_id: run_id.into(),
        candidate_dispatch_event_ref: candidate_dispatch_event_ref.into(),
    })
}

fn parse_recovery_token(
    token: &str,
) -> Result<(&str, &str, [u8; 64]), GovernedSessionTokenErrorV1> {
    require_token_shape(token)?;
    let mut parts = token.split('.');
    let prefix = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let run_id = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let candidate_dispatch_event_ref = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    let signature = parts
        .next()
        .ok_or(GovernedSessionTokenErrorV1::InvalidInput)?;
    if prefix != RECOVERY_PREFIX || parts.next().is_some() {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    require_v7_uuid(run_id)?;
    require_v7_uuid(candidate_dispatch_event_ref)?;
    Ok((
        run_id,
        candidate_dispatch_event_ref,
        decode_signature(signature)?,
    ))
}

fn recovery_message(
    run_id: &str,
    candidate_dispatch_event_ref: &str,
    project_identity_digest: &str,
) -> Vec<u8> {
    let mut message = RECOVERY_DOMAIN.to_vec();
    push_field(&mut message, run_id);
    push_field(&mut message, candidate_dispatch_event_ref);
    push_field(&mut message, project_identity_digest);
    message
}

fn session_message(
    kind: GovernedSessionKindV1,
    recovery_token: &str,
    session_nonce: &str,
) -> Vec<u8> {
    let mut message = SESSION_DOMAIN.to_vec();
    push_field(&mut message, kind.code());
    push_field(&mut message, recovery_token);
    push_field(&mut message, session_nonce);
    message
}

fn push_field(message: &mut Vec<u8>, value: &str) {
    message.extend_from_slice(value.as_bytes());
    message.push(0);
}

fn require_v7_uuid(value: &str) -> Result<(), GovernedSessionTokenErrorV1> {
    let parsed = Uuid::parse_str(value).map_err(|_| GovernedSessionTokenErrorV1::InvalidInput)?;
    if parsed.to_string() != value || parsed.get_version() != Some(Version::SortRand) {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    Ok(())
}

fn require_digest(value: &str) -> Result<(), GovernedSessionTokenErrorV1> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    Ok(())
}

fn require_token_shape(value: &str) -> Result<(), GovernedSessionTokenErrorV1> {
    if value.is_empty()
        || value.len() > MAX_TOKEN_BYTES
        || value.contains("..")
        || value.contains("//")
        || value.contains("@{")
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'/' | b'_' | b'-')
        })
    {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    Ok(())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn decode_signature(value: &str) -> Result<[u8; 64], GovernedSessionTokenErrorV1> {
    if value.len() != 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(GovernedSessionTokenErrorV1::InvalidInput);
    }
    let mut output = [0_u8; 64];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| GovernedSessionTokenErrorV1::InvalidInput)?;
    }
    Ok(output)
}
