use crate::settings::{self, AppSettingsView};
use anyhow::{Context, Result, bail};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct WorkspacePaths {
    pub workspace_root: PathBuf,
    pub data_root: PathBuf,
    pub artifacts_root: PathBuf,
    pub catalog_root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathSources {
    pub data_root: &'static str,
    pub artifacts_root: &'static str,
    pub catalog_root: &'static str,
    pub workspace_root: &'static str,
}

impl Default for WorkspacePaths {
    fn default() -> Self {
        Self::from_environment()
    }
}

impl WorkspacePaths {
    pub fn from_environment() -> Self {
        resolve_workspace_paths().0
    }

    pub fn settings_view() -> Result<AppSettingsView> {
        let settings = settings::load_app_settings().unwrap_or_default();
        let (paths, sources) = resolve_workspace_paths();
        Ok(AppSettingsView {
            settings,
            settings_path: settings::settings_file_path().display().to_string(),
            data_root: paths.data_root.display().to_string(),
            artifacts_root: paths.artifacts_root.display().to_string(),
            catalog_root: paths.catalog_root.display().to_string(),
            workspace_root: paths.workspace_root.display().to_string(),
            notes_dir: paths.notes_dir().display().to_string(),
            database_path: paths.database_path().display().to_string(),
            default_data_root: settings::default_data_root().display().to_string(),
            data_root_source: sources.data_root.to_string(),
            artifacts_root_source: sources.artifacts_root.to_string(),
            catalog_root_source: sources.catalog_root.to_string(),
            workspace_root_source: sources.workspace_root.to_string(),
            restart_required: false,
        })
    }

    pub fn ensure_layout(&self) -> Result<()> {
        if self.data_root == self.workspace_root {
            bail!("MOBIUS_DATA_ROOT must be separate from the active workspace");
        }

        for relative in [
            "vault/notes",
            "vault/wiki",
            "vault/sources",
            "vault/boards",
            "vault/boards/assets",
            "vault/trash",
            "vault/history",
            "skills/manifests",
            "migrations",
            "runtime",
        ] {
            fs::create_dir_all(self.data_root.join(relative)).with_context(|| {
                format!(
                    "creating data directory {}",
                    self.data_root.join(relative).display()
                )
            })?;
        }
        fs::create_dir_all(&self.artifacts_root).with_context(|| {
            format!(
                "creating artifacts directory {}",
                self.artifacts_root.display()
            )
        })?;
        fs::create_dir_all(self.session_maps_dir()).with_context(|| {
            format!(
                "creating session-forward map directory {}",
                self.session_maps_dir().display()
            )
        })?;
        Ok(())
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_root.join("mobius.sqlite")
    }

    pub fn notes_dir(&self) -> PathBuf {
        self.data_root.join("vault/notes")
    }

    pub fn wiki_dir(&self) -> PathBuf {
        self.data_root.join("vault/wiki")
    }

    pub fn boards_dir(&self) -> PathBuf {
        self.data_root.join("vault/boards")
    }

    pub fn board_assets_dir(&self) -> PathBuf {
        self.boards_dir().join("assets")
    }

    pub fn history_dir(&self) -> PathBuf {
        self.data_root.join("vault/history")
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.data_root.join("vault/trash")
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.data_root.join("runtime")
    }

    pub fn migration_backup_dir(&self) -> PathBuf {
        self.data_root.join("migrations")
    }

    pub fn skills_manifest_path(&self) -> PathBuf {
        self.data_root.join("skills/manifests/managed-skills.json")
    }

    pub fn session_maps_dir(&self) -> PathBuf {
        self.catalog_root.join("SessionMaps")
    }

    /// User-approved, read-only session source roots.  This manifest belongs
    /// to Möbius data, never inside a provider's transcript directory.
    pub fn approved_session_sources_path(&self) -> PathBuf {
        self.runtime_dir().join("approved-session-sources.json")
    }

    pub fn contains_workspace(&self, path: &Path) -> bool {
        path.starts_with(&self.workspace_root)
    }
}

fn resolve_workspace_paths() -> (WorkspacePaths, PathSources) {
    // Environment still wins for one process (CI, isolated tests, a one-off
    // launch). Stored settings are how a released desktop remembers a person's
    // data roots without baking a drive letter into the binary.
    let stored = settings::load_app_settings().unwrap_or_default();
    let (data_root, data_root_source) = resolve_path(
        "MOBIUS_DATA_ROOT",
        "MYDESK_DATA_ROOT",
        stored.data_root.as_deref(),
        settings::default_data_root,
    );
    let (workspace_root, workspace_root_source) = resolve_path(
        "MOBIUS_WORKSPACE",
        "MYDESK_WORKSPACE",
        stored.workspace_root.as_deref(),
        settings::default_workspace_root,
    );
    let (artifacts_root, artifacts_root_source) = resolve_path(
        "MOBIUS_ARTIFACTS_ROOT",
        "MYDESK_ARTIFACTS_ROOT",
        stored.artifacts_root.as_deref(),
        || data_root.join("artifacts"),
    );
    let (catalog_root, catalog_root_source) = resolve_path(
        "MOBIUS_CATALOG_ROOT",
        "MYDESK_CATALOG_ROOT",
        stored.catalog_root.as_deref(),
        || data_root.join("catalog"),
    );
    (
        WorkspacePaths {
            workspace_root,
            data_root,
            artifacts_root,
            catalog_root,
        },
        PathSources {
            data_root: data_root_source,
            artifacts_root: artifacts_root_source,
            catalog_root: catalog_root_source,
            workspace_root: workspace_root_source,
        },
    )
}

fn resolve_path(
    primary: &str,
    legacy: &str,
    stored: Option<&str>,
    fallback: impl FnOnce() -> PathBuf,
) -> (PathBuf, &'static str) {
    if let Some(path) = env_path(primary) {
        return (path, "environment");
    }
    if let Some(path) = env_path(legacy) {
        return (path, "legacy-environment");
    }
    if let Some(raw) = stored.map(str::trim).filter(|value| !value.is_empty()) {
        return (PathBuf::from(raw), "settings");
    }
    (fallback(), "default")
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::WorkspacePaths;
    use std::env;

    #[test]
    fn mobius_environment_wins_over_legacy_environment() {
        // The test only reads values supplied by the test process; it does
        // not create or inspect either path.
        unsafe {
            env::set_var("MOBIUS_WORKSPACE", "M:/mobius-workspace");
            env::set_var("MYDESK_WORKSPACE", "M:/legacy-workspace");
        }
        let paths = WorkspacePaths::from_environment();
        assert_eq!(
            paths.workspace_root.to_string_lossy(),
            "M:/mobius-workspace"
        );
        unsafe {
            env::remove_var("MOBIUS_WORKSPACE");
            env::remove_var("MYDESK_WORKSPACE");
        }
    }

    #[test]
    fn default_data_root_is_portable_local_app_data() {
        let data = crate::settings::default_data_root();
        let text = data.to_string_lossy();
        assert!(
            !text.contains("DataVault") && !text.contains("AcceptedArtifacts"),
            "default data root should be portable local app data, got {text}"
        );
        assert!(text.to_ascii_lowercase().contains("mobius"));
    }
}
