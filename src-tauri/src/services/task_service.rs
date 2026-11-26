use crate::{
    services::{
        service_error::{now_ms, Actor, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
        storage::{FileRepository, Repository},
    },
    types::{
        note::NoteItem,
        task::{FileAnchor, SubTask, TaskItem, TaskStatus, TASK_SCHEMA_VERSION},
    },
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub trait RunGuard: Send + Sync {
    fn is_task_run_active(&self, task_id: &str) -> bool;
    fn is_run_active(&self, run_id: &str) -> bool;
}

fn deserialize_some<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewSubTask {
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewTask {
    pub title: String,
    pub description: Option<String>,
    pub anchors: Option<Vec<FileAnchor>>,
    #[serde(rename = "linkedNoteIds")]
    pub linked_note_ids: Option<Vec<String>>,
    #[serde(rename = "subTasks")]
    pub sub_tasks: Option<Vec<NewSubTask>>,
    pub depends_on: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubTaskPatch {
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub description: Option<Option<String>>,
    pub status: Option<TaskStatus>,
}

#[derive(Debug, Default, Clone)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
}
pub struct TaskService {
    tasks: FileRepository<TaskItem>,
    notes: FileRepository<NoteItem>,
    runs_dir: PathBuf,
    lock: Arc<Mutex<()>>,
    sink: Box<dyn EventSink>,
    run_guard: Option<Arc<dyn RunGuard>>,
}
impl TaskService {
    pub(crate) fn sink_project_reload(&self) {
        self.sink.emit(ChangeEvent::ProjectReloaded);
    }
    pub fn new(
        root: impl AsRef<Path>,
        lock: Arc<Mutex<()>>,
        sink: impl EventSink + 'static,
    ) -> Self {
        Self {
            tasks: FileRepository::for_tasks(&root),
            notes: FileRepository::for_notes(&root),
            runs_dir: root.as_ref().join(".praide").join("runs"),
            lock,
            sink: Box::new(sink),
            run_guard: None,
        }
    }
    pub fn with_run_guard(mut self, guard: Arc<dyn RunGuard>) -> Self {
        self.run_guard = Some(guard);
        self
    }
    fn is_valid_id(id: &str) -> bool {
        (1..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ServiceError> {
        self.lock
            .lock()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))
    }
    fn all(&self) -> Result<Vec<TaskItem>, ServiceError> {
        Ok(self.tasks.list()?.records)
    }
    pub fn list(&self) -> Result<super::storage::ListReport<TaskItem>, ServiceError> {
        Ok(self.tasks.list()?)
    }
    pub fn get(&self, id: &str) -> Result<TaskItem, ServiceError> {
        Ok(self.tasks.get(id)?)
    }
    pub(crate) fn reload_external(&self, id: &str) -> Result<bool, ServiceError> {
        let path = self.tasks.path_for_reload(id)?;
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.tasks.is_own_write(id, None) {
                    return Ok(false);
                }
                self.tasks.clear_own_write(id);
                self.sink.emit(ChangeEvent::TaskDeleted(id.into()));
                return Ok(true);
            }
            Err(e) => return Err(ServiceError::new(ServiceErrorCode::Io, e.to_string())),
        };
        let record: TaskItem = serde_json::from_slice(&bytes)
            .map_err(|e| ServiceError::new(ServiceErrorCode::Corrupt, e.to_string()))?;
        if record.id != id {
            return Err(ServiceError::new(
                ServiceErrorCode::Corrupt,
                "record id does not match file name",
            ));
        }
        if self.tasks.is_own_write(id, Some(&bytes)) {
            return Ok(false);
        }
        self.tasks.clear_own_write(id);
        self.sink.emit(ChangeEvent::TaskReloaded(record));
        self.reconcile()?;
        Ok(true)
    }
    fn emit_changed(&self, t: TaskItem) {
        self.sink.emit(ChangeEvent::TaskUpdated(t));
    }
    fn reconcile_locked(&self) -> Result<Vec<TaskItem>, ServiceError> {
        let tasks = self.all()?;
        let note_ids: HashSet<String> = self
            .notes
            .list()?
            .records
            .into_iter()
            .map(|n| n.id)
            .collect();
        let snapshot: std::collections::HashMap<String, TaskStatus> =
            tasks.iter().map(|t| (t.id.clone(), t.status)).collect();
        let mut changed = Vec::new();
        for mut t in tasks {
            let mut dirty = false;
            if matches!(t.status, TaskStatus::Ready | TaskStatus::Blocked) {
                let desired = match t.depends_on.as_ref().and_then(|id| snapshot.get(id)) {
                    Some(TaskStatus::Completed) | None => TaskStatus::Ready,
                    Some(_) => TaskStatus::Blocked,
                };
                if t.status != desired {
                    t.status = desired;
                    dirty = true;
                }
            }
            if let Some(ids) = t.linked_note_ids.as_mut() {
                let before = ids.len();
                ids.retain(|id| note_ids.contains(id));
                if before != ids.len() {
                    dirty = true;
                }
                if ids.is_empty() {
                    t.linked_note_ids = None;
                }
            }
            if dirty {
                t.updated_at = Some(now_ms());
                let updated = self.tasks.update(t.clone(), t.rev)?;
                changed.push(updated);
            }
        }
        Ok(changed)
    }
    pub fn reconcile(&self) -> Result<Vec<String>, ServiceError> {
        let _g = self.lock()?;
        let changed = self.reconcile_locked()?;
        let deleted_runs = self.sweep_orphan_runs_locked();
        let ids = changed.iter().map(|t| t.id.clone()).collect();
        drop(_g);
        for task in changed {
            self.emit_changed(task);
        }
        for run_id in deleted_runs {
            self.sink.emit(ChangeEvent::RunDeleted(run_id));
        }
        Ok(ids)
    }
    pub fn load(&self) -> Result<Vec<TaskItem>, ServiceError> {
        let _g = self.lock()?;
        let changed = self.reconcile_locked()?;
        let deleted_runs = self.sweep_orphan_runs_locked();
        let tasks = self.all()?;
        drop(_g);
        for task in changed {
            self.emit_changed(task);
        }
        for run_id in deleted_runs {
            self.sink.emit(ChangeEvent::RunDeleted(run_id));
        }
        self.sink.emit(ChangeEvent::ProjectReloaded);
        Ok(tasks)
    }
    fn remove_matching_runs_locked<F>(&self, should_remove: F) -> Vec<String>
    where
        F: Fn(&str) -> bool,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RunTaskRef {
            #[serde(default)]
            task_id: Option<String>,
        }

        let entries = match std::fs::read_dir(&self.runs_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Could not scan runs directory {}: {error}",
                    self.runs_dir.display()
                );
                return Vec::new();
            }
        };
        let mut deleted = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        "Could not inspect run entry in {}: {error}",
                        self.runs_dir.display()
                    );
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(run_id) = name.to_str() else {
                continue;
            };
            if run_id == "proposals" || !Self::is_valid_id(run_id) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            if self
                .run_guard
                .as_ref()
                .is_some_and(|guard| guard.is_run_active(run_id))
            {
                continue;
            }
            let run_dir = self.runs_dir.join(run_id);
            let run_json = run_dir.join("run.json");
            let bytes = match std::fs::read(&run_json) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        "Could not read run metadata for {run_id}: {error}"
                    );
                    continue;
                }
            };
            let meta: RunTaskRef = match serde_json::from_slice(&bytes) {
                Ok(meta) => meta,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        "Skipping corrupt run metadata for {run_id}: {error}"
                    );
                    continue;
                }
            };
            let Some(task_id) = meta.task_id.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            if !should_remove(task_id) {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(&run_dir) {
                tauri_plugin_log::log::error!(
                    "Could not delete run directory for {run_id}: {error}"
                );
                continue;
            }
            deleted.push(run_id.to_owned());
        }
        deleted
    }
    fn delete_runs_for_task_locked(&self, id: &str) -> Vec<String> {
        self.remove_matching_runs_locked(|task_id| task_id == id)
    }
    fn sweep_orphan_runs_locked(&self) -> Vec<String> {
        let tasks = match self.all() {
            Ok(tasks) => tasks,
            Err(error) => {
                tauri_plugin_log::log::error!("Could not list tasks for run orphan sweep: {error}");
                return Vec::new();
            }
        };
        let task_ids: HashSet<String> = tasks.into_iter().map(|t| t.id).collect();
        self.remove_matching_runs_locked(|task_id| !task_ids.contains(task_id))
    }
    fn validate_dependency(&self, task_id: &str, dep: Option<&str>) -> Result<(), ServiceError> {
        let Some(dep) = dep else { return Ok(()) };
        if dep == task_id {
            return Err(ServiceError::validation("A task cannot depend on itself"));
        }
        let all = self.all()?;
        let map: std::collections::HashMap<&str, &TaskItem> =
            all.iter().map(|t| (t.id.as_str(), t)).collect();
        if !map.contains_key(dep) {
            return Err(ServiceError::validation(format!(
                "Dependency {dep} not found"
            )));
        }
        let mut cursor = Some(dep);
        let mut seen = HashSet::new();
        while let Some(id) = cursor {
            if id == task_id {
                return Err(ServiceError::validation("Dependency would create a cycle"));
            }
            if !seen.insert(id) {
                break;
            }
            cursor = map.get(id).and_then(|t| t.depends_on.as_deref());
        }
        Ok(())
    }
    fn validate_linked_notes(&self, ids: Option<&[String]>) -> Result<(), ServiceError> {
        if let Some(ids) = ids {
            for id in ids {
                if let Err(error) = self.notes.get(id) {
                    if error.code == crate::services::storage::StorageErrorCode::NotFound {
                        return Err(ServiceError::validation(format!(
                            "linkedNoteIds: linked note {id} not found"
                        )));
                    }
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }
    const MAX_ANCHORS: usize = 20;

    fn normalize_and_validate_anchors(
        anchors: Option<Vec<FileAnchor>>,
    ) -> Result<Option<Vec<FileAnchor>>, ServiceError> {
        let Some(list) = anchors else {
            return Ok(None);
        };
        if list.is_empty() {
            return Ok(None);
        }
        if list.len() > Self::MAX_ANCHORS {
            return Err(ServiceError::validation(format!(
                "anchors must contain at most {} items",
                Self::MAX_ANCHORS
            )));
        }
        let mut seen = HashSet::with_capacity(list.len());
        for anchor in &list {
            if !seen.insert((anchor.kind, anchor.path.as_str(), anchor.line_number)) {
                return Err(ServiceError::validation(
                    "anchors must not contain duplicates",
                ));
            }
        }
        Ok(Some(list))
    }

    pub(crate) fn validate_input_with_id_locked(
        &self,
        id: &str,
        input: &NewTask,
    ) -> Result<(), ServiceError> {
        Self::normalize_and_validate_anchors(input.anchors.clone())?;
        self.validate_dependency(id, input.depends_on.as_deref())
            .map_err(|mut error| {
                if error.code == ServiceErrorCode::Validation {
                    error.message = format!("dependsOn: {}", error.message);
                }
                error
            })?;
        self.validate_linked_notes(input.linked_note_ids.as_deref())
    }
    fn task_from_input(id: String, input: NewTask) -> TaskItem {
        let mut task = TaskItem::new(input.title);
        task.id = id;
        task.description = input.description;
        task.anchors = input.anchors;
        task.linked_note_ids = input.linked_note_ids;
        task.sub_tasks = input.sub_tasks.map(|items| {
            items
                .into_iter()
                .map(|item| {
                    let mut subtask = SubTask::new(item.title);
                    subtask.description = item.description;
                    subtask
                })
                .collect()
        });
        task.depends_on = input.depends_on;
        task.acceptance_criteria = input.acceptance_criteria;
        task.branch = input.branch;
        task
    }
    fn create_locked(&self, mut task: TaskItem) -> Result<(TaskItem, Vec<TaskItem>), ServiceError> {
        task.anchors = Self::normalize_and_validate_anchors(task.anchors)?;
        self.validate_dependency(&task.id, task.depends_on.as_deref())?;
        self.validate_linked_notes(task.linked_note_ids.as_deref())?;
        if let Some(subs) = task.sub_tasks.as_mut() {
            for sub in subs {
                sub.id = uuid::Uuid::new_v4().to_string();
                sub.status = TaskStatus::Ready;
                sub.updated_at = None;
            }
        }
        task.status = if task
            .depends_on
            .as_ref()
            .and_then(|id| self.tasks.get(id).ok())
            .is_some_and(|d| d.status != TaskStatus::Completed)
        {
            TaskStatus::Blocked
        } else {
            TaskStatus::Ready
        };
        let created = self.tasks.create(task)?;
        let changed = match self.reconcile_locked() {
            Ok(v) => v,
            Err(e) => {
                tauri_plugin_log::log::error!("Task reconcile failed after create: {e}");
                Vec::new()
            }
        };
        let result = self.tasks.get(&created.id)?;
        Ok((result, changed))
    }
    pub(crate) fn create_input_with_id_locked(
        &self,
        id: String,
        input: NewTask,
    ) -> Result<(TaskItem, Vec<TaskItem>), ServiceError> {
        self.validate_input_with_id_locked(&id, &input)?;
        match self.tasks.get(&id) {
            Ok(existing) => return Ok((existing, Vec::new())),
            Err(error) if error.code == crate::services::storage::StorageErrorCode::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.create_locked(Self::task_from_input(id, input))
    }
    pub(crate) fn add_subtasks_locked(
        &self,
        id: &str,
        items: Vec<SubTask>,
    ) -> Result<Option<TaskItem>, ServiceError> {
        let mut task = self.get(id).map_err(|error| {
            if error.code == ServiceErrorCode::NotFound {
                ServiceError::validation(format!("taskId: task {id} not found"))
            } else {
                error
            }
        })?;
        let subtasks = task.sub_tasks.get_or_insert_with(Vec::new);
        let mut changed = false;
        for item in items {
            if !subtasks.iter().any(|existing| existing.id == item.id) {
                subtasks.push(item);
                changed = true;
            }
        }
        if !changed {
            return Ok(None);
        }
        task.updated_at = Some(now_ms());
        Ok(Some(self.tasks.update(task.clone(), task.rev)?))
    }
    pub(crate) fn delete_locked(&self, id: &str) -> Result<Vec<TaskItem>, ServiceError> {
        self.tasks.delete(id)?;
        let mut changed_records = Vec::new();
        for mut task in self.all()? {
            if task.depends_on.as_deref() == Some(id) {
                task.depends_on = None;
                task.updated_at = Some(now_ms());
                let updated = self.tasks.update(task.clone(), task.rev)?;
                changed_records.push(updated);
            }
        }
        match self.reconcile_locked() {
            Ok(changed) => changed_records.extend(changed),
            Err(error) => {
                tauri_plugin_log::log::error!("Task reconcile failed after delete: {error}")
            }
        }
        Ok(changed_records)
    }
    pub fn create(&self, task: TaskItem) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let (result, changed) = self.create_locked(task)?;
        drop(_g);
        self.sink.emit(ChangeEvent::TaskCreated(result.clone()));
        for task in changed {
            self.emit_changed(task);
        }
        Ok(result)
    }
    pub fn create_input(&self, input: NewTask) -> Result<TaskItem, ServiceError> {
        self.create(Self::task_from_input(
            uuid::Uuid::new_v4().to_string(),
            input,
        ))
    }
    pub fn update(
        &self,
        id: &str,
        patch: TaskPatch,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut task = self.tasks.get(id)?;
        if task.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        if let Some(title) = patch.title {
            task.title = title;
        }
        if let Some(description) = patch.description {
            task.description = description;
        }
        task.updated_at = Some(now_ms());
        let t = self.tasks.update(task, expected_rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    fn check_transition(
        from: TaskStatus,
        to: TaskStatus,
        actor: Actor,
        subtask: bool,
    ) -> Result<(), ServiceError> {
        if subtask {
            if actor == Actor::Script && from == TaskStatus::Completed {
                return Err(ServiceError::new(
                    ServiceErrorCode::Forbidden,
                    "Scripts cannot change completed subtasks",
                ));
            }
            if to == TaskStatus::Completed && actor == Actor::Script {
                return Err(ServiceError::new(
                    ServiceErrorCode::Forbidden,
                    "Scripts cannot complete subtasks",
                ));
            }
            return Ok(());
        }
        let allowed = match (from, to) {
            (TaskStatus::Ready, TaskStatus::Running) => {
                return if matches!(actor, Actor::Ui | Actor::System) {
                    Ok(())
                } else {
                    Err(ServiceError::new(
                        ServiceErrorCode::Forbidden,
                        "Transition requires UI or system actor",
                    ))
                }
            }
            (TaskStatus::Ready, TaskStatus::Blocked) | (TaskStatus::Blocked, TaskStatus::Ready) => {
                Some(Actor::System)
            }
            (TaskStatus::Running, TaskStatus::NeedsReview) => {
                return if matches!(actor, Actor::Script | Actor::System) {
                    Ok(())
                } else {
                    Err(ServiceError::new(
                        ServiceErrorCode::Forbidden,
                        "Transition requires script or system actor",
                    ))
                }
            }
            (TaskStatus::Running, TaskStatus::Failed) => Some(Actor::System),
            (TaskStatus::Running, TaskStatus::Completed)
            | (TaskStatus::NeedsReview, TaskStatus::Completed)
            | (TaskStatus::NeedsReview, TaskStatus::Ready)
            | (TaskStatus::Failed, TaskStatus::Ready)
            | (TaskStatus::Completed, TaskStatus::Ready) => Some(Actor::Ui),
            _ => None,
        };
        match allowed {
            None => Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Transition is not allowed",
            )),
            Some(a) if a != actor => Err(ServiceError::new(
                ServiceErrorCode::Forbidden,
                "Actor cannot make this transition",
            )),
            _ => Ok(()),
        }
    }
    pub fn set_status(
        &self,
        id: &str,
        status: TaskStatus,
        expected_rev: u64,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut t = self.tasks.get(id)?;
        if t.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        let complete_reviewed_subtasks = status == TaskStatus::Completed && actor == Actor::Ui;
        if t.status == status
            && !(complete_reviewed_subtasks
                && t.sub_tasks.as_ref().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.status == TaskStatus::NeedsReview)
                }))
        {
            return Ok(t);
        }
        if t.status != status {
            Self::check_transition(t.status, status, actor, false)?;
            t.status = status;
        }
        if complete_reviewed_subtasks {
            if let Some(subtasks) = t.sub_tasks.as_mut() {
                for subtask in subtasks
                    .iter_mut()
                    .filter(|item| item.status == TaskStatus::NeedsReview)
                {
                    subtask.status = TaskStatus::Completed;
                    subtask.updated_at = Some(now_ms());
                }
            }
        }
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, expected_rev)?;
        let reconcile_result = self.reconcile_locked();
        let changed = match reconcile_result {
            Ok(v) => v,
            Err(e) => {
                tauri_plugin_log::log::error!("Task reconcile failed after status change: {e}");
                Vec::new()
            }
        };
        let result = self.tasks.get(id)?;
        drop(_g);
        self.emit_changed(t);
        for task in changed {
            self.emit_changed(task);
        }
        Ok(result)
    }
    pub fn start(
        &self,
        id: &str,
        expected_rev: u64,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let t = self.tasks.get(id)?;
        if t.status != TaskStatus::Ready
            || t.depends_on.as_ref().is_some_and(|d| {
                self.tasks
                    .get(d)
                    .map(|x| x.status != TaskStatus::Completed)
                    .unwrap_or(true)
            })
        {
            return Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Task is not startable",
            ));
        }
        self.set_status(id, TaskStatus::Running, expected_rev, actor)
    }
    pub fn start_with_run(
        &self,
        id: &str,
        expected_rev: u64,
        run_id: String,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut task = self.tasks.get(id)?;
        if task.status != TaskStatus::Ready
            || task.depends_on.as_ref().is_some_and(|dependency_id| {
                self.tasks
                    .get(dependency_id)
                    .map(|dependency| dependency.status != TaskStatus::Completed)
                    .unwrap_or(true)
            })
        {
            return Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Task is not startable",
            ));
        }
        if task.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        Self::check_transition(task.status, TaskStatus::Running, actor, false)?;
        let mut runs = task.runs.take().unwrap_or_default();
        runs.push(run_id);
        if runs.len() > 50 {
            runs.drain(..runs.len() - 50);
        }
        task.runs = Some(runs);
        task.status = TaskStatus::Running;
        task.updated_at = Some(now_ms());
        let updated = self.tasks.update(task, expected_rev)?;
        drop(_g);
        self.emit_changed(updated.clone());
        Ok(updated)
    }
    pub fn complete(&self, id: &str, expected_rev: u64) -> Result<TaskItem, ServiceError> {
        self.set_status(id, TaskStatus::Completed, expected_rev, Actor::Ui)
    }
    pub fn set_dependency(
        &self,
        id: &str,
        dep: Option<String>,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        self.validate_dependency(id, dep.as_deref())?;
        let mut t = self.tasks.get(id)?;
        t.depends_on = dep;
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, expected_rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        if let Err(e) = self.reconcile() {
            tauri_plugin_log::log::error!("Task reconcile failed after dependency change: {e}");
        }
        self.get(id)
    }
    pub fn set_anchors(
        &self,
        id: &str,
        anchors: Option<Vec<FileAnchor>>,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let anchors = Self::normalize_and_validate_anchors(anchors)?;
        let _g = self.lock()?;
        let mut t = self.tasks.get(id)?;
        t.anchors = anchors;
        t.schema_version = t.schema_version.max(TASK_SCHEMA_VERSION);
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, expected_rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn link_note(
        &self,
        id: &str,
        note_id: &str,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        self.notes.get(note_id)?;
        let mut t = self.tasks.get(id)?;
        if !t
            .linked_note_ids
            .as_ref()
            .is_some_and(|v| v.contains(&note_id.to_string()))
        {
            t.linked_note_ids
                .get_or_insert_with(Vec::new)
                .push(note_id.into());
        }
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, expected_rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn unlink_note(
        &self,
        id: &str,
        note_id: &str,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut t = self.tasks.get(id)?;
        if t.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        if let Some(v) = t.linked_note_ids.as_mut() {
            v.retain(|n| n != note_id);
        }
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, expected_rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn remove_linked_note(&self, note_id: &str) -> Result<Vec<String>, ServiceError> {
        let _g = self.lock()?;
        let mut ids = Vec::new();
        let mut changed = Vec::new();
        for mut t in self.all()? {
            if t.linked_note_ids
                .as_ref()
                .is_some_and(|v| v.contains(&note_id.to_string()))
            {
                t.linked_note_ids.as_mut().unwrap().retain(|n| n != note_id);
                t.updated_at = Some(now_ms());
                let x = self.tasks.update(t.clone(), t.rev)?;
                ids.push(x.id.clone());
                changed.push(x);
            }
        }
        drop(_g);
        for task in changed {
            self.emit_changed(task);
        }
        Ok(ids)
    }
    pub fn delete(&self, id: &str) -> Result<(), ServiceError> {
        if !Self::is_valid_id(id) {
            return Err(ServiceError::validation(
                "Id must be 1-64 characters of [A-Za-z0-9_-]",
            ));
        }
        let _g = self.lock()?;
        if self
            .run_guard
            .as_ref()
            .is_some_and(|guard| guard.is_task_run_active(id))
        {
            return Err(ServiceError::new(
                ServiceErrorCode::RunActive,
                "Cannot delete task while a workflow run is active",
            ));
        }
        let changed_records = self.delete_locked(id)?;
        let deleted_runs = self.delete_runs_for_task_locked(id);
        drop(_g);
        self.sink.emit(ChangeEvent::TaskDeleted(id.into()));
        for run_id in deleted_runs {
            self.sink.emit(ChangeEvent::RunDeleted(run_id));
        }
        for task in changed_records {
            self.emit_changed(task);
        }
        Ok(())
    }
    pub fn can_start(&self, id: &str) -> Result<bool, ServiceError> {
        let t = self.get(id)?;
        Ok(t.status == TaskStatus::Ready
            && t.depends_on
                .as_ref()
                .map(|d| {
                    self.tasks
                        .get(d)
                        .map(|x| x.status == TaskStatus::Completed)
                        .unwrap_or(false)
                })
                .unwrap_or(true))
    }
    pub fn get_dependent_tasks(&self, id: &str) -> Result<Vec<TaskItem>, ServiceError> {
        Ok(self
            .all()?
            .into_iter()
            .filter(|t| t.depends_on.as_deref() == Some(id))
            .collect())
    }
    pub fn set_acceptance_criteria(
        &self,
        id: &str,
        v: Option<String>,
        rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let mut t = self.get(id)?;
        t.acceptance_criteria = v;
        let _g = self.lock()?;
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn set_branch(
        &self,
        id: &str,
        v: Option<String>,
        rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let mut t = self.get(id)?;
        t.branch = v;
        let _g = self.lock()?;
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn add_subtask(
        &self,
        id: &str,
        mut st: SubTask,
        rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut t = self.get(id)?;
        st.id = uuid::Uuid::new_v4().to_string();
        st.status = TaskStatus::Ready;
        st.updated_at = None;
        t.sub_tasks.get_or_insert_with(Vec::new).push(st);
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn add_new_subtask(
        &self,
        id: &str,
        input: NewSubTask,
        rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let mut subtask = SubTask::new(input.title);
        subtask.description = input.description;
        self.add_subtask(id, subtask, rev)
    }
    pub fn update_subtask(
        &self,
        id: &str,
        sub_id: &str,
        st: SubTask,
        rev: u64,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut t = self.get(id)?;
        let list = t
            .sub_tasks
            .as_mut()
            .ok_or_else(|| ServiceError::new(ServiceErrorCode::NotFound, "Subtask not found"))?;
        let old = list
            .iter()
            .find(|x| x.id == sub_id)
            .ok_or_else(|| ServiceError::new(ServiceErrorCode::NotFound, "Subtask not found"))?;
        Self::check_transition(old.status, st.status, actor, true)?;
        *list.iter_mut().find(|x| x.id == sub_id).unwrap() = st;
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
    pub fn set_subtask_status(
        &self,
        task_id: &str,
        subtask_id: &str,
        status: TaskStatus,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut task = self.tasks.get(task_id)?;
        let subtask = task
            .sub_tasks
            .as_mut()
            .and_then(|items| items.iter_mut().find(|item| item.id == subtask_id))
            .ok_or_else(|| {
                ServiceError::new(
                    ServiceErrorCode::NotFound,
                    format!("subtaskId: subtask {subtask_id} not found"),
                )
            })?;
        Self::check_transition(subtask.status, status, actor, true)?;
        if subtask.status == status {
            return Ok(task);
        }
        subtask.status = status;
        subtask.updated_at = Some(now_ms());
        task.updated_at = Some(now_ms());
        let revision = task.rev;
        let task = self.tasks.update(task, revision)?;
        drop(_g);
        self.emit_changed(task.clone());
        Ok(task)
    }
    pub fn patch_subtask(
        &self,
        id: &str,
        sub_id: &str,
        patch: SubTaskPatch,
        rev: u64,
        actor: Actor,
    ) -> Result<TaskItem, ServiceError> {
        let mut task = self.get(id)?;
        let subtask = task
            .sub_tasks
            .as_mut()
            .and_then(|items| items.iter_mut().find(|item| item.id == sub_id))
            .ok_or_else(|| ServiceError::new(ServiceErrorCode::NotFound, "Subtask not found"))?;
        if let Some(title) = patch.title {
            subtask.title = title;
        }
        if let Some(description) = patch.description {
            subtask.description = description;
        }
        if let Some(status) = patch.status {
            subtask.status = status;
        }
        self.update_subtask(id, sub_id, subtask.clone(), rev, actor)
    }
    pub fn delete_subtask(
        &self,
        id: &str,
        sub_id: &str,
        rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        let mut t = self.get(id)?;
        if let Some(v) = t.sub_tasks.as_mut() {
            v.retain(|x| x.id != sub_id);
        }
        t.updated_at = Some(now_ms());
        let t = self.tasks.update(t, rev)?;
        drop(_g);
        self.emit_changed(t.clone());
        Ok(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        services::{note_service::NoteService, service_error::RecordingSink},
        types::{
            note::NoteItem,
            task::{TaskItem, TaskStatus},
        },
    };
    use tempfile::tempdir;
    fn services(root: &Path) -> (TaskService, NoteService, RecordingSink) {
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        (
            TaskService::new(root, lock.clone(), sink.clone()),
            NoteService::new(root, lock, sink.clone()),
            sink,
        )
    }
    #[test]
    fn own_task_write_is_suppressed_and_same_rev_external_edit_reloads() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let created = s.create(TaskItem::new("before")).unwrap();
        sink.take();
        assert!(!s.reload_external(&created.id).unwrap());
        assert!(sink.events().is_empty());
        let mut edited = created.clone();
        edited.title = "after".into();
        std::fs::write(
            d.path()
                .join(".praide/tasks")
                .join(format!("{}.json", created.id)),
            serde_json::to_vec_pretty(&edited).unwrap(),
        )
        .unwrap();
        assert!(s.reload_external(&created.id).unwrap());
        assert!(sink.events().iter().any(
            |e| matches!(e,ChangeEvent::TaskReloaded(x) if x.title=="after" && x.rev==created.rev)
        ));
    }
    #[test]
    fn own_task_delete_is_suppressed() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let t = s.create(TaskItem::new("delete")).unwrap();
        sink.take();
        s.delete(&t.id).unwrap();
        sink.take();
        assert!(!s.reload_external(&t.id).unwrap());
        assert!(sink.events().is_empty());
    }
    #[test]
    fn update_patch_cannot_change_other_fields() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let mut t = s.create(TaskItem::new("one")).unwrap();
        t.depends_on = Some("some-dependency".into());
        let before = s.get(&t.id).unwrap();
        let x = s
            .update(
                &t.id,
                TaskPatch {
                    title: Some("changed".into()),
                    description: Some(None),
                },
                before.rev,
            )
            .unwrap();
        assert_eq!(x.status, TaskStatus::Ready);
        assert_eq!(x.depends_on, None);
        assert_eq!(x.linked_note_ids, None);
        assert_eq!(x.sub_tasks, None);
    }
    #[test]
    fn create_ignores_requested_status_and_resets_subtasks() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let mut t = TaskItem::new("one");
        t.status = TaskStatus::Running;
        t.sub_tasks = Some(vec![SubTask::new("sub")]);
        let x = s.create(t).unwrap();
        assert_eq!(x.status, TaskStatus::Ready);
        assert_eq!(x.sub_tasks.unwrap()[0].status, TaskStatus::Ready);
    }
    #[test]
    fn corrupt_task_is_in_report_and_good_records_load() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        s.create(TaskItem::new("good")).unwrap();
        std::fs::create_dir_all(d.path().join(".praide/tasks")).unwrap();
        std::fs::write(d.path().join(".praide/tasks/bad.json"), "{").unwrap();
        let report = s.list().unwrap();
        assert_eq!(report.records.len(), 1);
        assert_eq!(report.errors.len(), 1);
    }
    #[test]
    fn note_delete_and_task_update_share_lock_without_deadlock() {
        let d = tempdir().unwrap();
        let (s, n, _) = services(d.path());
        let note = n.create(NoteItem::new("n")).unwrap();
        let mut task = TaskItem::new("t");
        task.linked_note_ids = Some(vec![note.id.clone()]);
        let task = s.create(task).unwrap();
        let id = task.id.clone();
        let note_id = note.id.clone();
        let rev = task.rev;
        let title_thread = std::thread::spawn(move || {
            s.update(
                &id,
                TaskPatch {
                    title: Some("updated".into()),
                    description: None,
                },
                rev,
            )
        });
        let delete_thread = std::thread::spawn(move || n.delete(&note_id));
        let _update_result = title_thread.join().unwrap();
        assert!(delete_thread.join().unwrap().is_ok());
    }

    #[test]
    fn transition_matrix_matches_architecture_and_actor_permissions() {
        use crate::services::storage::FileRepository;
        let allowed = [
            (TaskStatus::Ready, TaskStatus::Running, Actor::Ui),
            (TaskStatus::Ready, TaskStatus::Running, Actor::System),
            (TaskStatus::Ready, TaskStatus::Blocked, Actor::System),
            (TaskStatus::Blocked, TaskStatus::Ready, Actor::System),
            (TaskStatus::Running, TaskStatus::NeedsReview, Actor::Script),
            (TaskStatus::Running, TaskStatus::NeedsReview, Actor::System),
            (TaskStatus::Running, TaskStatus::Failed, Actor::System),
            (TaskStatus::Running, TaskStatus::Completed, Actor::Ui),
            (TaskStatus::NeedsReview, TaskStatus::Completed, Actor::Ui),
            (TaskStatus::NeedsReview, TaskStatus::Ready, Actor::Ui),
            (TaskStatus::Failed, TaskStatus::Ready, Actor::Ui),
            (TaskStatus::Completed, TaskStatus::Ready, Actor::Ui),
        ];
        let statuses = [
            TaskStatus::Ready,
            TaskStatus::Running,
            TaskStatus::Blocked,
            TaskStatus::NeedsReview,
            TaskStatus::Completed,
            TaskStatus::Failed,
        ];
        for from in statuses {
            for to in statuses {
                for actor in [Actor::Ui, Actor::Script, Actor::System] {
                    let d = tempdir().unwrap();
                    let (service, _, sink) = services(d.path());
                    let mut initial = TaskItem::new("matrix");
                    initial.status = from;
                    let repository = FileRepository::for_tasks(d.path());
                    let stored = repository.create(initial).unwrap();
                    let pair_allowed = allowed.iter().any(|(f, t, _)| *f == from && *t == to);
                    let actor_allowed = allowed.contains(&(from, to, actor));
                    let result = service.set_status(&stored.id, to, stored.rev, actor);
                    if from == to {
                        assert!(result.is_ok(), "same state {from:?} actor {actor:?}");
                        assert_eq!(service.get(&stored.id).unwrap().rev, stored.rev);
                        assert!(sink.events().is_empty());
                    } else if actor_allowed {
                        assert!(
                            result.is_ok(),
                            "allowed {from:?}->{to:?} {actor:?}: {result:?}"
                        );
                    } else if pair_allowed {
                        assert_eq!(
                            result.unwrap_err().code,
                            ServiceErrorCode::Forbidden,
                            "{from:?}->{to:?} {actor:?}"
                        );
                    } else {
                        assert_eq!(
                            result.unwrap_err().code,
                            ServiceErrorCode::InvalidTransition,
                            "{from:?}->{to:?} {actor:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn status_forbidden_invalid_transition_and_stale_precedence() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let mut t = TaskItem::new("x");
        t.status = TaskStatus::NeedsReview;
        let t = crate::services::storage::FileRepository::for_tasks(d.path())
            .create(t)
            .unwrap();
        assert_eq!(
            s.set_status(&t.id, TaskStatus::Completed, t.rev, Actor::Script)
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
        assert_eq!(
            s.set_status(&t.id, TaskStatus::Running, t.rev, Actor::Ui)
                .unwrap_err()
                .code,
            ServiceErrorCode::InvalidTransition
        );
        assert_eq!(
            s.set_status(&t.id, TaskStatus::Ready, t.rev + 1, Actor::Ui)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
        assert!(sink.events().is_empty());
    }

    #[test]
    fn sink_can_read_service_after_status_write_without_deadlock() {
        use std::sync::{mpsc, Weak};
        struct ReadSink(Arc<Mutex<Option<Weak<TaskService>>>>, mpsc::Sender<()>);
        impl EventSink for ReadSink {
            fn emit(&self, _: ChangeEvent) {
                if let Some(s) = self.0.lock().unwrap().as_ref().and_then(Weak::upgrade) {
                    let _ = s.get("reentrant");
                }
                let _ = self.1.send(());
            }
        }
        let d = tempdir().unwrap();
        let state = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel();
        let service = Arc::new(TaskService::new(
            d.path(),
            Arc::new(Mutex::new(())),
            ReadSink(state.clone(), tx),
        ));
        *state.lock().unwrap() = Some(Arc::downgrade(&service));
        let mut task = TaskItem::new("reentrant");
        task.id = "reentrant".into();
        let task = service.create(task).unwrap();
        let _ = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        let call = Arc::clone(&service);
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let result = call.set_status(&task.id, TaskStatus::Running, task.rev, Actor::Ui);
            let _ = done_tx.send(result);
        });
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .is_ok());
    }

    #[test]
    fn start_requires_ready_and_completed_dependency() {
        use crate::services::storage::FileRepository;
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let repo = FileRepository::for_tasks(d.path());
        let mut dep = TaskItem::new("dep");
        dep.status = TaskStatus::Running;
        let dep = repo.create(dep).unwrap();
        let mut child = TaskItem::new("child");
        child.depends_on = Some(dep.id.clone());
        child.status = TaskStatus::Blocked;
        let child = repo.create(child).unwrap();
        assert_eq!(
            s.start(&child.id, child.rev, Actor::Ui).unwrap_err().code,
            ServiceErrorCode::InvalidTransition
        );
        let dep_now = s.complete(&dep.id, dep.rev).unwrap();
        let refreshed = s.get(&child.id).unwrap();
        assert_eq!(refreshed.status, TaskStatus::Ready);
        assert!(s.start(&child.id, refreshed.rev, Actor::Ui).is_ok());
        assert_eq!(
            s.start(&dep_now.id, dep_now.rev, Actor::Ui)
                .unwrap_err()
                .code,
            ServiceErrorCode::InvalidTransition
        );
    }

    #[test]
    fn start_with_run_updates_status_and_history_in_one_write_and_event() {
        let d = tempdir().unwrap();
        let (service, _, sink) = services(d.path());
        let task = service.create(TaskItem::new("task")).unwrap();
        sink.take();

        let started = service
            .start_with_run(&task.id, task.rev, "run-1".into(), Actor::Ui)
            .unwrap();

        assert_eq!(started.status, TaskStatus::Running);
        assert_eq!(
            started.runs.as_deref(),
            Some(["run-1".to_owned()].as_slice())
        );
        assert_eq!(started.rev, task.rev + 1);
        assert_eq!(sink.events(), [ChangeEvent::TaskUpdated(started.clone())]);
    }

    #[test]
    fn retry_start_appends_runs_in_attempt_order() {
        let d = tempdir().unwrap();
        let (service, _, _) = services(d.path());
        let task = service.create(TaskItem::new("task")).unwrap();
        let first = service
            .start_with_run(&task.id, task.rev, "run-1".into(), Actor::Ui)
            .unwrap();
        let running = service
            .set_status(&first.id, TaskStatus::Failed, first.rev, Actor::System)
            .unwrap();
        let ready = service
            .set_status(&running.id, TaskStatus::Ready, running.rev, Actor::Ui)
            .unwrap();

        let retried = service
            .start_with_run(&ready.id, ready.rev, "run-2".into(), Actor::Ui)
            .unwrap();

        assert_eq!(
            retried.runs.as_deref(),
            Some(["run-1".to_owned(), "run-2".to_owned()].as_slice())
        );
    }

    #[test]
    fn start_with_run_keeps_only_the_newest_fifty_ids() {
        let d = tempdir().unwrap();
        let (service, _, _) = services(d.path());
        let mut task = TaskItem::new("task");
        task.runs = Some((0..50).map(|index| format!("run-{index}")).collect());
        let task = service.create(task).unwrap();

        let started = service
            .start_with_run(&task.id, task.rev, "run-50".into(), Actor::Ui)
            .unwrap();

        let runs = started.runs.unwrap();
        assert_eq!(runs.len(), 50);
        assert_eq!(runs.first().map(String::as_str), Some("run-1"));
        assert_eq!(runs.last().map(String::as_str), Some("run-50"));
    }

    #[test]
    fn hand_written_task_with_unknown_run_id_loads() {
        let d = tempdir().unwrap();
        let (service, _, _) = services(d.path());
        let task_id = "hand-written";
        std::fs::create_dir_all(d.path().join(".praide/tasks")).unwrap();
        std::fs::write(
            d.path()
                .join(".praide/tasks")
                .join(format!("{task_id}.json")),
            r#"{"id":"hand-written","title":"task","status":"ready","createdAt":1,"schemaVersion":1,"rev":1,"runs":["bogus-run-id"]}"#,
        )
        .unwrap();

        let loaded = service.get(task_id).unwrap();

        assert_eq!(
            loaded.runs.as_deref(),
            Some(["bogus-run-id".to_owned()].as_slice())
        );
    }

    #[test]
    fn task_json_includes_runs_in_camel_case() {
        let mut task = TaskItem::new("task");
        task.id = "task-id".into();
        task.created_at = 1;
        task.runs = Some(vec!["run-1".into()]);

        assert_eq!(
            serde_json::to_value(task).unwrap(),
            serde_json::json!({
                "id": "task-id",
                "title": "task",
                "status": "ready",
                "createdAt": 1,
                "runs": ["run-1"],
                "schemaVersion": 2,
                "rev": 0
            })
        );
    }

    #[test]
    fn completing_dependency_unblocks_once_and_emits_both_records() {
        use crate::services::storage::FileRepository;
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let repo = FileRepository::for_tasks(d.path());
        let mut dep = TaskItem::new("dep");
        dep.status = TaskStatus::Running;
        let dep = repo.create(dep).unwrap();
        let mut child = TaskItem::new("child");
        child.depends_on = Some(dep.id.clone());
        child.status = TaskStatus::Blocked;
        let child = repo.create(child).unwrap();
        s.complete(&dep.id, dep.rev).unwrap();
        let events = sink.take();
        let updated: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let ChangeEvent::TaskUpdated(t) = e {
                    Some(t.id.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(updated.iter().filter(|id| **id == dep.id).count(), 1);
        assert_eq!(updated.iter().filter(|id| **id == child.id).count(), 1);
        assert_eq!(updated.len(), 2);
        assert_eq!(s.get(&child.id).unwrap().status, TaskStatus::Ready);
    }

    #[test]
    fn dependency_creation_rejects_self_missing_and_two_or_three_node_cycles() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let a = s.create(TaskItem::new("a")).unwrap();
        let b = s.create(TaskItem::new("b")).unwrap();
        let c = s.create(TaskItem::new("c")).unwrap();
        assert_eq!(
            s.set_dependency(&a.id, Some(a.id.clone()), a.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        assert_eq!(
            s.set_dependency(&a.id, Some("missing".into()), a.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        s.set_dependency(&b.id, Some(a.id.clone()), b.rev).unwrap();
        let a_now = s.get(&a.id).unwrap();
        assert_eq!(
            s.set_dependency(&a.id, Some(b.id.clone()), a_now.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        let c_now = s.get(&c.id).unwrap();
        s.set_dependency(&c.id, Some(b.id.clone()), c_now.rev)
            .unwrap();
        let a_now = s.get(&a.id).unwrap();
        assert_eq!(
            s.set_dependency(&a.id, Some(c.id.clone()), a_now.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn reconcile_is_idempotent_preserves_terminal_and_active_statuses_and_dangling_links() {
        use crate::services::storage::FileRepository;
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let repo = FileRepository::for_tasks(d.path());
        let mut records = Vec::new();
        for status in [
            TaskStatus::Running,
            TaskStatus::NeedsReview,
            TaskStatus::Failed,
            TaskStatus::Completed,
        ] {
            let mut t = TaskItem::new(format!("{status:?}"));
            t.status = status;
            t.depends_on = Some("missing-dep".into());
            records.push(repo.create(t).unwrap());
        }
        let mut dangling = TaskItem::new("dangling");
        dangling.depends_on = Some("missing-dep".into());
        let dangling = repo.create(dangling).unwrap();
        assert!(s.reconcile().unwrap().is_empty());
        assert_eq!(s.get(&dangling.id).unwrap().status, TaskStatus::Ready);
        assert_eq!(
            s.get(&dangling.id).unwrap().depends_on,
            Some("missing-dep".into())
        );
        for original in records {
            let current = s.get(&original.id).unwrap();
            assert_eq!(current.status, original.status);
            assert_eq!(current.rev, original.rev);
        }
        sink.take();
        assert!(s.reconcile().unwrap().is_empty());
        assert!(sink.events().is_empty());
    }

    #[test]
    fn reconcile_changes_only_ready_or_blocked_tasks() {
        use crate::services::storage::FileRepository;
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let repo = FileRepository::for_tasks(d.path());
        let mut blocker = TaskItem::new("blocker");
        blocker.status = TaskStatus::Running;
        let blocker = repo.create(blocker).unwrap();
        let mut list = Vec::new();
        for status in [
            TaskStatus::Running,
            TaskStatus::NeedsReview,
            TaskStatus::Failed,
            TaskStatus::Completed,
        ] {
            let mut t = TaskItem::new(format!("{status:?}"));
            t.status = status;
            t.depends_on = Some(blocker.id.clone());
            list.push(repo.create(t).unwrap());
        }
        assert!(s.reconcile().unwrap().is_empty());
        for t in list {
            assert_eq!(s.get(&t.id).unwrap().rev, t.rev);
        }
    }

    #[test]
    fn stale_status_update_emits_nothing_and_same_status_is_noop() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let t = s.create(TaskItem::new("x")).unwrap();
        sink.take();
        assert_eq!(
            s.set_status(&t.id, TaskStatus::Ready, t.rev, Actor::Ui)
                .unwrap()
                .rev,
            t.rev
        );
        assert!(sink.events().is_empty());
        assert_eq!(
            s.set_status(&t.id, TaskStatus::Running, t.rev + 5, Actor::Ui)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
        assert!(sink.events().is_empty());
    }

    #[test]
    fn stale_update_link_and_add_subtask_emit_nothing() {
        let d = tempdir().unwrap();
        let (s, n, sink) = services(d.path());
        let note = n.create(NoteItem::new("n")).unwrap();
        let t = s.create(TaskItem::new("t")).unwrap();
        sink.take();
        assert_eq!(
            s.update(
                &t.id,
                TaskPatch {
                    title: Some("x".into()),
                    description: None
                },
                t.rev + 1
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::StaleRev
        );
        assert_eq!(
            s.link_note(&t.id, &note.id, t.rev + 1).unwrap_err().code,
            ServiceErrorCode::StaleRev
        );
        assert_eq!(
            s.add_subtask(&t.id, SubTask::new("sub"), t.rev + 1)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
        assert!(sink.events().is_empty());
    }

    #[test]
    fn script_cannot_complete_subtask_but_ui_can() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let t = s.create(TaskItem::new("parent")).unwrap();
        let t = s.add_subtask(&t.id, SubTask::new("sub"), t.rev).unwrap();
        let mut sub = t.sub_tasks.unwrap()[0].clone();
        let sub_id = sub.id.clone();
        sub.status = TaskStatus::Completed;
        assert_eq!(
            s.update_subtask(&t.id, &sub_id, sub.clone(), t.rev, Actor::Script)
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
        let completed = s
            .update_subtask(&t.id, &sub_id, sub, t.rev, Actor::Ui)
            .unwrap();
        assert_eq!(
            completed.sub_tasks.unwrap()[0].status,
            TaskStatus::Completed
        );
        assert_eq!(
            s.set_subtask_status(&t.id, &sub_id, TaskStatus::Failed, Actor::Script)
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
    }

    #[test]
    fn completing_task_completes_only_review_subtasks_in_one_update() {
        let d = tempdir().unwrap();
        let (service, _, sink) = services(d.path());
        let mut task = TaskItem::new("parent");
        task.status = TaskStatus::Running;
        let reviewed = SubTask::new("reviewed");
        let failed = SubTask::new("failed");
        let ready = SubTask::new("ready");
        let completed = SubTask::new("completed");
        task.sub_tasks = Some(vec![reviewed, failed, ready, completed]);
        let mut task = service.create(task).unwrap();
        let statuses = task
            .sub_tasks
            .as_ref()
            .unwrap()
            .iter()
            .map(|subtask| subtask.id.clone())
            .zip([
                TaskStatus::NeedsReview,
                TaskStatus::Failed,
                TaskStatus::Ready,
                TaskStatus::Completed,
            ])
            .collect::<Vec<_>>();
        for (subtask_id, status) in statuses {
            if status != TaskStatus::Ready {
                task = service
                    .set_subtask_status(&task.id, &subtask_id, status, Actor::Ui)
                    .unwrap();
            }
        }
        task = service.start(&task.id, task.rev, Actor::Ui).unwrap();
        let baseline = task.sub_tasks.clone().unwrap();
        sink.take();

        let completed_task = service.complete(&task.id, task.rev).unwrap();
        let subtasks = completed_task.sub_tasks.as_ref().unwrap();
        assert_eq!(subtasks[0].status, TaskStatus::Completed);
        assert!(subtasks[0].updated_at.is_some());
        assert_eq!(subtasks[1], baseline[1]);
        assert_eq!(subtasks[2], baseline[2]);
        assert_eq!(subtasks[3], baseline[3]);
        assert_eq!(completed_task.rev, task.rev + 1);
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(event, ChangeEvent::TaskUpdated(_)))
                .count(),
            1
        );

        sink.take();
        let reopened = service
            .set_status(
                &completed_task.id,
                TaskStatus::Ready,
                completed_task.rev,
                Actor::Ui,
            )
            .unwrap();
        assert_eq!(reopened.sub_tasks, completed_task.sub_tasks);
    }

    #[test]
    fn status_change_that_unblocks_emits_exactly_one_event_per_record() {
        use crate::services::storage::FileRepository;
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let repo = FileRepository::for_tasks(d.path());
        let mut dep = TaskItem::new("dep");
        dep.status = TaskStatus::Running;
        let dep = repo.create(dep).unwrap();
        let mut child = TaskItem::new("child");
        child.status = TaskStatus::Blocked;
        child.depends_on = Some(dep.id.clone());
        repo.create(child).unwrap();
        s.complete(&dep.id, dep.rev).unwrap();
        let events = sink.events();
        let changed: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let ChangeEvent::TaskUpdated(t) = e {
                    Some(t.id.clone())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(changed.len(), 2);
        assert_eq!(changed.iter().filter(|id| **id == dep.id).count(), 1);
    }

    #[test]
    fn create_with_unfinished_dependency_is_blocked_and_task_delete_clears_dependents() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let dep = s.create(TaskItem::new("dep")).unwrap();
        let mut child = TaskItem::new("child");
        child.depends_on = Some(dep.id.clone());
        let child = s.create(child).unwrap();
        assert_eq!(child.status, TaskStatus::Blocked);
        s.delete(&dep.id).unwrap();
        let child = s.get(&child.id).unwrap();
        assert_eq!(child.depends_on, None);
        assert_eq!(child.status, TaskStatus::Ready);
    }

    struct FakeRunGuard {
        active_task_id: Option<String>,
        active_run_id: Option<String>,
    }

    impl RunGuard for FakeRunGuard {
        fn is_task_run_active(&self, task_id: &str) -> bool {
            self.active_task_id.as_deref() == Some(task_id)
        }

        fn is_run_active(&self, run_id: &str) -> bool {
            self.active_run_id.as_deref() == Some(run_id)
        }
    }

    fn write_run_folder(root: &Path, run_id: &str, run_json: &str) -> PathBuf {
        let dir = root.join(".praide").join("runs").join(run_id);
        std::fs::create_dir_all(dir.join("calls")).unwrap();
        std::fs::create_dir_all(dir.join("patches")).unwrap();
        std::fs::write(dir.join("run.json"), run_json).unwrap();
        std::fs::write(dir.join("run.log"), "log line\n").unwrap();
        std::fs::write(dir.join("trace.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("calls").join("1.json"), "{}").unwrap();
        std::fs::write(dir.join("patches").join("p1.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn delete_task_cascades_to_finished_runs_and_preserves_other_tasks() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let task = s.create(TaskItem::new("target")).unwrap();
        let other = s.create(TaskItem::new("other")).unwrap();

        let r1 = write_run_folder(
            d.path(),
            "run-1",
            &format!(r#"{{"runId":"run-1","taskId":"{}","endedAt":10}}"#, task.id),
        );
        let r2 = write_run_folder(
            d.path(),
            "run-2",
            &format!(r#"{{"runId":"run-2","taskId":"{}","endedAt":20}}"#, task.id),
        );
        let r_other = write_run_folder(
            d.path(),
            "run-other",
            &format!(
                r#"{{"runId":"run-other","taskId":"{}","endedAt":30}}"#,
                other.id
            ),
        );

        sink.take();
        s.delete(&task.id).unwrap();

        assert!(!r1.exists());
        assert!(!r2.exists());
        assert!(r_other.exists());

        let deleted_runs: Vec<String> = sink
            .events()
            .into_iter()
            .filter_map(|e| match e {
                ChangeEvent::RunDeleted(id) => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(deleted_runs.len(), 2);
        assert!(deleted_runs.contains(&"run-1".to_string()));
        assert!(deleted_runs.contains(&"run-2".to_string()));
    }

    #[test]
    fn delete_task_with_active_run_returns_run_active_and_leaves_task_and_run_untouched() {
        let d = tempdir().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        let seed = TaskService::new(d.path(), lock.clone(), sink.clone());
        let task = seed.create(TaskItem::new("active-task")).unwrap();
        let run_dir = write_run_folder(
            d.path(),
            "run-active",
            &format!(r#"{{"runId":"run-active","taskId":"{}"}}"#, task.id),
        );

        let service =
            TaskService::new(d.path(), lock, sink.clone()).with_run_guard(Arc::new(FakeRunGuard {
                active_task_id: Some(task.id.clone()),
                active_run_id: Some("run-active".into()),
            }));

        sink.take();
        let err = service.delete(&task.id).unwrap_err();
        assert_eq!(err.code, ServiceErrorCode::RunActive);
        assert!(service.get(&task.id).is_ok());
        assert!(run_dir.exists());
        assert!(sink.events().is_empty());
    }

    #[test]
    fn delete_task_succeeds_when_one_run_folder_fails_to_delete() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let task = s.create(TaskItem::new("locked-run-task")).unwrap();

        let locked_dir = write_run_folder(
            d.path(),
            "run-locked",
            &format!(
                r#"{{"runId":"run-locked","taskId":"{}","endedAt":10}}"#,
                task.id
            ),
        );
        let removable_dir = write_run_folder(
            d.path(),
            "run-removable",
            &format!(
                r#"{{"runId":"run-removable","taskId":"{}","endedAt":20}}"#,
                task.id
            ),
        );

        // Hold an open handle inside `run-locked` on Windows (or make dir read-only on Unix)
        // so removing `run-locked` fails while `run-removable` succeeds.
        #[cfg(windows)]
        let _locked_handle = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .share_mode(0)
                .open(locked_dir.join("run.log"))
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        }

        sink.take();
        s.delete(&task.id).unwrap();

        assert_eq!(
            s.get(&task.id).unwrap_err().code,
            ServiceErrorCode::NotFound
        );
        assert!(!removable_dir.exists());

        let events = sink.events();
        assert!(events
            .iter()
            .any(|e| matches!(e, ChangeEvent::TaskDeleted(id) if id == &task.id)));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChangeEvent::RunDeleted(id) if id == "run-removable")));
        assert!(!events
            .iter()
            .any(|e| matches!(e, ChangeEvent::RunDeleted(id) if id == "run-locked")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn load_orphan_sweep_removes_orphans_and_preserves_special_folders_and_is_idempotent() {
        let d = tempdir().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        let seed = TaskService::new(d.path(), lock.clone(), sink.clone());
        let existing_task = seed.create(TaskItem::new("existing")).unwrap();

        let orphan_dir = write_run_folder(
            d.path(),
            "run-orphan",
            r#"{"runId":"run-orphan","taskId":"missing-task","endedAt":10}"#,
        );
        let valid_dir = write_run_folder(
            d.path(),
            "run-valid",
            &format!(
                r#"{{"runId":"run-valid","taskId":"{}","endedAt":20}}"#,
                existing_task.id
            ),
        );
        let active_orphan_dir = write_run_folder(
            d.path(),
            "run-active-orphan",
            r#"{"runId":"run-active-orphan","taskId":"missing-task"}"#,
        );
        let taskless_dir = write_run_folder(
            d.path(),
            "run-taskless",
            r#"{"runId":"run-taskless","endedAt":30}"#,
        );
        let corrupt_dir = write_run_folder(d.path(), "run-corrupt", "{not valid json");
        let proposals_dir = d.path().join(".praide").join("runs").join("proposals");
        std::fs::create_dir_all(&proposals_dir).unwrap();
        std::fs::write(proposals_dir.join("p1.json"), "{}").unwrap();

        let service =
            TaskService::new(d.path(), lock, sink.clone()).with_run_guard(Arc::new(FakeRunGuard {
                active_task_id: None,
                active_run_id: Some("run-active-orphan".into()),
            }));

        sink.take();
        service.load().unwrap();

        assert!(!orphan_dir.exists());
        assert!(valid_dir.exists());
        assert!(active_orphan_dir.exists());
        assert!(taskless_dir.exists());
        assert!(corrupt_dir.exists());
        assert!(proposals_dir.exists());
        assert!(proposals_dir.join("p1.json").exists());

        let deleted_runs: Vec<String> = sink
            .events()
            .into_iter()
            .filter_map(|e| match e {
                ChangeEvent::RunDeleted(id) => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(deleted_runs, vec!["run-orphan".to_string()]);

        // Second sweep is a no-op
        sink.take();
        service.reconcile().unwrap();
        assert!(!sink
            .events()
            .iter()
            .any(|e| matches!(e, ChangeEvent::RunDeleted(_))));
    }

    #[test]
    fn crafted_task_id_with_path_separators_never_deletes_outside_runs() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let outside = d.path().join("outside-secret");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "safe").unwrap();

        let crafted_run = write_run_folder(
            d.path(),
            "run-crafted",
            r#"{"runId":"run-crafted","taskId":"../../outside-secret","endedAt":10}"#,
        );

        assert_eq!(
            s.delete("../../outside-secret").unwrap_err().code,
            ServiceErrorCode::Validation
        );
        assert!(outside.join("keep.txt").exists());

        // Orphan sweep deletes only the run folder inside `.praide/runs/`, never `outside-secret`
        s.load().unwrap();
        assert!(!crafted_run.exists());
        assert!(outside.join("keep.txt").exists());
    }

    fn file_anchor(path: &str) -> FileAnchor {
        FileAnchor {
            kind: crate::types::task::FileAnchorKind::File,
            path: path.into(),
            label: None,
            line_number: None,
        }
    }

    #[test]
    fn legacy_task_with_single_anchor_loads_and_rewrites_on_save() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let tasks_dir = d.path().join(".praide/tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        let path = tasks_dir.join("legacy-task.json");
        std::fs::write(
            &path,
            r#"{"id":"legacy-task","title":"Legacy","anchor":{"kind":"file","path":"src/main.rs"},"status":"ready","createdAt":1,"schemaVersion":1,"rev":1}"#,
        )
        .unwrap();

        let loaded = s.get("legacy-task").unwrap();
        assert_eq!(loaded.anchors, Some(vec![file_anchor("src/main.rs")]));

        let updated = s
            .set_anchors(
                "legacy-task",
                Some(vec![file_anchor("src/main.rs"), file_anchor("src/lib.rs")]),
                loaded.rev,
            )
            .unwrap();
        assert_eq!(updated.schema_version, TASK_SCHEMA_VERSION);
        assert_eq!(updated.anchors.as_ref().map(Vec::len), Some(2));

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(raw.get("anchor").is_none());
        assert_eq!(raw["anchors"].as_array().unwrap().len(), 2);
        assert_eq!(raw["schemaVersion"], TASK_SCHEMA_VERSION);
    }

    #[test]
    fn task_with_both_anchor_and_anchors_prefers_anchors() {
        let d = tempdir().unwrap();
        let (s, _, _) = services(d.path());
        let tasks_dir = d.path().join(".praide/tasks");
        std::fs::create_dir_all(&tasks_dir).unwrap();
        std::fs::write(
            tasks_dir.join("both-keys.json"),
            r#"{"id":"both-keys","title":"Both","anchor":{"kind":"file","path":"old.rs"},"anchors":[{"kind":"file","path":"new.rs"}],"status":"ready","createdAt":1,"schemaVersion":2,"rev":1}"#,
        )
        .unwrap();

        let loaded = s.get("both-keys").unwrap();
        assert_eq!(loaded.anchors, Some(vec![file_anchor("new.rs")]));
    }

    #[test]
    fn set_anchors_replaces_clears_and_validates() {
        let d = tempdir().unwrap();
        let (s, _, sink) = services(d.path());
        let created = s.create(TaskItem::new("Anchors")).unwrap();
        assert_eq!(created.anchors, None);
        sink.take();

        let replaced = s
            .set_anchors(&created.id, Some(vec![file_anchor("a.rs")]), created.rev)
            .unwrap();
        assert_eq!(replaced.anchors, Some(vec![file_anchor("a.rs")]));
        assert!(matches!(
            sink.take().as_slice(),
            [ChangeEvent::TaskUpdated(t)] if t.anchors == Some(vec![file_anchor("a.rs")])
        ));

        // Stale expectedRev rejected
        assert_eq!(
            s.set_anchors(&created.id, None, created.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );

        // Clear with None
        let cleared_null = s.set_anchors(&created.id, None, replaced.rev).unwrap();
        assert_eq!(cleared_null.anchors, None);

        // Set again then clear with []
        let set_again = s
            .set_anchors(
                &created.id,
                Some(vec![file_anchor("b.rs")]),
                cleared_null.rev,
            )
            .unwrap();
        let cleared_empty = s
            .set_anchors(&created.id, Some(vec![]), set_again.rev)
            .unwrap();
        assert_eq!(cleared_empty.anchors, None);

        // 21 anchors rejected with Validation
        let too_many: Vec<FileAnchor> = (0..21)
            .map(|i| file_anchor(&format!("src/file_{i}.rs")))
            .collect();
        assert_eq!(
            s.set_anchors(&created.id, Some(too_many), cleared_empty.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );

        // Duplicate anchor (same kind + path + lineNumber) rejected with Validation
        let dup = vec![
            FileAnchor {
                kind: crate::types::task::FileAnchorKind::Function,
                path: "src/lib.rs".into(),
                label: Some("first".into()),
                line_number: Some(10),
            },
            FileAnchor {
                kind: crate::types::task::FileAnchorKind::Function,
                path: "src/lib.rs".into(),
                label: Some("second".into()),
                line_number: Some(10),
            },
        ];
        assert_eq!(
            s.set_anchors(&created.id, Some(dup), cleared_empty.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }
}
