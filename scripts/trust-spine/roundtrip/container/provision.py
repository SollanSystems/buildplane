#!/usr/bin/env python3
"""Provision every real filesystem precondition for the round trip.

No test seams, no relaxed modes, no patched constants, no environment overrides.
Every owner/mode value written here is the value the Rust binaries enforce.

Ledger CONTENT is deliberately NOT seeded (see params.SEALED_BLOCKER). Ledger
EXISTENCE is seeded through real production code only: the shipped native CLI's
`ledger export-signed-tape` opens SqliteStore, which runs the genuine schema
init. Its exit code is intentionally ignored; the produced FILE is validated.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402


def sh(*args, check=True, capture=False, stdin_bytes=None):
    return subprocess.run(
        args,
        check=check,
        input=stdin_bytes,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def mkdir(path, uid, gid, mode):
    os.makedirs(path, exist_ok=True)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def write_file(path, data, uid, gid, mode):
    """Create with O_EXCL|O_NOFOLLOW at 0600, then set the exact owner+mode.

    Explicit chown/chmod rather than umask reliance: a umask-derived mode is a
    process-global side channel and the gates compare exact values.
    """
    if os.path.lexists(path):
        os.remove(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def gen_ed25519():
    """Return (raw 32-byte seed, raw 32-byte public key).

    Both DER prefixes are asserted so a silently wrong byte offset can never
    reach the config or a key file.
    """
    der = sh("openssl", "genpkey", "-algorithm", "ED25519", "-outform", "DER",
             capture=True).stdout
    assert len(der) == 48, f"unexpected PKCS8 length {len(der)}"
    assert der[:16] == P.PKCS8_ED25519_PREFIX, "unexpected PKCS8 prefix"
    seed = der[16:]
    spki = sh("openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER",
              capture=True, stdin_bytes=der).stdout
    assert len(spki) == 44, f"unexpected SPKI length {len(spki)}"
    assert spki[:12] == P.SPKI_ED25519_PREFIX, "unexpected SPKI prefix"
    return seed, spki[12:]


def ensure_identities():
    def try_run(*args):
        subprocess.run(args, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try_run("groupadd", "-g", str(P.SOCKET_GID), "bpsock")
    try_run("groupadd", "-g", str(P.BROKER_GID), "bpauth")
    try_run("groupadd", "-g", str(P.CLIENT_GID), "bpclient")
    try_run("groupadd", "-g", str(P.OUTSIDER_GID), "bpother")
    try_run("useradd", "-u", str(P.BROKER_UID), "-g", str(P.BROKER_GID),
            "-M", "-N", "-s", "/usr/sbin/nologin", "bpauth")
    # The client UID must be a member of the socket group or connect(2) to a
    # 0660 root:<socket_gid> socket is denied by the kernel before any
    # Buildplane code runs.
    try_run("useradd", "-u", str(P.CLIENT_UID), "-g", str(P.CLIENT_GID),
            "-G", str(P.SOCKET_GID), "-M", "-N", "-s", "/usr/sbin/nologin",
            "bpclient")
    # Socket-group member, deliberately absent from promotion_decision_client_uids.
    try_run("useradd", "-u", str(P.OUTSIDER_UID), "-g", str(P.OUTSIDER_GID),
            "-G", str(P.SOCKET_GID), "-M", "-N", "-s", "/usr/sbin/nologin",
            "bpother")


def materialize_ledger():
    """Create a real, schema-complete, EMPTY ledger via production code."""
    seed_ledger_dir = os.path.join(P.SEED_WORKSPACE, ".buildplane", "ledger")
    os.makedirs(seed_ledger_dir, exist_ok=True)
    export = subprocess.run(
        [P.NATIVE_BIN, "ledger", "export-signed-tape",
         "--run-id", P.RUN_ID,
         "--workspace", P.SEED_WORKSPACE,
         "--out", os.path.join(P.SEED_WORKSPACE, "out")],
        check=False, capture_output=True,
        env={**os.environ, "HOME": "/root"},
    )
    staged_db = os.path.join(seed_ledger_dir, "events.db")
    assert os.path.isfile(staged_db), (
        "SqliteStore::open did not create events.db -- seed export stderr: "
        + export.stderr.decode(errors="replace")[:400]
    )
    with open(staged_db, "rb") as handle:
        assert handle.read(16) == P.SQLITE_MAGIC, "staged ledger is not SQLite"
    assert os.path.getsize(staged_db) > 0, "staged ledger is empty"
    count = subprocess.run(["sqlite3", staged_db, "select count(*) from events;"],
                           check=True, capture_output=True).stdout.strip()
    assert count == b"0", f"unexpected seeded event count {count!r}"

    copied = []
    for name in ("events.db",) + P.LEDGER_SIDECARS:
        src = os.path.join(seed_ledger_dir, name)
        if not os.path.isfile(src):
            continue  # never delete a surviving sidecar; copy it if present
        dst = os.path.join(P.LEDGER_DIR, name)
        shutil.copyfile(src, dst)
        os.chown(dst, P.BROKER_UID, P.BROKER_GID)
        os.chmod(dst, 0o600)
        copied.append(name)
    return {
        "seed_export_exit": export.returncode,
        "seed_export_stderr": export.stderr.decode(errors="replace")[:400],
        "copied_ledger_files": copied,
    }


def main():
    assert os.geteuid() == 0, "provisioning requires root inside the container"
    ensure_identities()

    # /etc chain: the host requires uid 0 with mode&0o022==0; the client
    # requires EXACTLY 0755. 0755 satisfies both.
    mkdir("/etc/buildplane", 0, 0, 0o755)
    mkdir(P.CONFIG_DIR, 0, 0, 0o755)
    # /run chain: validate_listener_parent_facts requires EXACTLY 0755 root:root.
    mkdir("/run/buildplane", 0, 0, 0o755)
    mkdir(P.RUN_DIR, 0, 0, 0o755)
    # /usr/libexec chain: validate_client_parent_facts requires EXACTLY 0755.
    mkdir(P.INSTALL_DIR, 0, 0, 0o755)
    # authority_root ancestors are root-owned and not group/other-writable;
    # authority_root and every keys/ledger directory are broker-owned EXACTLY 0700.
    mkdir("/var/lib/buildplane", 0, 0, 0o755)
    mkdir(P.AUTHORITY_ROOT, P.BROKER_UID, P.BROKER_GID, 0o700)
    mkdir(P.LEDGER_DIR, P.BROKER_UID, P.BROKER_GID, 0o700)
    mkdir(P.KEYS_DIR, P.BROKER_UID, P.BROKER_GID, 0o700)
    mkdir(P.KEYS_DIR + "/kernel", P.BROKER_UID, P.BROKER_GID, 0o700)
    mkdir(P.KEYS_DIR + "/operator", P.BROKER_UID, P.BROKER_GID, 0o700)

    # Real copies with nlink 1 -- never a symlink, never a bind-mounted leaf,
    # never run from the cargo target dir (the client asserts /proc/self/exe
    # string-equals the installed path AND matches its dev+ino).
    binaries = {}
    for src, dst in (
        ("buildplane-authority-client", P.CLIENT_BIN),
        ("buildplane-authority-host", P.HOST_BIN),
        ("buildplane-native", P.NATIVE_BIN),
    ):
        if os.path.lexists(dst):
            os.remove(dst)
        shutil.copyfile(os.path.join(P.REPO_DEBUG, src), dst)
        os.chown(dst, 0, 0)
        os.chmod(dst, 0o755)
        with open(dst, "rb") as handle:
            binaries[src] = hashlib.sha256(handle.read()).hexdigest()

    kernel_seed, kernel_pub = gen_ed25519()
    operator_seed, operator_pub = gen_ed25519()
    reviewer_seed, reviewer_pub = gen_ed25519()
    assert kernel_seed != operator_seed and kernel_pub != operator_pub
    assert reviewer_pub not in (kernel_pub, operator_pub)
    del reviewer_seed  # the host loads no reviewer private key

    write_file(P.KERNEL_KEY, kernel_seed, P.BROKER_UID, P.BROKER_GID, 0o600)
    write_file(P.OPERATOR_KEY, operator_seed, P.BROKER_UID, P.BROKER_GID, 0o600)

    host_config = {
        "schema_version": 1,
        "run_id": P.RUN_ID,
        "broker_uid": P.BROKER_UID,
        "promotion_decision_client_uids": [P.CLIENT_UID],
        "socket_group_gid": P.SOCKET_GID,
        "authority_root": P.AUTHORITY_ROOT,
        "authority_realm_digest": P.REALM_DIGEST,
        "kernel": {"actor_id": "kernel", "key_id": "kernel-main",
                   "public_key": list(kernel_pub)},
        "operator": {"actor_id": "operator", "key_id": "operator-main",
                     "public_key": list(operator_pub)},
        "reviewers": [{"actor_id": "reviewer", "key_id": "reviewer-main",
                       "public_key": list(reviewer_pub)}],
    }
    host_bytes = json.dumps(host_config).encode()
    assert len(host_bytes) <= P.MAX_HOST_CONFIG_BYTES
    # validate_config_file_facts requires uid 0, mode&0o022==0 AND mode&0o004==0
    # -- so only 0600 or 0640 -- but the reader has already setuid'd to
    # broker_uid. 0600 root:root would be policy-legal and UNREADABLE, failing
    # with the same opaque startup_failed. The gid is not checked, so
    # 0:<broker_gid> 0640 is the only shape that is both legal and readable.
    write_file(P.HOST_CONFIG, host_bytes, 0, P.BROKER_GID, 0o640)

    client_config = {
        "schema_version": 1,
        "listener_creator_uid": 0,
        "socket_group_gid": P.SOCKET_GID,
        # Responses are signed with signing_keys.kernel(), so the client must
        # pin the KERNEL public key.
        "broker_identity_public_key": list(kernel_pub),
    }
    client_bytes = json.dumps(client_config).encode()
    assert len(client_bytes) <= P.MAX_CLIENT_CONFIG_BYTES
    # validate_client_config_file_facts requires uid 0 and mode EXACTLY 0644 --
    # world-readable is REQUIRED here so the non-root client can read it. This is
    # the opposite of the host config.
    write_file(P.CLIENT_CONFIG, client_bytes, 0, 0, 0o644)

    ledger_facts = materialize_ledger()

    manifest = {
        "broker_uid": P.BROKER_UID,
        "client_uid": P.CLIENT_UID,
        "outsider_uid": P.OUTSIDER_UID,
        "socket_group_gid": P.SOCKET_GID,
        "run_id": P.RUN_ID,
        "kernel_public_key": list(kernel_pub),
        "operator_public_key": list(operator_pub),
        "reviewer_public_key": list(reviewer_pub),
        "host_config_sha256": hashlib.sha256(host_bytes).hexdigest(),
        "host_config_bytes": len(host_bytes),
        "client_config_sha256": hashlib.sha256(client_bytes).hexdigest(),
        "client_config_bytes": len(client_bytes),
        "installed_binary_sha256": binaries,
        **ledger_facts,
    }
    os.makedirs(P.OUT_DIR, exist_ok=True)
    with open(os.path.join(P.OUT_DIR, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
    print("PROVISION: ok")


if __name__ == "__main__":
    main()
