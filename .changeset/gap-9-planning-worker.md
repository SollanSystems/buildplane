---
"@buildplane/planforge": minor
"@buildplane/cli": minor
---

Add the PlanForge planning worker: a roadmap-driven next-slice plan.md generator gated by `planforge validate`.

- New `buildplane planforge plan` command reads a dedicated machine-readable roadmap (`docs/roadmap.json`, schema id `buildplane.roadmap.v0`) plus the L0 tape's completed slices, deterministically emits the next eligible slice's `plan.md` in the canonical `## Tasks` grammar, and exits 0 only when the emitted plan validates PASS.
- New `@buildplane/planforge` exports: `loadRoadmapFromString`, `selectNextRoadmapSlice`, `buildPlannerPlanMarkdown`, `PLANFORGE_ROADMAP_SCHEMA_VERSION`, and the `RoadmapDoc` / `RoadmapSlice` / `RoadmapSliceStatus` types.
- Narrows the `forbiddenGoalIntent` guard so benign self-build goals that mention running their verification commands are no longer falsely rejected `UNSAFE_TO_RUN`; the truly-unsafe boundary-crossing phrasings (push/deploy/merge/PR/network/board/worker-spawn) stay rejected.
- Extends the public `PLANFORGE_REQUIRED_EVIDENCE` tuple with `tasks` (a plan with no parsed tasks now reports `tasks` as missing evidence directly rather than via a runtime cast). The `done`-status roadmap slice is treated as a satisfied dependency so a hand-built prerequisite unblocks the next slice.
