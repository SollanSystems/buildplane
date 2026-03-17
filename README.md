<div align="center">

# Buildplane

**The control plane for autonomous software execution.**

*Operator-first autonomy for serious builders.*

</div>

Buildplane by **SollanSystems** is an operator-first execution system for autonomous software work. It treats language models as bounded workers inside a deterministic kernel that owns scheduling, state, policies, verification, and recovery. Instead of relying on one long-running chat session, Buildplane dispatches typed units of work in isolated contexts, captures evidence for every meaningful action, and advances only when reality matches the contract.

Build software with autonomy you can inspect, verify, reroute, and resume.

## Why Buildplane

- **Deterministic control plane** — the model is a worker, not the system
- **Bounded execution units** — work is dispatched in clean, isolated contexts
- **Evidence-first automation** — actions produce receipts, artifacts, and verification signals
- **Operator control** — inspect, pause, replay, intervene, recover
- **Recovery built in** — resume after interruptions without losing the thread
- **Policy-aware autonomy** — budgets, trust gates, retries, and stop rules are enforced by the runtime

## Install

```bash
npm install -g buildplane
```

## Status

This repo is an initial bootstrap scaffold. Milestone 1 is focused on the execution kernel: typed units of work, durable state, bounded worker runs, verification, and operator inspection.
