use serde::{Deserialize, Serialize};
use std::{fmt, sync::{Arc, Mutex}};

use super::storage::{StorageError, StorageErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ServiceErrorCode { NotFound, StaleRev, InvalidTransition, Forbidden, Validation, Io, Corrupt }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError { pub code: ServiceErrorCode, pub message: String }

impl ServiceError {
    pub fn new(code: ServiceErrorCode, message: impl Into<String>) -> Self { Self { code, message: message.into() } }
    pub fn validation(message: impl Into<String>) -> Self { Self::new(ServiceErrorCode::Validation, message) }
}
impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{:?}: {}", self.code, self.message) }
}
impl std::error::Error for ServiceError {}
impl From<StorageError> for ServiceError {
    fn from(value: StorageError) -> Self {
        let code = match value.code { StorageErrorCode::NotFound => ServiceErrorCode::NotFound, StorageErrorCode::StaleRev => ServiceErrorCode::StaleRev, StorageErrorCode::Validation => ServiceErrorCode::Validation, StorageErrorCode::Io => ServiceErrorCode::Io, StorageErrorCode::Corrupt => ServiceErrorCode::Corrupt };
        Self { code, message: value.message }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor { Ui, Script, System }

#[derive(Debug, Clone, PartialEq)]
pub enum ChangeEvent {
    TaskCreated(crate::types::task::TaskItem), TaskUpdated(crate::types::task::TaskItem), TaskDeleted(String),
    NoteCreated(crate::types::note::NoteItem), NoteUpdated(crate::types::note::NoteItem), NoteDeleted(String), ProjectReloaded,
}
pub trait EventSink: Send + Sync { fn emit(&self, event: ChangeEvent); }
#[derive(Default)]
pub struct NoopSink;
impl EventSink for NoopSink { fn emit(&self, _: ChangeEvent) {} }
#[derive(Default, Clone)]
pub struct RecordingSink { events: Arc<Mutex<Vec<ChangeEvent>>> }
impl RecordingSink {
    pub fn events(&self) -> Vec<ChangeEvent> { self.events.lock().expect("recording sink lock poisoned").clone() }
    pub fn take(&self) -> Vec<ChangeEvent> { std::mem::take(&mut *self.events.lock().expect("recording sink lock poisoned")) }
}
impl EventSink for RecordingSink { fn emit(&self, event: ChangeEvent) { self.events.lock().expect("recording sink lock poisoned").push(event); } }

pub fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
