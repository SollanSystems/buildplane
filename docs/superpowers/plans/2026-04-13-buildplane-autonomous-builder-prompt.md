# Buildplane Autonomous Builder Controller Prompt

Use this prompt for a future autonomous Buildplane implementation run.

---

You are continuing Buildplane from the current green `main` branch.

Repository and environment:
- Canonical clean worktree: `/mnt/c/Dev/projects/buildplane-memory-mainline-clean`
- Active branch there should be `main`
- Repo root: `/mnt/c/Dev/projects/buildplane-memory-mainline-clean`
- Use `npx pnpm ...`, not raw `pnpm`
- On `/mnt/c`, `core.filemode=false` is already the correct setting
- If CI behavior disagrees with `/mnt/c`, reproduce in a fresh ext4 worktree under `/tmp`
- Do not modify backup/archive branches or the preserved dirty backup worktree unless explicitly told

Your mission:
- Read `docs/superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md`
- Identify the next smallest unfinished high-leverage slice from the roadmap
- Prefer the default next slice unless the repo already clearly contains it
- Deliver one focused PR-sized slice, not a giant omnibus change

Execution rules:
1. Start from `main`
2. Create a fresh feature branch for this slice
3. If the slice lacks a focused design spec or implementation plan, write/update them first under:
   - `docs/superpowers/specs/`
   - `docs/superpowers/plans/`
4. Follow TDD where practical
5. Use fresh subagents per implementation task when possible
6. After implementation, run focused tests plus:
   - `npx pnpm typecheck`
   - `npx pnpm build`
7. If CI-sensitive, validate in an ext4 worktree under `/tmp`
8. Commit with a conventional commit message
9. Push the branch and open a draft PR against `main`
10. Report:
   - what slice was chosen
   - what files changed
   - what tests passed
   - PR URL

Do not:
- force-push `main`
- touch backup/archive branches as working branches
- run `scripts/published-bootstrap/verify-positive.mjs` in the canonical mainline worktree
- bundle multiple roadmap phases into one PR
- switch the product direction away from Buildplane as the umbrella system for Claude Code CLI and Codex CLI
- prioritize semantic retrieval above exact workspace/user facts

Selection heuristic for the next slice:
- First: structured memory retrieval and injection
- Second: convergence of flywheel learnings with structured memory
- Third: operator trust surface
- Fourth: workflow import / published bootstrap hardening
- Fifth: eval and benchmark proof
- Sixth: pack/host/provider hardening and selective native migration

Stop conditions:
- If you hit three failed implementation/debug attempts, stop and write an architecture note instead of thrashing
- If the next slice is still too large, split it and take the smallest useful sub-slice
- If you discover the roadmap doc is stale, patch it before continuing

Expected output format:
- Chosen slice
- Why this slice now
- Branch name
- Tests run and results
- PR URL
- Follow-up slice recommendation
