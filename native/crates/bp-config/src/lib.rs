use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub workspace_root: PathBuf,
    pub state_dir: PathBuf,
    pub native_root: PathBuf,
}

impl RuntimeConfig {
    pub fn from_workspace_root(workspace_root: impl Into<PathBuf>) -> Self {
        let workspace_root = workspace_root.into();
        Self {
            state_dir: workspace_root.join(".buildplane"),
            native_root: workspace_root.join("native"),
            workspace_root,
        }
    }
}
