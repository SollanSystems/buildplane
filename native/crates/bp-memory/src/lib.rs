use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const GLOBAL_USER_SCOPE_KEY: &str = "global";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryScope {
    User,
    Workspace,
    Pack,
    Session,
}

impl MemoryScope {
    pub fn default_scope_key(self) -> Option<&'static str> {
        match self {
            Self::User => Some(GLOBAL_USER_SCOPE_KEY),
            Self::Workspace | Self::Pack | Self::Session => None,
        }
    }

    pub fn priority(self) -> u8 {
        match self {
            Self::Session => 0,
            Self::Workspace => 1,
            Self::User => 2,
            Self::Pack => 3,
        }
    }
}

impl fmt::Display for MemoryScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::User => "user",
            Self::Workspace => "workspace",
            Self::Pack => "pack",
            Self::Session => "session",
        })
    }
}

impl FromStr for MemoryScope {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "workspace" => Ok(Self::Workspace),
            "pack" => Ok(Self::Pack),
            "session" => Ok(Self::Session),
            other => Err(MemoryError::InvalidEnumValue {
                field: "scope",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryKind {
    Preference,
    Constraint,
    Fact,
    Decision,
    Workflow,
    Environment,
    ProviderHeuristic,
    Alias,
}

impl fmt::Display for MemoryKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Preference => "preference",
            Self::Constraint => "constraint",
            Self::Fact => "fact",
            Self::Decision => "decision",
            Self::Workflow => "workflow",
            Self::Environment => "environment",
            Self::ProviderHeuristic => "provider-heuristic",
            Self::Alias => "alias",
        })
    }
}

impl FromStr for MemoryKind {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "preference" => Ok(Self::Preference),
            "constraint" => Ok(Self::Constraint),
            "fact" => Ok(Self::Fact),
            "decision" => Ok(Self::Decision),
            "workflow" => Ok(Self::Workflow),
            "environment" => Ok(Self::Environment),
            "provider-heuristic" => Ok(Self::ProviderHeuristic),
            "alias" => Ok(Self::Alias),
            other => Err(MemoryError::InvalidEnumValue {
                field: "kind",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryStatus {
    Active,
    Forgotten,
    Archived,
    Superseded,
}

impl fmt::Display for MemoryStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Active => "active",
            Self::Forgotten => "forgotten",
            Self::Archived => "archived",
            Self::Superseded => "superseded",
        })
    }
}

impl FromStr for MemoryStatus {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "forgotten" => Ok(Self::Forgotten),
            "archived" => Ok(Self::Archived),
            "superseded" => Ok(Self::Superseded),
            other => Err(MemoryError::InvalidEnumValue {
                field: "status",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemorySourceType {
    User,
    Agent,
    Tool,
    Import,
    Promotion,
}

impl fmt::Display for MemorySourceType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::Tool => "tool",
            Self::Import => "import",
            Self::Promotion => "promotion",
        })
    }
}

impl FromStr for MemorySourceType {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            "tool" => Ok(Self::Tool),
            "import" => Ok(Self::Import),
            "promotion" => Ok(Self::Promotion),
            other => Err(MemoryError::InvalidEnumValue {
                field: "source_type",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryEventAction {
    Created,
    Updated,
    Used,
    Promoted,
    Forgotten,
    Restored,
    Expired,
    Merged,
}

impl fmt::Display for MemoryEventAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Created => "create",
            Self::Updated => "update",
            Self::Used => "use",
            Self::Promoted => "promote",
            Self::Forgotten => "forget",
            Self::Restored => "restore",
            Self::Expired => "expire",
            Self::Merged => "merge",
        })
    }
}

impl FromStr for MemoryEventAction {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "create" => Ok(Self::Created),
            "update" => Ok(Self::Updated),
            "use" => Ok(Self::Used),
            "promote" => Ok(Self::Promoted),
            "forget" => Ok(Self::Forgotten),
            "restore" => Ok(Self::Restored),
            "expire" => Ok(Self::Expired),
            "merge" => Ok(Self::Merged),
            other => Err(MemoryError::InvalidEnumValue {
                field: "event_action",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryItem {
    pub id: String,
    pub scope: MemoryScope,
    pub scope_key: String,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub applicable_packs: Vec<String>,
    pub source_type: MemorySourceType,
    pub source_ref: Option<String>,
    pub origin_pack: Option<String>,
    pub status: MemoryStatus,
    pub promoted_from_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryEvent {
    pub id: String,
    pub memory_id: String,
    pub action: MemoryEventAction,
    pub reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryLinkRelation {
    DerivedFrom,
    PromotedFrom,
    Supports,
    Contradicts,
    DuplicateOf,
}

impl fmt::Display for MemoryLinkRelation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::DerivedFrom => "derived-from",
            Self::PromotedFrom => "promoted-from",
            Self::Supports => "supports",
            Self::Contradicts => "contradicts",
            Self::DuplicateOf => "duplicate-of",
        })
    }
}

impl FromStr for MemoryLinkRelation {
    type Err = MemoryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "derived-from" => Ok(Self::DerivedFrom),
            "promoted-from" => Ok(Self::PromotedFrom),
            "supports" => Ok(Self::Supports),
            "contradicts" => Ok(Self::Contradicts),
            "duplicate-of" => Ok(Self::DuplicateOf),
            other => Err(MemoryError::InvalidEnumValue {
                field: "link_relation",
                value: other.to_string(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryLink {
    pub id: String,
    pub from_memory_id: String,
    pub to_memory_id: String,
    pub relation: MemoryLinkRelation,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryQuery {
    pub scope: Option<MemoryScope>,
    pub scope_key: Option<String>,
    pub applicable_pack: Option<String>,
    pub search_text: Option<String>,
    pub include_forgotten: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveMemoryContext {
    pub workspace_scope_key: Option<String>,
    pub pack_scope_key: Option<String>,
    pub session_scope_key: Option<String>,
    pub include_forgotten: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectiveMemoryPolicy {
    pub include_user: bool,
    pub include_workspace: bool,
    pub include_pack: bool,
    pub include_session: bool,
}

impl Default for EffectiveMemoryPolicy {
    fn default() -> Self {
        Self {
            include_user: true,
            include_workspace: true,
            include_pack: true,
            include_session: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExplainedMemoryItem {
    pub item: MemoryItem,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RememberMemoryInput {
    pub scope: MemoryScope,
    pub scope_key: Option<String>,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub origin_pack: Option<String>,
    pub applicable_packs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromoteMemoryInput {
    pub id: String,
    pub to_scope: MemoryScope,
    pub to_scope_key: Option<String>,
    pub title: Option<String>,
    pub kind: Option<MemoryKind>,
    pub applicable_packs: Option<Vec<String>>,
    pub reason: Option<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum MemoryError {
    #[error("missing scope key for {scope} memory")]
    MissingScopeKey { scope: MemoryScope },
    #[error("memory item '{0}' was not found")]
    NotFound(String),
    #[error("invalid {field} value '{value}'")]
    InvalidEnumValue { field: &'static str, value: String },
    #[error("memory repository failure: {0}")]
    Repository(String),
}

pub type MemoryResult<T> = Result<T, MemoryError>;

pub trait MemoryRepository {
    fn upsert_item(&mut self, item: MemoryItem) -> MemoryResult<()>;
    fn get_item(&self, id: &str) -> MemoryResult<Option<MemoryItem>>;
    fn list_items(&self, query: &MemoryQuery) -> MemoryResult<Vec<MemoryItem>>;
    fn append_event(&mut self, event: MemoryEvent) -> MemoryResult<()>;
    fn list_events(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryEvent>>;
    fn upsert_link(&mut self, link: MemoryLink) -> MemoryResult<()>;
    fn list_links(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryLink>>;
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryMemoryRepository {
    items: BTreeMap<String, MemoryItem>,
    events: Vec<MemoryEvent>,
    links: Vec<MemoryLink>,
}

impl MemoryRepository for InMemoryMemoryRepository {
    fn upsert_item(&mut self, item: MemoryItem) -> MemoryResult<()> {
        self.items.insert(item.id.clone(), item);
        Ok(())
    }

    fn get_item(&self, id: &str) -> MemoryResult<Option<MemoryItem>> {
        Ok(self.items.get(id).cloned())
    }

    fn list_items(&self, query: &MemoryQuery) -> MemoryResult<Vec<MemoryItem>> {
        let mut items = self
            .items
            .values()
            .filter(|item| query.matches(item))
            .cloned()
            .collect::<Vec<_>>();
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
        self.events.push(event);
        Ok(())
    }

    fn list_events(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryEvent>> {
        Ok(self
            .events
            .iter()
            .filter(|event| memory_id.is_none_or(|id| event.memory_id == id))
            .cloned()
            .collect())
    }

    fn upsert_link(&mut self, link: MemoryLink) -> MemoryResult<()> {
        if let Some(existing) = self
            .links
            .iter_mut()
            .find(|candidate| candidate.id == link.id)
        {
            *existing = link;
        } else {
            self.links.push(link);
        }
        Ok(())
    }

    fn list_links(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryLink>> {
        Ok(self
            .links
            .iter()
            .filter(|link| {
                memory_id.is_none_or(|id| link.from_memory_id == id || link.to_memory_id == id)
            })
            .cloned()
            .collect())
    }
}

impl MemoryQuery {
    pub fn matches(&self, item: &MemoryItem) -> bool {
        if !self.include_forgotten && item.status != MemoryStatus::Active {
            return false;
        }
        if let Some(scope) = self.scope {
            if item.scope != scope {
                return false;
            }
        }
        if let Some(scope_key) = &self.scope_key {
            if item.scope_key != *scope_key {
                return false;
            }
        }
        if let Some(pack) = &self.applicable_pack {
            let pack_applies = item.applicable_packs.is_empty()
                || item
                    .applicable_packs
                    .iter()
                    .any(|candidate| candidate == pack)
                || item
                    .origin_pack
                    .as_ref()
                    .is_some_and(|candidate| candidate == pack)
                || (item.scope == MemoryScope::Pack && item.scope_key == *pack);
            if !pack_applies {
                return false;
            }
        }
        if let Some(search_text) = &self.search_text {
            let needle = search_text.to_lowercase();
            let haystacks = [
                item.title.to_lowercase(),
                item.body.to_lowercase(),
                item.tags.join(" ").to_lowercase(),
            ];
            if !haystacks.iter().any(|haystack| haystack.contains(&needle)) {
                return false;
            }
        }
        true
    }
}

pub struct MemoryService<R> {
    repository: R,
}

impl<R> MemoryService<R>
where
    R: MemoryRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn into_repository(self) -> R {
        self.repository
    }

    pub fn remember(&mut self, input: RememberMemoryInput) -> MemoryResult<MemoryItem> {
        let scope_key = resolve_scope_key(input.scope, input.scope_key)?;
        let timestamp = now_timestamp();
        let item = MemoryItem {
            id: new_id("mem"),
            scope: input.scope,
            scope_key,
            kind: input.kind,
            title: input.title,
            body: input.body,
            tags: input.tags,
            applicable_packs: input.applicable_packs,
            source_type: MemorySourceType::User,
            source_ref: None,
            origin_pack: input.origin_pack,
            status: MemoryStatus::Active,
            promoted_from_id: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        self.repository.upsert_item(item.clone())?;
        self.repository.append_event(MemoryEvent {
            id: new_id("evt"),
            memory_id: item.id.clone(),
            action: MemoryEventAction::Created,
            reason: None,
            created_at: timestamp,
        })?;
        Ok(item)
    }

    pub fn inspect(&self, id: &str) -> MemoryResult<Option<MemoryItem>> {
        self.repository.get_item(id)
    }

    pub fn list(&self, query: &MemoryQuery) -> MemoryResult<Vec<MemoryItem>> {
        self.repository.list_items(query)
    }

    pub fn search(
        &self,
        search_text: &str,
        mut query: MemoryQuery,
    ) -> MemoryResult<Vec<MemoryItem>> {
        query.search_text = Some(search_text.to_string());
        self.repository.list_items(&query)
    }

    pub fn effective_memory(
        &self,
        context: &EffectiveMemoryContext,
    ) -> MemoryResult<Vec<MemoryItem>> {
        self.effective_memory_with_policy(context, EffectiveMemoryPolicy::default())
    }

    pub fn effective_memory_with_policy(
        &self,
        context: &EffectiveMemoryContext,
        policy: EffectiveMemoryPolicy,
    ) -> MemoryResult<Vec<MemoryItem>> {
        Ok(self
            .explain_effective_memory(context, policy)?
            .into_iter()
            .map(|entry| entry.item)
            .collect())
    }

    pub fn explain_effective_memory(
        &self,
        context: &EffectiveMemoryContext,
        policy: EffectiveMemoryPolicy,
    ) -> MemoryResult<Vec<ExplainedMemoryItem>> {
        let mut items = Vec::new();

        if policy.include_session {
            if let Some(session_scope_key) = &context.session_scope_key {
                items.extend(self.repository.list_items(&MemoryQuery {
                    scope: Some(MemoryScope::Session),
                    scope_key: Some(session_scope_key.clone()),
                    include_forgotten: context.include_forgotten,
                    ..MemoryQuery::default()
                })?);
            }
        }
        if policy.include_workspace {
            if let Some(workspace_scope_key) = &context.workspace_scope_key {
                items.extend(self.repository.list_items(&MemoryQuery {
                    scope: Some(MemoryScope::Workspace),
                    scope_key: Some(workspace_scope_key.clone()),
                    include_forgotten: context.include_forgotten,
                    ..MemoryQuery::default()
                })?);
            }
        }
        if policy.include_user {
            items.extend(self.repository.list_items(&MemoryQuery {
                scope: Some(MemoryScope::User),
                scope_key: Some(GLOBAL_USER_SCOPE_KEY.to_string()),
                include_forgotten: context.include_forgotten,
                ..MemoryQuery::default()
            })?);
        }
        if policy.include_pack {
            if let Some(pack_scope_key) = &context.pack_scope_key {
                items.extend(self.repository.list_items(&MemoryQuery {
                    scope: Some(MemoryScope::Pack),
                    scope_key: Some(pack_scope_key.clone()),
                    applicable_pack: Some(pack_scope_key.clone()),
                    include_forgotten: context.include_forgotten,
                    ..MemoryQuery::default()
                })?);
            }
        }

        items.sort_by(|left, right| {
            left.scope
                .priority()
                .cmp(&right.scope.priority())
                .then_with(|| left.updated_at.cmp(&right.updated_at))
                .then_with(|| left.title.cmp(&right.title))
        });
        Ok(items
            .into_iter()
            .map(|item| ExplainedMemoryItem {
                reason: reason_for_item(&item),
                item,
            })
            .collect())
    }

    pub fn forget(&mut self, id: &str, reason: Option<String>) -> MemoryResult<MemoryItem> {
        let mut item = self
            .repository
            .get_item(id)?
            .ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        item.status = MemoryStatus::Forgotten;
        item.updated_at = now_timestamp();
        self.repository.upsert_item(item.clone())?;
        self.repository.append_event(MemoryEvent {
            id: new_id("evt"),
            memory_id: item.id.clone(),
            action: MemoryEventAction::Forgotten,
            reason,
            created_at: now_timestamp(),
        })?;
        Ok(item)
    }

    pub fn restore(&mut self, id: &str, reason: Option<String>) -> MemoryResult<MemoryItem> {
        let mut item = self
            .repository
            .get_item(id)?
            .ok_or_else(|| MemoryError::NotFound(id.to_string()))?;
        item.status = MemoryStatus::Active;
        item.updated_at = now_timestamp();
        self.repository.upsert_item(item.clone())?;
        self.repository.append_event(MemoryEvent {
            id: new_id("evt"),
            memory_id: item.id.clone(),
            action: MemoryEventAction::Restored,
            reason,
            created_at: now_timestamp(),
        })?;
        Ok(item)
    }

    pub fn promote(&mut self, input: PromoteMemoryInput) -> MemoryResult<MemoryItem> {
        let original = self
            .repository
            .get_item(&input.id)?
            .ok_or_else(|| MemoryError::NotFound(input.id.clone()))?;
        let timestamp = now_timestamp();
        let promoted = MemoryItem {
            id: new_id("mem"),
            scope: input.to_scope,
            scope_key: resolve_scope_key(input.to_scope, input.to_scope_key)?,
            kind: input.kind.unwrap_or(original.kind),
            title: input.title.unwrap_or_else(|| original.title.clone()),
            body: original.body.clone(),
            tags: original.tags.clone(),
            applicable_packs: input
                .applicable_packs
                .unwrap_or_else(|| original.applicable_packs.clone()),
            source_type: MemorySourceType::Promotion,
            source_ref: None,
            origin_pack: original.origin_pack.clone(),
            status: MemoryStatus::Active,
            promoted_from_id: Some(original.id.clone()),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        self.repository.upsert_item(promoted.clone())?;
        self.repository.append_event(MemoryEvent {
            id: new_id("evt"),
            memory_id: original.id.clone(),
            action: MemoryEventAction::Promoted,
            reason: input.reason.clone(),
            created_at: timestamp.clone(),
        })?;
        self.repository.append_event(MemoryEvent {
            id: new_id("evt"),
            memory_id: promoted.id.clone(),
            action: MemoryEventAction::Created,
            reason: input.reason,
            created_at: timestamp,
        })?;
        Ok(promoted)
    }

    pub fn link_items(
        &mut self,
        from_memory_id: &str,
        to_memory_id: &str,
        relation: MemoryLinkRelation,
    ) -> MemoryResult<MemoryLink> {
        self.repository
            .get_item(from_memory_id)?
            .ok_or_else(|| MemoryError::NotFound(from_memory_id.to_string()))?;
        self.repository
            .get_item(to_memory_id)?
            .ok_or_else(|| MemoryError::NotFound(to_memory_id.to_string()))?;

        let link = MemoryLink {
            id: new_id("lnk"),
            from_memory_id: from_memory_id.to_string(),
            to_memory_id: to_memory_id.to_string(),
            relation,
            created_at: now_timestamp(),
        };
        self.repository.upsert_link(link.clone())?;
        Ok(link)
    }

    pub fn links(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryLink>> {
        self.repository.list_links(memory_id)
    }

    pub fn events(&self, memory_id: Option<&str>) -> MemoryResult<Vec<MemoryEvent>> {
        self.repository.list_events(memory_id)
    }
}

fn reason_for_item(item: &MemoryItem) -> String {
    match item.scope {
        MemoryScope::Session => "session scope matched active session".to_string(),
        MemoryScope::Workspace => "workspace scope matched active workspace".to_string(),
        MemoryScope::User => "user scope is shared for all packs".to_string(),
        MemoryScope::Pack => {
            let pack_id = item
                .origin_pack
                .as_deref()
                .unwrap_or(item.scope_key.as_str());
            format!("pack scope matched active pack '{pack_id}'")
        }
    }
}

fn resolve_scope_key(scope: MemoryScope, provided: Option<String>) -> MemoryResult<String> {
    match (scope.default_scope_key(), provided) {
        (Some(default_key), None) => Ok(default_key.to_string()),
        (_, Some(scope_key)) => Ok(scope_key),
        (None, None) => Err(MemoryError::MissingScopeKey { scope }),
    }
}

fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}_{nanos}_{}", std::process::id())
}

fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_orders_effective_memory_by_scope_priority() {
        let mut service = MemoryService::new(InMemoryMemoryRepository::default());
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::User,
                scope_key: None,
                kind: MemoryKind::Preference,
                title: "prefers deep mode".to_string(),
                body: "Use deep mode for planning work".to_string(),
                tags: vec!["planning".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("user memory should be remembered");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some("/tmp/buildplane".to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("workspace memory should be remembered");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Pack,
                scope_key: Some("superclaude".to_string()),
                kind: MemoryKind::ProviderHeuristic,
                title: "structured planning prompts".to_string(),
                body: "Prefer Goal/Constraints/Plan sections".to_string(),
                tags: vec!["claude".to_string()],
                origin_pack: Some("superclaude".to_string()),
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("pack memory should be remembered");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Session,
                scope_key: Some("sess-123".to_string()),
                kind: MemoryKind::Decision,
                title: "approved native memory slice".to_string(),
                body: "Operator approved scaffolding for the memory vertical slice".to_string(),
                tags: vec!["session".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("session memory should be remembered");

        let visible = service
            .effective_memory(&EffectiveMemoryContext {
                workspace_scope_key: Some("/tmp/buildplane".to_string()),
                pack_scope_key: Some("superclaude".to_string()),
                session_scope_key: Some("sess-123".to_string()),
                include_forgotten: false,
            })
            .expect("effective memory should load");

        let titles = visible
            .into_iter()
            .map(|item| item.title)
            .collect::<Vec<_>>();
        assert_eq!(
            titles,
            vec![
                "approved native memory slice".to_string(),
                "repo uses pnpm".to_string(),
                "prefers deep mode".to_string(),
                "structured planning prompts".to_string(),
            ]
        );
    }

    #[test]
    fn forgetting_and_promoting_memory_records_audit_events() {
        let mut service = MemoryService::new(InMemoryMemoryRepository::default());
        let remembered = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Pack,
                scope_key: Some("superclaude".to_string()),
                kind: MemoryKind::ProviderHeuristic,
                title: "claude planning sections".to_string(),
                body: "Prefer explicit plan sections".to_string(),
                tags: vec!["claude".to_string(), "planning".to_string()],
                origin_pack: Some("superclaude".to_string()),
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("memory should be created");

        let promoted = service
            .promote(PromoteMemoryInput {
                id: remembered.id.clone(),
                to_scope: MemoryScope::User,
                to_scope_key: None,
                title: Some("prefers structured planning".to_string()),
                kind: Some(MemoryKind::Preference),
                applicable_packs: Some(Vec::new()),
                reason: Some("seen across packs".to_string()),
            })
            .expect("memory should promote");
        let forgotten = service
            .forget(
                &remembered.id,
                Some("superseded by shared preference".to_string()),
            )
            .expect("memory should be forgotten");
        let events = service
            .events(Some(&remembered.id))
            .expect("events should be readable");

        assert_eq!(promoted.promoted_from_id, Some(remembered.id.clone()));
        assert_eq!(forgotten.status, MemoryStatus::Forgotten);
        assert_eq!(
            events.iter().map(|event| event.action).collect::<Vec<_>>(),
            vec![
                MemoryEventAction::Created,
                MemoryEventAction::Promoted,
                MemoryEventAction::Forgotten,
            ]
        );
    }

    #[test]
    fn restore_reactivates_forgotten_memory_and_records_restore_event() {
        let mut service = MemoryService::new(InMemoryMemoryRepository::default());
        let remembered = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some("/tmp/buildplane".to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("memory should be created");
        service
            .forget(&remembered.id, Some("temporary cleanup".to_string()))
            .expect("memory should be forgotten first");

        let restored = service
            .restore(&remembered.id, Some("still valid".to_string()))
            .expect("memory should be restorable");
        let events = service
            .events(Some(&remembered.id))
            .expect("events should be readable");

        assert_eq!(restored.status, MemoryStatus::Active);
        assert_eq!(
            events.iter().map(|event| event.action).collect::<Vec<_>>(),
            vec![
                MemoryEventAction::Created,
                MemoryEventAction::Forgotten,
                MemoryEventAction::Restored,
            ]
        );
    }

    #[test]
    fn effective_memory_respects_policy_flags() {
        let mut service = MemoryService::new(InMemoryMemoryRepository::default());
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
            .expect("user memory should be remembered");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some("/tmp/buildplane".to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("workspace memory should be remembered");
        service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Pack,
                scope_key: Some("superclaude".to_string()),
                kind: MemoryKind::ProviderHeuristic,
                title: "structured planning prompts".to_string(),
                body: "Prefer explicit sections".to_string(),
                tags: vec!["pack".to_string()],
                origin_pack: Some("superclaude".to_string()),
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("pack memory should be remembered");

        let visible = service
            .effective_memory_with_policy(
                &EffectiveMemoryContext {
                    workspace_scope_key: Some("/tmp/buildplane".to_string()),
                    pack_scope_key: Some("superclaude".to_string()),
                    session_scope_key: None,
                    include_forgotten: false,
                },
                EffectiveMemoryPolicy {
                    include_user: true,
                    include_workspace: true,
                    include_pack: false,
                    include_session: true,
                },
            )
            .expect("effective memory should apply policy flags");

        let titles = visible
            .into_iter()
            .map(|item| item.title)
            .collect::<Vec<_>>();
        assert_eq!(
            titles,
            vec![
                "repo uses pnpm".to_string(),
                "prefers concise output".to_string(),
            ]
        );
    }

    #[test]
    fn linking_items_records_relations_for_explanation_and_export() {
        let mut service = MemoryService::new(InMemoryMemoryRepository::default());
        let source = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Workspace,
                scope_key: Some("/tmp/buildplane".to_string()),
                kind: MemoryKind::Fact,
                title: "repo uses pnpm".to_string(),
                body: "Use pnpm from the repo root".to_string(),
                tags: vec!["workspace".to_string()],
                origin_pack: None,
                applicable_packs: Vec::new(),
            })
            .expect("source memory should exist");
        let target = service
            .remember(RememberMemoryInput {
                scope: MemoryScope::Pack,
                scope_key: Some("superclaude".to_string()),
                kind: MemoryKind::ProviderHeuristic,
                title: "structured planning prompts".to_string(),
                body: "Prefer explicit sections".to_string(),
                tags: vec!["pack".to_string()],
                origin_pack: Some("superclaude".to_string()),
                applicable_packs: vec!["superclaude".to_string()],
            })
            .expect("target memory should exist");

        let link = service
            .link_items(&source.id, &target.id, MemoryLinkRelation::Supports)
            .expect("link should be created");
        let links = service
            .links(Some(&source.id))
            .expect("links should be queryable");

        assert_eq!(link.relation, MemoryLinkRelation::Supports);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].from_memory_id, source.id);
        assert_eq!(links[0].to_memory_id, target.id);
    }
}
