use crate::{Checkout, CheckoutKind, Workspace, WorkspaceInspection, WorkspaceStatus};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct GitIdentity {
    pub common_dir: String,
    pub top_level: String,
    pub remote: Option<String>,
    pub stable_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PathIdentity {
    pub input_path: String,
    pub canonical_path: String,
    pub stable_path_id: String,
    pub git: Option<GitIdentity>,
}

pub fn inspect_path_identity(path: &Path) -> Result<PathIdentity> {
    let absolute = absolute_path(path)?;
    if !absolute.is_dir() {
        bail!("Workspace path is not a directory: {}", absolute.display());
    }
    let canonical = fs_canonical_display(&absolute)?;
    let canonical_text = canonical.display().to_string();
    Ok(PathIdentity {
        input_path: path.display().to_string(),
        stable_path_id: stable_id("path", &normalize_key(&canonical_text)),
        git: inspect_git(&canonical).ok(),
        canonical_path: canonical_text,
    })
}

pub fn inspect_workspace(path: &Path, display_name: Option<&str>) -> Result<WorkspaceInspection> {
    let identity = inspect_path_identity(path)?;
    let now = Utc::now().to_rfc3339();
    let name = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(&identity.canonical_path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| identity.canonical_path.clone());

    let (id, canonical_path, git_identity, checkouts) = if let Some(git) = &identity.git {
        let checkouts = inspect_worktrees(
            Path::new(&git.top_level),
            &git.stable_id,
            &git.common_dir,
            &now,
        )?;
        let canonical_path = checkouts
            .first()
            .map(|checkout| checkout.canonical_path.clone())
            .unwrap_or_else(|| identity.canonical_path.clone());
        (
            git.stable_id.clone(),
            canonical_path,
            Some(git.stable_id.clone()),
            checkouts,
        )
    } else {
        let checkout = Checkout {
            id: stable_id("checkout", &normalize_key(&identity.canonical_path)),
            workspace_id: identity.stable_path_id.clone(),
            kind: CheckoutKind::Directory,
            canonical_path: identity.canonical_path.clone(),
            branch: None,
            head: None,
            git_common_dir: None,
            dirty: false,
            ahead: 0,
            behind: 0,
            updated_at: now.clone(),
        };
        (
            identity.stable_path_id.clone(),
            identity.canonical_path.clone(),
            None,
            vec![checkout],
        )
    };
    Ok(WorkspaceInspection {
        workspace: Workspace {
            id,
            display_name: name,
            canonical_path,
            git_identity,
            status: WorkspaceStatus::Working,
            created_at: now.clone(),
            updated_at: now,
        },
        checkouts,
    })
}

fn inspect_worktrees(
    git_root: &Path,
    workspace_id: &str,
    common_dir: &str,
    now: &str,
) -> Result<Vec<Checkout>> {
    let output = git_output(git_root, &["worktree", "list", "--porcelain"])?.replace("\r\n", "\n");
    let mut checkouts = Vec::new();
    for (index, block) in output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .enumerate()
    {
        let mut worktree = None;
        let mut head = None;
        let mut branch = None;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                worktree = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                branch = Some(value.to_string());
            }
        }
        let Some(worktree) = worktree else { continue };
        let canonical =
            fs_canonical_display(Path::new(&worktree)).unwrap_or_else(|_| PathBuf::from(&worktree));
        let canonical_path = canonical.display().to_string();
        let dirty = Command::new("git")
            .arg("-C")
            .arg(&canonical)
            .args(["status", "--porcelain", "--untracked-files=no"])
            .output()
            .map(|result| result.status.success() && !result.stdout.is_empty())
            .unwrap_or(false);
        checkouts.push(Checkout {
            id: stable_id("checkout", &normalize_key(&canonical_path)),
            workspace_id: workspace_id.to_string(),
            kind: if index == 0 {
                CheckoutKind::Main
            } else {
                CheckoutKind::Worktree
            },
            canonical_path,
            branch,
            head,
            git_common_dir: Some(common_dir.to_string()),
            dirty,
            ahead: 0,
            behind: 0,
            updated_at: now.to_string(),
        });
    }
    Ok(checkouts)
}

fn inspect_git(path: &Path) -> Result<GitIdentity> {
    let common_dir = git_output(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let top_level = git_output(
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
    )?;
    let remote = git_output(path, &["remote", "get-url", "origin"]).ok();
    let identity_material = format!(
        "{}\n{}",
        normalize_key(&common_dir),
        remote
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
    );
    Ok(GitIdentity {
        stable_id: stable_id("git", &identity_material),
        common_dir,
        top_level,
        remote,
    })
}

fn git_output(path: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .with_context(|| format!("running git in {}", path.display()))?;
    if !output.status.success() {
        bail!("git command failed with {}", output.status);
    }
    let value = String::from_utf8(output.stdout)?.trim().to_string();
    if value.is_empty() {
        bail!("git returned an empty identity");
    }
    Ok(value)
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(env::current_dir()?.join(path))
}

fn fs_canonical_display(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("canonicalizing {}", path.display()))?;
    let text = canonical.display().to_string();
    Ok(PathBuf::from(
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    ))
}

fn normalize_key(value: &str) -> String {
    value
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn stable_id(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{prefix}:{}", &hex::encode(hasher.finalize())[..24])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_directory_has_stable_identity() {
        let temporary = tempfile::tempdir().expect("temp");
        let first = inspect_path_identity(temporary.path()).expect("first");
        let second = inspect_path_identity(temporary.path()).expect("second");
        assert_eq!(first.stable_path_id, second.stable_path_id);
        assert_eq!(first.canonical_path, second.canonical_path);
    }

    #[test]
    fn plain_directory_becomes_one_directory_checkout() {
        let temporary = tempfile::tempdir().expect("temp");
        let inspection = inspect_workspace(temporary.path(), Some("Scratch")).expect("inspect");
        assert_eq!(inspection.workspace.display_name, "Scratch");
        assert_eq!(inspection.checkouts.len(), 1);
        assert_eq!(inspection.checkouts[0].kind, CheckoutKind::Directory);
        assert_eq!(
            inspection.checkouts[0].workspace_id,
            inspection.workspace.id
        );
    }
}
