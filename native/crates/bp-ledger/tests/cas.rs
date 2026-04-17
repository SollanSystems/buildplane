//! CAS integration tests — atomic writes, dedup, read-back.

use bp_ledger::storage::Cas;
use tempfile::TempDir;

#[test]
fn put_bytes_stores_and_returns_hash() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();

    let h = cas.put_bytes(b"hello").unwrap();
    assert!(h.starts_with("sha256:"), "expected sha256 prefix, got {h}");

    let back = cas.get_bytes(&h).unwrap();
    assert_eq!(back, b"hello");
}

#[test]
fn put_bytes_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();
    let h1 = cas.put_bytes(b"world").unwrap();
    let h2 = cas.put_bytes(b"world").unwrap();
    assert_eq!(h1, h2);
}

#[test]
fn put_path_hashes_file_contents() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path().join("cas")).unwrap();
    let src = tmp.path().join("src.txt");
    std::fs::write(&src, b"file content").unwrap();

    let h = cas.put_path(&src).unwrap();
    let back = cas.get_bytes(&h).unwrap();
    assert_eq!(back, b"file content");
}

#[test]
fn get_bytes_missing_hash_errors() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();
    let err = cas.get_bytes("sha256:deadbeef").unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("not found"), "unexpected error: {msg}");
}
