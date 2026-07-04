# M6 killer-demo — operator runbook (v0.5)

> The ten-step Buildplane demo, plus the three properties it proves. Companion to
> `scripts/run-demo.mjs`. Preview the whole flow with
> `node scripts/run-demo.mjs --dry-run` (prints every step, spawns nothing).

**Live-run gate (LOCKED):** the first live autonomous worker execution happens
with the operator watching. The runner script **stages** every step — it never
autonomously triggers the live worker. You type the commands and watch.

---

## 0. Setup

```
pnpm install
pnpm build            # builds apps/web — required for the source/dev-only `bp web`
pnpm native:build     # builds buildplane-native (the signed ledger)
```

- The web Mission Control surface is **source/dev-only** for v0.5: `bp web` serves
  `apps/web/dist`, so `pnpm build` must run first. There is no published web install.
- Stage a throwaway copy of the toy repo with `node scripts/run-demo.mjs` (copies
  `fixtures/demo-repo/` to a temp dir and `git init`s it so `trustedBase` resolves).
  Run the step commands from that staged directory.

---

## The ten steps

### Step 1 — compile + preview a raw goal

```
bp goal "Add rate limiting to POST /api/login: max 5 requests per minute per IP, return 429 with a Retry-After header."
```

`bp goal` auto-detects `trustedBase` via `git rev-parse HEAD`, synthesizes the
PlanForge markdown, runs compile → validate → preview, and prints the plan JSON.

### Step 2 — read the compile/preview surface

Inspect the JSON: `planDigest`, `trustedBase`, `missingEvidence`, `riskClass`.

**`INSUFFICIENT_EVIDENCE` here is EXPECTED — narrate it as expected.** A bare goal
string has an empty `## Tasks` section, so validation returns
`INSUFFICIENT_EVIDENCE` with `missingEvidence: ["tasks"]`. `bp goal` is a
compile-and-preview surface, **not** an admit path; the plan is intentionally not
admissible yet. This is the correct verdict, not a failure — say so out loud so a
viewer does not read it as a bug.

### Step 3 — switch to `goal.md` and dry-run the full plan

```
bp planforge dry-run --input goal.md --json
```

**Two-input handoff (narrate the discontinuity).** Step 1 used the raw string
`bp goal "<text>"`. To admit, you now switch to the seed
`fixtures/demo-repo/goal.md`, which carries a populated `## Tasks` section. This
input change (`"<text>"` → `goal.md`) is deliberate. Open `goal.md`, review the
seed tasks + safety constraints, then dry-run it: the plan now validates **PASS**
with `planDigest`, `trustedBase`, tasks, `riskClass`, and no missing evidence.

### Step 4 — admit the reviewed plan

```
bp planforge admit --input goal.md --approve --operator <operator-id>
```

Review the budget + risk class, then admit. `--approve` and `--operator <id>` are
both required — admission is an explicit, attributed decision. This records the
signed `plan_admitted` event on the L0 tape (kernel key).

### Step 5 — admission recorded + bundle finalized; open the web inspector

The signed `plan_admitted` lands and the capability bundle is finalized. Launch
Mission Control:

```
pnpm build   # if not already built
bp web        # → http://localhost:4173
```

Open the run inspector in the browser. (Source/dev-only; see Setup.)

### Step 6 — worker dispatched into an isolated worktree

The worker runs in a fresh git worktree with writable `src/` + `test/`, tools
`Read/Write/Edit/Bash`, and net-egress scoped to the NPM registry only.

### Step 7 — every tool call becomes a signed, policy-checked tape event

Each `Edit`/`Bash` tool call is appended to the tape as a signed event and checked
against the capability bundle. **Pause here** to demonstrate Property 1
(crash-resume) and Property 2 (policy denial) before letting the run finish.

### Step 8 — completion validated against the Acceptance Contract

The completion record is evaluated against the Acceptance Contract — diff-scope +
CI + lint. A passing record emits a signed `acceptance_recorded` event.

### Step 9 — kernel emits `result_ready`; operator sees it in the inbox

The kernel emits a signed `result_ready` L0 event. The approval inbox in `bp web`
surfaces it (the inbox feed stays derived; `result_ready` coexists with it).

### Step 10 — operator clicks Merge; final outcome on the tape

Click **Merge** in `bp web`. This records a signed `operator_decision_recorded`
plus a signed `run_completed` final-outcome event, and merges the branch.

---

## The three properties

### Property 1 — Replay / crash-resume (fail-closed)

Between steps 7 and 8, set the crash-injection env var and SIGKILL the kernel
right after an `activity_completed` lands:

```
BUILDPLANE_CRASH_AFTER_ACTIVITY=1 bp planforge loop --once   # kernel dies after the activity
bp planforge recover                                         # replay + resume
```

`BUILDPLANE_CRASH_AFTER_ACTIVITY=1` is a deterministic test-only hook (env var, not
a published CLI flag). After the kill, restart and run `bp planforge recover`: the
tape is replayed and the completed activity is **reused (never re-invoked)**. Recovery
is **fail-closed on trust**, not merely receipt-grade:

- **Recorded work that was verified** — a recorded activity carrying a matching signed
  `acceptance_recorded` verdict on the tape — is counted toward a `completed` receipt,
  and execution resumes at step 8. The recorded activity is reused, never re-run.
- **Recorded work that was never verified** — the crash landed *before* the acceptance
  gate ran, so no `acceptance_recorded` verdict exists — is **not** minted `completed`.
  `recover` fail-closes: the terminal receipt outcome is `failed`, the process exits 1,
  and each such task carries the machine-readable reason `acceptance-not-evaluated`. The
  suffix is not executed. (The `BUILDPLANE_CRASH_AFTER_ACTIVITY=1` kill point lands in
  exactly this window, so the injected-crash demo shows the honest fail-closed path.)

Enforcement is ON by default; `bp planforge recover --no-enforce-acceptance` (and
`bp planforge resume --no-enforce-acceptance`) opts out for a dispatch that itself ran
without acceptance. The decision comes only from the flag — never the unsigned dispatch
manifest. Either way the tape ends with **exactly one `plan_receipt`** (no
re-execution), and the orphaned `running` storage row is **reconciled** to a terminal
status matching that receipt, so a second `recover` reports `no_orphans`.

### Property 2 — Policy enforcement

Dispatch the out-of-scope command packet, which attempts a write to
`docs/out-of-scope.txt` — outside the `src/**`, `test/**` `fsWrite` scope:

```
# fixtures/demo-repo/out-of-scope-packet.json
```

The capability broker denies the write and appends a signed `capability_denied`
quarantine event to the tape. This is the real, enforced M3 boundary (a command
packet through the kernel ToolRegistry), not a best-effort narration.

### Property 3 — Signed receipts

Export the toy-repo tape after the run and verify it:

```
node scripts/verify-signed-tape.mjs --fixture <dir>
```

Exit 0 iff every event's Ed25519 signature verifies and every tape-root checkpoint
recomputes. Honesty note: the §7 sketch said "50-line script"; the real verifier is
~200 lines, and it proves **consistency** against tape-embedded trusted keys, not
third-party authenticity.

---

## Quick reference

| Step | Command |
|---|---|
| 1 | `bp goal "<text>"` → **INSUFFICIENT_EVIDENCE expected** |
| 3 | `bp planforge dry-run --input goal.md --json` → PASS |
| 4 | `bp planforge admit --input goal.md --approve --operator <id>` |
| 5 | `pnpm build && bp web` → http://localhost:4173 |
| P1 | `bp planforge recover` after `BUILDPLANE_CRASH_AFTER_ACTIVITY=1` kill → fail-closed `failed` receipt (crash before acceptance), exactly one `plan_receipt` |
| P2 | out-of-scope command packet → `capability_denied` |
| P3 | `node scripts/verify-signed-tape.mjs --fixture <dir>` → exit 0 |
