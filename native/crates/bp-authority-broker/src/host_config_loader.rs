//! Descriptor-bound loading for the fixed protected host configuration.
//!
//! This module owns the deployment descriptor boundaries: it opens the fixed
//! config without symlink traversal, validates descriptor metadata, bounds the
//! read, parses the resulting JSON, and retains a separately descriptor-walked
//! authority-root directory for later protected startup steps.

use crate::host_config::{parse_promotion_decision_host_config, PromotionDecisionHostConfigV1};
use thiserror::Error;

#[cfg(target_os = "linux")]
use std::fs::{File, Metadata};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::path::Path;

const ROOT_UID: u32 = 0;
const DEFAULT_PROMOTION_DECISION_HOST_CONFIG_PARENT_COMPONENTS: [&[u8]; 3] =
    [b"etc", b"buildplane", b"authority-host"];
const DEFAULT_PROMOTION_DECISION_HOST_CONFIG_FILE_NAME: &[u8] = b"promotion-decision-v1.json";
const MAX_PROTECTED_HOST_CONFIG_BYTES: usize = 256 * 1024;

/// Closed failures for the protected deployment config reader.
///
/// These errors intentionally do not expose a host pathname, errno, owner, or
/// mode. The caller gets only a safe operational class and must fail closed.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedHostConfigReadError {
    #[cfg(not(target_os = "linux"))]
    #[error("protected host config loading is supported only on Linux")]
    UnsupportedPlatform,
    #[error("protected host config directory path is unavailable or unsafe")]
    UnsafePath,
    #[error("protected host config file is unavailable or unsafe")]
    UnsafeConfig,
    #[error("protected authority root is unavailable or unsafe")]
    UnsafeAuthorityRoot,
    #[error("protected host config exceeds the maximum permitted size")]
    ConfigTooLarge,
    #[error("protected host config could not be read")]
    ReadFailed,
    #[error("protected host config is invalid")]
    InvalidConfig,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DescriptorKind {
    Directory,
    RegularFile,
    Other,
}

/// Facts obtained only from an already-open descriptor.
///
/// The validators below are intentionally pure so their ownership and mode
/// policy stays independently testable from the syscall layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DescriptorFacts {
    kind: DescriptorKind,
    uid: u32,
    mode: u32,
}

/// A directory descriptor that remains bound to the validated authority root.
///
/// This is runtime-only state. It is intentionally neither serializable nor
/// cloneable, so later protected startup steps must use this retained
/// descriptor instead of reopening the parsed pathname.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) struct ValidatedAuthorityRootV1 {
    directory: File,
}

#[cfg(not(target_os = "linux"))]
#[derive(Debug)]
pub(crate) struct ValidatedAuthorityRootV1;

#[cfg(target_os = "linux")]
impl ValidatedAuthorityRootV1 {
    fn new(directory: File) -> Self {
        Self { directory }
    }

    /// The held directory descriptor for later protected-realm opens.
    pub(crate) fn directory(&self) -> &File {
        &self.directory
    }
}

/// Parsed public configuration paired with its retained, validated authority
/// root descriptor. This is internal startup state, not a deployment schema.
#[derive(Debug)]
pub(crate) struct ValidatedPromotionDecisionHostStartupV1 {
    config: PromotionDecisionHostConfigV1,
    authority_root: ValidatedAuthorityRootV1,
}

impl ValidatedPromotionDecisionHostStartupV1 {
    pub(crate) fn config(&self) -> &PromotionDecisionHostConfigV1 {
        &self.config
    }

    pub(crate) fn authority_root(&self) -> &ValidatedAuthorityRootV1 {
        &self.authority_root
    }
}

/// Read the sole deployment config accepted by the default promotion-decision
/// host. Production callers cannot supply a path, environment variable, or
/// command-line override.
pub(crate) fn load_default_promotion_decision_host_config_v1(
) -> Result<ValidatedPromotionDecisionHostStartupV1, ProtectedHostConfigReadError> {
    #[cfg(target_os = "linux")]
    {
        let json = read_default_protected_host_config_json_bytes()?;
        let config = parse_protected_host_config_json(&json)?;
        let authority_root = open_validated_authority_root(&config)?;
        Ok(ValidatedPromotionDecisionHostStartupV1 {
            config,
            authority_root,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err(ProtectedHostConfigReadError::UnsupportedPlatform)
    }
}

fn parse_protected_host_config_json(
    bytes: &[u8],
) -> Result<PromotionDecisionHostConfigV1, ProtectedHostConfigReadError> {
    let json =
        std::str::from_utf8(bytes).map_err(|_| ProtectedHostConfigReadError::InvalidConfig)?;
    parse_promotion_decision_host_config(json)
        .map_err(|_| ProtectedHostConfigReadError::InvalidConfig)
}

fn validate_directory_facts(
    facts: DescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostConfigReadError> {
    if facts.kind != DescriptorKind::Directory
        || facts.uid != expected_owner
        || facts.mode & 0o022 != 0
    {
        return Err(ProtectedHostConfigReadError::UnsafePath);
    }
    Ok(())
}

fn validate_config_file_facts(
    facts: DescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostConfigReadError> {
    if facts.kind != DescriptorKind::RegularFile
        || facts.uid != expected_owner
        || facts.mode & 0o022 != 0
        || facts.mode & 0o004 != 0
    {
        return Err(ProtectedHostConfigReadError::UnsafeConfig);
    }
    Ok(())
}

fn validate_authority_root_facts(
    facts: DescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostConfigReadError> {
    if facts.kind != DescriptorKind::Directory
        || facts.uid != expected_owner
        || facts.mode & 0o077 != 0
        || facts.mode & 0o700 != 0o700
    {
        return Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot);
    }
    Ok(())
}

/// Bind the parsed deployment authority root to a retained descriptor. The
/// configured pathname is trusted only as an already-validated field from the
/// closed deployment config; each component is reopened exactly once through
/// the descriptor walk below, never by a later path lookup.
#[cfg(target_os = "linux")]
fn open_validated_authority_root(
    config: &PromotionDecisionHostConfigV1,
) -> Result<ValidatedAuthorityRootV1, ProtectedHostConfigReadError> {
    let components = authority_root_components(&config.authority_root)?;
    let (final_component, ancestors) = components
        .split_last()
        .ok_or(ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    let mut parent = open_validated_root_directory()
        .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    for component in ancestors {
        let child = open_root_owned_directory_at(parent.as_raw_fd(), component)
            .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
        parent = child;
    }

    let authority_root = open_directory_at_with_error(
        parent.as_raw_fd(),
        final_component,
        ProtectedHostConfigReadError::UnsafeAuthorityRoot,
    )?;
    validate_authority_root_facts(
        descriptor_facts(
            &authority_root
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?,
        ),
        config.broker_uid,
    )?;
    Ok(ValidatedAuthorityRootV1::new(authority_root))
}

/// Preserve every component for the descriptor walk; this is deliberately not
/// a normalization operation. The pure config parser rejects `.` and `..`, and
/// this boundary additionally rejects empty and trailing components before any
/// descriptor open occurs.
#[cfg(target_os = "linux")]
fn authority_root_components(
    authority_root: &Path,
) -> Result<Vec<Vec<u8>>, ProtectedHostConfigReadError> {
    let bytes = authority_root.as_os_str().as_bytes();
    if bytes.len() <= 1 || bytes.first() != Some(&b'/') || bytes.last() == Some(&b'/') {
        return Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot);
    }

    let components = bytes[1..]
        .split(|byte| *byte == b'/')
        .map(|component| component.to_vec())
        .collect::<Vec<_>>();
    if components.is_empty()
        || components.iter().any(|component| {
            component.is_empty()
                || component.as_slice() == b"."
                || component.as_slice() == b".."
                || component.contains(&0)
        })
    {
        return Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot);
    }
    Ok(components)
}

/// Traverse exactly `/etc/buildplane/authority-host` from an opened `/` and
/// then open exactly `promotion-decision-v1.json`. There is no configurable
/// production pathname or owner policy.
#[cfg(target_os = "linux")]
fn read_default_protected_host_config_json_bytes() -> Result<Vec<u8>, ProtectedHostConfigReadError>
{
    let mut parent = open_validated_root_directory()?;
    for component in DEFAULT_PROMOTION_DECISION_HOST_CONFIG_PARENT_COMPONENTS {
        let child = open_root_owned_directory_at(parent.as_raw_fd(), component)?;
        parent = child;
    }

    // The final name is opened relative to the held, validated parent. A
    // later pathname swap cannot redirect this descriptor to another parent.
    let mut config = open_config_file_at(
        parent.as_raw_fd(),
        DEFAULT_PROMOTION_DECISION_HOST_CONFIG_FILE_NAME,
    )?;
    validate_config_file_facts(
        descriptor_facts(
            &config
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafeConfig)?,
        ),
        ROOT_UID,
    )?;
    read_bounded_config(&mut config)
}

#[cfg(target_os = "linux")]
fn open_validated_root_directory() -> Result<File, ProtectedHostConfigReadError> {
    let root = std::ffi::CString::new("/").expect("a literal root path has no NUL");
    let descriptor = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    let directory =
        file_from_open_descriptor(descriptor, ProtectedHostConfigReadError::UnsafePath)?;
    validate_directory_facts(
        descriptor_facts(
            &directory
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafePath)?,
        ),
        ROOT_UID,
    )?;
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn open_root_owned_directory_at(
    parent_descriptor: RawFd,
    component: &[u8],
) -> Result<File, ProtectedHostConfigReadError> {
    let directory = open_directory_at(parent_descriptor, component)?;
    validate_directory_facts(
        descriptor_facts(
            &directory
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafePath)?,
        ),
        ROOT_UID,
    )?;
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn open_directory_at(
    parent_descriptor: RawFd,
    component: &[u8],
) -> Result<File, ProtectedHostConfigReadError> {
    open_directory_at_with_error(
        parent_descriptor,
        component,
        ProtectedHostConfigReadError::UnsafePath,
    )
}

#[cfg(target_os = "linux")]
fn open_directory_at_with_error(
    parent_descriptor: RawFd,
    component: &[u8],
    error: ProtectedHostConfigReadError,
) -> Result<File, ProtectedHostConfigReadError> {
    let component = std::ffi::CString::new(component).map_err(|_| error)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_open_descriptor(descriptor, error)
}

#[cfg(target_os = "linux")]
fn open_config_file_at(
    parent_descriptor: RawFd,
    file_name: &[u8],
) -> Result<File, ProtectedHostConfigReadError> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| ProtectedHostConfigReadError::UnsafeConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_open_descriptor(descriptor, ProtectedHostConfigReadError::UnsafeConfig)
}

#[cfg(target_os = "linux")]
fn file_from_open_descriptor(
    descriptor: libc::c_int,
    error: ProtectedHostConfigReadError,
) -> Result<File, ProtectedHostConfigReadError> {
    if descriptor < 0 {
        return Err(error);
    }

    // `open`/`openat` returned a fresh descriptor that is transferred exactly
    // once to `File`, which subsequently owns and closes it.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn descriptor_facts(metadata: &Metadata) -> DescriptorFacts {
    let kind = if metadata.file_type().is_dir() {
        DescriptorKind::Directory
    } else if metadata.file_type().is_file() {
        DescriptorKind::RegularFile
    } else {
        DescriptorKind::Other
    };
    DescriptorFacts {
        kind,
        uid: metadata.uid(),
        mode: metadata.mode() & 0o7777,
    }
}

/// Bound the read itself rather than trusting a size observed before the read:
/// a file that grows after `fstat` still cannot make this process retain more
/// than 256 KiB plus one sentinel byte.
#[cfg(target_os = "linux")]
fn read_bounded_config(file: &mut File) -> Result<Vec<u8>, ProtectedHostConfigReadError> {
    let mut bytes = Vec::with_capacity(MAX_PROTECTED_HOST_CONFIG_BYTES);
    file.take((MAX_PROTECTED_HOST_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ProtectedHostConfigReadError::ReadFailed)?;
    if bytes.len() > MAX_PROTECTED_HOST_CONFIG_BYTES {
        return Err(ProtectedHostConfigReadError::ConfigTooLarge);
    }
    Ok(bytes)
}

/// Test-only path seam. The supplied anchor is trusted by the test fixture, so
/// the world-writable `/tmp` prefix is intentionally not walked. The anchor
/// itself and every descendant directory remain descriptor-validated before
/// the final config is opened. This symbol is absent from production builds.
#[cfg(all(test, target_os = "linux"))]
fn read_protected_host_config_json_bytes_from_trusted_anchor_for_test(
    config_path: &Path,
    trusted_anchor: &Path,
    expected_config_owner: u32,
) -> Result<Vec<u8>, ProtectedHostConfigReadError> {
    let config_components = absolute_path_components_for_test(config_path)?;
    let anchor_components = absolute_path_components_for_test(trusted_anchor)?;
    if config_components.len() <= anchor_components.len()
        || !config_components.starts_with(anchor_components.as_slice())
    {
        return Err(ProtectedHostConfigReadError::UnsafePath);
    }

    let mut relative_components = config_components[anchor_components.len()..].to_vec();
    let file_name = relative_components
        .pop()
        .ok_or(ProtectedHostConfigReadError::UnsafePath)?;
    let mut parent = open_trusted_anchor_for_test(trusted_anchor, expected_config_owner)?;
    for component in relative_components {
        let child = open_directory_at(parent.as_raw_fd(), &component)?;
        validate_directory_facts(
            descriptor_facts(
                &child
                    .metadata()
                    .map_err(|_| ProtectedHostConfigReadError::UnsafePath)?,
            ),
            expected_config_owner,
        )?;
        parent = child;
    }

    let mut config = open_config_file_at(parent.as_raw_fd(), &file_name)?;
    validate_config_file_facts(
        descriptor_facts(
            &config
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafeConfig)?,
        ),
        expected_config_owner,
    )?;
    read_bounded_config(&mut config)
}

/// Split an absolute test path without normalizing it. Normalization would
/// hide `.`/`..` components before the descriptor walk could reject them.
#[cfg(all(test, target_os = "linux"))]
fn absolute_path_components_for_test(
    path: &Path,
) -> Result<Vec<Vec<u8>>, ProtectedHostConfigReadError> {
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() <= 1 || bytes.first() != Some(&b'/') || bytes.last() == Some(&b'/') {
        return Err(ProtectedHostConfigReadError::UnsafePath);
    }

    let components = bytes[1..]
        .split(|byte| *byte == b'/')
        .map(|component| component.to_vec())
        .collect::<Vec<_>>();
    if components.is_empty()
        || components.iter().any(|component| {
            component.is_empty()
                || component.as_slice() == b"."
                || component.as_slice() == b".."
                || component.contains(&0)
        })
    {
        return Err(ProtectedHostConfigReadError::UnsafePath);
    }
    Ok(components)
}

#[cfg(all(test, target_os = "linux"))]
fn open_trusted_anchor_for_test(
    trusted_anchor: &Path,
    expected_owner: u32,
) -> Result<File, ProtectedHostConfigReadError> {
    let anchor = std::ffi::CString::new(trusted_anchor.as_os_str().as_bytes())
        .map_err(|_| ProtectedHostConfigReadError::UnsafePath)?;
    let descriptor = unsafe {
        libc::open(
            anchor.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    let directory =
        file_from_open_descriptor(descriptor, ProtectedHostConfigReadError::UnsafePath)?;
    validate_directory_facts(
        descriptor_facts(
            &directory
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafePath)?,
        ),
        expected_owner,
    )?;
    Ok(directory)
}

/// Test-only authority-root seam. Production always begins at `/` and derives
/// both the path and ownership policy from the fixed parsed deployment config.
/// Tests may replace the immutable root-owned prefix with their private temp
/// anchor, but retain the same descriptor-walk and final-root checks.
#[cfg(all(test, target_os = "linux"))]
fn validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
    config: PromotionDecisionHostConfigV1,
    trusted_anchor: &Path,
    expected_ancestor_owner: u32,
) -> Result<ValidatedPromotionDecisionHostStartupV1, ProtectedHostConfigReadError> {
    let authority_root_components = absolute_path_components_for_test(&config.authority_root)
        .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    let anchor_components = absolute_path_components_for_test(trusted_anchor)
        .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    if authority_root_components.len() <= anchor_components.len()
        || !authority_root_components.starts_with(anchor_components.as_slice())
    {
        return Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot);
    }

    let mut relative_components = authority_root_components[anchor_components.len()..].to_vec();
    let final_component = relative_components
        .pop()
        .ok_or(ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    let mut parent = open_trusted_anchor_for_test(trusted_anchor, expected_ancestor_owner)
        .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
    for component in relative_components {
        let child = open_directory_at(parent.as_raw_fd(), &component)
            .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
        validate_directory_facts(
            descriptor_facts(
                &child
                    .metadata()
                    .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?,
            ),
            expected_ancestor_owner,
        )
        .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?;
        parent = child;
    }

    let authority_root = open_directory_at_with_error(
        parent.as_raw_fd(),
        &final_component,
        ProtectedHostConfigReadError::UnsafeAuthorityRoot,
    )?;
    validate_authority_root_facts(
        descriptor_facts(
            &authority_root
                .metadata()
                .map_err(|_| ProtectedHostConfigReadError::UnsafeAuthorityRoot)?,
        ),
        config.broker_uid,
    )?;
    Ok(ValidatedPromotionDecisionHostStartupV1 {
        config,
        authority_root: ValidatedAuthorityRootV1::new(authority_root),
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::TempDir;

    fn test_anchor() -> (TempDir, u32) {
        let directory = tempfile::tempdir().expect("temporary test directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("private temporary anchor");
        (directory, unsafe { libc::geteuid() })
    }

    fn write_private_file(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).expect("test config file");
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .expect("private test config file");
    }

    #[test]
    fn exposes_a_fixed_typed_default_loader() {
        let loader: fn() -> Result<
            ValidatedPromotionDecisionHostStartupV1,
            ProtectedHostConfigReadError,
        > = load_default_promotion_decision_host_config_v1;
        let _ = loader;
    }

    fn parsed_config_for_authority_root(
        authority_root: &Path,
        broker_uid: u32,
    ) -> PromotionDecisionHostConfigV1 {
        let signer = |actor_id: &str, key_id: &str, seed: u8| {
            let signing_key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
            serde_json::json!({
                "actor_id": actor_id,
                "key_id": key_id,
                "public_key": signing_key.verifying_key().to_bytes().to_vec(),
            })
        };
        let client_uid = if broker_uid == 1 { 2 } else { 1 };
        let config = serde_json::json!({
            "schema_version": 1,
            "run_id": "018f2e40-0000-7000-8000-000000000001",
            "broker_uid": broker_uid,
            "promotion_decision_client_uids": [client_uid],
            "socket_group_gid": 1002,
            "authority_root": authority_root.to_string_lossy(),
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "kernel": signer("kernel", "kernel-main", 1),
            "operator": signer("operator", "operator-main", 2),
            "reviewers": [signer("reviewer", "reviewer-main", 3)],
        });

        parse_promotion_decision_host_config(&config.to_string())
            .expect("valid authority-root test config")
    }

    fn create_private_directory(path: &Path) {
        fs::create_dir(path).expect("test authority directory");
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .expect("private test authority directory");
    }

    #[test]
    fn rejects_a_final_authority_root_symlink_through_the_descriptor_open() {
        let (anchor, owner) = test_anchor();
        let target = anchor.path().join("authority-target");
        create_private_directory(&target);
        let authority_root = anchor.path().join("authority");
        symlink(&target, &authority_root).expect("final authority-root symlink");
        let config = parsed_config_for_authority_root(&authority_root, owner);

        assert!(matches!(
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot)
        ));
    }

    #[test]
    fn rejects_an_intermediate_authority_root_symlink_through_the_descriptor_walk() {
        let (anchor, owner) = test_anchor();
        let target_parent = anchor.path().join("parent-target");
        create_private_directory(&target_parent);
        create_private_directory(&target_parent.join("authority"));
        let parent = anchor.path().join("parent");
        symlink(&target_parent, &parent).expect("intermediate authority-root symlink");
        let authority_root = parent.join("authority");
        let config = parsed_config_for_authority_root(&authority_root, owner);

        assert!(matches!(
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot)
        ));
    }

    #[test]
    fn rejects_an_authority_root_owned_by_a_different_broker_uid() {
        let (anchor, owner) = test_anchor();
        let authority_root = anchor.path().join("authority");
        create_private_directory(&authority_root);
        let other_owner = if owner == 1 { 2 } else { 1 };
        let config = parsed_config_for_authority_root(&authority_root, other_owner);

        assert!(matches!(
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot)
        ));
    }

    #[test]
    fn rejects_an_authority_root_with_group_or_other_permissions() {
        let (anchor, owner) = test_anchor();
        let authority_root = anchor.path().join("authority");
        create_private_directory(&authority_root);
        fs::set_permissions(&authority_root, fs::Permissions::from_mode(0o750))
            .expect("group-readable authority root");
        let config = parsed_config_for_authority_root(&authority_root, owner);

        assert!(matches!(
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot)
        ));
    }

    #[test]
    fn rejects_an_authority_root_missing_owner_rwx() {
        let (anchor, owner) = test_anchor();
        let authority_root = anchor.path().join("authority");
        create_private_directory(&authority_root);
        fs::set_permissions(&authority_root, fs::Permissions::from_mode(0o600))
            .expect("non-executable authority root");
        let config = parsed_config_for_authority_root(&authority_root, owner);

        assert!(matches!(
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeAuthorityRoot)
        ));
    }

    #[test]
    fn retains_a_validated_authority_root_directory_descriptor() {
        let (anchor, owner) = test_anchor();
        let authority_root = anchor.path().join("authority");
        create_private_directory(&authority_root);
        let config = parsed_config_for_authority_root(&authority_root, owner);

        let startup = validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
            config,
            anchor.path(),
            owner,
        )
        .expect("private authority root is accepted");
        assert_eq!(startup.config().authority_root, authority_root);
        fs::rename(&authority_root, anchor.path().join("authority-moved"))
            .expect("move authority root after descriptor validation");

        assert!(startup
            .authority_root()
            .directory()
            .metadata()
            .expect("retained descriptor remains open after pathname move")
            .is_dir());
    }

    #[test]
    fn rejects_non_root_config_owner_relative_to_expected_policy() {
        let facts = DescriptorFacts {
            kind: DescriptorKind::RegularFile,
            uid: 1000,
            mode: 0o600,
        };

        assert_eq!(
            validate_config_file_facts(facts, ROOT_UID),
            Err(ProtectedHostConfigReadError::UnsafeConfig)
        );
    }

    #[test]
    fn maps_invalid_json_to_a_closed_loader_error() {
        assert!(matches!(
            parse_protected_host_config_json(b"not-json"),
            Err(ProtectedHostConfigReadError::InvalidConfig)
        ));
    }

    #[test]
    fn rejects_unsafe_descriptor_metadata_policies_without_a_filesystem_lookup() {
        for facts in [
            DescriptorFacts {
                kind: DescriptorKind::Other,
                uid: ROOT_UID,
                mode: 0o600,
            },
            DescriptorFacts {
                kind: DescriptorKind::RegularFile,
                uid: ROOT_UID,
                mode: 0o604,
            },
            DescriptorFacts {
                kind: DescriptorKind::RegularFile,
                uid: ROOT_UID,
                mode: 0o620,
            },
        ] {
            assert_eq!(
                validate_config_file_facts(facts, ROOT_UID),
                Err(ProtectedHostConfigReadError::UnsafeConfig)
            );
        }

        assert_eq!(
            validate_directory_facts(
                DescriptorFacts {
                    kind: DescriptorKind::Directory,
                    uid: ROOT_UID,
                    mode: 0o775,
                },
                ROOT_UID,
            ),
            Err(ProtectedHostConfigReadError::UnsafePath)
        );
    }

    #[test]
    fn rejects_a_final_symlink_through_the_descriptor_open() {
        let (anchor, owner) = test_anchor();
        let target = anchor.path().join("target.json");
        write_private_file(&target, b"{}");
        let config = anchor.path().join("promotion-decision-v1.json");
        symlink(&target, &config).expect("final config symlink");

        assert_eq!(
            read_protected_host_config_json_bytes_from_trusted_anchor_for_test(
                &config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::UnsafeConfig)
        );
    }

    #[test]
    fn bounds_config_data_at_256_kib() {
        let (anchor, owner) = test_anchor();
        let config = anchor.path().join("promotion-decision-v1.json");

        write_private_file(&config, &vec![b'a'; MAX_PROTECTED_HOST_CONFIG_BYTES]);
        assert_eq!(
            read_protected_host_config_json_bytes_from_trusted_anchor_for_test(
                &config,
                anchor.path(),
                owner,
            )
            .expect("exactly bounded config is allowed")
            .len(),
            MAX_PROTECTED_HOST_CONFIG_BYTES
        );

        write_private_file(&config, &vec![b'a'; MAX_PROTECTED_HOST_CONFIG_BYTES + 1]);
        assert_eq!(
            read_protected_host_config_json_bytes_from_trusted_anchor_for_test(
                &config,
                anchor.path(),
                owner,
            ),
            Err(ProtectedHostConfigReadError::ConfigTooLarge)
        );
    }
}
