use crate::confinement::{BrokerAuthorityRoleV1, BrokerHostConfinementPolicyV1};
use crate::governed_session_startup::{
    GovernedSessionHostStartupErrorV1, GovernedSessionHostStartupV1,
};
use crate::rootless_oci::{
    attest_rootless_oci_with_runner_v1, OciProbeResultV1, OciProbeRunner, RootlessOciProfileV1,
};
use std::collections::VecDeque;

const IMAGE: &str =
    "localhost/buildplane-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct FakeRunner(VecDeque<OciProbeResultV1>);

impl OciProbeRunner for FakeRunner {
    fn run(&mut self, _args: &[String], _timeout_ms: u64) -> OciProbeResultV1 {
        self.0.pop_front().expect("configured probe")
    }
}

fn ok(stdout: &str) -> OciProbeResultV1 {
    OciProbeResultV1 {
        exit_code: Some(0),
        stdout: stdout.into(),
        ..OciProbeResultV1::default()
    }
}

fn oci_attestation() -> crate::rootless_oci::RootlessOciAttestationV1 {
    let profile = RootlessOciProfileV1::new(IMAGE, DIGEST, 2, 1_073_741_824, 128, 268_435_456)
        .expect("OCI profile");
    let mut runner = FakeRunner(
        [
            ok("podman version 5.5.2"),
            ok(r#"{"host":{"security":{"rootless":true}}}"#),
            ok(""),
            ok("--read-only --network --http-proxy --no-hosts --no-hostname --cap-drop --security-opt --userns --entrypoint"),
            ok(""),
        ]
        .into_iter()
        .collect(),
    );
    attest_rootless_oci_with_runner_v1(&profile, &mut runner, "linux").expect("OCI attestation")
}

#[test]
fn governed_session_startup_requires_model_action_confinement_and_oci() {
    let policy = BrokerHostConfinementPolicyV1::new_for_role(
        1000,
        BrokerAuthorityRoleV1::ModelAction,
        [1001],
    )
    .expect("model policy");
    let broker = policy.attestation_for_same_process_socket_tests();
    let startup = GovernedSessionHostStartupV1::new(policy, broker, oci_attestation())
        .expect("governed session startup");
    assert_eq!(startup.sandbox_profile_digest(), DIGEST);
}

#[test]
fn governed_session_startup_rejects_other_authority_roles() {
    let policy = BrokerHostConfinementPolicyV1::new_for_role(
        1000,
        BrokerAuthorityRoleV1::PromotionDecision,
        [1001],
    )
    .expect("promotion policy");
    let broker = policy.attestation_for_same_process_socket_tests();
    assert_eq!(
        GovernedSessionHostStartupV1::new(policy, broker, oci_attestation())
            .expect_err("wrong authority role"),
        GovernedSessionHostStartupErrorV1::WrongAuthorityRole
    );
}

#[test]
fn governed_session_startup_rejects_mismatched_or_weakened_attestations() {
    let attested_policy = BrokerHostConfinementPolicyV1::new_for_role(
        1000,
        BrokerAuthorityRoleV1::ModelAction,
        [1001],
    )
    .expect("attested policy");
    let broker = attested_policy.attestation_for_same_process_socket_tests();
    let different_policy = BrokerHostConfinementPolicyV1::new_for_role(
        2000,
        BrokerAuthorityRoleV1::ModelAction,
        [2001],
    )
    .expect("different policy");
    assert_eq!(
        GovernedSessionHostStartupV1::new(different_policy, broker, oci_attestation())
            .expect_err("mismatched broker attestation"),
        GovernedSessionHostStartupErrorV1::InvalidConfinement
    );

    let policy = BrokerHostConfinementPolicyV1::new_for_role(
        1000,
        BrokerAuthorityRoleV1::ModelAction,
        [1001],
    )
    .expect("model policy");
    let broker = policy.attestation_for_same_process_socket_tests();
    let mut weakened_oci = oci_attestation();
    weakened_oci.network = "host";
    assert_eq!(
        GovernedSessionHostStartupV1::new(policy, broker, weakened_oci)
            .expect_err("weakened OCI attestation"),
        GovernedSessionHostStartupErrorV1::InvalidOciAttestation
    );
}
