---
"@buildplane/planforge": minor
"buildplane": minor
---

M2-S3: PlanForge admit stage — operator-approved signed `plan_admitted`.

`buildplane planforge admit --input <file> --approve --operator <id>` records an
operator-approved admission as a kernel-signed `plan_admitted` event on the L0
tape (the first signed TS-spawned tape path). It fails closed with no tape write
on a non-PASS plan, a missing `--approve`, or a missing `--operator`, and is
idempotent by the plan's idempotency key. `@buildplane/planforge` adds the pure
`buildPlanAdmittedPayload` builder.
