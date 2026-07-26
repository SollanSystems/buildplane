//! Descriptor-bound Anthropic credential custody for the governed-session host.
//!
//! Production discovery starts only from the already validated authority-root
//! descriptor. The credential has one fixed descriptor-relative location and
//! is opened fresh for each host-performed provider action. No path,
//! environment, CLI option, OCI mount, or worker-visible value participates.

use async_trait::async_trait;
use bp_provider_anthropic::{AnthropicApiCredentialV1, AnthropicCredentialBrokerV1};
use bp_provider_sdk::ProviderError;
use thiserror::Error;

#[cfg(target_os = "linux")]
use crate::host_config_loader::ValidatedAuthorityRootV1;
#[cfg(target_os = "linux")]
use std::fs::{File, Metadata};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use zeroize::Zeroizing;

const CREDENTIAL_DIRECTORY: &[u8] = b"credentials";
const CREDENTIAL_FILE_NAME: &[u8] = b"anthropic-api-key-v1";
const MAX_ANTHROPIC_CREDENTIAL_BYTES: usize = 8 * 1024;

/// Closed failures intentionally omit paths, metadata, errno, and secret
/// bytes. The caller may distinguish only absence from an unsafe deployment.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum ProtectedAnthropicCredentialLoadErrorV1 {
    #[cfg(not(target_os = "linux"))]
    #[error("protected Anthropic credential loading is supported only on Linux")]
    UnsupportedPlatform,
    #[error("protected Anthropic credential is unavailable")]
    Unavailable,
    #[error("protected Anthropic credential directory is unsafe")]
    UnsafeDirectory,
    #[error("protected Anthropic credential file is unsafe")]
    UnsafeFile,
    #[error("protected Anthropic credential exceeds the maximum permitted size")]
    TooLarge,
    #[error("protected Anthropic credential could not be read")]
    ReadFailed,
    #[error("protected Anthropic credential is invalid")]
    InvalidCredential,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialDescriptorKind {
    Directory,
    RegularFile,
    Other,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CredentialDescriptorFacts {
    kind: CredentialDescriptorKind,
    uid: u32,
    mode: u32,
    link_count: u64,
}

/// Host-only credential issuer. It retains only a duplicate of the validated
/// authority-root descriptor and the startup-bound broker UID. It is neither
/// cloneable nor serializable and never caches credential bytes.
#[cfg(target_os = "linux")]
pub(crate) struct ProtectedAnthropicCredentialBrokerV1 {
    authority_root: File,
    broker_uid: u32,
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct ProtectedAnthropicCredentialBrokerV1;

impl ProtectedAnthropicCredentialBrokerV1 {
    #[cfg(target_os = "linux")]
    pub(crate) fn from_validated_authority_root(
        authority_root: &ValidatedAuthorityRootV1,
        broker_uid: u32,
    ) -> Result<Self, ProviderError> {
        if broker_uid == 0 {
            return Err(credential_transport_error());
        }
        let authority_root = authority_root
            .directory()
            .try_clone()
            .map_err(|_| credential_transport_error())?;
        Ok(Self {
            authority_root,
            broker_uid,
        })
    }
}

#[async_trait]
impl AnthropicCredentialBrokerV1 for ProtectedAnthropicCredentialBrokerV1 {
    async fn available(&self) -> Result<bool, ProviderError> {
        #[cfg(target_os = "linux")]
        {
            match self.load() {
                Ok(credential) => {
                    drop(credential);
                    Ok(true)
                }
                Err(ProtectedAnthropicCredentialLoadErrorV1::Unavailable) => Ok(false),
                Err(_) => Err(credential_transport_error()),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(credential_transport_error())
        }
    }

    async fn issue_for_messages(&self) -> Result<AnthropicApiCredentialV1, ProviderError> {
        #[cfg(target_os = "linux")]
        {
            self.load().map_err(|_| credential_transport_error())
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(credential_transport_error())
        }
    }
}

fn credential_transport_error() -> ProviderError {
    ProviderError::Transport("protected Anthropic credential is unavailable".into())
}

#[cfg(target_os = "linux")]
impl ProtectedAnthropicCredentialBrokerV1 {
    fn load(&self) -> Result<AnthropicApiCredentialV1, ProtectedAnthropicCredentialLoadErrorV1> {
        let directory = open_directory_at(self.authority_root.as_raw_fd())?;
        validate_directory_facts(
            credential_descriptor_facts(
                &directory
                    .metadata()
                    .map_err(|_| ProtectedAnthropicCredentialLoadErrorV1::UnsafeDirectory)?,
            ),
            self.broker_uid,
        )?;

        let mut file = open_credential_file_at(directory.as_raw_fd())?;
        validate_file_facts(
            credential_descriptor_facts(
                &file
                    .metadata()
                    .map_err(|_| ProtectedAnthropicCredentialLoadErrorV1::UnsafeFile)?,
            ),
            self.broker_uid,
        )?;

        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_ANTHROPIC_CREDENTIAL_BYTES));
        file.take((MAX_ANTHROPIC_CREDENTIAL_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ProtectedAnthropicCredentialLoadErrorV1::ReadFailed)?;
        if bytes.len() > MAX_ANTHROPIC_CREDENTIAL_BYTES {
            return Err(ProtectedAnthropicCredentialLoadErrorV1::TooLarge);
        }

        // Transfer the sole allocation into the provider credential. The
        // credential type zeroizes it on validation failure and on drop.
        AnthropicApiCredentialV1::new(std::mem::take(&mut *bytes))
            .map_err(|_| ProtectedAnthropicCredentialLoadErrorV1::InvalidCredential)
    }
}

#[cfg(target_os = "linux")]
fn validate_directory_facts(
    facts: CredentialDescriptorFacts,
    broker_uid: u32,
) -> Result<(), ProtectedAnthropicCredentialLoadErrorV1> {
    if facts.kind != CredentialDescriptorKind::Directory
        || facts.uid != broker_uid
        || facts.mode != 0o700
    {
        return Err(ProtectedAnthropicCredentialLoadErrorV1::UnsafeDirectory);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_file_facts(
    facts: CredentialDescriptorFacts,
    broker_uid: u32,
) -> Result<(), ProtectedAnthropicCredentialLoadErrorV1> {
    if facts.kind != CredentialDescriptorKind::RegularFile
        || facts.uid != broker_uid
        || facts.link_count != 1
        || !matches!(facts.mode, 0o400 | 0o600)
    {
        return Err(ProtectedAnthropicCredentialLoadErrorV1::UnsafeFile);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_directory_at(
    authority_root_descriptor: RawFd,
) -> Result<File, ProtectedAnthropicCredentialLoadErrorV1> {
    let component =
        std::ffi::CString::new(CREDENTIAL_DIRECTORY).expect("fixed component has no NUL");
    let descriptor = unsafe {
        libc::openat(
            authority_root_descriptor,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(
        descriptor,
        ProtectedAnthropicCredentialLoadErrorV1::UnsafeDirectory,
    )
}

#[cfg(target_os = "linux")]
fn open_credential_file_at(
    directory_descriptor: RawFd,
) -> Result<File, ProtectedAnthropicCredentialLoadErrorV1> {
    let file_name =
        std::ffi::CString::new(CREDENTIAL_FILE_NAME).expect("fixed file name has no NUL");
    let descriptor = unsafe {
        libc::openat(
            directory_descriptor,
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(
        descriptor,
        ProtectedAnthropicCredentialLoadErrorV1::UnsafeFile,
    )
}

#[cfg(target_os = "linux")]
fn file_from_descriptor(
    descriptor: libc::c_int,
    error: ProtectedAnthropicCredentialLoadErrorV1,
) -> Result<File, ProtectedAnthropicCredentialLoadErrorV1> {
    if descriptor < 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            return Err(ProtectedAnthropicCredentialLoadErrorV1::Unavailable);
        }
        return Err(error);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn credential_descriptor_facts(metadata: &Metadata) -> CredentialDescriptorFacts {
    let kind = if metadata.file_type().is_dir() {
        CredentialDescriptorKind::Directory
    } else if metadata.file_type().is_file() {
        CredentialDescriptorKind::RegularFile
    } else {
        CredentialDescriptorKind::Other
    };
    CredentialDescriptorFacts {
        kind,
        uid: metadata.uid(),
        mode: metadata.mode() & 0o7777,
        link_count: metadata.nlink(),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::TempDir;

    struct CredentialFixture {
        _anchor: TempDir,
        root: ValidatedAuthorityRootV1,
        credential_directory: std::path::PathBuf,
        credential_file: std::path::PathBuf,
        owner: u32,
    }

    impl CredentialFixture {
        fn new(bytes: &[u8]) -> Self {
            let anchor = tempfile::tempdir().expect("temporary authority root");
            fs::set_permissions(anchor.path(), fs::Permissions::from_mode(0o700))
                .expect("private root");
            let credential_directory = anchor.path().join("credentials");
            fs::create_dir(&credential_directory).expect("credential directory");
            fs::set_permissions(&credential_directory, fs::Permissions::from_mode(0o700))
                .expect("private credential directory");
            let credential_file = credential_directory.join("anthropic-api-key-v1");
            fs::write(&credential_file, bytes).expect("credential");
            fs::set_permissions(&credential_file, fs::Permissions::from_mode(0o600))
                .expect("private credential");
            let root = ValidatedAuthorityRootV1::new(
                File::open(anchor.path()).expect("authority-root descriptor"),
            );
            Self {
                _anchor: anchor,
                root,
                credential_directory,
                credential_file,
                owner: unsafe { libc::geteuid() },
            }
        }

        fn broker(&self) -> ProtectedAnthropicCredentialBrokerV1 {
            ProtectedAnthropicCredentialBrokerV1::from_validated_authority_root(
                &self.root, self.owner,
            )
            .expect("credential broker")
        }
    }

    #[test]
    fn issues_only_a_valid_descriptor_bound_credential() {
        let fixture = CredentialFixture::new(b"short-lived-host-secret");
        let broker = fixture.broker();
        assert!(block_on(broker.available()).expect("availability"));
        let credential = block_on(broker.issue_for_messages()).expect("credential");
        assert_eq!(
            format!("{credential:?}"),
            "AnthropicApiCredentialV1([REDACTED])"
        );
    }

    #[test]
    fn missing_credential_reports_unavailable_without_authority() {
        let fixture = CredentialFixture::new(b"short-lived-host-secret");
        fs::remove_file(&fixture.credential_file).expect("remove credential");
        let broker = fixture.broker();
        assert!(!block_on(broker.available()).expect("closed absence"));
        assert_eq!(
            block_on(broker.issue_for_messages())
                .expect_err("missing credential")
                .to_string(),
            "provider transport failure: protected Anthropic credential is unavailable"
        );
    }

    #[test]
    fn rejects_symlinks_hardlinks_and_unsafe_permissions() {
        let fixture = CredentialFixture::new(b"short-lived-host-secret");
        let original = fixture.credential_directory.join("original");
        fs::rename(&fixture.credential_file, &original).expect("move credential");
        symlink(&original, &fixture.credential_file).expect("credential symlink");
        assert!(block_on(fixture.broker().available()).is_err());

        fs::remove_file(&fixture.credential_file).expect("remove symlink");
        fs::hard_link(&original, &fixture.credential_file).expect("credential hardlink");
        assert!(block_on(fixture.broker().available()).is_err());

        fs::remove_file(&fixture.credential_file).expect("remove hardlink");
        fs::rename(&original, &fixture.credential_file).expect("restore credential");
        fs::set_permissions(&fixture.credential_file, fs::Permissions::from_mode(0o640))
            .expect("unsafe credential mode");
        assert!(block_on(fixture.broker().available()).is_err());
    }

    #[test]
    fn rejects_unsafe_directory_invalid_content_and_oversized_secret() {
        let fixture = CredentialFixture::new(b"short-lived-host-secret");
        fs::set_permissions(
            &fixture.credential_directory,
            fs::Permissions::from_mode(0o750),
        )
        .expect("unsafe directory mode");
        assert!(block_on(fixture.broker().available()).is_err());

        fs::set_permissions(
            &fixture.credential_directory,
            fs::Permissions::from_mode(0o700),
        )
        .expect("restore directory mode");
        fs::write(&fixture.credential_file, b"secret\n").expect("invalid credential");
        assert!(block_on(fixture.broker().available()).is_err());

        fs::write(
            &fixture.credential_file,
            vec![b'x'; MAX_ANTHROPIC_CREDENTIAL_BYTES + 1],
        )
        .expect("oversized credential");
        assert!(block_on(fixture.broker().available()).is_err());
    }
}
