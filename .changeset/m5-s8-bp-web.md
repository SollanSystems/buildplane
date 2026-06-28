---
"buildplane": minor
---

add the `bp web` subcommand — serve the Mission Control web UI. It lazy-imports `@buildplane/mission-control-server`, constructs the ledger-backed `OperatorDecisionPort` + the orchestrator/store deps, and static-serves `apps/web/dist` (loopback by default; `--allow-external`/`BUILDPLANE_WEB_ALLOW_EXTERNAL=1` to widen, `--port N` to choose the port, default 4173). `--check` runs a no-listen self-test that proves the dependency graph wires up (synthetic `GET /api/status`) without binding a socket; SIGINT/SIGTERM trigger a graceful close. The root `build` script now also builds `apps/web` (vite), and `apps/web` is typechecked as its own `tsc --noEmit` step (kept out of the root project-reference graph).
