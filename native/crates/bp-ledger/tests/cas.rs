//! CAS integration tests — atomic writes, dedup, read-back.

use bp_ledger::storage::cas::CanonicalCasRef;
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

/// A crash between creating the temp file and renaming it into place must not
/// wedge every future store of that content. A deterministic `.tmp-<hash>` name
/// opened with `create_new` did exactly that: the final blob never landed, so
/// every retry re-entered the write path and every retry then failed
/// `AlreadyExists` on the leftover temp — a permanently stranded object. The
/// temp name is now unique per attempt, so a retry always makes progress.
#[test]
fn a_stale_temp_from_a_crashed_write_does_not_wedge_a_retry() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();

    let content = b"stranded-plan-content";
    // Learn the object's on-disk layout by storing it once, then reconstruct the
    // exact crash state: the final blob absent, an old-style deterministic temp
    // present.
    let hash = cas.put_bytes(content).unwrap();
    let hex = hash.strip_prefix("sha256:").unwrap();
    let (shard, rest) = hex.split_at(2);
    let shard_dir = tmp.path().join(shard);
    std::fs::remove_file(shard_dir.join(rest)).unwrap();
    let stale_temp = shard_dir.join(format!(".tmp-{hash}"));
    std::fs::write(&stale_temp, b"partial").unwrap();
    assert!(
        !shard_dir.join(rest).exists(),
        "the crash state has no blob"
    );

    // The retry must succeed and land the real content, not fail on the stale
    // temp.
    let retried = cas.put_bytes(content).unwrap();
    assert_eq!(retried, hash);
    assert_eq!(cas.get_bytes(&hash).unwrap(), content);
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

#[test]
fn canonical_references_accept_only_raw_lowercase_sha256_objects() {
    let valid = format!("cas:sha256:{}", "a".repeat(64));
    let parsed = CanonicalCasRef::parse(&valid).unwrap();
    assert_eq!(parsed.to_cas_ref(), valid);
    assert_eq!(parsed.digest(), format!("sha256:{}", "a".repeat(64)));

    for invalid in [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "cas:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "cas:sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "cas:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ",
        "cas:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaag",
        "cas:sha256:../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "cas:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../x",
        "cas:sha256:%61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        assert!(
            CanonicalCasRef::parse(invalid).is_err(),
            "unexpectedly accepted malformed canonical reference: {invalid}"
        );
    }
}

#[test]
fn verified_canonical_read_requires_matching_raw_digest_and_rehashes_bytes() {
    let tmp = TempDir::new().unwrap();
    let cas = Cas::open(tmp.path()).unwrap();
    let reference = cas.put_canonical_bytes(b"governed evidence").unwrap();

    let bytes = cas
        .get_verified_canonical_bytes(&reference.to_cas_ref(), reference.digest())
        .unwrap();
    assert_eq!(bytes, b"governed evidence");

    let mismatched = format!("sha256:{}", "0".repeat(64));
    let error = cas
        .get_verified_canonical_bytes(&reference.to_cas_ref(), &mismatched)
        .unwrap_err();
    assert!(
        format!("{error}").contains("does not equal"),
        "unexpected error: {error}"
    );

    let digest = reference.digest().strip_prefix("sha256:").unwrap();
    let corrupt_path = tmp.path().join(&digest[..2]).join(&digest[2..]);
    std::fs::write(corrupt_path, b"tampered evidence").unwrap();
    let error = cas
        .get_verified_canonical_bytes(&reference.to_cas_ref(), reference.digest())
        .unwrap_err();
    assert!(
        format!("{error}").contains("object bytes do not match"),
        "unexpected error: {error}"
    );
}
