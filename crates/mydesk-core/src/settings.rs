use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

/// Durable, portable application settings. Environment variables still win
/// for a single process (CI, isolated tests). This file is how a person
/// points a released desktop at their own data roots without hard-coding
/// a machine layout into the binary.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct AppSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppSettingsView {
    pub settings: AppSettings,
    pub settings_path: String,
    pub data_root: String,
    pub artifacts_root: String,
    pub catalog_root: String,
    pub workspace_root: String,
    pub notes_dir: String,
    pub database_path: String,
    pub default_data_root: String,
    pub data_root_source: String,
    pub artifacts_root_source: String,
    pub catalog_root_source: String,
    pub workspace_root_source: String,
    pub restart_required: bool,
}

pub fn settings_file_path() -> PathBuf {
    config_home().join("settings.json")
}

pub fn load_app_settings() -> Result<AppSettings> {
    let path = settings_file_path();
    if !path.is_file() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
}

pub fn save_app_settings(settings: &AppSettings) -> Result<PathBuf> {
    validate_settings(settings)?;
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let encoded = serde_json::to_string_pretty(settings)?;
    fs::write(&path, encoded).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

pub fn default_data_root() -> PathBuf {
    if let Some(base) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(base).join("Mobius");
    }
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("mobius");
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".mobius")
}

pub fn default_workspace_root() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn config_home() -> PathBuf {
    if let Some(base) = env::var_os("APPDATA") {
        return PathBuf::from(base).join("Mobius");
    }
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join(".config").join("mobius");
    }
    default_data_root()
}

fn validate_settings(settings: &AppSettings) -> Result<()> {
    for (label, value) in [
        ("data_root", settings.data_root.as_deref()),
        ("artifacts_root", settings.artifacts_root.as_deref()),
        ("catalog_root", settings.catalog_root.as_deref()),
        ("workspace_root", settings.workspace_root.as_deref()),
    ] {
        if let Some(raw) = value {
            let path = Path::new(raw.trim());
            if raw.trim().is_empty() || !path.is_absolute() {
                bail!("{label} must be an absolute directory");
            }
        }
    }
    if let Some(theme) = settings.theme.as_deref() {
        if !matches!(theme, "light" | "dark") {
            bail!("theme must be light or dark");
        }
    }
    if let Some(locale) = settings.locale.as_deref() {
        if !matches!(locale, "en" | "zh-CN") {
            bail!("locale must be en or zh-CN");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_data_root_is_portable_local_app_data() {
        let data = default_data_root();
        let text = data.to_string_lossy();
        assert!(
            !text.contains("DataVault") && !text.contains("AcceptedArtifacts"),
            "default data root should be portable local app data, got {text}"
        );
        assert!(text.to_ascii_lowercase().contains("mobius"));
    }

    #[test]
    fn relative_data_root_is_rejected() {
        let error = validate_settings(&AppSettings {
            data_root: Some("vault".into()),
            ..AppSettings::default()
        })
        .expect_err("relative roots must not be stored");
        assert!(error.to_string().contains("absolute"));
    }
}
