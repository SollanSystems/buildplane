//! Content-addressed blob store.
//!
//! Writes are atomic: content goes to a temp file in the same directory, then
//! `rename(2)` moves it into its final location. Reading the same path twice
//! from two processes yields either the final content or `ENOENT` — never a
//! partial file.

use crate::error::{LedgerError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const SHA256_PREFIX: &str = "sha256:";
const CAS_SHA256_PREFIX: &str = "cas:sha256:";
const SHA256_HEX_LENGTH: usize = 64;

/// A strict, raw-SHA256 CAS reference for new authority-bearing evidence.
///
/// The legacy [`Cas::get_bytes`] API intentionally remains permissive for
/// historical callers. New governed code must use this type (or
/// [`Cas::get_verified_canonical_bytes`]) so a descriptor cannot turn an
/// arbitrary string into a filesystem path or confuse a semantic digest with
/// the raw content digest used by the CAS.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CanonicalCasRef {
    digest: String,
}

impl CanonicalCasRef {
    /// Parse only the canonical `cas:sha256:<64 lowercase hex>` form.
    pub fn parse(value: &str) -> Result<Self> {
        let Some(hex) = value.strip_prefix(CAS_SHA256_PREFIX) else {
            return Err(LedgerError::Cas(
                "canonical CAS reference must start with cas:sha256:".to_string(),
            ));
        };
        Self::from_digest(format!("{SHA256_PREFIX}{hex}"))
    }

    /// Construct a canonical CAS reference from a raw content digest.
    pub fn from_digest(digest: impl Into<String>) -> Result<Self> {
        let digest = digest.into();
        if !is_canonical_sha256_digest(&digest) {
            return Err(LedgerError::Cas(
                "canonical CAS digest must be sha256:<64 lowercase hex>".to_string(),
            ));
        }
        Ok(Self { digest })
    }

    /// The raw `sha256:<hex>` digest used for the CAS object path.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// Render the canonical `cas:sha256:<hex>` external reference.
    pub fn to_cas_ref(&self) -> String {
        format!("cas:{}", self.digest)
    }
}

/// A content-addressed blob store rooted at a directory.
pub struct Cas {
    root: PathBuf,
}

impl Cas {
    /// Create a new CAS rooted at `root`. The directory is created if missing.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// Store bytes, return the sha256 hash. Idempotent: if the blob already
    /// exists, no write happens.
    pub fn put_bytes(&self, bytes: &[u8]) -> Result<String> {
        let hash = hash_hex(bytes);
        let dest = self.path_for(&hash);
        if dest.exists() {
            return Ok(hash);
        }
        let parent = dest.parent().expect("CAS path always has a parent");
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(".tmp-{}", &hash));
        {
            let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &dest)?;
        // Fsync the parent directory so the rename is durable.
        File::open(parent)?.sync_all()?;
        Ok(hash)
    }

    /// Hash a file from disk, store it, and return the hash.
    pub fn put_path(&self, src: impl AsRef<Path>) -> Result<String> {
        let mut f = File::open(src)?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        self.put_bytes(&buf)
    }

    /// Store bytes and return the strict reference new governed evidence must
    /// carry. The reference always names the raw hash of the stored bytes.
    pub fn put_canonical_bytes(&self, bytes: &[u8]) -> Result<CanonicalCasRef> {
        CanonicalCasRef::from_digest(self.put_bytes(bytes)?)
    }

    /// Retrieve bytes by hash. Returns `Err` if the hash is not present.
    pub fn get_bytes(&self, hash: &str) -> Result<Vec<u8>> {
        let path = self.path_for(hash);
        let mut f =
            File::open(&path).map_err(|_| LedgerError::Cas(format!("blob not found: {hash}")))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Load authority-bearing evidence only when both the supplied reference
    /// and expected descriptor digest use the strict raw-SHA256 syntax and
    /// name the same object. Rehashing the bytes turns storage corruption or a
    /// bad descriptor into a fail-closed error.
    pub fn get_verified_canonical_bytes(
        &self,
        cas_ref: &str,
        expected_digest: &str,
    ) -> Result<Vec<u8>> {
        let reference = CanonicalCasRef::parse(cas_ref)?;
        let expected = CanonicalCasRef::from_digest(expected_digest.to_string())?;
        if reference.digest() != expected.digest() {
            return Err(LedgerError::Cas(
                "canonical CAS reference digest does not equal its descriptor digest".to_string(),
            ));
        }
        let bytes = self.get_bytes(reference.digest())?;
        if hash_hex(&bytes) != reference.digest() {
            return Err(LedgerError::Cas(
                "canonical CAS object bytes do not match their descriptor digest".to_string(),
            ));
        }
        Ok(bytes)
    }

    fn path_for(&self, hash: &str) -> PathBuf {
        let hex = hash.strip_prefix("sha256:").unwrap_or(hash);
        let (shard, rest) = hex.split_at(2);
        self.root.join(shard).join(rest)
    }
}

fn hash_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{SHA256_PREFIX}{:x}", h.finalize())
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix(SHA256_PREFIX) else {
        return false;
    };
    hex.len() == SHA256_HEX_LENGTH
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
