use crate::{
    services::{
        service_error::{now_ms, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
        storage::{FileRepository, Repository},
    },
    types::{
        note::{NoteAnchor, NoteItem, NoteStatus},
        task::TaskItem,
    },
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Debug, Default, Clone)]
pub struct NotePatch {
    pub content: Option<String>,
    pub r#type: Option<Option<String>>,
}
pub struct NoteService {
    notes: FileRepository<NoteItem>,
    tasks: FileRepository<TaskItem>,
    lock: Arc<Mutex<()>>,
    sink: Box<dyn EventSink>,
}
impl NoteService {
    pub fn new(
        root: impl AsRef<Path>,
        lock: Arc<Mutex<()>>,
        sink: impl EventSink + 'static,
    ) -> Self {
        Self {
            notes: FileRepository::for_notes(&root),
            tasks: FileRepository::for_tasks(root),
            lock,
            sink: Box::new(sink),
        }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ServiceError> {
        self.lock
            .lock()
            .map_err(|e| ServiceError::new(ServiceErrorCode::Io, e.to_string()))
    }
    fn emit_note(&self, n: NoteItem) {
        self.sink.emit(ChangeEvent::NoteUpdated(n));
    }
    pub fn list(&self) -> Result<super::storage::ListReport<NoteItem>, ServiceError> {
        Ok(self.notes.list()?)
    }
    pub fn get(&self, id: &str) -> Result<NoteItem, ServiceError> {
        Ok(self.notes.get(id)?)
    }
    pub fn create(&self, n: NoteItem) -> Result<NoteItem, ServiceError> {
        let _g = self.lock()?;
        let n = self.notes.create(n)?;
        drop(_g);
        self.sink.emit(ChangeEvent::NoteCreated(n.clone()));
        Ok(n)
    }
    pub fn update(&self, id: &str, patch: NotePatch, rev: u64) -> Result<NoteItem, ServiceError> {
        let _g = self.lock()?;
        let mut n = self.notes.get(id)?;
        if n.rev != rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        if let Some(content) = patch.content {
            n.content = content;
        }
        if let Some(typ) = patch.r#type {
            n.r#type = typ;
        }
        n.updated_at = Some(now_ms());
        let n = self.notes.update(n, rev)?;
        drop(_g);
        self.emit_note(n.clone());
        Ok(n)
    }
    pub fn delete(&self, id: &str) -> Result<(), ServiceError> {
        let _g = self.lock()?;
        self.notes.delete(id)?;
        let mut events = Vec::new();
        for mut t in self.tasks.list()?.records {
            if t.linked_note_ids
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|x| x == id))
            {
                t.linked_note_ids.as_mut().unwrap().retain(|x| x != id);
                if t.linked_note_ids.as_ref().is_some_and(Vec::is_empty) {
                    t.linked_note_ids = None;
                }
                t.updated_at = Some(now_ms());
                events.push(self.tasks.update(t.clone(), t.rev)?);
            }
        }
        drop(_g);
        self.sink.emit(ChangeEvent::NoteDeleted(id.into()));
        for t in events {
            self.sink.emit(ChangeEvent::TaskUpdated(t));
        }
        Ok(())
    }
    pub fn set_anchors(
        &self,
        id: &str,
        anchors: Vec<NoteAnchor>,
        rev: u64,
    ) -> Result<NoteItem, ServiceError> {
        let _g = self.lock()?;
        let mut n = self.notes.get(id)?;
        n.anchors = anchors;
        n.updated_at = Some(now_ms());
        let n = self.notes.update(n, rev)?;
        drop(_g);
        self.emit_note(n.clone());
        Ok(n)
    }
    pub fn set_anchor(
        &self,
        id: &str,
        anchor: Option<NoteAnchor>,
        rev: u64,
    ) -> Result<NoteItem, ServiceError> {
        self.set_anchors(id, anchor.into_iter().collect(), rev)
    }
    pub fn add_anchor(
        &self,
        id: &str,
        anchor: NoteAnchor,
        rev: u64,
    ) -> Result<NoteItem, ServiceError> {
        let mut n = self.get(id)?;
        n.anchors.push(anchor);
        self.set_anchors(id, n.anchors, rev)
    }
    pub fn remove_anchor(
        &self,
        id: &str,
        index: usize,
        rev: u64,
    ) -> Result<NoteItem, ServiceError> {
        let mut n = self.get(id)?;
        if index >= n.anchors.len() {
            return Err(ServiceError::validation("Anchor index out of range"));
        }
        n.anchors.remove(index);
        self.set_anchors(id, n.anchors, rev)
    }
    pub fn set_status(
        &self,
        id: &str,
        status: NoteStatus,
        rev: u64,
    ) -> Result<NoteItem, ServiceError> {
        let _g = self.lock()?;
        let mut n = self.notes.get(id)?;
        n.status = status;
        n.updated_at = Some(now_ms());
        let n = self.notes.update(n, rev)?;
        drop(_g);
        self.emit_note(n.clone());
        Ok(n)
    }
    pub fn toggle_status(&self, id: &str, rev: u64) -> Result<NoteItem, ServiceError> {
        let n = self.get(id)?;
        self.set_status(
            id,
            if n.status == NoteStatus::Open {
                NoteStatus::Completed
            } else {
                NoteStatus::Open
            },
            rev,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        service_error::{RecordingSink, ServiceErrorCode},
        task_service::TaskService,
    };
    use std::sync::Arc;
    use tempfile::tempdir;
    #[test]
    fn remove_anchor_out_of_range_keeps_revision() {
        let d = tempdir().unwrap();
        let s = NoteService::new(d.path(), Arc::new(Mutex::new(())), RecordingSink::default());
        let n = s.create(NoteItem::new("n")).unwrap();
        assert_eq!(
            s.remove_anchor(&n.id, 0, n.rev).unwrap_err().code,
            ServiceErrorCode::Validation
        );
        assert_eq!(s.get(&n.id).unwrap().rev, n.rev);
    }
    #[test]
    fn unlink_note_requires_matching_revision() {
        let d = tempdir().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        let notes = NoteService::new(d.path(), lock.clone(), sink.clone());
        let note = notes.create(NoteItem::new("n")).unwrap();
        let tasks = TaskService::new(d.path(), lock, sink);
        let mut t = TaskItem::new("t");
        t.linked_note_ids = Some(vec![note.id.clone()]);
        let t = tasks.create(t).unwrap();
        assert_eq!(
            tasks
                .unlink_note(&t.id, &note.id, t.rev + 1)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
    }
    #[test]
    fn deleting_note_unlinks_task_and_emits_each_changed_record_once() {
        let d = tempdir().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        let notes = NoteService::new(d.path(), lock.clone(), sink.clone());
        let tasks = TaskService::new(d.path(), lock, sink.clone());
        let note = notes.create(NoteItem::new("n")).unwrap();
        let mut t = TaskItem::new("t");
        t.linked_note_ids = Some(vec![note.id.clone()]);
        let t = tasks.create(t).unwrap();
        sink.take();
        notes.delete(&note.id).unwrap();
        let events = sink.events();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e,ChangeEvent::NoteDeleted(id)if id==&note.id))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e,ChangeEvent::TaskUpdated(x)if x.id==t.id))
                .count(),
            1
        );
        assert_eq!(tasks.get(&t.id).unwrap().linked_note_ids, None);
    }
}
