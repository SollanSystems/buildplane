#!/usr/bin/env python3
"""Independent external verifier for the promotion-decision wire response.

Speaks the real protocol as an allowed client UID and verifies the host's Ed25519
signature ITSELF (via openssl, no third-party Python deps), so the cryptographic
claim does not depend on trusting the Rust client. This is the wire-level
analogue of scripts/verify-signed-tape.mjs: it removes Rust from the crypto path.

The canonical payload layouts below are transcribed from
promotion_decision_response.rs:147-178 (canonical_unsigned_payload /
canonical_signed_payload) and the domain prefix from :15.

Exit 0 iff the signature verifies AND the response bytes equal the recomputed
canonical signed payload AND the response is bound to this process's own fresh
request_id.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

SOL_SOCKET = 1
SO_PEERCRED = 17
FAILURES = []


def check(name, ok, detail=""):
    ok = bool(ok)
    print(f"CHECK shadow:{name} {'ok' if ok else 'FAIL'}"
          f"{(' ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)
    return ok


def canonical_unsigned(request_id, approval_id, decision, status, event_id):
    event = "null" if event_id is None else f'"{event_id}"'
    return (
        '{"schema_version":2,"protocol":"buildplane-promotion-decision",'
        '"domain":"protected-authority-response",'
        f'"request_id":"{request_id}",'
        f'"promotion_approval_request_event_id":"{approval_id}",'
        f'"decision":"{decision}",'
        f'"promotion_decision_event_id":{event},'
        f'"status":"{status}"}}'
    ).encode()


def canonical_signed(unsigned, signature_hex):
    return unsigned[:-1] + b',"signature":"' + signature_hex.encode() + b'"}'


def verify_ed25519(pub32, message, signature):
    with tempfile.TemporaryDirectory() as tmp:
        key = os.path.join(tmp, "pub.der")
        msg = os.path.join(tmp, "msg.bin")
        sig = os.path.join(tmp, "sig.bin")
        with open(key, "wb") as handle:
            handle.write(P.SPKI_ED25519_PREFIX + bytes(pub32))
        with open(msg, "wb") as handle:
            handle.write(message)
        with open(sig, "wb") as handle:
            handle.write(signature)
        result = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", key,
             "-keyform", "DER", "-rawin", "-in", msg, "-sigfile", sig],
            capture_output=True)
        return (result.returncode == 0,
                (result.stdout + result.stderr).decode(errors="replace").strip())


def recv_exact(sock, count):
    buffer = b""
    while len(buffer) < count:
        chunk = sock.recv(count - len(buffer))
        if not chunk:
            break
        buffer += chunk
    return buffer


def main():
    with open(P.CLIENT_CONFIG, "rb") as handle:
        client_config = json.load(handle)
    pub = client_config["broker_identity_public_key"]

    request_id = str(uuid.uuid4())
    decision = "promote"
    payload = json.dumps(
        {"request_id": request_id,
         "promotion_approval_request_event_id": P.APPROVAL_EVENT_ID,
         "decision": decision},
        separators=(",", ":")).encode()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(8)
    sock.connect(P.SOCKET_PATH)

    cred = sock.getsockopt(SOL_SOCKET, SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", cred)
    print(f"OBSERVED listener_creator pid={pid} uid={uid} gid={gid}")
    print(f"OBSERVED self euid={os.geteuid()} egid={os.getegid()} "
          f"groups={sorted(os.getgroups())}")
    check("listener-creator-uid-is-0", uid == 0, f"uid={uid}")
    check("listener-creator-pid-positive", pid > 0, f"pid={pid}")

    sock.sendall(struct.pack(">I", len(payload)) + payload)

    header = recv_exact(sock, 4)
    if not check("response-header-4-bytes", len(header) == 4, repr(header)):
        print(json.dumps({"shadow_status": None, "listener_creator_uid": uid,
                          "failures": FAILURES}))
        sys.exit(1)
    length = struct.unpack(">I", header)[0]
    check("response-length-bounded", 0 < length <= 4096, str(length))
    body = recv_exact(sock, length)
    check("response-body-complete", len(body) == length,
          f"{len(body)}/{length}")
    check("no-trailing-bytes-after-frame", sock.recv(1) == b"")
    sock.close()

    parsed = json.loads(body)
    check("envelope-schema-version-2", parsed.get("schema_version") == 2)
    check("envelope-protocol", parsed.get("protocol")
          == "buildplane-promotion-decision")
    check("envelope-domain", parsed.get("domain")
          == "protected-authority-response")
    check("echoes-fresh-request-id", parsed.get("request_id") == request_id,
          "replay/binding: the response must be bound to the id minted here")
    check("echoes-approval-id",
          parsed.get("promotion_approval_request_event_id")
          == P.APPROVAL_EVENT_ID)
    check("echoes-decision", parsed.get("decision") == decision)
    status = parsed.get("status")
    check("status-known", status in ("sealed", "reconciliation_required"),
          str(status))
    event_id = parsed.get("promotion_decision_event_id")
    check("outcome-binding-consistent",
          (status == "reconciliation_required" and event_id is None)
          or (status == "sealed" and isinstance(event_id, str)))
    # A `sealed` status against an empty ledger would be a CRITICAL protocol
    # defect, not a better result. Flag it loudly rather than celebrating it.
    if status == "sealed":
        print("DEFECT-CANDIDATE sealed disposition against an empty ledger: "
              "the candidate/acceptance/review cross-checks were bypassed")

    unsigned = canonical_unsigned(request_id, P.APPROVAL_EVENT_ID, decision,
                                  status, event_id)
    signature_hex = parsed.get("signature", "")
    check("signature-hex-128-chars", len(signature_hex) == 128,
          str(len(signature_hex)))
    check("bytes-are-canonical-signed-payload",
          body == canonical_signed(unsigned, signature_hex),
          "byte-for-byte recomputation, not a field-wise comparison")

    ok, detail = verify_ed25519(pub, P.SIGNATURE_DOMAIN + unsigned,
                                bytes.fromhex(signature_hex))
    check("ed25519-signature-verifies-under-openssl", ok, detail)

    # Emitted on stdout only. This process runs as the unprivileged client UID
    # and deliberately never writes into the artifact directory, so nothing it
    # produces can be mistaken for a privileged harness artifact; roundtrip.sh
    # tees this stream and summarize.py parses the final JSON line.
    result = {"shadow_status": status,
              "listener_creator_uid": uid,
              "listener_creator_pid": pid,
              "request_id": request_id,
              "response_bytes": len(body),
              "signature_hex": signature_hex,
              "failures": FAILURES}
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if not FAILURES else 1)


if __name__ == "__main__":
    main()
