use bp_pack_manifest::{is_valid_pack_id, ManifestError, PackManifest};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedPack {
    pub pack_root: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: PackManifest,
}

pub fn packs_root_for(native_root: impl AsRef<Path>) -> PathBuf {
    native_root.as_ref().join("packs")
}

pub fn pack_root_for(native_root: impl AsRef<Path>, pack_id: &str) -> PathBuf {
    packs_root_for(native_root).join(pack_id)
}

pub fn manifest_path_for(pack_root: impl AsRef<Path>) -> PathBuf {
    pack_root.as_ref().join("pack.toml")
}

pub fn load_manifest(pack_root: impl AsRef<Path>) -> Result<PackManifest, PackLoaderError> {
    let manifest_path = manifest_path_for(pack_root);
    let manifest = PackManifest::parse_file(&manifest_path)?;
    Ok(manifest)
}

pub fn load_pack(pack_root: impl AsRef<Path>) -> Result<LoadedPack, PackLoaderError> {
    let pack_root = pack_root.as_ref().to_path_buf();
    let manifest_path = manifest_path_for(&pack_root);

    if !manifest_path.exists() {
        return Err(PackLoaderError::PackNotFound {
            pack_id: pack_root
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string()),
            pack_root,
        });
    }

    let manifest = PackManifest::parse_file(&manifest_path)?;
    Ok(LoadedPack {
        pack_root,
        manifest_path,
        manifest,
    })
}

pub fn load_pack_from_native_root(
    native_root: impl AsRef<Path>,
    pack_id: &str,
) -> Result<LoadedPack, PackLoaderError> {
    if !is_valid_pack_id(pack_id) {
        return Err(PackLoaderError::InvalidPackId(pack_id.to_string()));
    }

    let pack_root = pack_root_for(native_root, pack_id);
    load_pack(pack_root)
}

#[derive(Debug, Error)]
pub enum PackLoaderError {
    #[error("pack id '{0}' must be a lowercase slug using only a-z, 0-9, and '-' characters")]
    InvalidPackId(String),
    #[error("pack '{pack_id}' not found under {pack_root}")]
    PackNotFound { pack_id: String, pack_root: PathBuf },
    #[error("failed to load pack manifest: {0}")]
    Manifest(#[from] ManifestError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const VALID_MANIFEST: &str = r#"
    schema_version = 1

    [pack]
    id = "superclaude"
    display_name = "SuperClaude"
    version = "0.1.0"
    default_provider = "anthropic"

    [memory]
    share_user = true
    share_workspace = true
    share_pack = true

    [[modes]]
    id = "daily"
    display_name = "Daily"
    reasoning = "fast"
    autonomy = "guided"
    default = true
    "#;

    fn unique_temp_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "bp-pack-loader-test-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn derives_pack_paths_from_native_root() {
        let native_root = PathBuf::from("/tmp/buildplane/native");
        let pack_root = pack_root_for(&native_root, "superclaude");

        assert_eq!(packs_root_for(&native_root), native_root.join("packs"));
        assert_eq!(pack_root, native_root.join("packs").join("superclaude"));
        assert_eq!(manifest_path_for(&pack_root), pack_root.join("pack.toml"));
    }

    #[test]
    fn loads_pack_from_native_root() {
        let temp_root = unique_temp_root();
        let native_root = temp_root.join("native");
        let pack_root = pack_root_for(&native_root, "superclaude");
        fs::create_dir_all(&pack_root).expect("create pack dir");
        fs::write(manifest_path_for(&pack_root), VALID_MANIFEST).expect("write manifest");

        let loaded =
            load_pack_from_native_root(&native_root, "superclaude").expect("expected pack to load");

        assert_eq!(loaded.pack_root, pack_root);
        assert_eq!(loaded.manifest.pack.id, "superclaude");
        assert_eq!(loaded.manifest_path, loaded.pack_root.join("pack.toml"));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn rejects_pack_ids_with_path_traversal_segments() {
        let err = load_pack_from_native_root("/tmp/does-not-exist/native", "../escape")
            .expect_err("invalid pack ids should fail before filesystem access");

        assert!(matches!(
            err,
            PackLoaderError::InvalidPackId(pack_id) if pack_id == "../escape"
        ));
    }

    #[test]
    fn returns_pack_not_found_when_manifest_is_missing() {
        let err = load_pack_from_native_root("/tmp/does-not-exist/native", "missing")
            .expect_err("missing pack should fail");

        assert!(matches!(
            err,
            PackLoaderError::PackNotFound { pack_id, .. } if pack_id == "missing"
        ));
    }
}
