//! Broker-private, startup-bound Git promotion foundation.
//!
//! This module is deliberately an internal component, not a public API or a
//! production broker integration. A future OS-authenticated authority host
//! must construct [`VerifiedPromotionCapability`] only from a verified replay
//! and sealed decision, then persist the resulting ledger record through its
//! protected authority realm. Nothing here establishes that replay, sealing,
//! signing, or broker identity.
//!
//! The narrow boundary is intentional: callers cannot supply a Git executable,
//! command, arguments, repository path, target ref, or callback. The only
//! mutable effect is a single fixed `commit-tree` followed by an atomic
//! `update-ref --stdin` transaction that creates a candidate-keyed receipt.

use bp_ledger::canonicalize::{
    is_canonical_buildplane_candidate_ref, BUILDPANE_CANDIDATE_REF_PREFIX,
};
use bp_ledger::payload::trust_spine::{
    PromotionGitBindingV1, PromotionResultOutcomeV1, PromotionWorktreeSyncStateV1,
};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use thiserror::Error;

const FIXED_GIT_BINARY: &str = "/usr/bin/git";
const PROMOTION_RECEIPT_REF_PREFIX: &str = "refs/buildplane/promotions/";
const SHA256_PREFIX: &str = "sha256:";

/// Structural validation errors for a capability that was supposed to have
/// been derived from protected replay. These errors never invoke Git.
#[derive(Debug, Error, PartialEq, Eq)]
pub(super) enum PromotionCapabilityError {
    #[error("verified promotion capability has a malformed candidate digest")]
    MalformedCandidateDigest,
    #[error("verified promotion capability has a malformed candidate ref")]
    MalformedCandidateRef,
    #[error("verified promotion capability has a malformed candidate commit")]
    MalformedCandidateCommit,
    #[error("verified promotion capability has a malformed candidate tree digest")]
    MalformedCandidateTreeDigest,
    #[error("verified promotion capability has a malformed base commit")]
    MalformedBaseCommit,
    #[error("verified promotion capability has a malformed target ref")]
    MalformedTargetRef,
    #[error("verified promotion capability has a malformed idempotency key")]
    MalformedIdempotencyKey,
}

/// Startup failures for the broker-private Git component.
#[derive(Debug, Error, PartialEq, Eq)]
pub(super) enum PromotionGitStartupError {
    #[error("governed promotion Git requires Linux")]
    UnsupportedPlatform,
    #[error("governed promotion Git requires a canonical repository-root directory")]
    InvalidRepositoryRoot,
    #[error("governed promotion Git requires the fixed /usr/bin/git executable")]
    FixedGitUnavailable,
}

/// Every runtime failure is fail-closed. The caller must reopen its protected
/// replay/reconciliation path; it must not retry by creating another Git
/// effect from the same in-process state.
#[derive(Debug, Error, PartialEq, Eq)]
pub(super) enum PromotionGitError {
    #[error("governed promotion Git requires root-pending reconciliation")]
    ReconciliationRequired,
}

/// A non-cloneable capability containing facts already verified outside this
/// module. It deliberately has no deserialization, no public fields, and no
/// constructor that accepts arbitrary Git commands or paths.
///
/// The capability carries only facts available from the signed replayed
/// candidate. Its raw Git tree object ID is deliberately *not* supplied by a
/// caller: the fixed gateway derives it from the verified candidate commit
/// before it can create a merge. `candidate_tree_digest` remains the semantic
/// SHA-256 digest of the candidate's canonical `ls-tree` output.
#[derive(Debug)]
pub(super) struct VerifiedPromotionCapability {
    candidate_digest: String,
    candidate_ref: String,
    candidate_commit: String,
    candidate_tree_digest: String,
    base_commit: String,
    target_ref: String,
    idempotency_key: String,
}

impl VerifiedPromotionCapability {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn from_verified_facts(
        candidate_digest: String,
        candidate_ref: String,
        candidate_commit: String,
        candidate_tree_digest: String,
        base_commit: String,
        target_ref: String,
        idempotency_key: String,
    ) -> Result<Self, PromotionCapabilityError> {
        if !is_canonical_sha256_digest(&candidate_digest) {
            return Err(PromotionCapabilityError::MalformedCandidateDigest);
        }
        if !is_canonical_buildplane_candidate_ref(&candidate_ref) {
            return Err(PromotionCapabilityError::MalformedCandidateRef);
        }
        if !is_canonical_git_object_id(&candidate_commit) {
            return Err(PromotionCapabilityError::MalformedCandidateCommit);
        }
        if !is_canonical_sha256_digest(&candidate_tree_digest) {
            return Err(PromotionCapabilityError::MalformedCandidateTreeDigest);
        }
        if !is_canonical_git_object_id(&base_commit) {
            return Err(PromotionCapabilityError::MalformedBaseCommit);
        }
        if !is_canonical_target_ref(&target_ref) {
            return Err(PromotionCapabilityError::MalformedTargetRef);
        }
        if !is_canonical_idempotency_key(&idempotency_key) {
            return Err(PromotionCapabilityError::MalformedIdempotencyKey);
        }

        Ok(Self {
            candidate_digest,
            candidate_ref,
            candidate_commit,
            candidate_tree_digest,
            base_commit,
            target_ref,
            idempotency_key,
        })
    }

    fn receipt_ref(&self) -> String {
        // Structural validation in `from_verified_facts` proves this split is
        // safe. Keeping the receipt name tied to the candidate-ref suffix
        // matches the ledger's exact target-bound result validation.
        let suffix = self
            .candidate_ref
            .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
            .expect("validated candidate ref has the Buildplane prefix");
        format!("{PROMOTION_RECEIPT_REF_PREFIX}{suffix}")
    }

    fn receipt_message(&self, candidate_tree: &str) -> String {
        format!(
            "buildplane governed promotion receipt v1\n\
candidate_digest: {}\n\
candidate_ref: {}\n\
candidate_commit: {}\n\
candidate_tree: {}\n\
candidate_tree_digest: {}\n\
base_commit: {}\n\
target_ref: {}\n\
idempotency_key: {}",
            self.candidate_digest,
            self.candidate_ref,
            self.candidate_commit,
            candidate_tree,
            self.candidate_tree_digest,
            self.base_commit,
            self.target_ref,
            self.idempotency_key,
        )
    }
}

/// The only caller-visible successful observations. Both forms map to a
/// ledger `ReconciliationRequired` result: governed promotion never resets or
/// checks out the root after moving the target ref.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PromotionGitOutcome {
    /// The target still points exactly at the immutable merge, while the root
    /// checkout remains deliberately untouched.
    RootPendingReconciliation { binding: PromotionGitBindingV1 },
    /// A verified receipt proves the CAS happened, but the target no longer
    /// points exactly at that merge and needs explicit operator reconciliation.
    TargetAdvanced { binding: PromotionGitBindingV1 },
}

impl PromotionGitOutcome {
    /// Existing protected ledger validation requires all newly target-bound
    /// outcomes to be recorded as reconciliation-required.
    pub(super) fn ledger_outcome(&self) -> PromotionResultOutcomeV1 {
        PromotionResultOutcomeV1::ReconciliationRequired
    }

    pub(super) fn binding(&self) -> &PromotionGitBindingV1 {
        match self {
            Self::RootPendingReconciliation { binding } | Self::TargetAdvanced { binding } => {
                binding
            }
        }
    }
}

/// Startup-bound broker-private gateway. The repository root is canonicalized
/// once and never accepts a per-promotion path. This type has no `Clone` or
/// `Copy` implementation, so a test or caller cannot duplicate an in-flight
/// gateway capability by accident.
pub(super) struct PromotionGitGateway {
    repository_root: PathBuf,
    #[cfg(test)]
    test_runner: Option<Box<dyn TestFixedGitRunner>>,
}

impl PromotionGitGateway {
    /// Build only from the broker's startup repository root.
    ///
    /// This checks the platform before accepting a root, uses a canonical path
    /// thereafter, and refuses any executable except `/usr/bin/git`. It is not
    /// wired to trusted replay or a production broker process yet.
    pub(super) fn from_startup_repository_root(
        repository_root: &Path,
    ) -> Result<Self, PromotionGitStartupError> {
        if !cfg!(target_os = "linux") {
            return Err(PromotionGitStartupError::UnsupportedPlatform);
        }
        let repository_root = fs::canonicalize(repository_root)
            .map_err(|_| PromotionGitStartupError::InvalidRepositoryRoot)?;
        if !repository_root.is_dir() {
            return Err(PromotionGitStartupError::InvalidRepositoryRoot);
        }
        if !Path::new(FIXED_GIT_BINARY).is_file() {
            return Err(PromotionGitStartupError::FixedGitUnavailable);
        }
        Ok(Self {
            repository_root,
            #[cfg(test)]
            test_runner: None,
        })
    }

    /// Test-only closed-operation injection for platforms that cannot execute
    /// the Linux-only production boundary. It is compiled out of non-test
    /// builds and cannot become a caller-provided Git callback in production.
    #[cfg(test)]
    pub(super) fn with_test_runner(
        canonical_repository_root: &str,
        runner: Box<dyn TestFixedGitRunner>,
    ) -> Result<Self, PromotionGitStartupError> {
        if !is_test_canonical_root(canonical_repository_root) {
            return Err(PromotionGitStartupError::InvalidRepositoryRoot);
        }
        Ok(Self {
            repository_root: PathBuf::from(canonical_repository_root),
            test_runner: Some(runner),
        })
    }

    /// Consume one exact verified capability. A retry must obtain a fresh
    /// verified capability from protected replay; it cannot reuse or clone the
    /// old token. If a candidate-keyed receipt already exists, it is inspected
    /// and reused before any `commit-tree` or compare-and-swap is attempted.
    pub(super) fn promote(
        &mut self,
        capability: VerifiedPromotionCapability,
    ) -> Result<PromotionGitOutcome, PromotionGitError> {
        let candidate = self.verify_candidate(&capability)?;

        if let Some(receipt) = self.inspect_receipt(&capability, &candidate)? {
            return self.observe_receipt(&capability, receipt);
        }

        let target_head = self.resolve_target(&capability.target_ref)?;
        if target_head != capability.base_commit {
            return Err(PromotionGitError::ReconciliationRequired);
        }

        let merge_commit = self.create_merge_commit(&capability, &candidate)?;
        let receipt = self.verify_merge_commit(&capability, &candidate, &merge_commit)?;
        let advance = self.invoke(FixedGitOperation::AtomicAdvance {
            target_ref: capability.target_ref.clone(),
            expected_base: capability.base_commit.clone(),
            merge_commit: receipt.merge_commit.clone(),
            receipt_ref: capability.receipt_ref(),
        })?;

        if advance.status != 0 {
            // A process may have died after Git committed the ref transaction
            // but before its caller observed success. Receipt inspection is
            // the only retry action; never issue another CAS here.
            if let Some(existing) = self.inspect_receipt(&capability, &candidate)? {
                return self.observe_receipt(&capability, existing);
            }
            return Err(PromotionGitError::ReconciliationRequired);
        }

        let Some(existing) = self.inspect_receipt(&capability, &candidate)? else {
            // The target and receipt are one Git transaction. Treat a missing
            // receipt after a claimed success as ambiguous rather than trying
            // to repair it locally.
            return Err(PromotionGitError::ReconciliationRequired);
        };
        self.observe_receipt(&capability, existing)
    }

    fn verify_candidate(
        &mut self,
        capability: &VerifiedPromotionCapability,
    ) -> Result<VerifiedCandidateGitFacts, PromotionGitError> {
        let resolved = self.resolve_candidate_ref(&capability.candidate_ref)?;
        if resolved != capability.candidate_commit {
            return Err(PromotionGitError::ReconciliationRequired);
        }
        let candidate = self.read_commit(&capability.candidate_commit)?;
        if !has_exact_parents(&candidate.parents, &[capability.base_commit.as_str()]) {
            return Err(PromotionGitError::ReconciliationRequired);
        }
        if self.tree_digest(&capability.candidate_commit)? != capability.candidate_tree_digest {
            return Err(PromotionGitError::ReconciliationRequired);
        }
        Ok(VerifiedCandidateGitFacts {
            tree: candidate.tree,
        })
    }

    fn inspect_receipt(
        &mut self,
        capability: &VerifiedPromotionCapability,
        candidate: &VerifiedCandidateGitFacts,
    ) -> Result<Option<PromotionReceipt>, PromotionGitError> {
        let output = self.invoke(FixedGitOperation::InspectReceipt {
            receipt_ref: capability.receipt_ref(),
        })?;
        match output.status {
            0 => {
                let commit = parse_single_object_id(&output.stdout)
                    .ok_or(PromotionGitError::ReconciliationRequired)?;
                self.verify_merge_commit(capability, candidate, &commit)
                    .map(Some)
            }
            1 => Ok(None),
            _ => Err(PromotionGitError::ReconciliationRequired),
        }
    }

    fn create_merge_commit(
        &mut self,
        capability: &VerifiedPromotionCapability,
        candidate: &VerifiedCandidateGitFacts,
    ) -> Result<String, PromotionGitError> {
        let output = self.require_success(FixedGitOperation::CreateMergeCommit {
            tree: candidate.tree.clone(),
            base: capability.base_commit.clone(),
            candidate: capability.candidate_commit.clone(),
            receipt_message: capability.receipt_message(&candidate.tree),
        })?;
        parse_single_object_id(&output).ok_or(PromotionGitError::ReconciliationRequired)
    }

    fn verify_merge_commit(
        &mut self,
        capability: &VerifiedPromotionCapability,
        candidate: &VerifiedCandidateGitFacts,
        merge_commit: &str,
    ) -> Result<PromotionReceipt, PromotionGitError> {
        let merge = self.read_commit(merge_commit)?;
        if merge.tree != candidate.tree
            || !has_exact_parents(
                &merge.parents,
                &[
                    capability.base_commit.as_str(),
                    capability.candidate_commit.as_str(),
                ],
            )
            || !matches_receipt_message(
                &merge.message,
                &capability.receipt_message(&candidate.tree),
            )
            || self.tree_digest(merge_commit)? != capability.candidate_tree_digest
        {
            return Err(PromotionGitError::ReconciliationRequired);
        }
        Ok(PromotionReceipt {
            merge_commit: merge_commit.to_owned(),
            merge_tree: merge.tree,
        })
    }

    fn observe_receipt(
        &mut self,
        capability: &VerifiedPromotionCapability,
        receipt: PromotionReceipt,
    ) -> Result<PromotionGitOutcome, PromotionGitError> {
        let target_head_after = self.resolve_target(&capability.target_ref)?;
        let sync_state = if target_head_after == receipt.merge_commit {
            // No reset or checkout occurs in this component. The authority
            // writer requires this exact root-stale state for new target-bound
            // promotion results.
            PromotionWorktreeSyncStateV1::RootCheckoutStale
        } else {
            // A descendant still contains the merge, but it is no longer the
            // exact post-CAS target head. Observe reachability for the receipt
            // audit and classify either a descendant or a divergent head as
            // target-advanced so the strict ledger binding remains truthful.
            let _target_contains_merge =
                self.is_ancestor(&receipt.merge_commit, &target_head_after)?;
            PromotionWorktreeSyncStateV1::TargetAdvanced
        };
        let binding = PromotionGitBindingV1 {
            target_ref: capability.target_ref.clone(),
            target_head_before_sha: capability.base_commit.clone(),
            target_head_after_sha: Some(target_head_after),
            merged_head_sha: Some(receipt.merge_commit),
            candidate_commit_sha: capability.candidate_commit.clone(),
            merge_parent_shas: Some(vec![
                capability.base_commit.clone(),
                capability.candidate_commit.clone(),
            ]),
            merged_tree_sha: Some(receipt.merge_tree),
            merged_tree_digest: capability.candidate_tree_digest.clone(),
            promotion_receipt_ref: Some(capability.receipt_ref()),
            worktree_sync_state: Some(sync_state),
        };
        Ok(match sync_state {
            PromotionWorktreeSyncStateV1::RootCheckoutStale => {
                PromotionGitOutcome::RootPendingReconciliation { binding }
            }
            PromotionWorktreeSyncStateV1::TargetAdvanced => {
                PromotionGitOutcome::TargetAdvanced { binding }
            }
            PromotionWorktreeSyncStateV1::PendingReconciliation => {
                return Err(PromotionGitError::ReconciliationRequired)
            }
        })
    }

    fn resolve_candidate_ref(&mut self, candidate_ref: &str) -> Result<String, PromotionGitError> {
        let output = self.require_success(FixedGitOperation::ResolveCandidateRef {
            candidate_ref: candidate_ref.to_owned(),
        })?;
        parse_single_object_id(&output).ok_or(PromotionGitError::ReconciliationRequired)
    }

    fn resolve_target(&mut self, target_ref: &str) -> Result<String, PromotionGitError> {
        let output = self.require_success(FixedGitOperation::ResolveTarget {
            target_ref: target_ref.to_owned(),
        })?;
        parse_single_object_id(&output).ok_or(PromotionGitError::ReconciliationRequired)
    }

    fn read_commit(&mut self, commit: &str) -> Result<ParsedCommit, PromotionGitError> {
        let output = self.require_success(FixedGitOperation::ReadCommit {
            commit: commit.to_owned(),
        })?;
        parse_commit_object(&output).ok_or(PromotionGitError::ReconciliationRequired)
    }

    fn tree_digest(&mut self, commit: &str) -> Result<String, PromotionGitError> {
        let listing = self.require_success(FixedGitOperation::ReadTreeListing {
            commit: commit.to_owned(),
        })?;
        // Candidate artifacts currently hash the UTF-8 decoded `git ls-tree`
        // output. Match that contract exactly while the foundation remains
        // unwired; the raw Git tree object ID above separately binds the
        // actual object without any text decoding.
        let decoded = String::from_utf8_lossy(&listing);
        Ok(sha256_digest(decoded.as_bytes()))
    }

    fn is_ancestor(&mut self, ancestor: &str, descendant: &str) -> Result<bool, PromotionGitError> {
        let output = self.invoke(FixedGitOperation::IsAncestor {
            ancestor: ancestor.to_owned(),
            descendant: descendant.to_owned(),
        })?;
        match output.status {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(PromotionGitError::ReconciliationRequired),
        }
    }

    fn require_success(
        &mut self,
        operation: FixedGitOperation,
    ) -> Result<Vec<u8>, PromotionGitError> {
        let output = self.invoke(operation)?;
        if output.status == 0 {
            Ok(output.stdout)
        } else {
            Err(PromotionGitError::ReconciliationRequired)
        }
    }

    fn invoke(&mut self, operation: FixedGitOperation) -> Result<GitOutput, PromotionGitError> {
        #[cfg(test)]
        if let Some(runner) = self.test_runner.as_mut() {
            let output = runner.invoke(TestGitOperation::from(&operation));
            return Ok(GitOutput {
                status: output.status,
                stdout: output.stdout,
            });
        }
        self.invoke_fixed_git(operation)
    }

    fn invoke_fixed_git(
        &self,
        operation: FixedGitOperation,
    ) -> Result<GitOutput, PromotionGitError> {
        if !cfg!(target_os = "linux") {
            return Err(PromotionGitError::ReconciliationRequired);
        }

        let mut command = self.fixed_git_command();
        match operation {
            FixedGitOperation::InspectReceipt { receipt_ref } => {
                command
                    .arg("rev-parse")
                    .arg("--verify")
                    .arg("--quiet")
                    .arg(format!("{receipt_ref}^{{commit}}"));
                self.command_output(command)
            }
            FixedGitOperation::ResolveCandidateRef { candidate_ref } => {
                command
                    .arg("rev-parse")
                    .arg("--verify")
                    .arg("--quiet")
                    .arg(format!("{candidate_ref}^{{commit}}"));
                self.command_output(command)
            }
            FixedGitOperation::ResolveTarget { target_ref } => {
                command
                    .arg("rev-parse")
                    .arg("--verify")
                    .arg("--quiet")
                    .arg(format!("{target_ref}^{{commit}}"));
                self.command_output(command)
            }
            FixedGitOperation::ReadCommit { commit } => {
                command.arg("cat-file").arg("commit").arg(commit);
                self.command_output(command)
            }
            FixedGitOperation::ReadTreeListing { commit } => {
                command
                    .arg("ls-tree")
                    .arg("-r")
                    .arg("--full-tree")
                    .arg("-z")
                    .arg(commit);
                self.command_output(command)
            }
            FixedGitOperation::CreateMergeCommit {
                tree,
                base,
                candidate,
                receipt_message,
            } => {
                command
                    .arg("commit-tree")
                    .arg(tree)
                    .arg("-p")
                    .arg(base)
                    .arg("-p")
                    .arg(candidate)
                    .arg("-m")
                    .arg(receipt_message);
                self.command_output(command)
            }
            FixedGitOperation::AtomicAdvance {
                target_ref,
                expected_base,
                merge_commit,
                receipt_ref,
            } => {
                command.arg("update-ref").arg("--stdin");
                let transaction = format!(
                    "start\nupdate {target_ref} {merge_commit} {expected_base}\ncreate {receipt_ref} {merge_commit}\nprepare\ncommit\n"
                );
                self.command_output_with_stdin(command, transaction.into_bytes())
            }
            FixedGitOperation::IsAncestor {
                ancestor,
                descendant,
            } => {
                command
                    .arg("merge-base")
                    .arg("--is-ancestor")
                    .arg(ancestor)
                    .arg(descendant);
                self.command_output(command)
            }
        }
    }

    fn fixed_git_command(&self) -> Command {
        let mut command = Command::new(FIXED_GIT_BINARY);
        command
            .current_dir(&self.repository_root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", "/nonexistent")
            .env("XDG_CONFIG_HOME", "/nonexistent")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("GIT_AUTHOR_NAME", "Buildplane Authority Broker")
            .env("GIT_AUTHOR_EMAIL", "authority-broker@buildplane.invalid")
            .env("GIT_COMMITTER_NAME", "Buildplane Authority Broker")
            .env("GIT_COMMITTER_EMAIL", "authority-broker@buildplane.invalid");
        command
    }

    fn command_output(&self, mut command: Command) -> Result<GitOutput, PromotionGitError> {
        let output = command
            .output()
            .map_err(|_| PromotionGitError::ReconciliationRequired)?;
        Ok(GitOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
        })
    }

    fn command_output_with_stdin(
        &self,
        mut command: Command,
        stdin: Vec<u8>,
    ) -> Result<GitOutput, PromotionGitError> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| PromotionGitError::ReconciliationRequired)?;
        let Some(mut input) = child.stdin.take() else {
            return Err(PromotionGitError::ReconciliationRequired);
        };
        input
            .write_all(&stdin)
            .map_err(|_| PromotionGitError::ReconciliationRequired)?;
        drop(input);
        let output = child
            .wait_with_output()
            .map_err(|_| PromotionGitError::ReconciliationRequired)?;
        Ok(GitOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: output.stdout,
        })
    }
}

#[derive(Debug)]
struct PromotionReceipt {
    merge_commit: String,
    merge_tree: String,
}

/// Raw Git facts read only through the fixed gateway after the signed replay
/// capability has pinned the candidate commit and semantic tree digest.
#[derive(Debug)]
struct VerifiedCandidateGitFacts {
    tree: String,
}

#[derive(Debug)]
struct ParsedCommit {
    tree: String,
    parents: Vec<String>,
    message: Vec<u8>,
}

#[derive(Debug)]
struct GitOutput {
    status: i32,
    stdout: Vec<u8>,
}

/// Closed list of every Git operation the production component can perform.
/// There is no `run(args)`, callback, shell, executable selection, or
/// caller-supplied repository path.
#[derive(Clone, Debug)]
enum FixedGitOperation {
    InspectReceipt {
        receipt_ref: String,
    },
    ResolveCandidateRef {
        candidate_ref: String,
    },
    ResolveTarget {
        target_ref: String,
    },
    ReadCommit {
        commit: String,
    },
    ReadTreeListing {
        commit: String,
    },
    CreateMergeCommit {
        tree: String,
        base: String,
        candidate: String,
        receipt_message: String,
    },
    AtomicAdvance {
        target_ref: String,
        expected_base: String,
        merge_commit: String,
        receipt_ref: String,
    },
    IsAncestor {
        ancestor: String,
        descendant: String,
    },
}

fn parse_single_object_id(bytes: &[u8]) -> Option<String> {
    let output = std::str::from_utf8(bytes).ok()?;
    let output = output.strip_suffix('\n').unwrap_or(output);
    let output = output.strip_suffix('\r').unwrap_or(output);
    is_canonical_git_object_id(output).then(|| output.to_owned())
}

fn parse_commit_object(bytes: &[u8]) -> Option<ParsedCommit> {
    let separator = bytes.windows(2).position(|window| window == b"\n\n")?;
    let headers = &bytes[..separator];
    let message = bytes[separator + 2..].to_vec();
    let mut tree = None;
    let mut parents = Vec::new();

    for line in headers.split(|byte| *byte == b'\n') {
        if let Some(value) = line.strip_prefix(b"tree ") {
            let value = std::str::from_utf8(value).ok()?;
            if tree.replace(value.to_owned()).is_some() || !is_canonical_git_object_id(value) {
                return None;
            }
        } else if let Some(value) = line.strip_prefix(b"parent ") {
            let value = std::str::from_utf8(value).ok()?;
            if !is_canonical_git_object_id(value) {
                return None;
            }
            parents.push(value.to_owned());
        }
    }

    Some(ParsedCommit {
        tree: tree?,
        parents,
        message,
    })
}

fn matches_receipt_message(actual: &[u8], expected: &str) -> bool {
    if actual == expected.as_bytes() {
        return true;
    }
    let expected_with_final_newline = format!("{expected}\n");
    actual == expected_with_final_newline.as_bytes()
}

fn has_exact_parents(actual: &[String], expected: &[&str]) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .map(String::as_str)
            .eq(expected.iter().copied())
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == SHA256_PREFIX.len() + 64
        && value.starts_with(SHA256_PREFIX)
        && value[SHA256_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_target_ref(value: &str) -> bool {
    let Some(branch) = value.strip_prefix("refs/heads/") else {
        return false;
    };
    if branch.is_empty()
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
    {
        return false;
    }
    branch.split('/').all(|component| {
        !component.is_empty()
            && !component.starts_with('.')
            && !component.ends_with('.')
            && component != "@"
            && component.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@')
            })
    })
}

fn is_canonical_idempotency_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'/' | b'.' | b'_' | b'-')
        })
}

#[cfg(test)]
fn is_test_canonical_root(value: &str) -> bool {
    value.starts_with('/')
        && !value.contains("//")
        && !value
            .split('/')
            .any(|component| component == "." || component == "..")
}

/// Minimal SHA-256 implementation kept local so this narrowly scoped crate
/// does not acquire a new public dependency solely to recheck candidate tree
/// evidence. It is exercised through the known empty-tree-listing digest in
/// the module tests.
fn sha256_digest(bytes: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const ROUND: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut state = INITIAL;
    for chunk in padded.chunks_exact(64) {
        let mut schedule = [0u32; 64];
        for (index, word) in schedule[..16].iter_mut().enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let sigma0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let sigma1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(sigma0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(sigma1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choose)
                .wrapping_add(ROUND[index])
                .wrapping_add(schedule[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    format!(
        "sha256:{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",
        state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]
    )
}

#[cfg(test)]
pub(super) trait TestFixedGitRunner {
    fn invoke(&mut self, operation: TestGitOperation) -> TestGitOutput;
}

/// Test-only mirror of the fixed production operation set. It intentionally
/// exposes semantic operations, never a generic executable, argument vector,
/// shell command, callback, or path.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum TestGitOperation {
    InspectReceipt {
        receipt_ref: String,
    },
    ResolveCandidateRef {
        candidate_ref: String,
    },
    ResolveTarget {
        target_ref: String,
    },
    ReadCommit {
        commit: String,
    },
    ReadTreeListing {
        commit: String,
    },
    CreateMergeCommit {
        tree: String,
        base: String,
        candidate: String,
        receipt_message: String,
    },
    AtomicAdvance {
        target_ref: String,
        expected_base: String,
        merge_commit: String,
        receipt_ref: String,
    },
    IsAncestor {
        ancestor: String,
        descendant: String,
    },
}

#[cfg(test)]
impl From<&FixedGitOperation> for TestGitOperation {
    fn from(operation: &FixedGitOperation) -> Self {
        match operation {
            FixedGitOperation::InspectReceipt { receipt_ref } => Self::InspectReceipt {
                receipt_ref: receipt_ref.clone(),
            },
            FixedGitOperation::ResolveCandidateRef { candidate_ref } => Self::ResolveCandidateRef {
                candidate_ref: candidate_ref.clone(),
            },
            FixedGitOperation::ResolveTarget { target_ref } => Self::ResolveTarget {
                target_ref: target_ref.clone(),
            },
            FixedGitOperation::ReadCommit { commit } => Self::ReadCommit {
                commit: commit.clone(),
            },
            FixedGitOperation::ReadTreeListing { commit } => Self::ReadTreeListing {
                commit: commit.clone(),
            },
            FixedGitOperation::CreateMergeCommit {
                tree,
                base,
                candidate,
                receipt_message,
            } => Self::CreateMergeCommit {
                tree: tree.clone(),
                base: base.clone(),
                candidate: candidate.clone(),
                receipt_message: receipt_message.clone(),
            },
            FixedGitOperation::AtomicAdvance {
                target_ref,
                expected_base,
                merge_commit,
                receipt_ref,
            } => Self::AtomicAdvance {
                target_ref: target_ref.clone(),
                expected_base: expected_base.clone(),
                merge_commit: merge_commit.clone(),
                receipt_ref: receipt_ref.clone(),
            },
            FixedGitOperation::IsAncestor {
                ancestor,
                descendant,
            } => Self::IsAncestor {
                ancestor: ancestor.clone(),
                descendant: descendant.clone(),
            },
        }
    }
}

#[cfg(test)]
pub(super) struct TestGitOutput {
    status: i32,
    stdout: Vec<u8>,
}

#[cfg(test)]
impl TestGitOutput {
    pub(super) fn success(stdout: Vec<u8>) -> Self {
        Self { status: 0, stdout }
    }

    pub(super) fn failure(status: i32) -> Self {
        Self {
            status,
            stdout: Vec::new(),
        }
    }
}
