use crate::{
    services::{
        runs::RunContext,
        service_error::{now_ms, Actor, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
        storage::{FileRepository, ListReport, Repository},
        task_service::{NewSubTask, NewTask, TaskService},
    },
    types::{
        proposal::{Presentation, Proposal, ProposalKind, ProposalPayload, ProposalStatus},
        task::{SubTask, TaskItem, TaskStatus},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
};

const MAX_TITLE_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 10_000;
const MAX_SUBTASKS: usize = 50;
const MAX_BATCH_TASKS: usize = 20;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_PROPOSALS_PER_RUN: usize = 20;

fn validate_key(key: &str) -> Result<(), ServiceError> {
    if key.is_empty()
        || key.len() > 32
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ServiceError::validation(
            "items.key must match [A-Za-z0-9_-]{1,32}",
        ));
    }
    Ok(())
}

fn validate_subtask(subtask: &NewSubTask) -> Result<(), ServiceError> {
    let title_chars = subtask.title.chars().count();
    if !(1..=MAX_TITLE_CHARS).contains(&title_chars) {
        return Err(ServiceError::validation(
            "items.title must contain 1 to 200 characters",
        ));
    }
    if subtask
        .description
        .as_ref()
        .is_some_and(|text| text.chars().count() > MAX_TEXT_CHARS)
    {
        return Err(ServiceError::validation(
            "items.description must contain at most 10000 characters",
        ));
    }
    Ok(())
}

fn deduplicate_task_updates(updates: Vec<TaskItem>) -> Vec<TaskItem> {
    let mut positions = HashMap::new();
    let mut deduplicated = Vec::new();
    for task in updates {
        if let Some(index) = positions.get(&task.id).copied() {
            deduplicated[index] = task;
        } else {
            positions.insert(task.id.clone(), deduplicated.len());
            deduplicated.push(task);
        }
    }
    deduplicated
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceAction {
    Keep,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptResult {
    pub proposal: Proposal,
    pub tasks: Vec<TaskItem>,
}

pub struct ProposalService {
    proposals: Box<dyn Repository<Proposal> + Send + Sync>,
    tasks: Arc<TaskService>,
    lock: Arc<Mutex<()>>,
    sink: Box<dyn EventSink>,
}

impl ProposalService {
    pub fn new(
        root: impl AsRef<Path>,
        tasks: Arc<TaskService>,
        lock: Arc<Mutex<()>>,
        sink: impl EventSink + 'static,
    ) -> Self {
        Self::with_repository(
            Box::new(FileRepository::for_proposals(root)),
            tasks,
            lock,
            sink,
        )
    }

    fn with_repository(
        proposals: Box<dyn Repository<Proposal> + Send + Sync>,
        tasks: Arc<TaskService>,
        lock: Arc<Mutex<()>>,
        sink: impl EventSink + 'static,
    ) -> Self {
        Self {
            proposals,
            tasks,
            lock,
            sink: Box::new(sink),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        services::{
            project::{ProjectServices, ProjectState},
            service_error::RecordingSink,
            storage::{StorageError, StorageErrorCode},
            task_service::{NewSubTask, NewTask},
        },
        types::{
            note::NoteItem,
            proposal::{BatchTaskItem, ProposalPayload, SubtasksPayload, TasksPayload},
            task::{TaskItem, TaskStatus},
        },
    };
    use std::sync::Arc;
    use tempfile::{tempdir, TempDir};

    struct FailingUpdateRepository {
        inner: FileRepository<Proposal>,
        fixed_id: String,
    }

    impl Repository<Proposal> for FailingUpdateRepository {
        fn list(&self) -> Result<ListReport<Proposal>, StorageError> {
            self.inner.list()
        }

        fn get(&self, id: &str) -> Result<Proposal, StorageError> {
            self.inner.get(id)
        }

        fn create(&self, mut proposal: Proposal) -> Result<Proposal, StorageError> {
            proposal.id = self.fixed_id.clone();
            self.inner.create(proposal)
        }

        fn update(
            &self,
            _proposal: Proposal,
            _expected_rev: u64,
        ) -> Result<Proposal, StorageError> {
            Err(StorageError {
                code: StorageErrorCode::Io,
                message: "injected proposal write failure".into(),
            })
        }

        fn delete(&self, id: &str) -> Result<(), StorageError> {
            self.inner.delete(id)
        }
    }

    fn setup() -> (TempDir, Arc<ProjectServices>, RecordingSink, RunContext) {
        let directory = tempdir().unwrap();
        let state = ProjectState::default();
        let sink = RecordingSink::default();
        state.open(directory.path(), sink.clone()).unwrap();
        (
            directory,
            state.services().unwrap(),
            sink,
            RunContext {
                run_id: "run-context-id".into(),
                task_id: "source-task-id".into(),
                workflow: "trusted-workflow".into(),
            },
        )
    }

    fn payload(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            description: None,
            anchor: None,
            linked_note_ids: None,
            sub_tasks: None,
            depends_on: None,
            acceptance_criteria: None,
            branch: None,
        }
    }

    fn batch_item(key: &str, title: &str) -> BatchTaskItem {
        BatchTaskItem {
            key: key.into(),
            title: title.into(),
            description: None,
            anchor: None,
            linked_note_ids: None,
            sub_tasks: None,
            depends_on: None,
            depends_on_key: None,
            acceptance_criteria: None,
            branch: None,
        }
    }

    fn create_batch(
        project: &ProjectServices,
        context: &RunContext,
        items: Vec<BatchTaskItem>,
        source_task_id: Option<String>,
    ) -> Proposal {
        project
            .proposals
            .create_proposal(
                Actor::Script,
                context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id,
                    items,
                }),
                Presentation::Notify,
            )
            .unwrap()
    }

    fn create(project: &ProjectServices, context: &RunContext, payload: NewTask) -> Proposal {
        project
            .proposals
            .create(Actor::Script, context, payload)
            .unwrap()
    }

    fn assert_validation(result: Result<Proposal, ServiceError>, field: &str) {
        let error = result.unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert!(error.message.contains(field), "{}", error.message);
    }

    #[test]
    fn create_uses_run_context_and_stores_pending_proposal_without_creating_task() {
        let (_directory, project, _, context) = setup();
        let proposal = create(&project, &context, payload("follow up"));
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.run_id, context.run_id);
        assert_eq!(proposal.task_id.as_deref(), Some(context.task_id.as_str()));
        assert_eq!(proposal.workflow, context.workflow);
        assert!(project.tasks.get(&proposal.id).is_err());
        assert!(std::path::Path::new(&project.root)
            .join(".cairn/runs/proposals")
            .join(format!("{}.json", proposal.id))
            .is_file());
    }

    #[test]
    fn create_rejects_all_limits_with_the_field_name() {
        let (_directory, project, _, context) = setup();

        assert_validation(
            project.proposals.create(
                Actor::Script,
                &context,
                payload(&"x".repeat(MAX_TITLE_CHARS + 1)),
            ),
            "title",
        );

        let mut too_many_subtasks = payload("title");
        too_many_subtasks.sub_tasks = Some(
            (0..=MAX_SUBTASKS)
                .map(|index| NewSubTask {
                    title: format!("subtask {index}"),
                    description: None,
                })
                .collect(),
        );
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, too_many_subtasks),
            "subTasks",
        );

        let mut long_subtask_title = payload("title");
        long_subtask_title.sub_tasks = Some(vec![NewSubTask {
            title: "x".repeat(MAX_TITLE_CHARS + 1),
            description: None,
        }]);
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, long_subtask_title),
            "subTasks.title",
        );

        let mut long_description = payload("title");
        long_description.description = Some("x".repeat(MAX_TEXT_CHARS + 1));
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, long_description),
            "description",
        );

        let mut long_criteria = payload("title");
        long_criteria.acceptance_criteria = Some("x".repeat(MAX_TEXT_CHARS + 1));
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, long_criteria),
            "acceptanceCriteria",
        );

        let mut oversized = payload("title");
        oversized.sub_tasks = Some(
            (0..7)
                .map(|index| NewSubTask {
                    title: format!("subtask {index}"),
                    description: Some("x".repeat(MAX_TEXT_CHARS)),
                })
                .collect(),
        );
        assert_validation(
            project.proposals.create(Actor::Script, &context, oversized),
            "payload",
        );
    }

    #[test]
    fn create_limits_proposals_to_twenty_per_run_across_statuses() {
        let (_directory, project, _, context) = setup();
        let first = create(&project, &context, payload("proposal 0"));
        project
            .proposals
            .reject(Actor::Ui, &first.id, first.rev)
            .unwrap();
        for index in 1..MAX_PROPOSALS_PER_RUN {
            create(&project, &context, payload(&format!("proposal {index}")));
        }
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, payload("proposal 20")),
            "runId",
        );
    }

    #[test]
    fn create_checks_dependency_and_linked_note_and_rejects_unknown_identity_fields() {
        let (_directory, project, _, context) = setup();
        let mut missing_dependency = payload("title");
        missing_dependency.depends_on = Some("missing-task".into());
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, missing_dependency),
            "dependsOn",
        );

        let mut missing_note = payload("title");
        missing_note.linked_note_ids = Some(vec!["missing-note".into()]);
        assert_validation(
            project
                .proposals
                .create(Actor::Script, &context, missing_note),
            "linkedNoteIds",
        );

        for field in ["id", "status", "runId"] {
            let mut value = serde_json::to_value(payload("title")).unwrap();
            value[field] = serde_json::json!("caller-controlled");
            assert!(serde_json::from_value::<NewTask>(value).is_err(), "{field}");
        }
    }

    #[test]
    fn batch_proposal_validates_limits_keys_and_every_record_reference() {
        let (_directory, project, _, context) = setup();
        let source = project.tasks.create(TaskItem::new("source")).unwrap();
        let note = project.notes.create(NoteItem::new("note")).unwrap();

        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: (0..=MAX_BATCH_TASKS)
                        .map(|index| batch_item(&format!("k{index}"), "task"))
                        .collect(),
                }),
                Presentation::Notify,
            ),
            "items",
        );
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![batch_item("invalid key", "task")],
                }),
                Presentation::Notify,
            ),
            "key",
        );
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![batch_item(&"k".repeat(33), "task")],
                }),
                Presentation::Notify,
            ),
            "key",
        );
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![batch_item("same", "one"), batch_item("same", "two")],
                }),
                Presentation::Notify,
            ),
            "key",
        );
        let mut later_reference = batch_item("first", "first");
        later_reference.depends_on_key = Some("later".into());
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![later_reference, batch_item("later", "later")],
                }),
                Presentation::Notify,
            ),
            "dependsOnKey",
        );
        let mut both_dependencies = batch_item("first", "first");
        both_dependencies.depends_on = Some(source.id.clone());
        both_dependencies.depends_on_key = Some("earlier".into());
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![batch_item("earlier", "earlier"), both_dependencies],
                }),
                Presentation::Notify,
            ),
            "dependsOn",
        );

        let mut missing_dependency = batch_item("dep", "task");
        missing_dependency.depends_on = Some("missing-task".into());
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![missing_dependency],
                }),
                Presentation::Notify,
            ),
            "dependsOn",
        );
        let mut missing_note = batch_item("note", "task");
        missing_note.linked_note_ids = Some(vec!["missing-note".into()]);
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![missing_note],
                }),
                Presentation::Notify,
            ),
            "linkedNoteIds",
        );
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: Some("missing-source".into()),
                    items: vec![batch_item("source", "task")],
                }),
                Presentation::Notify,
            ),
            "sourceTaskId",
        );
        let mut long_title = batch_item("long-title", "x");
        long_title.title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![long_title],
                }),
                Presentation::Notify,
            ),
            "title",
        );

        let mut valid_reference = batch_item("valid", "task");
        valid_reference.depends_on = Some(source.id);
        valid_reference.linked_note_ids = Some(vec![note.id]);
        create_batch(&project, &context, vec![valid_reference], None);

        let oversized: Vec<_> = (0..MAX_BATCH_TASKS)
            .map(|index| {
                let mut item = batch_item(&format!("large{index}"), "task");
                item.description = Some("x".repeat(4_000));
                item
            })
            .collect();
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Tasks,
                ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: oversized,
                }),
                Presentation::Notify,
            ),
            "payload",
        );

        let subtask_items = (0..=MAX_SUBTASKS)
            .map(|index| NewSubTask {
                title: format!("subtask {index}"),
                description: None,
            })
            .collect();
        let parent = project.tasks.create(TaskItem::new("parent")).unwrap();
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Subtasks,
                ProposalPayload::Subtasks(SubtasksPayload {
                    task_id: parent.id,
                    items: subtask_items,
                }),
                Presentation::Notify,
            ),
            "items",
        );
        assert_validation(
            project.proposals.create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Subtasks,
                ProposalPayload::Subtasks(SubtasksPayload {
                    task_id: "missing-parent".into(),
                    items: vec![],
                }),
                Presentation::Notify,
            ),
            "taskId",
        );
    }

    #[test]
    fn batch_accept_creates_ordered_dependency_chain_and_recovers_precreated_items() {
        let (_directory, project, _, context) = setup();
        let first = batch_item("first", "first");
        let mut second = batch_item("second", "second");
        let mut third = batch_item("third", "third");
        second.depends_on_key = Some("first".into());
        third.depends_on_key = Some("second".into());
        let proposal = create_batch(
            &project,
            &context,
            vec![first.clone(), second.clone(), third.clone()],
            None,
        );
        let accepted = project
            .proposals
            .accept_with_options(Actor::Ui, &proposal.id, proposal.rev, None, None)
            .unwrap();
        assert_eq!(accepted.tasks.len(), 3);
        assert_eq!(accepted.tasks[0].id, format!("{}-1", proposal.id));
        assert_eq!(accepted.tasks[0].status, TaskStatus::Ready);
        assert_eq!(
            accepted.tasks[1].depends_on,
            Some(accepted.tasks[0].id.clone())
        );
        assert_eq!(accepted.tasks[1].status, TaskStatus::Blocked);
        assert_eq!(
            accepted.tasks[2].depends_on,
            Some(accepted.tasks[1].id.clone())
        );
        assert_eq!(accepted.tasks[2].status, TaskStatus::Blocked);
        assert_eq!(
            accepted.proposal.created_task_ids,
            Some(accepted.tasks.iter().map(|task| task.id.clone()).collect())
        );

        let recovery = create_batch(
            &project,
            &context,
            vec![first.clone(), second.clone(), third.clone()],
            None,
        );
        let mut precreated = TaskItem::new("already written");
        precreated.id = format!("{}-1", recovery.id);
        project.tasks.create(precreated).unwrap();
        let result = project
            .proposals
            .accept_with_options(Actor::Ui, &recovery.id, recovery.rev, None, None)
            .unwrap();
        assert_eq!(result.tasks.len(), 3);
        assert_eq!(project.tasks.list().unwrap().records.len(), 6);
    }

    #[test]
    fn edited_batch_may_remove_items_but_not_referenced_dependencies() {
        let (_directory, project, _, context) = setup();
        let first = batch_item("first", "first");
        let mut second = batch_item("second", "second");
        second.depends_on_key = Some("first".into());
        let proposal = create_batch(&project, &context, vec![first.clone(), second], None);
        let mut orphaned_dependency = batch_item("second", "second");
        orphaned_dependency.depends_on_key = Some("first".into());
        let invalid = project.proposals.accept_with_options(
            Actor::Ui,
            &proposal.id,
            proposal.rev,
            Some(ProposalPayload::Tasks(TasksPayload {
                source_task_id: None,
                items: vec![orphaned_dependency],
            })),
            None,
        );
        assert_eq!(invalid.unwrap_err().code, ServiceErrorCode::Validation);
        assert_eq!(
            project.proposals.list().unwrap().records[0].status,
            ProposalStatus::Pending
        );
        let accepted = project
            .proposals
            .accept_with_options(
                Actor::Ui,
                &proposal.id,
                proposal.rev,
                Some(ProposalPayload::Tasks(TasksPayload {
                    source_task_id: None,
                    items: vec![first.clone()],
                })),
                None,
            )
            .unwrap();
        assert_eq!(accepted.tasks.len(), 1);
        assert_eq!(accepted.tasks[0].title, "first");
    }

    #[test]
    fn batch_source_action_keeps_deletes_and_rejects_running_or_missing_source() {
        let (_directory, project, _, context) = setup();
        let source = project.tasks.create(TaskItem::new("source")).unwrap();
        let keep = create_batch(
            &project,
            &context,
            vec![batch_item("keep", "keep")],
            Some(source.id.clone()),
        );
        project
            .proposals
            .accept_with_options(
                Actor::Ui,
                &keep.id,
                keep.rev,
                None,
                Some(SourceAction::Keep),
            )
            .unwrap();
        assert!(project.tasks.get(&source.id).is_ok());

        let removed_source = project.tasks.create(TaskItem::new("removed")).unwrap();
        let missing_source = create_batch(
            &project,
            &context,
            vec![batch_item("missing-source", "replacement")],
            Some(removed_source.id.clone()),
        );
        project.tasks.delete(&removed_source.id).unwrap();
        let missing_source_error = project
            .proposals
            .accept_with_options(
                Actor::Ui,
                &missing_source.id,
                missing_source.rev,
                None,
                None,
            )
            .unwrap_err();
        assert_eq!(missing_source_error.code, ServiceErrorCode::Validation);
        assert!(project
            .tasks
            .get(&format!("{}-1", missing_source.id))
            .is_err());
        assert_eq!(
            project
                .proposals
                .list()
                .unwrap()
                .records
                .iter()
                .find(|proposal| proposal.id == missing_source.id)
                .unwrap()
                .status,
            ProposalStatus::Pending
        );

        let delete_source = project.tasks.create(TaskItem::new("delete")).unwrap();
        let delete = create_batch(
            &project,
            &context,
            vec![batch_item("delete", "replacement")],
            Some(delete_source.id.clone()),
        );
        project
            .proposals
            .accept_with_options(
                Actor::Ui,
                &delete.id,
                delete.rev,
                None,
                Some(SourceAction::Delete),
            )
            .unwrap();
        assert_eq!(
            project.tasks.get(&delete_source.id).unwrap_err().code,
            ServiceErrorCode::NotFound
        );

        let running = project.tasks.create(TaskItem::new("running")).unwrap();
        let running = project
            .tasks
            .set_status(&running.id, TaskStatus::Running, running.rev, Actor::Ui)
            .unwrap();
        let blocked_delete = create_batch(
            &project,
            &context,
            vec![batch_item("running", "replacement")],
            Some(running.id.clone()),
        );
        let error = project
            .proposals
            .accept_with_options(
                Actor::Ui,
                &blocked_delete.id,
                blocked_delete.rev,
                None,
                Some(SourceAction::Delete),
            )
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::InvalidTransition);
        assert_eq!(
            project
                .proposals
                .list()
                .unwrap()
                .records
                .iter()
                .find(|proposal| proposal.id == blocked_delete.id)
                .unwrap()
                .status,
            ProposalStatus::Pending
        );

        let no_source = create_batch(
            &project,
            &context,
            vec![batch_item("no-source", "task")],
            None,
        );
        assert_eq!(
            project
                .proposals
                .accept_with_options(
                    Actor::Ui,
                    &no_source.id,
                    no_source.rev,
                    None,
                    Some(SourceAction::Keep),
                )
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn subtasks_accept_once_updates_parent_once_and_missing_target_stays_pending() {
        let (_directory, project, sink, context) = setup();
        let parent = project.tasks.create(TaskItem::new("parent")).unwrap();
        let proposal = project
            .proposals
            .create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Subtasks,
                ProposalPayload::Subtasks(SubtasksPayload {
                    task_id: parent.id.clone(),
                    items: vec![
                        NewSubTask {
                            title: "one".into(),
                            description: None,
                        },
                        NewSubTask {
                            title: "two".into(),
                            description: Some("detail".into()),
                        },
                    ],
                }),
                Presentation::Display,
            )
            .unwrap();
        sink.take();
        let accepted = project
            .proposals
            .accept_with_options(Actor::Ui, &proposal.id, proposal.rev, None, None)
            .unwrap();
        assert_eq!(accepted.tasks[0].sub_tasks.as_ref().unwrap().len(), 2);
        let events = sink.take();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ChangeEvent::TaskUpdated(_)))
                .count(),
            1
        );
        assert!(matches!(
            events.last(),
            Some(ChangeEvent::ProposalUpdated(_))
        ));
        let repeated = project
            .proposals
            .accept_with_options(Actor::Ui, &proposal.id, proposal.rev, None, None)
            .unwrap();
        assert_eq!(repeated.tasks[0].sub_tasks.as_ref().unwrap().len(), 2);
        assert!(sink.events().is_empty());

        let target = project.tasks.create(TaskItem::new("target")).unwrap();
        let pending = project
            .proposals
            .create_proposal(
                Actor::Script,
                &context,
                ProposalKind::Subtasks,
                ProposalPayload::Subtasks(SubtasksPayload {
                    task_id: target.id.clone(),
                    items: vec![NewSubTask {
                        title: "orphan".into(),
                        description: None,
                    }],
                }),
                Presentation::Notify,
            )
            .unwrap();
        project.tasks.delete(&target.id).unwrap();
        let error = project
            .proposals
            .accept_with_options(Actor::Ui, &pending.id, pending.rev, None, None)
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert_eq!(
            project
                .proposals
                .list()
                .unwrap()
                .records
                .iter()
                .find(|proposal| proposal.id == pending.id)
                .unwrap()
                .status,
            ProposalStatus::Pending
        );
    }

    #[test]
    fn mark_seen_is_idempotent_ignores_unknown_ids_and_caps_request_size() {
        let (_directory, project, sink, context) = setup();
        let first = create(&project, &context, payload("first"));
        let second = create(&project, &context, payload("second"));
        sink.take();
        let changed = project
            .proposals
            .mark_seen(
                Actor::Ui,
                &[
                    first.id.clone(),
                    "unknown".into(),
                    "../invalid".into(),
                    second.id.clone(),
                    first.id.clone(),
                ],
            )
            .unwrap();
        assert_eq!(changed.len(), 2);
        assert!(changed.iter().all(|proposal| proposal.seen_at.is_some()));
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(event, ChangeEvent::ProposalUpdated(_)))
                .count(),
            2
        );
        sink.take();
        assert!(project
            .proposals
            .mark_seen(Actor::Ui, &[first.id.clone(), second.id.clone()])
            .unwrap()
            .is_empty());
        assert!(sink.events().is_empty());
        assert_eq!(
            project
                .proposals
                .mark_seen(Actor::Ui, &vec!["x".into(); 101])
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn accept_creates_blocked_task_and_is_idempotent() {
        let (_directory, project, _, context) = setup();
        let blocker = project.tasks.create(TaskItem::new("blocker")).unwrap();
        let mut proposed = payload("follow up");
        proposed.depends_on = Some(blocker.id.clone());
        let proposal = create(&project, &context, proposed);
        let (accepted, task) = project
            .proposals
            .accept(Actor::Ui, &proposal.id, proposal.rev, None)
            .unwrap();
        assert_eq!(task.id, proposal.id);
        assert_eq!(task.status, TaskStatus::Blocked);
        assert_eq!(accepted.status, ProposalStatus::Accepted);
        assert_eq!(accepted.created_task_id.as_deref(), Some(task.id.as_str()));

        let (again, same_task) = project
            .proposals
            .accept(Actor::Ui, &proposal.id, proposal.rev, None)
            .unwrap();
        assert_eq!(again, accepted);
        assert_eq!(same_task.id, task.id);
        assert_eq!(project.tasks.list().unwrap().records.len(), 2);
    }

    #[test]
    fn accept_uses_edits_and_recovers_a_task_created_before_proposal_update() {
        let (_directory, project, _, context) = setup();
        let proposal = create(&project, &context, payload("original"));
        let (accepted, task) = project
            .proposals
            .accept(
                Actor::Ui,
                &proposal.id,
                proposal.rev,
                Some(payload("edited")),
            )
            .unwrap();
        assert_eq!(task.title, "edited");
        assert_eq!(accepted.status, ProposalStatus::Accepted);

        let recovery_proposal = create(&project, &context, payload("recovered"));
        let mut precreated = TaskItem::new("task created before crash");
        precreated.id = recovery_proposal.id.clone();
        project.tasks.create(precreated).unwrap();
        let (recovered, recovered_task) = project
            .proposals
            .accept(
                Actor::Ui,
                &recovery_proposal.id,
                recovery_proposal.rev,
                None,
            )
            .unwrap();
        assert_eq!(recovered.status, ProposalStatus::Accepted);
        assert_eq!(recovered_task.title, "task created before crash");
    }

    #[test]
    fn accept_reports_when_the_task_created_from_an_accepted_proposal_was_deleted() {
        let (_directory, project, _, context) = setup();
        let proposal = create(&project, &context, payload("follow up"));
        let (accepted, task) = project
            .proposals
            .accept(Actor::Ui, &proposal.id, proposal.rev, None)
            .unwrap();
        project.tasks.delete(&task.id).unwrap();

        let error = project
            .proposals
            .accept(Actor::Ui, &proposal.id, accepted.rev, None)
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::InvalidTransition);
        assert_eq!(
            error.message,
            "the task created from this proposal was deleted"
        );
    }

    #[test]
    fn accept_emits_task_and_reconcile_events_when_proposal_write_fails() {
        let directory = tempdir().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let sink = RecordingSink::default();
        let tasks = Arc::new(TaskService::new(
            directory.path(),
            lock.clone(),
            sink.clone(),
        ));
        let proposal_id = "fixed-proposal-id".to_owned();
        let mut dependent = TaskItem::new("dependent");
        dependent.depends_on = Some(proposal_id.clone());
        let dependent = FileRepository::for_tasks(directory.path())
            .create(dependent)
            .unwrap();
        let proposals = ProposalService::with_repository(
            Box::new(FailingUpdateRepository {
                inner: FileRepository::for_proposals(directory.path()),
                fixed_id: proposal_id.clone(),
            }),
            tasks,
            lock,
            sink.clone(),
        );
        let context = RunContext {
            run_id: "run-context-id".into(),
            task_id: "source-task-id".into(),
            workflow: "trusted-workflow".into(),
        };
        let proposal = proposals
            .create(Actor::Script, &context, payload("follow up"))
            .unwrap();
        sink.take();

        let error = proposals
            .accept(Actor::Ui, &proposal.id, proposal.rev, None)
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Io);
        assert_eq!(error.message, "injected proposal write failure");
        let events = sink.events();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ChangeEvent::TaskCreated(task) if task.id == proposal_id
        ));
        assert!(matches!(
            &events[1],
            ChangeEvent::TaskUpdated(task)
                if task.id == dependent.id && task.status == TaskStatus::Blocked
        ));
    }

    #[test]
    fn accept_revalidates_deleted_dependency_and_preserves_pending_status() {
        let (_directory, project, _, context) = setup();
        let blocker = project.tasks.create(TaskItem::new("blocker")).unwrap();
        let mut proposed = payload("follow up");
        proposed.depends_on = Some(blocker.id.clone());
        let proposal = create(&project, &context, proposed);
        project.tasks.delete(&blocker.id).unwrap();
        let error = project
            .proposals
            .accept(Actor::Ui, &proposal.id, proposal.rev, None)
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert!(error.message.contains("dependsOn"));
        assert_eq!(
            project.proposals.list().unwrap().records[0].status,
            ProposalStatus::Pending
        );
    }

    #[test]
    fn actors_revisions_rejection_and_pending_delete_rules_are_enforced() {
        let (_directory, project, _, context) = setup();
        let proposal = create(&project, &context, payload("proposal"));
        assert_eq!(
            project
                .proposals
                .accept(Actor::Script, &proposal.id, proposal.rev, None)
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
        assert_eq!(
            project
                .proposals
                .accept(Actor::Ui, &proposal.id, proposal.rev + 1, None)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
        assert_eq!(
            project
                .proposals
                .delete(Actor::Ui, &proposal.id)
                .unwrap_err()
                .code,
            ServiceErrorCode::InvalidTransition
        );
        let rejected = project
            .proposals
            .reject(Actor::Ui, &proposal.id, proposal.rev)
            .unwrap();
        assert_eq!(rejected.status, ProposalStatus::Rejected);
        assert_eq!(
            project
                .proposals
                .accept(Actor::Ui, &proposal.id, rejected.rev, None)
                .unwrap_err()
                .code,
            ServiceErrorCode::InvalidTransition
        );
        project.proposals.delete(Actor::Ui, &proposal.id).unwrap();
    }

    #[test]
    fn proposal_create_requires_script_actor() {
        let (_directory, project, _, context) = setup();
        assert_eq!(
            project
                .proposals
                .create(Actor::Ui, &context, payload("proposal"))
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
    }
}

impl ProposalService {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ServiceError> {
        self.lock
            .lock()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))
    }

    fn check_actor(actor: Actor, expected: Actor) -> Result<(), ServiceError> {
        if actor == expected {
            Ok(())
        } else {
            Err(ServiceError::new(
                ServiceErrorCode::Forbidden,
                "Actor cannot perform this proposal operation",
            ))
        }
    }

    fn validate_task_text(payload: &NewTask) -> Result<(), ServiceError> {
        let title_chars = payload.title.chars().count();
        if !(1..=MAX_TITLE_CHARS).contains(&title_chars) {
            return Err(ServiceError::validation(
                "title must contain 1 to 200 characters",
            ));
        }
        for (field, value) in [
            ("description", payload.description.as_deref()),
            ("acceptanceCriteria", payload.acceptance_criteria.as_deref()),
        ] {
            if value.is_some_and(|text| text.chars().count() > MAX_TEXT_CHARS) {
                return Err(ServiceError::validation(format!(
                    "{field} must contain at most 10000 characters"
                )));
            }
        }
        if let Some(subtasks) = payload.sub_tasks.as_ref() {
            if subtasks.len() > MAX_SUBTASKS {
                return Err(ServiceError::validation(
                    "subTasks must contain at most 50 items",
                ));
            }
            for subtask in subtasks {
                let title_chars = subtask.title.chars().count();
                if !(1..=MAX_TITLE_CHARS).contains(&title_chars) {
                    return Err(ServiceError::validation(
                        "subTasks.title must contain 1 to 200 characters",
                    ));
                }
                if subtask
                    .description
                    .as_ref()
                    .is_some_and(|text| text.chars().count() > MAX_TEXT_CHARS)
                {
                    return Err(ServiceError::validation(
                        "subTasks.description must contain at most 10000 characters",
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_payload(&self, id: &str, payload: &ProposalPayload) -> Result<(), ServiceError> {
        let payload_bytes = serde_json::to_vec(payload)
            .map_err(|error| ServiceError::validation(format!("payload: {error}")))?;
        if payload_bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(ServiceError::validation(
                "payload must be at most 65536 bytes",
            ));
        }
        match payload {
            ProposalPayload::Task(task) => {
                Self::validate_task_text(task)?;
                self.tasks.validate_input_with_id_locked(id, task)
            }
            ProposalPayload::Tasks(batch) => {
                if batch.items.len() > MAX_BATCH_TASKS {
                    return Err(ServiceError::validation(
                        "items must contain at most 20 tasks",
                    ));
                }
                if let Some(source_id) = batch.source_task_id.as_deref() {
                    self.tasks.get(source_id).map_err(|error| {
                        if error.code == ServiceErrorCode::NotFound {
                            ServiceError::validation(format!(
                                "sourceTaskId: task {source_id} not found"
                            ))
                        } else {
                            error
                        }
                    })?;
                }
                let mut keys = HashSet::new();
                for (index, item) in batch.items.iter().enumerate() {
                    if format!("{id}-{}", index + 1).len() > 64 {
                        return Err(ServiceError::validation(
                            "proposal id makes generated task id longer than 64 characters",
                        ));
                    }
                    validate_key(&item.key)?;
                    if !keys.insert(item.key.as_str()) {
                        return Err(ServiceError::validation(format!(
                            "items[{index}].key must be unique"
                        )));
                    }
                    if let Some(depends_on_key) = item.depends_on_key.as_deref() {
                        if item.depends_on.is_some() {
                            return Err(ServiceError::validation(format!(
                                "items[{index}] cannot set both dependsOn and dependsOnKey"
                            )));
                        }
                        if !batch.items[..index]
                            .iter()
                            .any(|earlier| earlier.key == depends_on_key)
                        {
                            return Err(ServiceError::validation(format!(
                                "items[{index}].dependsOnKey must name an earlier item"
                            )));
                        }
                    }
                    let input = item.as_new_task(item.depends_on.clone());
                    Self::validate_task_text(&input)?;
                    if item.depends_on_key.is_some() {
                        let without_key_dependency = item.as_new_task(None);
                        self.tasks
                            .validate_input_with_id_locked(id, &without_key_dependency)?;
                    } else {
                        self.tasks.validate_input_with_id_locked(id, &input)?;
                    }
                }
                Ok(())
            }
            ProposalPayload::Subtasks(subtasks) => {
                self.tasks.get(&subtasks.task_id).map_err(|error| {
                    if error.code == ServiceErrorCode::NotFound {
                        ServiceError::validation(format!(
                            "taskId: task {} not found",
                            subtasks.task_id
                        ))
                    } else {
                        error
                    }
                })?;
                if subtasks.items.len() > MAX_SUBTASKS {
                    return Err(ServiceError::validation(
                        "items must contain at most 50 subtasks",
                    ));
                }
                if subtasks
                    .items
                    .iter()
                    .enumerate()
                    .any(|(index, _)| format!("{id}-{}", index + 1).len() > 64)
                {
                    return Err(ServiceError::validation(
                        "proposal id makes generated subtask id longer than 64 characters",
                    ));
                }
                for subtask in &subtasks.items {
                    validate_subtask(subtask)?;
                }
                Ok(())
            }
        }
    }

    #[cfg(test)]
    pub fn create(
        &self,
        actor: Actor,
        run: &RunContext,
        payload: NewTask,
    ) -> Result<Proposal, ServiceError> {
        self.create_proposal(
            actor,
            run,
            ProposalKind::Task,
            ProposalPayload::Task(payload),
            Presentation::Notify,
        )
    }

    pub fn create_proposal(
        &self,
        actor: Actor,
        run: &RunContext,
        kind: ProposalKind,
        payload: ProposalPayload,
        presentation: Presentation,
    ) -> Result<Proposal, ServiceError> {
        Self::check_actor(actor, Actor::Script)?;
        if !payload.matches_kind(kind) {
            return Err(ServiceError::validation("kind and payload do not agree"));
        }
        let guard = self.lock()?;
        let id = uuid::Uuid::new_v4().to_string();
        self.validate_payload(&id, &payload)?;
        let report = self.proposals.list()?;
        if report
            .records
            .iter()
            .filter(|proposal| proposal.run_id == run.run_id)
            .count()
            >= MAX_PROPOSALS_PER_RUN
        {
            return Err(ServiceError::validation(
                "runId may have at most 20 proposals",
            ));
        }
        let proposal = self.proposals.create(Proposal {
            id,
            kind,
            status: ProposalStatus::Pending,
            run_id: run.run_id.clone(),
            task_id: Some(run.task_id.clone()),
            workflow: run.workflow.clone(),
            payload,
            presentation,
            seen_at: None,
            created_task_id: None,
            created_task_ids: None,
            created_at: now_ms(),
            decided_at: None,
            schema_version: 1,
            rev: 0,
        })?;
        drop(guard);
        self.sink
            .emit(ChangeEvent::ProposalCreated(proposal.clone()));
        Ok(proposal)
    }

    pub fn list(&self) -> Result<ListReport<Proposal>, ServiceError> {
        Ok(self.proposals.list()?)
    }

    #[cfg(test)]
    pub fn accept(
        &self,
        actor: Actor,
        id: &str,
        expected_rev: u64,
        edited: Option<NewTask>,
    ) -> Result<(Proposal, TaskItem), ServiceError> {
        let payload = edited.map(ProposalPayload::Task);
        let accepted = self.accept_with_options(actor, id, expected_rev, payload, None)?;
        let task = accepted.tasks.into_iter().next().ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Accepted proposal did not create a task",
            )
        })?;
        Ok((accepted.proposal, task))
    }

    pub fn accept_with_options(
        &self,
        actor: Actor,
        id: &str,
        expected_rev: u64,
        edited: Option<ProposalPayload>,
        source_action: Option<SourceAction>,
    ) -> Result<AcceptResult, ServiceError> {
        Self::check_actor(actor, Actor::Ui)?;
        let guard = self.lock()?;
        let mut proposal = self.proposals.get(id)?;
        if proposal.status == ProposalStatus::Accepted {
            let tasks = self.tasks_for_accepted(&proposal)?;
            return Ok(AcceptResult { proposal, tasks });
        }
        if proposal.status == ProposalStatus::Rejected {
            return Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Rejected proposals cannot be accepted",
            ));
        }
        if proposal.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        let payload = edited.unwrap_or_else(|| proposal.payload.clone());
        if !payload.matches_kind(proposal.kind) {
            return Err(ServiceError::validation("kind and payload do not agree"));
        }
        let (effective_payload, source_to_delete) =
            self.validate_accept_payload(&proposal, payload, source_action)?;
        let mut created = Vec::new();
        let mut task_updates = Vec::new();
        let mut result_tasks = Vec::new();
        match &effective_payload {
            ProposalPayload::Task(task_payload) => {
                let existed = self.tasks.get(id).is_ok();
                let (task, reconciled) = self
                    .tasks
                    .create_input_with_id_locked(id.to_owned(), task_payload.clone())?;
                if !existed {
                    created.push(task.clone());
                }
                task_updates.extend(reconciled);
                proposal.created_task_id = Some(task.id.clone());
                result_tasks.push(task);
            }
            ProposalPayload::Tasks(batch) => {
                let mut ids_by_key: HashMap<String, String> = HashMap::new();
                let mut accepted_ids = Vec::with_capacity(batch.items.len());
                for (index, item) in batch.items.iter().enumerate() {
                    let task_id = format!("{}-{}", proposal.id, index + 1);
                    if task_id.len() > 64 {
                        return Err(ServiceError::validation(
                            "proposal id makes generated task id longer than 64 characters",
                        ));
                    }
                    let dependency = item
                        .depends_on_key
                        .as_ref()
                        .map(|key| ids_by_key[key].clone())
                        .or_else(|| item.depends_on.clone());
                    let input = item.as_new_task(dependency);
                    let existed = self.tasks.get(&task_id).is_ok();
                    let (task, reconciled) = self
                        .tasks
                        .create_input_with_id_locked(task_id.clone(), input)?;
                    if !existed {
                        created.push(task.clone());
                    }
                    task_updates.extend(reconciled);
                    ids_by_key.insert(item.key.clone(), task_id.clone());
                    accepted_ids.push(task_id);
                    result_tasks.push(task);
                }
                proposal.created_task_ids = Some(accepted_ids);
            }
            ProposalPayload::Subtasks(subtasks) => {
                let task_id = format!("{}-1", proposal.id);
                if task_id.len() > 64 {
                    return Err(ServiceError::validation(
                        "proposal id makes generated subtask id longer than 64 characters",
                    ));
                }
                let items = subtasks
                    .items
                    .iter()
                    .enumerate()
                    .map(|(index, input)| {
                        let mut subtask = SubTask::new(input.title.clone());
                        subtask.id = format!("{}-{}", proposal.id, index + 1);
                        subtask.description = input.description.clone();
                        subtask
                    })
                    .collect();
                if let Some(updated) = self.tasks.add_subtasks_locked(&subtasks.task_id, items)? {
                    task_updates.push(updated.clone());
                    result_tasks.push(updated);
                } else {
                    result_tasks.push(self.tasks.get(&subtasks.task_id)?);
                }
            }
        }
        let deleted_source_updates = if let Some(source_id) = source_to_delete.as_deref() {
            self.tasks.delete_locked(source_id)?
        } else {
            Vec::new()
        };
        task_updates.extend(deleted_source_updates);
        proposal.status = ProposalStatus::Accepted;
        proposal.decided_at = Some(now_ms());
        let update_result = self.proposals.update(proposal, expected_rev);
        drop(guard);

        for task in created {
            self.sink.emit(ChangeEvent::TaskCreated(task));
        }
        for changed in deduplicate_task_updates(task_updates) {
            self.sink.emit(ChangeEvent::TaskUpdated(changed));
        }
        if let Some(source_id) = source_to_delete {
            self.sink.emit(ChangeEvent::TaskDeleted(source_id));
        }
        let proposal = update_result?;
        self.sink
            .emit(ChangeEvent::ProposalUpdated(proposal.clone()));
        Ok(AcceptResult {
            proposal,
            tasks: result_tasks,
        })
    }

    fn validate_accept_payload(
        &self,
        proposal: &Proposal,
        payload: ProposalPayload,
        source_action: Option<SourceAction>,
    ) -> Result<(ProposalPayload, Option<String>), ServiceError> {
        let ProposalPayload::Tasks(batch) = &payload else {
            if source_action.is_some() {
                return Err(ServiceError::validation(
                    "sourceAction requires sourceTaskId",
                ));
            }
            self.validate_payload(&proposal.id, &payload)?;
            return Ok((payload, None));
        };
        let Some(source_id) = batch.source_task_id.as_deref() else {
            if source_action.is_some() {
                return Err(ServiceError::validation(
                    "sourceAction requires sourceTaskId",
                ));
            }
            self.validate_payload(&proposal.id, &payload)?;
            return Ok((payload, None));
        };
        let source_id = source_id.to_owned();
        let action = source_action.unwrap_or(SourceAction::Keep);
        let ids = (1..=batch.items.len())
            .map(|index| format!("{}-{index}", proposal.id))
            .collect::<Vec<_>>();
        let source_missing_after_create = action == SourceAction::Delete
            && self.tasks.get(&source_id).is_err()
            && !ids.is_empty()
            && ids.iter().all(|task_id| self.tasks.get(task_id).is_ok());
        let mut validation_payload = payload.clone();
        if source_missing_after_create {
            if let ProposalPayload::Tasks(validation_batch) = &mut validation_payload {
                validation_batch.source_task_id = None;
            }
        }
        self.validate_payload(&proposal.id, &validation_payload)?;
        let source = match self.tasks.get(&source_id) {
            Ok(task) => Some(task),
            Err(_error) if source_missing_after_create => None,
            Err(error) if error.code == ServiceErrorCode::NotFound => {
                return Err(ServiceError::validation(format!(
                    "sourceTaskId: task {source_id} not found"
                )))
            }
            Err(error) => return Err(error),
        };
        if action == SourceAction::Delete {
            if source
                .as_ref()
                .is_some_and(|task| task.status == TaskStatus::Running)
            {
                return Err(ServiceError::new(
                    ServiceErrorCode::InvalidTransition,
                    "A running source task cannot be deleted",
                ));
            }
            Ok((payload, source.map(|_| source_id)))
        } else {
            Ok((payload, None))
        }
    }

    fn tasks_for_accepted(&self, proposal: &Proposal) -> Result<Vec<TaskItem>, ServiceError> {
        match proposal.kind {
            ProposalKind::Task => {
                let id = proposal.created_task_id.as_deref().ok_or_else(|| {
                    ServiceError::new(
                        ServiceErrorCode::InvalidTransition,
                        "Accepted proposal has no created task id",
                    )
                })?;
                self.tasks.get(id).map(|task| vec![task]).map_err(|error| {
                    if error.code == ServiceErrorCode::NotFound {
                        ServiceError::new(
                            ServiceErrorCode::InvalidTransition,
                            "the task created from this proposal was deleted",
                        )
                    } else {
                        error
                    }
                })
            }
            ProposalKind::Tasks => proposal
                .created_task_ids
                .as_ref()
                .ok_or_else(|| {
                    ServiceError::new(
                        ServiceErrorCode::InvalidTransition,
                        "Accepted proposal has no created task ids",
                    )
                })?
                .iter()
                .map(|id| self.tasks.get(id))
                .collect(),
            ProposalKind::Subtasks => {
                let ProposalPayload::Subtasks(payload) = &proposal.payload else {
                    return Err(ServiceError::validation("kind and payload do not agree"));
                };
                self.tasks.get(&payload.task_id).map(|task| vec![task])
            }
        }
    }

    pub fn mark_seen(&self, actor: Actor, ids: &[String]) -> Result<Vec<Proposal>, ServiceError> {
        Self::check_actor(actor, Actor::Ui)?;
        if ids.len() > 100 {
            return Err(ServiceError::validation(
                "ids must contain at most 100 proposals",
            ));
        }
        let guard = self.lock()?;
        let mut changed = Vec::new();
        let mut seen_ids = HashSet::new();
        let mut failure = None;
        for id in ids {
            if !seen_ids.insert(id) {
                continue;
            }
            match self.proposals.get(id) {
                Ok(mut proposal) if proposal.seen_at.is_none() => {
                    proposal.seen_at = Some(now_ms());
                    match self.proposals.update(proposal.clone(), proposal.rev) {
                        Ok(updated) => changed.push(updated),
                        Err(error) => {
                            failure = Some(ServiceError::from(error));
                            break;
                        }
                    }
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.code,
                        crate::services::storage::StorageErrorCode::NotFound
                            | crate::services::storage::StorageErrorCode::Validation
                    ) => {}
                Err(error) => {
                    failure = Some(error.into());
                    break;
                }
            }
        }
        drop(guard);
        for proposal in &changed {
            self.sink
                .emit(ChangeEvent::ProposalUpdated(proposal.clone()));
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(changed),
        }
    }

    pub fn reject(
        &self,
        actor: Actor,
        id: &str,
        expected_rev: u64,
    ) -> Result<Proposal, ServiceError> {
        Self::check_actor(actor, Actor::Ui)?;
        let guard = self.lock()?;
        let mut proposal = self.proposals.get(id)?;
        if proposal.rev != expected_rev {
            return Err(ServiceError::new(
                ServiceErrorCode::StaleRev,
                "Stale revision",
            ));
        }
        if proposal.status != ProposalStatus::Pending {
            return Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Only pending proposals can be rejected",
            ));
        }
        proposal.status = ProposalStatus::Rejected;
        proposal.decided_at = Some(now_ms());
        let proposal = self.proposals.update(proposal, expected_rev)?;
        drop(guard);
        self.sink
            .emit(ChangeEvent::ProposalUpdated(proposal.clone()));
        Ok(proposal)
    }

    pub fn delete(&self, actor: Actor, id: &str) -> Result<(), ServiceError> {
        Self::check_actor(actor, Actor::Ui)?;
        let guard = self.lock()?;
        let proposal = self.proposals.get(id)?;
        if proposal.status == ProposalStatus::Pending {
            return Err(ServiceError::new(
                ServiceErrorCode::InvalidTransition,
                "Pending proposals cannot be deleted",
            ));
        }
        self.proposals.delete(id)?;
        drop(guard);
        self.sink.emit(ChangeEvent::ProposalDeleted(id.to_owned()));
        Ok(())
    }
}
