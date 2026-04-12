import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapStorageProjectionSchema,
  assertBaselineStorageProjectionSchema,
} from "../src/store";

const databases: DatabaseSync[] = [];

function openTempDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("memory storage schema", () => {
  it("bootstraps repo memory tables", () => {
    const database = openTempDatabase();

    bootstrapStorageProjectionSchema(database);

    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repo_facts', 'procedures', 'searchable_documents') ORDER BY name ASC`,
      )
      .all() as { name: string }[];

    expect(tables.map((row) => row.name)).toEqual([
      'procedures',
      'repo_facts',
      'searchable_documents',
    ]);
  });

  it("adds expected repo_facts columns", () => {
    const database = openTempDatabase();

    bootstrapStorageProjectionSchema(database);

    const columns = database
      .prepare(`PRAGMA table_info(repo_facts)`)
      .all() as { name: string }[];

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'repo_id',
        'fact_key',
        'fact_value_json',
        'value_type',
        'scope_type',
        'scope_key',
        'confidence',
        'source_run_id',
        'source_task_id',
        'status',
        'valid_from_commit',
        'valid_to_commit',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it("treats repo memory tables as part of the baseline projection schema", () => {
    const database = openTempDatabase();

    bootstrapStorageProjectionSchema(database);

    expect(() => assertBaselineStorageProjectionSchema(database)).not.toThrow();
  });
});
