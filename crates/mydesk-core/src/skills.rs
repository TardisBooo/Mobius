use crate::{SkillInfo, WorkspacePaths};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use walkdir::WalkDir;

const MANIFEST_VERSION: u32 = 1;
const MAX_SKILL_CONTENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct SkillRoot {
    pub path: PathBuf,
    pub scope: String,
    pub source_kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkillDeployment {
    pub managed_id: Option<String>,
    pub skill: SkillInfo,
    pub target: String,
    pub target_root: String,
    pub destination: String,
    pub can_install: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ManagedSkillInstall {
    pub id: String,
    pub source_path: String,
    pub destination: String,
    pub target: String,
    pub tree_hash: String,
    pub installed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkillHistoryEntry {
    pub id: String,
    pub managed_id: String,
    pub created_at: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SkillManifest {
    version: u32,
    installations: Vec<ManagedSkillInstall>,
}

impl Default for SkillManifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            installations: Vec::new(),
        }
    }
}

pub fn standard_skill_roots(paths: &WorkspacePaths) -> Vec<SkillRoot> {
    let (user, codex_home) = standard_harness_homes(paths);

    vec![
        SkillRoot {
            path: codex_home.join("skills"),
            scope: "global".to_string(),
            source_kind: "codex".to_string(),
        },
        SkillRoot {
            path: user.join(".agents/skills"),
            scope: "global".to_string(),
            source_kind: "agents".to_string(),
        },
        SkillRoot {
            path: user.join(".claude/skills"),
            scope: "global".to_string(),
            source_kind: "claude".to_string(),
        },
        SkillRoot {
            path: user.join(".pi/skills"),
            scope: "global".to_string(),
            source_kind: "pi".to_string(),
        },
        SkillRoot {
            path: user.join(".grok/skills"),
            scope: "global".to_string(),
            source_kind: "grok".to_string(),
        },
    ]
}

/// Resolves the profile roots shared by both skill discovery and managed
/// deployment. Keeping this in one place is important: an isolated
/// `MOBIUS_HARNESS_HOME` must never be discovered from one profile and then
/// written into the interactive account by a managed install.
fn standard_harness_homes(paths: &WorkspacePaths) -> (PathBuf, PathBuf) {
    // `MOBIUS_*` roots keep verification entirely self-contained. They are
    // intentionally read before the conventional Harness roots, but normal
    // desktop launches retain their existing USERPROFILE/CODEX_HOME behavior.
    let user = env::var_os("MOBIUS_HARNESS_HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.workspace_root.clone());
    let codex_home = env::var_os("MOBIUS_CODEX_HOME")
        .or_else(|| env::var_os("CODEX_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| user.join(".codex"));
    (user, codex_home)
}

/// Explicit project-local skill roots shared by the supported harnesses.
///
/// We intentionally do not scan a generic `skills/` directory: a project may
/// use that name for source code or documentation.  These roots are the
/// harness configuration locations, so discovery remains both predictable and
/// read-only.
pub fn project_skill_roots(workspace: &Path) -> Vec<SkillRoot> {
    [
        (".agents/skills", "agents"),
        (".codex/skills", "codex"),
        (".claude/skills", "claude"),
        (".pi/skills", "pi"),
        (".grok/skills", "grok"),
    ]
    .into_iter()
    .map(|(relative, source_kind)| SkillRoot {
        path: workspace.join(relative),
        scope: "project".to_string(),
        source_kind: source_kind.to_string(),
    })
    .collect()
}

pub fn scan_skill_root(root: &Path, scope: &str, source_kind: &str) -> Result<Vec<SkillInfo>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
    {
        let path = entry.into_path();
        let contents = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let name = first_skill_name(&contents).unwrap_or_else(|| {
            path.parent()
                .and_then(|item| item.file_name())
                .and_then(|item| item.to_str())
                .unwrap_or("unnamed-skill")
                .to_string()
        });
        skills.push(SkillInfo {
            id: format!("skill:{}", &hash_bytes(&contents)[..16]),
            name,
            source_path: path.display().to_string(),
            source_kind: source_kind.to_string(),
            content_hash: hash_bytes(&contents),
            scope: scope.to_string(),
            managed: false,
        });
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

pub fn discover_standard_skills(
    paths: &WorkspacePaths,
    scope: Option<&str>,
) -> Result<Vec<SkillInfo>> {
    let manifest = read_manifest(paths)?;
    let mut known = HashSet::new();
    let mut skills = Vec::new();

    for root in standard_skill_roots(paths) {
        if scope.is_some_and(|requested| requested != "all" && requested != root.scope) {
            continue;
        }
        for mut skill in scan_skill_root(&root.path, &root.scope, &root.source_kind)? {
            let canonical = canonical_or_original(Path::new(&skill.source_path));
            if !known.insert(canonical) {
                continue;
            }
            skill.managed = manifest.installations.iter().any(|install| {
                same_path(
                    &Path::new(&install.destination).join("SKILL.md"),
                    Path::new(&skill.source_path),
                )
            });
            skills.push(skill);
        }
    }
    if scope.map_or(true, |requested| {
        requested == "all" || requested == "project"
    }) {
        for root in project_skill_roots(&paths.workspace_root) {
            for mut skill in scan_skill_root(&root.path, &root.scope, &root.source_kind)? {
                let canonical = canonical_or_original(Path::new(&skill.source_path));
                if !known.insert(canonical) {
                    continue;
                }
                skill.managed = manifest.installations.iter().any(|install| {
                    same_path(
                        &Path::new(&install.destination).join("SKILL.md"),
                        Path::new(&skill.source_path),
                    )
                });
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|left, right| {
        left.scope
            .cmp(&right.scope)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(skills)
}

/// Discovers project skills for one registered checkout.  The caller owns the
/// registration check; this function itself only reads the explicit harness
/// directories above and never follows links.
pub fn discover_project_skills(workspace: &Path) -> Result<Vec<SkillInfo>> {
    let mut known = HashSet::new();
    let mut skills = Vec::new();
    for root in project_skill_roots(workspace) {
        for skill in scan_skill_root(&root.path, &root.scope, &root.source_kind)? {
            if known.insert(canonical_or_original(Path::new(&skill.source_path))) {
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

pub fn list_managed_installations(paths: &WorkspacePaths) -> Result<Vec<ManagedSkillInstall>> {
    Ok(read_manifest(paths)?.installations)
}

pub fn preview_managed_copy(skill: SkillInfo, target_root: &Path) -> SkillDeployment {
    let source = PathBuf::from(&skill.source_path);
    let folder = source
        .parent()
        .and_then(|item| item.file_name())
        .unwrap_or_default();
    SkillDeployment {
        destination: target_root.join(folder).display().to_string(),
        target_root: target_root.display().to_string(),
        target: "explicit".to_string(),
        skill,
        managed_id: None,
        can_install: true,
        reason: "Destination has not been checked.".to_string(),
    }
}

pub fn preview_install(
    paths: &WorkspacePaths,
    source_path: &str,
    target: &str,
) -> Result<SkillDeployment> {
    let (source, skill) = resolve_known_skill(paths, source_path)?;
    preview_resolved_install(paths, source, skill, target)
}

/// Previews a deployment from a caller-supplied, already discovered catalogue.
/// The desktop uses this for project-local skills after proving that the source
/// belongs to a registered checkout.  It deliberately does not accept an
/// arbitrary filesystem path.
pub fn preview_install_from_catalogue(
    paths: &WorkspacePaths,
    source_path: &str,
    known_skills: &[SkillInfo],
    target: &str,
) -> Result<SkillDeployment> {
    let (source, skill) = resolve_known_skill_from_catalogue(source_path, known_skills)?;
    preview_resolved_install(paths, source, skill, target)
}

fn preview_resolved_install(
    paths: &WorkspacePaths,
    source: PathBuf,
    skill: SkillInfo,
    target: &str,
) -> Result<SkillDeployment> {
    let target_root = target_root(paths, target)?;
    let source_dir = source
        .parent()
        .context("SKILL.md must belong to a skill directory")?;
    let folder = source_dir
        .file_name()
        .context("skill directory must have a folder name")?;
    let destination = target_root.join(folder);
    let manifest = read_manifest(paths)?;

    if same_path(source_dir, &destination) {
        return Ok(SkillDeployment {
            managed_id: None,
            skill,
            target: target.to_string(),
            target_root: target_root.display().to_string(),
            destination: destination.display().to_string(),
            can_install: false,
            reason: "Source is already inside this deployment target.".to_string(),
        });
    }

    if destination.exists() {
        let managed = manifest
            .installations
            .iter()
            .find(|install| same_path(Path::new(&install.destination), &destination));
        let (managed_id, reason) = match managed {
            Some(install) => (
                Some(install.id.clone()),
                "A managed skill already owns this destination. Uninstall it before deploying a replacement."
                    .to_string(),
            ),
            None => (
                None,
                "Destination exists and is not managed by MyDesk; it will not be overwritten."
                    .to_string(),
            ),
        };
        return Ok(SkillDeployment {
            managed_id,
            skill,
            target: target.to_string(),
            target_root: target_root.display().to_string(),
            destination: destination.display().to_string(),
            can_install: false,
            reason,
        });
    }

    Ok(SkillDeployment {
        managed_id: None,
        skill,
        target: target.to_string(),
        target_root: target_root.display().to_string(),
        destination: destination.display().to_string(),
        can_install: true,
        reason: "A new managed copy will be created; the source remains untouched.".to_string(),
    })
}

pub fn install_skill(
    paths: &WorkspacePaths,
    source_path: &str,
    target: &str,
) -> Result<SkillDeployment> {
    let (source, skill) = resolve_known_skill(paths, source_path)?;
    install_resolved_skill(paths, source, skill, target)
}

/// Installs a managed copy from a caller-supplied, already discovered
/// catalogue.  This is the project-local counterpart to [`install_skill`].
pub fn install_skill_from_catalogue(
    paths: &WorkspacePaths,
    source_path: &str,
    known_skills: &[SkillInfo],
    target: &str,
) -> Result<SkillDeployment> {
    let (source, skill) = resolve_known_skill_from_catalogue(source_path, known_skills)?;
    install_resolved_skill(paths, source, skill, target)
}

/// Installs a skill returned by the public agentskill.sh catalogue without
/// treating the remote response as an arbitrary local source. The Markdown is
/// cached under Möbius' data vault for provenance, then passed through the
/// same staged-copy and manifest path as local skills. The cached source is
/// never written into a Harness skill directory.
pub fn install_marketplace_skill(
    paths: &WorkspacePaths,
    slug: &str,
    name: &str,
    content: &str,
    target: &str,
) -> Result<SkillDeployment> {
    if content.is_empty() || content.len() > MAX_SKILL_CONTENT_BYTES {
        bail!("Marketplace SKILL.md is empty or exceeds the {} MiB safety limit.", MAX_SKILL_CONTENT_BYTES / 1024 / 1024);
    }
    let mut parts = slug.split('/');
    let owner = parts.next().filter(|value| !value.is_empty()).context("marketplace skill owner is missing")?;
    let skill_slug = parts.next().filter(|value| !value.is_empty()).context("marketplace skill slug is missing")?;
    if parts.next().is_some() || !is_safe_marketplace_segment(owner) || !is_safe_marketplace_segment(skill_slug) {
        bail!("invalid marketplace skill slug");
    }
    let source_dir = paths.data_root.join("skills/marketplace").join(owner).join(skill_slug);
    fs::create_dir_all(&source_dir).with_context(|| format!("creating marketplace cache {}", source_dir.display()))?;
    let source = source_dir.join("SKILL.md");
    fs::write(&source, content).with_context(|| format!("caching marketplace skill {}", slug))?;
    let source = source.canonicalize().with_context(|| format!("resolving marketplace skill {}", slug))?;
    let display_name = first_skill_name(content.as_bytes()).unwrap_or_else(|| {
        if name.trim().is_empty() { skill_slug.to_string() } else { name.trim().to_string() }
    });
    let content_hash = hash_bytes(content.as_bytes());
    let skill = SkillInfo {
        id: format!("market:{}", &content_hash[..16]),
        name: display_name,
        source_path: source.display().to_string(),
        source_kind: "agentskill.sh".to_string(),
        content_hash,
        scope: "market".to_string(),
        managed: false,
    };
    install_resolved_skill(paths, source, skill, target)
}

fn is_safe_marketplace_segment(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn install_resolved_skill(
    paths: &WorkspacePaths,
    source: PathBuf,
    skill: SkillInfo,
    target: &str,
) -> Result<SkillDeployment> {
    let mut preview = preview_resolved_install(paths, source.clone(), skill, target)?;
    if !preview.can_install {
        bail!("{}", preview.reason);
    }

    let source_dir = source
        .parent()
        .context("SKILL.md must belong to a skill directory")?;
    let destination = PathBuf::from(&preview.destination);
    let destination_parent = destination
        .parent()
        .context("managed skill destination must have a parent directory")?;
    fs::create_dir_all(destination_parent).with_context(|| {
        format!(
            "creating managed skill target root {}",
            destination_parent.display()
        )
    })?;
    let staging = destination_parent.join(format!(".mydesk-staging-{}", uuid::Uuid::new_v4()));
    copy_skill_tree(source_dir, &staging)?;
    fs::rename(&staging, &destination).with_context(|| {
        format!(
            "activating managed skill {} from staged copy {}",
            destination.display(),
            staging.display()
        )
    })?;
    let tree_hash = hash_tree(&destination)?;

    let mut manifest = read_manifest(paths)?;
    let install = ManagedSkillInstall {
        id: format!("managed-skill:{}", uuid::Uuid::new_v4()),
        source_path: source.display().to_string(),
        destination: destination.display().to_string(),
        target: target.to_string(),
        tree_hash,
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    manifest.installations.push(install.clone());
    write_manifest(paths, &manifest)?;

    preview.managed_id = Some(install.id);
    preview.skill.managed = true;
    preview.reason =
        "Managed copy installed. The manifest owns only this exact destination.".to_string();
    Ok(preview)
}

pub fn uninstall_skill(paths: &WorkspacePaths, managed_id: &str) -> Result<ManagedSkillInstall> {
    let mut manifest = read_manifest(paths)?;
    let index = manifest
        .installations
        .iter()
        .position(|install| install.id == managed_id)
        .ok_or_else(|| anyhow::anyhow!("No managed skill installation matches {managed_id}"))?;
    let install = manifest.installations[index].clone();
    let target_root = target_root(paths, &install.target)?;
    let destination = PathBuf::from(&install.destination);
    ensure_safe_managed_destination(&target_root, &destination)?;
    let actual_hash = hash_tree(&destination)?;
    if actual_hash != install.tree_hash {
        bail!(
            "Refusing to remove {} because it no longer matches its managed manifest. Review it manually.",
            destination.display()
        );
    }

    snapshot_managed_skill(paths, &install)?;

    fs::remove_dir_all(&destination)
        .with_context(|| format!("removing managed skill {}", destination.display()))?;
    manifest.installations.remove(index);
    write_manifest(paths, &manifest)?;
    Ok(install)
}

/// Reads a SKILL.md only when it is already part of Möbius' discoverable
/// catalogue or an exact managed installation. This deliberately does not
/// turn the desktop IPC into an arbitrary local-file reader.
pub fn read_skill_content(paths: &WorkspacePaths, source_path: &str) -> Result<String> {
    let discovered = discover_standard_skills(paths, None)?;
    read_known_or_managed_skill_content(paths, source_path, &discovered)
}

/// Reads a caller-supplied, already-enumerated skill path. Desktop uses this
/// for a skill discovered beneath a registered checkout. Keeping the known
/// list explicit prevents a path from becoming readable merely because it
/// happens to be named SKILL.md.
pub fn read_known_skill_content(source_path: &str, known_skills: &[SkillInfo]) -> Result<String> {
    let source = canonical_regular_skill_document(Path::new(source_path))?;
    if !known_skills
        .iter()
        .any(|skill| same_path(Path::new(&skill.source_path), &source))
    {
        bail!("Skill was not found in the supplied discovered skill catalogue.");
    }
    read_canonical_skill_content(&source)
}

/// Reads a desktop-catalogued skill, or the exact document of a
/// M枚bius-managed installation. The latter exception is necessary because a
/// managed copy can be selected immediately after installation, before a UI
/// catalogue refresh has observed the new file. It remains bounded by both the
/// manifest and the target-root safety check, so an arbitrary local `SKILL.md`
/// never becomes readable through the desktop IPC.
pub fn read_known_or_managed_skill_content(
    paths: &WorkspacePaths,
    source_path: &str,
    known_skills: &[SkillInfo],
) -> Result<String> {
    let source = canonical_regular_skill_document(Path::new(source_path))?;
    let is_known = known_skills
        .iter()
        .any(|skill| same_path(Path::new(&skill.source_path), &source));
    let is_managed = read_manifest(paths)?.installations.iter().any(|install| {
        managed_skill_document(paths, install)
            .map(|document| same_path(&document, &source))
            .unwrap_or(false)
    });
    if !is_known && !is_managed {
        bail!(
            "Skill is not a discovered source or an exact managed installation; arbitrary files cannot be read."
        );
    }
    read_canonical_skill_content(&source)
}

fn read_canonical_skill_content(source: &Path) -> Result<String> {
    let bytes = fs::read(source).with_context(|| format!("reading {}", source.display()))?;
    if bytes.len() > MAX_SKILL_CONTENT_BYTES {
        bail!(
            "SKILL.md exceeds the {} MiB editor safety limit.",
            MAX_SKILL_CONTENT_BYTES / 1024 / 1024
        );
    }
    String::from_utf8(bytes).context("SKILL.md must be valid UTF-8 to edit in Möbius")
}

/// Replaces only the SKILL.md file inside an existing Möbius-managed copy.
/// The source skill is never changed. The replacement is staged beside the
/// destination and then atomically renamed; after it is active the managed
/// tree hash is refreshed in Möbius' own manifest.
pub fn write_managed_skill(
    paths: &WorkspacePaths,
    managed_id: &str,
    content: &str,
) -> Result<ManagedSkillInstall> {
    if content.as_bytes().len() > MAX_SKILL_CONTENT_BYTES {
        bail!(
            "SKILL.md exceeds the {} MiB editor safety limit.",
            MAX_SKILL_CONTENT_BYTES / 1024 / 1024
        );
    }
    let mut manifest = read_manifest(paths)?;
    let index = manifest
        .installations
        .iter()
        .position(|install| install.id == managed_id)
        .ok_or_else(|| anyhow::anyhow!("No managed skill installation matches {managed_id}"))?;
    let install = manifest.installations[index].clone();
    let document = managed_skill_document(paths, &install)?;
    let original = fs::read(&document)
        .with_context(|| format!("reading managed skill {}", document.display()))?;

    snapshot_managed_skill(paths, &install)?;

    atomic_replace_skill_document(&document, content.as_bytes())?;
    let refreshed_hash = match hash_tree(Path::new(&install.destination)) {
        Ok(hash) => hash,
        Err(error) => {
            // Do not leave a user with a file changed but an out-of-date
            // manifest when post-write validation fails unexpectedly.
            let _ = atomic_replace_skill_document(&document, &original);
            return Err(error).context("validating edited managed skill tree");
        }
    };
    manifest.installations[index].tree_hash = refreshed_hash;
    if let Err(error) = write_manifest(paths, &manifest) {
        let _ = atomic_replace_skill_document(&document, &original);
        return Err(error).context("recording edited managed skill manifest");
    }
    Ok(manifest.installations[index].clone())
}

fn skill_history_root(paths: &WorkspacePaths, managed_id: &str) -> PathBuf {
    paths.catalog_root.join("Mobius").join("SkillHistory").join(hash_bytes(managed_id.as_bytes()))
}

fn snapshot_managed_skill(paths: &WorkspacePaths, install: &ManagedSkillInstall) -> Result<SkillHistoryEntry> {
    let document = managed_skill_document(paths, install)?;
    let content = fs::read(&document).with_context(|| format!("reading history source {}", document.display()))?;
    let content_hash = hash_bytes(&content);
    let created_at = chrono::Utc::now().to_rfc3339();
    let id = format!("{}-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"), &content_hash[..12]);
    let root = skill_history_root(paths, &install.id);
    fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
    let target = root.join(format!("{id}.md"));
    if !target.exists() { fs::write(&target, &content).with_context(|| format!("writing {}", target.display()))?; }
    Ok(SkillHistoryEntry { id, managed_id: install.id.clone(), created_at, content_hash })
}

pub fn list_skill_history(paths: &WorkspacePaths, managed_id: &str) -> Result<Vec<SkillHistoryEntry>> {
    let root = skill_history_root(paths, managed_id);
    if !root.is_dir() { return Ok(Vec::new()); }
    let mut entries = fs::read_dir(root)?.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        let id = name.strip_suffix(".md")?.to_string();
        let hash = id.rsplit('-').next()?.to_string();
        let created = id.split('-').next()?.to_string();
        Some(SkillHistoryEntry { id, managed_id: managed_id.to_string(), created_at: created, content_hash: hash })
    }).collect::<Vec<_>>();
    entries.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(entries)
}

pub fn restore_skill_history(paths: &WorkspacePaths, managed_id: &str, history_id: &str) -> Result<ManagedSkillInstall> {
    if history_id.contains(['/', '\\']) || !history_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.')) {
        bail!("invalid skill history id");
    }
    let source = skill_history_root(paths, managed_id).join(format!("{history_id}.md"));
    let content = read_canonical_skill_content(&source)?;
    write_managed_skill(paths, managed_id, &content)
}

pub fn hash_bytes(contents: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(contents);
    hex::encode(hasher.finalize())
}

fn resolve_known_skill(paths: &WorkspacePaths, source_path: &str) -> Result<(PathBuf, SkillInfo)> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .with_context(|| format!("resolving source skill {}", source_path))?;
    if source.file_name().and_then(|item| item.to_str()) != Some("SKILL.md") {
        bail!("A managed deployment must start from a SKILL.md file.");
    }

    for root in standard_skill_roots(paths)
        .into_iter()
        .chain(project_skill_roots(&paths.workspace_root))
    {
        if !root.path.exists() {
            continue;
        }
        let canonical_root = root
            .path
            .canonicalize()
            .with_context(|| format!("resolving declared skill root {}", root.path.display()))?;
        if !source.starts_with(&canonical_root) {
            continue;
        }
        let skill = scan_skill_root(&root.path, &root.scope, &root.source_kind)?
            .into_iter()
            .find(|skill| same_path(Path::new(&skill.source_path), &source))
            .context("source is not a discoverable SKILL.md package")?;
        return Ok((source, skill));
    }

    bail!(
        "Source is outside the configured global/project skill roots. Discover it first instead of copying an arbitrary directory."
    )
}

fn resolve_known_skill_from_catalogue(
    source_path: &str,
    known_skills: &[SkillInfo],
) -> Result<(PathBuf, SkillInfo)> {
    let source = PathBuf::from(source_path)
        .canonicalize()
        .with_context(|| format!("resolving source skill {source_path}"))?;
    if source.file_name().and_then(|item| item.to_str()) != Some("SKILL.md") {
        bail!("A managed deployment must start from a SKILL.md file.");
    }
    let skill = known_skills
        .iter()
        .find(|skill| same_path(Path::new(&skill.source_path), &source))
        .cloned()
        .context("source is not part of the supplied discovered skill catalogue")?;
    Ok((source, skill))
}

fn target_root(paths: &WorkspacePaths, target: &str) -> Result<PathBuf> {
    let (user, codex_home) = standard_harness_homes(paths);
    target_root_for_harness(paths, target, &user, &codex_home)
}

/// Resolves a managed skill destination using the same Harness profile that
/// was used to build the discovery catalogue. Kept separate from environment
/// lookup so the isolation contract is directly testable without mutating
/// process-wide environment variables.
fn target_root_for_harness(
    paths: &WorkspacePaths,
    target: &str,
    user: &Path,
    codex_home: &Path,
) -> Result<PathBuf> {
    if let Some(workspace) = target.strip_prefix("project:") {
        let workspace = PathBuf::from(workspace)
            .canonicalize()
            .with_context(|| format!("resolving project skill target {workspace}"))?;
        return Ok(workspace.join(".agents/skills"));
    }

    match target {
        "global" => Ok(user.join(".agents/skills")),
        "project" => Ok(paths.workspace_root.join(".agents/skills")),
        "codex" => Ok(codex_home.join("skills")),
        "claude" => Ok(user.join(".claude/skills")),
        "pi" => Ok(user.join(".pi/skills")),
        "grok" => Ok(user.join(".grok/skills")),
        _ => bail!(
            "Unsupported skill target {target}. Use global, project:<registered-checkout>, codex, claude, pi, or grok."
        ),
    }
}

fn copy_skill_tree(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        bail!("Destination already exists: {}", destination.display());
    }
    fs::create_dir_all(destination)
        .with_context(|| format!("creating managed skill directory {}", destination.display()))?;

    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        if entry.path() == source {
            continue;
        }
        if entry.file_type().is_symlink() {
            bail!(
                "Refusing to copy symbolic link in a managed skill: {}",
                entry.path().display()
            );
        }
        let relative = entry.path().strip_prefix(source)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target).with_context(|| {
                format!(
                    "copying managed skill file {} to {}",
                    entry.path().display(),
                    target.display()
                )
            })?;
        }
    }
    Ok(())
}

fn ensure_safe_managed_destination(target_root: &Path, destination: &Path) -> Result<()> {
    let canonical_root = target_root
        .canonicalize()
        .with_context(|| format!("resolving skill target root {}", target_root.display()))?;
    let canonical_destination = destination
        .canonicalize()
        .with_context(|| format!("resolving managed destination {}", destination.display()))?;
    if canonical_destination == canonical_root
        || canonical_destination.parent() != Some(canonical_root.as_path())
        || !canonical_destination.starts_with(&canonical_root)
    {
        bail!(
            "Managed destination {} is not an immediate child of its declared target root.",
            destination.display()
        );
    }
    Ok(())
}

fn canonical_regular_skill_document(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("reading skill document metadata {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        bail!("SKILL.md must be a regular file, not a symbolic link.");
    }
    if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        bail!("Skill document must be named SKILL.md.");
    }
    path.canonicalize()
        .with_context(|| format!("resolving skill document {}", path.display()))
}

fn managed_skill_document(
    paths: &WorkspacePaths,
    install: &ManagedSkillInstall,
) -> Result<PathBuf> {
    let target_root = target_root(paths, &install.target)?;
    let destination = PathBuf::from(&install.destination);
    ensure_safe_managed_destination(&target_root, &destination)?;
    let document = canonical_regular_skill_document(&destination.join("SKILL.md"))?;
    let canonical_destination = destination
        .canonicalize()
        .with_context(|| format!("resolving managed destination {}", destination.display()))?;
    if document.parent() != Some(canonical_destination.as_path()) {
        bail!("Managed SKILL.md must be directly inside its declared destination.");
    }
    Ok(document)
}

fn atomic_replace_skill_document(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("SKILL.md must have a parent directory")?;
    let mut temporary = NamedTempFile::new_in(parent)
        .with_context(|| format!("staging edited skill beside {}", path.display()))?;
    temporary.write_all(content)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    let temporary_path = temporary.into_temp_path();
    fs::rename(&temporary_path, path)
        .with_context(|| format!("atomically replacing managed skill {}", path.display()))?;
    Ok(())
}

fn read_manifest(paths: &WorkspacePaths) -> Result<SkillManifest> {
    let path = paths.skills_manifest_path();
    if !path.exists() {
        return Ok(SkillManifest::default());
    }
    let contents = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let manifest: SkillManifest =
        serde_json::from_slice(&contents).with_context(|| format!("parsing {}", path.display()))?;
    if manifest.version != MANIFEST_VERSION {
        bail!(
            "Unsupported managed skills manifest version {}",
            manifest.version
        );
    }
    Ok(manifest)
}

fn write_manifest(paths: &WorkspacePaths, manifest: &SkillManifest) -> Result<()> {
    let path = paths.skills_manifest_path();
    let parent = path
        .parent()
        .context("managed skills manifest must have a parent directory")?;
    fs::create_dir_all(parent)?;

    if path.exists() {
        let history = parent.join("history");
        fs::create_dir_all(&history)?;
        let snapshot = history.join(format!(
            "managed-skills-{}.json",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        ));
        fs::copy(&path, &snapshot).with_context(|| {
            format!(
                "snapshotting managed skills manifest to {}",
                snapshot.display()
            )
        })?;
    }

    let mut temporary = NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, manifest)?;
    temporary.write_all(b"\n")?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    let temporary_path = temporary.into_temp_path();
    fs::rename(&temporary_path, &path)
        .with_context(|| format!("replacing managed skills manifest {}", path.display()))?;
    Ok(())
}

fn hash_tree(root: &Path) -> Result<String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if entry.file_type().is_symlink() {
            bail!(
                "Managed skill contains a symbolic link: {}",
                entry.path().display()
            );
        }
        if entry.file_type().is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, fs::read(entry.path())?));
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (relative, contents) in files {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(contents);
        hasher.update([0]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    canonical_or_original(left) == canonical_or_original(right)
}

fn first_skill_name(contents: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(contents).ok()?;
    for line in text.lines().take(20) {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("name:") {
            return Some(name.trim().trim_matches('"').to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        discover_project_skills, hash_tree, install_skill, install_skill_from_catalogue,
        list_managed_installations, list_skill_history, read_known_or_managed_skill_content,
        read_skill_content, restore_skill_history, scan_skill_root, target_root_for_harness,
        write_managed_skill,
    };
    use crate::WorkspacePaths;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn paths(root: &Path) -> WorkspacePaths {
        WorkspacePaths {
            workspace_root: root.join("workspace"),
            data_root: root.join("data"),
            artifacts_root: root.join("artifacts"),
            catalog_root: root.join("catalog"),
        }
    }

    #[test]
    fn discovers_skill_manifest() {
        let directory = tempfile::tempdir().expect("temp directory");
        let skill = directory.path().join("sample/SKILL.md");
        fs::create_dir_all(skill.parent().expect("skill parent")).expect("create directory");
        fs::write(&skill, "name: sample\n\n# Sample").expect("write skill");

        let discovered = scan_skill_root(directory.path(), "project", "test").expect("scan");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "sample");
        assert_eq!(
            hash_tree(Path::new(skill.parent().expect("parent")))
                .expect("hash")
                .len(),
            64
        );
    }

    #[test]
    fn managed_global_targets_follow_the_discovery_harness_home() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let paths = paths(temporary.path());
        let harness_home = temporary.path().join("isolated-harness-home");
        let codex_home = harness_home.join("codex-profile");

        assert_eq!(
            target_root_for_harness(&paths, "global", &harness_home, &codex_home)
                .expect("global target"),
            harness_home.join(".agents/skills")
        );
        assert_eq!(
            target_root_for_harness(&paths, "claude", &harness_home, &codex_home)
                .expect("claude target"),
            harness_home.join(".claude/skills")
        );
        assert_eq!(
            target_root_for_harness(&paths, "codex", &harness_home, &codex_home)
                .expect("codex target"),
            codex_home.join("skills")
        );
        assert!(target_root_for_harness(&paths, "apodex", &harness_home, &codex_home).is_err());
    }

    #[test]
    fn reads_and_atomically_edits_only_an_existing_managed_copy() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let source = paths.workspace_root.join(".agents/skills/demo/SKILL.md");
        fs::create_dir_all(source.parent().expect("source parent")).expect("source directory");
        fs::write(&source, "name: demo\n\n# Original\n").expect("source skill");
        let checkout = temporary.path().join("registered-checkout");
        fs::create_dir_all(&checkout).expect("checkout");
        let target = format!("project:{}", checkout.display());

        let deployment = install_skill(&paths, &source.display().to_string(), &target)
            .expect("install managed copy");
        let managed_id = deployment.managed_id.expect("managed id");
        let document = PathBuf::from(&deployment.destination).join("SKILL.md");
        assert_eq!(
            read_skill_content(&paths, &document.display().to_string()).expect("read managed"),
            "name: demo\n\n# Original\n"
        );

        let edited = "name: demo\n\n# Edited locally\n";
        let install = write_managed_skill(&paths, &managed_id, edited).expect("edit managed");
        assert_eq!(
            fs::read_to_string(&document).expect("edited content"),
            edited
        );
        assert_eq!(
            fs::read_to_string(&source).expect("source untouched"),
            "name: demo\n\n# Original\n"
        );
        assert_eq!(
            install.tree_hash,
            hash_tree(Path::new(&deployment.destination)).expect("refreshed tree hash")
        );
        assert_eq!(
            list_managed_installations(&paths)
                .expect("manifest")
                .into_iter()
                .find(|item| item.id == managed_id)
                .expect("managed install")
                .tree_hash,
            install.tree_hash
        );
        let history = list_skill_history(&paths, &managed_id).expect("history");
        assert_eq!(history.len(), 1);
        restore_skill_history(&paths, &managed_id, &history[0].id).expect("restore history");
        assert_eq!(
            fs::read_to_string(&document).expect("restored content"),
            "name: demo\n\n# Original\n"
        );

        let arbitrary = temporary.path().join("arbitrary/SKILL.md");
        fs::create_dir_all(arbitrary.parent().expect("arbitrary parent")).expect("arbitrary dir");
        fs::write(&arbitrary, "name: arbitrary").expect("arbitrary file");
        assert!(read_skill_content(&paths, &arbitrary.display().to_string()).is_err());
        assert!(write_managed_skill(&paths, "managed-skill:missing", "x").is_err());
    }

    #[test]
    fn exact_manifest_owned_skill_can_be_read_before_catalogue_refresh() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let source = paths.workspace_root.join(".agents/skills/source/SKILL.md");
        fs::create_dir_all(source.parent().expect("source parent")).expect("source directory");
        fs::write(&source, "name: source\n\n# Source\n").expect("source skill");
        let checkout = temporary.path().join("registered-checkout");
        fs::create_dir_all(&checkout).expect("checkout");
        let target = format!("project:{}", checkout.display());
        let deployment = install_skill(&paths, &source.display().to_string(), &target)
            .expect("install managed copy");
        let managed_document = PathBuf::from(&deployment.destination).join("SKILL.md");

        assert_eq!(
            read_known_or_managed_skill_content(
                &paths,
                &managed_document.display().to_string(),
                &[],
            )
            .expect("manifest-owned document remains readable"),
            "name: source\n\n# Source\n"
        );

        let arbitrary = temporary.path().join("unmanaged/SKILL.md");
        fs::create_dir_all(arbitrary.parent().expect("arbitrary parent")).expect("arbitrary dir");
        fs::write(&arbitrary, "name: arbitrary\n").expect("arbitrary skill");
        assert!(
            read_known_or_managed_skill_content(&paths, &arbitrary.display().to_string(), &[],)
                .is_err()
        );
    }

    #[test]
    fn discovers_supported_project_harness_roots_and_deploys_only_catalogued_source() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let paths = paths(temporary.path());
        paths.ensure_layout().expect("layout");
        let checkout = temporary.path().join("registered-checkout");
        let claude = checkout.join(".claude/skills/claude-local/SKILL.md");
        let apodex = checkout.join(".apodex/skills/apodex-local/SKILL.md");
        fs::create_dir_all(claude.parent().expect("claude parent")).expect("create claude root");
        fs::create_dir_all(apodex.parent().expect("apodex parent")).expect("create apodex root");
        fs::write(&claude, "name: claude-local\n\n# Claude").expect("write claude skill");
        fs::write(&apodex, "name: apodex-local\n\n# Apodex").expect("write apodex skill");

        let catalogue = discover_project_skills(&checkout).expect("discover project roots");
        assert_eq!(catalogue.len(), 1);
        assert!(catalogue.iter().any(|skill| skill.source_kind == "claude"));
        assert!(!catalogue.iter().any(|skill| skill.source_kind == "apodex"));

        let target_checkout = temporary.path().join("target-checkout");
        fs::create_dir_all(&target_checkout).expect("target checkout");
        let target = format!("project:{}", target_checkout.display());
        let deployment = install_skill_from_catalogue(
            &paths,
            &claude.display().to_string(),
            &catalogue,
            &target,
        )
        .expect("install catalogued project skill");
        assert!(
            Path::new(&deployment.destination)
                .join("SKILL.md")
                .is_file()
        );

        let arbitrary = temporary.path().join("unregistered/SKILL.md");
        fs::create_dir_all(arbitrary.parent().expect("arbitrary parent")).expect("arbitrary root");
        fs::write(&arbitrary, "name: unregistered").expect("arbitrary skill");
        assert!(
            install_skill_from_catalogue(
                &paths,
                &arbitrary.display().to_string(),
                &catalogue,
                &target,
            )
            .is_err()
        );
    }
}
