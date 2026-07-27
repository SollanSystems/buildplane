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
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};
use thiserror::Error;

const WORKSPACE_DIRECTORY: &[u8] = b"candidate-workspaces\0";
const VERIFICATION_WORKSPACE_DIRECTORY: &[u8] = b"candidate-verification-workspaces\0";
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImmutableCandidateArtifactV1 {
    pub(crate) candidate_id: String,
    pub(crate) candidate_ref: String,
    pub(crate) base_commit_sha: String,
    pub(crate) candidate_commit_sha: String,
    pub(crate) commit_digest: String,
    pub(crate) tree_digest: String,
    pub(crate) patch_digest: String,
    pub(crate) changed_files_digest: String,
    pub(crate) candidate_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenedCandidateVerificationWorkspaceV1 {
    pub(crate) path: PathBuf,
    pub(crate) candidate_commit_sha: String,
    pub(crate) candidate_digest: String,
}

pub(crate) fn immutable_candidate_artifact_v1_bytes(
    artifact: &ImmutableCandidateArtifactV1,
) -> Result<Vec<u8>, CandidateWorkspaceErrorV1> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        schema_version: u8,
        candidate_id: &'a str,
        candidate_ref: &'a str,
        base_commit_sha: &'a str,
        candidate_commit_sha: &'a str,
        commit_digest: &'a str,
        tree_digest: &'a str,
        patch_digest: &'a str,
        changed_files_digest: &'a str,
        candidate_digest: &'a str,
    }
    serde_json::to_vec(&Evidence {
        schema_version: 1,
        candidate_id: &artifact.candidate_id,
        candidate_ref: &artifact.candidate_ref,
        base_commit_sha: &artifact.base_commit_sha,
        candidate_commit_sha: &artifact.candidate_commit_sha,
        commit_digest: &artifact.commit_digest,
        tree_digest: &artifact.tree_digest,
        patch_digest: &artifact.patch_digest,
        changed_files_digest: &artifact.changed_files_digest,
        candidate_digest: &artifact.candidate_digest,
    })
    .map_err(|_| CandidateWorkspaceErrorV1::ReconciliationRequired)
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

/// Materialize one deterministic commit and create-only candidate ref while
/// preserving the checked-out target branch exactly. Git object writes occur
/// before the ref CAS, so a crash can be retried to the same commit identity;
/// the detached workspace HEAD and target HEAD never move.
pub(crate) fn finalize_candidate_workspace_v1(
    authority_root: &File,
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<ImmutableCandidateArtifactV1, CandidateWorkspaceErrorV1> {
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
    let root_head = required_git_value(
        &git,
        repository,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?;
    let root_tree = required_git_value(&git, repository, &["rev-parse", "HEAD^{tree}"])?;
    let root_count = required_git_value(&git, repository, &["rev-list", "--count", "HEAD"])?;
    if root_head != authority.base_commit_sha
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
    let canonical_workspace = workspace_path
        .canonicalize()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    let canonical_workspace_root = PathBuf::from(format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        workspace_root.as_raw_fd()
    ))
    .canonicalize()
    .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    if canonical_workspace.parent() != Some(canonical_workspace_root.as_path())
        || required_git_value(
            &git,
            &canonical_workspace,
            &["rev-parse", "--verify", "HEAD^{commit}"],
        )? != authority.base_commit_sha
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    verify_candidate_worktree_topology(&git, repository, &canonical_workspace)?;

    let existing_ref =
        governed_git_output(&git, repository, &["rev-parse", "--verify", &candidate_ref])?;
    let candidate_commit_sha = if existing_ref.status.success() {
        let existing = decoded_git_value(existing_ref)?;
        derive_candidate_artifact(
            &git,
            repository,
            authority,
            &candidate_id,
            &candidate_ref,
            &existing,
        )?
        .candidate_commit_sha
    } else if existing_ref.status.code() == Some(128) {
        let staged = governed_git_output(
            &git,
            &canonical_workspace,
            &["add", "--all", "--", ".", ":!.buildplane"],
        )?;
        if !staged.status.success() {
            return Err(CandidateWorkspaceErrorV1::Git);
        }
        let tree = required_git_value(&git, &canonical_workspace, &["write-tree"])?;
        let candidate_key = format!("{candidate_id}/{}/{}", authority.run_id, authority.attempt);
        let message = format!("feat: buildplane candidate {candidate_key}");
        let commit = required_git_value(
            &git,
            &canonical_workspace,
            &[
                "commit-tree",
                &tree,
                "-p",
                &authority.base_commit_sha,
                "-m",
                &message,
            ],
        )?;
        let empty = "0".repeat(authority.base_commit_sha.len());
        let create_ref = governed_git_output(
            &git,
            repository,
            &["update-ref", &candidate_ref, &commit, &empty],
        )?;
        if create_ref.status.success() {
            commit
        } else {
            let concurrent =
                required_git_value(&git, repository, &["rev-parse", "--verify", &candidate_ref])?;
            if concurrent != commit {
                return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
            }
            concurrent
        }
    } else {
        return Err(CandidateWorkspaceErrorV1::Git);
    };
    let artifact = derive_candidate_artifact(
        &git,
        repository,
        authority,
        &candidate_id,
        &candidate_ref,
        &candidate_commit_sha,
    )?;
    if required_git_value(
        &git,
        repository,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )? != root_head
        || required_git_value(&git, repository, &["rev-parse", "HEAD^{tree}"])? != root_tree
        || required_git_value(&git, repository, &["rev-list", "--count", "HEAD"])? != root_count
        || !required_git_value_allow_empty(&git, repository, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
        || required_git_value(
            &git,
            &canonical_workspace,
            &["rev-parse", "--verify", "HEAD^{commit}"],
        )? != authority.base_commit_sha
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    Ok(artifact)
}

/// Open a separate clean detached worktree at the exact immutable candidate
/// commit. The returned path is intended only for a read-only OCI bind mount;
/// it never reuses the mutable implementer overlay and never moves the target
/// checkout or candidate ref.
pub(crate) fn open_candidate_verification_workspace_v1(
    authority_root: &File,
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
    artifact: &ImmutableCandidateArtifactV1,
) -> Result<OpenedCandidateVerificationWorkspaceV1, CandidateWorkspaceErrorV1> {
    let verified_artifact = finalize_candidate_workspace_v1(authority_root, authority)?;
    if &verified_artifact != artifact {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    let (_, _, workspace_name) = candidate_identity(authority)?;
    let candidate_workspace_root =
        open_or_create_private_directory_at(authority_root, WORKSPACE_DIRECTORY)?;
    let manifest_bytes =
        read_workspace_manifest_bytes(&candidate_workspace_root, &manifest_name(&workspace_name)?)?;
    let manifest: CandidateWorkspaceManifestV1 = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| CandidateWorkspaceErrorV1::ReconciliationRequired)?;
    if manifest.repository_binding_digest != authority.repository_binding_digest
        || manifest.candidate_ref != artifact.candidate_ref
        || manifest.base_commit_sha != artifact.base_commit_sha
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    verify_governed_repository_binding_v1(
        &manifest.repository_root,
        &authority.repository_binding_digest,
    )?;
    let git = governed_git_executable()?;
    let repository = Path::new(&manifest.repository_root);
    let root_head = required_git_value(
        &git,
        repository,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )?;
    let root_tree = required_git_value(&git, repository, &["rev-parse", "HEAD^{tree}"])?;
    let root_count = required_git_value(&git, repository, &["rev-list", "--count", "HEAD"])?;
    if root_head != artifact.base_commit_sha
        || !required_git_value_allow_empty(&git, repository, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
        || required_git_value(
            &git,
            repository,
            &["rev-parse", "--verify", &artifact.candidate_ref],
        )? != artifact.candidate_commit_sha
    {
        return Err(CandidateWorkspaceErrorV1::BaseMismatch);
    }

    let verification_root =
        open_or_create_private_directory_at(authority_root, VERIFICATION_WORKSPACE_DIRECTORY)?;
    let canonical_root = PathBuf::from(format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        verification_root.as_raw_fd()
    ))
    .canonicalize()
    .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    let verification_name = format!("verify-{workspace_name}");
    let verification_path = PathBuf::from(format!(
        "/proc/{}/fd/{}/{}",
        std::process::id(),
        verification_root.as_raw_fd(),
        verification_name
    ));
    if verification_path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CandidateWorkspaceErrorV1::WorkspaceCustody);
    }
    if verification_path.exists() {
        verify_existing_workspace(&git, &verification_path, &artifact.candidate_commit_sha)?;
    } else {
        let output = governed_git_output(
            &git,
            repository,
            &[
                "worktree",
                "add",
                "--detach",
                verification_path
                    .to_str()
                    .ok_or(CandidateWorkspaceErrorV1::WorkspaceCustody)?,
                &artifact.candidate_commit_sha,
            ],
        )?;
        if !output.status.success() {
            if verification_path.exists() {
                verify_existing_workspace(
                    &git,
                    &verification_path,
                    &artifact.candidate_commit_sha,
                )?;
            } else {
                return Err(CandidateWorkspaceErrorV1::Git);
            }
        }
    }
    verify_existing_workspace(&git, &verification_path, &artifact.candidate_commit_sha)?;
    verify_candidate_worktree_topology(&git, repository, &verification_path)?;
    let canonical_workspace = verification_path
        .canonicalize()
        .map_err(|_| CandidateWorkspaceErrorV1::WorkspaceCustody)?;
    if canonical_workspace.parent() != Some(canonical_root.as_path())
        || required_git_value(
            &git,
            repository,
            &["rev-parse", "--verify", "HEAD^{commit}"],
        )? != root_head
        || required_git_value(&git, repository, &["rev-parse", "HEAD^{tree}"])? != root_tree
        || required_git_value(&git, repository, &["rev-list", "--count", "HEAD"])? != root_count
        || !required_git_value_allow_empty(&git, repository, &["status", "--porcelain=v1", "-z"])?
            .is_empty()
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    Ok(OpenedCandidateVerificationWorkspaceV1 {
        path: canonical_workspace,
        candidate_commit_sha: artifact.candidate_commit_sha.clone(),
        candidate_digest: artifact.candidate_digest.clone(),
    })
}

fn verify_candidate_worktree_topology(
    git: &Path,
    repository: &Path,
    workspace: &Path,
) -> Result<(), CandidateWorkspaceErrorV1> {
    let root_common = required_git_value(git, repository, &["rev-parse", "--git-common-dir"])?;
    let root_common = canonical_git_path(repository, &root_common)?;
    let workspace_common = required_git_value(git, workspace, &["rev-parse", "--git-common-dir"])?;
    let workspace_common = canonical_git_path(workspace, &workspace_common)?;
    let workspace_git_dir = required_git_value(git, workspace, &["rev-parse", "--git-dir"])?;
    let workspace_git_dir = canonical_git_path(workspace, &workspace_git_dir)?;
    let detached = governed_git_output(git, workspace, &["symbolic-ref", "-q", "HEAD"])?;
    if root_common != workspace_common
        || !workspace_git_dir.starts_with(root_common.join("worktrees"))
        || detached.status.code() != Some(1)
    {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    Ok(())
}

fn canonical_git_path(
    repository: &Path,
    value: &str,
) -> Result<PathBuf, CandidateWorkspaceErrorV1> {
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        repository.join(path)
    };
    path.canonicalize()
        .map_err(|_| CandidateWorkspaceErrorV1::ReconciliationRequired)
}

fn decoded_git_value(output: std::process::Output) -> Result<String, CandidateWorkspaceErrorV1> {
    let value = String::from_utf8(output.stdout).map_err(|_| CandidateWorkspaceErrorV1::Git)?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(CandidateWorkspaceErrorV1::Git);
    }
    Ok(value)
}

fn required_git_bytes(
    git: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<Vec<u8>, CandidateWorkspaceErrorV1> {
    let output = governed_git_output(git, repository, args)?;
    if !output.status.success() {
        return Err(CandidateWorkspaceErrorV1::Git);
    }
    Ok(output.stdout)
}

fn derive_candidate_artifact(
    git: &Path,
    repository: &Path,
    authority: &ResolvedGovernedV5CandidateAuthorityV1,
    candidate_id: &str,
    candidate_ref: &str,
    candidate_commit_sha: &str,
) -> Result<ImmutableCandidateArtifactV1, CandidateWorkspaceErrorV1> {
    let ref_commit =
        required_git_value(git, repository, &["rev-parse", "--verify", candidate_ref])?;
    let parent = required_git_value(
        git,
        repository,
        &["rev-parse", "--verify", &format!("{candidate_commit_sha}^")],
    )?;
    if ref_commit != candidate_commit_sha || parent != authority.base_commit_sha {
        return Err(CandidateWorkspaceErrorV1::ReconciliationRequired);
    }
    let commit_digest = sha256_hex(&required_git_bytes(
        git,
        repository,
        &["cat-file", "commit", candidate_commit_sha],
    )?);
    let tree_digest = sha256_hex(&required_git_bytes(
        git,
        repository,
        &["ls-tree", "-r", "--full-tree", "-z", candidate_commit_sha],
    )?);
    let patch_digest = sha256_hex(&required_git_bytes(
        git,
        repository,
        &[
            "-c",
            "core.quotePath=false",
            "-c",
            "diff.algorithm=myers",
            "-c",
            "diff.mnemonicPrefix=false",
            "-c",
            "diff.noprefix=false",
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            "--no-indent-heuristic",
            "--unified=3",
            &authority.base_commit_sha,
            candidate_commit_sha,
        ],
    )?);
    let changed_files_digest = sha256_hex(&required_git_bytes(
        git,
        repository,
        &[
            "-c",
            "core.quotePath=false",
            "-c",
            "diff.algorithm=myers",
            "-c",
            "diff.mnemonicPrefix=false",
            "-c",
            "diff.noprefix=false",
            "diff",
            "--name-only",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            &authority.base_commit_sha,
            candidate_commit_sha,
        ],
    )?);
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CandidateDigestMaterial<'a> {
        schema_version: u8,
        candidate_id: &'a str,
        run_id: String,
        attempt: u32,
        candidate_ref: &'a str,
        base_sha: &'a str,
        candidate_commit_sha: &'a str,
        commit_digest: &'a str,
        tree_digest: &'a str,
        patch_digest: &'a str,
        changed_files_digest: &'a str,
    }
    let material = CandidateDigestMaterial {
        schema_version: 1,
        candidate_id,
        run_id: authority.run_id.to_string(),
        attempt: authority.attempt,
        candidate_ref,
        base_sha: &authority.base_commit_sha,
        candidate_commit_sha,
        commit_digest: &commit_digest,
        tree_digest: &tree_digest,
        patch_digest: &patch_digest,
        changed_files_digest: &changed_files_digest,
    };
    let candidate_digest = serde_json::to_vec(&material)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|_| CandidateWorkspaceErrorV1::ReconciliationRequired)?;
    Ok(ImmutableCandidateArtifactV1 {
        candidate_id: candidate_id.into(),
        candidate_ref: candidate_ref.into(),
        base_commit_sha: authority.base_commit_sha.clone(),
        candidate_commit_sha: candidate_commit_sha.into(),
        commit_digest: format!("sha256:{commit_digest}"),
        tree_digest: format!("sha256:{tree_digest}"),
        patch_digest: format!("sha256:{patch_digest}"),
        changed_files_digest: format!("sha256:{changed_files_digest}"),
        candidate_digest: format!("sha256:{candidate_digest}"),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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

    #[test]
    fn finalization_is_idempotent_and_never_mutates_the_target_branch() {
        let (repository, _custody, root, authority) = fixture();
        let opened = open_candidate_workspace_v1(
            &root,
            repository.path().to_str().expect("utf8 repository"),
            &authority,
        )
        .expect("open candidate");
        fs::write(opened.path.join("candidate.txt"), "candidate\n").expect("candidate change");
        fs::create_dir(opened.path.join(".buildplane")).expect("worker state directory");
        fs::write(
            opened.path.join(".buildplane").join("worker-state.json"),
            "{}",
        )
        .expect("worker state");

        let root_head = git_ok(repository.path(), &["rev-parse", "HEAD"]);
        let root_tree = git_ok(repository.path(), &["rev-parse", "HEAD^{tree}"]);
        let root_count = git_ok(repository.path(), &["rev-list", "--count", "HEAD"]);
        let artifact =
            finalize_candidate_workspace_v1(&root, &authority).expect("finalize candidate");

        assert_eq!(artifact.candidate_id, opened.candidate_id);
        assert_eq!(artifact.candidate_ref, opened.candidate_ref);
        assert_eq!(artifact.base_commit_sha, root_head);
        assert_eq!(
            git_ok(
                repository.path(),
                &["rev-parse", "--verify", &opened.candidate_ref]
            ),
            artifact.candidate_commit_sha
        );
        assert_eq!(
            git_ok(
                repository.path(),
                &["rev-parse", &format!("{}^", artifact.candidate_commit_sha)]
            ),
            root_head
        );
        assert_eq!(
            git_ok(
                repository.path(),
                &[
                    "show",
                    "--format=",
                    "--name-only",
                    &artifact.candidate_commit_sha
                ]
            ),
            "candidate.txt",
            "private worker state must not enter the candidate"
        );
        assert_eq!(git_ok(repository.path(), &["rev-parse", "HEAD"]), root_head);
        assert_eq!(
            git_ok(repository.path(), &["rev-parse", "HEAD^{tree}"]),
            root_tree
        );
        assert_eq!(
            git_ok(repository.path(), &["rev-list", "--count", "HEAD"]),
            root_count
        );
        assert!(git_ok(repository.path(), &["status", "--porcelain"]).is_empty());
        assert_eq!(
            git_ok(&opened.path, &["rev-parse", "HEAD"]),
            root_head,
            "candidate workspace must remain detached at the base"
        );
        for digest in [
            &artifact.commit_digest,
            &artifact.tree_digest,
            &artifact.patch_digest,
            &artifact.changed_files_digest,
            &artifact.candidate_digest,
        ] {
            assert!(
                digest
                    .strip_prefix("sha256:")
                    .is_some_and(|hex| hex.len() == 64
                        && hex
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))),
                "digest is not canonical: {digest}"
            );
        }

        let replay =
            finalize_candidate_workspace_v1(&root, &authority).expect("replay finalization");
        assert_eq!(replay, artifact);
        let verification = open_candidate_verification_workspace_v1(&root, &authority, &artifact)
            .expect("open immutable candidate verification workspace");
        assert_eq!(
            git_ok(&verification.path, &["rev-parse", "HEAD"]),
            artifact.candidate_commit_sha
        );
        assert!(
            git_ok(&verification.path, &["status", "--porcelain"]).is_empty(),
            "verification workspace must begin clean at the candidate commit"
        );
        assert_eq!(verification.candidate_digest, artifact.candidate_digest);
        assert_eq!(
            open_candidate_verification_workspace_v1(&root, &authority, &artifact)
                .expect("reopen verification workspace"),
            verification
        );
        assert_eq!(git_ok(repository.path(), &["rev-parse", "HEAD"]), root_head);
        assert_eq!(
            git_ok(repository.path(), &["rev-list", "--count", "HEAD"]),
            root_count
        );
        assert!(git_ok(repository.path(), &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn stale_or_dirty_target_prevents_finalization_and_candidate_ref_creation() {
        let (repository, _custody, root, authority) = fixture();
        let opened = open_candidate_workspace_v1(
            &root,
            repository.path().to_str().expect("utf8 repository"),
            &authority,
        )
        .expect("open candidate");
        fs::write(opened.path.join("candidate.txt"), "candidate\n").expect("candidate change");
        fs::write(repository.path().join("dirty.txt"), "dirty\n").expect("dirty target");

        assert_eq!(
            finalize_candidate_workspace_v1(&root, &authority),
            Err(CandidateWorkspaceErrorV1::BaseMismatch)
        );
        assert!(
            !governed_git_output(
                &governed_git_executable().expect("git"),
                repository.path(),
                &["show-ref", "--verify", "--quiet", &opened.candidate_ref],
            )
            .expect("query ref")
            .status
            .success(),
            "failed finalization must not publish a candidate ref"
        );
    }
}
