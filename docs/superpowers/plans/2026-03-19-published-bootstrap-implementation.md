# Published Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm install -g buildplane` produce a working operator CLI outside the monorepo, while keeping `pnpm buildplane ...` and `node apps/cli/dist/index.js ...` working and adding a canonical positive verification command.

**Architecture:** Keep the product contract narrow and honest. `apps/cli` becomes a two-stage entrypoint: a tiny published bootstrap wrapper at `dist/index.js` checks Node `24.13.1`, then loads the real compiled CLI runtime from `dist/cli.js`. Root-level Node scripts assemble a staged publish package from compiled outputs, derive a publish-facing README from the repo-root README, copy the private internal runtime closure into a vendored tree inside the staged artifact, and rewrite only internal `@buildplane/*` specifiers in staged copied files through one explicit package-to-file mapping table. A canonical positive verifier then runs repo-dev, built, and packed tarball smoke flows with explicit cleanup between phases. CI runs that same positive verifier and adds one separate wrong-Node companion job.

**Tech Stack:** TypeScript, Node.js 24.13.1, pnpm workspaces, npm pack, Vitest, GitHub Actions

---

## Planned file structure

### CLI bootstrap boundary and runtime contract

- Create: `apps/cli/src/cli-main.ts` — published/runtime entrypoint loaded only after the Node-version guard passes
- Create: `apps/cli/src/version-guard.ts` — single source of truth for the `24.13.1` contract and error formatting
- Modify: `apps/cli/src/index.ts` — tiny shebang bootstrap wrapper that checks Node and then imports `./cli-main.js`
- Modify: `apps/cli/test/smoke.test.ts` — keep banner/direct-run coverage against the wrapper entrypoint
- Modify: `apps/cli/test/run-cli.test.ts` — lock the machine-readable `run-id: <id>` token the verifier will parse
- Create: `apps/cli/test/version-guard.test.ts` — focused unit coverage for the version guard and its error text

### Published package assembly and artifact inspection

- Create: `scripts/published-bootstrap/manifest.mjs` — derive the publish manifest from `apps/cli/package.json`
- Create: `scripts/published-bootstrap/readme.mjs` — derive the publish-facing staged README from the repo-root README
- Create: `scripts/published-bootstrap/stage-package.mjs` — build a temp staged publish directory from compiled artifacts and emit its path/metadata
- Create: `scripts/published-bootstrap/inspect-package.mjs` — inspect the staged tree or tarball for manifest and artifact-shape contract failures
- Modify: `apps/cli/package.json` — keep repo-private metadata, add any missing fields the staged manifest must derive from source of truth
- Modify: `package.json` — add `stage:published-bootstrap` and `verify:published-bootstrap` scripts without weakening the existing root workflow
- Create: `test/workflow/published-bootstrap-contract.test.ts` — assert the root scripts and staged manifest derivation contract

### Published bootstrap verification, docs, and CI

- Create: `scripts/published-bootstrap/verify-positive.mjs` — canonical positive-path verifier for repo-dev, built, and packed global-install smoke flows
- Create: `scripts/published-bootstrap/verify-wrong-node.mjs` — CI-only companion verifier for the wrong-Node guard path
- Create: `test/fixtures/published-bootstrap/packet.json` — committed smoke packet fixture for repo-dev and built-path regression checks
- Modify: `README.md` — replace the future-only distribution note with real published-install guidance while preserving repo-dev and built-path sections
- Modify: `test/workflow/readme-contract.test.ts` — assert the root README documents all three paths and no longer treats published install as unavailable
- Modify: `.github/workflows/ci.yml` — call `pnpm verify:published-bootstrap` and add a separate wrong-Node companion job or step

### Design decisions locked for implementation

- `apps/cli/src/index.ts` stays the public binary target and becomes the tiny version-checking bootstrap wrapper
- The real CLI runtime moves behind `apps/cli/src/cli-main.ts`
- The staged publish artifact is assembled by repo-owned scripts from compiled output; the raw `apps/cli/` source tree is never packed directly
- Internal `@buildplane/*` runtime code is vendored privately into the staged artifact under `vendor/@buildplane/*`
- The staging script maintains one explicit mapping table from each internal package name to its staged runtime entrypoint and rewrites only those internal specifiers in staged copied files
- The staged README is derived from the repo-root README and must omit repo-dev-only `pnpm` instructions from the shipped package artifact
- The positive verification entrypoint is `pnpm verify:published-bootstrap`
- The wrong-Node proof is CI-only and must execute the packed CLI under a separately provisioned non-`24.13.1` runtime
- The verifier parses the frozen stdout token `^run-id: (.+)$` across repo-dev, built, and published smoke flows

---

## Chunk 1: Split the published binary into a real bootstrap wrapper

**Chunk acceptance criteria:** The public binary target stays `dist/index.js`, that file is reduced to a small version-checking wrapper, the main CLI runtime moves behind `dist/cli.js`, and repo tests lock the wrong-Node error text plus the stable `run-id` output token.

### Task 1: Add the version guard and move the CLI runtime behind it

**Files:**
- Create: `apps/cli/src/version-guard.ts`
- Create: `apps/cli/src/cli-main.ts`
- Modify: `apps/cli/src/index.ts`
- Create: `apps/cli/test/version-guard.test.ts`
- Modify: `apps/cli/test/smoke.test.ts`
- Modify: `apps/cli/test/run-cli.test.ts`

- [ ] **Step 1: Write the failing version-guard test**

Create `apps/cli/test/version-guard.test.ts` with focused cases for the contract surface:

```ts
import { assertSupportedNodeVersion } from "../src/version-guard";
import { describe, expect, it } from "vitest";

describe("published CLI node guard", () => {
  it("allows Node 24.13.1", () => {
    expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
  });

  it("rejects other versions with a clear error", () => {
    expect(() => assertSupportedNodeVersion("24.13.0")).toThrow(
      /Node 24\.13\.1.*24\.13\.0/i,
    );
  });
});
```

- [ ] **Step 2: Write the failing run-id token regression**

Extend one passing-path assertion in `apps/cli/test/run-cli.test.ts` so the verifier’s parse contract is explicit, not incidental:

```ts
expect(result.stdout[0]).toBe("run-id: run-123");
```

Use the existing deterministic fake-orchestrator path instead of adding a new integration test.

- [ ] **Step 3: Run the focused CLI tests to verify they fail**

Run: `pnpm vitest --run apps/cli/test/version-guard.test.ts apps/cli/test/run-cli.test.ts apps/cli/test/smoke.test.ts`
Expected: FAIL because `version-guard.ts` and `cli-main.ts` do not exist yet.

- [ ] **Step 4: Implement the minimal version guard**

Create `apps/cli/src/version-guard.ts` with one exported constant and one exported assertion:

```ts
export const SUPPORTED_NODE_VERSION = "24.13.1";

export function assertSupportedNodeVersion(current = process.versions.node): void {
  if (current !== SUPPORTED_NODE_VERSION) {
    throw new Error(
      `Buildplane requires Node ${SUPPORTED_NODE_VERSION}. Detected ${current}.`,
    );
  }
}
```

Keep this file dependency-free so the published wrapper can load it first.

- [ ] **Step 5: Move the CLI runtime behind a separate module**

Create `apps/cli/src/cli-main.ts` that owns:

- `getBootstrapBanner()`
- `runCli` re-export
- the current direct-run behavior that executes `runCli(process.argv.slice(2))`

Keep `cli-main.ts` semantically identical to the current `index.ts` aside from its filename and imports.

- [ ] **Step 6: Turn `apps/cli/src/index.ts` into the tiny public wrapper**

Update `apps/cli/src/index.ts` to:

- start with `#!/usr/bin/env node`
- import only `assertSupportedNodeVersion`
- call the guard before any CLI runtime import
- dynamically import `./cli-main.js` only after the guard passes
- preserve the direct-run behavior for both source-run and built-run entrypoints

A minimal shape is enough:

```ts
#!/usr/bin/env node
import { assertSupportedNodeVersion } from "./version-guard.js";

assertSupportedNodeVersion();

const cli = await import("./cli-main.js");
export const getBootstrapBanner = cli.getBootstrapBanner;
export const runCli = cli.runCli;
```

Do not pull `run-cli.ts` into the wrapper directly.

- [ ] **Step 7: Re-run the focused CLI tests**

Run: `pnpm vitest --run apps/cli/test/version-guard.test.ts apps/cli/test/run-cli.test.ts apps/cli/test/smoke.test.ts`
Expected: PASS.

- [ ] **Step 8: Build and smoke the built wrapper directly**

Run: `pnpm build && node apps/cli/dist/index.js`
Expected: prints `Buildplane by SollanSystems` on Node `24.13.1`.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/src/cli-main.ts apps/cli/src/version-guard.ts apps/cli/test/version-guard.test.ts apps/cli/test/smoke.test.ts apps/cli/test/run-cli.test.ts
git commit -m "refactor: split published cli bootstrap wrapper"
```

---

## Chunk 2: Assemble a publishable staged package from compiled output

**Chunk acceptance criteria:** The repo can build a real staged publish directory from compiled artifacts, derive a public manifest named `buildplane`, vendor the internal runtime closure into that staged tree, and inspect the resulting artifact shape before any external smoke run.

### Task 2: Derive the staged manifest and root workflow contract first

**Files:**
- Create: `scripts/published-bootstrap/manifest.mjs`
- Modify: `apps/cli/package.json`
- Modify: `package.json`
- Create: `test/workflow/published-bootstrap-contract.test.ts`
- Modify: `test/workflow/root-tooling.test.ts`

- [ ] **Step 1: Write the failing published-bootstrap contract test**

Create `test/workflow/published-bootstrap-contract.test.ts` that reads the root and CLI manifests and asserts:

```ts
expect(rootPkg.scripts?.["stage:published-bootstrap"]).toBeDefined();
expect(rootPkg.scripts?.["verify:published-bootstrap"]).toBeDefined();
expect(cliPkg.name).toBe("buildplane");
expect(cliPkg.private).toBe(true);
expect(cliPkg.bin?.buildplane).toBe("./dist/index.js");
expect(cliPkg.engines?.node).toBe("24.13.1");
```

Then import a helper from `scripts/published-bootstrap/manifest.mjs` and assert the derived publish manifest has:

```ts
expect(publishManifest.name).toBe("buildplane");
expect(publishManifest.private).toBeUndefined();
expect(publishManifest.bin?.buildplane).toBe("./dist/index.js");
expect(publishManifest.engines?.node).toBe("24.13.1");
expect(publishManifest.dependencies ?? {}).not.toHaveProperty("@buildplane/kernel");
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts test/workflow/published-bootstrap-contract.test.ts`
Expected: FAIL because the new scripts, engine field, and manifest helper do not exist yet.

- [ ] **Step 3: Add the missing source-of-truth metadata and root scripts**

Update `apps/cli/package.json` to add the missing `engines.node = "24.13.1"` field while keeping the package repo-private.

Update root `package.json` to add:

```json
"stage:published-bootstrap": "node ./scripts/published-bootstrap/stage-package.mjs",
"verify:published-bootstrap": "node ./scripts/published-bootstrap/verify-positive.mjs"
```

Do not remove or rename the existing repo-dev `buildplane` script.

- [ ] **Step 4: Implement the derived-manifest helper**

Create `scripts/published-bootstrap/manifest.mjs` with one exported pure function that reads `apps/cli/package.json` and returns a publish-safe manifest.

Required behavior:

- keep `name`, `version`, `description`, `type`, `bin`, and `engines`
- omit `private`
- omit workspace-only scripts
- omit internal `@buildplane/*` runtime dependencies
- emit `files` covering only `dist`, `vendor`, and `README.md`
- emit no `preinstall`, `install`, or `postinstall` hooks

- [ ] **Step 5: Re-run the focused contract tests**

Run: `pnpm vitest --run test/workflow/root-tooling.test.ts test/workflow/published-bootstrap-contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/cli/package.json test/workflow/root-tooling.test.ts test/workflow/published-bootstrap-contract.test.ts scripts/published-bootstrap/manifest.mjs
git commit -m "build: define published bootstrap manifest contract"
```

### Task 3: Stage the publishable package and inspect the artifact shape

**Files:**
- Create: `scripts/published-bootstrap/readme.mjs`
- Create: `scripts/published-bootstrap/stage-package.mjs`
- Create: `scripts/published-bootstrap/inspect-package.mjs`
- Modify: `package.json` (only if a helper script alias is necessary)

- [ ] **Step 1: Run a minimal staging repro before implementation**

Run: `pnpm build && node ./scripts/published-bootstrap/stage-package.mjs`
Expected: FAIL because the staging script does not exist yet.

- [ ] **Step 2: Implement the staging script around compiled output only**

Create `scripts/published-bootstrap/stage-package.mjs` so it:

1. verifies `pnpm build` has already produced `apps/cli/dist` and the required internal package `dist/` outputs
2. creates a fresh temp staging root outside the repo
3. writes a staged package tree like:

```text
<temp>/buildplane/
  package.json
  README.md
  dist/
    index.js
    cli.js
    ...copied CLI runtime
  vendor/
    @buildplane/kernel/...
    @buildplane/runtime/...
    @buildplane/policy/...
    @buildplane/storage/...
    @buildplane/adapters-git/...
```

4. derives a publish-facing `README.md` from the repo-root README by keeping the published/global install instructions and high-level product context while omitting repo-dev-only `pnpm buildplane ...` guidance from the shipped artifact
5. copies the compiled CLI runtime into `dist/`
6. copies the compiled internal runtime closure into `vendor/`
7. defines one explicit package-entry mapping table, for example:

```js
{
  "@buildplane/kernel": "vendor/@buildplane/kernel/index.js",
  "@buildplane/runtime": "vendor/@buildplane/runtime/index.js",
  "@buildplane/policy": "vendor/@buildplane/policy/index.js",
  "@buildplane/storage": "vendor/@buildplane/storage/index.js",
  "@buildplane/adapters-git": "vendor/@buildplane/adapters-git/index.js"
}
```

8. rewrites only those internal package specifiers in staged copied files using that mapping table:
   - from staged CLI files under `dist/`, rewrite `@buildplane/<pkg>` to `../vendor/@buildplane/<pkg>/index.js`
   - from staged vendored files under `vendor/@buildplane/*`, compute the correct relative path from the current file to the mapped staged target
   - handle both static `from "@buildplane/..."` imports and dynamic `import("@buildplane/...")` forms
   - leave Node built-ins and any third-party imports untouched
9. writes the derived `package.json`
10. prints the staged package path as JSON so later verifier steps can consume it deterministically

Keep the rewrite surface minimal and explicit: only internal `@buildplane/*` runtime imports in staged copied files should be rewritten, and the mapping table should live in one place in `stage-package.mjs` or a helper it imports.

- [ ] **Step 3: Implement artifact inspection**

Create `scripts/published-bootstrap/inspect-package.mjs` that accepts a staged package path or tarball path and fails if any of the following are untrue:

- `package.json.name === "buildplane"`
- `private` is absent/false
- `bin.buildplane === "./dist/index.js"`
- `engines.node === "24.13.1"`
- no `workspace:`, `file:`, `link:`, or absolute-path dependency specifiers remain
- no internal `@buildplane/*` dependencies remain in the published manifest
- `dist/index.js` exists, has a shebang, and contains the wrapper import boundary
- `README.md` exists and does not contain repo-dev-only `pnpm buildplane` guidance
- `src/` and `test/` payloads are not required at runtime

Make the script emit concise failure messages with the exact offending field or file path.

- [ ] **Step 4: Stage and inspect the artifact for real**

Run:

```bash
pnpm build
node ./scripts/published-bootstrap/stage-package.mjs > /tmp/buildplane-stage.json
node ./scripts/published-bootstrap/inspect-package.mjs "$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('/tmp/buildplane-stage.json', 'utf8')).packageRoot)")"
```

Expected: both commands exit 0 and the inspection confirms the staged package shape.

- [ ] **Step 5: Commit**

```bash
git add scripts/published-bootstrap/readme.mjs scripts/published-bootstrap/stage-package.mjs scripts/published-bootstrap/inspect-package.mjs
git commit -m "build: assemble staged published package"
```

---

## Chunk 3: Prove the positive install path and wire CI around it

**Chunk acceptance criteria:** The repo has one canonical positive verifier, docs describe the real published install path, the verifier proves repo-dev, built, and isolated global-install smoke flows from a packed tarball, and CI runs both the positive verifier and the separate wrong-Node companion check.

### Task 4: Add the positive verifier, packet fixture, and README contract updates

**Files:**
- Create: `scripts/published-bootstrap/verify-positive.mjs`
- Create: `test/fixtures/published-bootstrap/packet.json`
- Modify: `README.md`
- Modify: `test/workflow/readme-contract.test.ts`

- [ ] **Step 1: Write the failing README contract update**

Update `test/workflow/readme-contract.test.ts` so it now asserts:

```ts
expect(readme).toContain("pnpm buildplane init");
expect(readme).toContain("node apps/cli/dist/index.js init");
expect(readme).toContain("npm install -g buildplane");
expect(readme).toContain("buildplane init");
expect(readme).not.toMatch(/not yet available|future-only/i);
```

Keep the clean-working-tree assertion.

- [ ] **Step 2: Create the committed smoke packet fixture**

Create `test/fixtures/published-bootstrap/packet.json` as a passing local command packet equivalent in shape to the existing dev-bootstrap fixture. Reuse the simple `node -e` output-writing behavior instead of inventing a new runtime path.

- [ ] **Step 3: Implement the positive verifier script**

Create `scripts/published-bootstrap/verify-positive.mjs` so it performs these phases in order with fresh temp locations or explicit cleanup between them:

1. repo-dev smoke:
   - `pnpm buildplane init`
   - `pnpm buildplane run --packet test/fixtures/published-bootstrap/packet.json`
   - parse `^run-id: (.+)$`
   - `pnpm buildplane status --json`
   - `pnpm buildplane inspect <run-id> --json`
   - assert this exact minimum JSON contract:
     - `status.initialized === true`
     - `status.latestRun.id === <captured-run-id>`
     - `status.latestRun.status === "passed"`
     - `inspect.kind === "run"`
     - `inspect.run.id === <captured-run-id>`
     - `inspect.run.status === "passed"`
     - `inspect.evidence` is an array
     - `inspect.decisions` is an array
   - cleanup repo-generated state before the next phase by removing `.buildplane/project.json`, `.buildplane/state.db`, `.buildplane/artifacts`, `.buildplane/evidence`, `.buildplane/runs`, `.buildplane/logs`, `.buildplane/workspaces`, and packet output directories such as `tmp/`
2. repo verification gate:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
3. built-path smoke:
   - `node apps/cli/dist/index.js init`
   - `node apps/cli/dist/index.js run --packet test/fixtures/published-bootstrap/packet.json`
   - same run-id parse
   - assert the same exact minimum JSON contract
   - cleanup repo-generated state before the next phase using the same `.buildplane/**` and packet-output removals
4. staged-package creation + inspection:
   - call `stage-package.mjs`
   - call `inspect-package.mjs`
   - `npm pack` from the exact staged package directory
5. external packed-install smoke:
   - create a fresh git repo outside the monorepo and make one commit so `HEAD` resolves
   - copy the smoke packet outside that repo
   - install the tarball into an isolated npm prefix
   - sanitize the environment so `buildplane` resolves from that prefix and repo-local helpers do not leak in
   - run `buildplane init`, `buildplane run --packet ...`, `buildplane status --json`, `buildplane inspect <run-id> --json`
   - assert the same exact minimum JSON contract
   - remove the temp repo, temp packet location, staged package directory, tarball extraction directory, and isolated npm prefix before exit
6. staged README check:
   - assert the staged `README.md` contains the published install contract strings required for operators and omits repo-dev-only `pnpm buildplane` guidance

Make the verifier fail fast with short, specific error messages, and print the exact command that failed.

- [ ] **Step 4: Rewrite the root README once the verifier exists**

Update `README.md` so it clearly documents all three paths:

1. repo development via `pnpm buildplane ...`
2. in-repo built CLI via `node apps/cli/dist/index.js ...`
3. published/global install via `npm install -g buildplane` then `buildplane ...`

Keep the clean-working-tree precondition attached to `run`, and remove the current future-only distribution warning.

- [ ] **Step 5: Run the positive verifier and focused docs tests**

Run:

```bash
pnpm vitest --run test/workflow/readme-contract.test.ts
pnpm verify:published-bootstrap
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add README.md test/workflow/readme-contract.test.ts test/fixtures/published-bootstrap/packet.json scripts/published-bootstrap/verify-positive.mjs
git commit -m "test: prove published bootstrap install path"
```

### Task 5: Add the CI-only wrong-Node companion verification

**Files:**
- Create: `scripts/published-bootstrap/verify-wrong-node.mjs`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Run the missing-script repro before implementation**

Run: `node ./scripts/published-bootstrap/verify-wrong-node.mjs`
Expected: FAIL because the script does not exist yet.

- [ ] **Step 2: Implement the CI-only wrong-Node verifier**

Create `scripts/published-bootstrap/verify-wrong-node.mjs` so it:

1. assumes the current Node runtime is intentionally unsupported for this check
2. runs `pnpm build`
3. stages and packs the publish artifact
4. installs the tarball into an isolated npm prefix
5. invokes that installed `buildplane` binary under the current wrong-Node runtime
6. asserts:
   - non-zero exit
   - error text includes required `24.13.1`
   - error text includes the detected version when available
   - failure happens before normal repo/packet execution begins

Make this script require an explicit guard like `BUILDPLANE_EXPECT_UNSUPPORTED_NODE=1` so accidental local runs on `24.13.1` fail immediately with a clear message instead of giving a false signal.

- [ ] **Step 3: Wire CI to run the positive verifier and a separate wrong-Node job**

Update `.github/workflows/ci.yml` so:

- the main verify job runs `pnpm verify:published-bootstrap` instead of duplicating the old dev-bootstrap smoke inline
- a second job provisions a non-`24.13.1` runtime (for example `24.13.0` via `actions/setup-node`) and runs:

```bash
BUILDPLANE_EXPECT_UNSUPPORTED_NODE=1 node ./scripts/published-bootstrap/verify-wrong-node.mjs
```

Keep the main job on `.node-version` and keep the wrong-Node proof separate from the local positive rerun command.

- [ ] **Step 4: Run final repo verification locally**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

Then run: `pnpm verify:published-bootstrap`
Expected: PASS.

Do not try to fake the wrong-Node path locally on `24.13.1`; that proof belongs to CI.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/published-bootstrap/verify-wrong-node.mjs
git commit -m "ci: verify published bootstrap packaging"
```

---

## Plan review notes

- Keep the published artifact assembly explicit and local to the staging scripts. Do not mutate the repo’s normal build output in place.
- If the staged import rewriting touches more than internal `@buildplane/*` runtime specifiers, stop and inspect the actual compiled graph before broadening it.
- If `npm pack` resists the staged shape, debug the tarball contents first; do not weaken the published contract to match an accidental pack result.
- If the positive verifier becomes unwieldy, extract small helper functions inside `scripts/published-bootstrap/verify-positive.mjs` rather than creating a framework.
- Leave `release.yml` alone in this slice unless a failing CI or packaging repro proves it must change.

Plan complete and saved to `docs/superpowers/plans/2026-03-19-published-bootstrap-implementation.md`. Ready to execute?