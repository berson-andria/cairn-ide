use serde::{Deserialize, Deserializer, Serialize};

pub const TASK_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Ready,
    Running,
    Blocked,
    NeedsReview,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAnchor {
    pub kind: FileAnchorKind,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileAnchorKind {
    File,
    Function,
    Ast,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTask {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: TaskStatus,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
}

impl SubTask {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            description: None,
            status: TaskStatus::Ready,
            created_at: now_ms(),
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchors: Option<Vec<FileAnchor>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_note_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_tasks: Option<Vec<SubTask>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<String>,
    pub status: TaskStatus,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<Vec<String>>,
    pub schema_version: u32,
    pub rev: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskItemFields {
    id: String,
    title: String,
    description: Option<String>,
    anchor: Option<FileAnchor>,
    anchors: Option<Vec<FileAnchor>>,
    linked_note_ids: Option<Vec<String>>,
    sub_tasks: Option<Vec<SubTask>>,
    depends_on: Option<String>,
    status: TaskStatus,
    created_at: u64,
    updated_at: Option<u64>,
    acceptance_criteria: Option<String>,
    branch: Option<String>,
    runs: Option<Vec<String>>,
    schema_version: u32,
    rev: u64,
}

impl<'de> Deserialize<'de> for TaskItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let fields = TaskItemFields::deserialize(deserializer)?;
        let anchors = match (fields.anchors, fields.anchor) {
            (Some(list), _) => {
                if list.is_empty() {
                    None
                } else {
                    Some(list)
                }
            }
            (None, Some(single)) => Some(vec![single]),
            (None, None) => None,
        };
        Ok(Self {
            id: fields.id,
            title: fields.title,
            description: fields.description,
            anchors,
            linked_note_ids: fields.linked_note_ids,
            sub_tasks: fields.sub_tasks,
            depends_on: fields.depends_on,
            status: fields.status,
            created_at: fields.created_at,
            updated_at: fields.updated_at,
            acceptance_criteria: fields.acceptance_criteria,
            branch: fields.branch,
            runs: fields.runs,
            schema_version: fields.schema_version,
            rev: fields.rev,
        })
    }
}

impl TaskItem {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            description: None,
            anchors: None,
            linked_note_ids: None,
            sub_tasks: None,
            depends_on: None,
            status: TaskStatus::Ready,
            created_at: now_ms(),
            updated_at: None,
            acceptance_criteria: None,
            branch: None,
            runs: None,
            schema_version: TASK_SCHEMA_VERSION,
            rev: 0,
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
