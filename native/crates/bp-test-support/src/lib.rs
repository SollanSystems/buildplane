use bp_host_sdk::DetectionContext;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub fn detection_context(
    workspace_root: impl Into<PathBuf>,
    env: &[(&str, &str)],
) -> DetectionContext {
    let env = env
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect::<BTreeMap<_, _>>();

    DetectionContext {
        workspace_root: workspace_root.into(),
        env,
    }
}
