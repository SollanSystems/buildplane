//! Descriptor-bound custody for the fixed promotion repository.

use crate::host_config_loader::ValidatedPromotionDecisionHostStartupV1;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;

const REPOSITORY_DIRECTORY_NAME: &[u8] = b"repository";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedPromotionRepositoryErrorV1 {
    #[cfg(not(target_os = "linux"))]
    #[error("protected promotion repository requires Linux")]
    UnsupportedPlatform,
    #[error("protected promotion repository is unavailable or unsafe")]
    UnsafeRepository,
}

#[cfg(target_os = "linux")]
pub(crate) struct ProtectedPromotionRepositoryV1 {
    _repository: File,
    gateway_path: PathBuf,
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct ProtectedPromotionRepositoryV1;

impl ProtectedPromotionRepositoryV1 {
    #[cfg(target_os = "linux")]
    pub(crate) fn gateway_path(&self) -> &Path {
        &self.gateway_path
    }
}

pub(crate) fn load_promotion_repository_v1(
    startup: &ValidatedPromotionDecisionHostStartupV1,
) -> Result<ProtectedPromotionRepositoryV1, ProtectedPromotionRepositoryErrorV1> {
    #[cfg(target_os = "linux")]
    {
        let component = std::ffi::CString::new(REPOSITORY_DIRECTORY_NAME)
            .map_err(|_| ProtectedPromotionRepositoryErrorV1::UnsafeRepository)?;
        let descriptor = unsafe {
            libc::openat(
                startup.authority_root().directory().as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(ProtectedPromotionRepositoryErrorV1::UnsafeRepository);
        }
        let repository = unsafe { File::from_raw_fd(descriptor) };
        let metadata = repository
            .metadata()
            .map_err(|_| ProtectedPromotionRepositoryErrorV1::UnsafeRepository)?;
        if !metadata.is_dir()
            || metadata.uid() != startup.config().broker_uid
            || metadata.mode() & 0o7777 != 0o700
            || metadata.dev() == 0
            || metadata.ino() == 0
        {
            return Err(ProtectedPromotionRepositoryErrorV1::UnsafeRepository);
        }
        let gateway_path = PathBuf::from(format!("/proc/self/fd/{}", repository.as_raw_fd()));
        Ok(ProtectedPromotionRepositoryV1 {
            _repository: repository,
            gateway_path,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = startup;
        Err(ProtectedPromotionRepositoryErrorV1::UnsupportedPlatform)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::host_config::parse_promotion_decision_host_config;
    use crate::host_config_loader::validate_promotion_decision_host_startup_from_trusted_anchor_for_test;
    use ed25519_dalek::SigningKey;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        anchor: tempfile::TempDir,
        authority_root: std::path::PathBuf,
        owner: u32,
    }

    impl Fixture {
        fn new() -> Self {
            let anchor = tempfile::tempdir().unwrap();
            let owner = unsafe { libc::geteuid() };
            fs::set_permissions(anchor.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let authority_root = anchor.path().join("authority");
            fs::create_dir(&authority_root).unwrap();
            fs::set_permissions(&authority_root, fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                anchor,
                authority_root,
                owner,
            }
        }

        fn startup(&self) -> crate::host_config_loader::ValidatedPromotionDecisionHostStartupV1 {
            let signer = |actor_id: &str, key_id: &str, seed: [u8; 32]| {
                let signing_key = SigningKey::from_bytes(&seed);
                json!({
                    "actor_id": actor_id,
                    "key_id": key_id,
                    "public_key": signing_key.verifying_key().to_bytes().to_vec(),
                })
            };
            let client_uid = if self.owner == 1 { 2 } else { 1 };
            let config = json!({
                "schema_version": 1,
                "run_id": "018f2e40-0000-7000-8000-000000000001",
                "broker_uid": self.owner,
                "promotion_decision_client_uids": [client_uid],
                "socket_group_gid": 1002,
                "authority_root": self.authority_root.to_string_lossy(),
                "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "kernel": signer("kernel", "kernel-main", [1; 32]),
                "operator": signer("operator", "operator-main", [2; 32]),
                "reviewers": [signer("reviewer", "reviewer-main", [3; 32])],
            });
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                parse_promotion_decision_host_config(&config.to_string()).unwrap(),
                self.anchor.path(),
                self.owner,
            )
            .unwrap()
        }

        fn create_repository(&self) -> std::path::PathBuf {
            let repository = self.authority_root.join("repository");
            fs::create_dir(&repository).unwrap();
            fs::set_permissions(&repository, fs::Permissions::from_mode(0o700)).unwrap();
            repository
        }
    }

    #[test]
    fn repository_is_opened_from_the_retained_root_without_following_symlinks() {
        let fixture = Fixture::new();
        let repository = fixture.create_repository();
        let startup = fixture.startup();
        let moved_root = fixture.anchor.path().join("authority-moved");
        fs::rename(&fixture.authority_root, &moved_root).unwrap();

        let custody = load_promotion_repository_v1(&startup)
            .expect("retained root resolves the fixed repository after pathname movement");
        assert_eq!(
            fs::canonicalize(custody.gateway_path()).unwrap(),
            fs::canonicalize(moved_root.join("repository")).unwrap()
        );
        assert!(!repository.exists());

        let symlink_fixture = Fixture::new();
        let external = symlink_fixture.anchor.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::set_permissions(&external, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&external, symlink_fixture.authority_root.join("repository")).unwrap();
        let symlink_startup = symlink_fixture.startup();
        assert!(load_promotion_repository_v1(&symlink_startup).is_err());
    }
}
