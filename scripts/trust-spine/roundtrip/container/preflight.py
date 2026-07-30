#!/usr/bin/env python3
"""Out-of-band validator for every invariant the host collapses to
`startup_failed`.

This file exists because the host is diagnostically opaque BY DESIGN: its own
contract test asserts the emitted string is one of
{startup_failed, accept_failed, unsupported_platform} and never contains a path,
uid, gid, fd number, or 'sqlite'. There is no verbose or debug environment
variable anywhere in the crate. Roughly 25 distinct causes therefore share one
output byte-string, and iterating against that is a black box.

So every precondition is asserted here first, by name, before the host is
started. A failure prints exactly which gate failed and its observed facts.

Exit 0 iff every check passes. Each check prints `CHECK <name> <ok|FAIL> [detail]`.
"""
import json
import os
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

FAILURES = []


def check(name, ok, detail=""):
    ok = bool(ok)
    print(f"CHECK {name} {'ok' if ok else 'FAIL'}{(' ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)
    return ok


def facts(path):
    st = os.lstat(path)  # lstat: a symlink must never satisfy a directory check
    return st, stat.S_IMODE(st.st_mode)


def dir_exact(path, uid, mode):
    try:
        st, m = facts(path)
    except OSError as exc:
        return check(f"dir-exact:{path}", False, f"stat failed: {exc}")
    ok = stat.S_ISDIR(st.st_mode) and st.st_uid == uid and m == mode
    return check(f"dir-exact:{path}", ok,
                 f"uid={st.st_uid} mode={oct(m)} want uid={uid} mode={oct(mode)}")


def dir_nowrite(path, uid):
    try:
        st, m = facts(path)
    except OSError as exc:
        return check(f"dir-nowrite:{path}", False, f"stat failed: {exc}")
    ok = stat.S_ISDIR(st.st_mode) and st.st_uid == uid and (m & 0o022) == 0
    return check(f"dir-nowrite:{path}", ok, f"uid={st.st_uid} mode={oct(m)}")


def regular(label, path, uid, modes, nlink=1, min_size=None, exact_size=None,
            gid=None, max_size=None):
    try:
        st, m = facts(path)
    except OSError as exc:
        return check(f"file:{label}", False, f"stat failed: {exc}")
    reasons = []
    if not stat.S_ISREG(st.st_mode):
        reasons.append("not-a-regular-file")
    if st.st_uid != uid:
        reasons.append(f"uid={st.st_uid}!={uid}")
    if m not in modes:
        reasons.append(f"mode={oct(m)} not in {[oct(x) for x in modes]}")
    if st.st_nlink != nlink:
        reasons.append(f"nlink={st.st_nlink}!={nlink}")
    if gid is not None and st.st_gid != gid:
        reasons.append(f"gid={st.st_gid}!={gid}")
    if min_size is not None and st.st_size < min_size:
        reasons.append(f"size={st.st_size}<{min_size}")
    if max_size is not None and st.st_size > max_size:
        reasons.append(f"size={st.st_size}>{max_size}")
    if exact_size is not None and st.st_size != exact_size:
        reasons.append(f"size={st.st_size}!={exact_size}")
    return check(f"file:{label}", not reasons,
                 f"uid={st.st_uid} gid={st.st_gid} mode={oct(m)} "
                 f"nlink={st.st_nlink} size={st.st_size}"
                 + (" | " + ",".join(reasons) if reasons else ""))


def sha256_of(path):
    import hashlib
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def derive_public(seed_path):
    """Re-derive the Ed25519 public key from an on-disk raw seed via openssl.

    Catches PublicKeyMismatch before the host ever runs. Deliberately reads with
    the same take(33) semantics the crate uses, so a 33-byte file is rejected
    here too.
    """
    with open(seed_path, "rb") as handle:
        seed = handle.read(33)
    if len(seed) != 32:
        return None
    der = P.PKCS8_ED25519_PREFIX + seed
    spki = subprocess.run(
        ["openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER"],
        input=der, check=True, capture_output=True).stdout
    if len(spki) != 44 or spki[:12] != P.SPKI_ED25519_PREFIX:
        return None
    return list(spki[12:])


def readable_as(path, uid, gid):
    """Fork a child, drop to uid/gid, and actually read the file.

    A mode/gid derivation argument is not the same as evidence. The host reads
    its config AFTER setuid, so this proves the real reader can open it.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:  # child
        try:
            os.close(read_fd)
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            with open(path, "rb") as handle:
                handle.read(1)
            os.write(write_fd, b"1")
        except BaseException:
            try:
                os.write(write_fd, b"0")
            except BaseException:
                pass
        finally:
            os._exit(0)
    os.close(write_fd)
    with os.fdopen(read_fd, "rb") as handle:
        answer = handle.read()
    os.waitpid(pid, 0)
    return answer == b"1"


def sqlite_event_count(path):
    result = subprocess.run(["sqlite3", path, "select count(*) from events;"],
                            check=False, capture_output=True)
    if result.returncode != 0:
        return None, result.stderr.decode(errors="replace").strip()
    return result.stdout.strip().decode(), ""


def pre_bind():
    manifest_path = os.path.join(P.OUT_DIR, "manifest.json")
    manifest = {}
    if os.path.isfile(manifest_path):
        with open(manifest_path) as handle:
            manifest = json.load(handle)
    check("manifest:present", bool(manifest), manifest_path)

    # --- descriptor-walk chains -------------------------------------------
    # The client requires EXACTLY 0755 on each /etc, /run, /usr/libexec hop; the
    # host requires uid 0 with no group/other write. Every hop is opened
    # O_NOFOLLOW|O_DIRECTORY from a fresh open of '/', so no symlink is tolerated.
    for path in ("/", "/etc", "/etc/buildplane", P.CONFIG_DIR):
        dir_exact(path, 0, 0o755)
    for path in ("/run", "/run/buildplane", P.RUN_DIR):
        dir_exact(path, 0, 0o755)
    for path in ("/usr", "/usr/libexec", P.INSTALL_DIR):
        dir_exact(path, 0, 0o755)
    for path in ("/var", "/var/lib", "/var/lib/buildplane"):
        dir_nowrite(path, 0)

    # --- host config -------------------------------------------------------
    regular("host-config", P.HOST_CONFIG, 0, {0o600, 0o640},
            gid=P.BROKER_GID, max_size=P.MAX_HOST_CONFIG_BYTES)
    try:
        _st, host_mode = facts(P.HOST_CONFIG)
        check("host-config:no-group-or-other-write", (host_mode & 0o022) == 0,
              oct(host_mode))
        check("host-config:no-other-read", (host_mode & 0o004) == 0, oct(host_mode))
    except OSError as exc:
        check("host-config:facts", False, str(exc))
    check("host-config:readable-by-broker-after-setuid",
          readable_as(P.HOST_CONFIG, P.BROKER_UID, P.BROKER_GID),
          "the host reads this file AFTER dropping to broker_uid")
    if manifest:
        check("host-config:bytes-unmodified-since-provision",
              sha256_of(P.HOST_CONFIG) == manifest.get("host_config_sha256"))

    # --- client config -----------------------------------------------------
    regular("client-config", P.CLIENT_CONFIG, 0, {0o644}, gid=0,
            max_size=P.MAX_CLIENT_CONFIG_BYTES)
    check("client-config:readable-by-client-uid",
          readable_as(P.CLIENT_CONFIG, P.CLIENT_UID, P.CLIENT_GID),
          "this file MUST be world-readable, unlike the host config")
    if manifest:
        check("client-config:bytes-unmodified-since-provision",
              sha256_of(P.CLIENT_CONFIG) == manifest.get("client_config_sha256"))

    # --- installed binaries ------------------------------------------------
    regular("installed-client", P.CLIENT_BIN, 0, {0o755})
    regular("installed-host", P.HOST_BIN, 0, {0o755})
    regular("installed-native", P.NATIVE_BIN, 0, {0o755})
    if manifest:
        expected = manifest.get("installed_binary_sha256", {})
        check("installed-client:bytes-match-repo-build",
              sha256_of(P.CLIENT_BIN)
              == expected.get("buildplane-authority-client"))
        check("installed-host:bytes-match-repo-build",
              sha256_of(P.HOST_BIN)
              == expected.get("buildplane-authority-host"))

    # --- authority root tree ------------------------------------------------
    dir_exact(P.AUTHORITY_ROOT, P.BROKER_UID, 0o700)
    dir_exact(P.LEDGER_DIR, P.BROKER_UID, 0o700)
    dir_exact(P.KEYS_DIR, P.BROKER_UID, 0o700)
    dir_exact(P.KEYS_DIR + "/kernel", P.BROKER_UID, 0o700)
    dir_exact(P.KEYS_DIR + "/operator", P.BROKER_UID, 0o700)
    regular("kernel-key", P.KERNEL_KEY, P.BROKER_UID, {0o400, 0o600},
            exact_size=32)
    regular("operator-key", P.OPERATOR_KEY, P.BROKER_UID, {0o400, 0o600},
            exact_size=32)
    check("keys:no-reviewer-private-key",
          not os.path.lexists(P.KEYS_DIR + "/reviewer"),
          "load_promotion_decision_signing_keys_v1 loads kernel+operator only")

    # --- host config semantics ---------------------------------------------
    try:
        with open(P.HOST_CONFIG, "rb") as handle:
            host_config = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        check("host-config:parses", False, str(exc))
        host_config = None

    if host_config is not None:
        check("host-config:exact-key-set",
              set(host_config) == {"schema_version", "run_id", "broker_uid",
                                   "promotion_decision_client_uids",
                                   "socket_group_gid", "authority_root",
                                   "authority_realm_digest", "kernel",
                                   "operator", "reviewers"},
              "deny_unknown_fields: an extra key is indistinguishable from a "
              "syntax error")
        check("host-config:schema-version-1", host_config["schema_version"] == 1)
        check("host-config:run-id-canonical-uuidv7",
              host_config["run_id"] == P.RUN_ID
              and host_config["run_id"][14] == "7"
              and host_config["run_id"] == host_config["run_id"].lower(),
              host_config["run_id"])
        check("host-config:uids-nonzero-and-distinct",
              host_config["broker_uid"] != 0
              and host_config["promotion_decision_client_uids"] == [P.CLIENT_UID]
              and P.CLIENT_UID != 0
              and P.CLIENT_UID != host_config["broker_uid"])
        check("host-config:authority-root-matches",
              host_config["authority_root"] == P.AUTHORITY_ROOT)
        digest = host_config["authority_realm_digest"]
        check("host-config:realm-digest-canonical-sha256",
              len(digest) == 71 and digest.startswith("sha256:")
              and all(c in "0123456789abcdef" for c in digest[7:]))
        signers = [host_config["kernel"], host_config["operator"]] + \
            list(host_config["reviewers"])
        check("host-config:signer-key-set",
              all(set(s) == {"actor_id", "key_id", "public_key"} for s in signers))
        actor_ids = [s["actor_id"] for s in signers]
        check("host-config:distinct-actor-ids",
              len(set(actor_ids)) == len(actor_ids), ",".join(actor_ids))
        check("host-config:signer-ids-charset",
              all(s["actor_id"] and s["key_id"]
                  and not s["actor_id"].startswith(".")
                  and all(c.isalnum() or c in "._-" for c in s["actor_id"])
                  and all(c.isalnum() or c in "._-" for c in s["key_id"])
                  for s in signers))
        pubs = [tuple(s["public_key"]) for s in signers]
        check("host-config:distinct-public-keys", len(set(pubs)) == len(pubs))
        check("host-config:public-keys-are-32-int-arrays",
              all(len(p) == 32 and all(isinstance(b, int) and 0 <= b <= 255
                                       for b in p) for p in pubs),
              "public_key is Vec<u8>: a JSON int array, never base64 or hex")
        check("host-config:reviewers-nonempty", len(host_config["reviewers"]) >= 1)

        kernel_derived = derive_public(P.KERNEL_KEY)
        operator_derived = derive_public(P.OPERATOR_KEY)
        check("key:kernel-seed-derives-config-public-key",
              kernel_derived == host_config["kernel"]["public_key"])
        check("key:operator-seed-derives-config-public-key",
              operator_derived == host_config["operator"]["public_key"])
        check("key:kernel-operator-not-aliased",
              kernel_derived is not None and kernel_derived != operator_derived)

    # --- client config semantics -------------------------------------------
    try:
        with open(P.CLIENT_CONFIG, "rb") as handle:
            client_config = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        check("client-config:parses", False, str(exc))
        client_config = None

    if client_config is not None and host_config is not None:
        check("client-config:exact-key-set",
              set(client_config) == {"schema_version", "listener_creator_uid",
                                     "socket_group_gid",
                                     "broker_identity_public_key"})
        check("client-config:schema-version-1",
              client_config["schema_version"] == 1)
        check("client-config:listener-creator-uid-is-0",
              client_config["listener_creator_uid"] == 0,
              "the parser rejects anything other than 0")
        check("client-config:socket-gid-matches-host",
              client_config["socket_group_gid"]
              == host_config["socket_group_gid"] == P.SOCKET_GID)
        check("client-config:pins-kernel-public-key",
              client_config["broker_identity_public_key"]
              == host_config["kernel"]["public_key"],
              "the host signs responses with signing_keys.kernel()")

    # --- ledger -------------------------------------------------------------
    regular("ledger-db", P.LEDGER_DB, P.BROKER_UID, {0o600}, min_size=1)
    try:
        with open(P.LEDGER_DB, "rb") as handle:
            check("ledger:sqlite-magic", handle.read(16) == P.SQLITE_MAGIC,
                  "the host never creates or repairs a ledger; touch(1) fails")
    except OSError as exc:
        check("ledger:readable", False, str(exc))
    count, err = sqlite_event_count(P.LEDGER_DB)
    check("ledger:opens-and-has-zero-events", count == "0",
          f"count={count} err={err}")
    for name in P.LEDGER_SIDECARS:
        path = os.path.join(P.LEDGER_DIR, name)
        if os.path.lexists(path):
            regular(f"ledger-sidecar:{name}", path, P.BROKER_UID, {0o600})


def post_bind():
    try:
        st, m = facts(P.SOCKET_PATH)
    except OSError as exc:
        check("socket:exists", False, str(exc))
        return
    check("socket:is-socket-not-symlink", stat.S_ISSOCK(st.st_mode),
          oct(st.st_mode))
    check("socket:uid-0", st.st_uid == 0, str(st.st_uid))
    check("socket:gid-is-socket-group", st.st_gid == P.SOCKET_GID, str(st.st_gid))
    check("socket:mode-exactly-0660", m == 0o660, oct(m))
    check("socket:nlink-1", st.st_nlink == 1, str(st.st_nlink))

    # The path-based snapshot above is one of two independent gates. The
    # fd-based gate (S_ISSOCK + SO_DOMAIN + SO_TYPE + SO_ACCEPTCONN + kernel
    # pathname equality) can only be observed by the process holding the
    # listener, so launch-host.py records it before exec.
    listener_facts_path = os.path.join(P.OUT_DIR, "listener-facts.json")
    if not check("listener-facts:recorded", os.path.isfile(listener_facts_path),
                 listener_facts_path):
        return
    with open(listener_facts_path) as handle:
        lf = json.load(handle)
    check("listener-fd:is-socket", lf.get("is_socket") is True, str(lf))
    check("listener-fd:so-domain-af-unix", lf.get("so_domain") == 1,
          str(lf.get("so_domain")))
    check("listener-fd:so-type-sock-stream", lf.get("so_type") == 1,
          str(lf.get("so_type")))
    check("listener-fd:so-acceptconn-1", lf.get("so_acceptconn") == 1,
          "listen(2) must have been called")
    check("listener-fd:kernel-pathname-exact",
          lf.get("getsockname") == P.SOCKET_PATH, str(lf.get("getsockname")))
    check("listener-fd:number-is-3", lf.get("fd") == P.LISTENER_FD,
          str(lf.get("fd")))
    check("listener-fd:inheritable-across-execve",
          lf.get("inheritable") is True,
          "Python fds are CLOEXEC by default (PEP 446); without "
          "set_inheritable the kernel closes fd 3 during execve")
    check("launcher:listened-while-euid-0", lf.get("euid_at_listen") == 0,
          "the kernel snapshots SO_PEERCRED in unix_listen(); the client pins "
          "listener_creator_uid to 0")
    check("launcher:euid-after-setuid-is-broker",
          lf.get("euid_at_exec") == P.BROKER_UID,
          "attest_current_broker_process compares geteuid() to broker_uid")
    check("launcher:supplementary-groups-cleared",
          lf.get("groups_at_exec") in ([], [P.BROKER_GID]),
          str(lf.get("groups_at_exec")))


if __name__ == "__main__":
    if "--phase" not in sys.argv:
        print("usage: preflight.py --phase pre-bind|post-bind", file=sys.stderr)
        sys.exit(2)
    phase = sys.argv[sys.argv.index("--phase") + 1]
    if phase == "pre-bind":
        pre_bind()
    elif phase == "post-bind":
        post_bind()
    else:
        print(f"unknown phase {phase}", file=sys.stderr)
        sys.exit(2)
    print(f"PREFLIGHT {phase}: "
          f"{'ok' if not FAILURES else 'FAIL ' + ','.join(FAILURES)}")
    sys.exit(0 if not FAILURES else 1)
