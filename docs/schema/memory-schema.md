# Buildplane Memory Schema Proposal

> **Implementation status (origin/main, verified 2026-05-26):** this proposal is
> partly shipped and partly divergent from the real schema. Treat the real tables
> in `packages/storage/src/store.ts` + `database.ts` as ground truth, not the DDL
> sketch below.
>
> | Proposed here | Real on origin/main |
> |---|---|
> | `events` | ✅ `events` (in `database.ts`) |
> | `artifacts` | ✅ `artifacts` |
> | `repo_facts` | ✅ `repo_facts` (with `created_by`/`branch`/`commit_sha`/`valid_*_commit`) |
> | `procedures` | ✅ `procedures` |
> | `searchable_documents` + FTS | ✅ `searchable_documents` + `searchable_documents_fts` (fts5) |
> | `repos` | ❌ no dedicated table — repo identity via `runs`/`workspaces` |
> | `tasks` | ❌ modeled as `units` + `steps` |
> | `outcome_scores` | ❌ not built (the outcome/scoring layer is still future) |
> | `memory_entries` | ❌ not built (dedicated tables used instead — intended) |
>
> Real tables the proposal omits: `units`, `steps`, `evidence`, `decisions`,
> `workspaces`, `run_learnings` (run-derived learnings + promotion),
> `injected_memories` (what memory was injected into each run). See
> `docs/plans/v1-memory-implementation.md`.

## Schema goals

The schema must support:
- append-only episodic memory
- deterministic replay
- repo-scoped structured facts
- reusable procedures
- outcome scoring
- exact retrieval first
- semantic retrieval second

## Core entities

### `repos`
Represents a codebase.

Fields:
- `id` TEXT/UUID PK
- `canonical_path` TEXT
- `remote_url` TEXT NULL
- `default_branch` TEXT NULL
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

### `runs`
Represents a top-level Buildplane execution.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id`
- `engine` TEXT
- `status` TEXT
- `verdict` TEXT NULL
- `task_summary` TEXT
- `branch_name` TEXT NULL
- `workspace_path` TEXT NULL
- `started_at` TIMESTAMP
- `completed_at` TIMESTAMP NULL
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

### `tasks`
Represents a typed unit of work within a run.

Fields:
- `id` TEXT/UUID PK
- `run_id` FK `runs.id`
- `parent_task_id` FK `tasks.id` NULL
- `task_type` TEXT
- `task_status` TEXT
- `attempt` INTEGER
- `worker_role` TEXT
- `input_payload_json` JSON/TEXT
- `output_payload_json` JSON/TEXT NULL
- `started_at` TIMESTAMP NULL
- `completed_at` TIMESTAMP NULL
- `created_at` TIMESTAMP

### `events`
Append-only canonical event log.

Fields:
- `id` TEXT/UUID PK
- `run_id` FK `runs.id`
- `task_id` FK `tasks.id` NULL
- `event_kind` TEXT
- `event_timestamp` TIMESTAMP
- `payload_json` JSON/TEXT
- `created_at` TIMESTAMP

Indexes:
- `(run_id, event_timestamp)`
- `(task_id, event_timestamp)`
- `(event_kind, event_timestamp)`

### `artifacts`
References large outputs kept outside the DB.

Fields:
- `id` TEXT/UUID PK
- `run_id` FK `runs.id`
- `task_id` FK `tasks.id` NULL
- `artifact_kind` TEXT
- `path` TEXT
- `content_hash` TEXT NULL
- `metadata_json` JSON/TEXT NULL
- `created_at` TIMESTAMP

Examples:
- diff
- log
- test-report
- review-summary
- plan
- patch

## Structured memory tables

### `repo_facts`
Canonical structured facts about a repo.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id`
- `fact_key` TEXT
- `fact_value_json` JSON/TEXT
- `value_type` TEXT
- `scope_type` TEXT DEFAULT `repo`
- `scope_key` TEXT NULL
- `confidence` REAL
- `source_run_id` FK `runs.id` NULL
- `source_task_id` FK `tasks.id` NULL
- `status` TEXT DEFAULT `active`
- `valid_from_commit` TEXT NULL
- `valid_to_commit` TEXT NULL
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

Recommended uniqueness:
- `(repo_id, fact_key, scope_type, COALESCE(scope_key, ''))`

Examples:
- `commands.test`
- `commands.typecheck`
- `conventions.branch_naming`
- `risk_paths`
- `definition_of_done.requires`

### `procedures`
Reusable playbooks or skills extracted from successful runs.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id` NULL
- `name` TEXT
- `task_type` TEXT NULL
- `body_markdown` TEXT
- `metadata_json` JSON/TEXT NULL
- `confidence` REAL
- `source_run_id` FK `runs.id` NULL
- `source_task_id` FK `tasks.id` NULL
- `status` TEXT DEFAULT `active`
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

Examples:
- fix monorepo TypeScript build break after schema change
- update lockfile, regenerate types, rerun package checks

### `outcome_scores`
Aggregated strategy performance.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id`
- `task_type` TEXT
- `engine` TEXT
- `worker_role` TEXT NULL
- `strategy_key` TEXT
- `sample_count` INTEGER
- `success_count` INTEGER
- `review_approve_count` INTEGER
- `mean_attempts` REAL
- `mean_duration_ms` REAL
- `score` REAL
- `updated_at` TIMESTAMP

Recommended uniqueness:
- `(repo_id, task_type, engine, COALESCE(worker_role, ''), strategy_key)`

### `memory_entries`
Generic scoped memory abstraction for cross-cutting use.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id` NULL
- `memory_type` TEXT
- `scope_type` TEXT
- `scope_key` TEXT NULL
- `title` TEXT NULL
- `body_text` TEXT
- `body_json` JSON/TEXT NULL
- `confidence` REAL
- `source_run_id` FK `runs.id` NULL
- `source_task_id` FK `tasks.id` NULL
- `status` TEXT DEFAULT `active`
- `created_by` TEXT
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

Use this only where the dedicated tables above are too rigid.

## Retrieval support tables

### `searchable_documents`
FTS-friendly normalized retrieval records.

Fields:
- `id` TEXT/UUID PK
- `repo_id` FK `repos.id` NULL
- `source_table` TEXT
- `source_id` TEXT
- `document_kind` TEXT
- `title` TEXT NULL
- `body_text` TEXT
- `metadata_json` JSON/TEXT NULL
- `created_at` TIMESTAMP
- `updated_at` TIMESTAMP

SQLite:
- create `searchable_documents_fts` using FTS5 over `title`, `body_text`

Postgres:
- use `tsvector` index on title and body

### `embeddings` (optional V2/V3)
Only for semantic retrieval over selected summarized docs.

Fields:
- `id` TEXT/UUID PK
- `source_table` TEXT
- `source_id` TEXT
- `embedding_model` TEXT
- `embedding_vector` VECTOR/BLOB
- `created_at` TIMESTAMP

Important:
Do not embed everything.
Embed:
- plan summaries
- review summaries
- distilled failure summaries
- distilled procedures

Do not use this as source of truth.

## Suggested SQLite DDL sketch

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  task_summary TEXT NOT NULL,
  branch_name TEXT,
  workspace_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_task_id TEXT,
  task_type TEXT NOT NULL,
  task_status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  worker_role TEXT NOT NULL,
  input_payload_json TEXT NOT NULL,
  output_payload_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  event_kind TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_events_run_time ON events(run_id, event_timestamp);
CREATE INDEX idx_events_kind_time ON events(event_kind, event_timestamp);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  artifact_kind TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE repo_facts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value_json TEXT NOT NULL,
  value_type TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'repo',
  scope_key TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_run_id TEXT,
  source_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from_commit TEXT,
  valid_to_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);

CREATE TABLE procedures (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  name TEXT NOT NULL,
  task_type TEXT,
  body_markdown TEXT NOT NULL,
  metadata_json TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_run_id TEXT,
  source_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);

CREATE TABLE outcome_scores (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  engine TEXT NOT NULL,
  worker_role TEXT,
  strategy_key TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  review_approve_count INTEGER NOT NULL DEFAULT 0,
  mean_attempts REAL NOT NULL DEFAULT 0,
  mean_duration_ms REAL NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);

CREATE TABLE searchable_documents (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_kind TEXT NOT NULL,
  title TEXT,
  body_text TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);
```

## Recommended retrieval strategy

### Exact retrieval
- `repo_facts`
- `procedures`
- recent `runs`
- `searchable_documents` via FTS

### Semantic retrieval
- optional embeddings over selected summaries only

## Implementation note

This schema is designed for a TypeScript-first Buildplane monorepo with SQLite in local-first mode and a clean migration path to Postgres later. It is intentionally conservative: event log first, structured memory second, semantic memory third.

## Summary

The right schema is:
- events for truth
- facts for operational memory
- procedures for compounding skill
- scores for routing
- search docs for retrieval
- embeddings only as optional support
