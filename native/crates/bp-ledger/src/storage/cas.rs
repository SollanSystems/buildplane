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

    /// Retrieve bytes by hash. Returns `Err` if the hash is not present.
    pub fn get_bytes(&self, hash: &str) -> Result<Vec<u8>> {
        let path = self.path_for(hash);
        let mut f = File::open(&path).map_err(|_| LedgerError::Cas(
            format!("blob not found: {hash}")
        ))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
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
    format!("sha256:{:x}", h.finalize())
}
