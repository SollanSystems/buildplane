use bp_memory::{
    MemoryError, MemoryEvent, MemoryEventAction, MemoryItem, MemoryKind, MemoryLink,
    MemoryLinkRelation, MemoryQuery, MemoryRepository, MemoryResult, MemoryScope, MemorySourceType,
    MemoryStatus,
};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use thiserror::Error;

const MEMORY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    applicable_packs_json TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    origin_pack TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    promoted_from_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL,
    to_memory_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED,
    title,
    body,
    tags
);

CREATE INDEX IF NOT EXISTS idx_memory_items_scope
ON memory_items(scope_type, scope_key, status);

CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id
ON memory_events(memory_id, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_links_from_to
ON memory_links(from_memory_id, to_memory_id, relation);
"#;

pub const GLOBAL_DATABASE_FILENAME: &str = "global.db";
pub const WORKSPACE_DATABASE_FILENAME: &str = "workspace.db";
pub const DEFAULT_BUILDPLANE_DIRNAME: &str = ".buildplane";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoragePaths {
    pub global_database: PathBuf,
    pub workspace_database: PathBuf,
    pub artifacts_dir: PathBuf,
    pub evidence_dir: PathBuf,
}

impl StoragePaths {
    pub fn for_roots(global_root: impl AsRef<Path>, workspace_root: impl AsRef<Path>) -> Self {
        let global_root = global_root.as_ref();
        let workspace_root = workspace_root.as_ref();
        let workspace_dir = workspace_root.join(DEFAULT_BUILDPLANE_DIRNAME);
        Self {
            global_database: global_root.join(GLOBAL_DATABASE_FILENAME),
            workspace_database: workspace_dir.join(WORKSPACE_DATABASE_FILENAME),
            artifacts_dir: workspace_dir.join("artifacts"),
            evidence_dir: workspace_dir.join("evidence"),
        }
    }

    pub fn for_workspace_root(workspace_root: impl AsRef<Path>) -> Result<Self, StorageError> {
        Ok(Self::for_roots(default_global_root()?, workspace_root))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryExportBundle {
    pub schema_version: u32,
    pub items: Vec<MemoryItem>,
    pub events: Vec<MemoryEvent>,
    pub links: Vec<MemoryLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryImportReport {
    pub imported_items: usize,
    pub imported_events: usize,
    pub imported_links: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryDoctorReport {
    pub global_database: PathBuf,
    pub workspace_database: PathBuf,
    pub global_item_count: usize,
    pub workspace_item_count: usize,
    pub global_event_count: usize,
    pub workspace_event_count: usize,
    pub global_link_count: usize,
    pub workspace_link_count: usize,
    pub forgotten_item_count: usize,
    pub duplicate_item_ids: Vec<String>,
    pub orphan_event_ids: Vec<String>,
    pub orphan_link_ids: Vec<String>,
    pub orphan_promoted_item_ids: Vec<String>,
    pub duplicate_promoted_item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryPruneReport {
    pub removed_items: usize,
    pub removed_events: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DatabaseKind {
    Global,
    Workspace,
}

pub struct SqliteMemoryStore {
    paths: StoragePaths,
    global_connection: Connection,
    workspace_connection: Connection,
}

impl SqliteMemoryStore {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = database_path
            .as_ref()
            .parent()
            .ok_or_else(|| {
                StorageError::InvalidPath("database path must have a parent".to_string())
            })?
            .to_path_buf();
        Self::open_with_roots(root, std::env::current_dir()?)
    }

    pub fn open_with_roots(
        global_root: impl AsRef<Path>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, StorageError> {
        let paths = StoragePaths::for_roots(global_root, workspace_root);
        initialize_parent(&paths.global_database)?;
        initialize_parent(&paths.workspace_database)?;
        fs::create_dir_all(&paths.artifacts_dir)?;
        fs::create_dir_all(&paths.evidence_dir)?;

        let global_connection = Connection::open(&paths.global_database)?;
        global_connection.execute_batch(MEMORY_SCHEMA)?;
        let workspace_connection = Connection::open(&paths.workspace_database)?;
        workspace_connection.execute_batch(MEMORY_SCHEMA)?;

        Ok(Self {
            paths,
            global_connection,
            workspace_connection,
        })
    }

    pub fn open_under_workspace(workspace_root: impl AsRef<Path>) -> Result<Self, StorageError> {
        Self::open_with_roots(default_global_root()?, workspace_root)
    }

    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    pub fn export_bundle(&self, query: &MemoryQuery) -> Result<MemoryExportBundle, StorageError> {
        let items = self.list_items(query).map_err(StorageError::Memory)?;
        let memory_ids = items
            .iter()
            .map(|item| item.id.clone())
            .collect::<BTreeSet<_>>();
        let events = self
            .list_events(None)
            .map_err(StorageError::Memory)?
            .into_iter()
            .filter(|event| memory_ids.contains(&event.memory_id))
            .collect::<Vec<_>>();
        let links = self
            .list_links(None)
            .map_err(StorageError::Memory)?
            .into_iter()
            .filter(|link| {
                memory_ids.contains(&link.from_memory_id) || memory_ids.contains(&link.to_memory_id)
            })
            .collect::<Vec<_>>();
        Ok(MemoryExportBundle {
            schema_version: 1,
            items,
            events,
            links,
        })
    }

    pub fn import_bundle(
        &mut self,
        bundle: &MemoryExportBundle,
    ) -> Result<MemoryImportReport, StorageError> {
        for item in &bundle.items {
            self.upsert_item(item.clone())
                .map_err(StorageError::Memory)?;
        }
        for event in &bundle.events {
            self.upsert_event(event.clone())?;
        }
        for link in &bundle.links {
            self.upsert_link(link.clone())
                .map_err(StorageError::Memory)?;
        }
        Ok(MemoryImportReport {
            imported_items: bundle.items.len(),
            imported_events: bundle.events.len(),
            imported_links: bundle.links.len(),
        })
    }

    pub fn doctor(&self) -> Result<MemoryDoctorReport, StorageError> {
        let global_items = self.all_items_for(DatabaseKind::Global)?;
        let workspace_items = self.all_items_for(DatabaseKind::Workspace)?;
        let global_events = self.all_events_for(DatabaseKind::Global)?;
        let workspace_events = self.all_events_for(DatabaseKind::Workspace)?;
        let global_links = self.all_links_for(DatabaseKind::Global)?;
        let workspace_links = self.all_links_for(DatabaseKind::Workspace)?;

        let mut seen_ids = BTreeSet::new();
        let mut duplicate_item_ids = BTreeSet::new();
        for item in global_items.iter().chain(workspace_items.iter()) {
            if !seen_ids.insert(item.id.clone()) {
                duplicate_item_ids.insert(item.id.clone());
            }
        }

        let known_item_ids = global_items
            .iter()
            .chain(workspace_items.iter())
            .map(|item| item.id.clone())
            .collect::<BTreeSet<_>>();
        let orphan_event_ids = global_events
            .iter()
            .chain(workspace_events.iter())
            .filter(|event| !known_item_ids.contains(&event.memory_id))
            .map(|event| event.id.clone())
            .collect::<Vec<_>>();
        let orphan_link_ids = global_links
            .iter()
            .chain(workspace_links.iter())
            .filter(|link| {
                !known_item_ids.contains(&link.from_memory_id)
                    || !known_item_ids.contains(&link.to_memory_id)
            })
            .map(|link| link.id.clone())
            .collect::<Vec<_>>();
        let mut orphan_promoted_item_ids = global_items
            .iter()
            .chain(workspace_items.iter())
            .filter(|item| {
                item.promoted_from_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && !known_item_ids.contains(id))
            })
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        orphan_promoted_item_ids.sort();

        // Key: (kind, title, body, scope_type, scope_key, origin_pack, tags, packs)
        type DupKey = (String, String, String, String, String, String, Vec<String>, Vec<String>);
        let mut duplicate_promoted_groups: BTreeMap<DupKey, Vec<String>> = BTreeMap::new();
        for item in global_items.iter().chain(workspace_items.iter()) {
            let Some(promoted_from_id) = item.promoted_from_id.as_ref() else {
                continue;
            };
            if promoted_from_id.is_empty() || item.status != MemoryStatus::Active {
                continue;
            }
            duplicate_promoted_groups
                .entry(Self::promoted_duplicate_key(item, promoted_from_id))
                .or_default()
                .push(item.id.clone());
        }
        let duplicate_promoted_item_ids = duplicate_promoted_groups
            .into_values()
            .filter(|ids| ids.len() > 1)
            .flat_map(|mut ids| {
                ids.sort();
                ids
            })
            .collect::<Vec<_>>();

        let forgotten_item_count = global_items
            .iter()
            .chain(workspace_items.iter())
            .filter(|item| item.status == MemoryStatus::Forgotten)
            .count();

        Ok(MemoryDoctorReport {
            global_database: self.paths.global_database.clone(),
            workspace_database: self.paths.workspace_database.clone(),
            global_item_count: global_items.len(),
            workspace_item_count: workspace_items.len(),
            global_event_count: global_events.len(),
            workspace_event_count: workspace_events.len(),
            global_link_count: global_links.len(),
            workspace_link_count: workspace_links.len(),
            forgotten_item_count,
            duplicate_item_ids: duplicate_item_ids.into_iter().collect(),
            orphan_event_ids,
            orphan_link_ids,
            orphan_promoted_item_ids,
            duplicate_promoted_item_ids,
        })
    }

    pub fn prune_forgotten(&mut self) -> Result<MemoryPruneReport, StorageError> {
        let (global_items, global_events, global_links) =
            prune_forgotten_from_connection(&self.global_connection)?;
        let (workspace_items, workspace_events, workspace_links) =
            prune_forgotten_from_connection(&self.workspace_connection)?;
        Ok(MemoryPruneReport {
            removed_items: global_items + workspace_items,
            removed_events: global_events + workspace_events + global_links + workspace_links,
        })
    }

    fn upsert_event(&mut self, event: MemoryEvent) -> Result<(), StorageError> {
        match self.database_for_memory_id(&event.memory_id)? {
            Some(DatabaseKind::Global) => {
                upsert_event_on_connection(&self.global_connection, &event)?
            }
            Some(DatabaseKind::Workspace) => {
                upsert_event_on_connection(&self.workspace_connection, &event)?
            }
            None => return Err(StorageError::MissingMemoryForEvent(event.memory_id)),
        }
        Ok(())
    }

    fn all_items_for(&self, kind: DatabaseKind) -> Result<Vec<MemoryItem>, StorageError> {
        let connection = self.connection_for(kind);
        let mut statement = connection.prepare(
            "SELECT id, scope_type, scope_key, kind, title, body, tags_json, applicable_packs_json, source_type, source_ref, origin_pack, status, promoted_from_id, created_at, updated_at FROM memory_items",
        )?;
        let mut rows = statement.query([])?;
        let mut items = Vec::new();
        while let Some(row) = rows.next()? {
            items.push(map_item_row(row)?);
        }
        Ok(items)
    }

    fn all_events_for(&self, kind: DatabaseKind) -> Result<Vec<MemoryEvent>, StorageError> {
        let connection = self.connection_for(kind);
        let mut statement = connection.prepare(
            "SELECT id, memory_id, action, reason, created_at FROM memory_events ORDER BY created_at ASC, id ASC",
        )?;
        let mut rows = statement.query([])?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            events.push(map_event_row(row)?);
        }
        Ok(events)
    }

    fn all_links_for(&self, kind: DatabaseKind) -> Result<Vec<MemoryLink>, StorageError> {
        let connection = self.connection_for(kind);
        let mut statement = connection.prepare(
            "SELECT id, from_memory_id, to_memory_id, relation, created_at FROM memory_links ORDER BY created_at ASC, id ASC",
        )?;
        let mut rows = statement.query([])?;
        let mut links = Vec::new();
        while let Some(row) = rows.next()? {
            links.push(map_link_row(row)?);
        }
        Ok(links)
    }

    fn promoted_duplicate_key(
        item: &MemoryItem,
        promoted_from_id: &str,
    ) -> (String, String, String, String, String, String, Vec<String>, Vec<String>) {
        (
            promoted_from_id.to_string(),
            item.scope.to_string(),
            item.scope_key.clone(),
            item.kind.to_string(),
            item.title.clone(),
            item.body.clone(),
            Self::normalized_string_list(&item.tags),
            Self::normalized_string_list(&item.applicable_packs),
        )
    }

    fn normalized_string_list(values: &[String]) -> Vec<String> {
        let mut normalized = values.to_vec();
        normalized.sort();
        normalized.dedup();
        normalized
    }

    fn fts_match_ids_for(
        &self,
        kind: DatabaseKind,
        query: &str,
    ) -> Result<Option<BTreeSet<String>>, StorageError> {
        let connection = self.connection_for(kind);
        let mut statement =
            connection.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?1")?;
        let mut rows = statement.query(params![query])?;
        let mut ids = BTreeSet::new();
        while let Some(row) = rows.next()? {
            ids.insert(row.get::<_, String>(0)?);
        }
        Ok(Some(ids))
    }

    fn connection_for(&self, kind: DatabaseKind) -> &Connection {
        match kind {
            DatabaseKind::Global => &self.global_connection,
            DatabaseKind::Workspace => &self.workspace_connection,
        }
    }

    fn database_for_scope(scope: MemoryScope) -> DatabaseKind {
        match scope {
            MemoryScope::User | MemoryScope::Pack => DatabaseKind::Global,
            MemoryScope::Workspace | MemoryScope::Session => DatabaseKind::Workspace,
        }
    }

    fn database_for_memory_id(
        &self,
        memory_id: &str,
    ) -> Result<Option<DatabaseKind>, StorageError> {
        if exists_in_connection(&self.global_connection, memory_id)? {
            return Ok(Some(DatabaseKind::Global));
        }
        if exists_in_connection(&self.workspace_connection, memory_id)? {
            return Ok(Some(DatabaseKind::Workspace));
        }
        Ok(None)
    }
}

impl MemoryRepository for SqliteMemoryStore {
    fn upsert_item(&mut self, item: MemoryItem) -> MemoryResult<()> {
        let connection = match Self::database_for_scope(item.scope) {
            DatabaseKind::Global => &self.global_connection,
            DatabaseKind::Workspace => &self.workspace_connection,
        };
        let tags_json = serde_json::to_string(&item.tags)
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        let applicable_packs_json = serde_json::to_string(&item.applicable_packs)
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        let tags_text = item.tags.join(" ");
        connection
            .execute(
                "INSERT OR REPLACE INTO memory_items (
                    id, scope_type, scope_key, kind, title, body, tags_json,
                    applicable_packs_json, source_type, source_ref, origin_pack,
                    status, promoted_from_id, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    item.id,
                    item.scope.to_string(),
                    item.scope_key,
                    item.kind.to_string(),
                    item.title,
                    item.body,
                    tags_json,
                    applicable_packs_json,
                    item.source_type.to_string(),
                    item.source_ref.unwrap_or_default(),
                    item.origin_pack.unwrap_or_default(),
                    item.status.to_string(),
                    item.promoted_from_id.unwrap_or_default(),
                    item.created_at,
                    item.updated_at,
                ],
            )
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        connection
            .execute(
                "INSERT OR REPLACE INTO memory_fts (id, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
                params![item.id, item.title, item.body, tags_text],
            )
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        Ok(())
    }

    fn get_item(&self, id: &str) -> MemoryResult<Option<MemoryItem>> {
        match self.database_for_memory_id(id) {
            Ok(Some(kind)) => load_item_from_connection(self.connection_for(kind), id)
                .map_err(|err| MemoryError::Repository(err.to_string())),
            Ok(None) => Ok(None),
            Err(err) => Err(MemoryError::Repository(err.to_string())),
        }
    }

    fn list_items(&self, query: &MemoryQuery) -> MemoryResult<Vec<MemoryItem>> {
        let databases = match query.scope {
            Some(MemoryScope::User) | Some(MemoryScope::Pack) => vec![DatabaseKind::Global],
            Some(MemoryScope::Workspace) | Some(MemoryScope::Session) => {
                vec![DatabaseKind::Workspace]
            }
            None => vec![DatabaseKind::Global, DatabaseKind::Workspace],
        };

        let mut items = Vec::new();
        for database in databases {
            let mut database_items = self
                .all_items_for(database)
                .map_err(|err| MemoryError::Repository(err.to_string()))?;
            if let Some(search_text) = &query.search_text {
                let ids = self
                    .fts_match_ids_for(database, search_text)
                    .map_err(|err| MemoryError::Repository(err.to_string()))?;
                if let Some(ids) = ids {
                    database_items.retain(|item| ids.contains(&item.id));
                }
            }
            items.extend(database_items);
        }
        let mut filter_query = query.clone();
        filter_query.search_text = None;
        items.retain(|item| filter_query.matches(item));
        items.sort_by(|left, right| {
            left.scope
                .priority()
                .cmp(&right.scope.priority())
                .then_with(|| left.updated_at.cmp(&right.updated_at))
                .then_with(|| left.title.cmp(&right.title))
        });
        Ok(items)
    }

    fn append_event(&mut self, event: MemoryEvent) -> MemoryResult<()> {
        self.upsert_event(event)
            .map_err(|err| MemoryError::Repository(err.to_string()))
    }

    fn list_events(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryEvent>> {
        let mut events = match memory_id {
            Some(memory_id) => match self.database_for_memory_id(memory_id) {
                Ok(Some(kind)) => self
                    .all_events_for(kind)
                    .map_err(|err| MemoryError::Repository(err.to_string()))?,
                Ok(None) => Vec::new(),
                Err(err) => return Err(MemoryError::Repository(err.to_string())),
            },
            None => {
                let mut all = self
                    .all_events_for(DatabaseKind::Global)
                    .map_err(|err| MemoryError::Repository(err.to_string()))?;
                all.extend(
                    self.all_events_for(DatabaseKind::Workspace)
                        .map_err(|err| MemoryError::Repository(err.to_string()))?,
                );
                all
            }
        };
        if let Some(memory_id) = memory_id {
            events.retain(|event| event.memory_id == memory_id);
        }
        Ok(events)
    }

    fn upsert_link(&mut self, link: MemoryLink) -> MemoryResult<()> {
        let from_database = self
            .database_for_memory_id(&link.from_memory_id)
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        let Some(database) = from_database else {
            return Err(MemoryError::Repository(format!(
                "memory id '{}' does not exist for link source",
                link.from_memory_id
            )));
        };
        let connection = self.connection_for(database);
        connection
            .execute(
                "INSERT OR REPLACE INTO memory_links (id, from_memory_id, to_memory_id, relation, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    link.id,
                    link.from_memory_id,
                    link.to_memory_id,
                    link.relation.to_string(),
                    link.created_at,
                ],
            )
            .map_err(|err| MemoryError::Repository(err.to_string()))?;
        Ok(())
    }

    fn list_links(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryLink>> {
        let mut links = match memory_id {
            Some(memory_id) => match self.database_for_memory_id(memory_id) {
                Ok(Some(kind)) => self
                    .all_links_for(kind)
                    .map_err(|err| MemoryError::Repository(err.to_string()))?,
                Ok(None) => Vec::new(),
                Err(err) => return Err(MemoryError::Repository(err.to_string())),
            },
            None => {
                let mut all = self
                    .all_links_for(DatabaseKind::Global)
                    .map_err(|err| MemoryError::Repository(err.to_string()))?;
                all.extend(
                    self.all_links_for(DatabaseKind::Workspace)
                        .map_err(|err| MemoryError::Repository(err.to_string()))?,
                );
                all
            }
        };
        if let Some(memory_id) = memory_id {
            links.retain(|link| link.from_memory_id == memory_id || link.to_memory_id == memory_id);
        }
        Ok(links)
    }
}

pub fn default_global_root() -> Result<PathBuf, StorageError> {
    if let Some(value) = env::var_os("BUILDPLANE_HOME") {
        return Ok(PathBuf::from(value));
    }
    let Some(home) = env::var_os("HOME") else {
        return Err(StorageError::InvalidPath(
            "HOME is not set and BUILDPLANE_HOME was not provided".to_string(),
        ));
    };
    Ok(PathBuf::from(home).join(DEFAULT_BUILDPLANE_DIRNAME))
}

fn initialize_parent(path: &Path) -> Result<(), StorageError> {
    let Some(parent) = path.parent() else {
        return Err(StorageError::InvalidPath(format!(
            "{} has no parent directory",
            path.display()
        )));
    };
    fs::create_dir_all(parent)?;
    Ok(())
}

fn exists_in_connection(connection: &Connection, memory_id: &str) -> Result<bool, StorageError> {
    let mut statement = connection.prepare("SELECT 1 FROM memory_items WHERE id = ?1 LIMIT 1")?;
    let mut rows = statement.query(params![memory_id])?;
    Ok(rows.next()?.is_some())
}

fn load_item_from_connection(
    connection: &Connection,
    memory_id: &str,
) -> Result<Option<MemoryItem>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT id, scope_type, scope_key, kind, title, body, tags_json, applicable_packs_json, source_type, source_ref, origin_pack, status, promoted_from_id, created_at, updated_at FROM memory_items WHERE id = ?1",
    )?;
    let mut rows = statement.query(params![memory_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(map_item_row(row)?))
}

fn upsert_event_on_connection(
    connection: &Connection,
    event: &MemoryEvent,
) -> Result<(), StorageError> {
    connection.execute(
        "INSERT OR REPLACE INTO memory_events (id, memory_id, action, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            event.id,
            event.memory_id,
            event.action.to_string(),
            event.reason.clone().unwrap_or_default(),
            event.created_at,
        ],
    )?;
    Ok(())
}

fn prune_forgotten_from_connection(
    connection: &Connection,
) -> Result<(usize, usize, usize), StorageError> {
    let mut statement =
        connection.prepare("SELECT id FROM memory_items WHERE status = 'forgotten'")?;
    let mut rows = statement.query([])?;
    let mut forgotten_ids = Vec::new();
    while let Some(row) = rows.next()? {
        forgotten_ids.push(row.get::<_, String>(0)?);
    }

    let mut removed_events = 0usize;
    let mut removed_items = 0usize;
    let mut removed_links = 0usize;
    for memory_id in forgotten_ids {
        removed_events += connection.execute(
            "DELETE FROM memory_events WHERE memory_id = ?1",
            params![memory_id.clone()],
        )?;
        removed_links += connection.execute(
            "DELETE FROM memory_links WHERE from_memory_id = ?1 OR to_memory_id = ?1",
            params![memory_id.clone()],
        )?;
        connection.execute(
            "DELETE FROM memory_fts WHERE id = ?1",
            params![memory_id.clone()],
        )?;
        removed_items +=
            connection.execute("DELETE FROM memory_items WHERE id = ?1", params![memory_id])?;
    }
    Ok((removed_items, removed_events, removed_links))
}

fn map_item_row(row: &Row<'_>) -> Result<MemoryItem, StorageError> {
    let tags_json: String = row.get(6)?;
    let applicable_packs_json: String = row.get(7)?;
    let source_ref: String = row.get(9)?;
    let origin_pack: String = row.get(10)?;
    let promoted_from_id: String = row.get(12)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        scope: MemoryScope::from_str(&row.get::<_, String>(1)?)?,
        scope_key: row.get(2)?,
        kind: MemoryKind::from_str(&row.get::<_, String>(3)?)?,
        title: row.get(4)?,
        body: row.get(5)?,
        tags: serde_json::from_str(&tags_json)?,
        applicable_packs: serde_json::from_str(&applicable_packs_json)?,
        source_type: MemorySourceType::from_str(&row.get::<_, String>(8)?)?,
        source_ref: if source_ref.is_empty() {
            None
        } else {
            Some(source_ref)
        },
        origin_pack: if origin_pack.is_empty() {
            None
        } else {
            Some(origin_pack)
        },
        status: MemoryStatus::from_str(&row.get::<_, String>(11)?)?,
        promoted_from_id: if promoted_from_id.is_empty() {
            None
        } else {
            Some(promoted_from_id)
        },
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn map_event_row(row: &Row<'_>) -> Result<MemoryEvent, StorageError> {
    let reason: String = row.get(3)?;
    Ok(MemoryEvent {
        id: row.get(0)?,
        memory_id: row.get(1)?,
        action: MemoryEventAction::from_str(&row.get::<_, String>(2)?)?,
        reason: if reason.is_empty() {
            None
        } else {
            Some(reason)
        },
        created_at: row.get(4)?,
    })
}

fn map_link_row(row: &Row<'_>) -> Result<MemoryLink, StorageError> {
    Ok(MemoryLink {
        id: row.get(0)?,
        from_memory_id: row.get(1)?,
        to_memory_id: row.get(2)?,
        relation: MemoryLinkRelation::from_str(&row.get::<_, String>(3)?)?,
        created_at: row.get(4)?,
    })
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("failed to access sqlite storage: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("failed to access the filesystem: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to encode or decode json: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Memory(#[from] MemoryError),
    #[error("invalid storage path: {0}")]
    InvalidPath(String),
    #[error("memory id '{0}' does not exist in either database")]
    MissingMemoryForEvent(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_memory::{
        MemoryKind, MemoryLinkRelation, MemoryQuery, MemoryRepository, MemoryScope, MemoryService,
        MemorySourceType, MemoryStatus, PromoteMemoryInput, RememberMemoryInput,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "bp-storage-sqlite-test-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn storage_paths_split_global_and_workspace_databases() {
        let roots = StoragePaths::for_roots("/tmp/buildplane-home", "/tmp/buildplane-workspace");

        assert_eq!(
            roots.global_database,
            PathBuf::from("/tmp/buildplane-home/global.db")
        );
        assert_eq!(
            roots.workspace_database,
            PathBuf::from("/tmp/buildplane-workspace/.buildplane/workspace.db")
        );
        assert_eq!(
            roots.artifacts_dir,
            PathBuf::from("/tmp/buildplane-workspace/.buildplane/artifacts")
        );
        assert_eq!(
            roots.evidence_dir,
            PathBuf::from("/tmp/buildplane-workspace/.buildplane/evidence")
        );
    }

    #[test]
    fn sqlite_memory_store_routes_user_and_workspace_items_to_separate_databases() {
        let temp_root = unique_temp_root();
        let global_root = temp_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let workspace_root = temp_root.join("workspace");
        let store = SqliteMemoryStore::open_with_roots(&global_root, &workspace_root)
            .expect("sqlite store should initialize");
        let mut service = MemoryService::new(store);
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::User,
                scope_key: None,
                kind: MemoryKind::Preference,
                title: "prefers concise output".to_string(),
                body: "Keep answers concise".to_string(),
                tags: vec!["user".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("user memory should store");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some(workspace_root.display().to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("workspace memory should store");
        let store = service.into_repository();
        let report = store.doctor().expect("doctor should succeed");

        assert_eq!(report.global_item_count, 1);
        assert_eq!(report.workspace_item_count, 1);

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn doctor_reports_orphaned_promoted_rows() {
        let temp_root = unique_temp_root();
        let global_root = temp_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let workspace_root = temp_root.join("workspace");
        let mut store = SqliteMemoryStore::open_with_roots(&global_root, &workspace_root)
            .expect("sqlite store should initialize");
        store
            .import_bundle(&MemoryExportBundle {
                schema_version: 1,
                items: vec![MemoryItem {
                    id: "mem_promoted_orphan".to_string(),
                    scope: MemoryScope::Workspace,
                    scope_key: workspace_root.display().to_string(),
                    kind: MemoryKind::Workflow,
                    title: "review workflow".to_string(),
                    body: "Use implement then review".to_string(),
                    tags: vec!["workflow".to_string()],
                    applicable_packs: Vec::new(),
                    source_type: MemorySourceType::Promotion,
                    source_ref: None,
                    origin_pack: None,
                    status: MemoryStatus::Active,
                    promoted_from_id: Some("mem_missing_source".to_string()),
                    created_at: "1".to_string(),
                    updated_at: "1".to_string(),
                }],
                events: Vec::new(),
                links: Vec::new(),
            })
            .expect("import should succeed");

        let report = store.doctor().expect("doctor should succeed");

        assert_eq!(
            report.orphan_promoted_item_ids,
            vec!["mem_promoted_orphan".to_string()]
        );
        assert!(report.duplicate_promoted_item_ids.is_empty());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn doctor_reports_duplicate_promoted_copies() {
        let temp_root = unique_temp_root();
        let global_root = temp_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let workspace_root = temp_root.join("workspace");
        let store = SqliteMemoryStore::open_with_roots(&global_root, &workspace_root)
            .expect("sqlite store should initialize");
        let mut service = MemoryService::new(store);
        let original = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some(workspace_root.display().to_string()),
                kind: MemoryKind::Workflow,
                title: "review workflow".to_string(),
                body: "Use implement then review".to_string(),
                tags: vec!["workflow".to_string()],
                origin_pack: None,
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("original memory should store");
        let first = service
            .promote(PromoteMemoryInput {
                id: original.id.clone(),
                to_scope: MemoryScope::User,
                to_scope_key: None,
                reason: Some("reuse broadly".to_string()),
                kind: None,
                title: None,
                applicable_packs: None,
            })
            .expect("first promotion should succeed");
        let second = service
            .promote(PromoteMemoryInput {
                id: original.id.clone(),
                to_scope: MemoryScope::User,
                to_scope_key: None,
                reason: Some("reuse broadly".to_string()),
                kind: None,
                title: None,
                applicable_packs: None,
            })
            .expect("second promotion should succeed");
        let store = service.into_repository();

        let report = store.doctor().expect("doctor should succeed");

        assert_eq!(report.duplicate_promoted_item_ids.len(), 2);
        assert!(report.duplicate_promoted_item_ids.contains(&first.id));
        assert!(report.duplicate_promoted_item_ids.contains(&second.id));
        assert!(!report.duplicate_promoted_item_ids.contains(&original.id));
        assert!(report.orphan_promoted_item_ids.is_empty());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn doctor_ignores_forgotten_promoted_rows_for_duplicate_noise() {
        let temp_root = unique_temp_root();
        let global_root = temp_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let workspace_root = temp_root.join("workspace");
        let store = SqliteMemoryStore::open_with_roots(&global_root, &workspace_root)
            .expect("sqlite store should initialize");
        let mut service = MemoryService::new(store);
        let original = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some(workspace_root.display().to_string()),
                kind: MemoryKind::Workflow,
                title: "review workflow".to_string(),
                body: "Use implement then review".to_string(),
                tags: vec!["workflow".to_string()],
                origin_pack: None,
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("original memory should store");
        let first = service
            .promote(PromoteMemoryInput {
                id: original.id.clone(),
                to_scope: MemoryScope::User,
                to_scope_key: None,
                reason: Some("reuse broadly".to_string()),
                kind: None,
                title: None,
                applicable_packs: None,
            })
            .expect("first promotion should succeed");
        let second = service
            .promote(PromoteMemoryInput {
                id: original.id.clone(),
                to_scope: MemoryScope::User,
                to_scope_key: None,
                reason: Some("reuse broadly".to_string()),
                kind: None,
                title: None,
                applicable_packs: None,
            })
            .expect("second promotion should succeed");
        service
            .forget(&second.id, Some("cleanup duplicate".to_string()))
            .expect("forgotten duplicate should succeed");
        let store = service.into_repository();

        let report = store.doctor().expect("doctor should succeed");

        assert!(report.duplicate_promoted_item_ids.is_empty());
        assert!(!report.orphan_promoted_item_ids.contains(&first.id));
        assert!(!report.orphan_promoted_item_ids.contains(&second.id));

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn export_import_and_prune_round_trip_memory() {
        let source_root = unique_temp_root();
        let source_global_root = source_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let source_workspace_root = source_root.join("workspace");
        let store = SqliteMemoryStore::open_with_roots(&source_global_root, &source_workspace_root)
            .expect("source store should initialize");
        let mut service = MemoryService::new(store);
        let user_item = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::User,
                scope_key: None,
                kind: MemoryKind::Preference,
                title: "prefers concise output".to_string(),
                body: "Keep answers concise".to_string(),
                tags: vec!["user".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("user memory should store");
        let forgotten_item = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some(source_workspace_root.display().to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("workspace memory should store");
        service
            .link_items(
                &user_item.id,
                &forgotten_item.id,
                MemoryLinkRelation::Supports,
            )
            .expect("link should be created");
        service
            .forget(&forgotten_item.id, Some("no longer needed".to_string()))
            .expect("memory should be forgotten");
        let source_store = service.into_repository();

        let export = source_store
            .export_bundle(&MemoryQuery {
                include_forgotten: true,
                ..MemoryQuery::default()
            })
            .expect("export should succeed");
        assert_eq!(export.items.len(), 2);
        assert_eq!(export.links.len(), 1);

        let target_root = unique_temp_root();
        let target_global_root = target_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let target_workspace_root = target_root.join("workspace");
        let mut target_store =
            SqliteMemoryStore::open_with_roots(&target_global_root, &target_workspace_root)
                .expect("target store should initialize");
        let import_report = target_store
            .import_bundle(&export)
            .expect("import should succeed");
        let doctor = target_store.doctor().expect("doctor should succeed");
        let prune_report = target_store
            .prune_forgotten()
            .expect("prune should succeed");
        let active_items = target_store
            .list_items(&MemoryQuery::default())
            .expect("active items should list");
        let links = target_store
            .list_links(None)
            .expect("links should round-trip through import");

        assert_eq!(import_report.imported_items, 2);
        assert_eq!(import_report.imported_links, 1);
        assert_eq!(doctor.forgotten_item_count, 1);
        assert_eq!(prune_report.removed_items, 1);
        assert_eq!(links.len(), 1);
        assert_eq!(active_items.len(), 1);
        assert_eq!(active_items[0].id, user_item.id);

        let _ = std::fs::remove_dir_all(&source_root);
        let _ = std::fs::remove_dir_all(&target_root);
    }

    #[test]
    fn sqlite_memory_store_uses_fts_for_prefix_search_and_persists_links() {
        let temp_root = unique_temp_root();
        let global_root = temp_root.join("home").join(DEFAULT_BUILDPLANE_DIRNAME);
        let workspace_root = temp_root.join("workspace");
        let store = SqliteMemoryStore::open_with_roots(&global_root, &workspace_root)
            .expect("store should initialize");
        let mut service = MemoryService::new(store);
        let workspace_item = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some(workspace_root.display().to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string(), "package-manager".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("workspace memory should store");
        let pack_item = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Pack,
                scope_key: Some("superclaude".to_string()),
                kind: MemoryKind::ProviderHeuristic,
                title: "structured planning prompts".to_string(),
                body: "Prefer explicit plan sections".to_string(),
                tags: vec!["claude".to_string()],
                origin_pack: Some("superclaude".to_string()),
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("pack memory should store");
        service
            .link_items(
                &workspace_item.id,
                &pack_item.id,
                MemoryLinkRelation::Supports,
            )
            .expect("link should store");
        let store = service.into_repository();

        let results = store
            .list_items(&MemoryQuery {
                search_text: Some("pnp*".to_string()),
                ..MemoryQuery::default()
            })
            .expect("fts search should succeed");
        let links = store
            .list_links(Some(&workspace_item.id))
            .expect("links should be queryable");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, workspace_item.id);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].to_memory_id, pack_item.id);

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
