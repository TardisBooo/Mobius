use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TimelineCursor {
    pub epoch: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TimelineWindow {
    pub session_id: String,
    pub epoch: String,
    pub minimum_sequence: Option<u64>,
    pub maximum_sequence: Option<u64>,
    pub has_older: bool,
    pub has_newer: bool,
    pub catalogue_complete: bool,
}

impl TimelineWindow {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.session_id.trim().is_empty() || self.epoch.trim().is_empty() {
            return Err("timeline identity must not be empty");
        }
        if let (Some(minimum), Some(maximum)) = (self.minimum_sequence, self.maximum_sequence)
            && minimum > maximum
        {
            return Err("timeline sequence range is inverted");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReferenceReadMethods {
    pub cli: Option<String>,
    pub mcp: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReferenceEnvelope {
    pub schema: String,
    pub operation_id: String,
    pub target_workspace_id: String,
    pub entry_session_ids: Vec<String>,
    pub graph_revision: String,
    pub ancestor_session_ids: Vec<String>,
    pub read_via: ReferenceReadMethods,
}

impl ReferenceEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema != "mobius.references/v1" {
            return Err("unsupported reference envelope schema");
        }
        if self.operation_id.trim().is_empty()
            || self.target_workspace_id.trim().is_empty()
            || self.graph_revision.trim().is_empty()
            || self.entry_session_ids.is_empty()
        {
            return Err("reference envelope identity is incomplete");
        }
        if self.entry_session_ids.iter().any(|id| id.trim().is_empty())
            || self
                .ancestor_session_ids
                .iter()
                .any(|id| id.trim().is_empty())
        {
            return Err("reference envelope contains an empty session identity");
        }
        if self.read_via.cli.as_deref().is_none_or(str::is_empty)
            && self.read_via.mcp.as_deref().is_none_or(str::is_empty)
        {
            return Err("reference envelope needs at least one bounded read method");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_cursor_serializes_without_content_identity_guessing() {
        let cursor = TimelineCursor {
            epoch: "epoch-7".into(),
            sequence: 91,
        };
        assert_eq!(
            serde_json::to_value(cursor).unwrap(),
            serde_json::json!({"epoch":"epoch-7","sequence":91})
        );
    }

    #[test]
    fn envelope_requires_identity_and_a_read_path() {
        let mut envelope = ReferenceEnvelope {
            schema: "mobius.references/v1".into(),
            operation_id: "handoff:1".into(),
            target_workspace_id: "workspace:1".into(),
            entry_session_ids: vec!["session:b".into()],
            graph_revision: "revision:1".into(),
            ancestor_session_ids: vec!["session:a".into(), "session:b".into()],
            read_via: ReferenceReadMethods {
                cli: Some("mobius session show".into()),
                mcp: Some("mobius.read_session".into()),
            },
        };
        assert!(envelope.validate().is_ok());
        envelope.read_via = ReferenceReadMethods {
            cli: None,
            mcp: None,
        };
        assert!(envelope.validate().is_err());
    }

    #[test]
    fn inverted_timeline_window_is_rejected() {
        let window = TimelineWindow {
            session_id: "session:1".into(),
            epoch: "epoch:1".into(),
            minimum_sequence: Some(20),
            maximum_sequence: Some(10),
            has_older: false,
            has_newer: false,
            catalogue_complete: true,
        };
        assert!(window.validate().is_err());
    }
}
