---
"@buildplane/mission-control-server": patch
---

harden the mission-control READ API against DNS-rebinding and error leakage. Every request now passes a `Host`/`Origin` allowlist (loopback names plus the configured bind host) before any route runs, so a browser page on a rebound attacker domain is rejected with 403 instead of exfiltrating run data; the guard is disabled only for an explicit external bind, where legitimate hostnames cannot be enumerated. Unhandled request failures now return a generic `{ error: "internal_error" }` body with the detailed error logged server-side, rather than leaking `error.message` to the client.
