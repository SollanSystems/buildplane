#!/usr/bin/env python3
"""Raw wire probe that reports HOW a connection ended, as whatever UID runs it.

Purpose: a negative control that passes for the wrong reason is worse than no
control. The real client collapses every failure to the single string
`client_blocked`, so `client_blocked` alone cannot distinguish

  (a) the HOST rejecting the peer (SO_PEERCRED gate: zero response bytes, the
      host closes the stream before the response writer is ever reached), from
  (b) the CLIENT rejecting itself (install-identity or config gate: it never
      touches the socket at all).

This probe removes that ambiguity for case (a): it establishes a real connection
as the given UID, sends the same well-formed frame the real client sends, and
reports exactly how the exchange ended.

OBSERVED host-side rejection signature (measured, not assumed): the host closes
the accepted stream so early that `sendall` itself fails with EPIPE and zero
request bytes are delivered. That directly confirms the documented property that
peer verification is the host's FIRST operation -- "a rejected worker cannot
cause even a frame-header read or a tape write". A clean EOF with zero response
bytes after a successful send is the same rejection observed one step later;
both are accepted as host-side evidence, and this file computes that verdict
itself so no caller has to re-implement the predicate.

Emits one JSON line on stdout. Exit code is always 0: it reports, it does not judge.
"""
import errno
import json
import os
import socket
import struct
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

SOL_SOCKET = 1
SO_PEERCRED = 17


def main():
    report = {
        "euid": os.geteuid(),
        "egid": os.getegid(),
        "groups": sorted(os.getgroups()),
        "connected": False,
        "connect_error": None,
        "listener_creator": None,
        "sent_bytes": 0,
        "send_error": None,
        "response_bytes": 0,
        "read_outcome": None,
        "send_errno": None,
        "elapsed_ms": None,
        "host_side_rejection": False,
        "rejection_signature": None,
    }
    started = time.monotonic()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(8)
    try:
        sock.connect(P.SOCKET_PATH)
        report["connected"] = True
    except OSError as exc:
        report["connect_error"] = f"{type(exc).__name__}:{exc.errno}:{exc}"
        report["rejection_signature"] = "kernel_dac_denied_connect"
        report["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        print(json.dumps(report, sort_keys=True))
        return

    try:
        cred = sock.getsockopt(SOL_SOCKET, SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, gid = struct.unpack("3i", cred)
        report["listener_creator"] = {"pid": pid, "uid": uid, "gid": gid}
    except OSError as exc:
        report["listener_creator"] = f"error:{exc}"

    payload = json.dumps(
        {"request_id": str(uuid.uuid4()),
         "promotion_approval_request_event_id": P.APPROVAL_EVENT_ID,
         "decision": "promote"},
        separators=(",", ":")).encode()
    frame = struct.pack(">I", len(payload)) + payload
    try:
        sock.sendall(frame)
        report["sent_bytes"] = len(frame)
    except OSError as exc:
        report["send_error"] = f"{type(exc).__name__}:{exc.errno}:{exc}"
        report["send_errno"] = exc.errno

    received = b""
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                report["read_outcome"] = "eof"
                break
            received += chunk
            if len(received) >= 4:
                expected = 4 + struct.unpack(">I", received[:4])[0]
                if len(received) >= expected:
                    report["read_outcome"] = "complete_frame"
                    break
    except socket.timeout:
        report["read_outcome"] = "timeout"
    except OSError as exc:
        report["read_outcome"] = f"{type(exc).__name__}:{exc.errno}:{exc}"
    report["response_bytes"] = len(received)
    sock.close()
    report["elapsed_ms"] = int((time.monotonic() - started) * 1000)

    if report["response_bytes"] == 0 and report["read_outcome"] == "eof":
        if report["send_errno"] in (errno.EPIPE, errno.ECONNRESET):
            report["host_side_rejection"] = True
            report["rejection_signature"] = (
                "host closed the accepted stream before reading any frame byte "
                "(send failed EPIPE/ECONNRESET, 0 request bytes delivered, "
                "0 response bytes) -- peer verification precedes the frame read"
            )
        elif report["send_error"] is None:
            report["host_side_rejection"] = True
            report["rejection_signature"] = (
                "host accepted the frame then closed without writing any "
                "response byte (clean EOF) -- rejection precedes the response "
                "writer"
            )
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
