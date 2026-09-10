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

impl Default for WorkspacePaths {
    fn default() -> Self {
        Self::from_environment()
    }
}

impl WorkspacePaths {
    pub fn from_environment() -> Self {
        Self {
            // Möbius never defaults to a previous MyDesk installation or to a
            // harness home.  The MYDESK_* names remain a deliberate opt-in
            // compatibility bridge for existing launch scripts.
            workspace_root: env_path(
                "MOBIUS_WORKSPACE",
                "MYDESK_WORKSPACE",
                r"E:\Workspaces\Mobius",
            ),
            data_root: env_path(
                "MOBIUS_DATA_ROOT",
                "MYDESK_DATA_ROOT",
                r"D:\DataVault\Mobius",
            ),
            artifacts_root: env_path(
                "MOBIUS_ARTIFACTS_ROOT",
                "MYDESK_ARTIFACTS_ROOT",
                r"D:\AcceptedArtifacts\Mobius",
            ),
            catalog_root: env_path("MOBIUS_CATALOG_ROOT", "MYDESK_CATALOG_ROOT", r"D:\Catalog"),
        }
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

fn env_path(primary: &str, legacy: &str, fallback: &str) -> PathBuf {
    env::var_os(primary)
        .or_else(|| env::var_os(legacy))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
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
}
