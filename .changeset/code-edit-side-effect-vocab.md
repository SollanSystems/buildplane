---
"@buildplane/planforge": patch
---

add a `code-edit` side-effect kind mapping to `src/**`, `test/**`, `packages/**/src/**`, and `packages/**/test/**`, so an admitted plan can authorize source edits through the capability bundle. Extends `PLANFORGE_ALLOWED_SIDE_EFFECTS` and `SIDE_EFFECT_FS_WRITE_GLOBS`; no change to the toy dry-run plan or its golden fixture.
