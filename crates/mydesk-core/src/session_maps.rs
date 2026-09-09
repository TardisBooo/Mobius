use anyhow::{Context, Result, bail};
use chrono::Utc;
use csv::{ReaderBuilder, StringRecord, Trim};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

const MAX_STRUCTURED_MAP_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionMapEntry {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
    pub source_path: String,
    pub status: Option<String>,
    pub discovered_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionMapLoadReport {
    pub root: String,
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub invalid_rows: usize,
    pub entries: Vec<SessionMapEntry>,
}

#[derive(Clone, Debug, Default)]
pub struct SessionMapCatalog {
    entries: Vec<SessionMapEntry>,
}

impl SessionMapCatalog {
    pub fn load(root: &Path) -> Result<SessionMapLoadReport> {
        if !root.is_dir() {
            bail!("SessionMaps root is not a directory: {}", root.display());
        }
        let mut report = SessionMapLoadReport {
            root: root.display().to_string(),
            ..SessionMapLoadReport::default()
        };
        for entry in WalkDir::new(root).follow_links(false) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    report.files_skipped += 1;
                    continue;
                }
            };
            if !entry.file_type().is_file() || entry.file_type().is_symlink() {
                continue;
            }
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "csv" | "json" | "jsonl") {
                continue;
            }
            if fs::metadata(path)
                .map(|item| item.len())
                .unwrap_or(u64::MAX)
                > MAX_STRUCTURED_MAP_BYTES
            {
                report.files_skipped += 1;
                continue;
            }
            report.files_scanned += 1;
            let parsed = match extension.as_str() {
                "csv" => read_csv(path, &mut report.invalid_rows),
                "json" => read_json(path, &mut report.invalid_rows),
                "jsonl" => read_jsonl(path, &mut report.invalid_rows),
                _ => unreachable!(),
            };
            match parsed {
                Ok(mut entries) => report.entries.append(&mut entries),
                Err(_) => report.files_skipped += 1,
            }
        }
        deduplicate(&mut report.entries);
        report.entries.sort_by(|left, right| {
            component_count(&right.old_path)
                .cmp(&component_count(&left.old_path))
                .then_with(|| left.old_path.cmp(&right.old_path))
        });
        Ok(report)
    }

    pub fn from_entries(mut entries: Vec<SessionMapEntry>) -> Self {
        deduplicate(&mut entries);
        entries.sort_by_key(|entry| std::cmp::Reverse(component_count(&entry.old_path)));
        Self { entries }
    }

    pub fn entries(&self) -> &[SessionMapEntry] {
        &self.entries
    }

    pub fn resolve_forward(&self, historical_path: &Path) -> Option<PathBuf> {
        self.entries.iter().find_map(|entry| {
            strip_prefix_case_insensitive(historical_path, Path::new(&entry.old_path)).map(
                |remaining| {
                    let mut resolved = PathBuf::from(&entry.new_path);
                    for component in remaining {
                        resolved.push(component);
                    }
                    resolved
                },
            )
        })
    }
}

fn read_csv(path: &Path, invalid_rows: &mut usize) -> Result<Vec<SessionMapEntry>> {
    let mut reader = ReaderBuilder::new()
        .flexible(true)
        .trim(Trim::All)
        .from_path(path)
        .with_context(|| format!("reading SessionMaps CSV {}", path.display()))?;
    let headers = reader.headers()?.clone();
    let old_index = header_index(
        &headers,
        &["oldpath", "oldcwd", "originalcwd", "sourcepath"],
    );
    let new_index = header_index(
        &headers,
        &["newpath", "newcwd", "destinationpath", "targetpath"],
    );
    let status_index = header_index(&headers, &["status", "state", "mappingmode"]);
    let (Some(old_index), Some(new_index)) = (old_index, new_index) else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for row in reader.records() {
        let row = match row {
            Ok(row) => row,
            Err(_) => {
                *invalid_rows += 1;
                continue;
            }
        };
        let old_path = row.get(old_index).unwrap_or_default().trim();
        let new_path = row.get(new_index).unwrap_or_default().trim();
        if !valid_mapping(old_path, new_path) {
            *invalid_rows += 1;
            continue;
        }
        entries.push(new_entry(
            old_path,
            new_path,
            path,
            status_index
                .and_then(|index| row.get(index))
                .filter(|value| !value.trim().is_empty()),
        ));
    }
    Ok(entries)
}

fn read_json(path: &Path, invalid_rows: &mut usize) -> Result<Vec<SessionMapEntry>> {
    let value: Value = serde_json::from_reader(
        fs::File::open(path).with_context(|| format!("opening {}", path.display()))?,
    )?;
    let mut entries = Vec::new();
    collect_json_mappings(&value, path, &mut entries, invalid_rows);
    Ok(entries)
}

fn read_jsonl(path: &Path, invalid_rows: &mut usize) -> Result<Vec<SessionMapEntry>> {
    let contents = fs::read_to_string(path)?;
    let mut entries = Vec::new();
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => collect_json_mappings(&value, path, &mut entries, invalid_rows),
            Err(_) => *invalid_rows += 1,
        }
    }
    Ok(entries)
}

fn collect_json_mappings(
    value: &Value,
    source: &Path,
    entries: &mut Vec<SessionMapEntry>,
    invalid_rows: &mut usize,
) {
    match value {
        Value::Object(object) => {
            let field = |names: &[&str]| {
                object.iter().find_map(|(key, value)| {
                    names
                        .contains(&normalize_header(key).as_str())
                        .then(|| value.as_str())
                        .flatten()
                })
            };
            let old = field(&["oldpath", "oldcwd", "originalcwd", "sourcepath"]);
            let new = field(&["newpath", "newcwd", "destinationpath", "targetpath"]);
            if let (Some(old), Some(new)) = (old, new) {
                if valid_mapping(old, new) {
                    entries.push(new_entry(
                        old,
                        new,
                        source,
                        field(&["status", "state", "mappingmode"]),
                    ));
                } else {
                    *invalid_rows += 1;
                }
            }
            for child in object.values() {
                collect_json_mappings(child, source, entries, invalid_rows);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_json_mappings(child, source, entries, invalid_rows);
            }
        }
        _ => {}
    }
}

fn header_index(headers: &StringRecord, candidates: &[&str]) -> Option<usize> {
    headers
        .iter()
        .position(|header| candidates.contains(&normalize_header(header).as_str()))
}

fn normalize_header(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn valid_mapping(old_path: &str, new_path: &str) -> bool {
    let old = Path::new(old_path);
    let new = Path::new(new_path);
    old.is_absolute() && new.is_absolute() && old != new
}

fn new_entry(
    old_path: &str,
    new_path: &str,
    source: &Path,
    status: Option<&str>,
) -> SessionMapEntry {
    let source_path = source.display().to_string();
    let mut hasher = Sha256::new();
    hasher.update(normalize_path_key(old_path));
    hasher.update([0]);
    hasher.update(normalize_path_key(new_path));
    hasher.update([0]);
    hasher.update(source_path.as_bytes());
    SessionMapEntry {
        id: format!("path-map:{}", &hex::encode(hasher.finalize())[..24]),
        old_path: old_path.to_string(),
        new_path: new_path.to_string(),
        source_path,
        status: status.map(str::to_string),
        discovered_at: Utc::now().to_rfc3339(),
    }
}

fn deduplicate(entries: &mut Vec<SessionMapEntry>) {
    let mut seen = HashSet::new();
    entries.retain(|entry| {
        seen.insert((
            normalize_path_key(&entry.old_path),
            normalize_path_key(&entry.new_path),
        ))
    });
}

fn normalize_path_key(value: &str) -> String {
    value
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn component_count(value: &str) -> usize {
    Path::new(value).components().count()
}

fn strip_prefix_case_insensitive(path: &Path, prefix: &Path) -> Option<Vec<PathBuf>> {
    let path_components = path.components().collect::<Vec<_>>();
    let prefix_components = prefix.components().collect::<Vec<_>>();
    if prefix_components.len() > path_components.len() {
        return None;
    }
    if !prefix_components
        .iter()
        .zip(&path_components)
        .all(|(left, right)| {
            left.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
        })
    {
        return None;
    }
    Some(
        path_components[prefix_components.len()..]
            .iter()
            .map(|component| PathBuf::from(component.as_os_str()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_mixed_csv_headers_and_prefers_longest_prefix() {
        let temporary = tempfile::tempdir().expect("temp");
        let root = temporary.path();
        fs::write(
            root.join("map.csv"),
            "OldPath,NewPath,State\nD:\\Data\\HC_PROJECT,E:\\Workspaces\\legacy,ACTIVE\nD:\\Data\\HC_PROJECT\\MyDesk,E:\\Workspaces\\MyDesk,ACTIVE\n",
        )
        .expect("write map");
        let report = SessionMapCatalog::load(root).expect("load");
        assert_eq!(report.entries.len(), 2);
        let catalog = SessionMapCatalog::from_entries(report.entries);
        assert_eq!(
            catalog
                .resolve_forward(Path::new(r"d:\data\hc_project\MYDESK\crates"))
                .expect("mapping"),
            PathBuf::from(r"E:\Workspaces\MyDesk\crates")
        );
    }

    #[test]
    fn reads_original_cwd_json_without_touching_it() {
        let temporary = tempfile::tempdir().expect("temp");
        let path = temporary.path().join("mapping.json");
        let original =
            r#"{"original_cwd":"D:\\Data\\HC_PROJECT\\A","new_cwd":"E:\\Workspaces\\A"}"#;
        fs::write(&path, original).expect("write");
        let report = SessionMapCatalog::load(temporary.path()).expect("load");
        assert_eq!(report.entries.len(), 1);
        assert_eq!(fs::read_to_string(path).expect("read"), original);
    }
}
