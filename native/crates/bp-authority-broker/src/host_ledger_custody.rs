//! Descriptor-bound custody for the promotion-decision host ledger.
//!
//! Production has one fixed layout beneath the already-validated authority
//! root: `ledger/events.db`. Both components are opened with `openat(2)` from
//! the retained root descriptor. SQLite receives only an internally-generated
//! `/proc/self/fd` path, so neither deployment paths nor controller input can
//! select the durable authority realm.

use crate::host_config_loader::ValidatedPromotionDecisionHostStartupV1;
use bp_ledger::storage::sqlite::SqliteStore;
use thiserror::Error;

#[cfg(target_os = "linux")]
use std::fs::{File, Metadata};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

const LEDGER_DIRECTORY_NAME: &[u8] = b"ledger";
const LEDGER_DATABASE_NAME: &[u8] = b"events.db";
const SQLITE_SIDECAR_NAMES: [&[u8]; 3] = [b"events.db-wal", b"events.db-shm", b"events.db-journal"];

/// Closed startup failures. No variant renders a deployment path, descriptor,
/// owner, mode, database identity, errno, SQLite message, or ledger content.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedHostLedgerLoadError {
    #[cfg(not(target_os = "linux"))]
    #[error("protected host ledger loading is supported only on Linux")]
    UnsupportedPlatform,
    #[error("protected host ledger directory is unavailable or unsafe")]
    UnsafeLedgerDirectory,
    #[error("protected host ledger database is unavailable or unsafe")]
    UnsafeLedgerDatabase,
    #[error("protected host ledger could not be opened")]
    LedgerOpenFailed,
    #[error("protected host ledger identity could not be established")]
    LedgerIdentityMismatch,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DatabaseIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LedgerDescriptorKind {
    Directory,
    RegularFile,
    Other,
}

/// Pure descriptor metadata used to test the protected ownership policy even
/// when the test process cannot change file ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LedgerDescriptorFacts {
    kind: LedgerDescriptorKind,
    uid: u32,
    mode: u32,
    link_count: u64,
    size: u64,
}

/// Startup-owned ledger custody. This type is intentionally neither cloneable
/// nor serializable. The ledger-directory descriptor stays alive for every
/// `/proc/self/fd/...` lookup performed through the store or recovery path.
#[cfg(target_os = "linux")]
pub(crate) struct ProtectedPromotionDecisionLedgerV1 {
    // Field order is intentional: the SQLite connection closes before the
    // descriptors that bind its primary and derived sidecar paths.
    store: SqliteStore,
    database: File,
    sqlite_sidecars: Vec<File>,
    ledger_directory: File,
    recovery_database_path: PathBuf,
}

#[cfg(not(target_os = "linux"))]
pub(crate) struct ProtectedPromotionDecisionLedgerV1;

#[cfg(target_os = "linux")]
impl ProtectedPromotionDecisionLedgerV1 {
    pub(crate) fn store(&self) -> &SqliteStore {
        &self.store
    }

    pub(crate) fn recovery_database_path(&self) -> &Path {
        &self.recovery_database_path
    }
}

/// Load the sole protected ledger accepted by the promotion-decision host.
///
/// No production caller can provide a path or request creation. The URI's
/// `mode=rw` is defense in depth against disappearance between the descriptor
/// validation and SQLite open; the directory's exact 0700 policy excludes
/// untrusted traversal or replacement.
pub(crate) fn load_promotion_decision_ledger_v1(
    startup: &ValidatedPromotionDecisionHostStartupV1,
) -> Result<ProtectedPromotionDecisionLedgerV1, ProtectedHostLedgerLoadError> {
    #[cfg(target_os = "linux")]
    {
        let expected_owner = startup.config().broker_uid;
        let ledger_directory = open_directory_at(
            startup.authority_root().directory().as_raw_fd(),
            LEDGER_DIRECTORY_NAME,
        )?;
        validate_ledger_directory_metadata(&ledger_directory, expected_owner)?;

        let database = open_database_at(ledger_directory.as_raw_fd())?;
        let database_metadata = database
            .metadata()
            .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)?;
        validate_ledger_database_metadata(&database_metadata, expected_owner)?;
        let validated_identity = database_identity(&database_metadata);
        validate_existing_sqlite_sidecars(ledger_directory.as_raw_fd(), expected_owner)?;

        let recovery_database_path = PathBuf::from(format!(
            "/proc/self/fd/{}/events.db",
            ledger_directory.as_raw_fd()
        ));
        let sqlite_uri = PathBuf::from(format!(
            "file:/proc/self/fd/{}/events.db?mode=rw",
            ledger_directory.as_raw_fd()
        ));
        let store = SqliteStore::open(&sqlite_uri)
            .map_err(|_| ProtectedHostLedgerLoadError::LedgerOpenFailed)?;

        let store_path = store
            .canonical_database_path()
            .map_err(|_| ProtectedHostLedgerLoadError::LedgerIdentityMismatch)?;
        let recovery_target = std::fs::canonicalize(&recovery_database_path)
            .map_err(|_| ProtectedHostLedgerLoadError::LedgerIdentityMismatch)?;
        if store_path != recovery_target {
            return Err(ProtectedHostLedgerLoadError::LedgerIdentityMismatch);
        }
        let reopened_metadata = std::fs::metadata(&store_path)
            .map_err(|_| ProtectedHostLedgerLoadError::LedgerIdentityMismatch)?;
        if database_identity(&reopened_metadata) != validated_identity {
            return Err(ProtectedHostLedgerLoadError::LedgerIdentityMismatch);
        }
        let sqlite_sidecars =
            open_and_validate_sqlite_sidecars(ledger_directory.as_raw_fd(), expected_owner)?;

        Ok(ProtectedPromotionDecisionLedgerV1 {
            store,
            database,
            sqlite_sidecars,
            ledger_directory,
            recovery_database_path,
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = startup;
        Err(ProtectedHostLedgerLoadError::UnsupportedPlatform)
    }
}

#[cfg(target_os = "linux")]
fn open_directory_at(
    parent_descriptor: RawFd,
    component: &[u8],
) -> Result<File, ProtectedHostLedgerLoadError> {
    let component = std::ffi::CString::new(component)
        .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDirectory)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(
        descriptor,
        ProtectedHostLedgerLoadError::UnsafeLedgerDirectory,
    )
}

#[cfg(target_os = "linux")]
fn open_database_at(
    ledger_directory_descriptor: RawFd,
) -> Result<File, ProtectedHostLedgerLoadError> {
    let file_name = std::ffi::CString::new(LEDGER_DATABASE_NAME)
        .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)?;
    let descriptor = unsafe {
        libc::openat(
            ledger_directory_descriptor,
            file_name.as_ptr(),
            libc::O_RDWR | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    file_from_descriptor(
        descriptor,
        ProtectedHostLedgerLoadError::UnsafeLedgerDatabase,
    )
}

#[cfg(target_os = "linux")]
fn file_from_descriptor(
    descriptor: libc::c_int,
    error: ProtectedHostLedgerLoadError,
) -> Result<File, ProtectedHostLedgerLoadError> {
    if descriptor < 0 {
        return Err(error);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn validate_ledger_directory_metadata(
    directory: &File,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    let metadata = directory
        .metadata()
        .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDirectory)?;
    validate_ledger_directory_facts(ledger_descriptor_facts(&metadata), expected_owner)
}

#[cfg(target_os = "linux")]
fn validate_ledger_database_metadata(
    metadata: &Metadata,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    validate_ledger_database_facts(ledger_descriptor_facts(metadata), expected_owner)
}

fn validate_ledger_directory_facts(
    facts: LedgerDescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    if facts.kind != LedgerDescriptorKind::Directory
        || facts.uid != expected_owner
        || facts.mode != 0o700
    {
        return Err(ProtectedHostLedgerLoadError::UnsafeLedgerDirectory);
    }
    Ok(())
}

fn validate_ledger_database_facts(
    facts: LedgerDescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    if facts.kind != LedgerDescriptorKind::RegularFile
        || facts.uid != expected_owner
        || facts.mode != 0o600
        || facts.link_count != 1
        || facts.size == 0
    {
        return Err(ProtectedHostLedgerLoadError::UnsafeLedgerDatabase);
    }
    Ok(())
}

fn validate_sqlite_sidecar_facts(
    facts: LedgerDescriptorFacts,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    if facts.kind != LedgerDescriptorKind::RegularFile
        || facts.uid != expected_owner
        || facts.mode != 0o600
        || facts.link_count != 1
    {
        return Err(ProtectedHostLedgerLoadError::UnsafeLedgerDatabase);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn ledger_descriptor_facts(metadata: &Metadata) -> LedgerDescriptorFacts {
    let kind = if metadata.file_type().is_dir() {
        LedgerDescriptorKind::Directory
    } else if metadata.file_type().is_file() {
        LedgerDescriptorKind::RegularFile
    } else {
        LedgerDescriptorKind::Other
    };
    LedgerDescriptorFacts {
        kind,
        uid: metadata.uid(),
        mode: metadata.mode() & 0o7777,
        link_count: metadata.nlink(),
        size: metadata.len(),
    }
}

#[cfg(target_os = "linux")]
fn validate_existing_sqlite_sidecars(
    ledger_directory_descriptor: RawFd,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    for name in SQLITE_SIDECAR_NAMES {
        if let Some(sidecar) = open_optional_file_at(ledger_directory_descriptor, name)? {
            validate_sqlite_sidecar_metadata(&sidecar, expected_owner)?;
        }
    }
    Ok(())
}

/// Reopen and retain every SQLite sidecar that exists after connection
/// initialization. The bundled Unix VFS creates WAL/journal files with the
/// primary database's mode and creates SHM with `(db.st_mode & 0777)`, both
/// using `O_NOFOLLOW`; requiring the primary database to be exactly 0600
/// therefore provides a per-connection owner-only creation policy without a
/// process-global `umask` mutation. Revalidation catches any unsafe
/// pre-existing sidecar before the authority host becomes available.
#[cfg(target_os = "linux")]
fn open_and_validate_sqlite_sidecars(
    ledger_directory_descriptor: RawFd,
    expected_owner: u32,
) -> Result<Vec<File>, ProtectedHostLedgerLoadError> {
    let mut retained = Vec::new();
    for name in SQLITE_SIDECAR_NAMES {
        if let Some(sidecar) = open_optional_file_at(ledger_directory_descriptor, name)? {
            validate_sqlite_sidecar_metadata(&sidecar, expected_owner)?;
            retained.push(sidecar);
        }
    }
    Ok(retained)
}

#[cfg(target_os = "linux")]
fn validate_sqlite_sidecar_metadata(
    sidecar: &File,
    expected_owner: u32,
) -> Result<(), ProtectedHostLedgerLoadError> {
    let metadata = sidecar
        .metadata()
        .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)?;
    validate_sqlite_sidecar_facts(ledger_descriptor_facts(&metadata), expected_owner)
}

#[cfg(target_os = "linux")]
fn open_optional_file_at(
    parent_descriptor: RawFd,
    file_name: &[u8],
) -> Result<Option<File>, ProtectedHostLedgerLoadError> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            file_name.as_ptr(),
            libc::O_RDWR | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor >= 0 {
        return Ok(Some(unsafe { File::from_raw_fd(descriptor) }));
    }
    let errno = std::io::Error::last_os_error().raw_os_error();
    if errno == Some(libc::ENOENT) {
        return Ok(None);
    }
    Err(ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)
}

#[cfg(target_os = "linux")]
fn database_identity(metadata: &Metadata) -> DatabaseIdentity {
    DatabaseIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::host_config::parse_promotion_decision_host_config;
    use crate::host_config_loader::{
        validate_promotion_decision_host_startup_from_trusted_anchor_for_test,
        ValidatedPromotionDecisionHostStartupV1,
    };
    use bp_ledger::storage::sqlite::SqliteStore;
    use ed25519_dalek::SigningKey;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    const SIDECAR_UMASK_CHILD: &str = "BUILDPLANE_LEDGER_SIDECAR_UMASK_CHILD";

    struct LedgerFixture {
        _anchor: TempDir,
        authority_root: PathBuf,
        owner: u32,
    }

    impl LedgerFixture {
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

        fn startup(&self) -> ValidatedPromotionDecisionHostStartupV1 {
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
                "operator": signer("operator:primary", "operator-main", [2; 32]),
                "reviewers": [signer("reviewer", "reviewer-main", [3; 32])],
            });
            let config = parse_promotion_decision_host_config(&config.to_string())
                .expect("valid ledger-custody config");
            validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
                config,
                self._anchor.path(),
                self.owner,
            )
            .expect("validated test startup")
        }

        fn create_ledger(&self) -> PathBuf {
            let ledger_directory = self.authority_root.join("ledger");
            create_private_directory(&ledger_directory);
            self.create_ledger_in(&ledger_directory)
        }

        fn create_ledger_in(&self, ledger_directory: &Path) -> PathBuf {
            let database_path = ledger_directory.join("events.db");
            let store = SqliteStore::open(&database_path).expect("create a real Buildplane ledger");
            drop(store);
            set_mode(&database_path, 0o600);
            database_path
        }
    }

    fn create_private_directory(path: &Path) {
        fs::create_dir(path).expect("create fixture directory");
        set_mode(path, 0o700);
    }

    fn set_mode(path: &Path, mode: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set fixture mode");
    }

    fn load_error(
        startup: &ValidatedPromotionDecisionHostStartupV1,
    ) -> ProtectedHostLedgerLoadError {
        match load_promotion_decision_ledger_v1(startup) {
            Ok(_) => panic!("protected ledger load unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    #[test]
    fn opens_a_real_existing_ledger_after_the_authority_root_path_moves() {
        let fixture = LedgerFixture::new();
        let original_database_path = fixture.create_ledger();
        let startup = fixture.startup();
        let moved_root = fixture._anchor.path().join("authority-moved");

        fs::rename(&fixture.authority_root, &moved_root)
            .expect("move authority root after descriptor validation");

        let protected = load_promotion_decision_ledger_v1(&startup)
            .expect("load through the retained authority-root descriptor");
        let moved_database_path = moved_root.join("ledger").join("events.db");
        assert!(!original_database_path.exists());
        assert_eq!(
            protected
                .store()
                .canonical_database_path()
                .expect("opened store identity"),
            fs::canonicalize(&moved_database_path).expect("canonical moved ledger")
        );
        assert_eq!(
            fs::canonicalize(protected.recovery_database_path())
                .expect("canonical recovery identity"),
            fs::canonicalize(&moved_database_path).expect("canonical moved ledger")
        );
        let store_metadata = fs::metadata(
            protected
                .store()
                .canonical_database_path()
                .expect("store database identity"),
        )
        .expect("store database metadata");
        let recovery_metadata =
            fs::metadata(protected.recovery_database_path()).expect("recovery database metadata");
        assert_eq!(
            (store_metadata.dev(), store_metadata.ino()),
            (recovery_metadata.dev(), recovery_metadata.ino()),
            "the writer and recovery reader must bind the same device and inode"
        );
    }

    #[test]
    fn missing_database_fails_without_creating_one() {
        let fixture = LedgerFixture::new();
        let ledger_directory = fixture.authority_root.join("ledger");
        create_private_directory(&ledger_directory);
        let startup = fixture.startup();
        let database_path = ledger_directory.join("events.db");

        assert_eq!(
            load_error(&startup),
            ProtectedHostLedgerLoadError::UnsafeLedgerDatabase
        );
        assert!(
            !database_path.exists(),
            "governed startup must not initialize a missing ledger"
        );
    }

    #[test]
    fn empty_and_corrupt_databases_fail_closed() {
        for contents in [&b""[..], &b"not a sqlite database"[..]] {
            let fixture = LedgerFixture::new();
            let ledger_directory = fixture.authority_root.join("ledger");
            create_private_directory(&ledger_directory);
            let database_path = ledger_directory.join("events.db");
            fs::write(&database_path, contents).expect("write invalid database fixture");
            set_mode(&database_path, 0o600);
            let startup = fixture.startup();

            let error = load_error(&startup);
            if contents.is_empty() {
                assert_eq!(error, ProtectedHostLedgerLoadError::UnsafeLedgerDatabase);
            } else {
                assert_eq!(error, ProtectedHostLedgerLoadError::LedgerOpenFailed);
            }
            assert_eq!(
                fs::read(&database_path).expect("read invalid database after refusal"),
                contents,
                "failed governed startup must not rewrite an invalid database"
            );
        }
    }

    #[test]
    fn symlinked_ledger_directory_and_database_fail_closed() {
        let directory_fixture = LedgerFixture::new();
        let external_ledger = directory_fixture._anchor.path().join("external-ledger");
        create_private_directory(&external_ledger);
        directory_fixture.create_ledger_in(&external_ledger);
        symlink(
            &external_ledger,
            directory_fixture.authority_root.join("ledger"),
        )
        .expect("symlink ledger directory");
        let startup = directory_fixture.startup();
        assert_eq!(
            load_error(&startup),
            ProtectedHostLedgerLoadError::UnsafeLedgerDirectory
        );

        let database_fixture = LedgerFixture::new();
        let ledger_directory = database_fixture.authority_root.join("ledger");
        create_private_directory(&ledger_directory);
        let external_database = database_fixture.authority_root.join("external.db");
        let store =
            SqliteStore::open(&external_database).expect("create external Buildplane ledger");
        drop(store);
        set_mode(&external_database, 0o600);
        symlink(&external_database, ledger_directory.join("events.db"))
            .expect("symlink ledger database");
        let startup = database_fixture.startup();
        assert_eq!(
            load_error(&startup),
            ProtectedHostLedgerLoadError::UnsafeLedgerDatabase
        );
    }

    #[test]
    fn hard_linked_database_fails_closed() {
        let fixture = LedgerFixture::new();
        let database_path = fixture.create_ledger();
        fs::hard_link(
            &database_path,
            database_path.with_file_name("events-copy.db"),
        )
        .expect("hard link protected database");
        let startup = fixture.startup();

        assert_eq!(
            load_error(&startup),
            ProtectedHostLedgerLoadError::UnsafeLedgerDatabase
        );
    }

    #[test]
    fn ledger_directory_and_database_require_exact_private_modes() {
        for unsafe_mode in [0o600, 0o750, 0o770, 0o777, 0o1700] {
            let fixture = LedgerFixture::new();
            fixture.create_ledger();
            let ledger_directory = fixture.authority_root.join("ledger");
            set_mode(&ledger_directory, unsafe_mode);
            let startup = fixture.startup();
            assert_eq!(
                load_error(&startup),
                ProtectedHostLedgerLoadError::UnsafeLedgerDirectory
            );
        }

        for unsafe_mode in [0o400, 0o640, 0o660, 0o700, 0o1600] {
            let fixture = LedgerFixture::new();
            let database_path = fixture.create_ledger();
            set_mode(&database_path, unsafe_mode);
            let startup = fixture.startup();
            assert_eq!(
                load_error(&startup),
                ProtectedHostLedgerLoadError::UnsafeLedgerDatabase
            );
        }
    }

    #[test]
    fn pure_metadata_policy_rejects_the_wrong_owner() {
        let directory = LedgerDescriptorFacts {
            kind: LedgerDescriptorKind::Directory,
            uid: 4100,
            mode: 0o700,
            link_count: 1,
            size: 4096,
        };
        assert_eq!(
            validate_ledger_directory_facts(directory, 4200),
            Err(ProtectedHostLedgerLoadError::UnsafeLedgerDirectory)
        );

        let database = LedgerDescriptorFacts {
            kind: LedgerDescriptorKind::RegularFile,
            uid: 4100,
            mode: 0o600,
            link_count: 1,
            size: 4096,
        };
        assert_eq!(
            validate_ledger_database_facts(database, 4200),
            Err(ProtectedHostLedgerLoadError::UnsafeLedgerDatabase)
        );
    }

    #[test]
    fn unsafe_preexisting_sqlite_sidecar_fails_before_sqlite_opens_it() {
        let fixture = LedgerFixture::new();
        let database_path = fixture.create_ledger();
        let wal_path = database_path.with_file_name("events.db-wal");
        fs::write(&wal_path, b"untrusted sidecar").expect("write unsafe WAL fixture");
        set_mode(&wal_path, 0o644);
        let startup = fixture.startup();

        assert_eq!(
            load_error(&startup),
            ProtectedHostLedgerLoadError::UnsafeLedgerDatabase
        );
    }

    #[test]
    fn sqlite_sidecars_inherit_owner_only_mode_even_with_umask_zero() {
        if std::env::var_os(SIDECAR_UMASK_CHILD).is_none() {
            let output = Command::new(std::env::current_exe().expect("current test binary"))
                .args([
                    "--exact",
                    "host_ledger_custody::tests::sqlite_sidecars_inherit_owner_only_mode_even_with_umask_zero",
                    "--nocapture",
                ])
                .env(SIDECAR_UMASK_CHILD, "1")
                .output()
                .expect("run isolated umask regression");
            assert!(
                output.status.success(),
                "isolated sidecar regression failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        unsafe {
            libc::umask(0);
        }
        let fixture = LedgerFixture::new();
        let database_path = fixture.create_ledger();
        let startup = fixture.startup();
        let protected = load_promotion_decision_ledger_v1(&startup).expect("open protected ledger");
        append_test_event(protected.store());

        for sidecar_name in ["events.db-wal", "events.db-shm"] {
            let sidecar = database_path.with_file_name(sidecar_name);
            let metadata =
                fs::metadata(&sidecar).expect("SQLite sidecar exists while store is open");
            assert_eq!(
                metadata.mode() & 0o7777,
                0o600,
                "{sidecar_name} must inherit the validated database mode"
            );
            assert_eq!(metadata.uid(), fixture.owner);
        }
    }

    fn append_test_event(store: &SqliteStore) {
        use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use bp_ledger::payload::Payload;
        use bp_ledger::{Event, EventId, EventKind, RunId};
        use chrono::Utc;

        let event = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "1".into(),
                event_count: "1".into(),
                unit_count: "0".into(),
            }),
        };
        store
            .append(&event)
            .expect("append sidecar regression event");
    }

    #[test]
    fn failures_render_only_closed_redacted_messages() {
        let fixture = LedgerFixture::new();
        let ledger_directory = fixture.authority_root.join("ledger");
        create_private_directory(&ledger_directory);
        let database_path = ledger_directory.join("events.db");
        fs::write(&database_path, b"private ledger bytes").expect("write corrupt ledger");
        set_mode(&database_path, 0o600);
        let startup = fixture.startup();

        let rendered = load_error(&startup).to_string();
        assert_eq!(rendered, "protected host ledger could not be opened");
        for secret in [
            fixture.authority_root.to_string_lossy().as_ref(),
            "events.db",
            "private ledger bytes",
            "018f2e40",
            "database disk image",
            "inode",
            "0600",
        ] {
            assert!(
                !rendered.contains(secret),
                "closed error leaked sensitive detail: {secret}"
            );
        }
    }
}
