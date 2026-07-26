//! Deterministic detached workspace opening for one sealed V5 candidate.
//!
//! Opening is deliberately weaker than candidate creation: it creates no
//! candidate ref, commit, tape event, or promotion authority. The workspace is
//! rooted beneath the retained protected authority directory and starts at the
//! exact signed base commit while the target checkout remains unchanged.

use crate::candidate_repository::{
    governed_git_executable, governed_git_output, required_git_value,
    verify_governed_repository_binding_v1, CandidateRepositoryErrorV1,
};
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};
use thiserror::Error;

const WORKSPACE_DIRECTORY: &[u8] = b"candidate-workspaces\0";
const CANDIDATE_REF_PREFIX: &str = "refs/buildplane/candidates/";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateWorkspaceManifestV1 {
    schema_version: u8,
    run_id: String,
    dispatch_event_id: String,
    admission_event_id: String,
    repository_root: String,
    repository_binding_digest: String,
    candidate_id: String,
    candidate_ref: String,
    workspace_name: String,
    base_commit_sha: String,
    dispatch_envelope_digest: String,
    governed_packet_digest: String,
    sandbox_profile_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenedCandidateWorkspaceV1 {
    pub(crate) candidate_id: String,
    pub(crate) candidate_ref: String,
    pub(crate) path: PathBuf,
    pub(crate) base_commit_sha: String,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum CandidateWorkspaceErrorV1 {
    #[error("candidate repository authority is invalid")]
    Repository,
    #[error("candidate base is stale or invalid")]
    BaseMismatch,
    #[error("target checkout is not clean")]
    DirtyTarget,
    #[error("candidate workspace custody is unavailable or unsafe")]
    WorkspaceCustody,
    #[error("candidate workspace Git operation failed")]
    Git,
    #[error("candidate already has an immutable ref")]
    AlreadyFinalized,
    #[error("candidate workspace recovery is ambiguous")]
    ReconciliationRequired,
}

impl From<CandidateRepositoryErrorV1> for CandidateWorkspaceErrorV1 {
    fn from(_: CandidateRepositoryErrorV1) -> Self {
        Self::Repository
    }
}

pub(crate) fn open_candidate_workspace_v1(
    authority_root: &File,
    project_root: &str,
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<OpenedCandidateWorkspaceV1, CandidateWorkspaceErrorV1> {
    let repository_binding =
        verify_governed_repository_binding_v1(project_root, &authority.repository_binding_digest)?;
    let git = governed_git_executable()?;
    let project = Path::new(project_root);
    let root_head = required_git_value(&git, project, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    if root_head != authority.base_commit_sha {
        return Err(CandidateWorkspaceErrorV1::BaseMismatch);
    }
    let root_tree = required_git_value(&git, project, &["rev-parse", "HEAD^{tree}"])?;
    if !required_git_value_allow_empty(&git, project, &["status", "--porcelain=v1", "-z"])?
        .is_empty()
    {
        return Err(CandidateWorkspaceErrorV1::DirtyTarget);
    }

    let (candidate_id, candidate_ref, workspace_name) = candidate_identity(authority)?;
    let candidate_ref_query = governed_git_output(
        &git,
        project,
        &["show-ref", "--verify", "--quiet", &candidate_ref],
    )?;
    match candidate_ref_query.status.code() {
        Some(0) => return Err(CandidateWorkspaceErrorV1::AlreadyFinalized),
        Some(1) => {}
        _ => return Err(CandidateWorkspaceErrorV1::Git),
    }

    let workspace_root = open_or_create_private_directory_at(authority_root, WORKSPACE_DIRECTORY)?;
    let canonical_workspace_root = PathBuf::from(format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        workspace_root.as_raw_fd()
    ))
    .canonicalize()
    .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    let workspace_path = PathBuf::from(format!(
        "/proc/{}/fd/{}/{}",
        std::process::id(),
        workspace_root.as_raw_fd(),
        workspace_name
    ));

    if workspace_path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    if workspace_path.exists() {
        verify_existing_workspace(&git, &workspace_path, &authority.base_commit_sha)?;
    } else {
        let output = governed_git_output(
            &git,
            project,
            &[
                "worktree",
                "add",
                "--detach",
                workspace_path
                    .to_str()
                    .ok_or(CandidateWorkspaceErrorV1::WorkspaceCustody)?,
                &authority.base_commit_sha,
            ],
        )?;
        if !output.status.success() {
            if workspace_path.exists() {
                verify_existing_workspace(&git, &workspace_path, &authority.base_commit_sha)?;
            } else {
                return Err(CandidateWorkspaceErrorV1::Git);
            }
        }
    }

    let final_root_head =
        required_git_value(&git, project, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let final_root_tree = required_git_value(&git, project, &["rev-parse", "HEAD^{tree}"])?;
    if final_root_head != root_head
        || final_root_tree != root_tree
        || !required_git_value_allow_empty(&git, project, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }

    let canonical_workspace = workspace_path
        .canonicalize()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    if canonical_workspace.parent() != Some(canonical_workspace_root.as_path()) {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    persist_workspace_manifest(
        &workspace_root,
        &workspace_name,
        &CandidateWorkspaceManifestV1 {
            schema_version: 1,
            run_id: authority.run_id.to_string(),
            dispatch_event_id: authority.dispatch_event_id.to_string(),
            admission_event_id: authority.admission_event_id.to_string(),
            repository_root: repository_binding.repository_root().into(),
            repository_binding_digest: authority.repository_binding_digest.clone(),
            candidate_id: candidate_id.clone(),
            candidate_ref: candidate_ref.clone(),
            workspace_name: workspace_name.clone(),
            base_commit_sha: authority.base_commit_sha.clone(),
            dispatch_envelope_digest: authority.dispatch_envelope_digest.clone(),
            governed_packet_digest: authority.governed_packet_digest.clone(),
            sandbox_profile_digest: authority.sandbox_profile_digest.clone(),
        },
    )?;

    Ok(OpenedCandidateWorkspaceV1 {
        candidate_id,
        candidate_ref,
        path: canonical_workspace,
        base_commit_sha: authority.base_commit_sha.clone(),
    })
}

pub(crate) fn reopen_candidate_workspace_v1(
    authority_root: &File,
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<OpenedCandidateWorkspaceV1, CandidateWorkspaceErrorV1> {
    let (candidate_id, candidate_ref, workspace_name) = candidate_identity(authority)?;
    let workspace_root = open_or_create_private_directory_at(authority_root, WORKSPACE_DIRECTORY)?;
    let manifest_bytes =
        read_workspace_manifest_bytes(&workspace_root, &manifest_name(&workspace_name)?)?;
    let manifest: CandidateWorkspaceManifestV1 = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| CandidateWorkspaceErrorV1::ReconciliationRequired)?;
    if manifest.schema_version != 1
        || manifest.run_id != authority.run_id.to_string()
        || manifest.dispatch_event_id != authority.dispatch_event_id.to_string()
        || manifest.admission_event_id != authority.admission_event_id.to_string()
        || manifest.repository_binding_digest != authority.repository_binding_digest
        || manifest.candidate_id != candidate_id
        || manifest.candidate_ref != candidate_ref
        || manifest.workspace_name != workspace_name
        || manifest.base_commit_sha != authority.base_commit_sha
        || manifest.dispatch_envelope_digest != authority.dispatch_envelope_digest
        || manifest.governed_packet_digest != authority.governed_packet_digest
        || manifest.sandbox_profile_digest != authority.sandbox_profile_digest
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    verify_governed_repository_binding_v1(
        &manifest.repository_root,
        &authority.repository_binding_digest,
    )?;
    let git = governed_git_executable()?;
    let repository = Path::new(&manifest.repository_root);
    if required_git_value(
        &git,
        repository,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )? != authority.base_commit_sha
        || !required_git_value_allow_empty(&git, repository, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
    {
        return Err(CandidateWorkspaceErrorV1::BaseMismatch);
    }
    let workspace_path = PathBuf::from(format!(
        "/proc/{}/fd/{}/{}",
        std::process::id(),
        workspace_root.as_raw_fd(),
        workspace_name
    ));
    if workspace_path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    verify_existing_workspace(&git, &workspace_path, &authority.base_commit_sha)?;
    let canonical_root = PathBuf::from(format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        workspace_root.as_raw_fd()
    ))
    .canonicalize()
    .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    let canonical_workspace = workspace_path
        .canonicalize()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    if canonical_workspace.parent() != Some(canonical_root.as_path()) {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    Ok(OpenedCandidateWorkspaceV1 {
        candidate_id,
        candidate_ref,
        path: canonical_workspace,
        base_commit_sha: authority.base_commit_sha.clone(),
    })
}

fn candidate_identity(
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<(String, String, String), CandidateWorkspaceErrorV1> {
    let digest_hex = authority
        .dispatch_envelope_digest
        .strip_prefix("sha256:")
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or(CandidateWorkspaceErrorV1::ReconciliationRequired)?;
    let candidate_id = format!("c-{digest_hex}");
    let candidate_ref = format!(
        "{CANDIDATE_REF_PREFIX}{candidate_id}/{}/{}",
        authority.run_id, authority.attempt
    );
    let workspace_name = format!("{candidate_id}-{}-{}", authority.run_id, authority.attempt);
    Ok((candidate_id, candidate_ref, workspace_name))
}

fn manifest_name(workspace_name: &str) -> Result<CString, CandidateWorkspaceErrorV1> {
    CString::new(format!("{workspace_name}.json"))
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)
}

fn persist_workspace_manifest(
    directory: &File,
    workspace_name: &str,
    manifest: &CandidateWorkspaceManifestV1,
) -> Result<(), CandidateWorkspaceErrorV1> {
    let expected =
        serde_json::to_vec(manifest).map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    let name = manifest_name(workspace_name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd >= 0 {
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&expected)
            .and_then(|_| file.sync_all())
            .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
        return Ok(());
    }
    if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    if read_workspace_manifest_bytes(directory, &name)? != expected {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    Ok(())
}

fn read_workspace_manifest_bytes(
    directory: &File,
    name: &CString,
) -> Result<Vec<u8>, CandidateWorkspaceErrorV1> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() > 16 * 1024
    {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    Ok(bytes)
}

fn verify_existing_workspace(
    git: &Path,
    workspace: &Path,
    expected_base: &str,
) -> Result<(), CandidateWorkspaceErrorV1> {
    let head = required_git_value(git, workspace, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    if head != expected_base
        || !required_git_value_allow_empty(git, workspace, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    Ok(())
}

fn required_git_value_allow_empty(
    git: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<String, CandidateWorkspaceErrorV1> {
    let output = governed_git_output(git, repository, args)?;
    if !output.status.success() {
        return Err(CandidateWorkspaceErrorV1::Git);
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|_| CandidateWorkspaceErrorV1::Git)
}

fn open_or_create_private_directory_at(
    parent: &File,
    name: &[u8],
) -> Result<File, CandidateWorkspaceErrorV1> {
    let created = unsafe {
        libc::mkdirat(
            parent.as_raw_fd(),
            name.as_ptr().cast::<libc::c_char>(),
            0o700,
        )
    };
    if created != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
        }
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr().cast::<libc::c_char>(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    let directory = unsafe { File::from_raw_fd(fd) };
    let metadata = directory
        .metadata()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candidate_repository::{
        canonical_governed_repository_binding_digest_v1, compute_governed_repository_binding_v1,
    };
    use bp_ledger::{EventId, RunId};
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn git_ok(repository: &Path, args: &[&str]) -> String {
        let git = governed_git_executable().expect("pinned git");
        let output = governed_git_output(&git, repository, args).expect("run git");
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("utf8")
            .trim()
            .to_owned()
    }

    fn fixture() -> (
        TempDir,
        TempDir,
        File,
        ResolvedGovernedV5CandidateAuthorityV1,
    ) {
        let repository = TempDir::new().expect("repository");
        git_ok(repository.path(), &["init", "-b", "main"]);
        git_ok(
            repository.path(),
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
        );
        let base = git_ok(repository.path(), &["rev-parse", "HEAD"]);
        let binding = compute_governed_repository_binding_v1(
            repository.path().to_str().expect("utf8 repository"),
        )
        .expect("binding");
        let binding_digest =
            canonical_governed_repository_binding_digest_v1(&binding).expect("binding digest");
        let custody = TempDir::new().expect("custody");
        fs::set_permissions(custody.path(), fs::Permissions::from_mode(0o700))
            .expect("private custody");
        let root = File::open(custody.path()).expect("open custody");
        let authority = ResolvedGovernedV5CandidateAuthorityV1 {
            run_id: RunId::new(),
            dispatch_event_id: EventId::new(),
            admission_event_id: EventId::new(),
            workflow_id: "workflow".into(),
            unit_id: "unit".into(),
            attempt: 1,
            provenance_ref: "provenance:test".into(),
            base_commit_sha: base,
            repository_binding_digest: binding_digest,
            dispatch_envelope_digest: format!("sha256:{}", "a".repeat(64)),
            governed_packet_digest: format!("sha256:{}", "b".repeat(64)),
            sandbox_profile_digest: format!("sha256:{}", "c".repeat(64)),
        };
        (repository, custody, root, authority)
    }

    #[test]
    fn opening_is_idempotent_and_preserves_target_head_tree_and_commit_count() {
        let (repository, _custody, root, authority) = fixture();
        let head = git_ok(repository.path(), &["rev-parse", "HEAD"]);
        let tree = git_ok(repository.path(), &["rev-parse", "HEAD^{tree}"]);
        let count = git_ok(repository.path(), &["rev-list", "--count", "HEAD"]);

        let opened = open_candidate_workspace_v1(
            &root,
            repository.path().to_str().expect("utf8 repository"),
            &authority,
        )
        .expect("open candidate workspace");
        assert_eq!(git_ok(&opened.path, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git_ok(repository.path(), &["rev-parse", "HEAD"]),
            head,
            "opening must not move target HEAD"
        );
        assert_eq!(
            git_ok(repository.path(), &["rev-parse", "HEAD^{tree}"]),
            tree
        );
        assert_eq!(
            git_ok(repository.path(), &["rev-list", "--count", "HEAD"]),
            count
        );
        assert!(git_ok(repository.path(), &["status", "--porcelain"]).is_empty());
        let candidate_ref_exists = governed_git_output(
            &governed_git_executable().expect("git"),
            repository.path(),
            &["show-ref", "--verify", "--quiet", &opened.candidate_ref],
        )
        .expect("query ref")
        .status
        .success();
        assert!(
            !candidate_ref_exists,
            "opening must not create candidate ref"
        );

        let replay = open_candidate_workspace_v1(
            &root,
            repository.path().to_str().expect("utf8 repository"),
            &authority,
        )
        .expect("reopen candidate workspace");
        assert_eq!(replay, opened);
        assert_eq!(
            reopen_candidate_workspace_v1(&root, &authority)
                .expect("recover workspace from protected manifest"),
            opened
        );
    }

    #[test]
    fn dirty_or_stale_target_creates_no_workspace() {
        let (repository, custody, root, mut authority) = fixture();
        fs::write(repository.path().join("dirty.txt"), "dirty").expect("dirty target");
        assert_eq!(
            open_candidate_workspace_v1(
                &root,
                repository.path().to_str().expect("utf8 repository"),
                &authority,
            ),
            Err(CandidateWorkspaceErrorV1::DirtyTarget)
        );
        assert!(!custody.path().join("candidate-workspaces").exists());

        fs::remove_file(repository.path().join("dirty.txt")).expect("clean target");
        authority.base_commit_sha = "0".repeat(40);
        assert_eq!(
            open_candidate_workspace_v1(
                &root,
                repository.path().to_str().expect("utf8 repository"),
                &authority,
            ),
            Err(CandidateWorkspaceErrorV1::BaseMismatch)
        );
        assert!(!custody.path().join("candidate-workspaces").exists());
    }

    #[test]
    fn precreated_workspace_symlink_is_never_followed() {
        let (repository, custody, root, authority) = fixture();
        let workspace_root = custody.path().join("candidate-workspaces");
        fs::create_dir(&workspace_root).expect("workspace root");
        fs::set_permissions(&workspace_root, fs::Permissions::from_mode(0o700))
            .expect("private workspace root");
        let workspace_name = format!(
            "c-{}-{}-{}",
            "a".repeat(64),
            authority.run_id,
            authority.attempt
        );
        symlink(repository.path(), workspace_root.join(workspace_name))
            .expect("malicious workspace symlink");

        assert_eq!(
            open_candidate_workspace_v1(
                &root,
                repository.path().to_str().expect("utf8 repository"),
                &authority,
            ),
            Err(CandidateWorkspaceErrorV1::WorkspaceCustody)
        );
        assert!(git_ok(repository.path(), &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn substituted_recovery_manifest_fails_closed() {
        let (repository, custody, root, authority) = fixture();
        open_candidate_workspace_v1(
            &root,
            repository.path().to_str().expect("utf8 repository"),
            &authority,
        )
        .expect("open candidate");
        let (_, _, workspace_name) = candidate_identity(&authority).expect("identity");
        let manifest = custody
            .path()
            .join("candidate-workspaces")
            .join(format!("{workspace_name}.json"));
        fs::write(&manifest, b"{}").expect("substitute manifest");
        fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600))
            .expect("retain private mode");
        assert_eq!(
            reopen_candidate_workspace_v1(&root, &authority),
            Err(CandidateWorkspaceErrorV1::ReconciliationRequired)
        );
        assert!(git_ok(repository.path(), &["status", "--porcelain"]).is_empty());
    }
}
