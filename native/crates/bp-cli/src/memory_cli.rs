use bp_memory::{
    EffectiveMemoryContext, EffectiveMemoryPolicy, ExplainedMemoryItem, MemoryItem, MemoryKind,
    MemoryLinkRelation, MemoryQuery, MemoryScope, MemoryService, PromoteMemoryInput,
    RememberMemoryInput,
};
use bp_pack_loader::load_pack_from_native_root;
use bp_storage_sqlite::{
    MemoryDoctorReport, MemoryExportBundle, MemoryImportReport, MemoryPruneReport,
    SqliteMemoryStore,
};
use bp_ui_terminal::{
    render_links_section, render_memory_explanations, render_memory_item, render_memory_links,
    render_memory_list,
};
use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryCommand {
    Remember(RememberMemoryArgs),
    Inspect(InspectMemoryArgs),
    Explain(ExplainMemoryArgs),
    Search(SearchMemoryArgs),
    Forget(ForgetMemoryArgs),
    Restore(RestoreMemoryArgs),
    Promote(PromoteMemoryArgs),
    Export(ExportMemoryArgs),
    Import(ImportMemoryArgs),
    Doctor(DoctorMemoryArgs),
    Prune(PruneMemoryArgs),
    LinkAdd(LinkAddArgs),
    LinkList(LinkListArgs),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RememberMemoryArgs {
    pub workspace_root: PathBuf,
    pub body: String,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    pub title: Option<String>,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectMemoryArgs {
    pub native_root: PathBuf,
    pub workspace_root: PathBuf,
    pub id: Option<String>,
    pub scope: Option<MemoryScope>,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub effective: bool,
    pub include_forgotten: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplainMemoryArgs {
    pub native_root: PathBuf,
    pub workspace_root: PathBuf,
    pub id: Option<String>,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub effective: bool,
    pub include_forgotten: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMemoryArgs {
    pub workspace_root: PathBuf,
    pub query: String,
    pub scope: Option<MemoryScope>,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub include_forgotten: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetMemoryArgs {
    pub workspace_root: PathBuf,
    pub id: String,
    pub reason: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreMemoryArgs {
    pub workspace_root: PathBuf,
    pub id: String,
    pub reason: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromoteMemoryArgs {
    pub workspace_root: PathBuf,
    pub id: String,
    pub to_scope: MemoryScope,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub reason: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportMemoryArgs {
    pub workspace_root: PathBuf,
    pub output_path: PathBuf,
    pub scope: Option<MemoryScope>,
    pub pack_id: Option<String>,
    pub session_id: Option<String>,
    pub include_forgotten: bool,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportMemoryArgs {
    pub workspace_root: PathBuf,
    pub input_path: PathBuf,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorMemoryArgs {
    pub workspace_root: PathBuf,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneMemoryArgs {
    pub workspace_root: PathBuf,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkAddArgs {
    pub workspace_root: PathBuf,
    pub from_id: String,
    pub to_id: String,
    pub relation: MemoryLinkRelation,
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkListArgs {
    pub workspace_root: PathBuf,
    pub memory_id: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ExecutionOverrides {
    global_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct MemoryExportReport {
    output_path: PathBuf,
    exported_items: usize,
    exported_events: usize,
}

pub fn parse_memory_command<I, T>(
    iter: I,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let mut args = iter
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>()
        .into_iter();
    let Some(action) = args.next() else {
        return Err(
            "missing memory action; expected one of remember, inspect, explain, search, forget, restore, promote, export, import, doctor, prune, link"
                .to_string(),
        );
    };
    let action = parse_string(action, "memory action")?;

    match action.as_str() {
        "remember" => parse_remember(args, default_workspace_root),
        "inspect" => parse_inspect(args, default_workspace_root),
        "explain" => parse_explain(args, default_workspace_root),
        "search" => parse_search(args, default_workspace_root),
        "forget" => parse_forget(args, default_workspace_root),
        "restore" => parse_restore(args, default_workspace_root),
        "promote" => parse_promote(args, default_workspace_root),
        "export" => parse_export(args, default_workspace_root),
        "import" => parse_import(args, default_workspace_root),
        "doctor" => parse_doctor(args, default_workspace_root),
        "prune" => parse_prune(args, default_workspace_root),
        "link" => parse_link(args, default_workspace_root),
        other => Err(format!("unknown memory action '{other}'")),
    }
}

pub fn run_memory_command(command: MemoryCommand) -> Result<(), String> {
    let rendered = execute_memory_command(command, ExecutionOverrides::default())?;
    println!("{rendered}");
    Ok(())
}

fn execute_memory_command(
    command: MemoryCommand,
    overrides: ExecutionOverrides,
) -> Result<String, String> {
    match command {
        MemoryCommand::Remember(args) => run_remember(args, &overrides),
        MemoryCommand::Inspect(args) => run_inspect(args, &overrides),
        MemoryCommand::Explain(args) => run_explain(args, &overrides),
        MemoryCommand::Search(args) => run_search(args, &overrides),
        MemoryCommand::Forget(args) => run_forget(args, &overrides),
        MemoryCommand::Restore(args) => run_restore(args, &overrides),
        MemoryCommand::Promote(args) => run_promote(args, &overrides),
        MemoryCommand::Export(args) => run_export(args, &overrides),
        MemoryCommand::Import(args) => run_import(args, &overrides),
        MemoryCommand::Doctor(args) => run_doctor(args, &overrides),
        MemoryCommand::Prune(args) => run_prune(args, &overrides),
        MemoryCommand::LinkAdd(args) => run_link_add(args, &overrides),
        MemoryCommand::LinkList(args) => run_link_list(args, &overrides),
    }
}

fn parse_remember(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let body = parse_string(
        args.next().ok_or_else(|| {
            "missing body; expected `buildplane-native memory remember <text>`".to_string()
        })?,
        "memory body",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut scope = MemoryScope::User;
    let mut kind = MemoryKind::Fact;
    let mut title = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?);
            }
            "--scope" => scope = parse_scope(&next_value(&mut args, "--scope")?)?,
            "--kind" => kind = parse_kind(&next_value(&mut args, "--kind")?)?,
            "--title" => {
                title = Some(parse_string(next_value(&mut args, "--title")?, "title")?);
            }
            "--pack" => {
                pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?);
            }
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?);
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Remember(RememberMemoryArgs {
        workspace_root,
        body,
        scope,
        kind,
        title,
        pack_id,
        session_id,
        json,
    }))
}

fn parse_inspect(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut native_root = default_native_root_for_workspace(&workspace_root);
    let mut id = None;
    let mut scope = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut effective = false;
    let mut include_forgotten = false;
    let mut json = false;

    while let Some(value) = args.next() {
        let value = parse_string(value, "inspect argument")?;
        if !value.starts_with("--") && id.is_none() {
            id = Some(value);
            continue;
        }
        match value.as_str() {
            "--native-root" => native_root = PathBuf::from(next_value(&mut args, "--native-root")?),
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?);
                native_root = default_native_root_for_workspace(&workspace_root);
            }
            "--scope" => scope = Some(parse_scope(&next_value(&mut args, "--scope")?)?),
            "--pack" => pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?),
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?)
            }
            "--effective" => effective = true,
            "--include-forgotten" => include_forgotten = true,
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Inspect(InspectMemoryArgs {
        native_root,
        workspace_root,
        id,
        scope,
        pack_id,
        session_id,
        effective,
        include_forgotten,
        json,
    }))
}

fn parse_explain(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut native_root = default_native_root_for_workspace(&workspace_root);
    let mut id = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut effective = false;
    let mut include_forgotten = false;
    let mut json = false;

    while let Some(value) = args.next() {
        let value = parse_string(value, "explain argument")?;
        if !value.starts_with("--") && id.is_none() {
            id = Some(value);
            continue;
        }
        match value.as_str() {
            "--native-root" => native_root = PathBuf::from(next_value(&mut args, "--native-root")?),
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?);
                native_root = default_native_root_for_workspace(&workspace_root);
            }
            "--pack" => pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?),
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?)
            }
            "--effective" => effective = true,
            "--include-forgotten" => include_forgotten = true,
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Explain(ExplainMemoryArgs {
        native_root,
        workspace_root,
        id,
        pack_id,
        session_id,
        effective,
        include_forgotten,
        json,
    }))
}

fn parse_search(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let query = parse_string(
        args.next().ok_or_else(|| {
            "missing query; expected `buildplane-native memory search <text>`".to_string()
        })?,
        "search query",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut scope = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut include_forgotten = false;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--scope" => scope = Some(parse_scope(&next_value(&mut args, "--scope")?)?),
            "--pack" => pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?),
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?)
            }
            "--include-forgotten" => include_forgotten = true,
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Search(SearchMemoryArgs {
        workspace_root,
        query,
        scope,
        pack_id,
        session_id,
        include_forgotten,
        json,
    }))
}

fn parse_forget(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let id = parse_string(
        args.next().ok_or_else(|| {
            "missing memory id; expected `buildplane-native memory forget <id>`".to_string()
        })?,
        "memory id",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut reason = None;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--reason" => {
                reason = Some(parse_string(next_value(&mut args, "--reason")?, "reason")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Forget(ForgetMemoryArgs {
        workspace_root,
        id,
        reason,
        json,
    }))
}

fn parse_restore(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let id = parse_string(
        args.next().ok_or_else(|| {
            "missing memory id; expected `buildplane-native memory restore <id>`".to_string()
        })?,
        "memory id",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut reason = None;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--reason" => {
                reason = Some(parse_string(next_value(&mut args, "--reason")?, "reason")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Restore(RestoreMemoryArgs {
        workspace_root,
        id,
        reason,
        json,
    }))
}

fn parse_promote(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let id = parse_string(
        args.next().ok_or_else(|| {
            "missing memory id; expected `buildplane-native memory promote <id>`".to_string()
        })?,
        "memory id",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut to_scope = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut reason = None;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--to" => to_scope = Some(parse_scope(&next_value(&mut args, "--to")?)?),
            "--pack" => pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?),
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?)
            }
            "--reason" => {
                reason = Some(parse_string(next_value(&mut args, "--reason")?, "reason")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Promote(PromoteMemoryArgs {
        workspace_root,
        id,
        to_scope: to_scope.ok_or_else(|| "missing --to scope for memory promote".to_string())?,
        pack_id,
        session_id,
        reason,
        json,
    }))
}

fn parse_export(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut output_path = None;
    let mut scope = None;
    let mut pack_id = None;
    let mut session_id = None;
    let mut include_forgotten = false;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--out" => output_path = Some(PathBuf::from(next_value(&mut args, "--out")?)),
            "--scope" => scope = Some(parse_scope(&next_value(&mut args, "--scope")?)?),
            "--pack" => pack_id = Some(parse_string(next_value(&mut args, "--pack")?, "pack")?),
            "--session" => {
                session_id = Some(parse_string(
                    next_value(&mut args, "--session")?,
                    "session",
                )?)
            }
            "--include-forgotten" => include_forgotten = true,
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Export(ExportMemoryArgs {
        workspace_root,
        output_path: output_path
            .ok_or_else(|| "missing --out path for memory export".to_string())?,
        scope,
        pack_id,
        session_id,
        include_forgotten,
        json,
    }))
}

fn parse_import(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let input_path = PathBuf::from(next_value(&mut args, "<path>").map_err(|_| {
        "missing import path; expected `buildplane-native memory import <path>`".to_string()
    })?);
    let mut workspace_root = default_workspace_root;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Import(ImportMemoryArgs {
        workspace_root,
        input_path,
        json,
    }))
}

fn parse_doctor(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Doctor(DoctorMemoryArgs {
        workspace_root,
        json,
    }))
}

fn parse_prune(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::Prune(PruneMemoryArgs {
        workspace_root,
        json,
    }))
}

fn parse_link(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let sub_action = parse_string(
        args.next().ok_or_else(|| {
            "missing link sub-action; expected `memory link add` or `memory link list`".to_string()
        })?,
        "link sub-action",
    )?;
    match sub_action.as_str() {
        "add" => parse_link_add(args, default_workspace_root),
        "list" => parse_link_list(args, default_workspace_root),
        other => Err(format!(
            "unknown link sub-action '{other}'; expected add or list"
        )),
    }
}

fn parse_link_add(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let from_id = parse_string(
        args.next().ok_or_else(|| {
            "missing from-id; expected `memory link add <from-id> <to-id> --relation <rel>`"
                .to_string()
        })?,
        "from-id",
    )?;
    let to_id = parse_string(
        args.next().ok_or_else(|| {
            "missing to-id; expected `memory link add <from-id> <to-id> --relation <rel>`"
                .to_string()
        })?,
        "to-id",
    )?;
    let mut workspace_root = default_workspace_root;
    let mut relation = None;
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--relation" => relation = Some(parse_relation(&next_value(&mut args, "--relation")?)?),
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::LinkAdd(LinkAddArgs {
        workspace_root,
        from_id,
        to_id,
        relation: relation.ok_or_else(|| "missing --relation for memory link add".to_string())?,
        json,
    }))
}

fn parse_link_list(
    mut args: std::vec::IntoIter<OsString>,
    default_workspace_root: PathBuf,
) -> Result<MemoryCommand, String> {
    let mut workspace_root = default_workspace_root;
    let mut memory_id = None;
    let mut json = false;

    while let Some(value) = args.next() {
        let value = parse_string(value, "link list argument")?;
        if !value.starts_with("--") && memory_id.is_none() {
            memory_id = Some(value);
            continue;
        }
        match value.as_str() {
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?)
            }
            "--json" => json = true,
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(MemoryCommand::LinkList(LinkListArgs {
        workspace_root,
        memory_id,
        json,
    }))
}

fn run_remember(
    args: RememberMemoryArgs,
    overrides: &ExecutionOverrides,
) -> Result<String, String> {
    let scope_key = scope_key_for(
        args.scope,
        &args.workspace_root,
        args.pack_id.as_deref(),
        args.session_id.as_deref(),
    )?;
    let title = args.title.clone().unwrap_or_else(|| args.body.clone());
    let applicable_packs = args.pack_id.iter().cloned().collect::<Vec<_>>();
    let mut service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let item = service
        .remember(RememberMemoryInput {
            scope: args.scope,
            scope_key,
            kind: args.kind,
            title,
            body: args.body,
            tags: Vec::new(),
            origin_pack: args.pack_id.clone(),
            applicable_packs,
        })
        .map_err(|err| err.to_string())?;
    Ok(render_output(&item, args.json, render_memory_item(&item)))
}

fn run_inspect(args: InspectMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    if args.effective {
        let items = service
            .effective_memory_with_policy(
                &EffectiveMemoryContext {
                    workspace_scope_key: Some(workspace_scope_key(&args.workspace_root)),
                    pack_scope_key: args.pack_id.clone(),
                    session_scope_key: args.session_id.clone(),
                    include_forgotten: args.include_forgotten,
                },
                effective_policy_for_pack(&args.native_root, args.pack_id.as_deref())?,
            )
            .map_err(|err| err.to_string())?;
        return Ok(render_output(&items, args.json, render_memory_list(&items)));
    }
    if let Some(id) = args.id.as_deref() {
        let item = service.inspect(id).map_err(|err| err.to_string())?;
        return match item {
            Some(item) => {
                let links = service.links(Some(id)).map_err(|err| err.to_string())?;
                let mut text = render_memory_item(&item);
                text.push_str(&render_links_section(&links));
                Ok(render_output(&item, args.json, text))
            }
            None => Err(format!("memory item '{id}' was not found")),
        };
    }

    let items = service
        .list(&MemoryQuery {
            scope: args.scope,
            scope_key: scope_key_for_optional(
                args.scope,
                &args.workspace_root,
                args.pack_id.as_deref(),
                args.session_id.as_deref(),
            )?,
            applicable_pack: args.pack_id.clone(),
            include_forgotten: args.include_forgotten,
            ..MemoryQuery::default()
        })
        .map_err(|err| err.to_string())?;
    Ok(render_output(&items, args.json, render_memory_list(&items)))
}

fn run_explain(args: ExplainMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    if args.effective {
        let items = service
            .explain_effective_memory(
                &EffectiveMemoryContext {
                    workspace_scope_key: Some(workspace_scope_key(&args.workspace_root)),
                    pack_scope_key: args.pack_id.clone(),
                    session_scope_key: args.session_id.clone(),
                    include_forgotten: args.include_forgotten,
                },
                effective_policy_for_pack(&args.native_root, args.pack_id.as_deref())?,
            )
            .map_err(|err| err.to_string())?;
        return Ok(render_output(
            &items,
            args.json,
            render_memory_explanations(&items),
        ));
    }

    let id = args
        .id
        .as_deref()
        .ok_or_else(|| "explain requires either a memory id or --effective".to_string())?;
    let item = service
        .inspect(id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("memory item '{id}' was not found"))?;
    let explained = explain_item(item);
    let links = service.links(Some(id)).map_err(|err| err.to_string())?;
    let mut text = render_memory_explanations(std::slice::from_ref(&explained));
    text.push_str(&render_links_section(&links));
    Ok(render_output(&explained, args.json, text))
}

fn run_search(args: SearchMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let items = service
        .search(
            &args.query,
            MemoryQuery {
                scope: args.scope,
                scope_key: scope_key_for_optional(
                    args.scope,
                    &args.workspace_root,
                    args.pack_id.as_deref(),
                    args.session_id.as_deref(),
                )?,
                applicable_pack: args.pack_id.clone(),
                include_forgotten: args.include_forgotten,
                ..MemoryQuery::default()
            },
        )
        .map_err(|err| err.to_string())?;
    Ok(render_output(&items, args.json, render_memory_list(&items)))
}

fn run_forget(args: ForgetMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let mut service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let item = service
        .forget(&args.id, args.reason)
        .map_err(|err| err.to_string())?;
    Ok(render_output(&item, args.json, render_memory_item(&item)))
}

fn run_restore(args: RestoreMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let mut service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let item = service
        .restore(&args.id, args.reason)
        .map_err(|err| err.to_string())?;
    Ok(render_output(&item, args.json, render_memory_item(&item)))
}

fn run_promote(args: PromoteMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let mut service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let item = service
        .promote(PromoteMemoryInput {
            id: args.id,
            to_scope: args.to_scope,
            to_scope_key: scope_key_for(
                args.to_scope,
                &args.workspace_root,
                args.pack_id.as_deref(),
                args.session_id.as_deref(),
            )?,
            title: None,
            kind: None,
            applicable_packs: None,
            reason: args.reason,
        })
        .map_err(|err| err.to_string())?;
    Ok(render_output(&item, args.json, render_memory_item(&item)))
}

fn run_export(args: ExportMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let store = open_store(&args.workspace_root, overrides)?;
    let bundle = store
        .export_bundle(&MemoryQuery {
            scope: args.scope,
            scope_key: scope_key_for_optional(
                args.scope,
                &args.workspace_root,
                args.pack_id.as_deref(),
                args.session_id.as_deref(),
            )?,
            applicable_pack: args.pack_id.clone(),
            include_forgotten: args.include_forgotten,
            ..MemoryQuery::default()
        })
        .map_err(|err| err.to_string())?;
    if let Some(parent) = args.output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        &args.output_path,
        serde_json::to_string_pretty(&bundle).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    let report = MemoryExportReport {
        output_path: args.output_path,
        exported_items: bundle.items.len(),
        exported_events: bundle.events.len(),
    };
    Ok(render_output(
        &report,
        args.json,
        render_export_report(&report),
    ))
}

fn run_import(args: ImportMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let bundle: MemoryExportBundle =
        serde_json::from_str(&fs::read_to_string(&args.input_path).map_err(|err| err.to_string())?)
            .map_err(|err| err.to_string())?;
    let mut store = open_store(&args.workspace_root, overrides)?;
    let report = store
        .import_bundle(&bundle)
        .map_err(|err| err.to_string())?;
    Ok(render_output(
        &report,
        args.json,
        render_import_report(&report),
    ))
}

fn run_doctor(args: DoctorMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let store = open_store(&args.workspace_root, overrides)?;
    let report = store.doctor().map_err(|err| err.to_string())?;
    Ok(render_output(
        &report,
        args.json,
        render_doctor_report(&report),
    ))
}

fn run_prune(args: PruneMemoryArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let mut store = open_store(&args.workspace_root, overrides)?;
    let report = store.prune_forgotten().map_err(|err| err.to_string())?;
    Ok(render_output(
        &report,
        args.json,
        render_prune_report(&report),
    ))
}

fn run_link_add(args: LinkAddArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let mut service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let link = service
        .link_items(&args.from_id, &args.to_id, args.relation)
        .map_err(|err| err.to_string())?;
    let text = format!(
        "Linked {} -> {} ({})",
        link.from_memory_id, link.to_memory_id, link.relation
    );
    Ok(render_output(&link, args.json, text))
}

fn run_link_list(args: LinkListArgs, overrides: &ExecutionOverrides) -> Result<String, String> {
    let service = MemoryService::new(open_store(&args.workspace_root, overrides)?);
    let links = service
        .links(args.memory_id.as_deref())
        .map_err(|err| err.to_string())?;
    Ok(render_output(
        &links,
        args.json,
        render_memory_links(&links),
    ))
}

fn open_store(
    workspace_root: &Path,
    overrides: &ExecutionOverrides,
) -> Result<SqliteMemoryStore, String> {
    match &overrides.global_root {
        Some(global_root) => SqliteMemoryStore::open_with_roots(global_root, workspace_root),
        None => SqliteMemoryStore::open_under_workspace(workspace_root),
    }
    .map_err(|err| err.to_string())
}

pub fn effective_policy_for_pack(
    native_root: &Path,
    pack_id: Option<&str>,
) -> Result<EffectiveMemoryPolicy, String> {
    let Some(pack_id) = pack_id else {
        return Ok(EffectiveMemoryPolicy::default());
    };
    let loaded = load_pack_from_native_root(native_root, pack_id).map_err(|err| err.to_string())?;
    Ok(EffectiveMemoryPolicy {
        include_user: loaded.manifest.memory.share_user,
        include_workspace: loaded.manifest.memory.share_workspace,
        include_pack: loaded.manifest.memory.share_pack,
        include_session: true,
    })
}

fn scope_key_for(
    scope: MemoryScope,
    workspace_root: &Path,
    pack_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    match scope {
        MemoryScope::User => Ok(None),
        MemoryScope::Workspace => Ok(Some(workspace_scope_key(workspace_root))),
        MemoryScope::Pack => pack_id
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| "pack-scoped memory requires --pack <id>".to_string()),
        MemoryScope::Session => session_id
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| "session-scoped memory requires --session <id>".to_string()),
    }
}

fn scope_key_for_optional(
    scope: Option<MemoryScope>,
    workspace_root: &Path,
    pack_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    match scope {
        Some(scope) => scope_key_for(scope, workspace_root, pack_id, session_id),
        None => Ok(None),
    }
}

fn explain_item(item: MemoryItem) -> ExplainedMemoryItem {
    let reason = match item.scope {
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
    };
    ExplainedMemoryItem { item, reason }
}

fn default_native_root_for_workspace(workspace_root: &Path) -> PathBuf {
    let nested = workspace_root.join("native");
    if nested.join("Cargo.toml").is_file() {
        nested
    } else {
        workspace_root.to_path_buf()
    }
}

fn workspace_scope_key(workspace_root: &Path) -> String {
    workspace_root.display().to_string()
}

fn parse_scope(value: &OsString) -> Result<MemoryScope, String> {
    let value = parse_string(value.clone(), "scope")?;
    value
        .parse()
        .map_err(|err: bp_memory::MemoryError| err.to_string())
}

fn parse_kind(value: &OsString) -> Result<MemoryKind, String> {
    let value = parse_string(value.clone(), "kind")?;
    value
        .parse()
        .map_err(|err: bp_memory::MemoryError| err.to_string())
}

fn parse_relation(value: &OsString) -> Result<MemoryLinkRelation, String> {
    let value = parse_string(value.clone(), "relation")?;
    value
        .parse()
        .map_err(|err: bp_memory::MemoryError| err.to_string())
}

fn parse_string(value: OsString, label: &str) -> Result<String, String> {
    value
        .into_string()
        .map_err(|_| format!("{label} must be valid UTF-8"))
}

fn next_value(args: &mut std::vec::IntoIter<OsString>, flag: &str) -> Result<OsString, String> {
    args.next()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn render_output<T>(value: &T, json: bool, text: String) -> String
where
    T: Serialize,
{
    if json {
        serde_json::to_string_pretty(value).expect("json serialization should succeed")
    } else {
        text
    }
}

fn render_export_report(report: &MemoryExportReport) -> String {
    format!(
        "Exported {} memory items and {} events to {}",
        report.exported_items,
        report.exported_events,
        report.output_path.display()
    )
}

fn render_import_report(report: &MemoryImportReport) -> String {
    format!(
        "Imported {} memory items, {} events, and {} links",
        report.imported_items, report.imported_events, report.imported_links
    )
}

fn render_doctor_report(report: &MemoryDoctorReport) -> String {
    format!(
        "Memory doctor\n- global database: {}\n- workspace database: {}\n- global items: {}\n- workspace items: {}\n- global events: {}\n- workspace events: {}\n- global links: {}\n- workspace links: {}\n- forgotten items: {}\n- duplicate item ids: {}\n- orphan event ids: {}\n- orphan link ids: {}",
        report.global_database.display(),
        report.workspace_database.display(),
        report.global_item_count,
        report.workspace_item_count,
        report.global_event_count,
        report.workspace_event_count,
        report.global_link_count,
        report.workspace_link_count,
        report.forgotten_item_count,
        if report.duplicate_item_ids.is_empty() {
            "none".to_string()
        } else {
            report.duplicate_item_ids.join(", ")
        },
        if report.orphan_event_ids.is_empty() {
            "none".to_string()
        } else {
            report.orphan_event_ids.join(", ")
        },
        if report.orphan_link_ids.is_empty() {
            "none".to_string()
        } else {
            report.orphan_link_ids.join(", ")
        }
    )
}

fn render_prune_report(report: &MemoryPruneReport) -> String {
    format!(
        "Pruned {} forgotten memory items and {} events",
        report.removed_items, report.removed_events
    )
}

pub fn memory_usage_text() -> &'static str {
    "Memory commands:
  buildplane-native memory remember <text> [--scope <user|workspace|pack|session>] [--kind <kind>] [--pack <id>] [--session <id>] [--workspace-root <path>] [--json]
  buildplane-native memory inspect [<memory-id>] [--scope <scope>] [--pack <id>] [--session <id>] [--effective] [--include-forgotten] [--native-root <path>] [--workspace-root <path>] [--json]
  buildplane-native memory explain [<memory-id>] [--pack <id>] [--session <id>] [--effective] [--include-forgotten] [--native-root <path>] [--workspace-root <path>] [--json]
  buildplane-native memory search <text> [--scope <scope>] [--pack <id>] [--session <id>] [--include-forgotten] [--workspace-root <path>] [--json]
  buildplane-native memory forget <memory-id> [--reason <text>] [--workspace-root <path>] [--json]
  buildplane-native memory restore <memory-id> [--reason <text>] [--workspace-root <path>] [--json]
  buildplane-native memory promote <memory-id> --to <user|workspace|pack|session> [--pack <id>] [--session <id>] [--reason <text>] [--workspace-root <path>] [--json]
  buildplane-native memory export --out <path> [--scope <scope>] [--pack <id>] [--session <id>] [--include-forgotten] [--workspace-root <path>] [--json]
  buildplane-native memory import <path> [--workspace-root <path>] [--json]
  buildplane-native memory doctor [--workspace-root <path>] [--json]
  buildplane-native memory prune [--workspace-root <path>] [--json]
  buildplane-native memory link add <from-id> <to-id> --relation <derived-from|promoted-from|supports|contradicts|duplicate-of> [--workspace-root <path>] [--json]
  buildplane-native memory link list [<memory-id>] [--workspace-root <path>] [--json]"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_root(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    fn write_pack_manifest(
        native_root: &Path,
        share_user: bool,
        share_workspace: bool,
        share_pack: bool,
    ) {
        let pack_root = native_root.join("packs").join("superclaude");
        fs::create_dir_all(&pack_root).expect("pack root should exist");
        fs::write(
            pack_root.join("pack.toml"),
            format!(
                "schema_version = 1\n\n[pack]\nid = \"superclaude\"\ndisplay_name = \"SuperClaude\"\nversion = \"0.1.0\"\n\n[memory]\nshare_user = {}\nshare_workspace = {}\nshare_pack = {}\n\n[[modes]]\nid = \"daily\"\ndisplay_name = \"Daily\"\nreasoning = \"fast\"\nautonomy = \"guided\"\ndefault = true\n",
                share_user, share_workspace, share_pack
            ),
        )
        .expect("manifest should be written");
    }

    #[test]
    fn remember_requires_pack_identifier_for_pack_scope() {
        let command = parse_memory_command(
            vec!["remember", "test", "--scope", "pack"],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("parse itself should succeed");
        match command {
            MemoryCommand::Remember(args) => {
                let result = scope_key_for(args.scope, &args.workspace_root, None, None);
                assert!(result.is_err());
            }
            other => panic!("expected remember args, got {other:?}"),
        }
    }

    #[test]
    fn parses_restore_command() {
        let command = parse_memory_command(
            vec!["restore", "mem_123", "--json"],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("restore command should parse");

        assert_eq!(
            command,
            MemoryCommand::Restore(RestoreMemoryArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                id: "mem_123".to_string(),
                reason: None,
                json: true,
            })
        );
    }

    #[test]
    fn parses_explain_effective_command() {
        let command = parse_memory_command(
            vec![
                "explain",
                "--effective",
                "--pack",
                "superclaude",
                "--native-root",
                "/tmp/buildplane/native",
            ],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("explain command should parse");

        assert_eq!(
            command,
            MemoryCommand::Explain(ExplainMemoryArgs {
                native_root: PathBuf::from("/tmp/buildplane/native"),
                workspace_root: PathBuf::from("/tmp/buildplane"),
                id: None,
                pack_id: Some("superclaude".to_string()),
                session_id: None,
                effective: true,
                include_forgotten: false,
                json: false,
            })
        );
    }

    #[test]
    fn loads_effective_policy_from_pack_manifest() {
        let native_root = unique_temp_root("bp-memory-policy");
        write_pack_manifest(&native_root, false, true, false);

        let policy = effective_policy_for_pack(&native_root, Some("superclaude"))
            .expect("policy should load from pack manifest");

        assert!(!policy.include_user);
        assert!(policy.include_workspace);
        assert!(!policy.include_pack);
        assert!(policy.include_session);

        let _ = fs::remove_dir_all(native_root);
    }

    #[test]
    fn cli_e2e_persists_then_explains_and_inspects_effective_memory() {
        let temp_root = unique_temp_root("bp-memory-e2e");
        let native_root = temp_root.join("native");
        let workspace_root = temp_root.join("workspace");
        let global_root = temp_root.join("home").join(".buildplane");
        fs::create_dir_all(&workspace_root).expect("workspace root should exist");
        write_pack_manifest(&native_root, true, true, true);

        execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Keep answers concise".to_string(),
                scope: MemoryScope::User,
                kind: MemoryKind::Preference,
                title: Some("prefers concise output".to_string()),
                pack_id: None,
                session_id: None,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("user remember should succeed");
        execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Use pnpm from the repo root".to_string(),
                scope: MemoryScope::Workspace,
                kind: MemoryKind::Fact,
                title: Some("repo uses pnpm".to_string()),
                pack_id: None,
                session_id: None,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("workspace remember should succeed");
        execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Prefer explicit plan sections".to_string(),
                scope: MemoryScope::Pack,
                kind: MemoryKind::ProviderHeuristic,
                title: Some("structured planning prompts".to_string()),
                pack_id: Some("superclaude".to_string()),
                session_id: None,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("pack remember should succeed");

        let inspect_output = execute_memory_command(
            MemoryCommand::Inspect(InspectMemoryArgs {
                native_root: native_root.clone(),
                workspace_root: workspace_root.clone(),
                id: None,
                scope: None,
                pack_id: Some("superclaude".to_string()),
                session_id: None,
                effective: true,
                include_forgotten: false,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("effective inspect should succeed");

        let explain_output = execute_memory_command(
            MemoryCommand::Explain(ExplainMemoryArgs {
                native_root: native_root.clone(),
                workspace_root: workspace_root.clone(),
                id: None,
                pack_id: Some("superclaude".to_string()),
                session_id: None,
                effective: true,
                include_forgotten: false,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("effective explain should succeed");

        assert!(inspect_output.contains("Memory items: 3"));
        assert!(inspect_output.contains("prefers concise output"));
        assert!(inspect_output.contains("repo uses pnpm"));
        assert!(inspect_output.contains("structured planning prompts"));
        assert!(explain_output.contains("because: user scope is shared for all packs"));
        assert!(explain_output.contains("because: workspace scope matched active workspace"));
        assert!(explain_output.contains("because: pack scope matched active pack 'superclaude'"));
        assert!(global_root.join("global.db").is_file());
        assert!(workspace_root
            .join(".buildplane")
            .join("workspace.db")
            .is_file());

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn export_import_doctor_and_prune_commands_work_end_to_end() {
        let temp_root = unique_temp_root("bp-memory-maint");
        let workspace_root = temp_root.join("workspace");
        let global_root = temp_root.join("home").join(".buildplane");
        fs::create_dir_all(&workspace_root).expect("workspace root should exist");
        let export_path = temp_root.join("export.json");

        execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Keep answers concise".to_string(),
                scope: MemoryScope::User,
                kind: MemoryKind::Preference,
                title: Some("prefers concise output".to_string()),
                pack_id: None,
                session_id: None,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("user remember should succeed");
        let forgotten = execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Use pnpm from the repo root".to_string(),
                scope: MemoryScope::Workspace,
                kind: MemoryKind::Fact,
                title: Some("repo uses pnpm".to_string()),
                pack_id: None,
                session_id: None,
                json: true,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("workspace remember should succeed");
        let forgotten_item: MemoryItem =
            serde_json::from_str(&forgotten).expect("remember json should parse");
        execute_memory_command(
            MemoryCommand::Forget(ForgetMemoryArgs {
                workspace_root: workspace_root.clone(),
                id: forgotten_item.id.clone(),
                reason: Some("cleanup".to_string()),
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("forget should succeed");

        let export_output = execute_memory_command(
            MemoryCommand::Export(ExportMemoryArgs {
                workspace_root: workspace_root.clone(),
                output_path: export_path.clone(),
                scope: None,
                pack_id: None,
                session_id: None,
                include_forgotten: true,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("export should succeed");
        let doctor_output = execute_memory_command(
            MemoryCommand::Doctor(DoctorMemoryArgs {
                workspace_root: workspace_root.clone(),
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("doctor should succeed");
        let prune_output = execute_memory_command(
            MemoryCommand::Prune(PruneMemoryArgs {
                workspace_root: workspace_root.clone(),
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(global_root.clone()),
            },
        )
        .expect("prune should succeed");

        let import_root = temp_root.join("import-workspace");
        fs::create_dir_all(&import_root).expect("import workspace root should exist");
        let import_output = execute_memory_command(
            MemoryCommand::Import(ImportMemoryArgs {
                workspace_root: import_root.clone(),
                input_path: export_path,
                json: false,
            }),
            ExecutionOverrides {
                global_root: Some(temp_root.join("import-home").join(".buildplane")),
            },
        )
        .expect("import should succeed");

        assert!(export_output.contains("Exported 2 memory items"));
        assert!(doctor_output.contains("forgotten items: 1"));
        assert!(prune_output.contains("Pruned 1 forgotten memory items"));
        assert!(import_output.contains("Imported 2 memory items"));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn parses_link_add_command() {
        let command = parse_memory_command(
            vec![
                "link",
                "add",
                "mem_123",
                "mem_456",
                "--relation",
                "supports",
                "--json",
            ],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("link add should parse");

        assert_eq!(
            command,
            MemoryCommand::LinkAdd(LinkAddArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                from_id: "mem_123".to_string(),
                to_id: "mem_456".to_string(),
                relation: MemoryLinkRelation::Supports,
                json: true,
            })
        );
    }

    #[test]
    fn parses_link_list_command_with_optional_memory_id() {
        let command = parse_memory_command(
            vec!["link", "list", "mem_123"],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("link list should parse");

        assert_eq!(
            command,
            MemoryCommand::LinkList(LinkListArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                memory_id: Some("mem_123".to_string()),
                json: false,
            })
        );

        let command_all = parse_memory_command(
            vec!["link", "list", "--json"],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect("link list --json should parse");

        assert_eq!(
            command_all,
            MemoryCommand::LinkList(LinkListArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                memory_id: None,
                json: true,
            })
        );
    }

    #[test]
    fn link_add_rejects_missing_relation() {
        let err = parse_memory_command(
            vec!["link", "add", "mem_123", "mem_456"],
            PathBuf::from("/tmp/buildplane"),
        )
        .expect_err("link add without --relation should fail");

        assert!(err.contains("--relation"));
    }

    #[test]
    fn link_commands_and_inspect_explain_show_links_end_to_end() {
        let temp_root = unique_temp_root("bp-memory-links-e2e");
        let workspace_root = temp_root.join("workspace");
        let global_root = temp_root.join("home").join(".buildplane");
        fs::create_dir_all(&workspace_root).expect("workspace root should exist");

        let overrides = ExecutionOverrides {
            global_root: Some(global_root.clone()),
        };

        let item_a_json = execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "Prefer concise output".to_string(),
                scope: MemoryScope::User,
                kind: MemoryKind::Preference,
                title: Some("concise output".to_string()),
                pack_id: None,
                session_id: None,
                json: true,
            }),
            overrides.clone(),
        )
        .expect("remember A should succeed");
        let item_a: MemoryItem = serde_json::from_str(&item_a_json).expect("A json should parse");

        let item_b_json = execute_memory_command(
            MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: workspace_root.clone(),
                body: "No trailing summaries".to_string(),
                scope: MemoryScope::User,
                kind: MemoryKind::Constraint,
                title: Some("skip summaries".to_string()),
                pack_id: None,
                session_id: None,
                json: true,
            }),
            overrides.clone(),
        )
        .expect("remember B should succeed");
        let item_b: MemoryItem = serde_json::from_str(&item_b_json).expect("B json should parse");

        let link_output = execute_memory_command(
            MemoryCommand::LinkAdd(LinkAddArgs {
                workspace_root: workspace_root.clone(),
                from_id: item_b.id.clone(),
                to_id: item_a.id.clone(),
                relation: MemoryLinkRelation::Supports,
                json: false,
            }),
            overrides.clone(),
        )
        .expect("link add should succeed");
        assert!(link_output.contains("(supports)"));

        let list_output = execute_memory_command(
            MemoryCommand::LinkList(LinkListArgs {
                workspace_root: workspace_root.clone(),
                memory_id: Some(item_a.id.clone()),
                json: false,
            }),
            overrides.clone(),
        )
        .expect("link list should succeed");
        assert!(list_output.contains("Links: 1"));
        assert!(list_output.contains("supports"));

        let inspect_output = execute_memory_command(
            MemoryCommand::Inspect(InspectMemoryArgs {
                native_root: workspace_root.clone(),
                workspace_root: workspace_root.clone(),
                id: Some(item_a.id.clone()),
                scope: None,
                pack_id: None,
                session_id: None,
                effective: false,
                include_forgotten: false,
                json: false,
            }),
            overrides.clone(),
        )
        .expect("inspect should succeed");
        assert!(inspect_output.contains("concise output"));
        assert!(inspect_output.contains("Links:"));
        assert!(inspect_output.contains("supports"));

        let explain_output = execute_memory_command(
            MemoryCommand::Explain(ExplainMemoryArgs {
                native_root: workspace_root.clone(),
                workspace_root: workspace_root.clone(),
                id: Some(item_b.id.clone()),
                pack_id: None,
                session_id: None,
                effective: false,
                include_forgotten: false,
                json: false,
            }),
            overrides.clone(),
        )
        .expect("explain should succeed");
        assert!(explain_output.contains("skip summaries"));
        assert!(explain_output.contains("Links:"));
        assert!(explain_output.contains("supports"));

        let list_all_output = execute_memory_command(
            MemoryCommand::LinkList(LinkListArgs {
                workspace_root: workspace_root.clone(),
                memory_id: None,
                json: false,
            }),
            overrides,
        )
        .expect("link list all should succeed");
        assert!(list_all_output.contains("Links: 1"));

        let _ = fs::remove_dir_all(temp_root);
    }
}
