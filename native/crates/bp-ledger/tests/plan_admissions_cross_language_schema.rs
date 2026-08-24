//! The `plan_admissions` projection is read by two languages, and only one of
//! them owns the schema.
//!
//! `packages/kernel/src/admitted-plan-reader.ts` opens this database directly
//! over `node:sqlite` and reads four names by hand: the table, the column it
//! keys the lookup on, the state column, and the `'sealed'` literal. Renaming
//! any of them on the Rust side silently disables every governed dispatch — the
//! reader's lookup misses or throws, either way resolving to not-sealed, so the
//! kernel gate refuses with a misleading "unsealed" diagnosis. That is a
//! fail-closed outage with, until now, no failing test on either side.
//!
//! This test is the pin. The four names below are the contract; each is
//! asserted against the **live** schema an opened store actually creates AND
//! against the TypeScript source that reads it, so a rename on either side
//! fails here.
//!
//! **Why this does not shell out to node** (the S2 round-trip pattern): the
//! binding under test is between a SQL schema and a string literal in a source
//! file. Comparing them needs no JavaScript execution, and shelling to node
//! would add a skip-when-absent path — turning a check that runs everywhere
//! into one that only runs in CI, for no extra guarantee.

use bp_ledger::storage::sqlite::SqliteStore;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// The cross-language contract. Changing any of these four is a coordinated
/// two-language change, and this test is the place that says so.
const TABLE: &str = "plan_admissions";
const KEY_COLUMN: &str = "admission_event_id";
const RUN_COLUMN: &str = "run_id";
const STATE_COLUMN: &str = "state";
const SEALED_STATE: &str = "sealed";
const AWAITING_STATE: &str = "awaiting_checkpoint";

const READER_SOURCE: &str = "packages/kernel/src/admitted-plan-reader.ts";

fn repository_root() -> PathBuf {
    // native/crates/bp-ledger -> native/crates -> native -> repository root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is nested three levels below the repository root")
        .to_path_buf()
}

fn reader_source() -> String {
    let path = repository_root().join(READER_SOURCE);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} must be readable: {error}", path.display()))
}

#[test]
fn the_rust_schema_creates_exactly_the_names_the_typescript_reader_hardcodes() {
    let directory = TempDir::new().unwrap();
    let store = SqliteStore::open(directory.path().join("events.db")).unwrap();
    let connection = store.conn_for_tests();

    let table_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [TABLE],
            |row| row.get(0),
        )
        .unwrap_or_else(|error| {
            panic!("opening a store must create the `{TABLE}` projection: {error}")
        });

    let columns: Vec<String> = {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({TABLE})"))
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap();
        rows.map(Result::unwrap).collect()
    };
    assert!(
        columns.iter().any(|column| column == KEY_COLUMN),
        "the reader keys its lookup on `{KEY_COLUMN}`, which the live schema must have: {columns:?}"
    );
    assert!(
        columns.iter().any(|column| column == STATE_COLUMN),
        "the reader selects `{STATE_COLUMN}`, which the live schema must have: {columns:?}"
    );
    assert!(
        table_sql.contains(&format!("{KEY_COLUMN}              TEXT NOT NULL UNIQUE"))
            || table_sql.contains(&format!("{KEY_COLUMN} TEXT NOT NULL UNIQUE")),
        "the reader's single-row lookup depends on `{KEY_COLUMN}` being UNIQUE: {table_sql}"
    );
    assert!(
        table_sql.contains(&format!("'{AWAITING_STATE}', '{SEALED_STATE}'")),
        "the live CHECK constraint must admit exactly the two states the reader distinguishes: \
         {table_sql}"
    );

    let source = reader_source();
    let expected_query =
        format!("SELECT {STATE_COLUMN} FROM {TABLE} WHERE {KEY_COLUMN} = ? AND {RUN_COLUMN} = ?");
    assert!(
        source.contains(&expected_query),
        "{READER_SOURCE} must issue exactly `{expected_query}`; a rename on either side is a \
         coordinated two-language change. The projection lookup binds run_id as well as the \
         admission event id, so the sealed row must belong to the same run as its event."
    );
    assert!(
        columns.iter().any(|column| column == RUN_COLUMN),
        "the reader binds the projection lookup on `{RUN_COLUMN}`, which the live schema must \
         have: {columns:?}"
    );
    assert!(
        source.contains(&format!(
            "const PLAN_ADMISSION_SEALED_STATE = \"{SEALED_STATE}\";"
        )),
        "{READER_SOURCE} must compare against the same `{SEALED_STATE}` literal the CHECK \
         constraint admits"
    );
}

/// The reader treats every uncertainty as not-sealed, which is only safe if the
/// two states really are the whole vocabulary. Pin that the database refuses a
/// third one, so "not sealed" can never mean "some state the reader has not
/// heard of and silently ignored".
#[test]
fn the_projection_state_vocabulary_is_closed_to_exactly_two_values() {
    let directory = TempDir::new().unwrap();
    let store = SqliteStore::open(directory.path().join("events.db")).unwrap();
    let connection = store.conn_for_tests();
    // The projection's admission id is a foreign key into `events`, and a
    // synthetic row would fail on that long before the CHECK was evaluated —
    // which would make every negative below pass for the wrong reason. This is
    // a throwaway store whose only purpose is to answer one question: what does
    // the state CHECK admit?
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();

    let insert = format!(
        "INSERT INTO {TABLE} (
            run_id, request_id, admission_identity_digest, plan_content_ref, plan_id,
            input_digest, trusted_base, decided_by, decided_at, authorized_next_step,
            asserted_plan_digest, asserted_idempotency_key, asserted_validation_status,
            ledger_authority_realm_digest, {KEY_COLUMN}, admission_event_digest,
            {STATE_COLUMN}, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
    );
    let row = |state: &str| {
        [
            "run".to_string(),
            format!("request-{state}"),
            format!("identity-{state}"),
            "cas://sha256:aa".to_string(),
            "pf-plan".to_string(),
            "sha256:bb".to_string(),
            "c".repeat(40),
            "operator:test".to_string(),
            "2026-01-01T00:00:00Z".to_string(),
            "dispatch".to_string(),
            "sha256:cc".to_string(),
            "planforge:v0".to_string(),
            "PASS".to_string(),
            "sha256:dd".to_string(),
            format!("event-{state}"),
            "sha256:ee".to_string(),
            state.to_string(),
            "2026-01-01T00:00:00Z".to_string(),
        ]
    };

    for rejected in ["SEALED", "Sealed", "sealed ", "pending", "", "awaiting"] {
        let error = connection
            .execute(&insert, rusqlite::params_from_iter(row(rejected)))
            .expect_err(&format!(
                "`{rejected}` must not be a storable projection state: the reader distinguishes \
                 exactly `{AWAITING_STATE}` and `{SEALED_STATE}`"
            ))
            .to_string();
        assert!(
            error.contains("CHECK constraint failed"),
            "`{rejected}` must be refused by the state CHECK itself, not by some other \
             constraint that happens to fire first: {error}"
        );
    }
    connection
        .execute(&insert, rusqlite::params_from_iter(row(AWAITING_STATE)))
        .unwrap_or_else(|error| {
            panic!("`{AWAITING_STATE}` must be a storable projection state: {error}")
        });
}
