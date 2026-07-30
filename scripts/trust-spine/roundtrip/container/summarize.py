#!/usr/bin/env python3
"""Build /out/summary.json from the recorded checks and raw artifacts.

Deliberately built in Python, not a shell heredoc: a heredoc with embedded
command substitution silently produces invalid JSON the moment a value contains
a quote or a newline, and this artifact must be diffable across runs.

The summary hard-codes `sealed_reachable: false` with its verbatim blocker text,
and records the tape steps as an explicit N/A with the reason, so the file cannot
be quoted as more than it is.

Exit 0 iff every gated check passed.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402


def read_text(name, default=""):
    path = os.path.join(P.OUT_DIR, name)
    if not os.path.isfile(path):
        return default
    with open(path, "rb") as handle:
        return handle.read().decode(errors="replace")


def read_json(name, default=None):
    raw = read_text(name)
    if not raw.strip():
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


def read_int(name, default=None):
    raw = read_text(name).strip()
    try:
        return int(raw)
    except ValueError:
        return default


def last_json_line(name):
    for line in reversed(read_text(name).splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def load_checks():
    checks = []
    for line in read_text("checks.tsv").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        while len(parts) < 3:
            parts.append("")
        checks.append({"name": parts[0], "status": parts[1],
                       "detail": parts[2]})
    return checks


def main():
    checks = load_checks()
    failed = [c["name"] for c in checks if c["status"] != "ok"]

    stdout_bytes = b""
    stdout_path = os.path.join(P.OUT_DIR, "client.stdout")
    if os.path.isfile(stdout_path):
        with open(stdout_path, "rb") as handle:
            stdout_bytes = handle.read()

    summary = {
        "proof": "first live promotion-decision authority host/client round trip",
        "proof_target": (
            "signed reconciliation_required response from a real "
            "buildplane-authority-host (fd-3 socket activation, EUID 4201) to "
            "the real installed buildplane-authority-client (zero argv, EUID "
            "4202), over an empty-but-genuine ledger"
        ),
        "gated_result": "PASS" if not failed else "FAIL",
        "failed_checks": failed,
        "checks": checks,

        "client": {
            "exit": read_int("client.exit"),
            "stdout_bytes": len(stdout_bytes),
            "stdout_sha256": hashlib.sha256(stdout_bytes).hexdigest(),
            "stdout_literal": stdout_bytes.decode(errors="replace"),
            "stdout_byte_exact": stdout_bytes == P.EXPECTED_CLIENT_STDOUT,
            "stderr_literal": read_text("client.stderr"),
        },
        "shadow_verify": last_json_line("shadow.log"),
        "listener_facts": read_json("listener-facts.json"),
        "provision_manifest": read_json("manifest.json"),

        "ledger_events": {
            "before": read_text("events.before").strip(),
            "after": read_text("events.after").strip(),
            "contract": (
                "record_from_approval_decision returns ReconciliationRequired "
                "before record_then_seal is reached, so a correct "
                "implementation appends nothing. A non-zero count after the "
                "round trip is a genuine protocol defect, not a harness bug."
            ),
        },

        "negative_controls": {
            "N1_client_as_root": {
                "intent": "the host's SO_PEERCRED peer-UID gate must refuse uid 0",
                "client_exit": read_int("n1.exit"),
                "client_stderr": read_text("n1.stderr"),
                "client_stdout_bytes": len(read_text("n1.stdout")),
                "elapsed_ms": read_int("n1.elapsed_ms"),
                "host_side_evidence": read_json("n1-probe.json"),
                "discriminator": (
                    "peer-probe.py run as uid 0 established a real connection "
                    "to the live host pid and was closed with zero response "
                    "bytes. That is positive evidence the HOST rejected the "
                    "peer, not that the client self-rejected. MEASURED "
                    "REFINEMENT: the close is so early that sendall itself "
                    "fails EPIPE with zero request bytes delivered, which "
                    "confirms the documented property that peer verification "
                    "precedes even the frame-header read."
                ),
            },
            "N5_socket_group_member_not_in_allowlist": {
                "intent": (
                    "a real non-root UID that IS a socket-group member but is "
                    "NOT in promotion_decision_client_uids must still be "
                    "refused by the host"
                ),
                "host_side_evidence": read_json("n5-probe.json"),
                "discriminator": (
                    "kernel DAC cannot explain this rejection -- this UID is a "
                    "socket-group member and its connect(2) succeeded -- so the "
                    "zero-byte close isolates the host's configured-allowlist "
                    "check specifically, independently of the root case."
                ),
            },
            "N6_non_socket_group_uid": {
                "intent": (
                    "the socket's 0660 root:<socket_gid> mode must make the "
                    "kernel refuse connect(2) for a non-member UID, before any "
                    "Buildplane code runs"
                ),
                "host_side_evidence": read_json("n6-probe.json"),
                "discriminator": (
                    "a distinct failure signature from N1/N5: connect(2) itself "
                    "fails EACCES, so the socket mode/group gate is proven live "
                    "rather than merely configured."
                ),
            },
            "N2_uninstalled_client_copy": {
                "intent": (
                    "the client's /proc/self/exe path + dev/ino "
                    "self-attestation must refuse a byte-identical copy at "
                    "another path"
                ),
                "client_exit": read_int("n2.exit"),
                "client_stderr": read_text("n2.stderr"),
                "elapsed_ms": read_int("n2.elapsed_ms"),
                "copy_sha256_matches_installed":
                    read_text("n2.sha256_match").strip() == "yes",
                "discriminator": (
                    "single-variable control: byte-identical bytes, same mode "
                    "0755, same uid 4202, same stdin, same live host that had "
                    "just returned exit 0 for the installed path seconds "
                    "earlier. Only the executable's path/dev/ino changed. "
                    "HONEST LIMIT: this is a controlled-variable argument, not "
                    "a directly observed host-side event -- the failure is "
                    "client-side by construction (it precedes any socket use), "
                    "so no host-side trace exists to observe."
                ),
            },
            "N3_world_readable_host_config": {
                "intent": (
                    "validate_config_file_facts must fail closed on mode 0644 "
                    "(other-read)"
                ),
                "launcher_exit": read_int("n3.exit"),
                "host_stderr": read_text("n3.host.stderr"),
                "restart_after_restoring_0640": read_text("n3b.result").strip(),
                "discriminator": (
                    "N3b restores mode 0640 and restarts with everything else "
                    "untouched; the host then starts alive and silent again, "
                    "so the 0644 failure cannot be attributed to a leftover or "
                    "unrelated cause."
                ),
            },
        },

        "sealed_reachable": False,
        "sealed_blocker": P.SEALED_BLOCKER,
        "tape_verification": {
            "status": "N/A",
            "reason": P.TAPE_NA_REASON,
            "export_exit": read_int("tape-export.exit"),
            "verify_exit": read_text("tape-verify.exit").strip() or "not-run",
            "gated": False,
        },
        "scope_limits": [
            "This proves the promotion-DECISION pair only. The promotion-"
            "EXECUTION leg (promotion-execution-v1.sock, a different host "
            "binary) is untouched, and a non-reconciliation execution status "
            "inherits the same unreachable-lifecycle blocker.",
            "A green run must NOT be described as 'the governed promotion path "
            "works end to end', as 'promotion sealed', or as 'tape-verified'.",
            "The external verifier proves consistency of the response signature "
            "against the key pinned in the client config; that key was "
            "generated by this harness, so the claim is 'only a host holding "
            "the real private seed could have produced this response', not a "
            "third-party authenticity claim about a production key.",
        ],
    }

    path = os.path.join(P.OUT_DIR, "summary.json")
    with open(path, "w") as handle:
        json.dump(summary, handle, indent=2, sort_keys=False)
        handle.write("\n")
    print(json.dumps({"gated_result": summary["gated_result"],
                      "failed_checks": failed}, indent=2))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
