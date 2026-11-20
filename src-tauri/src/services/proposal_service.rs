use crate::{
    services::{
        runs::RunContext,
        service_error::{now_ms, Actor, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
        storage::{FileRepository, ListReport, Repository},
        task_service::{NewTask, TaskService},
    },
    types::proposal::{Proposal, ProposalKind, ProposalStatus},
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

const MAX_TITLE_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 10_000;
const MAX_SUBTASKS: usize = 50;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_PROPOSALS_PER_RUN: usize = 20;

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
            task_service::NewSubTask,
        },
        types::task::{TaskItem, TaskStatus},
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

    fn validate_payload(&self, id: &str, payload: &NewTask) -> Result<(), ServiceError> {
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
            }
        }
        let payload_bytes = serde_json::to_vec(payload)
            .map_err(|error| ServiceError::validation(format!("payload: {error}")))?;
        if payload_bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(ServiceError::validation(
                "payload must be at most 65536 bytes",
            ));
        }
        self.tasks.validate_input_with_id_locked(id, payload)
    }

    pub fn create(
        &self,
        actor: Actor,
        run: &RunContext,
        payload: NewTask,
    ) -> Result<Proposal, ServiceError> {
        Self::check_actor(actor, Actor::Script)?;
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
            kind: ProposalKind::Task,
            status: ProposalStatus::Pending,
            run_id: run.run_id.clone(),
            task_id: Some(run.task_id.clone()),
            workflow: run.workflow.clone(),
            payload,
            created_task_id: None,
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

    pub fn accept(
        &self,
        actor: Actor,
        id: &str,
        expected_rev: u64,
        edited: Option<NewTask>,
    ) -> Result<(Proposal, crate::types::task::TaskItem), ServiceError> {
        Self::check_actor(actor, Actor::Ui)?;
        let guard = self.lock()?;
        let mut proposal = self.proposals.get(id)?;
        if proposal.status == ProposalStatus::Accepted {
            match self.tasks.get(id) {
                Ok(task) => return Ok((proposal, task)),
                Err(error) if error.code == ServiceErrorCode::NotFound => {
                    return Err(ServiceError::new(
                        ServiceErrorCode::InvalidTransition,
                        "the task created from this proposal was deleted",
                    ));
                }
                Err(error) => return Err(error),
            }
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
        self.validate_payload(id, &payload)?;
        let (task, reconciled) = self
            .tasks
            .create_input_with_id_locked(id.to_owned(), payload)?;
        proposal.status = ProposalStatus::Accepted;
        proposal.created_task_id = Some(task.id.clone());
        proposal.decided_at = Some(now_ms());
        let update_result = self.proposals.update(proposal, expected_rev);
        drop(guard);

        self.sink.emit(ChangeEvent::TaskCreated(task.clone()));
        for changed in reconciled {
            self.sink.emit(ChangeEvent::TaskUpdated(changed));
        }
        let proposal = update_result?;
        self.sink
            .emit(ChangeEvent::ProposalUpdated(proposal.clone()));
        Ok((proposal, task))
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
