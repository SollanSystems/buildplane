# Buildplane Control-Plane Positioning Design

**Date:** 2026-04-22
**Product:** Buildplane
**Status:** Proposed positioning and front-door alignment for the current repo reality

## Thesis

Buildplane is the deterministic control plane for autonomous software execution.

It is not another autonomous coding agent, not a chat-first shell, and not a thin provider wrapper. Buildplane sits above agent workers and gives operators a governed system for routing, constraining, verifying, inspecting, replaying, and recovering autonomous software work.

Short form:

- Hermes, Claude Code, Codex, and similar tools are workers
- Buildplane is the kernel, orchestration layer, trust layer, and recovery surface around those workers

## Why this positioning now

The current repo already implements the hard parts of a control-plane thesis better than it implements a broad public release story.

The repo has real:

- kernel/runtime/policy/storage separation
- typed run and unit execution surfaces
- evidence and decision capture
- status/inspect/replay-oriented operator surfaces
- strategy execution beyond one-shot raw runs
- structured memory foundations
- worktree/workspace isolation concepts

That means the strongest honest product statement is not "smartest agent" or "best shell". It is "the system that makes autonomous software work governable."

## Core job to be done

When I need AI agents to do meaningful software work across a repo, I want a system that can route, constrain, verify, inspect, replay, and recover those runs, so I get autonomous progress without babysitting prompts or trusting a black box.

### Functional job

Users hire Buildplane to:

- delegate real repo work safely
- package work into bounded units and strategies
- preserve durable run state outside the transcript
- collect receipts, artifacts, and verification evidence
- inspect what happened and why
- recover from bad runs without starting from zero
- standardize multi-agent operating behavior across workers and providers

### Emotional job

Users want to:

- feel in control even when autonomy increases
- reduce anxiety about repo damage or silent failure
- trust delegated work because it is inspectable and reviewable
- recover instead of restarting from scratch after interruptions or bad outcomes

### Social job

Users want to:

- use AI in a disciplined, defensible way
- show evidence instead of saying "the model said so"
- operate with a repeatable system rather than prompt folklore
- make autonomous work legible to teammates, reviewers, and future selves

## Competitive alternatives

Buildplane does not primarily compete with raw model quality. It competes against fragmented operating models.

Current alternatives users hire for adjacent jobs:

- raw Claude Code / Codex / Hermes sessions
- Cursor / Windsurf / Copilot editor workflows
- Aider-style terminal pair-programming
- Devin-style long-running delegation
- tmux + worktrees + shell scripts + prompt files + manual checklists
- doing the work manually because autonomous execution still feels too risky

The strongest practical competitor is often homemade glue, not another branded product.

## Positioning wedge

Buildplane wins when autonomous work must be:

- inspectable
- reviewable
- recoverable
- policy-bound
- safe to delegate
- reproducible across runs and workers

The wedge is not "better agent cognition."

The wedge is:

- deterministic orchestration over stochastic workers
- typed work and durable run state
- evidence-first execution
- recovery and replay as first-class workflows
- policy and review separated from worker reasoning
- worker interchangeability across shells/providers

One-line wedge:

Buildplane turns stochastic coding agents into governed workers.

## What Buildplane is

Buildplane should present itself as:

- the orchestration and trust layer for autonomous software work
- the deterministic control plane for autonomous software execution
- an operator-first system for routing, constraining, verifying, replaying, and recovering agent work

Architecturally, Buildplane owns:

- work admission
- task/run packaging
- route selection
- policy and trust gates
- evidence and decision capture
- verification gates
- status/inspect/replay/recovery surfaces
- memory with provenance

## What Buildplane is not

Buildplane should not try to become:

1. Another chat-first coding shell
2. A monolithic super-agent where the model becomes the system again
3. A thin provider wrapper that collapses pack, host, and provider into one layer
4. Opaque memory theater without provenance, explanation, and operator control
5. A breadth-first feature race on messaging surfaces, personality, or general assistant feel

## Product guardrails implied by this positioning

### 1. Control-plane depth over agent breadth

Prefer:

- clearer inspect/provenance
- stronger verification
- better replay/fork/recovery
- calmer operator surfaces
- better policy visibility

Over:

- more chat UX
- more generic assistant behavior
- more shell mimicry
- more breadth without stronger governance

### 2. Worker-agnostic framing

Buildplane should treat Hermes-like systems as routable workers, not as the product center.

That means:

- no single shell should define the top-level product identity
- pack/host/provider separation remains strategically important
- worker choice should feel interchangeable inside Buildplane's operator model

### 3. Honest support boundaries

The public story must match what the repo actually proves.

That means:

- repo-development and in-repo built CLI paths are currently the clearest supported operator paths
- published/global install should be described as narrower while memory/native contracts remain excluded from the verified public package path
- the README and strategy docs should not underclaim the implemented control-plane surfaces, but they should not overclaim public-release readiness either

## Message hierarchy

### Primary line

Buildplane is the deterministic control plane for autonomous software execution.

### Supporting line

It turns raw AI coding agents into governed workers by wrapping them in typed work units, policy boundaries, evidence capture, verification gates, and operator recovery flows.

### Operator-facing translation

Use Buildplane when autonomous software work must be inspectable, reviewable, recoverable, and safe to delegate.

## Near-term implications for the roadmap

The next strategic slices should reinforce the control-plane thesis rather than broaden agent-shell behavior.

Highest-value directions:

1. make the trust contract boring and green
2. build a unified inspect/provenance surface
3. make replay/review/recovery the default operator narrative

## Non-goals for this positioning slice

- redesigning the whole package architecture
- changing the pack/host/provider split
- adding new providers or shells for breadth alone
- claiming public-release readiness before verification/readiness surfaces are green

## Acceptance criteria

This positioning slice is successful when:

- README front-door language clearly frames Buildplane as a control plane, not a chat-first assistant
- the repo has a durable written positioning memo aligned to current repo reality
- the next 30-day plan is explicitly organized around trust surfaces and operator control, not breadth
- future docs and roadmap conversations have a clear north star for what Buildplane should and should not become
