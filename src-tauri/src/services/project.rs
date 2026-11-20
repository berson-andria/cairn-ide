use super::{
    note_service::NoteService,
    proposal_service::ProposalService,
    runs::recover_interrupted_runs,
    service_error::{Actor, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
    task_service::TaskService,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangedRecord {
    Task(String),
    Note(String),
}

pub fn classify_changed_paths(root: &Path, paths: &[PathBuf]) -> Vec<ChangedRecord> {
    let mut out = std::collections::BTreeSet::new();
    for path in paths {
        let rel = if cfg!(windows) {
            let root_s = root
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_owned();
            let path_s = path.to_string_lossy().replace('/', "\\");
            if !path_s
                .to_lowercase()
                .starts_with(&format!("{}\\", root_s.to_lowercase()))
            {
                continue;
            }
            PathBuf::from(&path_s[root_s.len() + 1..])
        } else {
            match path.strip_prefix(root) {
                Ok(p) => p.to_path_buf(),
                Err(_) => continue,
            }
        };
        let parts = rel
            .components()
            .map(|p| p.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        if parts.len() != 3
            || parts[0] != ".cairn"
            || !matches!(parts[1].as_str(), "tasks" | "notes")
            || parts[2].starts_with('.')
            || !parts[2].ends_with(".json")
        {
            continue;
        }
        let id = &parts[2][..parts[2].len() - 5];
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            continue;
        }
        out.insert(if parts[1] == "tasks" {
            ChangedRecord::Task(id.to_owned())
        } else {
            ChangedRecord::Note(id.to_owned())
        });
    }
    out.into_iter().collect()
}

pub struct ProjectServices {
    pub root: PathBuf,
    pub tasks: Arc<TaskService>,
    pub notes: NoteService,
    pub proposals: ProposalService,
}
#[derive(Default)]
pub struct ProjectState(RwLock<Option<Arc<ProjectServices>>>);
impl ProjectState {
    pub fn reload_changed(&self, batch_root: &Path, paths: &[PathBuf]) {
        self.reload_changed_with_retry(batch_root, paths, || {
            std::thread::sleep(std::time::Duration::from_millis(150));
        });
    }

    fn reload_changed_with_retry(
        &self,
        batch_root: &Path,
        paths: &[PathBuf],
        mut wait_before_retry: impl FnMut(),
    ) {
        let Ok(project) = self.services() else {
            return;
        };
        let same_root = if cfg!(windows) {
            project
                .root
                .to_string_lossy()
                .eq_ignore_ascii_case(&batch_root.to_string_lossy())
        } else {
            project.root == batch_root
        };
        if !same_root {
            return;
        }
        for change in classify_changed_paths(&project.root, paths) {
            let run = || -> Result<bool, ServiceError> {
                match &change {
                    ChangedRecord::Task(id) => project.tasks.reload_external(id),
                    ChangedRecord::Note(id) => project.notes.reload_external(id),
                }
            };
            let result = match run() {
                Err(first) if first.code == ServiceErrorCode::Corrupt => {
                    wait_before_retry();
                    match run() {
                        Err(second) if second.code == ServiceErrorCode::Corrupt => {
                            project.tasks.sink_project_reload();
                            Ok(true)
                        }
                        result => result,
                    }
                }
                result => result,
            };
            if let Ok(true) = result {
                let _ = project.tasks.reconcile();
            }
        }
    }
    pub fn open(
        &self,
        path: impl AsRef<Path>,
        sink: impl EventSink + 'static,
    ) -> Result<PathBuf, ServiceError> {
        let path = path.as_ref();
        if !path.is_dir() {
            return Err(ServiceError::validation(
                "Project path must be an existing directory",
            ));
        }
        let canonical = path
            .canonicalize()
            .map_err(|e| ServiceError::validation(e.to_string()))?;
        let root = PathBuf::from(strip_windows_verbatim_prefix(&canonical.to_string_lossy()));
        let lock = Arc::new(Mutex::new(()));
        let sink: Arc<dyn EventSink> = Arc::new(sink);
        let tasks = Arc::new(TaskService::new(
            &root,
            lock.clone(),
            SharedSink(sink.clone()),
        ));
        let notes = NoteService::new(&root, lock.clone(), SharedSink(sink.clone()));
        let proposals = ProposalService::new(&root, tasks.clone(), lock, SharedSink(sink));
        let shared = Arc::new(ProjectServices {
            root: root.clone(),
            tasks,
            notes,
            proposals,
        });
        *self
            .0
            .write()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))? =
            Some(shared.clone());
        match shared.tasks.load() {
            Ok(tasks) => {
                for task in tasks
                    .into_iter()
                    .filter(|task| task.status == crate::types::task::TaskStatus::Running)
                {
                    if let Err(error) = shared.tasks.set_status(
                        &task.id,
                        crate::types::task::TaskStatus::Failed,
                        task.rev,
                        Actor::System,
                    ) {
                        tauri_plugin_log::log::error!(
                            "Could not recover running task {} in {}: {error}",
                            task.id,
                            root.display()
                        );
                    }
                }
            }
            Err(error) => {
                tauri_plugin_log::log::error!("Failed to load project {}: {error}", root.display());
            }
        }
        recover_interrupted_runs(&root);
        Ok(root)
    }
    pub fn services(&self) -> Result<Arc<ProjectServices>, ServiceError> {
        self.0
            .read()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))?
            .clone()
            .ok_or_else(|| ServiceError::new(ServiceErrorCode::NoProject, "No project is open"))
    }
    pub fn close(&self) -> Result<(), ServiceError> {
        *self
            .0
            .write()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))? = None;
        Ok(())
    }
}

struct SharedSink(Arc<dyn EventSink>);
impl EventSink for SharedSink {
    fn emit(&self, event: ChangeEvent) {
        self.0.emit(event);
    }
}
#[derive(Clone)]
pub struct TauriEventSink(pub tauri::AppHandle);
impl EventSink for TauriEventSink {
    fn emit(&self, event: ChangeEvent) {
        let Some((name, payload)) = event_parts(&event) else {
            return;
        };
        let _ = tauri::Emitter::emit(&self.0, name, payload);
    }
}
pub fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = path.strip_prefix(r"\\?\") {
        path.to_string()
    } else {
        path.to_string()
    }
}
pub fn event_parts(e: &ChangeEvent) -> Option<(&'static str, Value)> {
    let part = match e {
        ChangeEvent::TaskCreated(x) => ("task:created", serde_json::to_value(x)),
        ChangeEvent::TaskUpdated(x) => ("task:updated", serde_json::to_value(x)),
        ChangeEvent::TaskReloaded(x) => ("task:reloaded", serde_json::to_value(x)),
        ChangeEvent::TaskDeleted(id) => ("task:deleted", Ok(json!({"id":id}))),
        ChangeEvent::NoteCreated(x) => ("note:created", serde_json::to_value(x)),
        ChangeEvent::NoteUpdated(x) => ("note:updated", serde_json::to_value(x)),
        ChangeEvent::NoteReloaded(x) => ("note:reloaded", serde_json::to_value(x)),
        ChangeEvent::NoteDeleted(id) => ("note:deleted", Ok(json!({"id":id}))),
        ChangeEvent::ProjectReloaded => ("project:reloaded", Ok(json!({}))),
        ChangeEvent::RunStarted {
            run_id,
            task_id,
            workflow,
        } => (
            "run:started",
            Ok(json!({"runId":run_id,"taskId":task_id,"workflow":workflow})),
        ),
        ChangeEvent::RunLog { run_id, lines } => {
            ("run:log", Ok(json!({"runId":run_id,"lines":lines})))
        }
        ChangeEvent::RunFinished {
            run_id,
            task_id,
            outcome,
            reason,
        } => {
            let mut payload = json!({
                "runId":run_id,
                "taskId":task_id,
                "outcome":outcome,
            });
            if let Some(reason) = reason {
                payload["reason"] = json!(reason);
            }
            ("run:finished", Ok(payload))
        }
        ChangeEvent::ProposalCreated(x) => ("proposal:created", serde_json::to_value(x)),
        ChangeEvent::ProposalUpdated(x) => ("proposal:updated", serde_json::to_value(x)),
        ChangeEvent::ProposalDeleted(id) => ("proposal:deleted", Ok(json!({"id":id}))),
    };
    match part {
        (name, Ok(payload)) => Some((name, payload)),
        (name, Err(error)) => {
            tauri_plugin_log::log::error!(
                "Skipping {name} event; payload serialization failed: {error}"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        services::{
            runs::{workflows::WorkflowSource, RunRecord},
            service_error::{RecordingSink, RunOutcome},
            storage::{FileRepository, Repository},
        },
        types::{
            note::NoteItem,
            proposal::{
                BatchTaskItem, Presentation, Proposal, ProposalKind, ProposalPayload,
                ProposalStatus, TasksPayload,
            },
            task::{TaskItem, TaskStatus},
        },
    };
    use std::fs;

    fn task_path(root: &Path, id: &str) -> PathBuf {
        root.join(".cairn/tasks").join(format!("{id}.json"))
    }

    #[test]
    fn open_recovers_running_tasks_and_unfinished_runs_but_skips_malformed_runs() {
        let dir = tempfile::tempdir().unwrap();
        let repository = FileRepository::for_tasks(dir.path());
        let mut task_ids = Vec::new();
        for (title, status) in [
            ("running one", TaskStatus::Running),
            ("running two", TaskStatus::Running),
            ("ready", TaskStatus::Ready),
            ("review", TaskStatus::NeedsReview),
        ] {
            let mut task = TaskItem::new(title);
            task.status = status;
            task_ids.push((repository.create(task).unwrap().id, status));
        }

        let run_directory = dir.path().join(".cairn/runs/interrupted-run");
        fs::create_dir_all(&run_directory).unwrap();
        let record = RunRecord {
            run_id: "interrupted-run".into(),
            task_id: task_ids[0].0.clone(),
            workflow: "default".into(),
            source: WorkflowSource::Project,
            script_hash: "hash".into(),
            started_at: 1,
            ended_at: None,
            outcome: None,
            reason: None,
            summary: None,
        };
        fs::write(
            run_directory.join("run.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let malformed_directory = dir.path().join(".cairn/runs/malformed-run");
        fs::create_dir_all(&malformed_directory).unwrap();
        fs::write(malformed_directory.join("run.json"), "{").unwrap();

        let state = ProjectState::default();
        let sink = RecordingSink::default();
        state.open(dir.path(), sink.clone()).unwrap();

        let project = state.services().unwrap();
        for (task_id, original_status) in task_ids {
            let recovered = project.tasks.get(&task_id).unwrap();
            let expected = if original_status == TaskStatus::Running {
                TaskStatus::Failed
            } else {
                original_status
            };
            assert_eq!(recovered.status, expected);
        }
        let events = sink.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ChangeEvent::TaskUpdated(task) if task.status == TaskStatus::Failed))
                .count(),
            2
        );

        let recovered_run: RunRecord =
            serde_json::from_slice(&fs::read(run_directory.join("run.json")).unwrap()).unwrap();
        assert!(recovered_run.ended_at.is_some());
        assert_eq!(recovered_run.outcome, Some(RunOutcome::Failed));
        assert_eq!(
            recovered_run.reason.as_deref(),
            Some("interrupted (app closed during run)")
        );
        assert_eq!(
            fs::read_to_string(malformed_directory.join("run.json")).unwrap(),
            "{"
        );
    }
    #[test]
    fn classifies_only_direct_valid_task_and_note_ids() {
        let root = PathBuf::from(if cfg!(windows) { r"C:\work" } else { "/work" });
        let paths = [
            ".cairn/tasks/valid-id.json",
            ".cairn/notes/n1.json",
            ".cairn/tasks/../x.json",
            ".cairn/tasks/nested/x.json",
            ".cairn/tasks/a.tmp",
            ".other/tasks/x.json",
        ]
        .iter()
        .map(|p| root.join(p))
        .collect::<Vec<_>>();
        assert_eq!(
            classify_changed_paths(&root, &paths),
            vec![
                ChangedRecord::Task("valid-id".into()),
                ChangedRecord::Note("n1".into())
            ]
        );
    }
    #[test]
    fn all_event_parts_have_exact_names_and_payloads() {
        let mut t = TaskItem::new("t");
        t.id = "task-id".into();
        t.created_at = 1;
        t.rev = 2;
        let mut n = NoteItem::new("n");
        n.id = "note-id".into();
        n.created_at = 3;
        n.rev = 4;
        let proposal = Proposal {
            id: "proposal-id".into(),
            kind: ProposalKind::Task,
            status: ProposalStatus::Pending,
            run_id: "run-id".into(),
            task_id: Some("task-id".into()),
            workflow: "default".into(),
            payload: ProposalPayload::Task(crate::services::task_service::NewTask {
                title: "title".into(),
                description: None,
                anchor: None,
                linked_note_ids: None,
                sub_tasks: None,
                depends_on: None,
                acceptance_criteria: None,
                branch: None,
            }),
            presentation: Presentation::Notify,
            seen_at: None,
            created_task_id: None,
            created_task_ids: None,
            created_at: 5,
            decided_at: None,
            schema_version: 1,
            rev: 7,
        };
        let batch_proposal = Proposal {
            id: "batch-id".into(),
            kind: ProposalKind::Tasks,
            status: ProposalStatus::Pending,
            run_id: "run-id".into(),
            task_id: Some("task-id".into()),
            workflow: "default".into(),
            payload: ProposalPayload::Tasks(TasksPayload {
                source_task_id: None,
                items: vec![BatchTaskItem {
                    key: "one".into(),
                    title: "first".into(),
                    description: None,
                    anchor: None,
                    linked_note_ids: None,
                    sub_tasks: None,
                    depends_on: None,
                    depends_on_key: None,
                    acceptance_criteria: None,
                    branch: None,
                }],
            }),
            presentation: Presentation::Notify,
            seen_at: None,
            created_task_id: None,
            created_task_ids: None,
            created_at: 5,
            decided_at: None,
            schema_version: 1,
            rev: 7,
        };
        let batch_event_json = r#"{"createdAt":5,"id":"batch-id","kind":"tasks","payload":{"items":[{"acceptanceCriteria":null,"anchor":null,"branch":null,"dependsOn":null,"dependsOnKey":null,"description":null,"key":"one","linkedNoteIds":null,"subTasks":null,"title":"first"}],"sourceTaskId":null},"presentation":"notify","rev":7,"runId":"run-id","schemaVersion":1,"status":"pending","taskId":"task-id","workflow":"default"}"#;
        let cases = vec![
            (
                ChangeEvent::TaskCreated(t.clone()),
                "task:created",
                r#"{"createdAt":1,"id":"task-id","rev":2,"schemaVersion":1,"status":"ready","title":"t"}"#,
            ),
            (
                ChangeEvent::TaskUpdated(t.clone()),
                "task:updated",
                r#"{"createdAt":1,"id":"task-id","rev":2,"schemaVersion":1,"status":"ready","title":"t"}"#,
            ),
            (
                ChangeEvent::TaskReloaded(t.clone()),
                "task:reloaded",
                r#"{"createdAt":1,"id":"task-id","rev":2,"schemaVersion":1,"status":"ready","title":"t"}"#,
            ),
            (
                ChangeEvent::TaskDeleted("task-id".into()),
                "task:deleted",
                r#"{"id":"task-id"}"#,
            ),
            (
                ChangeEvent::NoteCreated(n.clone()),
                "note:created",
                r#"{"anchors":[],"content":"n","createdAt":3,"id":"note-id","rev":4,"schemaVersion":1,"status":"open"}"#,
            ),
            (
                ChangeEvent::NoteUpdated(n.clone()),
                "note:updated",
                r#"{"anchors":[],"content":"n","createdAt":3,"id":"note-id","rev":4,"schemaVersion":1,"status":"open"}"#,
            ),
            (
                ChangeEvent::NoteReloaded(n.clone()),
                "note:reloaded",
                r#"{"anchors":[],"content":"n","createdAt":3,"id":"note-id","rev":4,"schemaVersion":1,"status":"open"}"#,
            ),
            (
                ChangeEvent::NoteDeleted("note-id".into()),
                "note:deleted",
                r#"{"id":"note-id"}"#,
            ),
            (ChangeEvent::ProjectReloaded, "project:reloaded", r#"{}"#),
            (
                ChangeEvent::RunStarted {
                    run_id: "run-id".into(),
                    task_id: "task-id".into(),
                    workflow: "hello".into(),
                },
                "run:started",
                r#"{"runId":"run-id","taskId":"task-id","workflow":"hello"}"#,
            ),
            (
                ChangeEvent::RunLog {
                    run_id: "run-id".into(),
                    lines: vec!["one".into(), "two".into()],
                },
                "run:log",
                r#"{"lines":["one","two"],"runId":"run-id"}"#,
            ),
            (
                ChangeEvent::RunFinished {
                    run_id: "run-id".into(),
                    task_id: "task-id".into(),
                    outcome: crate::services::service_error::RunOutcome::NeedsReview,
                    reason: Some("done".into()),
                },
                "run:finished",
                r#"{"outcome":"needs_review","reason":"done","runId":"run-id","taskId":"task-id"}"#,
            ),
            (
                ChangeEvent::RunFinished {
                    run_id: "run-id".into(),
                    task_id: "task-id".into(),
                    outcome: crate::services::service_error::RunOutcome::Failed,
                    reason: None,
                },
                "run:finished",
                r#"{"outcome":"failed","runId":"run-id","taskId":"task-id"}"#,
            ),
            (
                ChangeEvent::ProposalCreated(proposal.clone()),
                "proposal:created",
                r#"{"createdAt":5,"id":"proposal-id","kind":"task","payload":{"acceptanceCriteria":null,"anchor":null,"branch":null,"dependsOn":null,"description":null,"linkedNoteIds":null,"subTasks":null,"title":"title"},"presentation":"notify","rev":7,"runId":"run-id","schemaVersion":1,"status":"pending","taskId":"task-id","workflow":"default"}"#,
            ),
            (
                ChangeEvent::ProposalUpdated(proposal.clone()),
                "proposal:updated",
                r#"{"createdAt":5,"id":"proposal-id","kind":"task","payload":{"acceptanceCriteria":null,"anchor":null,"branch":null,"dependsOn":null,"description":null,"linkedNoteIds":null,"subTasks":null,"title":"title"},"presentation":"notify","rev":7,"runId":"run-id","schemaVersion":1,"status":"pending","taskId":"task-id","workflow":"default"}"#,
            ),
            (
                ChangeEvent::ProposalCreated(batch_proposal.clone()),
                "proposal:created",
                batch_event_json,
            ),
            (
                ChangeEvent::ProposalUpdated(batch_proposal),
                "proposal:updated",
                batch_event_json,
            ),
            (
                ChangeEvent::ProposalDeleted("proposal-id".into()),
                "proposal:deleted",
                r#"{"id":"proposal-id"}"#,
            ),
        ];
        for (event, name, payload) in cases {
            let (actual_name, actual) = event_parts(&event).unwrap();
            assert_eq!(actual_name, name);
            assert_eq!(actual.to_string(), payload);
        }
    }

    #[test]
    fn windows_verbatim_paths_are_normalized() {
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\C:\x"), r"C:\x");
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\srv\share"),
            r"\\srv\share"
        );
        assert_eq!(strip_windows_verbatim_prefix(r"C:\x"), r"C:\x");
    }

    struct RootCheckingSink {
        state: Arc<ProjectState>,
        expected: PathBuf,
    }
    impl EventSink for RootCheckingSink {
        fn emit(&self, event: ChangeEvent) {
            if matches!(event, ChangeEvent::ProjectReloaded) {
                assert_eq!(self.state.services().unwrap().root, self.expected);
            }
        }
    }
    #[test]
    fn project_reloaded_sink_observes_new_project_state() {
        let state = Arc::new(ProjectState::default());
        let dir = tempfile::tempdir().unwrap();
        let expected = PathBuf::from(strip_windows_verbatim_prefix(
            &dir.path().canonicalize().unwrap().to_string_lossy(),
        ));
        state
            .open(
                dir.path(),
                RootCheckingSink {
                    state: state.clone(),
                    expected: expected.clone(),
                },
            )
            .unwrap();
        assert_eq!(state.services().unwrap().root, expected);
    }

    #[test]
    fn corrupt_json_retries_once_then_emits_project_reloaded() {
        let dir = tempfile::tempdir().unwrap();
        let state = ProjectState::default();
        let sink = RecordingSink::default();
        let root = state.open(dir.path(), sink.clone()).unwrap();
        sink.take();
        let path = task_path(&root, "broken");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{").unwrap();
        let mut retries = 0;
        state.reload_changed_with_retry(&root, &[path], || retries += 1);
        assert_eq!(retries, 1);
        assert_eq!(sink.events(), vec![ChangeEvent::ProjectReloaded]);
    }

    #[test]
    fn partial_task_file_becoming_valid_on_retry_emits_task_reloaded_only() {
        let dir = tempfile::tempdir().unwrap();
        let state = ProjectState::default();
        let sink = RecordingSink::default();
        let root = state.open(dir.path(), sink.clone()).unwrap();
        sink.take();
        let path = task_path(&root, "partial");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{").unwrap();
        let mut task = TaskItem::new("completed write");
        task.id = "partial".into();
        let bytes = serde_json::to_vec_pretty(&task).unwrap();
        state.reload_changed_with_retry(&root, &[path], || {
            fs::write(task_path(&root, "partial"), &bytes).unwrap()
        });
        let events = sink.events();
        assert!(events.iter().any(|event| matches!(event, ChangeEvent::TaskReloaded(item) if item.title == "completed write")));
        assert!(!events
            .iter()
            .any(|event| matches!(event, ChangeEvent::ProjectReloaded)));
    }

    #[test]
    fn reconcile_write_is_recognized_as_own_write_without_a_second_event() {
        let dir = tempfile::tempdir().unwrap();
        let state = ProjectState::default();
        let sink = RecordingSink::default();
        let root = state.open(dir.path(), sink.clone()).unwrap();
        let project = state.services().unwrap();
        let mut blocker = TaskItem::new("blocker");
        blocker.id = "blocker".into();
        blocker.status = TaskStatus::Blocked;
        let blocker = project.tasks.create(blocker).unwrap();
        let mut dependent = TaskItem::new("dependent");
        dependent.id = "dependent".into();
        dependent.depends_on = Some(blocker.id.clone());
        let dependent = project.tasks.create(dependent).unwrap();
        sink.take();

        let mut externally_completed = blocker;
        externally_completed.status = TaskStatus::Completed;
        let blocker_path = task_path(&root, "blocker");
        fs::write(
            &blocker_path,
            serde_json::to_vec_pretty(&externally_completed).unwrap(),
        )
        .unwrap();
        state.reload_changed(&root, &[blocker_path]);
        assert_eq!(
            project.tasks.get(&dependent.id).unwrap().status,
            TaskStatus::Ready
        );
        assert!(sink.events().iter().any(
            |event| matches!(event, ChangeEvent::TaskUpdated(item) if item.id == dependent.id)
        ));

        sink.take();
        state.reload_changed(&root, &[task_path(&root, "dependent")]);
        assert!(sink.events().is_empty());
    }

    #[test]
    fn watcher_batches_without_project_and_for_previous_project_are_ignored() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = ProjectState::default();
        let first_sink = RecordingSink::default();
        let second_sink = RecordingSink::default();
        let first_root = PathBuf::from(strip_windows_verbatim_prefix(
            &first.path().canonicalize().unwrap().to_string_lossy(),
        ));
        state.reload_changed(&first_root, &[task_path(&first_root, "task")]);
        state.open(first.path(), first_sink.clone()).unwrap();
        let mut first_task = TaskItem::new("first");
        first_task.id = "task".into();
        fs::create_dir_all(task_path(&first_root, "task").parent().unwrap()).unwrap();
        fs::write(
            task_path(&first_root, "task"),
            serde_json::to_vec(&first_task).unwrap(),
        )
        .unwrap();
        state.reload_changed(&first_root, &[task_path(&first_root, "task")]);
        assert!(first_sink
            .events()
            .iter()
            .any(|event| matches!(event, ChangeEvent::TaskReloaded(_))));

        let second_root = state.open(second.path(), second_sink.clone()).unwrap();
        second_sink.take();
        first_sink.take();
        let mut changed_first = first_task.clone();
        changed_first.title = "stale project".into();
        fs::write(
            task_path(&first_root, "task"),
            serde_json::to_vec(&changed_first).unwrap(),
        )
        .unwrap();
        state.reload_changed(&first_root, &[task_path(&first_root, "task")]);
        assert!(first_sink.events().is_empty());
        assert!(second_sink.events().is_empty());

        let mut second_task = TaskItem::new("second");
        second_task.id = "task".into();
        fs::create_dir_all(task_path(&second_root, "task").parent().unwrap()).unwrap();
        fs::write(
            task_path(&second_root, "task"),
            serde_json::to_vec(&second_task).unwrap(),
        )
        .unwrap();
        state.reload_changed(&second_root, &[task_path(&second_root, "task")]);
        assert!(second_sink.events().iter().any(
            |event| matches!(event, ChangeEvent::TaskReloaded(item) if item.title == "second")
        ));
    }
}
