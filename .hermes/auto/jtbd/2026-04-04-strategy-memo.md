# Buildplane JTBD Strategy Memo — April 2026 Update

> **Previous score: 6/10 → Updated score: 6.5/10**  
> **Author:** Hermes Agent, SollanSystems | **Audience:** Solo dev / Buildplane team

---

## One-Positioning Statement

**Buildplane is the control plane that turns AI coding agents from chatty assistants into accountable workers — dispatching them in isolation, verifying their output, and remembering what worked so your next run starts smarter, not from scratch.**

---

## North-Star Job (Refined)

> When I hand real software work to AI agents,  
> I want a system that dispatches them safely, verifies results against defined standards, and carries forward everything it learns —  
> So I can delegate with confidence instead of babysitting with anxiety.

*What changed:* The prior statement framed it as fixing prompt/fragmentation pain. This one frames it around **delegation with accountability** — the deeper job. Fragmentation is a symptom; the disease is the inability to trust autonomous agents with real work.

---

## Primary and Secondary Jobs

| Job | Priority | Owner |
|-----|----------|-------|
| **Primary:** Dispatch AI agents safely and verify their output against standards | Must-have today | Kernel, strategy executor, verification contracts |
| **Secondary A:** Build persistent memory so agents don't start cold on every run | Must-have in 3 months | Memory system (4 scopes, 8 kinds, promotion wiring) |
| **Secondary B:** Orchestrate multi-agent workflows in parallel (worktrees) | Must-have for power users | Graph scheduler, worktrees |
| **Tertiary:** Standardize team workflows through reusable packs | Important for scale | Pack system, workflow packs |

---

## Functional / Emotional / Social Dimensions

| Dimension | Status | Assessment |
|-----------|--------|------------|
| **Functional:** Isolate agents, verify contracts, dispatch tasks, persist memory | **Stages 1-3 working; stages 4-7 schema-ready, unwired.** Kernel, policy, event bus, evidence store are solid. Memory routing is the critical gap. |
| **Emotional:** Feel in control when delegating; trust the system to catch mistakes before they matter | **Policy layer is the thesis but thinnest layer.** Verification contracts exist but need enforcement teeth. Operators need to *see* proof, not hope. |
| **Social:** Be known as a serious builder who ships quality autonomously, not as someone who blindly trusts AI output | **Strong differentiator if positioned around evidence.** Audit trail (receipts + artifacts) is unique vs raw agents and IDEs. No one else sells "provable delegation." |

---

## Forces of Progress

| Force | Current State | Verdict |
|-------|--------------|---------|
| **Push** (frustration with current state) | Medium | Agents are improving but still amnesiac between sessions. Frustration grows as agents get *almost* good enough to trust but not quite. |
| **Pull** (attraction of Buildplane) | Medium-Strong | Implement-then-review and worktree isolation are genuinely compelling. But the value is not yet felt end-to-end because memory wiring is incomplete. |
| **Anxiety** (fear of the new) | High | 2 languages, 31 packages/crates for a solo dev — users will worry about maintenance. Plus: "am I adding a complexity layer to solve a complexity problem?" |
| **Habit** (comfort with raw agents) | High | Claude Code and Codex CLI are one command away and improving weekly. Muscle memory is strong. |

**Change formula:** Push + Pull ≈ Habit + Anxiety. This is a knife edge. **Memory that works end-to-end is what tips the equation.** When a user's second run is measurably smarter than their first, retention happens.

---

## Big Hire vs Little Hire

### Big Hire (Adopting Buildplane)
- **Risk:** The dual workspace (root = 91 tests, main = 513 TS + 95 Rust) and dual language stack create genuine anxiety about complexity and maintainer burnout. A solo dev shipping 31 packages/crates signals either exceptional execution or a system too large for one person.
- **Justification:** The split *is* justified **only if** root remains a stable, minimal kernel subset and main is the full-featured workspace. If root grows to include orchestration logic that duplicates main, it becomes dead weight. The 91-test root should be the minimal "can I dispatch and verify a unit?" contract. Main handles the rest.
- **Verdict:** Keep the split, but enforce a discipline: root gets features only when they're part of a minimal reproducible kernel contract. Everything else lives in main.

### Little Hire (Using Buildplane for this task right now)
- **Succeeds when:** Memory from prior runs makes this run faster. Quality gates caught something last time, giving the operator confidence. One command sets up worktrees, dispatches agents, and collects results.
- **Fails when:** Setup cost exceeds task value. The operator has to debug the framework instead of reviewing output. A run takes 10 minutes of config to save 5 minutes of typing.
- **The critical gap:** Stages 4-7 of the flywheel (extract learning, write memory, promote, retrieve/route) are **schema-ready but not wired**. Without end-to-end memory, the Little Hire is just a fancier dispatcher — and the operator can already "just open Claude Code directly."

---

## Competitive Landscape (Updated)

| Competitor | Threat | New Dynamic |
|-----------|--------|-------------|
| **Non-consumption** ("I'll write it myself") | **VERY HIGH** | Unchanged. Still 80%+ of developers. |
| **Claude Code / Codex CLI (raw)** | **HIGH → CRITICAL** | Anthropic and OpenAI are adding subagent spawning, hooks, background execution, and session management *weekly*. Their runway to "good enough orchestration" is measured in months, not years. |
| **Cursor / Windsurf** | **MEDIUM** | IDE-first, unlikely to build true CLI/ci/CD orchestration. Complementary, not competitive. |
| **Devin (Cognition)** | **HIGH** | Capital and talent to pivot to orchestration. Still single-agent, but the gap shrinks with each funding round. |
| **GitHub Copilot Agent** | **MEDIUM-HIGH** | Distribution moat is the threat. Already procured in enterprises. Not building orchestration, but "good enough" plus "already installed" beats "better" for 90% of developers. |
| **Platform providers absorbing orchestration** | **EXISTENTIAL** | The single biggest strategic risk. If Anthropic makes Claude Code itself into an orchestrator with memory, Buildplane's wrapper value shrinks to near-zero for the majority use case. |

**Non-obvious competitor:** The model providers' own plugin/extension ecosystems. If "Buildplane" becomes a Claude Code hook config file rather than a standalone tool, the business model changes dramatically. That might be fine — but it needs to be a choice, not a default outcome.

---

## Updated JTBD Score: 6.5/10

**Previous: 6/10** | **Current: 6.5/10** | **Gap to "must-use": 3.5 points**

### What moved up (+0.5):
- 699 tests across 31 packages/crates — exceptional test coverage for a solo dev
- Flywheel stages 1-3 (dispatch, observe, verify) are genuinely working
- Strategy executor + graph scheduler exist in main workspace
- Honcho adapter, Codex adapter, and TaskIntent renderers show agent-agnostic vision in practice, not just in docs
- Memory schema (4 scopes, 8 kinds, 4 statuses, promotion model) is well-designed

### What held it back:
- Memory wiring is incomplete (stages 4-7 are schema-ready but unwired)
- Policy layer is the thesis but the thinnest implementation
- No zero-config install path that works out of the box
- 2 languages, 31 packages for a solo dev creates real maintainer sustainability risk
- Platform risk from Anthropic/OpenAI has *increased* since the original analysis

### Remaining unknowns:
- No user research / discovery interviews completed
- No "% of runs that complete without human intervention" metric instrumented
- No eval harness to benchmark against raw agents

---

## Biggest Gaps Between Current State and the Job

1. **Memory that works end-to-end.** Schema exists, wiring doesn't. Without this, every run starts cold — the single most frustrating experience for AI agent users, and the one Buildplane claims to solve.

2. **Policy layer enforcement.** Budgets, trust gates, and stop rules exist in structure but lack the enforcement depth to give operators real confidence. This is the emotional job: trust through verification.

3. **Zero-friction first run.** The path from `npm install -g buildplane` to a successful, verified, memory-enhanced run is too long and has too many preconditions (clean git tree, Node 24+, `pnpm install`, init, packet creation).

4. **No proof of value.** Without an eval harness or benchmark showing Buildplane vs raw Claude Code on the same task, there's no data to counter the "it would be faster to just do it myself" objection.

5. **TUI is a skeleton.** The operator inspection experience is CLI-JSON only. Serious builders need to *see* the state of runs, agents, memory, and verification at a glance.

---

## What to Build NEXT — 7 Strategic Recommendations

1. **Wire the memory flywheel end-to-end (stages 4-7).** Extract learning from completed runs → write memory → promote between scopes → retrieve and inject into the next run. This is the single highest-leverage investment. Without it, Buildplane is a dispatcher with great ideas. With it, Buildplane becomes a system that gets smarter with every run.

2. **Ship one zero-friction demo experience.** A single command — `buildplane demo` — that clones a sample repo, runs an implement-then-review workflow with worktree isolation, shows the quality gate catching an issue, produces a verification report, and demonstrates memory carryover when run a second time. The demo should take < 60 seconds and require no packet writing.

3. **Harden the policy layer with teeth.** Budgets that actually stop agents. Trust gates that fail runs and alert operators. Stop rules that prevent runaway execution. This is the emotional job — if operators can't trust the system to stop bad actors, they won't delegate.

4. **Build an eval harness.** Run the same task through raw Claude Code and through Buildplane. Measure: output quality, time to completion, number of corrections needed, verification pass rate. You need data to win against the "just use Claude directly" reflex.

5. **Enforce the root/main boundary.** Audit what lives in root. If root has grown beyond the minimal kernel contract, prune it back. The 91 tests vs 608 split is fine if intentional — dangerous if accidental. Document the boundary.

6. **Ship the TUI for operator inspection.** Not as eye candy — as proof. The TUI should show: what was dispatched, what verified, what failed, what was learned. Make the system's internal state visible without running JSON through jq.

7. **Plan for the platform risk.** Assume Anthropic and OpenAI will build 80% of Buildplane's features into their CLI tools within 12-18 months. What's the defensible 20? It's likely: **agent-agnostic orchestration across providers**, **portable workflow packs**, and **the memory format as a standard**. Build toward becoming the standard, not just a tool.

---

## The One Thing to Ship in the Next 3 Months

**End-to-end memory wiring with visible carryover.**

Not all 31 packages. Not the TUI. Not multi-provider evals. Memory. When a user runs Buildplane twice on the same repo, the second run must be *demonstrably smarter and faster* because of what the first run learned. This is the difference between a dispatcher and a system that gets better over time.

Specifically: a completed run extracts facts into session memory → a promotion agent (rule-based, not magical) lifts durable facts to workspace memory → the next run retrieves workspace memory and injects it into the agent context → the operator sees concrete evidence: "This run used 3 memories carried forward from your previous run."

If Buildplane ships this and demonstrates it clearly, the Little Hire flips from "maybe I'll try it" to "not using Buildplane means my agents start stupid every time."

Everything else — more adapters, richer TUI, additional packs — is defensible after memory proves the thesis. Without it, Buildplane is an elegant system that doesn't deliver on its core promise: autonomous agents that learn.
