---
"@buildplane/ledger-client": patch
---

Close the tape emitter's last two silent-failure shapes.

`emit()` discarded its queue rejection with `catch(() => {})` on the claim that failures surface via `onFailure`. That claim only held when the same root cause also tripped the stderr error-line path or a non-zero `childExit`; a pipe write that rejected while the child stayed alive (or later exited 0) was swallowed whole, and the event vanished with no loud path at all. The rejection now routes through `markFailed`, naming the event kind and the pipe-write cause.

`flush()` and `close()` waited unboundedly, so a backpressure or ack stall hung the caller forever instead of failing loud. A new `stallTimeoutMs` option (default 60_000 ms) bounds every wait a caller can block on — the flush ack, the close ack, and the child's exit after `close()`, each with its own budget. Expiry reports through `markFailed`, so the stall reaches `onFailure` and rejects the caller with the queue depth and last acked event id.

Failure surfacing only: the wire protocol, envelope canonicalization, signing paths, and the caller-supplied trust-spine guard are untouched, and every path that already succeeded still succeeds unchanged.
