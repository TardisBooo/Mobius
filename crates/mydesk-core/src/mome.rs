//! Local, explainable Mome recall.
//!
//! V1 has no network client, daemon, ANN index, or bundled embedding model.
//! It uses a regenerable SQLite FTS/BM25 chunk index. Local-model setup is
//! deliberately separate from recall, so recall never downloads a model or
//! silently sends source text to a local model service.

use crate::{
    Database, MAX_MOME_SESSION_SOURCES, MAX_MOME_TOKENS, MomeRecallRequest, MomeRecallResponse,
    MomeSemanticStatus, MomeSource,
};
use anyhow::{Result, bail};

#[derive(Clone, Debug)]
pub struct MomeRecall<'a> {
    database: &'a Database,
}

impl<'a> MomeRecall<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// Syncs only derived catalogue rows from already-indexed messages, then
    /// searches them. It never opens a Harness transcript path.
    pub fn recall(&self, request: &MomeRecallRequest) -> Result<MomeRecallResponse> {
        if request.providers.iter().any(|provider| !provider.is_supported()) {
            bail!("Mome recall provider is unsupported");
        }
        if request.query.trim().is_empty() {
            bail!("Mome recall needs a non-empty explicit query");
        }
        let max_tokens = request
            .max_tokens
            .unwrap_or(MAX_MOME_TOKENS)
            .clamp(1, MAX_MOME_TOKENS);
        self.database.sync_mome_chunks()?;
        let candidates = self.database.search_mome_chunks(request, 96)?;
        let mut sources = Vec::new();
        let mut used = 0usize;
        for candidate in candidates {
            if sources.len() == MAX_MOME_SESSION_SOURCES
                || sources.iter().any(|source: &MomeSource| {
                    source.session_record_id == candidate.session_record_id
                })
            {
                continue;
            }
            let remaining = max_tokens.saturating_sub(used);
            if remaining == 0 {
                break;
            }
            let (text, estimated_tokens) = truncate_to_tokens(&candidate.content, remaining);
            if text.is_empty() {
                continue;
            }
            used += estimated_tokens;
            sources.push(MomeSource {
                provider: candidate.provider,
                session_id: candidate.provider_session_id,
                session_record_id: candidate.session_record_id,
                start_ordinal: candidate.start_ordinal,
                end_ordinal: candidate.end_ordinal,
                citation: candidate.citation,
                content_hash: candidate.content_hash,
                text,
                estimated_tokens,
            });
        }
        Ok(MomeRecallResponse {
            query: request.query.trim().to_string(),
            retrieval_mode: "lexical_bm25".into(),
            semantic_status: MomeSemanticStatus::LexicalOnlyNoSemanticBackendConfigured,
            max_tokens,
            estimated_tokens: used,
            sources,
        })
    }
}

/// Conservative local estimate: CJK codepoints are token-like, while other
/// runs use four characters per token. It is intentionally a budget ceiling.
pub(crate) fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for character in text.chars() {
        if is_cjk(character) {
            cjk += 1;
        } else if !character.is_whitespace() {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

pub(crate) fn truncate_to_tokens(text: &str, budget: usize) -> (String, usize) {
    let mut output = String::new();
    for character in text.chars() {
        output.push(character);
        if estimate_tokens(&output) > budget {
            output.pop();
            break;
        }
    }
    let output = output.trim_end().to_string();
    (output.clone(), estimate_tokens(&output))
}

pub(crate) fn is_cjk(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_token_budget_handles_cjk_and_never_overshoots() {
        assert_eq!(estimate_tokens("你好世界"), 4);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        let (value, tokens) = truncate_to_tokens("你好世界", 2);
        assert_eq!(value, "你好");
        assert_eq!(tokens, 2);
    }
}
