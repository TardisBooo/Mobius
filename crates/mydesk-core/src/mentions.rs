use crate::{ContextHit, ContextKind, Database, Mention, MentionKind, SearchFilter, SearchRequest};
use anyhow::Result;
use regex::Regex;

pub fn parse_mentions(input: &str) -> Vec<Mention> {
    let expression = Regex::new(
        r"@(?P<kind>project|session|note|board):(?P<reference>[A-Za-z0-9_./-]+)(?:#(?P<node>[A-Za-z0-9_./-]+))?",
    )
    .expect("mention grammar is a static valid regex");

    expression
        .captures_iter(input)
        .filter_map(|capture| {
            let kind = match capture.name("kind")?.as_str() {
                "project" => MentionKind::Project,
                "session" => MentionKind::Session,
                "note" => MentionKind::Note,
                "board" => MentionKind::Board,
                _ => return None,
            };
            let reference = trim_terminal_punctuation(capture.name("reference")?.as_str());
            if reference.is_empty() {
                return None;
            }
            let node = capture
                .name("node")
                .map(|node| trim_terminal_punctuation(node.as_str()))
                .filter(|node| !node.is_empty())
                .map(str::to_string);
            Some(Mention {
                kind,
                reference: reference.to_string(),
                node,
            })
        })
        .collect()
}

fn trim_terminal_punctuation(value: &str) -> &str {
    value.trim_end_matches(|character: char| {
        matches!(
            character,
            '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}'
        )
    })
}

pub fn resolve_mentions(
    database: &Database,
    input: &str,
    per_mention: usize,
) -> Result<Vec<ContextHit>> {
    let mut hits = Vec::new();
    for mention in parse_mentions(input) {
        let mut request = SearchRequest {
            query: mention.reference.clone(),
            filter: SearchFilter::default(),
            limit: per_mention.clamp(1, 8),
        };
        match mention.kind {
            MentionKind::Project => {
                request.query.clear();
                request.filter.project_slug = Some(mention.reference);
            }
            MentionKind::Session => {
                request.filter.kind = Some(ContextKind::Session);
            }
            MentionKind::Note => {
                request.filter.kind = Some(ContextKind::Note);
            }
            MentionKind::Board => {
                request.filter.kind = Some(ContextKind::Board);
            }
        }
        hits.extend(database.search_contexts(&request)?);
    }
    hits.sort_by(|left, right| left.id.cmp(&right.id));
    hits.dedup_by(|left, right| left.id == right.id);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_supported_mention_kinds() {
        let mentions = parse_mentions(
            "Use @project:mydesk with @session:codex/abc, @note:memory-model and @board:map#node-1.",
        );
        assert_eq!(mentions.len(), 4);
        assert_eq!(mentions[0].kind, MentionKind::Project);
        assert_eq!(mentions[3].node.as_deref(), Some("node-1"));
    }
}
