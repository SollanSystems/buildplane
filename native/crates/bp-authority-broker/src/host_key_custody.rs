//! Descriptor-bound private signing-key custody for the promotion-decision host.
//!
//! Production key discovery begins only from the authority-root descriptor
//! retained by protected host startup. No path, environment, or CLI override is
//! accepted at this boundary.

use crate::host_config_loader::ValidatedPromotionDecisionHostStartupV1;
use ed25519_dalek::SigningKey;
use thiserror::Error;

#[cfg(target_os = "linux")]
use bp_ledger::keyring::KeyringRef;
#[cfg(target_os = "linux")]
use bp_ledger::signing::{public_key_hash, ActorKeyRef};
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
use std::path::{Component, Path};
#[cfg(target_os = "linux")]
use zeroize::Zeroizing;

/// Closed failures for protected private-key loading.
///
/// Error variants intentionally omit paths, actor/key identities, metadata,
/// public-key hashes, seed bytes, and raw operating-system errors.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedHostKeyLoadError {
    #[cfg(not(target_os = "linux"))]
    #[error("protected host key loading is supported only on Linux")]
    UnsupportedPlatform,
    #[error("protected host key path is invalid")]
    InvalidKeyLayout,
    #[error("protected host key directory is unavailable or unsafe")]
    UnsafeKeyDirectory,
    #[error("protected host key file is unavailable or unsafe")]
    UnsafeKeyFile,
    #[error("protected host key seed has an invalid length")]
    InvalidSeedLength,
    #[error("protected host key could not be read")]
    ReadFailed,
    #[error("protected host key does not match its configured public identity")]
    PublicKeyMismatch,
    #[error("protected host signing roles must use distinct key material")]
    AliasedKeyMaterial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyDescriptorKind {
    Directory,
    RegularFile,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KeyDescriptorFacts {
    kind: KeyDescriptorKind,
    uid: u32,
    mode: u32,
    link_count: u64,
}

fn validate_key_directory_facts(
    facts: KeyDescriptorFacts,
    broker_uid: u32,
) -> Result<(), ProtectedHostKeyLoadError> {
    if facts.kind != KeyDescriptorKind::Directory || facts.uid != broker_uid || facts.mode != 0o700
    {
        return Err(ProtectedHostKeyLoadError::UnsafeKeyDirectory);
    }
    Ok(())
}

fn validate_key_file_facts(
    facts: KeyDescriptorFacts,
    broker_uid: u32,
) -> Result<(), ProtectedHostKeyLoadError> {
    if facts.kind != KeyDescriptorKind::RegularFile
        || facts.uid != broker_uid
        || facts.link_count != 1
        || !matches!(facts.mode, 0o400 | 0o600)
    {
        return Err(ProtectedHostKeyLoadError::UnsafeKeyFile);
    }
    Ok(())
}

/// Host-owned signing keys required to record and checkpoint promotion
/// decisions. This runtime-only value is intentionally neither cloneable nor
/// serializable.
pub(crate) struct ProtectedPromotionDecisionSigningKeysV1 {
    kernel: SigningKey,
    operator: SigningKey,
}

impl ProtectedPromotionDecisionSigningKeysV1 {
    pub(crate) fn kernel(&self) -> &SigningKey {
        &self.kernel
    }

    pub(crate) fn operator(&self) -> &SigningKey {
        &self.operator
    }
}

pub(crate) fn load_promotion_decision_signing_keys_v1(
    startup: &ValidatedPromotionDecisionHostStartupV1,
) -> Result<ProtectedPromotionDecisionSigningKeysV1, ProtectedHostKeyLoadError> {
    #[cfg(target_os = "linux")]
    {
        let broker_uid = startup.config().broker_uid;
        let authority_root = startup.authority_root().directory();
        let kernel = load_signing_key_from_authority_descriptor(
            authority_root,
            &startup.config().kernel_signer,
            broker_uid,
        )?;
        let operator = load_signing_key_from_authority_descriptor(
            authority_root,
            &startup.config().operator_signer,
            broker_uid,
        )?;
        if kernel.verifying_key() == operator.verifying_key() {
            return Err(ProtectedHostKeyLoadError::AliasedKeyMaterial);
        }
        Ok(ProtectedPromotionDecisionSigningKeysV1 { kernel, operator })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = startup;
        Err(ProtectedHostKeyLoadError::UnsupportedPlatform)
    }
}

#[cfg(target_os = "linux")]
fn load_signing_key_from_authority_descriptor(
    authority_root: &File,
    signer: &ActorKeyRef,
    broker_uid: u32,
) -> Result<SigningKey, ProtectedHostKeyLoadError> {
    let components = key_components(signer)?;
    let (file_name, directories) = components
        .split_last()
        .ok_or(ProtectedHostKeyLoadError::InvalidKeyLayout)?;

    let mut current_directory: Option<File> = None;
    let mut parent_descriptor = authority_root.as_raw_fd();
    for component in directories {
        let child = open_key_directory_at(parent_descriptor, component)?;
        validate_key_directory_facts(
            key_descriptor_facts(
                &child
                    .metadata()
                    .map_err(|_| ProtectedHostKeyLoadError::UnsafeKeyDirectory)?,
            ),
            broker_uid,
        )?;
        parent_descriptor = child.as_raw_fd();
        current_directory = Some(child);
    }

    // Keep the final parent alive until the key file has been opened.
    let _current_directory = current_directory;
    let file = open_key_file_at(parent_descriptor, file_name)?;
    validate_key_file_facts(
        key_descriptor_facts(
            &file
                .metadata()
                .map_err(|_| ProtectedHostKeyLoadError::UnsafeKeyFile)?,
        ),
        broker_uid,
    )?;

    let signing_key = read_signing_key_seed(file)?;

    let expected_hash = signer
        .public_key_hash
        .as_deref()
        .ok_or(ProtectedHostKeyLoadError::PublicKeyMismatch)?;
    if public_key_hash(&signing_key.verifying_key()) != expected_hash {
        return Err(ProtectedHostKeyLoadError::PublicKeyMismatch);
    }
    Ok(signing_key)
}

/// Read a raw Ed25519 seed through RAII-backed buffers. Both the growable
/// partial-read buffer and the fixed-size seed copy are guaranteed to be
/// zeroized on every return path, including an I/O error after a partial read.
#[cfg(target_os = "linux")]
fn read_signing_key_seed(reader: impl Read) -> Result<SigningKey, ProtectedHostKeyLoadError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(33));
    reader
        .take(33)
        .read_to_end(&mut bytes)
        .map_err(|_| ProtectedHostKeyLoadError::ReadFailed)?;
    if bytes.len() != 32 {
        return Err(ProtectedHostKeyLoadError::InvalidSeedLength);
    }
    let mut seed = Zeroizing::new([0_u8; 32]);
    seed.copy_from_slice(&bytes);
    Ok(SigningKey::from_bytes(&seed))
}

#[cfg(target_os = "linux")]
fn key_components(signer: &ActorKeyRef) -> Result<Vec<Vec<u8>>, ProtectedHostKeyLoadError> {
    let path = KeyringRef::new(&signer.actor_id, &signer.key_id)
        .path_under(Path::new("keys"))
        .map_err(|_| ProtectedHostKeyLoadError::InvalidKeyLayout)?;
    let components = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => {
                let bytes = value.as_bytes();
                if bytes.is_empty() || bytes.contains(&0) {
                    return Err(ProtectedHostKeyLoadError::InvalidKeyLayout);
                }
                Ok(bytes.to_vec())
            }
            _ => Err(ProtectedHostKeyLoadError::InvalidKeyLayout),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.len() < 3 {
        return Err(ProtectedHostKeyLoadError::InvalidKeyLayout);
    }
    Ok(components)
}

#[cfg(target_os = "linux")]
fn open_key_directory_at(
    parent_descriptor: RawFd,
    component: &[u8],
) -> Result<File, ProtectedHostKeyLoadError> {
    let component = std::ffi::CString::new(component)
        .map_err(|_| ProtectedHostKeyLoadError::InvalidKeyLayout)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(descriptor, ProtectedHostKeyLoadError::UnsafeKeyDirectory)
}

#[cfg(target_os = "linux")]
fn open_key_file_at(
    parent_descriptor: RawFd,
    file_name: &[u8],
) -> Result<File, ProtectedHostKeyLoadError> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| ProtectedHostKeyLoadError::InvalidKeyLayout)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(descriptor, ProtectedHostKeyLoadError::UnsafeKeyFile)
}

#[cfg(target_os = "linux")]
fn file_from_descriptor(
    descriptor: libc::c_int,
    error: ProtectedHostKeyLoadError,
) -> Result<File, ProtectedHostKeyLoadError> {
    if descriptor < 0 {
        return Err(error);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn key_descriptor_facts(metadata: &Metadata) -> KeyDescriptorFacts {
    let kind = if metadata.file_type().is_dir() {
        KeyDescriptorKind::Directory
    } else if metadata.file_type().is_file() {
        KeyDescriptorKind::RegularFile
    } else {
        KeyDescriptorKind::Other
    };
    KeyDescriptorFacts {
        kind,
        uid: metadata.uid(),
        mode: metadata.mode() & 0o7777,
        link_count: metadata.nlink(),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::host_config::parse_promotion_decision_host_config;
    use crate::host_config_loader::validate_promotion_decision_host_startup_from_trusted_anchor_for_test;
    use serde_json::json;
    use std::fs;
    use std::io::{self, Read};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    struct KeyFixture {
        _anchor: TempDir,
        authority_root: PathBuf,
        owner: u32,
    }

    impl KeyFixture {
        fn new() -> Self {
            let anchor = tempfile::tempdir().expect("temporary test anchor");
            set_mode(anchor.path(), 0o700);
            let authority_root = anchor.path().join("authority");
            create_private_directory(&authority_root);
            Self {
                _anchor: anchor,
                authority_root,
                owner: unsafe { libc::geteuid() },
            }
        }

        fn startup(
            &self,
            kernel_seed: [u8; 32],
            operator_seed: [u8; 32],
        ) -> ValidatedPromotionDecisionHostStartupV1 {
            self.startup_from_config(self.config(kernel_seed, operator_seed))
        }

        fn config(
            &self,
            kernel_seed: [u8; 32],
            operator_seed: [u8; 32],
        ) -> crate::host_config::PromotionDecisionHostConfigV1 {
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
                "kernel": signer("kernel", "kernel-main", kernel_seed),
                "operator": signer("operator:primary", "operator-main", operator_seed),
                "reviewers": [signer("reviewer", "reviewer-main", [3; 32])],
            });
            parse_promotion_decision_host_config(&config.to_string())
                .expect("valid key-custody config")
        }

        fn startup_from_config(
            &self,
            config: crate::host_config::PromotionDecisionHostConfigV1,
        ) -> ValidatedPromotionDecisionHostStartupV1 {
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                self._anchor.path(),
                self.owner,
            )
            .expect("validated test startup")
        }

        fn write_key(&self, actor_components: &[&str], key_id: &str, bytes: &[u8]) -> PathBuf {
            let mut directory = self.authority_root.join("keys");
            if !directory.exists() {
                create_private_directory(&directory);
            }
            for component in actor_components {
                directory.push(component);
                if !directory.exists() {
                    create_private_directory(&directory);
                }
            }
            let path = directory.join(format!("{key_id}.ed25519"));
            fs::write(&path, bytes).expect("write fixture key");
            set_mode(&path, 0o600);
            path
        }
    }

    fn create_private_directory(path: &Path) {
        fs::create_dir(path).expect("create fixture directory");
        set_mode(path, 0o700);
    }

    fn set_mode(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set fixture mode");
    }

    fn load_error(startup: &ValidatedPromotionDecisionHostStartupV1) -> ProtectedHostKeyLoadError {
        match load_promotion_decision_signing_keys_v1(startup) {
            Ok(_) => panic!("protected key load unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    #[test]
    fn loads_kernel_and_scoped_operator_keys_from_the_retained_descriptor() {
        let fixture = KeyFixture::new();
        let kernel_seed = [1; 32];
        let operator_seed = [2; 32];
        fixture.write_key(&["kernel"], "kernel-main", &kernel_seed);
        let operator = fixture.write_key(&["operator", "primary"], "operator-main", &operator_seed);
        set_mode(&operator, 0o400);
        let startup = fixture.startup(kernel_seed, operator_seed);

        fs::rename(
            &fixture.authority_root,
            fixture._anchor.path().join("authority-moved"),
        )
        .expect("move authority root after startup validation");

        let keys = load_promotion_decision_signing_keys_v1(&startup)
            .expect("descriptor-bound keys load after pathname move");
        assert_eq!(keys.kernel().to_bytes(), kernel_seed);
        assert_eq!(keys.operator().to_bytes(), operator_seed);
    }

    #[test]
    fn rejects_short_and_long_seed_files() {
        for seed_bytes in [vec![1; 31], vec![1; 33]] {
            let fixture = KeyFixture::new();
            fixture.write_key(&["kernel"], "kernel-main", &seed_bytes);
            fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
            let startup = fixture.startup([1; 32], [2; 32]);

            assert_eq!(
                load_error(&startup),
                ProtectedHostKeyLoadError::InvalidSeedLength
            );
        }
    }

    #[test]
    fn rejects_a_seed_that_does_not_match_the_pinned_public_key_hash() {
        let fixture = KeyFixture::new();
        fixture.write_key(&["kernel"], "kernel-main", &[9; 32]);
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        let startup = fixture.startup([1; 32], [2; 32]);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::PublicKeyMismatch
        );
    }

    #[test]
    fn rejects_kernel_and_operator_resolving_to_the_same_key_material() {
        let fixture = KeyFixture::new();
        fixture.write_key(&["kernel"], "kernel-main", &[1; 32]);
        fixture.write_key(&["operator", "primary"], "operator-main", &[1; 32]);
        let mut config = fixture.config([1; 32], [2; 32]);
        config.operator_signer.public_key_hash = config.kernel_signer.public_key_hash.clone();
        let startup = fixture.startup_from_config(config);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::AliasedKeyMaterial
        );
    }

    #[test]
    fn rejects_a_symlinked_key_directory() {
        let fixture = KeyFixture::new();
        let keys = fixture.authority_root.join("keys");
        create_private_directory(&keys);
        let target = fixture.authority_root.join("kernel-target");
        create_private_directory(&target);
        let target_key = target.join("kernel-main.ed25519");
        fs::write(&target_key, [1; 32]).expect("write target key");
        set_mode(&target_key, 0o600);
        symlink(&target, keys.join("kernel")).expect("symlink actor directory");
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        let startup = fixture.startup([1; 32], [2; 32]);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::UnsafeKeyDirectory
        );
    }

    #[test]
    fn rejects_a_symlinked_key_file() {
        let fixture = KeyFixture::new();
        let target = fixture.write_key(&["kernel"], "alternate", &[1; 32]);
        symlink(
            &target,
            fixture
                .authority_root
                .join("keys/kernel/kernel-main.ed25519"),
        )
        .expect("symlink key file");
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        let startup = fixture.startup([1; 32], [2; 32]);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::UnsafeKeyFile
        );
    }

    #[test]
    fn rejects_a_hard_linked_key_file() {
        let fixture = KeyFixture::new();
        let key = fixture.write_key(&["kernel"], "kernel-main", &[1; 32]);
        fs::hard_link(
            &key,
            fixture
                .authority_root
                .join("keys/kernel/kernel-copy.ed25519"),
        )
        .expect("hard-link key file");
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        let startup = fixture.startup([1; 32], [2; 32]);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::UnsafeKeyFile
        );
    }

    #[test]
    fn rejects_a_special_key_file_without_blocking_on_it() {
        let fixture = KeyFixture::new();
        let keys = fixture.authority_root.join("keys");
        create_private_directory(&keys);
        let kernel = keys.join("kernel");
        create_private_directory(&kernel);
        let key_path = kernel.join("kernel-main.ed25519");
        let key_path_c = std::ffi::CString::new(key_path.as_os_str().as_bytes())
            .expect("fixture path has no NUL");
        assert_eq!(
            unsafe { libc::mkfifo(key_path_c.as_ptr(), 0o600) },
            0,
            "create fixture FIFO"
        );
        set_mode(&key_path, 0o600);
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        let startup = fixture.startup([1; 32], [2; 32]);

        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::UnsafeKeyFile
        );
    }

    #[test]
    fn rejects_unsafe_key_directory_and_file_modes() {
        let fixture = KeyFixture::new();
        let kernel = fixture.write_key(&["kernel"], "kernel-main", &[1; 32]);
        fixture.write_key(&["operator", "primary"], "operator-main", &[2; 32]);
        set_mode(&fixture.authority_root.join("keys/kernel"), 0o750);
        let startup = fixture.startup([1; 32], [2; 32]);
        assert_eq!(
            load_error(&startup),
            ProtectedHostKeyLoadError::UnsafeKeyDirectory
        );

        set_mode(&fixture.authority_root.join("keys/kernel"), 0o700);
        for unsafe_mode in [0o640, 0o700] {
            set_mode(&kernel, unsafe_mode);
            assert_eq!(
                load_error(&startup),
                ProtectedHostKeyLoadError::UnsafeKeyFile
            );
        }
    }

    #[test]
    fn metadata_policy_rejects_wrong_ownership_without_requiring_chown() {
        let wrong_owner = 2001;
        let broker_uid = 2002;

        assert_eq!(
            validate_key_directory_facts(
                KeyDescriptorFacts {
                    kind: KeyDescriptorKind::Directory,
                    uid: wrong_owner,
                    mode: 0o700,
                    link_count: 1,
                },
                broker_uid,
            ),
            Err(ProtectedHostKeyLoadError::UnsafeKeyDirectory)
        );
        assert_eq!(
            validate_key_file_facts(
                KeyDescriptorFacts {
                    kind: KeyDescriptorKind::RegularFile,
                    uid: wrong_owner,
                    mode: 0o600,
                    link_count: 1,
                },
                broker_uid,
            ),
            Err(ProtectedHostKeyLoadError::UnsafeKeyFile)
        );
    }

    #[test]
    fn closed_errors_do_not_expose_sensitive_identifiers_or_metadata() {
        let forbidden = [
            "kernel-main",
            "operator-main",
            "sha256:",
            "/authority",
            "uid",
            "mode",
            "permission denied",
        ];
        for error in [
            ProtectedHostKeyLoadError::InvalidKeyLayout,
            ProtectedHostKeyLoadError::UnsafeKeyDirectory,
            ProtectedHostKeyLoadError::UnsafeKeyFile,
            ProtectedHostKeyLoadError::InvalidSeedLength,
            ProtectedHostKeyLoadError::ReadFailed,
            ProtectedHostKeyLoadError::PublicKeyMismatch,
            ProtectedHostKeyLoadError::AliasedKeyMaterial,
        ] {
            let rendered = error.to_string().to_ascii_lowercase();
            for secret in forbidden {
                assert!(
                    !rendered.contains(secret),
                    "closed error leaked forbidden detail: {rendered}"
                );
            }
        }
    }

    struct PartialSecretThenError {
        emitted: bool,
    }

    impl Read for PartialSecretThenError {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.emitted {
                return Err(io::Error::other("raw-os-error-containing-transient-secret"));
            }
            self.emitted = true;
            let partial_secret = [0xabu8; 16];
            buffer[..partial_secret.len()].copy_from_slice(&partial_secret);
            Ok(partial_secret.len())
        }
    }

    #[test]
    fn partial_seed_read_errors_through_the_closed_raii_buffer_path() {
        let error = match read_signing_key_seed(PartialSecretThenError { emitted: false }) {
            Ok(_) => panic!("a partial read followed by an error must fail closed"),
            Err(error) => error,
        };

        assert_eq!(error, ProtectedHostKeyLoadError::ReadFailed);
        let rendered = error.to_string();
        assert!(!rendered.contains("transient-secret"));
        assert!(!rendered.contains("171"));
    }
}
