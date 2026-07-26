use super::rootless_oci::{
    attest_rootless_oci_with_runner_v1, OciProbeResultV1, OciProbeRunner, RootlessOciProfileV1,
    RootlessOciStartupErrorV1,
};
use std::collections::VecDeque;

const IMAGE: &str =
    "localhost/buildplane-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Default)]
struct FakeRunner {
    results: VecDeque<OciProbeResultV1>,
    calls: Vec<Vec<String>>,
}

impl OciProbeRunner for FakeRunner {
    fn run(&mut self, args: &[String], _timeout_ms: u64) -> OciProbeResultV1 {
        self.calls.push(args.to_vec());
        self.results.pop_front().expect("configured probe result")
    }
}

fn ok(stdout: &str) -> OciProbeResultV1 {
    OciProbeResultV1 {
        exit_code: Some(0),
        stdout: stdout.into(),
        stderr: String::new(),
        control_error: None,
    }
}

fn profile() -> RootlessOciProfileV1 {
    RootlessOciProfileV1::new(IMAGE, DIGEST, 2, 1_073_741_824, 128, 268_435_456)
        .expect("closed OCI profile")
}

#[test]
fn rootless_oci_attestation_runs_the_exact_isolated_canary() {
    let mut runner = FakeRunner {
        results: [
            ok("podman version 5.5.2"),
            ok(r#"{"host":{"security":{"rootless":true}}}"#),
            ok(""),
            ok("--read-only --network --http-proxy --no-hosts --no-hostname --cap-drop --security-opt --userns --entrypoint"),
            ok(""),
        ]
        .into_iter()
        .collect(),
        calls: Vec::new(),
    };

    let attestation = attest_rootless_oci_with_runner_v1(&profile(), &mut runner, "linux")
        .expect("rootless OCI attestation");
    assert!(attestation.rootless);
    assert!(attestation.read_only_base);
    assert_eq!(attestation.network, "none");
    assert!(!attestation.host_fallback);
    assert_eq!(runner.calls.len(), 5);
    assert_eq!(runner.calls[0], ["--version"]);
    assert_eq!(runner.calls[1], ["info", "--format", "json"]);
    assert_eq!(runner.calls[2], ["unshare", "true"]);
    assert_eq!(runner.calls[3], ["run", "--help"]);
    let canary = &runner.calls[4];
    for required in [
        "run",
        "--rm",
        "--pull=never",
        "--read-only",
        "--network=none",
        "--http-proxy=false",
        "--no-hosts",
        "--no-hostname",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--userns=keep-id",
        "--entrypoint=",
        IMAGE,
        "/bin/true",
    ] {
        assert!(
            canary.iter().any(|arg| arg == required),
            "missing {required}"
        );
    }
    assert!(!canary.iter().any(|arg| arg.starts_with("--volume")));
    assert!(!canary.iter().any(|arg| arg.starts_with("--mount")));
}

#[test]
fn rootless_oci_attestation_fails_closed_before_canary() {
    let mut non_linux = FakeRunner::default();
    assert_eq!(
        attest_rootless_oci_with_runner_v1(&profile(), &mut non_linux, "windows")
            .expect_err("host fallback is forbidden"),
        RootlessOciStartupErrorV1::UnsupportedHost
    );
    assert!(non_linux.calls.is_empty());

    let mut rootful = FakeRunner {
        results: [
            ok("podman version 5.5.2"),
            ok(r#"{"host":{"security":{"rootless":false}}}"#),
        ]
        .into_iter()
        .collect(),
        calls: Vec::new(),
    };
    assert_eq!(
        attest_rootless_oci_with_runner_v1(&profile(), &mut rootful, "linux")
            .expect_err("rootful Podman cannot attest"),
        RootlessOciStartupErrorV1::RootlessNotProven
    );
    assert_eq!(rootful.calls.len(), 2);
}

#[test]
fn rootless_oci_profile_rejects_unpinned_images_and_invalid_limits() {
    assert!(RootlessOciProfileV1::new(
        "localhost/buildplane-worker:latest",
        DIGEST,
        2,
        1_073_741_824,
        128,
        268_435_456,
    )
    .is_err());
    assert!(RootlessOciProfileV1::new(IMAGE, DIGEST, 0, 1, 1, 1).is_err());
}
