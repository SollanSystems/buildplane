use crate::governed_session_token::{
    issue_recovery_token_v1, issue_session_token_v1, verify_recovery_token_v1,
    verify_session_token_v1, GovernedSessionKindV1,
};
use ed25519_dalek::SigningKey;

const PROJECT_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PROJECT_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN_ID: &str = "01919000-0000-7000-8000-000000000101";
const DISPATCH_ID: &str = "01919000-0000-7000-8000-000000000102";
const NONCE: &str = "01919000-0000-7000-8000-000000000103";

#[test]
fn recovery_token_is_bounded_opaque_and_binds_repository_and_tape_identity() {
    let key = SigningKey::from_bytes(&[71; 32]);
    let token =
        issue_recovery_token_v1(&key, RUN_ID, DISPATCH_ID, PROJECT_DIGEST).expect("issue token");
    assert!(token.len() <= 256);
    assert!(token
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ".:/_-".contains(character)));

    let verified =
        verify_recovery_token_v1(&key.verifying_key(), &token, PROJECT_DIGEST).expect("verify");
    assert_eq!(verified.run_id(), RUN_ID);
    assert_eq!(verified.candidate_dispatch_event_ref(), DISPATCH_ID);

    assert!(verify_recovery_token_v1(&key.verifying_key(), &token, OTHER_PROJECT_DIGEST).is_err());
    let substituted = token.replacen(DISPATCH_ID, RUN_ID, 1);
    assert!(verify_recovery_token_v1(&key.verifying_key(), &substituted, PROJECT_DIGEST).is_err());
}

#[test]
fn session_token_binds_exact_recovery_kind_and_nonce_across_restart() {
    let key = SigningKey::from_bytes(&[72; 32]);
    let recovery =
        issue_recovery_token_v1(&key, RUN_ID, DISPATCH_ID, PROJECT_DIGEST).expect("recovery");
    let verified_recovery =
        verify_recovery_token_v1(&key.verifying_key(), &recovery, PROJECT_DIGEST)
            .expect("verified recovery");
    let token = issue_session_token_v1(
        &key,
        GovernedSessionKindV1::Reviewer,
        &verified_recovery,
        NONCE,
    )
    .expect("session");
    assert!(token.len() <= 256);

    let verified = verify_session_token_v1(
        &key.verifying_key(),
        &token,
        GovernedSessionKindV1::Reviewer,
        &recovery,
    )
    .expect("verify session");
    assert_eq!(verified.session_nonce(), NONCE);
    assert_eq!(verified.run_id(), RUN_ID);
    assert_eq!(verified.candidate_dispatch_event_ref(), DISPATCH_ID);

    assert!(verify_session_token_v1(
        &key.verifying_key(),
        &token,
        GovernedSessionKindV1::Candidate,
        &recovery,
    )
    .is_err());
    let other_recovery =
        issue_recovery_token_v1(&key, RUN_ID, NONCE, PROJECT_DIGEST).expect("other recovery");
    assert!(verify_session_token_v1(
        &key.verifying_key(),
        &token,
        GovernedSessionKindV1::Reviewer,
        &other_recovery,
    )
    .is_err());
}

#[test]
fn malformed_noncanonical_or_wrong_key_tokens_fail_closed() {
    let key = SigningKey::from_bytes(&[73; 32]);
    let wrong_key = SigningKey::from_bytes(&[74; 32]);
    let recovery =
        issue_recovery_token_v1(&key, RUN_ID, DISPATCH_ID, PROJECT_DIGEST).expect("recovery");
    assert!(
        verify_recovery_token_v1(&wrong_key.verifying_key(), &recovery, PROJECT_DIGEST).is_err()
    );
    for malformed in [
        "",
        "gr1",
        "gr2.01919000-0000-7000-8000-000000000101",
        "gr1.not-a-uuid.not-a-uuid.deadbeef",
        &recovery.to_uppercase(),
    ] {
        assert!(verify_recovery_token_v1(&key.verifying_key(), malformed, PROJECT_DIGEST).is_err());
    }
}
