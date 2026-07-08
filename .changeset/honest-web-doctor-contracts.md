---
"buildplane": patch
---

fail closed with source-checkout guidance when `bp web` runs from a published install (the optional `@buildplane/mission-control-server` package is not bundled), surface a `bootstrap doctor` note that the published native binary is packaged for linux-x64 only, and report entrypoint promise rejections as a clean exit 1 instead of an unhandled rejection
