---
"@buildplane/planforge": major
---

Dynamic task generation from ## Tasks Markdown section.

Breaking changes:
- `PLANFORGE_TASK_IDS` constant removed.
- `PlanForgeTaskId` type removed.
- `PlanForgeTask.id` widened from `PlanForgeTaskId` to `string`.
- `PlanForgeTask.dependsOn` widened from `PlanForgeTaskId[]` to `string[]`.

New exports:
- `parseTasks(content: string): ParsedTask[]` — parses the `## Tasks` Markdown section.
- `ParsedTask` interface.
- `PlanForgeCompileResult.parsedTasks` field.

Validation changes:
- Plans without a `## Tasks` section now produce `INSUFFICIENT_EVIDENCE`.
- New checks `tasks-present` and `tasks-valid` added to `PlanForgeValidation`.
