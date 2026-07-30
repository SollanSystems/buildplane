# Trust Spine — first live authority-host round trip receipt

## Identity

| Field | Value |
|---|---|
| Date | 2026-07-29 |
| Base commit | `a5dd9ca` (main, immediately after the Trust Spine merge `a53519b`) |
| Harness | `scripts/trust-spine/roundtrip/` (`run.sh` is the single entrypoint) |
| Surface proven | `buildplane-authority-host` ↔ `buildplane-authority-client` (promotion-decision role) |
| Result | **PASS** — 23/23 gated checks, `gated_result: "PASS"`, `failed_checks: []` |

This receipt exists because the Trust Spine landed without one. Every milestone
M2–M6 closed with a GATE receipt in `docs/operations/`; PR #281 did not. It also
closes the largest unmeasured risk that the post-merge audit identified: **not one
of the four protected hosts had ever served a real request.** Every protocol claim
in the crate rested on in-process `UnixStream::pair` unit tests plus
argument-rejection tests, and the only two client binary-level tests assert
`invalid_arguments` and `client_blocked`.

## What was proven

A real `buildplane-authority-host` — built from this checkout, installed to
`/usr/libexec/buildplane`, running as EUID 4201 on an **inherited fd-3 listener**
at `/run/buildplane/authority-host/promotion-decision-v1.sock` exactly as the
systemd unit would supply it — served the real installed
`buildplane-authority-client` invoked with zero argv as EUID 4202 (member of the
socket group gid 4210), and returned a **kernel-key-signed** response.

```
client exit:   0
client stderr: (empty)
client stdout: {"schema_version":2,"status":"reconciliation_required","promotion_decision_event_id":null}
               91 bytes, sha256 95d82c55e97113fadc9c11f622586b26ec94cb2173ca40d3cfe9678143918be0
ledger events: 0 before  ->  0 after
```

The traversed trust surface, each gate asserted rather than assumed: fd-3
validation (`S_ISSOCK`, `SO_DOMAIN`, `SO_TYPE`, `SO_ACCEPTCONN`, kernel pathname
equality), the root-owned `O_NOFOLLOW` descriptor walk over `/etc`, the closed
host-config schema, the `authority_root` 0700/broker-owned walk, the path-based
socket metadata gate, `geteuid() == broker_uid` attestation, both Ed25519 seed
loads with public-key-hash match and anti-aliasing, ledger custody including the
`/proc/self/fd` canonical-identity cross-check, the client's `/proc/self/exe`
dev+ino self-attestation, the client-config gate, the client→listener-creator
`SO_PEERCRED` check, the host→client `SO_PEERCRED` check per read and per write,
BE-u32 framing both directions, and the client's `verify_strict` plus
request-binding and EOF-after-frame assertions.

**No test-only override, no patched constant, no relaxed mode.** Every gate was
satisfied properly. `git status` confirms zero modifications under `native/`,
`apps/`, or `packages/` — the harness is additive only.

## Independent verification

The cryptographic claim does not depend on the Rust client. A shadow verifier
speaks the raw wire as uid 4202, recomputes the canonical unsigned payload
byte-for-byte, and verifies the signature with
`openssl pkeyutl -verify -pubin -rawin` → `Signature Verified Successfully`.
The adversarial reviewer additionally wrote a *from-scratch* verifier,
transcribing the payload format directly from `promotion_decision_response.rs`
rather than reusing the harness script; it verified on every run, and a
bit-flip negative control correctly failed.

Reproduced **six times by three independent actors** — implementer ×3, adversarial
reviewer ×2 from a fresh container, and the principal ×1 — with identical client
stdout sha256 every time. Each run generates fresh Ed25519 keys, a fresh ledger,
and a fresh `request_id`, and therefore produces a **different signature**, which
is what rules out caching or a hardcoded response.

## Negative controls

A control that passes for the wrong reason is worse than no control, so four of
the six carry directly observed host-side or kernel-side evidence rather than
inference.

| Control | Outcome | Evidence |
|---|---|---|
| N1 — real client as uid 0, all other gates satisfied | refused | Connection reached the live host pid; `sendall` failed `EPIPE` with **zero request bytes delivered** → the host's `SO_PEERCRED` gate, not a client self-rejection |
| N5 — uid 4203, socket-group member but not in `promotion_decision_client_uids` | refused | `connect(2)` succeeded, then zero response bytes and EOF → isolates the configured allowlist specifically, since kernel DAC cannot explain it |
| N6 — uid 65534, not a socket-group member | refused at the kernel | `PermissionError: 13` on `connect(2)` → the socket's `0660 root:4210` mode is load-bearing, refused before any Buildplane code runs |
| N2 — byte-identical client copy at another path | refused | `client_blocked`, 18 ms. **Honest limit:** a controlled-variable argument, not host-side evidence — `/proc/self/exe` self-attestation precedes any socket use, so no host-side trace can exist |
| N3 — host config `chmod 0644` | startup refused | host stderr byte-exactly `startup_failed`, launcher stderr empty |
| N3b — restore `0640`, restart, nothing else touched | started | alive and silent → makes config mode the only variable in N3 |

The host **survived all three rejected connections** and returned a second
byte-exact exit-0 response afterward, confirming `ConnectionFailed` is swallowed
by the accept loop rather than being host-fatal.

## Known limitations disclosed at this gate

These are stated plainly so this receipt cannot be quoted as more than it is.

1. **A `sealed` promotion is NOT reachable in this repo state, and was not
   attempted.** `BrokerPromotionDecisionAuthority::record_from_approval_decision`
   short-circuits to `ReconciliationRequired` *before any ledger write* unless the
   tape already carries a fully cross-consistent workflow in phase
   `PromotionApprovalPending` (dispatch + `CandidateCreated` +
   `CandidateCompletion` + `Acceptance(Passed)` + ≥1 Approve review +
   `PromotionApprovalRequested`, with matching digests and refs). The modules that
   would produce that chain are `#[allow(dead_code)]`, and the OCI path hard-pins
   `/usr/bin/podman` with no Docker fallback. Seeding that chain by writing Rust
   that mints authority-bearing events would be **fabricating evidence** — exactly
   the rigging this exercise exists to disprove — so it was refused.
   `summary.json` hard-codes `sealed_reachable: false` with the verbatim blocker.
2. **`scripts/verify-signed-tape.mjs` is N/A here and is not a gate.** The
   reconciliation path appends zero events, so there is nothing to verify. The
   tape-side evidence is inverted instead: the event count must be 0 **before and
   after**. The export command's verbatim exit code (1) is recorded and `node` is
   absent from the harness image, so the verifier is logged `"not-run"` rather
   than implied to have passed.
3. **Scope is the promotion-DECISION pair only.** The promotion-execution leg
   (different host, socket, and config) is untouched and inherits the same
   unreachable-lifecycle blocker. The governed-session host was not exercised at
   all, because its startup composition calls the OCI attestation.
4. **PlanForge remains unbuilt at the protocol level**, unchanged by this work:
   `admitPlanForge` and `openPlanForgeCandidateSession` are hardcoded throws that
   fire even against a live healthy host, and there are zero `planforge`
   references in the broker crate.
5. **This is not GA enrollment.** A container with distinct UIDs is not a separate
   OS/hardware-protected host, and nothing here enrolls a key in the pinned trust
   root. The five numbered operator gates in the governed runbook remain open.

## Genuine findings

1. **Peer rejection precedes any frame read — measured, not inferred.** A raw
   connection from uid 0, and independently from uid 4203, reached the live host
   and `sendall` failed `EPIPE` having delivered zero request bytes. This
   empirically confirms the property documented in `promotion_decision_handler.rs`
   that no test in the repo had ever exercised at the process level.
2. **A single-process launcher is sufficient.** `SO_PEERCRED` read by the
   unprivileged client reported `uid=0 pid=84`, where 84 is the host's own pid
   *after* `setgroups`+`setgid`+`setuid`+`execve`. The kernel's peercred snapshot
   taken in `unix_listen()` is not rewritten by a later privilege drop in the same
   PID, so a root parent forking a setuid child is unnecessary. This falsifies the
   contrary reading flagged as the plan's one open runtime unknown.
3. **The host config must be uid 0, mode 0640, gid == `broker_gid`.**
   `validate_config_file_facts` admits only 0600 and 0640, but the config is read
   *after* the process drops to `broker_uid` — so the otherwise-obvious
   `0600 root:root` is policy-legal and unreadable, and fails with the identical
   opaque `startup_failed`. The gid is not checked by the loader, which is what
   makes `0:<broker_gid> 0640` the only shape satisfying both the fail-closed
   policy and the reader's own permissions.
4. **`ledger export-signed-tape` fails yet still materializes a valid ledger.**
   It exits 1, but its first action (`SqliteStore::open` → `init`) produces a
   genuine schema-complete WAL-mode `events.db` with zero events. Validating the
   produced *file* and ignoring the command's exit code is therefore the correct
   contract — and the host, which refuses to create or repair a ledger, accepted it.
5. **The `#[allow(dead_code)]` attributes live on the `mod` declarations in
   `lib.rs`, not inside the module files.** Grepping those files directly returns
   zero matches, which makes the sealed-unreachability blocker — the load-bearing
   honesty caveat of this whole exercise — look false to anyone who checks it the
   obvious way.
6. **The client writes its stdout newline in a separate `write_all`.** Any
   comparison via shell command substitution strips it and silently passes a
   wrong-length output; `cmp` against a byte-exact file is the only sound check.

The failure surface is fully redacted — `startup_failed`, `accept_failed`,
`unsupported_platform`, `client_blocked` — with no debug or verbose env var
anywhere in the crate. `preflight.py` therefore asserts every precondition
independently *before* the host starts, so an opaque failure becomes a named
assertion. That is why the entire Buildplane-facing path succeeded on the first
attempt with zero opaque failures.

## Next gate

1. Provision a Podman that supplies `--no-hostname` at the pinned
   `/usr/bin/podman`, then exercise `attest_rootless_oci_v1` against the real
   binary, replacing the `FakeRunner` every existing attestation test injects.
   This unblocks the governed-session host, and therefore the
   candidate → review → promotion cycle.

   **Verified blocker (2026-07-29): Podman `4.9.3` is insufficient.** The
   feasibility probe requires all nine of `--read-only`, `--network`,
   `--http-proxy`, `--no-hosts`, `--no-hostname`, `--cap-drop`,
   `--security-opt`, `--userns`, `--entrypoint` in `podman run --help`. Only
   `--no-hostname` is missing on `4.9.3`, and it is genuinely passed by both the
   governed run arguments (`rootless_oci.rs:392`) and the startup canary
   (`:633`) — so the probe is correct to demand it and correctly fail-closes.
   Ubuntu 24.04 LTS ships only `4.9.3` in every repo, so the distro package
   cannot satisfy the OCI plane. `podman unshare true` passes on `4.9.3`, so a
   green userns probe is not evidence of readiness. The version floor is now
   recorded in the governed runbook; this was found by probing before building
   the governed-session host rather than after.
2. Reach a `sealed` promotion honestly, by driving the real candidate lifecycle
   through the governed-session host — never by seeding the tape.
3. Design and build PlanForge admission/dispatch as views over the candidate and
   promotion transaction. This is unbuilt design work, not ops, and it is what
   restores the dogfood thesis.
