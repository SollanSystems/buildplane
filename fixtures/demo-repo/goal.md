# Add rate limiting to the login endpoint

## Goal

Add rate limiting to `POST /api/login`: max 5 requests per minute per IP, return HTTP 429 with a `Retry-After` header when the limit is exceeded.

## Repository context

A minimal Express app. `src/server.js` exports an `app` instance with a single `POST /api/login` route that performs a dummy credential check and currently has no rate limiting. `test/login.test.js` uses supertest to fire six login attempts from one IP and expects the sixth to be rejected with `429` + `Retry-After`; it is RED until the protection is added. `express-rate-limit` is already declared as a devDependency.

## Safety constraints

- Only edit `src/server.js`; do not modify `test/login.test.js`, `package.json`, or any other file's behavior contract.
- Do not change the existing credential-check semantics (200 on valid, 401 on invalid) for requests under the limit.
- Use the already-declared `express-rate-limit` dependency; do not add new dependencies.
- Do not introduce real authentication or persistence — this is a demo target.

## Tasks

- Add `express-rate-limit` middleware to the `POST /api/login` route.
- Configure the limiter to a 5 requests / 1 minute per-IP window.
- Ensure the limiter returns HTTP `429` with a `Retry-After` header when the window is exceeded.
- Run `npm test` and confirm `test/login.test.js` passes (the 6th request returns `429`).
