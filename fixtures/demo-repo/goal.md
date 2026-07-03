# Add rate limiting to the login endpoint

## Goal

Add rate limiting to `POST /api/login`: max 5 requests per minute per IP, return HTTP 429 with a `Retry-After` header when the limit is exceeded.

## Repository context

- Remote: local-staged-demo (throwaway copy; no remote)
- Trusted base: <stamped-at-staging>
- Worktree policy: isolated-worktree-required

A minimal Express app. `src/server.js` exports an `app` instance with a single `POST /api/login` route that performs a dummy credential check and currently has no rate limiting. `test/login.test.js` uses supertest to fire six login attempts from one IP and expects the sixth to be rejected with `429` + `Retry-After`; it is RED until the protection is added. `express-rate-limit` is already declared as a devDependency. The `Trusted base` line above is stamped with the staged seed commit by `scripts/run-demo.mjs`.

## Safety constraints

- Dry-run only.
- Buildplane kernel validates and admits plans.
- Coding agents are untrusted workers.
- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.
- Only edit `src/server.js`; do not modify `test/login.test.js`, `package.json`, or any other file's behavior contract.
- Do not change the existing credential-check semantics (200 on valid, 401 on invalid) for requests under the limit.
- Use the already-declared `express-rate-limit` dependency; do not add new dependencies.
- Do not introduce real authentication or persistence — this is a demo target.

## Tasks

### T1: Add per-IP rate limiting to POST /api/login

- Objective: Add express-rate-limit middleware to the POST /api/login route in src/server.js with a 5-requests-per-minute per-IP window that returns HTTP 429 with a Retry-After header when the limit is exceeded, using the already-declared express-rate-limit devDependency.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree
- Allowed-side-effects: code-edit
- Forbidden-side-effects: execute-code, board-write, network-write, push, deploy, merge
- Acceptance-criteria:
  - The sixth login request within one minute from a single IP returns HTTP 429 with a Retry-After header.
  - Requests under the limit keep the existing credential-check semantics (200 on valid, 401 on invalid).
  - Only src/server.js changes; test/login.test.js and package.json are untouched.
- Verification-commands:
  - npm test
