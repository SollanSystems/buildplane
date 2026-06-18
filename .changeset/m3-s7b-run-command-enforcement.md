---
"buildplane": minor
---

adapters-tools: enforce the capability bundle's `run_command.allowlist` before spawning (M3-S7b). A command whose argv0 is not allowlisted is denied fail-closed and never executed, and (when a tape context is present) emits a signed `capability_denied` event — mirroring the `write_file` gate (M3-S4/S6) and closing the gap where the allowlist was defined and broker-evaluable but never enforced on the tool surface.
