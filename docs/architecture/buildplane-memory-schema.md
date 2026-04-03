# Buildplane Memory Schema

Date: 2026-04-01
Status: Proposed v1 contract for Buildplane memory

This document defines the concrete memory model for Buildplane as the umbrella system under which provider-specific packs such as SuperClaude and SuperCodex run.

The central rule is simple:

- one memory system
- multiple scopes
- shared facts, separate tactics

Related distinction:

- config = explicit settings
- memory = learned durable facts
- session state = temporary working context
- skills = reusable procedures and templates

## Goals

- let Buildplane remember durable user and workspace facts without turning into an opaque blob
- let SuperClaude and SuperCodex benefit from shared context without contaminating each other's provider-specific tactics
- keep memory local-first, inspectable, editable, deletable, and exportable
- support safe promotion from narrower scopes to broader scopes
- make retrieval explainable enough for operator trust

## Scope model

Buildplane v1 uses four memory scopes plus a separate skill system.

### 1. User scope

Use for facts that should apply across workspaces and packs.

Examples:
- prefers concise output
- prefers deep mode for planning
- wants rollback-friendly execution

### 2. Workspace scope

Use for facts that belong to a repository or project.

Examples:
- repo uses pnpm + turbo
- this workspace expects a clean git tree before `run`
- public docs live under `docs/architecture/`

### 3. Pack scope

Use for provider- or pack-specific heuristics.

Examples:
- SuperClaude planning prompts should prefer explicit section headers
- SuperCodex daily mode should bias toward shorter, more tool-oriented instructions
- this pack defaults to a given reasoning/autonomy shape

### 4. Session scope

Use for temporary notes that should expire.

Examples:
- current branch is `feat/memory-v1`
- current hypothesis is that ranking should downweight stale pack heuristics
- operator approved a one-off override during this run

### 5. Skills

Skills are not memory items. They are reusable procedures, templates, and checklists stored and loaded separately.

## Retrieval visibility

For a given run, Buildplane should read from these scopes:

1. session
2. workspace
3. user
4. pack

This is a retrieval priority, not a storage priority. Pack heuristics are useful, but explicit user preferences and workspace facts should normally win.

When multiple items conflict, the winning order is:

1. explicit operator override in the current session
2. workspace fact or decision for the active repo
3. user preference or constraint
4. pack heuristic or default
5. fallback config default

Additional tie-breakers:
- explicit user-entered facts beat inferred facts
- active items beat archived or forgotten items
- higher confidence beats lower confidence
- newer superseding items beat older items

## Storage layout

Buildplane should stay local-first.

Global paths:

```text
~/.buildplane/
  config.yaml
  global.db
  skills/
  packs/
```

Per-workspace paths:

```text
<repo>/.buildplane/
  workspace.db
  sessions/
  cache/
```

Why this split:
- user and pack memory travel with the user
- workspace memory stays with the repo context
- session state is easy to inspect and prune

## Logical entities

Buildplane v1 needs three durable entities:

- `memory_items` — the facts themselves
- `memory_events` — audit trail for create/use/update/promote/forget actions
- `memory_links` — relationships such as promoted-from or contradicts

An FTS index should exist for search and explainability.

## Recommended SQLite schema

```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('user','workspace','pack','session')
  ),
  scope_key TEXT NOT NULL,

  kind TEXT NOT NULL CHECK (
    kind IN (
      'preference',
      'constraint',
      'fact',
      'decision',
      'workflow',
      'environment',
      'provider_heuristic',
      'alias'
    )
  ),

  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT DEFAULT '',

  tags_json TEXT NOT NULL DEFAULT '[]',
  applicable_packs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',

  source_type TEXT NOT NULL CHECK (
    source_type IN ('user','agent','tool','import','promotion')
  ),
  source_ref TEXT DEFAULT '',
  origin_pack TEXT DEFAULT '',
  created_by TEXT DEFAULT '',

  confidence REAL NOT NULL DEFAULT 0.80,
  importance INTEGER NOT NULL DEFAULT 50,
  pinned INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','forgotten','archived','superseded')
  ),
  promoted_from_id TEXT DEFAULT '',
  supersedes_id TEXT DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT DEFAULT '',
  expires_at TEXT DEFAULT ''
);
```

```sql
CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'create',
      'update',
      'use',
      'promote',
      'forget',
      'restore',
      'expire',
      'merge'
    )
  ),

  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('user','pack','system')
  ),
  actor_id TEXT NOT NULL,

  from_scope_type TEXT DEFAULT '',
  from_scope_key TEXT DEFAULT '',
  to_scope_type TEXT DEFAULT '',
  to_scope_key TEXT DEFAULT '',

  reason TEXT DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

```sql
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (
    relation IN (
      'derived_from',
      'promoted_from',
      'supports',
      'contradicts',
      'duplicate_of'
    )
  ),
  created_at TEXT NOT NULL
);
```

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tags
);
```

Recommended indexes:

```sql
CREATE INDEX idx_memory_scope ON memory_items(scope_type, scope_key, status);
CREATE INDEX idx_memory_kind ON memory_items(kind, status);
CREATE INDEX idx_memory_origin_pack ON memory_items(origin_pack, status);
CREATE INDEX idx_memory_updated_at ON memory_items(updated_at);
CREATE INDEX idx_memory_expires_at ON memory_items(expires_at);
```

## Scope keys

Use stable scope keys.

- user scope key: `global`
- workspace scope key: normalized absolute repo root path or durable workspace id
- pack scope key: pack id such as `superclaude` or `supercodex`
- session scope key: run id or session id

## Item kinds

Use these v1 kinds:

- `preference` — user style or workflow preference
- `constraint` — must-follow rule or boundary
- `fact` — stable truth about environment or project
- `decision` — documented choice made for the workspace or user setup
- `workflow` — validated recurring practice that is not yet a formal skill
- `environment` — setup, tooling, or platform quirk
- `provider_heuristic` — pack/provider-specific tactic
- `alias` — stable mapping such as nickname to canonical resource

## Write policy

Default write destinations:

- user explicitly states a durable preference -> user scope
- repo fact or project convention is discovered -> workspace scope
- Claude/Codex-specific tactic is learned -> pack scope
- temporary breadcrumb from the current run -> session scope

Never store in memory:
- API keys
- tokens
- secrets
- large raw logs
- full transcripts
- deterministic configuration values that belong in config

## Promotion policy

Promotion should be explicit or rule-based, never magical.

Recommended promotion rules:

- session -> workspace when validated and likely useful in future runs in the same repo
- session -> user only when the pattern is clearly durable across repos or the operator explicitly confirms it
- pack -> workspace when the learned fact is really about this repo, not the provider
- pack -> user only when the insight is provider-agnostic and durable
- pack -> pack promotion should preserve the origin link and create a new item rather than mutating history

Default promote behavior should be copy, not move.

## Forget and retention policy

- user, workspace, and pack memory are durable by default
- session memory should expire after 7 days unless pinned or promoted
- `forget` should default to soft delete by marking `status = 'forgotten'`
- hard delete should be opt-in and explicit
- forgotten items should remain auditable unless a secure wipe is requested

## Retrieval pipeline

For each run, `bp-memory` should perform these steps:

1. load applicable user, workspace, pack, and session items
2. discard inactive, expired, or pack-inapplicable rows
3. apply conflict and precedence rules
4. rank by scope relevance, importance, confidence, recency, and tag match
5. emit both the ranked memory set and an explanation structure for operator inspection

## Example item

```json
{
  "id": "mem_01HXYZ",
  "scope_type": "pack",
  "scope_key": "superclaude",
  "kind": "provider_heuristic",
  "title": "Structured planning prompts work best for SuperClaude",
  "body": "For complex planning, prefer Goal, Constraints, Plan, and Deliverable sections instead of a flat prompt.",
  "tags_json": ["claude", "prompting", "planning"],
  "applicable_packs_json": ["superclaude"],
  "source_type": "promotion",
  "origin_pack": "superclaude",
  "confidence": 0.91,
  "importance": 67,
  "status": "active",
  "created_at": "2026-04-01T18:00:00Z",
  "updated_at": "2026-04-01T18:00:00Z"
}
```

## Mapping to current repo

Current codebase seams:

- `native/crates/bp-memory` should own scope resolution, ranking, and promotion logic
- `native/crates/bp-storage-sqlite` should own the concrete SQLite implementation and migrations
- `native/crates/bp-config` should own explicit configuration, not learned memory
- `native/packs/superclaude/pack.toml` and `native/packs/supercodex/pack.toml` should expose pack-level memory sharing flags and defaults
- the current TypeScript workspace can continue shipping while converging on the same logical contract over time

## Non-goals for v1

Do not add these yet:

- cloud sync
- org/team shared memory
- embeddings/vector retrieval
- secret storage inside memory rows
- memory-driven silent automation with no inspectability

The v1 win condition is simpler: Buildplane remembers the right things, in the right scope, and can explain why.