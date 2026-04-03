# Little Hire Friction Map: Buildplane

## What is the Little Hire?

Every time a developer needs AI help with code, they make a micro-decision: "Do I use Buildplane, or do I just open Claude/Codex/Cursor directly?" The Little Hire is this repeated, moment-to-moment choice. Winning it once (installation) doesn't matter if you lose it every day after.

**North-star metric:** `% of runs that complete without human intervention`

---

## Friction Inventory

### F1. Two-step installation (Python brain + TS kernel)
- **Current state:** Requires separate setup for SuperClaude (Python) and Buildplane (TypeScript)
- **Friction level:** HIGH -- blocks initial adoption entirely
- **Little Hire impact:** Users who don't get past setup never experience the Little Hire
- **Fix:** Unified install script: `curl -fsSL https://buildplane.dev/install | bash` handles both
- **Success signal:** `npm install -g buildplane` works in < 60 seconds on first run

### F2. No zero-config default
- **Current state:** Requires configuration of providers, models, memory paths before first use
- **Friction level:** MEDIUM -- adds 5-10 minutes of setup before value
- **Little Hire impact:** "I'll finish this task manually and configure later" (later never comes)
- **Fix:** `buildplane init` auto-detects current provider from existing tools (`claude auth status`, `codex configure`)
- **Success signal:** First run works within 2 commands of install

### F3. Memory not automatically shared between packs
- **Current state:** SuperClaude memory and Buildplane memory are separate; manual promotion needed
- **Friction level:** HIGH -- defeats the primary value proposition
- **Little Hire impact:** "Why do I need to re-explain my architecture?"
- **Fix:** Shared SQLite database at `~/.buildplane/memory.db` with automatic cross-pack visibility for provider-agnostic facts
- **Success signal:** Claude learns a fact, Codex benefits without config

### F4. Git worktree setup overhead
- **Current state:** Requires manual worktree creation or explicit flags for parallel runs
- **Friction level:** MEDIUM -- adds cognitive load for parallel work
- **Little Hire impact:** Users avoid parallel runs, use single agent sequentially
- **Fix:** `buildplane run --parallel 3` auto-creates isolated worktrees, merges on success
- **Success signal:** Parallel run is one flag, not a workflow

### F5. No eval harness / no quality proof
- **Current state:** Cannot benchmark Buildplane runs against raw agent performance
- **Friction level:** MEDIUM -- undermines confidence in the tool
- **Little Hire impact:** "Is this actually better than just using Claude directly?"
- **Fix:** `buildplane eval` runs standardized tasks through both raw agent and Buildplane pipeline, compares pass rates, time, and code quality
- **Success signal:** Quantified improvement shown after installation

### F6. Error messages are framework-level, not user-level
- **Current state:** Errors surface internal TS/Python stack traces and bus errors
- **Friction level:** MEDIUM -- forces debugging the framework instead of the code
- **Little Hire impact:** "I spent 30 minutes debugging Buildplane instead of getting work done"
- **Fix:** User-friendly errors: "Claude Code exited with code 1. The task packet may be malformed. Run `buildplane validate <packet>` to check."
- **Success signal:** Users resolve errors without reading source code

### F7. No import for existing workflows
- **Current state:** Users must rebuild prompt libraries, memory, and conventions from scratch
- **Friction level:** MEDIUM -- high Habit friction
- **Little Hire impact:** "I'll stick with my tmux setup, I've already invested in it"
- **Fix:** `buildplane import` scans Claude Code's `CLAUDE.md`, prompt files, and tmux configs to auto-generate packs
- **Success signal:** Existing users can migrate in < 5 minutes

### F8. No clear "run succeeded" signal
- **Current state:** Completion requires reading logs or diffs to verify results
- **Friction level:** Low -- annoying but not blocking
- **Little Hire impact:** Adds review time to every run
- **Fix:** `buildplane status` shows a one-line summary: "Run #47 passed. 3 files changed, all tests green. Diff: ..."
- **Success signal:** One command gives full run status

---

## Priority Matrix

| Friction | Impact | Effort | Priority |
|----------|--------|--------|----------|
| F1: Two-step install | Critical | Medium | **P0** |
| F3: Memory not shared | Critical | Medium | **P0** |
| F2: No zero-config default | High | Low | **P1** |
| F6: Cryptic errors | High | Low | **P1** |
| F7: No workflow import | High | Medium | **P1** |
| F4: Worktree overhead | Medium | Medium | **P2** |
| F5: No eval harness | Medium | High | **P2** |
| F8: No run status signal | Low | Low | **P3** |

## Implementation Order

1. **P0: F1 + F3** -- Fix installation and memory sharing to enable the core Little Hire
2. **P1: F2 + F6 + F7** -- Reduce friction for users who got past install
3. **P2: F4 + F5** -- Enable advanced use cases (parallel, benchmarking)
4. **P3: F8** -- Polish and developer experience improvements

## Measuring Little Hire Success

```
Little Hire Rate = (runs completed without intervention) / (total runs initiated)

Target by milestone:
  M1 (after F1+F3): 50% (half of runs need no intervention)
  M2 (after F2+F6+F7): 70%
  M3 (after F4+F5): 85%
  M4 (polish): 95%
```
