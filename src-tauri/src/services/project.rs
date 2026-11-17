use super::{
    note_service::NoteService,
    service_error::{ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
    task_service::TaskService,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};

pub struct ProjectServices {
    pub root: PathBuf,
    pub tasks: TaskService,
    pub notes: NoteService,
}
#[derive(Default)]
pub struct ProjectState(RwLock<Option<Arc<ProjectServices>>>);
impl ProjectState {
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
        let tasks = TaskService::new(&root, lock.clone(), SharedSink(sink.clone()));
        let notes = NoteService::new(&root, lock, SharedSink(sink));
        let shared = Arc::new(ProjectServices {
            root: root.clone(),
            tasks,
            notes,
        });
        *self
            .0
            .write()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))? =
            Some(shared.clone());
        if let Err(error) = shared.tasks.load() {
            tauri_plugin_log::log::error!("Failed to load project {}: {error}", root.display());
        }
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
        ChangeEvent::TaskDeleted(id) => ("task:deleted", Ok(json!({"id":id}))),
        ChangeEvent::NoteCreated(x) => ("note:created", serde_json::to_value(x)),
        ChangeEvent::NoteUpdated(x) => ("note:updated", serde_json::to_value(x)),
        ChangeEvent::NoteDeleted(id) => ("note:deleted", Ok(json!({"id":id}))),
        ChangeEvent::ProjectReloaded => ("project:reloaded", Ok(json!({}))),
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
    use crate::types::{note::NoteItem, task::TaskItem};
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
                ChangeEvent::NoteDeleted("note-id".into()),
                "note:deleted",
                r#"{"id":"note-id"}"#,
            ),
            (ChangeEvent::ProjectReloaded, "project:reloaded", r#"{}"#),
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
}
