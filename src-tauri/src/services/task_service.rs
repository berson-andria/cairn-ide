use crate::{
    services::{
        service_error::{now_ms, Actor, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
        storage::{FileRepository, Repository},
    },
    types::{
        note::NoteItem,
        task::{SubTask, TaskItem, TaskStatus},
    },
};
use serde::{Deserialize, Deserializer};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
};

fn deserialize_some<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewSubTask {
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewTask {
    pub title: String,
    pub description: Option<String>,
    pub anchor: Option<crate::types::task::FileAnchor>,
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
    lock: Arc<Mutex<()>>,
    sink: Box<dyn EventSink>,
}
impl TaskService {
    pub fn new(
        root: impl AsRef<Path>,
        lock: Arc<Mutex<()>>,
        sink: impl EventSink + 'static,
    ) -> Self {
        Self {
            tasks: FileRepository::for_tasks(&root),
            notes: FileRepository::for_notes(root),
            lock,
            sink: Box::new(sink),
        }
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
        let ids = changed.iter().map(|t| t.id.clone()).collect();
        drop(_g);
        for task in changed {
            self.emit_changed(task);
        }
        Ok(ids)
    }
    pub fn load(&self) -> Result<Vec<TaskItem>, ServiceError> {
        let _g = self.lock()?;
        let changed = self.reconcile_locked()?;
        let tasks = self.all()?;
        drop(_g);
        for task in changed {
            self.emit_changed(task);
        }
        self.sink.emit(ChangeEvent::ProjectReloaded);
        Ok(tasks)
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
    pub fn create(&self, mut task: TaskItem) -> Result<TaskItem, ServiceError> {
        let _g = self.lock()?;
        self.validate_dependency(&task.id, task.depends_on.as_deref())?;
        if let Some(ids) = task.linked_note_ids.as_ref() {
            for id in ids {
                self.notes
                    .get(id)
                    .map_err(|_| ServiceError::validation(format!("Linked note {id} not found")))?;
            }
        }
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
        let t = self.tasks.create(task)?;
        let changed = match self.reconcile_locked() {
            Ok(v) => v,
            Err(e) => {
                tauri_plugin_log::log::error!("Task reconcile failed after create: {e}");
                Vec::new()
            }
        };
        let result = self.tasks.get(&t.id)?;
        drop(_g);
        self.sink.emit(ChangeEvent::TaskCreated(t));
        for task in changed {
            self.emit_changed(task);
        }
        Ok(result)
    }
    pub fn create_input(&self, input: NewTask) -> Result<TaskItem, ServiceError> {
        let mut task = TaskItem::new(input.title);
        task.description = input.description;
        task.anchor = input.anchor;
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
        self.create(task)
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
        if t.status == status {
            return Ok(t);
        }
        Self::check_transition(t.status, status, actor, false)?;
        t.status = status;
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
    pub fn set_anchor(
        &self,
        id: &str,
        anchor: Option<crate::types::task::FileAnchor>,
        expected_rev: u64,
    ) -> Result<TaskItem, ServiceError> {
        let mut t = self.get(id)?;
        t.anchor = anchor;
        let _g = self.lock()?;
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
        let _g = self.lock()?;
        self.tasks.delete(id)?;
        let mut changed_records = Vec::new();
        for mut t in self.all()? {
            if t.depends_on.as_deref() == Some(id) {
                t.depends_on = None;
                t.updated_at = Some(now_ms());
                let x = self.tasks.update(t.clone(), t.rev)?;
                changed_records.push(x);
            }
        }
        match self.reconcile_locked() {
            Ok(v) => changed_records.extend(v),
            Err(e) => tauri_plugin_log::log::error!("Task reconcile failed after delete: {e}"),
        }
        drop(_g);
        self.sink.emit(ChangeEvent::TaskDeleted(id.into()));
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
        std::fs::create_dir_all(d.path().join(".cairn/tasks")).unwrap();
        std::fs::write(d.path().join(".cairn/tasks/bad.json"), "{").unwrap();
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
        assert_eq!(
            s.update_subtask(&t.id, &sub_id, sub, t.rev, Actor::Ui)
                .unwrap()
                .sub_tasks
                .unwrap()[0]
                .status,
            TaskStatus::Completed
        );
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
}
