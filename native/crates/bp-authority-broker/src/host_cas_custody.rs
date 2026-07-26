//! Protected descriptor-bound CAS custody for the V5 admission host.

use crate::host_config_loader::ValidatedGovernedSessionHostStartupV1;
use bp_ledger::storage::cas::Cas;
use thiserror::Error;

#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

const CAS_DIRECTORY_NAME: &[u8] = b"cas";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedV5CasLoadError {
    #[cfg(not(target_os = "linux"))]
    #[error("protected V5 CAS loading is supported only on Linux")]
    UnsupportedPlatform,
    #[error("protected V5 CAS is unavailable or unsafe")]
    UnsafeCas,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CasDescriptorKind {
    Directory,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CasDescriptorFacts {
    kind: CasDescriptorKind,
    uid: u32,
    mode: u32,
    link_count: u64,
}

fn validate_cas_directory_facts(
    facts: CasDescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedV5CasLoadError> {
    if facts.kind != CasDescriptorKind::Directory
        || facts.uid != expected_owner
        || facts.mode & 0o7777 != 0o700
        || facts.link_count < 2
    {
        return Err(ProtectedV5CasLoadError::UnsafeCas);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) struct ProtectedV5CasV1 {
    // Field order keeps the Cas path usable until after Cas is dropped.
    cas: Cas,
    directory: File,
    root_path: PathBuf,
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct ProtectedV5CasV1;

#[cfg(target_os = "linux")]
impl ProtectedV5CasV1 {
    pub(crate) fn cas(&self) -> &Cas {
        &self.cas
    }

    pub(crate) fn root_path(&self) -> &Path {
        &self.root_path
    }
}

/// Open the sole existing CAS root accepted by protected V5 admission.
///
/// V5 admission currently resolves only signed inline tape payloads and does
/// not dereference a CAS object. This custody therefore proves the fixed CAS
/// root is present, private, descriptor-bound, and retained at startup; it
/// deliberately makes no per-object integrity claim until V5 evidence names
/// a canonical CAS reference.
pub(crate) fn load_protected_v5_cas_v1(
    authority_root: &File,
    expected_owner: u32,
) -> Result<ProtectedV5CasV1, ProtectedV5CasLoadError> {
    #[cfg(target_os = "linux")]
    {
        let component = std::ffi::CString::new(CAS_DIRECTORY_NAME)
            .map_err(|_| ProtectedV5CasLoadError::UnsafeCas)?;
        let descriptor = unsafe {
            libc::openat(
                authority_root.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(ProtectedV5CasLoadError::UnsafeCas);
        }
        let directory = unsafe { File::from_raw_fd(descriptor) };
        let metadata = directory
            .metadata()
            .map_err(|_| ProtectedV5CasLoadError::UnsafeCas)?;
        validate_cas_directory_facts(
            CasDescriptorFacts {
                kind: if metadata.file_type().is_dir() {
                    CasDescriptorKind::Directory
                } else {
                    CasDescriptorKind::Other
                },
                uid: metadata.uid(),
                mode: metadata.mode(),
                link_count: metadata.nlink(),
            },
            expected_owner,
        )?;
        let identity = (metadata.dev(), metadata.ino());
        let root_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        let cas = Cas::open(&root_path).map_err(|_| ProtectedV5CasLoadError::UnsafeCas)?;
        let reopened =
            std::fs::metadata(&root_path).map_err(|_| ProtectedV5CasLoadError::UnsafeCas)?;
        if (reopened.dev(), reopened.ino()) != identity {
            return Err(ProtectedV5CasLoadError::UnsafeCas);
        }
        Ok(ProtectedV5CasV1 {
            cas,
            directory,
            root_path,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (authority_root, expected_owner);
        Err(ProtectedV5CasLoadError::UnsupportedPlatform)
    }
}

pub(crate) fn load_governed_session_cas_v1(
    startup: &ValidatedGovernedSessionHostStartupV1,
) -> Result<ProtectedV5CasV1, ProtectedV5CasLoadError> {
    #[cfg(target_os = "linux")]
    {
        load_protected_v5_cas_v1(
            startup.authority_root().directory(),
            startup.config().broker_uid,
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = startup;
        Err(ProtectedV5CasLoadError::UnsupportedPlatform)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn protected_v5_cas_is_existing_fixed_descriptor_bound_storage() {
        let root = tempfile::tempdir().expect("authority root");
        let cas_path = root.path().join("cas");
        fs::create_dir(&cas_path).expect("existing CAS root");
        fs::set_permissions(&cas_path, fs::Permissions::from_mode(0o700))
            .expect("private CAS mode");
        let root_descriptor = std::fs::File::open(root.path()).expect("retained authority root");

        let custody = load_protected_v5_cas_v1(&root_descriptor, unsafe { libc::geteuid() })
            .expect("protected CAS custody");
        assert!(custody
            .cas()
            .get_bytes("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .is_err());
    }

    #[test]
    fn protected_v5_cas_rejects_missing_wrong_type_symlink_and_unsafe_mode_without_creation() {
        for variant in ["missing", "file", "symlink", "mode"] {
            let root = tempfile::tempdir().expect("authority root");
            let cas_path = root.path().join("cas");
            match variant {
                "file" => fs::write(&cas_path, b"not a directory").expect("CAS regular file"),
                "symlink" => symlink(root.path(), &cas_path).expect("CAS symlink"),
                "mode" => {
                    fs::create_dir(&cas_path).expect("CAS root");
                    fs::set_permissions(&cas_path, fs::Permissions::from_mode(0o755))
                        .expect("unsafe CAS mode");
                }
                _ => {}
            }
            let root_descriptor =
                std::fs::File::open(root.path()).expect("retained authority root");
            assert!(
                load_protected_v5_cas_v1(&root_descriptor, unsafe { libc::geteuid() },).is_err()
            );
            if variant == "missing" {
                assert!(!cas_path.exists(), "startup must not create missing CAS");
            }
        }
    }

    #[test]
    fn protected_v5_cas_rejects_owner_and_link_count_mismatch() {
        for facts in [
            CasDescriptorFacts {
                kind: CasDescriptorKind::Directory,
                uid: 41,
                mode: 0o40700,
                link_count: 2,
            },
            CasDescriptorFacts {
                kind: CasDescriptorKind::Directory,
                uid: 40,
                mode: 0o40700,
                link_count: 1,
            },
        ] {
            assert_eq!(
                validate_cas_directory_facts(facts, 40),
                Err(ProtectedV5CasLoadError::UnsafeCas)
            );
        }
    }

    #[test]
    fn protected_v5_cas_descriptor_survives_authority_root_substitution() {
        let anchor = tempfile::tempdir().expect("anchor");
        let root = anchor.path().join("authority");
        fs::create_dir(&root).expect("authority root");
        let cas_path = root.join("cas");
        fs::create_dir(&cas_path).expect("CAS root");
        fs::set_permissions(&cas_path, fs::Permissions::from_mode(0o700))
            .expect("private CAS mode");
        let root_descriptor = std::fs::File::open(&root).expect("retained authority root");
        let moved = anchor.path().join("authority-moved");
        fs::rename(&root, &moved).expect("substitute root pathname");
        fs::create_dir(&root).expect("replacement root");
        fs::create_dir(root.join("cas")).expect("replacement CAS");

        let custody = load_protected_v5_cas_v1(&root_descriptor, unsafe { libc::geteuid() })
            .expect("descriptor-bound original CAS");
        assert_eq!(
            fs::canonicalize(custody.root_path()).expect("custody path"),
            fs::canonicalize(moved.join("cas")).expect("moved original CAS")
        );
    }
}
