# PlanForge coding plan — M5-S1 scaffold

## Goal

Scaffold the M5 Web Mission Control Next.js application with the initial directory structure, package.json, tsconfig, and a health-check route that returns 200 OK.

## Repository context

- Remote: https://github.com/SollanSystems/buildplane.git
- Trusted base: 252f7c5a0000000000000000000000000000000a
- Worktree policy: isolated-worktree-required

## Safety constraints

- Dry-run only.
- Buildplane kernel validates and admits plans.
- Coding agents are untrusted workers.
- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.
- Idempotent repeated planning for the same normalized input, trusted base, and evidence set.

## Tasks

### M5-S1-T1: Create app scaffold

- Objective: Create apps/web directory with package.json, tsconfig.json, and next.config.ts.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on:
- Acceptance-criteria:
  - apps/web/package.json exists with name @buildplane/web.
  - apps/web/tsconfig.json extends tsconfig.base.json.
- Verification-commands:
  - pnpm typecheck
  - pnpm vitest --run apps/web/test

### M5-S1-T2: Add health-check route

- Objective: Add apps/web/src/app/api/health/route.ts returning 200 OK with a JSON body.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: local-doc, local-fixture, local-receipt
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Depends-on: M5-S1-T1
- Acceptance-criteria:
  - GET /api/health returns 200 with { ok: true }.
  - Route is covered by a vitest unit test.
- Verification-commands:
  - pnpm typecheck
  - pnpm vitest --run apps/web/test/health.test.ts
