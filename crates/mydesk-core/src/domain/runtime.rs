use serde::{Deserialize, Serialize};

/// Runtime state is deliberately separate from durable Session source state.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Initializing,
    Running,
    NeedsInput,
    Idle,
    Failed,
    Closed,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvidenceKind {
    ProviderEvent,
    Process,
    Pty,
    ScreenObservation,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCapability {
    CreateSession,
    NativeResume,
    Send,
    Interrupt,
    AttachTerminal,
    Stop,
    ListSessions,
    ReadHistory,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimeEvidence {
    pub kind: RuntimeEvidenceKind,
    pub observed_at: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AgentRuntime {
    pub id: String,
    pub workspace_id: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub state: RuntimeState,
    pub evidence: RuntimeEvidence,
    pub capabilities: Vec<RuntimeCapability>,
    pub process_id: Option<u32>,
    pub terminal_id: Option<String>,
}

impl AgentRuntime {
    /// Screen and generic process evidence can describe activity, but cannot
    /// establish which native Harness Session owns that activity.
    pub fn validate_identity_binding(&self) -> Result<(), &'static str> {
        if self.session_id.is_some()
            && matches!(
                self.evidence.kind,
                RuntimeEvidenceKind::ScreenObservation
                    | RuntimeEvidenceKind::Process
                    | RuntimeEvidenceKind::Pty
                    | RuntimeEvidenceKind::Unknown
            )
        {
            return Err("native session binding requires provider identity evidence");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(kind: RuntimeEvidenceKind, session_id: Option<&str>) -> AgentRuntime {
        AgentRuntime {
            id: "runtime:1".into(),
            workspace_id: "workspace:1".into(),
            provider: "codex".into(),
            session_id: session_id.map(str::to_owned),
            state: RuntimeState::Running,
            evidence: RuntimeEvidence {
                kind,
                observed_at: "2026-09-15T00:00:00Z".into(),
                detail: None,
            },
            capabilities: vec![RuntimeCapability::AttachTerminal],
            process_id: Some(42),
            terminal_id: Some("terminal:1".into()),
        }
    }

    #[test]
    fn screen_or_process_activity_cannot_claim_native_session_identity() {
        for kind in [
            RuntimeEvidenceKind::ScreenObservation,
            RuntimeEvidenceKind::Process,
            RuntimeEvidenceKind::Pty,
            RuntimeEvidenceKind::Unknown,
        ] {
            assert!(
                runtime(kind, Some("session:1"))
                    .validate_identity_binding()
                    .is_err()
            );
        }
        assert!(
            runtime(RuntimeEvidenceKind::ProviderEvent, Some("session:1"))
                .validate_identity_binding()
                .is_ok()
        );
    }

    #[test]
    fn unbound_runtime_can_report_observed_activity() {
        assert!(
            runtime(RuntimeEvidenceKind::ScreenObservation, None)
                .validate_identity_binding()
                .is_ok()
        );
    }
}
