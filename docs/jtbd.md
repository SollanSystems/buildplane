# Jobs to Be Done: Buildplane

## The Job Statement

> **When** I'm building software with AI coding agents and constantly context-switching between prompt patterns, memory fragments, and tool-specific workflows,
>
> **I want to** have a unified, persistent operating system that remembers my conventions, enforces quality gates, and lets me delegate work autonomously,
>
> **So I can** focus on the actual product instead of babysitting prompts, re-explaining my stack, and wiring together disconnected tools.

This job is about **progress**: moving from fragmented, manual AI tool orchestration to a system that acts as a trusted co-pilot with institutional memory. The job exists regardless of which specific AI model or vendor is used -- it persists across Claude, GPT, Gemini, and whatever comes next.

## Three Dimensions of the Job

| Dimension | Description | Why It Matters |
|-----------|-------------|----------------|
| **Functional** | Orchestrate AI coding agents with shared memory, execution isolation (git worktrees), quality gates, and reproducible workflows -- all from the CLI | Without this, every session starts from zero. You lose time re-explaining architecture, conventions, and preferences. The kernel must own scheduling, state, policy, and verification -- not the model. |
| **Emotional** | Feel in control and confident that delegated work won't blow up the repo; trust the system to "just work" without constant supervision | The biggest barrier to AI adoption isn't capability -- it's anxiety about losing control of your codebase. Verification contracts and evidence-first execution address this directly. |
| **Social** | Be seen as a serious builder who uses systems, not hacks; ship fast without looking reckless | Power users want to be known for shipping quality work, not for being the person who merged broken AI output. Strategy modes (implement-then-review, adversarial, parallel-candidates) formalize this. |

## The Big Hire vs Little Hire

### Big Hire (Installing Buildplane)
- **Push**: Frustration with fragmented tooling -- re-explaining context to every AI session
- **Pull**: A single install that ties together memory, execution, quality gates, and multi-agent orchestration
- **Anxiety**: "Will this break my workflow? Am I trading one complexity for another?"
- **Habit**: Existing prompt snippets, tmux setups, and muscle memory with raw CLI agents

### Little Hire (Each Run/Mission)
The repeated, moment-to-moment decision: "Should I use Buildplane for this, or just open Claude Code directly?"

**Little Hire succeeds when:**
- One command is faster than manual setup
- Memory from previous runs makes each run smarter
- Quality gates catch issues before I review
- Isolation (worktrees) lets me parallelize safely
- Strategy execution (implement-then-review, adversarial) delivers better results than I could alone

**Little Hire fails when:**
- Setup overhead exceeds task complexity
- A run takes 10 minutes of config to save 30 minutes of work
- Error messages are cryptic and force debugging the framework instead of code
- The 505 passing tests hide the fact that Node version guard (now fixed) was blocking local dev

**Retention rule:** Every failed run, confusing error, or "it would be faster to just do it myself" moment chips away at adoption.

## Forces of Progress

| Force | Assessment | Intervention |
|-------|-----------|-------------|
| **Push** (frustration with current state) | Medium -- power users feel fragmentation acutely | Name it: "Stop being the glue between your AI tools" |
| **Pull** (attraction of Buildplane) | Strong -- unified memory + multi-agent orchestration is compelling | Show implement-then-review strategy in 30 seconds |
| **Anxiety** (fear of the new) | High -- "will this break my workflow?" | Evidence-first approach: every action produces receipts, artifacts, and verification signals |
| **Habit** (comfort with current behavior) | High -- existing snippets, tmux, muscle memory | Import layer: bring your existing prompt packets and workflows |

**Change formula:** Push + Pull > Habit + Anxiety
Currently, Habit + Anxiety may still win for most users. The kernel abstraction (model as worker, not system) is the key differentiator.

## Competitive Landscape (Non-Obvious)

| Competitor | Category | Why They Win |
|------------|----------|-------------|
| Raw Claude Code / Codex CLI | Direct simplicity | "One command, no setup" |
| Cursor / Windsurf | IDE integration | "It's in my editor with zero config" |
| Devin (Cognition) | Autonomous agent | "It just works -- I don't need to orchestrate" |
| Devin (Cognition) | Autonomy without config | "One tool, zero setup" |
| Custom tmux + prompt snippets | Workaround | "I've already invested in this" |
| GitHub Copilot agent | Big-tech default | "Already installed, works OK" |
| **Doing nothing / manual coding** | **Non-consumption** | **"I'll just write it myself, it's faster"** |

**The real competing job:** "Make AI coding agents work together without me being the glue." This means Buildplane competes most directly with the user's own tolerance for fragmentation.

## JTBD Diagnostic

| Question | Score | Gap |
|----------|-------|-----|
| Can you state the job without mentioning Buildplane? | Yes | Job statement passes this test |
| Have you mapped all four forces? | Yes | Done above |
| Do you know emotional and social dimensions? | Yes | Done above |
| Have you identified non-obvious competitors? | Partially | Non-consumption is the biggest rival |
| Are you tracking Little Hire separately? | No | Need a "runs without intervention" metric |
| Can the team map each feature to a job dimension? | Partially | Need job-to-feature mapping |
| Have you interviewed users about their decision timeline? | No | Need discovery interviews |

**Overall JTBD Score: 6/10**

## Feature-to-Job Mapping (Current Repo State)

| Feature | Job Dimension | Status |
|---------|--------------|--------|
| Kernel orchestrator (865 LOC) | Functional | IMPLEMENTED |
| Strategy execution (implement-then-review, adversarial) | Functional + Emotional | IMPLEMENTED |
| Event bus + run-scoped-bus | Functional | IMPLEMENTED |
| SQLite evidence store | Functional | IMPLEMENTED |
| Policy budgets + trust gates | Functional + Emotional | IMPLEMENTED |
| Git worktree isolation | Functional + Social | IMPLEMENTED |
| Honcho memory adapter | Functional | IMPLEMENTED |
| Multi-agent rendering (Claude/Codex) | Functional | IMPLEMENTED |
| Operator inspection + replay | Emotional | IMPLEMENTED |
| Published bootstrap staging | Social (trust) | IMPLEMENTED |

**Gaps vs the job:**
1. No zero-config install -- still requires `pnpm install` and Node 24+ setup
2. No workflow import from existing Claude Code / Codex setups
3. Memory promotion between packs not fully wired end-to-end
4. No eval harness to benchmark against raw agents
5. TUI exists (ui-tui) as skeleton only -- no visual operator experience

## Key Recommendations

1. **Measure Little Hire**: Track "% of runs that complete without human intervention" as the north-star retention metric
2. **Implement-then-review as killer feature**: This is Buildplane's most compelling differentiator vs raw agents. Make it the default path.
3. **One-line installer**: `curl -fsSL buildplane.dev/install | bash` or `npm install -g buildplane`
4. **Import existing workflows**: Reduce Habit friction by scanning Claude Code / Codex configs
5. **Eval harness**: Build benchmarks to validate "best in the world" claims
