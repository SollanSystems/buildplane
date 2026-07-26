//! Protected repository identity for candidate creation.
//!
//! This is a Rust port of the TypeScript governed repository-binding contract.
//! The protected host recomputes it with pinned Git and an empty environment;
//! the client never supplies a binding document or target ref.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use thiserror::Error;

const REPOSITORY_BINDING_DOMAIN: &[u8] = b"buildplane.repository-binding.v1\0";
const ORIGIN_URL_DOMAIN: &[u8] = b"buildplane.repository-origin.v1\0";
const GOVERNED_GIT: &str = "/usr/bin/git";
const LOCAL_BRANCH_PREFIX: &str = "refs/heads/";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct GovernedRepositoryBindingV1 {
    schema_version: u8,
    repository_root: String,
    git_common_dir: String,
    object_format: GovernedGitObjectFormatV1,
    target_ref: String,
    origin_url_digest: Option<String>,
}

impl GovernedRepositoryBindingV1 {
    pub(crate) fn repository_root(&self) -> &str {
        &self.repository_root
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum GovernedGitObjectFormatV1 {
    Sha1,
    Sha256,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum CandidateRepositoryErrorV1 {
    #[error("candidate project root is invalid")]
    InvalidProjectRoot,
    #[error("pinned governed Git is unavailable")]
    GitUnavailable,
    #[error("governed repository query failed")]
    GitQuery,
    #[error("governed repository identity is invalid")]
    InvalidRepository,
    #[error("governed repository binding does not match signed authority")]
    BindingMismatch,
    #[error("governed repository binding could not be canonicalized")]
    Canonicalization,
}

pub(crate) fn verify_governed_repository_binding_v1(
    project_root: &str,
    expected_digest: &str,
) -> Result<GovernedRepositoryBindingV1, CandidateRepositoryErrorV1> {
    if !is_canonical_sha256(expected_digest) {
        return Err(CandidateRepositoryErrorV1::BindingMismatch);
    }
    let binding = compute_governed_repository_binding_v1(project_root)?;
    if canonical_governed_repository_binding_digest_v1(&binding)? != expected_digest {
        return Err(CandidateRepositoryErrorV1::BindingMismatch);
    }
    Ok(binding)
}

pub(crate) fn compute_governed_repository_binding_v1(
    project_root: &str,
) -> Result<GovernedRepositoryBindingV1, CandidateRepositoryErrorV1> {
    if project_root.is_empty() || project_root.contains('\0') {
        return Err(CandidateRepositoryErrorV1::InvalidProjectRoot);
    }
    let requested = Path::new(project_root);
    if !requested.is_absolute() {
        return Err(CandidateRepositoryErrorV1::InvalidProjectRoot);
    }
    let requested = canonical_path(requested, CandidateRepositoryErrorV1::InvalidProjectRoot)?;
    let git = governed_git_executable()?;
    let repository_root = canonical_path(
        Path::new(&required_git_value(
            &git,
            &requested,
            &["rev-parse", "--show-toplevel"],
        )?),
        CandidateRepositoryErrorV1::InvalidRepository,
    )?;
    if !requested.starts_with(&repository_root) {
        return Err(CandidateRepositoryErrorV1::InvalidRepository);
    }

    let common_dir =
        required_git_value(&git, &repository_root, &["rev-parse", "--git-common-dir"])?;
    let common_dir = PathBuf::from(common_dir);
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        repository_root.join(common_dir)
    };
    let git_common_dir =
        canonical_path(&common_dir, CandidateRepositoryErrorV1::InvalidRepository)?;

    let object_format = match required_git_value(
        &git,
        &repository_root,
        &["rev-parse", "--show-object-format"],
    )?
    .as_str()
    {
        "sha1" => GovernedGitObjectFormatV1::Sha1,
        "sha256" => GovernedGitObjectFormatV1::Sha256,
        _ => return Err(CandidateRepositoryErrorV1::InvalidRepository),
    };
    let target_ref = required_git_value(&git, &repository_root, &["symbolic-ref", "-q", "HEAD"])?;
    if !target_ref.starts_with(LOCAL_BRANCH_PREFIX)
        || target_ref.len() == LOCAL_BRANCH_PREFIX.len()
        || target_ref.contains(['\0', '\r', '\n'])
    {
        return Err(CandidateRepositoryErrorV1::InvalidRepository);
    }
    let origin_url_digest = optional_git_value(
        &git,
        &repository_root,
        &["config", "--get", "remote.origin.url"],
    )?
    .map(|origin| domain_sha256(ORIGIN_URL_DOMAIN, origin.as_bytes()));

    Ok(GovernedRepositoryBindingV1 {
        schema_version: 1,
        repository_root: path_string(&repository_root)?,
        git_common_dir: path_string(&git_common_dir)?,
        object_format,
        target_ref,
        origin_url_digest,
    })
}

pub(crate) fn canonical_governed_repository_binding_digest_v1(
    binding: &GovernedRepositoryBindingV1,
) -> Result<String, CandidateRepositoryErrorV1> {
    let bytes =
        serde_json::to_vec(binding).map_err(|_| CandidateRepositoryErrorV1::Canonicalization)?;
    Ok(domain_sha256(REPOSITORY_BINDING_DOMAIN, &bytes))
}

pub(crate) fn governed_git_executable() -> Result<PathBuf, CandidateRepositoryErrorV1> {
    let path =
        fs::canonicalize(GOVERNED_GIT).map_err(|_| CandidateRepositoryErrorV1::GitUnavailable)?;
    if !path.is_file() {
        return Err(CandidateRepositoryErrorV1::GitUnavailable);
    }
    Ok(path)
}

pub(crate) fn required_git_value(
    git: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<String, CandidateRepositoryErrorV1> {
    let output = governed_git_output(git, repository, args)?;
    if !output.status.success() {
        return Err(CandidateRepositoryErrorV1::GitQuery);
    }
    decoded_nonempty_stdout(output)
}

fn optional_git_value(
    git: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<Option<String>, CandidateRepositoryErrorV1> {
    let output = governed_git_output(git, repository, args)?;
    if output.status.success() {
        return decoded_nonempty_stdout(output).map(Some);
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err(CandidateRepositoryErrorV1::GitQuery)
}

pub(crate) fn governed_git_output(
    git: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<Output, CandidateRepositoryErrorV1> {
    Command::new(git)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("TZ", "UTC")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "--no-optional-locks",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "gpg.program=false",
            "-c",
            "gpg.ssh.program=false",
            "-c",
            "diff.external=false",
            "-C",
        ])
        .arg(repository)
        .args(args)
        .output()
        .map_err(|_| CandidateRepositoryErrorV1::GitQuery)
}

fn decoded_nonempty_stdout(output: Output) -> Result<String, CandidateRepositoryErrorV1> {
    let value =
        String::from_utf8(output.stdout).map_err(|_| CandidateRepositoryErrorV1::GitQuery)?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(CandidateRepositoryErrorV1::GitQuery);
    }
    Ok(value)
}

fn canonical_path(
    path: &Path,
    error: CandidateRepositoryErrorV1,
) -> Result<PathBuf, CandidateRepositoryErrorV1> {
    fs::canonicalize(path).map_err(|_| error)
}

fn path_string(path: &Path) -> Result<String, CandidateRepositoryErrorV1> {
    path.to_str()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .map(str::to_owned)
        .ok_or(CandidateRepositoryErrorV1::InvalidRepository)
}

fn domain_sha256(domain: &[u8], value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(value);
    format!("sha256:{:x}", hasher.finalize())
}

fn is_canonical_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn canonical_digest_matches_typescript_known_answer() {
        let binding = GovernedRepositoryBindingV1 {
            schema_version: 1,
            repository_root: "/srv/repos/buildplane".into(),
            git_common_dir: "/srv/repos/buildplane/.git".into(),
            object_format: GovernedGitObjectFormatV1::Sha1,
            target_ref: "refs/heads/main".into(),
            origin_url_digest: Some(format!("sha256:{}", "a".repeat(64))),
        };
        assert_eq!(
            canonical_governed_repository_binding_digest_v1(&binding).expect("hash binding"),
            "sha256:5350a74e05cff826218bdda56d3cc13d0b48c16647b54f41c380fcfc78f5bcaa"
        );
        assert_eq!(
            domain_sha256(ORIGIN_URL_DOMAIN, b"git@github.com:example/buildplane.git"),
            "sha256:1e643dbe061a5af8a7446ff14ea5896365fab267d21a602799dc4ec4601f0368"
        );
    }

    #[test]
    fn live_binding_requires_exact_repository_and_digest() {
        let temp = TempDir::new().expect("temp repository");
        let git = governed_git_executable().expect("pinned git");
        let init =
            governed_git_output(&git, temp.path(), &["init", "-b", "main"]).expect("run git init");
        assert!(init.status.success());
        let binding =
            compute_governed_repository_binding_v1(temp.path().to_str().expect("utf8 repository"))
                .expect("compute binding");
        let digest =
            canonical_governed_repository_binding_digest_v1(&binding).expect("hash binding");
        assert_eq!(
            verify_governed_repository_binding_v1(
                temp.path().to_str().expect("utf8 repository"),
                &digest,
            )
            .expect("verify exact binding"),
            binding
        );
        assert_eq!(
            verify_governed_repository_binding_v1(
                temp.path().to_str().expect("utf8 repository"),
                &format!("sha256:{}", "0".repeat(64)),
            ),
            Err(CandidateRepositoryErrorV1::BindingMismatch)
        );
    }

    #[test]
    fn relative_roots_and_detached_heads_fail_closed() {
        assert_eq!(
            compute_governed_repository_binding_v1("relative/repository"),
            Err(CandidateRepositoryErrorV1::InvalidProjectRoot)
        );

        let temp = TempDir::new().expect("temp repository");
        let git = governed_git_executable().expect("pinned git");
        assert!(
            governed_git_output(&git, temp.path(), &["init", "-b", "main"])
                .expect("init")
                .status
                .success()
        );
        assert!(governed_git_output(
            &git,
            temp.path(),
            &[
                "-c",
                "user.name=Buildplane",
                "-c",
                "user.email=buildplane@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "base",
            ],
        )
        .expect("commit")
        .status
        .success());
        assert!(
            governed_git_output(&git, temp.path(), &["checkout", "--detach"])
                .expect("detach")
                .status
                .success()
        );
        assert_eq!(
            compute_governed_repository_binding_v1(temp.path().to_str().expect("utf8 repository"),),
            Err(CandidateRepositoryErrorV1::GitQuery)
        );
    }
}
