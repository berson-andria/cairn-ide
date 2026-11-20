use crate::services::task_service::{NewSubTask, NewTask};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    Task,
    Tasks,
    Subtasks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presentation {
    Display,
    Notify,
}

impl Default for Presentation {
    fn default() -> Self {
        Self::Notify
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchTaskItem {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub anchor: Option<crate::types::task::FileAnchor>,
    pub linked_note_ids: Option<Vec<String>>,
    #[serde(rename = "subTasks")]
    pub sub_tasks: Option<Vec<NewSubTask>>,
    pub depends_on: Option<String>,
    pub depends_on_key: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub branch: Option<String>,
}

impl BatchTaskItem {
    pub fn as_new_task(&self, depends_on: Option<String>) -> NewTask {
        NewTask {
            title: self.title.clone(),
            description: self.description.clone(),
            anchor: self.anchor.clone(),
            linked_note_ids: self.linked_note_ids.clone(),
            sub_tasks: self.sub_tasks.clone(),
            depends_on,
            acceptance_criteria: self.acceptance_criteria.clone(),
            branch: self.branch.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TasksPayload {
    pub source_task_id: Option<String>,
    pub items: Vec<BatchTaskItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtasksPayload {
    pub task_id: String,
    pub items: Vec<NewSubTask>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProposalPayload {
    Task(NewTask),
    Tasks(TasksPayload),
    Subtasks(SubtasksPayload),
}

impl ProposalPayload {
    pub fn matches_kind(&self, kind: ProposalKind) -> bool {
        matches!(
            (kind, self),
            (ProposalKind::Task, Self::Task(_))
                | (ProposalKind::Tasks, Self::Tasks(_))
                | (ProposalKind::Subtasks, Self::Subtasks(_))
        )
    }

    pub fn title(&self) -> String {
        match self {
            Self::Task(task) => task.title.clone(),
            Self::Tasks(tasks) => tasks
                .items
                .first()
                .map(|item| item.title.clone())
                .unwrap_or_default(),
            Self::Subtasks(subtasks) => format!("Subtasks for {}", subtasks.task_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub kind: ProposalKind,
    pub status: ProposalStatus,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub workflow: String,
    pub payload: ProposalPayload,
    pub presentation: Presentation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_task_ids: Option<Vec<String>>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<u64>,
    pub schema_version: u32,
    pub rev: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalFields {
    id: String,
    kind: ProposalKind,
    status: ProposalStatus,
    run_id: String,
    task_id: Option<String>,
    workflow: String,
    payload: ProposalPayload,
    #[serde(default)]
    presentation: Presentation,
    seen_at: Option<u64>,
    created_task_id: Option<String>,
    created_task_ids: Option<Vec<String>>,
    created_at: u64,
    decided_at: Option<u64>,
    schema_version: u32,
    rev: u64,
}

impl<'de> Deserialize<'de> for Proposal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let fields = ProposalFields::deserialize(deserializer)?;
        if !fields.payload.matches_kind(fields.kind) {
            return Err(D::Error::custom("kind and payload do not agree"));
        }
        Ok(Self {
            id: fields.id,
            kind: fields.kind,
            status: fields.status,
            run_id: fields.run_id,
            task_id: fields.task_id,
            workflow: fields.workflow,
            payload: fields.payload,
            presentation: fields.presentation,
            seen_at: fields.seen_at,
            created_task_id: fields.created_task_id,
            created_task_ids: fields.created_task_ids,
            created_at: fields.created_at,
            decided_at: fields.decided_at,
            schema_version: fields.schema_version,
            rev: fields.rev,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(kind: &str, payload: &str) -> String {
        format!(
            r#"{{"id":"p","kind":"{kind}","status":"pending","runId":"r","workflow":"w","payload":{payload},"createdAt":1,"schemaVersion":1,"rev":0}}"#
        )
    }

    #[test]
    fn each_kind_round_trips_as_literal_camel_case_json() {
        let literals = [
            base(
                "task",
                r#"{"title":"one","description":null,"anchor":null,"linkedNoteIds":null,"subTasks":null,"dependsOn":null,"acceptanceCriteria":null,"branch":null}"#,
            ),
            base(
                "tasks",
                r#"{"sourceTaskId":"source","items":[{"key":"one","title":"first","description":null,"anchor":null,"linkedNoteIds":null,"subTasks":null,"dependsOn":null,"dependsOnKey":null,"acceptanceCriteria":null,"branch":null}]}"#,
            ),
            base(
                "subtasks",
                r#"{"taskId":"parent","items":[{"title":"child","description":null}]}"#,
            ),
        ];
        for literal in literals {
            let proposal: Proposal = serde_json::from_str(&literal).unwrap();
            let round_trip: Proposal =
                serde_json::from_value(serde_json::to_value(&proposal).unwrap()).unwrap();
            assert_eq!(round_trip.kind, proposal.kind);
            assert_eq!(round_trip.payload, proposal.payload);
        }
    }

    #[test]
    fn old_proposals_default_presentation_to_notify() {
        let proposal: Proposal = serde_json::from_str(&base(
            "task",
            r#"{"title":"old","description":null,"anchor":null,"linkedNoteIds":null,"subTasks":null,"dependsOn":null,"acceptanceCriteria":null,"branch":null}"#,
        ))
        .unwrap();
        assert_eq!(proposal.presentation, Presentation::Notify);
        assert_eq!(proposal.seen_at, None);
        assert_eq!(proposal.created_task_ids, None);
    }

    #[test]
    fn batch_task_items_reject_unknown_fields() {
        let literal = base(
            "tasks",
            r#"{"items":[{"key":"one","title":"first","unexpected":true}]}"#,
        );
        assert!(serde_json::from_str::<Proposal>(&literal).is_err());
    }

    #[test]
    fn kind_and_payload_mismatch_is_rejected() {
        let literal = base(
            "tasks",
            r#"{"title":"not a batch","description":null,"anchor":null,"linkedNoteIds":null,"subTasks":null,"dependsOn":null,"acceptanceCriteria":null,"branch":null}"#,
        );
        assert!(serde_json::from_str::<Proposal>(&literal).is_err());
    }
}
