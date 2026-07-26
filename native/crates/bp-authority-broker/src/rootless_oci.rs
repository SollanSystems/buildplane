//! Fail-closed rootless OCI authority for governed workers.
//!
//! Startup first proves the fixed Podman runtime and required isolation
//! controls. The command gateway can then consume one broker-private,
//! purpose-bound capability against a startup-bound candidate workspace. It
//! cannot fetch an image, inherit host environment, enable network, select an
//! alternate mount, invoke a shell, or fall back to a host process.

use crate::command_action::{
    CommandEffectGateway, CommandGatewayCompletion, PairedCommandGatewayResult,
    PrivateCommandCapability,
};
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::storage::Cas;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Read;
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

const PODMAN_PROBE_TIMEOUT_MS: u64 = 30_000;
const MAX_COMMAND_EXECUTION_TIMEOUT_MS: u64 = 300_000;
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OciCommandExecutionResultV1 {
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) control_error: Option<String>,
}

pub(crate) trait OciCommandRunner {
    fn run(&mut self, args: &[String], timeout_ms: u64) -> OciCommandExecutionResultV1;
}

#[cfg(target_os = "linux")]
pub(crate) struct FixedPodmanCommandRunner;

#[cfg(target_os = "linux")]
impl OciCommandRunner for FixedPodmanCommandRunner {
    fn run(&mut self, args: &[String], timeout_ms: u64) -> OciCommandExecutionResultV1 {
        let result = run_fixed_podman_probe(args, timeout_ms);
        OciCommandExecutionResultV1 {
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            control_error: result.control_error,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum RootlessOciCommandGatewayStartupErrorV1 {
    #[error("rootless OCI attestation does not match the configured profile")]
    AttestationMismatch,
    #[error("candidate workspace must be one existing canonical non-symlink directory")]
    InvalidCandidateWorkspace,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct GovernedOciCommandEvidenceV1 {
    schema_version: u32,
    run_id: String,
    dispatch_event_id: String,
    action_request_event_id: String,
    command_input_digest: String,
    sandbox_profile_digest: String,
    image: String,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    stdout_digest: String,
    stderr_digest: String,
    stdout_retained_bytes: u64,
    stderr_retained_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_error_digest: Option<String>,
}

/// Rootless OCI gateway for a single candidate workspace. The workspace path
/// is startup-bound and cannot be selected by command evidence. A capability
/// supplies only the already-verified executable and lease deadline.
pub(crate) struct RootlessOciCommandGateway<'a, R> {
    profile: RootlessOciProfileV1,
    candidate_workspace: PathBuf,
    evidence_cas: &'a Cas,
    runner: R,
}

impl<'a, R> RootlessOciCommandGateway<'a, R>
where
    R: OciCommandRunner,
{
    pub(crate) fn new(
        profile: RootlessOciProfileV1,
        attestation: &RootlessOciAttestationV1,
        candidate_workspace: impl AsRef<Path>,
        evidence_cas: &'a Cas,
        runner: R,
    ) -> Result<Self, RootlessOciCommandGatewayStartupErrorV1> {
        if !attestation.rootless
            || !attestation.read_only_base
            || !attestation.writable_overlay
            || attestation.network != "none"
            || attestation.host_fallback
            || attestation.profile_digest != profile.profile_digest
            || attestation.image != profile.image
        {
            return Err(RootlessOciCommandGatewayStartupErrorV1::AttestationMismatch);
        }
        let source = candidate_workspace.as_ref();
        let metadata = fs::symlink_metadata(source)
            .map_err(|_| RootlessOciCommandGatewayStartupErrorV1::InvalidCandidateWorkspace)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(RootlessOciCommandGatewayStartupErrorV1::InvalidCandidateWorkspace);
        }
        let candidate_workspace = fs::canonicalize(source)
            .map_err(|_| RootlessOciCommandGatewayStartupErrorV1::InvalidCandidateWorkspace)?;
        let rendered = candidate_workspace.to_string_lossy();
        if !candidate_workspace.is_absolute() || rendered.contains(['\0', '\r', '\n', ':', ',']) {
            return Err(RootlessOciCommandGatewayStartupErrorV1::InvalidCandidateWorkspace);
        }
        Ok(Self {
            profile,
            candidate_workspace,
            evidence_cas,
            runner,
        })
    }
}

impl<R> CommandEffectGateway for RootlessOciCommandGateway<'_, R>
where
    R: OciCommandRunner,
{
    fn invoke(&mut self, capability: PrivateCommandCapability) -> PairedCommandGatewayResult {
        let now = Utc::now();
        let intent = capability.command_intent().document();
        let timeout_ms = remaining_command_lease_ms(capability.lease_expires_at(), now)
            .map(|remaining| remaining.min(MAX_COMMAND_EXECUTION_TIMEOUT_MS));
        let workdir = governed_container_workdir(intent.cwd.as_deref());
        let execution = match (
            intent.binding.sandbox_profile_digest == self.profile.profile_digest,
            timeout_ms,
            workdir,
        ) {
            (false, _, _) => OciCommandExecutionResultV1 {
                exit_code: Some(126),
                stderr: "signed sandbox profile does not match OCI startup profile".into(),
                ..OciCommandExecutionResultV1::default()
            },
            (true, Some(timeout_ms), Some(workdir)) if timeout_ms > 0 => self.runner.run(
                &governed_command_args(&self.profile, &self.candidate_workspace, intent, &workdir),
                timeout_ms,
            ),
            (true, _, None) => OciCommandExecutionResultV1 {
                exit_code: Some(126),
                stderr: "governed command cwd is outside /workspace".into(),
                ..OciCommandExecutionResultV1::default()
            },
            _ => OciCommandExecutionResultV1 {
                control_error: Some("command lease expired before OCI entry".into()),
                ..OciCommandExecutionResultV1::default()
            },
        };
        let outcome = if execution.control_error.is_some() || execution.exit_code.is_none() {
            ActivityResultOutcomeV1::Unknown
        } else if execution.exit_code == Some(0) {
            ActivityResultOutcomeV1::Succeeded
        } else {
            ActivityResultOutcomeV1::Failed
        };
        let evidence = GovernedOciCommandEvidenceV1 {
            schema_version: 1,
            run_id: capability.run_id().to_string(),
            dispatch_event_id: capability.dispatch_event_id().to_string(),
            action_request_event_id: capability.action_request_event_id().to_string(),
            command_input_digest: intent.command_input_digest.clone(),
            sandbox_profile_digest: self.profile.profile_digest.clone(),
            image: self.profile.image.clone(),
            outcome: match outcome {
                ActivityResultOutcomeV1::Succeeded => "succeeded",
                ActivityResultOutcomeV1::Failed => "failed",
                ActivityResultOutcomeV1::Unknown => "unknown",
            },
            exit_code: execution.exit_code,
            stdout_digest: sha256(execution.stdout.as_bytes()),
            stderr_digest: sha256(execution.stderr.as_bytes()),
            stdout_retained_bytes: execution.stdout.len() as u64,
            stderr_retained_bytes: execution.stderr.len() as u64,
            control_error_digest: execution
                .control_error
                .as_deref()
                .map(|value| sha256(value.as_bytes())),
        };
        let evidence_bytes = match serde_json::to_vec(&evidence) {
            Ok(bytes) => bytes,
            Err(_) => return capability.unrecordable(),
        };
        let evidence_ref = match self.evidence_cas.put_canonical_bytes(&evidence_bytes) {
            Ok(reference) => reference,
            Err(_) => return capability.unrecordable(),
        };
        let evidence_digest = evidence_ref.digest().to_string();
        let evidence_cas_ref = evidence_ref.to_cas_ref();
        let completion = match outcome {
            ActivityResultOutcomeV1::Succeeded => CommandGatewayCompletion::succeeded(
                evidence_digest.clone(),
                evidence_cas_ref.clone(),
                evidence_digest,
                evidence_cas_ref,
            ),
            ActivityResultOutcomeV1::Failed => {
                CommandGatewayCompletion::failed(evidence_digest, evidence_cas_ref)
            }
            ActivityResultOutcomeV1::Unknown => {
                CommandGatewayCompletion::unknown(evidence_digest, evidence_cas_ref)
            }
        };
        capability.complete(completion)
    }
}

fn remaining_command_lease_ms(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let expiry = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Utc);
    let remaining = expiry.signed_duration_since(now).num_milliseconds();
    u64::try_from(remaining).ok()
}

fn governed_command_args(
    profile: &RootlessOciProfileV1,
    candidate_workspace: &Path,
    intent: &bp_ledger::payload::command_evidence::CommandIntentEvidenceDocumentV1,
    workdir: &str,
) -> Vec<String> {
    let mut args = vec![
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
        format!(
            "--volume={}:/workspace:rw,rprivate",
            candidate_workspace.display()
        ),
        format!("--workdir={workdir}"),
        profile.image.clone(),
        intent.command.clone(),
    ];
    args.extend(intent.args.iter().cloned());
    args
}

fn governed_container_workdir(cwd: Option<&str>) -> Option<String> {
    let Some(cwd) = cwd else {
        return Some("/workspace".into());
    };
    let path = Path::new(cwd);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    let normalized = path
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        Some("/workspace".into())
    } else {
        Some(format!("/workspace/{normalized}"))
    }
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
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

#[cfg(test)]
mod command_gateway_tests {
    use super::*;
    use bp_ledger::payload::command_evidence::{
        canonical_command_action_input_v1_bytes, command_intent_evidence_document_v1_bytes,
        parse_verified_canonical_command_action_input_v1,
        parse_verified_command_intent_evidence_document_v1, CanonicalCommandActionInputV1,
        CommandActionEvidenceBindingV1, CommandIntentEvidenceDocumentV1,
        VerifiedCommandIntentEvidenceDocumentV1,
    };
    use bp_ledger::payload::trust_spine::{ActionKindV1, ActionRequestedV2, ExecutionRoleV1};
    use bp_ledger::{EventId, RunId};
    use std::cell::RefCell;
    use std::rc::Rc;
    use tempfile::tempdir;

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const IMAGE: &str =
        "example.invalid/buildplane-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Clone, Default)]
    struct CapturingRunner {
        calls: Rc<RefCell<Vec<(Vec<String>, u64)>>>,
    }

    impl OciCommandRunner for CapturingRunner {
        fn run(&mut self, args: &[String], timeout_ms: u64) -> OciCommandExecutionResultV1 {
            self.calls.borrow_mut().push((args.to_vec(), timeout_ms));
            OciCommandExecutionResultV1 {
                exit_code: Some(0),
                stdout: "ok".into(),
                ..OciCommandExecutionResultV1::default()
            }
        }
    }

    fn profile() -> RootlessOciProfileV1 {
        RootlessOciProfileV1::new(IMAGE, DIGEST, 1, 256 * 1024 * 1024, 64, 64 * 1024 * 1024)
            .unwrap()
    }

    fn attestation(profile: &RootlessOciProfileV1) -> RootlessOciAttestationV1 {
        RootlessOciAttestationV1 {
            runtime: "rootless-oci",
            rootless: true,
            read_only_base: true,
            writable_overlay: true,
            network: "none",
            host_fallback: false,
            profile_digest: profile.profile_digest.clone(),
            image: profile.image.clone(),
        }
    }

    fn verified_intent(
        cas: &Cas,
        run_id: RunId,
        dispatch_event_id: EventId,
        action_request_event_id: EventId,
        cwd: Option<String>,
    ) -> VerifiedCommandIntentEvidenceDocumentV1 {
        let input = CanonicalCommandActionInputV1::new(
            run_id.to_string(),
            "action-1".into(),
            "/usr/bin/git".into(),
            vec!["status".into(), "--short".into()],
            cwd,
        )
        .unwrap();
        let input_bytes = canonical_command_action_input_v1_bytes(&input).unwrap();
        let input_ref = cas.put_canonical_bytes(&input_bytes).unwrap();
        let verified_input = parse_verified_canonical_command_action_input_v1(
            &input_bytes,
            &input_ref.to_cas_ref(),
            input_ref.digest(),
        )
        .unwrap();
        let action = ActionRequestedV2 {
            run_id: run_id.to_string(),
            workflow_id: "workflow-1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            provenance_ref: "provenance-1".into(),
            action_id: "action-1".into(),
            idempotency_key: "command:action-1".into(),
            action_kind: ActionKindV1::Process,
            canonical_input_digest: input_ref.digest().into(),
            canonical_input_ref: input_ref.to_cas_ref(),
            dispatch_envelope_digest: DIGEST.into(),
            repository_binding_digest: DIGEST.into(),
            ledger_authority_realm_digest: DIGEST.into(),
            governed_packet_digest: Some(DIGEST.into()),
            capability_bundle_digest: DIGEST.into(),
            policy_digest: DIGEST.into(),
            context_manifest_digest: DIGEST.into(),
            worker_manifest_digest: DIGEST.into(),
            sandbox_profile_digest: DIGEST.into(),
            authority_actor: "broker-1".into(),
            execution_role: ExecutionRoleV1::Implementer,
            requested_at: "2026-07-26T12:00:00Z".into(),
        };
        let binding = CommandActionEvidenceBindingV1::from_action_requested_v2(
            &action,
            dispatch_event_id,
            action_request_event_id,
        )
        .unwrap();
        let intent = CommandIntentEvidenceDocumentV1::from_verified_canonical_input(
            binding,
            &verified_input,
        )
        .unwrap();
        let bytes = command_intent_evidence_document_v1_bytes(&intent).unwrap();
        let reference = cas.put_canonical_bytes(&bytes).unwrap();
        parse_verified_command_intent_evidence_document_v1(
            &bytes,
            &reference.to_cas_ref(),
            reference.digest(),
        )
        .unwrap()
    }

    #[test]
    fn gateway_runs_exact_command_without_shell_under_fixed_isolation_flags() {
        let directory = tempdir().unwrap();
        let candidate = directory.path().join("candidate");
        fs::create_dir(&candidate).unwrap();
        let cas = Cas::open(directory.path().join("cas")).unwrap();
        let profile = profile();
        let runner = CapturingRunner::default();
        let calls = runner.calls.clone();
        let mut gateway = RootlessOciCommandGateway::new(
            profile.clone(),
            &attestation(&profile),
            &candidate,
            &cas,
            runner,
        )
        .unwrap();
        let run_id = RunId::new();
        let dispatch_event_id = EventId::new();
        let action_request_event_id = EventId::new();
        let capability = PrivateCommandCapability::from_verified_parts_for_tests(
            run_id,
            dispatch_event_id,
            action_request_event_id,
            "lease-1".into(),
            "2099-07-26T12:00:00Z".into(),
            verified_intent(
                &cas,
                run_id,
                dispatch_event_id,
                action_request_event_id,
                Some("src".into()),
            ),
        );

        let _paired = gateway.invoke(capability);
        let calls = calls.borrow();
        assert_eq!(calls.len(), 1);
        let (args, timeout_ms) = &calls[0];
        assert!((1..=MAX_COMMAND_EXECUTION_TIMEOUT_MS).contains(timeout_ms));
        for required in [
            "--read-only",
            "--network=none",
            "--http-proxy=false",
            "--no-hosts",
            "--no-hostname",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--userns=keep-id",
            "--entrypoint=",
            "--workdir=/workspace/src",
        ] {
            assert!(args.iter().any(|value| value == required), "{required}");
        }
        assert!(args
            .iter()
            .any(|value| value.starts_with("--volume=")
                && value.ends_with(":/workspace:rw,rprivate")));
        let image_index = args.iter().position(|value| value == IMAGE).unwrap();
        assert_eq!(args[image_index + 1], "/usr/bin/git");
        assert_eq!(&args[image_index + 2..], ["status", "--short"]);
        assert!(!args
            .iter()
            .any(|value| matches!(value.as_str(), "sh" | "bash" | "/bin/sh" | "/bin/bash")));
    }

    #[test]
    fn path_escape_is_rejected_before_podman_entry() {
        let directory = tempdir().unwrap();
        let candidate = directory.path().join("candidate");
        fs::create_dir(&candidate).unwrap();
        let cas = Cas::open(directory.path().join("cas")).unwrap();
        let profile = profile();
        let runner = CapturingRunner::default();
        let calls = runner.calls.clone();
        let mut gateway = RootlessOciCommandGateway::new(
            profile.clone(),
            &attestation(&profile),
            &candidate,
            &cas,
            runner,
        )
        .unwrap();
        let run_id = RunId::new();
        let dispatch_event_id = EventId::new();
        let action_request_event_id = EventId::new();
        let capability = PrivateCommandCapability::from_verified_parts_for_tests(
            run_id,
            dispatch_event_id,
            action_request_event_id,
            "lease-1".into(),
            "2099-07-26T12:00:00Z".into(),
            verified_intent(
                &cas,
                run_id,
                dispatch_event_id,
                action_request_event_id,
                Some("../outside".into()),
            ),
        );

        let _paired = gateway.invoke(capability);
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn startup_rejects_attestation_or_workspace_substitution() {
        let directory = tempdir().unwrap();
        let candidate = directory.path().join("candidate");
        fs::create_dir(&candidate).unwrap();
        let cas = Cas::open(directory.path().join("cas")).unwrap();
        let profile = profile();
        let mut wrong = attestation(&profile);
        wrong.host_fallback = true;
        assert!(matches!(
            RootlessOciCommandGateway::new(
                profile.clone(),
                &wrong,
                &candidate,
                &cas,
                CapturingRunner::default(),
            ),
            Err(RootlessOciCommandGatewayStartupErrorV1::AttestationMismatch)
        ));
        assert!(matches!(
            RootlessOciCommandGateway::new(
                profile.clone(),
                &attestation(&profile),
                directory.path().join("missing"),
                &cas,
                CapturingRunner::default(),
            ),
            Err(RootlessOciCommandGatewayStartupErrorV1::InvalidCandidateWorkspace)
        ));
    }
}
