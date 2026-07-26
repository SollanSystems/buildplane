//! Fail-closed rootless OCI feasibility authority for governed workers.
//!
//! This module owns only startup attestation. It cannot execute a repository
//! action, select mounts, inject environment, fetch an image, or fall back to a
//! host process. A later broker-owned action gateway may consume the frozen
//! attestation together with reducer-issued activity authority.

use serde_json::Value;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

const PODMAN_PROBE_TIMEOUT_MS: u64 = 30_000;
const MAX_CPU_CORES: u16 = 4;
const MAX_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PIDS_LIMIT: u32 = 256;
const MAX_TMPFS_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(target_os = "linux")]
const PINNED_PODMAN_BINARY: &str = "/usr/bin/podman";
#[cfg(target_os = "linux")]
const MAX_PROBE_OUTPUT_BYTES: usize = 64 * 1024;
const REQUIRED_RUN_HELP_FLAGS: [&str; 9] = [
    "--read-only",
    "--network",
    "--http-proxy",
    "--no-hosts",
    "--no-hostname",
    "--cap-drop",
    "--security-opt",
    "--userns",
    "--entrypoint",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RootlessOciProfileV1 {
    image: String,
    profile_digest: String,
    cpu_cores: u16,
    memory_bytes: u64,
    pids_limit: u32,
    tmpfs_bytes: u64,
}

impl RootlessOciProfileV1 {
    pub(crate) fn new(
        image: impl Into<String>,
        profile_digest: impl Into<String>,
        cpu_cores: u16,
        memory_bytes: u64,
        pids_limit: u32,
        tmpfs_bytes: u64,
    ) -> Result<Self, RootlessOciStartupErrorV1> {
        let image = image.into();
        let profile_digest = profile_digest.into();
        if !is_digest_pinned_image(&image) {
            return Err(RootlessOciStartupErrorV1::InvalidProfile);
        }
        if !is_sha256_digest(&profile_digest)
            || cpu_cores == 0
            || cpu_cores > MAX_CPU_CORES
            || memory_bytes == 0
            || memory_bytes > MAX_MEMORY_BYTES
            || pids_limit == 0
            || pids_limit > MAX_PIDS_LIMIT
            || tmpfs_bytes == 0
            || tmpfs_bytes > MAX_TMPFS_BYTES
        {
            return Err(RootlessOciStartupErrorV1::InvalidProfile);
        }
        Ok(Self {
            image,
            profile_digest,
            cpu_cores,
            memory_bytes,
            pids_limit,
            tmpfs_bytes,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RootlessOciAttestationV1 {
    pub(crate) runtime: &'static str,
    pub(crate) rootless: bool,
    pub(crate) read_only_base: bool,
    pub(crate) writable_overlay: bool,
    pub(crate) network: &'static str,
    pub(crate) host_fallback: bool,
    pub(crate) profile_digest: String,
    pub(crate) image: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OciProbeResultV1 {
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) control_error: Option<String>,
}

pub(crate) trait OciProbeRunner {
    fn run(&mut self, args: &[String], timeout_ms: u64) -> OciProbeResultV1;
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum RootlessOciStartupErrorV1 {
    #[error("rootless OCI profile is invalid")]
    InvalidProfile,
    #[error("governed OCI requires a Linux or WSL Linux process")]
    UnsupportedHost,
    #[error("fixed Podman runtime is unavailable")]
    RuntimeUnavailable,
    #[error("Podman version output is invalid")]
    VersionRejected,
    #[error("rootless Podman mode could not be proven")]
    RootlessNotProven,
    #[error("rootless Podman user namespaces are unavailable")]
    UserNamespaceUnavailable,
    #[error("Podman lacks required governed isolation flags")]
    IsolationFlagsUnavailable,
    #[error("isolated governed OCI canary did not complete")]
    CanaryRejected,
}

pub(crate) fn attest_rootless_oci_with_runner_v1<R: OciProbeRunner>(
    profile: &RootlessOciProfileV1,
    runner: &mut R,
    host_platform: &str,
) -> Result<RootlessOciAttestationV1, RootlessOciStartupErrorV1> {
    if host_platform != "linux" {
        return Err(RootlessOciStartupErrorV1::UnsupportedHost);
    }
    let version = runner.run(&strings(&["--version"]), PODMAN_PROBE_TIMEOUT_MS);
    if !probe_succeeded(&version) {
        return Err(RootlessOciStartupErrorV1::RuntimeUnavailable);
    }
    if !valid_podman_version(&version.stdout) {
        return Err(RootlessOciStartupErrorV1::VersionRejected);
    }
    let info = runner.run(
        &strings(&["info", "--format", "json"]),
        PODMAN_PROBE_TIMEOUT_MS,
    );
    if !probe_succeeded(&info) || !reports_rootless(&info.stdout) {
        return Err(RootlessOciStartupErrorV1::RootlessNotProven);
    }
    let userns = runner.run(&strings(&["unshare", "true"]), PODMAN_PROBE_TIMEOUT_MS);
    if !probe_succeeded(&userns) {
        return Err(RootlessOciStartupErrorV1::UserNamespaceUnavailable);
    }
    let help = runner.run(&strings(&["run", "--help"]), PODMAN_PROBE_TIMEOUT_MS);
    if !probe_succeeded(&help)
        || REQUIRED_RUN_HELP_FLAGS
            .iter()
            .any(|required| !help.stdout.contains(required))
    {
        return Err(RootlessOciStartupErrorV1::IsolationFlagsUnavailable);
    }
    let canary = runner.run(&governed_canary_args(profile), PODMAN_PROBE_TIMEOUT_MS);
    if !probe_succeeded(&canary) {
        return Err(RootlessOciStartupErrorV1::CanaryRejected);
    }
    Ok(RootlessOciAttestationV1 {
        runtime: "rootless-oci",
        rootless: true,
        read_only_base: true,
        writable_overlay: true,
        network: "none",
        host_fallback: false,
        profile_digest: profile.profile_digest.clone(),
        image: profile.image.clone(),
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn attest_rootless_oci_v1(
    profile: &RootlessOciProfileV1,
) -> Result<RootlessOciAttestationV1, RootlessOciStartupErrorV1> {
    let mut runner = FixedPodmanProbeRunner;
    attest_rootless_oci_with_runner_v1(profile, &mut runner, "linux")
}

#[cfg(target_os = "linux")]
struct FixedPodmanProbeRunner;

#[cfg(target_os = "linux")]
impl OciProbeRunner for FixedPodmanProbeRunner {
    fn run(&mut self, args: &[String], timeout_ms: u64) -> OciProbeResultV1 {
        run_fixed_podman_probe(args, timeout_ms)
    }
}

#[cfg(target_os = "linux")]
fn run_fixed_podman_probe(args: &[String], timeout_ms: u64) -> OciProbeResultV1 {
    let mut child = match Command::new(PINNED_PODMAN_BINARY)
        .args(args)
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return OciProbeResultV1 {
                control_error: Some(format!("fixed Podman spawn failed: {error}")),
                ..OciProbeResultV1::default()
            };
        }
    };
    let stdout_reader = child
        .stdout
        .take()
        .map(|stream| thread::spawn(move || read_bounded_probe_output(stream)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|stream| thread::spawn(move || read_bounded_probe_output(stream)));
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut control_error = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                control_error = Some("fixed Podman probe exceeded its absolute deadline".into());
                let _ = child.kill();
                break child.wait().ok();
            }
            Err(error) => {
                control_error = Some(format!("fixed Podman probe status failed: {error}"));
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = join_probe_reader(stdout_reader);
    let stderr = join_probe_reader(stderr_reader);
    OciProbeResultV1 {
        exit_code: status.and_then(|status| status.code()),
        stdout,
        stderr,
        control_error,
    }
}

#[cfg(target_os = "linux")]
fn read_bounded_probe_output<R: Read>(mut reader: R) -> String {
    let mut retained = Vec::with_capacity(MAX_PROBE_OUTPUT_BYTES.min(4096));
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        if retained.len() < MAX_PROBE_OUTPUT_BYTES {
            let remaining = MAX_PROBE_OUTPUT_BYTES - retained.len();
            retained.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    String::from_utf8_lossy(&retained).into_owned()
}

#[cfg(target_os = "linux")]
fn join_probe_reader(reader: Option<thread::JoinHandle<String>>) -> String {
    reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default()
}

fn governed_canary_args(profile: &RootlessOciProfileV1) -> Vec<String> {
    vec![
        "run".into(),
        "--rm".into(),
        "--pull=never".into(),
        "--read-only".into(),
        "--network=none".into(),
        "--http-proxy=false".into(),
        "--no-hosts".into(),
        "--no-hostname".into(),
        "--cap-drop=ALL".into(),
        "--security-opt=no-new-privileges".into(),
        "--userns=keep-id".into(),
        "--entrypoint=".into(),
        format!("--cpus={}", profile.cpu_cores),
        format!("--memory={}b", profile.memory_bytes),
        format!("--pids-limit={}", profile.pids_limit),
        format!(
            "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size={}",
            profile.tmpfs_bytes
        ),
        "--env=HOME=/tmp".into(),
        "--env=TMPDIR=/tmp".into(),
        "--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        "--env=LANG=C.UTF-8".into(),
        "--env=LC_ALL=C.UTF-8".into(),
        profile.image.clone(),
        "/bin/true".into(),
    ]
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn probe_succeeded(result: &OciProbeResultV1) -> bool {
    result.exit_code == Some(0) && result.control_error.is_none()
}

fn valid_podman_version(stdout: &str) -> bool {
    let mut words = stdout.split_ascii_whitespace();
    matches!(words.next(), Some(value) if value.eq_ignore_ascii_case("podman"))
        && matches!(words.next(), Some(value) if value.eq_ignore_ascii_case("version"))
        && words
            .next()
            .is_some_and(|version| version.split('.').take(3).count() == 3)
}

fn reports_rootless(stdout: &str) -> bool {
    serde_json::from_str::<Value>(stdout)
        .ok()
        .and_then(|value| {
            value
                .get("host")?
                .get("security")?
                .get("rootless")?
                .as_bool()
        })
        == Some(true)
}

fn is_digest_pinned_image(value: &str) -> bool {
    let Some((name, digest)) = value.rsplit_once('@') else {
        return false;
    };
    !name.is_empty()
        && !name.chars().any(char::is_whitespace)
        && !name.contains("..")
        && is_sha256_digest(digest)
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
