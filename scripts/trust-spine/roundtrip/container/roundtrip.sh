#!/usr/bin/env bash
# In-container orchestration of the first live promotion-decision round trip.
#
# Runs as root inside a throwaway container. Root is required to create uid-0
# 0755 trees, to bind+listen the socket as the listener creator, and to setuid
# before exec. --privileged is NOT used and must not be: CAP_CHOWN/CAP_SETUID/
# CAP_SETGID are in Docker's default set, and weakening the sandbox would weaken
# the claim.
#
# No step relaxes a Buildplane constant. Every owner/mode/path/fd value written
# here is the value the Rust binaries enforce.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=/out
CLIENT_BIN=/usr/libexec/buildplane/buildplane-authority-client
COPIED_CLIENT=/tmp/copied-client
NATIVE_BIN=/usr/libexec/buildplane/buildplane-native
LEDGER_DB=/var/lib/buildplane/authority/ledger/events.db
HOST_CONFIG=/etc/buildplane/authority-host/promotion-decision-v1.json
SOCKET=/run/buildplane/authority-host/promotion-decision-v1.sock
RUN_ID=018f2e40-0000-7000-8000-000000000001

mkdir -p "$OUT"
: >"$OUT/checks.tsv"

record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$OUT/checks.tsv"
  printf 'CHECK %s %s %s\n' "$1" "$2" "${3:-}"
}
ok_or_fail() { [ "$1" = 0 ] && echo ok || echo FAIL; }
as_client() { setpriv --reuid=4202 --regid=4202 --groups=4210 "$@"; }
as_outsider() { setpriv --reuid=4203 --regid=4203 --groups=4210 "$@"; }
# nobody(65534) is deliberately NOT a member of the socket group.
as_nonmember() { setpriv --reuid=65534 --regid=65534 --groups=65534 "$@"; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# Byte-exact expected outputs. Never compared with shell string equality: a
# command substitution strips trailing newlines, which is precisely the
# difference that matters here.
printf '{"schema_version":2,"status":"reconciliation_required","promotion_decision_event_id":null}\n' \
  >"$OUT/client.expected"
printf 'client_blocked\n' >"$OUT/expected.client_blocked"
printf 'startup_failed\n' >"$OUT/expected.startup_failed"
REQUEST='{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote"}'

echo "===== 0. environment ====="
uname -a
openssl version
python3 --version
sqlite3 --version

echo "===== 1. ABI/liveness probe (expect invalid_arguments / exit 1) ====="
/repo/native/target/debug/buildplane-authority-host x >"$OUT/abi.stdout" 2>"$OUT/abi.stderr"
ABI_EXIT=$?
if [ "$ABI_EXIT" = 1 ] && grep -qx invalid_arguments "$OUT/abi.stderr"; then
  record abi-probe-argv-guard ok "exit=1 stderr=invalid_arguments"
else
  record abi-probe-argv-guard FAIL "exit=$ABI_EXIT stderr=$(cat "$OUT/abi.stderr")"
fi

echo "===== 2. provision ====="
if python3 "$HERE/provision.py" >"$OUT/provision.log" 2>&1; then
  record provision ok
else
  record provision FAIL "see $OUT/provision.log"
  cat "$OUT/provision.log"
  python3 "$HERE/summarize.py"
  exit 1
fi
cat "$OUT/provision.log"

echo "===== 3. preflight (pre-bind) ====="
python3 "$HERE/preflight.py" --phase pre-bind >"$OUT/preflight-pre.log" 2>&1
PRE_EXIT=$?
cat "$OUT/preflight-pre.log"
record preflight-pre-bind "$(ok_or_fail "$PRE_EXIT")" \
  "$(grep -c '^CHECK .* FAIL' "$OUT/preflight-pre.log") failing gates"
if [ "$PRE_EXIT" != 0 ]; then
  echo "ABORT: a precondition the host would report only as 'startup_failed' is unmet."
  python3 "$HERE/summarize.py"
  exit 1
fi

echo "===== 4. ledger event count BEFORE ====="
sqlite3 "$LEDGER_DB" 'select count(*) from events;' >"$OUT/events.before" 2>&1
BEFORE=$(tr -d '[:space:]' <"$OUT/events.before")
record events-before-zero "$([ "$BEFORE" = 0 ] && echo ok || echo FAIL)" "count=$BEFORE"

echo "===== 5. launch host on inherited fd 3 ====="
nohup python3 "$HERE/launch-host.py" --stderr "$OUT/host.stderr" \
  --facts "$OUT/listener-facts.json" \
  >"$OUT/launcher.stdout" 2>"$OUT/launcher.stderr" &
HOST_PID=$!
echo "$HOST_PID" >"$OUT/host.pid"
sleep 2

echo "===== 6. preflight (post-bind) ====="
python3 "$HERE/preflight.py" --phase post-bind >"$OUT/preflight-post.log" 2>&1
POST_EXIT=$?
cat "$OUT/preflight-post.log"
record preflight-post-bind "$(ok_or_fail "$POST_EXIT")" \
  "$(grep -c '^CHECK .* FAIL' "$OUT/preflight-post.log") failing gates"

echo "===== 7. host startup proof: alive and silent ====="
if kill -0 "$HOST_PID" 2>/dev/null; then
  record host-alive ok "pid=$HOST_PID"
else
  record host-alive FAIL "host exited; stderr=$(cat "$OUT/host.stderr")"
fi
if [ -s "$OUT/host.stderr" ]; then
  record host-stderr-empty FAIL "$(cat "$OUT/host.stderr")"
  echo "The host emitted a redacted diagnostic. Cross-reference the spec debug_map."
else
  record host-stderr-empty ok "no startup_failed / accept_failed"
fi
if [ -s "$OUT/launcher.stderr" ]; then
  record launcher-stderr-empty FAIL "$(cat "$OUT/launcher.stderr")"
else
  record launcher-stderr-empty ok
fi

echo "===== 8. shadow round trip (independent Ed25519 verification) ====="
as_client python3 "$HERE/shadow-verify.py" >"$OUT/shadow.log" 2>&1
SHADOW_EXIT=$?
cat "$OUT/shadow.log"
record shadow-roundtrip "$(ok_or_fail "$SHADOW_EXIT")" "exit=$SHADOW_EXIT"

echo "===== 9. THE PROOF: the real installed client, zero argv, uid 4202 ====="
printf '%s' "$REQUEST" | as_client "$CLIENT_BIN" \
  >"$OUT/client.stdout" 2>"$OUT/client.stderr"
CLIENT_EXIT=$?
echo "$CLIENT_EXIT" >"$OUT/client.exit"
record client-exit-0 "$([ "$CLIENT_EXIT" = 0 ] && echo ok || echo FAIL)" \
  "exit=$CLIENT_EXIT stderr=$(cat "$OUT/client.stderr")"
if [ -s "$OUT/client.stderr" ]; then
  record client-stderr-empty FAIL "$(cat "$OUT/client.stderr")"
else
  record client-stderr-empty ok
fi
if cmp -s "$OUT/client.stdout" "$OUT/client.expected"; then
  record client-stdout-byte-exact ok
else
  record client-stdout-byte-exact FAIL \
    "got=$(od -c "$OUT/client.stdout" | head -4 | tr '\n' ' ')"
fi
echo "--- client stdout (verbatim) ---"
cat "$OUT/client.stdout"

echo "===== 10. ledger event count AFTER (fail-closed no-write contract) ====="
sqlite3 "$LEDGER_DB" 'select count(*) from events;' >"$OUT/events.after" 2>&1
AFTER=$(tr -d '[:space:]' <"$OUT/events.after")
record events-after-zero "$([ "$AFTER" = 0 ] && echo ok || echo FAIL)" "count=$AFTER"
if [ "$AFTER" != 0 ]; then
  echo "DEFECT-CANDIDATE: the reconciliation path appended $AFTER event(s)."
fi

echo "===== 11. negative control N1: client as root must be refused ====="
N1_START=$(now_ms)
printf '%s' "$REQUEST" | "$CLIENT_BIN" >"$OUT/n1.stdout" 2>"$OUT/n1.stderr"
N1=$?
echo $(( $(now_ms) - N1_START )) >"$OUT/n1.elapsed_ms"
echo "$N1" >"$OUT/n1.exit"
if [ "$N1" != 0 ] && cmp -s "$OUT/n1.stderr" "$OUT/expected.client_blocked" \
   && [ ! -s "$OUT/n1.stdout" ]; then
  record negative-N1-root-client-blocked ok "exit=$N1"
else
  record negative-N1-root-client-blocked FAIL \
    "exit=$N1 stderr=$(cat "$OUT/n1.stderr") stdout_bytes=$(wc -c <"$OUT/n1.stdout")"
fi
# Direct host-side evidence that N1 failed at the host's peer gate, not inside
# the client: a raw root connection that sends a valid frame and gets 0 bytes.
python3 "$HERE/peer-probe.py" >"$OUT/n1-probe.json" 2>"$OUT/n1-probe.err"
cat "$OUT/n1-probe.json"
if python3 -c "
import json,sys
r=json.load(open('$OUT/n1-probe.json'))
sys.exit(0 if (r['euid']==0 and r['connected']
               and r['listener_creator']['uid']==0
               and r['listener_creator']['pid']==$HOST_PID
               and r['host_side_rejection'] is True) else 1)
" 2>/dev/null; then
  record negative-N1-host-side-rejection ok \
    "$(python3 -c "import json;print(json.load(open('$OUT/n1-probe.json'))['rejection_signature'])")"
else
  record negative-N1-host-side-rejection FAIL "$(cat "$OUT/n1-probe.json")"
fi

echo "===== 12. negative control N5: socket-group member outside the allowlist ====="
as_outsider python3 "$HERE/peer-probe.py" >"$OUT/n5-probe.json" 2>"$OUT/n5-probe.err"
cat "$OUT/n5-probe.json"
if python3 -c "
import json,sys
r=json.load(open('$OUT/n5-probe.json'))
sys.exit(0 if (r['euid']==4203 and r['connected']
               and r['listener_creator']['pid']==$HOST_PID
               and r['host_side_rejection'] is True) else 1)
" 2>/dev/null; then
  record negative-N5-outsider-uid-host-side-rejection ok \
    "uid 4203 connected (kernel DAC allowed it) and was refused by the host allowlist"
else
  record negative-N5-outsider-uid-host-side-rejection FAIL "$(cat "$OUT/n5-probe.json")"
fi

echo "===== 12b. negative control N6: non-member of the socket group ====="
# Proves the 0660 root:<socket_gid> mode is actually load-bearing: a UID outside
# the socket group must be denied by the kernel at connect(2), before any
# Buildplane code runs. Distinct failure signature from N1/N5.
as_nonmember python3 "$HERE/peer-probe.py" >"$OUT/n6-probe.json" 2>"$OUT/n6-probe.err"
cat "$OUT/n6-probe.json"
if python3 -c "
import errno,json,sys
r=json.load(open('$OUT/n6-probe.json'))
sys.exit(0 if (r['euid']==65534 and r['connected'] is False
               and r['rejection_signature']=='kernel_dac_denied_connect'
               and str(errno.EACCES) in (r['connect_error'] or '')) else 1)
" 2>/dev/null; then
  record negative-N6-non-socket-group-denied-by-kernel ok \
    "connect(2) refused with EACCES before any Buildplane code ran"
else
  record negative-N6-non-socket-group-denied-by-kernel FAIL "$(cat "$OUT/n6-probe.json")"
fi

echo "===== 13. negative control N2: byte-identical client copy at another path ====="
cp "$CLIENT_BIN" "$COPIED_CLIENT"
chmod 0755 "$COPIED_CLIENT"
chown 0:0 "$COPIED_CLIENT"
if [ "$(sha256sum <"$CLIENT_BIN" | cut -d' ' -f1)" \
   = "$(sha256sum <"$COPIED_CLIENT" | cut -d' ' -f1)" ]; then
  echo yes >"$OUT/n2.sha256_match"
  record negative-N2-copy-is-byte-identical ok "single-variable control precondition"
else
  echo no >"$OUT/n2.sha256_match"
  record negative-N2-copy-is-byte-identical FAIL "copy differs from the installed binary"
fi
N2_START=$(now_ms)
printf '%s' "$REQUEST" | as_client "$COPIED_CLIENT" \
  >"$OUT/n2.stdout" 2>"$OUT/n2.stderr"
N2=$?
echo $(( $(now_ms) - N2_START )) >"$OUT/n2.elapsed_ms"
echo "$N2" >"$OUT/n2.exit"
if [ "$N2" != 0 ] && cmp -s "$OUT/n2.stderr" "$OUT/expected.client_blocked" \
   && [ ! -s "$OUT/n2.stdout" ]; then
  record negative-N2-copied-client-blocked ok "exit=$N2"
else
  record negative-N2-copied-client-blocked FAIL \
    "exit=$N2 stderr=$(cat "$OUT/n2.stderr")"
fi

echo "===== 14. host survives rejected connections (supervision semantics) ====="
if kill -0 "$HOST_PID" 2>/dev/null && [ ! -s "$OUT/host.stderr" ]; then
  record host-survives-rejected-connections ok "still alive and silent"
else
  record host-survives-rejected-connections FAIL \
    "pid gone or stderr=$(cat "$OUT/host.stderr")"
fi

echo "===== 15. re-run the proof to show the host is still serving ====="
printf '%s' "$REQUEST" | as_client "$CLIENT_BIN" \
  >"$OUT/client2.stdout" 2>"$OUT/client2.stderr"
CLIENT2_EXIT=$?
if [ "$CLIENT2_EXIT" = 0 ] && cmp -s "$OUT/client2.stdout" "$OUT/client.expected" \
   && [ ! -s "$OUT/client2.stderr" ]; then
  record proof-repeatable-after-negatives ok "second exchange also exit 0, byte-exact"
else
  record proof-repeatable-after-negatives FAIL \
    "exit=$CLIENT2_EXIT stderr=$(cat "$OUT/client2.stderr")"
fi

echo "===== 16. negative control N3: world-readable host config must fail startup ====="
kill "$HOST_PID" 2>/dev/null
wait "$HOST_PID" 2>/dev/null
rm -f "$SOCKET"
chmod 0644 "$HOST_CONFIG"
python3 "$HERE/launch-host.py" --stderr "$OUT/n3.host.stderr" \
  --facts "$OUT/n3.listener-facts.json" \
  >"$OUT/n3.stdout" 2>"$OUT/n3.launcher.stderr"
N3=$?
echo "$N3" >"$OUT/n3.exit"
if [ "$N3" != 0 ] && cmp -s "$OUT/n3.host.stderr" "$OUT/expected.startup_failed" \
   && [ ! -s "$OUT/n3.launcher.stderr" ]; then
  record negative-N3-bad-config-startup-failed ok \
    "exit=$N3 host stderr byte-exactly 'startup_failed'; launcher itself clean"
else
  record negative-N3-bad-config-startup-failed FAIL \
    "exit=$N3 host=$(cat "$OUT/n3.host.stderr") launcher=$(cat "$OUT/n3.launcher.stderr")"
fi

echo "===== 17. N3b: restore mode 0640 and prove the host starts again ====="
chmod 0640 "$HOST_CONFIG"
rm -f "$SOCKET"
nohup python3 "$HERE/launch-host.py" --stderr "$OUT/n3b.host.stderr" \
  --facts "$OUT/n3b.listener-facts.json" \
  >"$OUT/n3b.stdout" 2>"$OUT/n3b.launcher.stderr" &
HOST2_PID=$!
sleep 2
if kill -0 "$HOST2_PID" 2>/dev/null && [ ! -s "$OUT/n3b.host.stderr" ]; then
  echo "alive-and-silent" >"$OUT/n3b.result"
  record negative-N3b-restore-restores-startup ok \
    "only the config mode changed, so N3 cannot be attributed elsewhere"
else
  echo "failed" >"$OUT/n3b.result"
  record negative-N3b-restore-restores-startup FAIL \
    "stderr=$(cat "$OUT/n3b.host.stderr")"
fi

echo "===== 18. tape step: RUN IT, RECORD IT, DO NOT GATE ON IT ====="
"$NATIVE_BIN" ledger export-signed-tape --run-id "$RUN_ID" \
  --workspace /var/lib/buildplane/authority --out "$OUT/tape" \
  >"$OUT/tape-export.stdout" 2>"$OUT/tape-export.stderr"
TAPE_EXPORT=$?
echo "$TAPE_EXPORT" >"$OUT/tape-export.exit"
if [ -f "$OUT/tape/tape.json" ] && command -v node >/dev/null 2>&1; then
  node /repo/scripts/verify-signed-tape.mjs --fixture "$OUT/tape" --json \
    >"$OUT/tape-verify.json" 2>&1
  echo "$?" >"$OUT/tape-verify.exit"
else
  echo "not-run" >"$OUT/tape-verify.exit"
fi
echo "tape-export-exit=$TAPE_EXPORT tape-verify=$(cat "$OUT/tape-verify.exit")"
echo "tape verification is N/A for this proof: the reconciliation path appends"
echo "zero tape events, so there is nothing to verify. Recorded, never gated."

echo "===== 19. summary ====="
python3 "$HERE/summarize.py"
SUMMARY_EXIT=$?
cat "$OUT/summary.json"
kill "$HOST2_PID" 2>/dev/null
exit "$SUMMARY_EXIT"
