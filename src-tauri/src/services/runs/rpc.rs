use crate::{
    services::{
        project::ProjectServices,
        service_error::{
            now_ms, Actor, ChangeEvent, EventSink, RunOutcome, ServiceError, ServiceErrorCode,
        },
        task_service::{NewSubTask, NewTask},
    },
    types::{
        note::NoteItem,
        proposal::{
            BatchTaskItem, Presentation, ProposalKind, ProposalPayload, ProposalStatus,
            SubtasksPayload, TasksPayload,
        },
        task::{TaskItem, TaskStatus},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_TRACE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_RUN_STEPS: usize = 200;
const MAX_STEP_SUMMARY_CHARS: usize = 2000;
const MAX_STEP_REASON_CHARS: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposeBatchParams {
    items: Vec<BatchTaskItem>,
    source_task_id: Option<String>,
    presentation: Option<Presentation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposeSubtasksParams {
    task_id: String,
    items: Vec<NewSubTask>,
    presentation: Option<Presentation>,
}

#[derive(Debug, Default)]
pub struct LineBuffer {
    bytes: Vec<u8>,
    dropping_oversize: bool,
}

pub fn split_lines(buffer: &mut LineBuffer, chunk: &[u8]) -> Vec<Result<String, Value>> {
    let mut lines = Vec::new();
    for byte in chunk {
        if *byte == b'\n' {
            if buffer.dropping_oversize {
                buffer.dropping_oversize = false;
                buffer.bytes.clear();
                continue;
            }
            if buffer.bytes.last() == Some(&b'\r') {
                buffer.bytes.pop();
            }
            match String::from_utf8(std::mem::take(&mut buffer.bytes)) {
                Ok(line) => lines.push(Ok(line)),
                Err(_) => lines.push(Err(error_response(
                    Value::Null,
                    -32600,
                    "Invalid UTF-8 request",
                    None,
                ))),
            }
            continue;
        }
        if buffer.dropping_oversize {
            continue;
        }
        buffer.bytes.push(*byte);
        if buffer.bytes.len() > MAX_LINE_BYTES {
            buffer.bytes.clear();
            buffer.dropping_oversize = true;
            lines.push(Err(error_response(
                Value::Null,
                -32600,
                "Request line exceeds 1 MB",
                None,
            )));
        }
    }
    lines
}

#[derive(Debug, Clone)]
pub struct RpcRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

pub fn parse_request(line: &str) -> Result<RpcRequest, Value> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| error_response(Value::Null, -32700, "Parse error", None))?;
    let Some(object) = value.as_object() else {
        return Err(error_response(Value::Null, -32600, "Invalid Request", None));
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !object.get("method").is_some_and(Value::is_string)
    {
        return Err(error_response(id, -32600, "Invalid Request", None));
    }
    if object
        .get("id")
        .is_some_and(|id| !(id.is_string() || id.is_number() || id.is_null()))
    {
        return Err(error_response(id, -32600, "Invalid Request", None));
    }
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(error_response(id, -32600, "Invalid Request", None));
    }
    Ok(RpcRequest {
        id,
        method: object["method"].as_str().unwrap().to_owned(),
        params,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRequest {
    pub outcome: RunOutcome,
    pub summary: Option<String>,
    pub reason: Option<String>,
}

pub struct RpcContext {
    pub run_id: String,
    pub task_id: String,
    pub workflow: String,
    pub project: Arc<ProjectServices>,
    pub finish: Arc<Mutex<Option<FinishRequest>>>,
    pub record: Arc<Mutex<super::RunRecord>>,
    pub run_directory: PathBuf,
    pub sink: Arc<dyn EventSink>,
    pub version_mismatch: Arc<AtomicBool>,
    pub trace_path: PathBuf,
}

pub fn dispatch(ctx: &RpcContext, request: RpcRequest) -> Value {
    let id = request.id.clone();
    let response = match request.method.as_str() {
        "hello" => dispatch_hello(ctx, &request.params),
        "run.context" => empty_params(&request.params).and_then(|()| {
            let task = ctx.project.tasks.get(&ctx.task_id).map_err(domain_error)?;
            let attempt = task
                .runs
                .as_ref()
                .and_then(|runs| runs.iter().position(|run_id| run_id == &ctx.run_id))
                .map_or(1, |index| index + 1);
            let subtasks = task.sub_tasks.unwrap_or_default();
            let done = subtasks
                .iter()
                .filter(|item| {
                    matches!(item.status, TaskStatus::NeedsReview | TaskStatus::Completed)
                })
                .count();
            let pending = subtasks
                .iter()
                .filter(|item| {
                    !matches!(item.status, TaskStatus::NeedsReview | TaskStatus::Completed)
                })
                .map(|item| json!({"id":item.id,"title":item.title,"status":item.status}))
                .collect::<Vec<_>>();
            let previous = task
                .runs
                .as_ref()
                .and_then(|runs| runs.iter().position(|run_id| run_id == &ctx.run_id))
                .and_then(|index| index.checked_sub(1))
                .and_then(|index| task.runs.as_ref()?.get(index))
                .and_then(|run_id| previous_run(ctx, run_id));
            let mut result = json!({
                "runId":ctx.run_id,
                "taskId":ctx.task_id,
                "workflow":ctx.workflow,
                "attempt":attempt,
                "resume":{"total":subtasks.len(),"done":done,"pending":pending}
            });
            if let Some(previous) = previous {
                result["previous"] = previous;
            }
            Ok(result)
        }),
        "step.start" => {
            parse_step_start(&request.params).and_then(|subtask_id| start_step(ctx, subtask_id))
        }
        "step.finish" => {
            parse_step_finish(&request.params).and_then(|(subtask_id, outcome, summary, reason)| {
                finish_step(ctx, subtask_id, outcome, summary, reason)
            })
        }
        "tasks.get" => required_string(&request.params, "id").and_then(|task_id| {
            ctx.project
                .tasks
                .get(task_id)
                .and_then(serialize_task)
                .map_err(domain_error)
        }),
        "tasks.list" => empty_params(&request.params).and_then(|()| {
            ctx.project
                .tasks
                .list()
                .map(|report| serde_json::to_value(report.records).unwrap_or(Value::Null))
                .map_err(domain_error)
        }),
        "tasks.propose" => {
            parse_propose_task(&request.params).and_then(|(payload, presentation)| {
                let context = proposal_run_context(ctx);
                ctx.project
                    .proposals
                    .create_proposal(
                        Actor::Script,
                        &context,
                        ProposalKind::Task,
                        ProposalPayload::Task(payload),
                        presentation,
                    )
                    .map(|proposal| json!({"proposalId":proposal.id}))
                    .map_err(domain_error)
            })
        }
        "tasks.propose_batch" => {
            serde_json::from_value::<ProposeBatchParams>(request.params.clone())
                .map_err(|error| invalid_params(error.to_string()))
                .and_then(|params| {
                    ctx.project
                        .proposals
                        .create_proposal(
                            Actor::Script,
                            &proposal_run_context(ctx),
                            ProposalKind::Tasks,
                            ProposalPayload::Tasks(TasksPayload {
                                source_task_id: params.source_task_id,
                                items: params.items,
                            }),
                            params.presentation.unwrap_or_default(),
                        )
                        .map(|proposal| json!({"proposalId":proposal.id}))
                        .map_err(domain_error)
                })
        }
        "tasks.propose_subtasks" => {
            serde_json::from_value::<ProposeSubtasksParams>(request.params.clone())
                .map_err(|error| invalid_params(error.to_string()))
                .and_then(|params| {
                    ctx.project
                        .proposals
                        .create_proposal(
                            Actor::Script,
                            &proposal_run_context(ctx),
                            ProposalKind::Subtasks,
                            ProposalPayload::Subtasks(SubtasksPayload {
                                task_id: params.task_id,
                                items: params.items,
                            }),
                            params.presentation.unwrap_or_default(),
                        )
                        .map(|proposal| json!({"proposalId":proposal.id}))
                        .map_err(domain_error)
                })
        }
        "proposals.list" => empty_params(&request.params).and_then(|()| {
            ctx.project
                .proposals
                .list()
                .map(|report| {
                    json!(report
                        .records
                        .into_iter()
                        .map(|proposal| {
                            let status = match proposal.status {
                                ProposalStatus::Pending => "pending",
                                ProposalStatus::Accepted => "accepted",
                                ProposalStatus::Rejected => "rejected",
                            };
                            json!({
                                "id":proposal.id,
                                "title":proposal.payload.title(),
                                "status":status
                            })
                        })
                        .collect::<Vec<_>>())
                })
                .map_err(domain_error)
        }),
        "notes.get" => required_string(&request.params, "id").and_then(|note_id| {
            ctx.project
                .notes
                .get(note_id)
                .and_then(serialize_note)
                .map_err(domain_error)
        }),
        "notes.for_task" => required_string(&request.params, "taskId").and_then(|task_id| {
            ctx.project
                .tasks
                .get(task_id)
                .and_then(|task| notes_for_task(&ctx.project, task))
                .map_err(domain_error)
        }),
        "run.finish" => parse_finish(&request.params).and_then(|finish| {
            let mut stored = ctx
                .finish
                .lock()
                .map_err(|error| invalid_params(error.to_string()))?;
            if stored.is_some() {
                return Err(domain_error(ServiceError::validation(
                    "run.finish has already been called",
                )));
            }
            *stored = Some(finish);
            Ok(Value::Null)
        }),
        _ => return error_response(id, -32601, "Method not found", None),
    };
    match response {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(mut error) => {
            error["id"] = id;
            error
        }
    }
}

fn parse_step_start(params: &Value) -> Result<String, Value> {
    let object = params
        .as_object()
        .filter(|object| object.len() == 1 && object.contains_key("subtaskId"))
        .ok_or_else(|| invalid_params("step.start requires only 'subtaskId'"))?;
    object["subtaskId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid_params("'subtaskId' must be a string"))
}

fn parse_step_finish(
    params: &Value,
) -> Result<(String, TaskStatus, Option<String>, Option<String>), Value> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid_params("params must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "subtaskId" | "outcome" | "summary" | "reason"))
    {
        return Err(invalid_params("step.finish has an unknown parameter"));
    }
    let subtask_id = object
        .get("subtaskId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("'subtaskId' must be a string"))?
        .to_owned();
    let outcome = match object.get("outcome").and_then(Value::as_str) {
        Some("needs_review") => TaskStatus::NeedsReview,
        Some("failed") => TaskStatus::Failed,
        Some(_) => {
            return Err(domain_error(ServiceError::new(
                ServiceErrorCode::Forbidden,
                "Scripts may finish steps only as needs_review or failed",
            )))
        }
        None => return Err(invalid_params("'outcome' must be a string")),
    };
    let optional_string = |key: &str| -> Result<Option<String>, Value> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(invalid_params(format!("'{key}' must be a string or null"))),
        }
    };
    let summary = optional_string("summary")?;
    let reason = optional_string("reason")?;
    if summary
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_STEP_SUMMARY_CHARS)
    {
        return Err(domain_error(ServiceError::validation(
            "summary must be at most 2000 characters",
        )));
    }
    if reason
        .as_ref()
        .is_some_and(|value| value.chars().count() > MAX_STEP_REASON_CHARS)
    {
        return Err(domain_error(ServiceError::validation(
            "reason must be at most 500 characters",
        )));
    }
    Ok((subtask_id, outcome, summary, reason))
}

fn start_step(ctx: &RpcContext, subtask_id: String) -> Result<Value, Value> {
    let mut record = ctx.record.lock().map_err(|error| {
        domain_error(ServiceError::new(ServiceErrorCode::Io, error.to_string()))
    })?;
    let task = ctx.project.tasks.get(&ctx.task_id).map_err(domain_error)?;
    let subtask = task
        .sub_tasks
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.id == subtask_id))
        .ok_or_else(|| {
            domain_error(ServiceError::new(
                ServiceErrorCode::NotFound,
                format!("subtaskId: subtask {subtask_id} not found in this run's task"),
            ))
        })?;
    if record.steps.iter().any(|step| step.ended_at.is_none()) {
        return Err(domain_error(ServiceError::validation(
            "finish the current step first",
        )));
    }
    if record.steps.len() >= MAX_RUN_STEPS {
        return Err(domain_error(ServiceError::validation(
            "steps may contain at most 200 entries",
        )));
    }
    if subtask.status == TaskStatus::Completed {
        return Err(domain_error(ServiceError::new(
            ServiceErrorCode::InvalidTransition,
            "A completed subtask cannot be restarted",
        )));
    }
    if !matches!(
        subtask.status,
        TaskStatus::Ready | TaskStatus::Failed | TaskStatus::NeedsReview
    ) {
        return Err(domain_error(ServiceError::new(
            ServiceErrorCode::InvalidTransition,
            "Subtask is not startable",
        )));
    }

    ctx.project
        .tasks
        .set_subtask_status(
            &ctx.task_id,
            &subtask_id,
            TaskStatus::Running,
            Actor::Script,
        )
        .map_err(domain_error)?;
    record.steps.push(super::RunStep {
        subtask_id: subtask_id.clone(),
        started_at: now_ms(),
        ended_at: None,
        outcome: None,
        summary: None,
        reason: None,
    });
    super::write_run_record(&ctx.run_directory, &record).map_err(|error| {
        domain_error(ServiceError::new(ServiceErrorCode::Io, error.to_string()))
    })?;
    ctx.sink.emit(ChangeEvent::RunStep {
        run_id: ctx.run_id.clone(),
        task_id: ctx.task_id.clone(),
        subtask_id,
        status: TaskStatus::Running,
        summary: None,
        reason: None,
    });
    Ok(Value::Null)
}

fn finish_step(
    ctx: &RpcContext,
    subtask_id: String,
    outcome: TaskStatus,
    summary: Option<String>,
    reason: Option<String>,
) -> Result<Value, Value> {
    let mut record = ctx.record.lock().map_err(|error| {
        domain_error(ServiceError::new(ServiceErrorCode::Io, error.to_string()))
    })?;
    let step = record
        .steps
        .iter()
        .rposition(|step| step.ended_at.is_none())
        .ok_or_else(|| domain_error(ServiceError::validation("there is no open step to finish")))?;
    if record.steps[step].subtask_id != subtask_id {
        return Err(domain_error(ServiceError::validation(
            "subtaskId does not match the open step",
        )));
    }
    ctx.project
        .tasks
        .set_subtask_status(&ctx.task_id, &subtask_id, outcome, Actor::Script)
        .map_err(domain_error)?;
    let entry = &mut record.steps[step];
    entry.ended_at = Some(now_ms());
    entry.outcome = Some(if outcome == TaskStatus::NeedsReview {
        RunOutcome::NeedsReview
    } else {
        RunOutcome::Failed
    });
    entry.summary = summary.clone();
    entry.reason = reason.clone();
    super::write_run_record(&ctx.run_directory, &record).map_err(|error| {
        domain_error(ServiceError::new(ServiceErrorCode::Io, error.to_string()))
    })?;
    ctx.sink.emit(ChangeEvent::RunStep {
        run_id: ctx.run_id.clone(),
        task_id: ctx.task_id.clone(),
        subtask_id,
        status: outcome,
        summary,
        reason,
    });
    Ok(Value::Null)
}

fn previous_run(ctx: &RpcContext, run_id: &str) -> Option<Value> {
    if run_id.is_empty()
        || run_id.len() > 64
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    let path = ctx
        .project
        .root
        .join(".cairn")
        .join("runs")
        .join(run_id)
        .join("run.json");
    let previous: super::RunRecord = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if previous.run_id != run_id {
        return None;
    }
    let outcome = previous.outcome?;
    let mut result = json!({
        "runId":previous.run_id,
        "outcome":serde_json::to_value(outcome).ok()?
    });
    if let Some(reason) = previous.reason {
        result["reason"] = json!(reason);
    }
    if let Some(summary) = previous.summary {
        result["summary"] = json!(summary);
    }
    Some(result)
}

fn proposal_run_context(ctx: &RpcContext) -> super::RunContext {
    super::RunContext {
        run_id: ctx.run_id.clone(),
        task_id: ctx.task_id.clone(),
        workflow: ctx.workflow.clone(),
    }
}

fn parse_propose_task(params: &Value) -> Result<(NewTask, Presentation), Value> {
    let mut task_params = params.clone();
    let presentation = match task_params
        .as_object_mut()
        .and_then(|object| object.remove("presentation"))
    {
        Some(Value::Null) | None => Presentation::Notify,
        Some(value) => {
            serde_json::from_value(value).map_err(|error| invalid_params(error.to_string()))?
        }
    };
    serde_json::from_value::<NewTask>(task_params)
        .map(|payload| (payload, presentation))
        .map_err(|error| invalid_params(error.to_string()))
}

fn dispatch_hello(ctx: &RpcContext, params: &Value) -> Result<Value, Value> {
    let version = params
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("apiVersion"))
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_params("hello requires an integer apiVersion"))?;
    if version != 1 {
        ctx.version_mismatch.store(true, Ordering::SeqCst);
        return Err(invalid_params("SDK API version mismatch"));
    }
    Ok(json!({"apiVersion":1}))
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, Value> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid_params("params must be an object"))?;
    if object.len() != 1 {
        return Err(invalid_params(format!(
            "expected only the '{key}' parameter"
        )));
    }
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params(format!("'{key}' must be a string")))
}

fn empty_params(params: &Value) -> Result<(), Value> {
    if params.as_object().is_some_and(|object| object.is_empty()) {
        Ok(())
    } else {
        Err(invalid_params("method takes no parameters"))
    }
}

fn parse_finish(params: &Value) -> Result<FinishRequest, Value> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid_params("params must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "outcome" | "summary" | "reason"))
    {
        return Err(invalid_params("run.finish has an unknown parameter"));
    }
    let outcome = match object.get("outcome").and_then(Value::as_str) {
        Some("needs_review") => RunOutcome::NeedsReview,
        Some("failed") => RunOutcome::Failed,
        Some(_) => {
            return Err(domain_error(ServiceError::new(
                crate::services::service_error::ServiceErrorCode::Forbidden,
                "Scripts may finish only as needs_review or failed",
            )))
        }
        None => return Err(invalid_params("'outcome' must be a string")),
    };
    let optional_string = |key: &str| -> Result<Option<String>, Value> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(invalid_params(format!("'{key}' must be a string or null"))),
        }
    };
    Ok(FinishRequest {
        outcome,
        summary: optional_string("summary")?,
        reason: optional_string("reason")?,
    })
}

fn serialize_task(task: TaskItem) -> Result<Value, ServiceError> {
    serde_json::to_value(task).map_err(|error| {
        ServiceError::new(
            crate::services::service_error::ServiceErrorCode::Io,
            error.to_string(),
        )
    })
}

fn serialize_note(note: NoteItem) -> Result<Value, ServiceError> {
    serde_json::to_value(note).map_err(|error| {
        ServiceError::new(
            crate::services::service_error::ServiceErrorCode::Io,
            error.to_string(),
        )
    })
}

fn notes_for_task(project: &ProjectServices, task: TaskItem) -> Result<Value, ServiceError> {
    let mut notes = Vec::new();
    for id in task.linked_note_ids.unwrap_or_default() {
        match project.notes.get(&id) {
            Ok(note) => notes.push(note),
            Err(error)
                if error.code == crate::services::service_error::ServiceErrorCode::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    serde_json::to_value(notes).map_err(|error| {
        ServiceError::new(
            crate::services::service_error::ServiceErrorCode::Io,
            error.to_string(),
        )
    })
}

fn domain_error(error: ServiceError) -> Value {
    error_response(
        Value::Null,
        -32000,
        error.message.clone(),
        Some(json!({"code":error.code,"message":error.message})),
    )
}

fn invalid_params(message: impl Into<String>) -> Value {
    error_response(Value::Null, -32602, message, None)
}

fn error_response(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut error = json!({"code":code,"message":message.into()});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"jsonrpc":"2.0","id":id,"error":error})
}

pub fn handle_line(ctx: &RpcContext, line: &str) -> Value {
    let started = Instant::now();
    let parsed = parse_request(line);
    let method = parsed.as_ref().ok().map(|request| request.method.clone());
    let response = parsed
        .map(|request| dispatch(ctx, request))
        .unwrap_or_else(|error| error);
    append_trace(
        &ctx.trace_path,
        method.as_deref(),
        &response,
        started.elapsed().as_millis() as u64,
    );
    response
}

pub fn append_trace(path: &Path, method: Option<&str>, response: &Value, ms: u64) {
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            tauri_plugin_log::log::error!("Could not create run trace directory: {error}");
            return;
        }
    }
    let error = response.get("error");
    let mut entry = json!({
        "t":crate::services::service_error::now_ms(),
        "method":method,
        "ok":error.is_none(),
        "ms":ms
    });
    if let Some(error) = error {
        entry["error"] = error.clone();
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    match options.open(path) {
        Ok(mut file) => {
            let size = match file.metadata() {
                Ok(metadata) => metadata.len(),
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not inspect run trace size: {error}");
                    return;
                }
            };
            if size >= MAX_TRACE_BYTES {
                return;
            }
            let mut line = match serde_json::to_vec(&entry) {
                Ok(line) => line,
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not encode run trace entry: {error}");
                    return;
                }
            };
            line.push(b'\n');
            if line.len() as u64 > MAX_TRACE_BYTES - size {
                return;
            }
            if let Err(error) = file.write_all(&line) {
                tauri_plugin_log::log::error!("Could not append run trace: {error}");
            }
        }
        Err(error) => tauri_plugin_log::log::error!("Could not open run trace: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        services::{
            project::ProjectState,
            service_error::{NoopSink, RecordingSink},
        },
        types::{
            note::NoteItem,
            task::{SubTask, TaskItem},
        },
    };
    use std::{
        io::{BufRead, BufReader, Read, Write},
        process::Command,
        sync::Mutex,
    };
    use tempfile::tempdir;

    fn request(id: u64, method: &str, params: Value) -> RpcRequest {
        RpcRequest {
            id: json!(id),
            method: method.into(),
            params,
        }
    }

    fn context() -> (tempfile::TempDir, RpcContext) {
        let (directory, context, _) = context_with_sink();
        (directory, context)
    }

    fn context_with_sink() -> (tempfile::TempDir, RpcContext, RecordingSink) {
        let directory = tempdir().unwrap();
        let project_state = ProjectState::default();
        let sink = RecordingSink::default();
        project_state.open(directory.path(), sink.clone()).unwrap();
        let run_directory = directory.path().join(".cairn/runs/run-id");
        let record = super::super::RunRecord {
            run_id: "run-id".into(),
            task_id: "task-id".into(),
            workflow: "hello".into(),
            source: super::super::workflows::WorkflowSource::Project,
            script_hash: "hash".into(),
            started_at: 1,
            ended_at: None,
            outcome: None,
            reason: None,
            summary: None,
            steps: Vec::new(),
        };
        super::super::write_run_record(&run_directory, &record).unwrap();
        let context = RpcContext {
            run_id: "run-id".into(),
            task_id: "task-id".into(),
            workflow: "hello".into(),
            project: project_state.services().unwrap(),
            finish: Arc::new(Mutex::new(None)),
            record: Arc::new(Mutex::new(record)),
            run_directory,
            sink: Arc::new(sink.clone()),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: directory_path_placeholder(),
        };
        (directory, context, sink)
    }

    fn directory_path_placeholder() -> PathBuf {
        std::env::temp_dir().join(format!("cairn-rpc-{}.jsonl", uuid::Uuid::new_v4()))
    }

    #[test]
    fn split_lines_handles_partial_and_multiple_requests() {
        let mut buffer = LineBuffer::default();
        assert!(split_lines(&mut buffer, br#"{"jsonrpc":"2.0","id":1"#).is_empty());
        let lines = split_lines(
            &mut buffer,
            br#","method":"tasks.list","params":{}}
{"jsonrpc":"2.0","id":2,"method":"run.context","params":{}}
"#,
        );
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(Result::is_ok));
    }

    #[test]
    fn malformed_json_is_parse_error_and_invalid_requests_are_rejected() {
        let error = parse_request("{").unwrap_err();
        assert_eq!(error["error"]["code"], -32700);
        assert_eq!(parse_request("[]").unwrap_err()["error"]["code"], -32600);
    }

    #[test]
    fn oversize_line_is_reported_and_discarded_until_newline() {
        let mut buffer = LineBuffer::default();
        let mut chunk = vec![b'a'; MAX_LINE_BYTES + 1];
        chunk.extend_from_slice(
            b"junk\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tasks.list\",\"params\":{}}\n",
        );
        let lines = split_lines(&mut buffer, &chunk);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].as_ref().unwrap_err()["error"]["code"], -32600);
        assert!(lines[1].is_ok());
    }

    #[test]
    fn permission_manifest_is_exact_and_forbidden_status_is_structured() {
        let (_directory, ctx) = context();
        let allowed = [
            "hello",
            "run.context",
            "step.start",
            "step.finish",
            "tasks.get",
            "tasks.list",
            "tasks.propose",
            "tasks.propose_batch",
            "tasks.propose_subtasks",
            "proposals.list",
            "notes.get",
            "notes.for_task",
            "run.finish",
        ];
        for method in allowed {
            let params = if method == "hello" {
                json!({"apiVersion":1})
            } else if method.ends_with(".get") {
                json!({"id":"missing"})
            } else if method == "notes.for_task" {
                json!({"taskId":"missing"})
            } else if method == "tasks.propose" {
                json!({"title":"proposed task"})
            } else if method == "tasks.propose_batch" {
                json!({"items":[{"key":"first","title":"first task"}]})
            } else if method == "tasks.propose_subtasks" {
                json!({"taskId":"missing","items":[{"title":"subtask"}]})
            } else if method == "run.finish" {
                json!({"outcome":"needs_review"})
            } else if method == "step.start" {
                json!({"subtaskId":"missing"})
            } else if method == "step.finish" {
                json!({"subtaskId":"missing","outcome":"failed"})
            } else {
                json!({})
            };
            let response = dispatch(&ctx, request(1, method, params));
            assert_ne!(response["error"]["code"], -32601, "{method}");
        }
        for method in [
            "tasks.update",
            "tasks.create",
            "notes.create",
            "proposals.accept",
            "tasks.set_status",
            "tasks.update",
        ] {
            let response = dispatch(&ctx, request(2, method, json!({})));
            assert_eq!(response["error"]["code"], -32601, "{method}");
        }
        let forbidden = dispatch(
            &ctx,
            request(3, "run.finish", json!({"outcome":"completed"})),
        );
        assert_eq!(forbidden["error"]["code"], -32000);
        assert_eq!(forbidden["error"]["data"]["code"], "Forbidden");
    }

    #[test]
    fn malformed_params_and_unknown_methods_use_standard_errors() {
        let (_directory, ctx) = context();
        assert_eq!(
            dispatch(&ctx, request(1, "tasks.get", json!({})))["error"]["code"],
            -32602
        );
        assert_eq!(
            dispatch(&ctx, request(1, "bogus", json!({})))["error"]["code"],
            -32601
        );
        assert_eq!(
            dispatch(&ctx, request(1, "hello", json!({"apiVersion":2})))["error"]["code"],
            -32602
        );
        assert!(ctx.version_mismatch.load(Ordering::SeqCst));
    }

    #[test]
    fn read_methods_return_records_and_skip_dangling_note_links() {
        let (_directory, ctx) = context();
        let note = ctx.project.notes.create(NoteItem::new("note")).unwrap();
        let mut task = TaskItem::new("task");
        task.id = "task-id".into();
        let task = ctx.project.tasks.create(task).unwrap();
        let mut task_with_dangling_note = task.clone();
        task_with_dangling_note.linked_note_ids = Some(vec![note.id.clone(), "missing".into()]);
        std::fs::write(
            ctx.project
                .root
                .join(".cairn/tasks")
                .join(format!("{}.json", task.id)),
            serde_json::to_vec(&task_with_dangling_note).unwrap(),
        )
        .unwrap();
        assert_eq!(
            dispatch(&ctx, request(1, "tasks.get", json!({"id":task.id})))["result"]["title"],
            "task"
        );
        assert_eq!(
            dispatch(&ctx, request(2, "tasks.list", json!({})))["result"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(3, "notes.for_task", json!({"taskId":task.id}))
            )["result"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn run_context_reports_first_and_retry_attempts() {
        let (_directory, mut ctx) = context();
        let mut task = TaskItem::new("task");
        task.id = ctx.task_id.clone();
        task.runs = Some(vec![ctx.run_id.clone()]);
        ctx.project.tasks.create(task.clone()).unwrap();

        let first_context = dispatch(&ctx, request(1, "run.context", json!({})))["result"].clone();
        assert_eq!(first_context["attempt"], 1);
        assert!(first_context.get("previous").is_none());

        ctx.run_id = "retry-run".into();
        task.runs = Some(vec!["run-id".into(), ctx.run_id.clone()]);
        std::fs::write(
            ctx.project
                .root
                .join(".cairn")
                .join("tasks")
                .join(format!("{}.json", task.id)),
            serde_json::to_vec(&task).unwrap(),
        )
        .unwrap();
        assert_eq!(
            dispatch(&ctx, request(2, "run.context", json!({})))["result"]["attempt"],
            2
        );
    }

    #[test]
    fn step_rpc_updates_subtasks_persists_steps_and_enforces_step_rules() {
        let (_directory, ctx, sink) = context_with_sink();
        let mut task = TaskItem::new("task");
        task.id = ctx.task_id.clone();
        let first = SubTask::new("first");
        let failed = SubTask::new("failed");
        let reviewed = SubTask::new("reviewed");
        let completed = SubTask::new("completed");
        task.sub_tasks = Some(vec![
            first.clone(),
            failed.clone(),
            reviewed.clone(),
            completed.clone(),
        ]);
        let mut task = ctx.project.tasks.create(task).unwrap();
        let first = task.sub_tasks.as_ref().unwrap()[0].clone();
        let failed = task.sub_tasks.as_ref().unwrap()[1].clone();
        let reviewed = task.sub_tasks.as_ref().unwrap()[2].clone();
        let completed = task.sub_tasks.as_ref().unwrap()[3].clone();
        for (subtask, status) in [
            (&failed, TaskStatus::Failed),
            (&reviewed, TaskStatus::NeedsReview),
            (&completed, TaskStatus::Completed),
        ] {
            task = ctx
                .project
                .tasks
                .set_subtask_status(&task.id, &subtask.id, status, Actor::Ui)
                .unwrap();
        }
        let mut other_task = TaskItem::new("other task");
        let foreign = SubTask::new("foreign");
        other_task.sub_tasks = Some(vec![foreign.clone()]);
        let foreign = ctx
            .project
            .tasks
            .create(other_task)
            .unwrap()
            .sub_tasks
            .unwrap()[0]
            .clone();
        sink.take();

        assert_eq!(
            dispatch(
                &ctx,
                request(1, "step.start", json!({"subtaskId":first.id}))
            )["result"],
            Value::Null
        );
        let events = sink.take();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ChangeEvent::TaskUpdated(_)))
                .count(),
            1
        );
        assert_eq!(
            ctx.project
                .tasks
                .get(&ctx.task_id)
                .unwrap()
                .sub_tasks
                .unwrap()[0]
                .status,
            TaskStatus::Running
        );
        assert_eq!(ctx.record.lock().unwrap().steps.len(), 1);

        for id in ["unknown", foreign.id.as_str()] {
            let response = dispatch(&ctx, request(2, "step.start", json!({"subtaskId":id})));
            assert_eq!(response["error"]["data"]["code"], "NotFound");
            assert!(response["error"]["data"]["message"]
                .as_str()
                .unwrap()
                .contains("subtaskId"));
        }
        assert_eq!(
            dispatch(
                &ctx,
                request(3, "step.start", json!({"subtaskId":failed.id}))
            )["error"]["data"]["code"],
            "Validation"
        );
        assert!(
            dispatch(
                &ctx,
                request(
                    4,
                    "step.finish",
                    json!({"subtaskId":first.id,"outcome":"completed"})
                )
            )["error"]["data"]["code"]
                == "Forbidden"
        );
        for (field, value) in [("summary", "s".repeat(2001)), ("reason", "r".repeat(501))] {
            let mut params = json!({"subtaskId":first.id,"outcome":"failed"});
            params[field] = json!(value);
            let error = dispatch(&ctx, request(4, "step.finish", params))["error"].clone();
            assert_eq!(error["data"]["code"], "Validation");
            assert!(error["data"]["message"].as_str().unwrap().contains(field));
        }
        assert_eq!(
            dispatch(
                &ctx,
                request(
                    5,
                    "step.finish",
                    json!({"subtaskId":failed.id,"outcome":"failed"})
                )
            )["error"]["data"]["code"],
            "Validation"
        );

        sink.take();
        assert_eq!(
            dispatch(
                &ctx,
                request(
                    6,
                    "step.finish",
                    json!({"subtaskId":first.id,"outcome":"needs_review","summary":"ok"})
                )
            )["result"],
            Value::Null
        );
        let events = sink.take();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ChangeEvent::TaskUpdated(_)))
                .count(),
            1
        );
        let persisted: super::super::RunRecord =
            serde_json::from_slice(&std::fs::read(ctx.run_directory.join("run.json")).unwrap())
                .unwrap();
        assert_eq!(persisted.steps[0].outcome, Some(RunOutcome::NeedsReview));
        assert_eq!(persisted.steps[0].summary.as_deref(), Some("ok"));
        assert!(persisted.steps[0].ended_at.is_some());
        assert_eq!(
            ctx.project
                .tasks
                .get(&ctx.task_id)
                .unwrap()
                .sub_tasks
                .unwrap()[0]
                .status,
            TaskStatus::NeedsReview
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(
                    7,
                    "step.finish",
                    json!({"subtaskId":first.id,"outcome":"failed"})
                )
            )["error"]["data"]["code"],
            "Validation"
        );

        assert_eq!(
            dispatch(
                &ctx,
                request(8, "step.start", json!({"subtaskId":first.id}))
            )["result"],
            Value::Null
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(
                    9,
                    "step.finish",
                    json!({"subtaskId":first.id,"outcome":"failed","reason":"retry failed"})
                )
            )["result"],
            Value::Null
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(10, "step.start", json!({"subtaskId":failed.id}))
            )["result"],
            Value::Null
        );
        dispatch(
            &ctx,
            request(
                11,
                "step.finish",
                json!({"subtaskId":failed.id,"outcome":"needs_review"}),
            ),
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(12, "step.start", json!({"subtaskId":reviewed.id}))
            )["result"],
            Value::Null
        );
        dispatch(
            &ctx,
            request(
                13,
                "step.finish",
                json!({"subtaskId":reviewed.id,"outcome":"failed"}),
            ),
        );
        assert_eq!(
            dispatch(
                &ctx,
                request(14, "step.start", json!({"subtaskId":completed.id}))
            )["error"]["data"]["code"],
            "InvalidTransition"
        );
        assert_eq!(ctx.record.lock().unwrap().steps.len(), 4);

        let task = ctx.project.tasks.get(&ctx.task_id).unwrap();
        let mut steps_full = ctx.record.lock().unwrap();
        steps_full.steps = (0..200)
            .map(|index| super::super::RunStep {
                subtask_id: format!("closed-{index}"),
                started_at: 1,
                ended_at: Some(2),
                outcome: Some(RunOutcome::NeedsReview),
                summary: None,
                reason: None,
            })
            .collect();
        drop(steps_full);
        let error = dispatch(
            &ctx,
            request(
                15,
                "step.start",
                json!({"subtaskId":task.sub_tasks.unwrap()[0].id}),
            ),
        )["error"]
            .clone();
        assert_eq!(error["data"]["code"], "Validation");
        assert!(error["data"]["message"].as_str().unwrap().contains("steps"));
    }

    #[test]
    fn run_context_reports_resume_and_previous_run() {
        let (_directory, ctx) = context();
        let mut task = TaskItem::new("task");
        task.id = ctx.task_id.clone();
        let statuses = [
            TaskStatus::NeedsReview,
            TaskStatus::Failed,
            TaskStatus::Ready,
            TaskStatus::Completed,
        ]
        .into_iter()
        .map(|_| SubTask::new("step"))
        .collect::<Vec<_>>();
        task.sub_tasks = Some(statuses.clone());
        task.runs = Some(vec!["previous-run".into(), ctx.run_id.clone()]);
        let mut task = ctx.project.tasks.create(task).unwrap();
        let statuses_for_subtasks = task
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
        for (subtask_id, status) in statuses_for_subtasks {
            if status != TaskStatus::Ready {
                task = ctx
                    .project
                    .tasks
                    .set_subtask_status(&task.id, &subtask_id, status, Actor::Ui)
                    .unwrap();
            }
        }
        let statuses = task.sub_tasks.unwrap();
        let previous_dir = ctx.project.root.join(".cairn/runs/previous-run");
        let previous = super::super::RunRecord {
            run_id: "previous-run".into(),
            task_id: ctx.task_id.clone(),
            workflow: "hello".into(),
            source: super::super::workflows::WorkflowSource::Project,
            script_hash: "hash".into(),
            started_at: 1,
            ended_at: Some(2),
            outcome: Some(RunOutcome::Failed),
            reason: Some("last failure".into()),
            summary: Some("partial".into()),
            steps: Vec::new(),
        };
        super::super::write_run_record(&previous_dir, &previous).unwrap();

        let result = dispatch(&ctx, request(1, "run.context", json!({})))["result"].clone();
        assert_eq!(result["resume"]["total"], 4);
        assert_eq!(result["resume"]["done"], 2);
        assert_eq!(
            result["resume"]["pending"],
            json!([
                {"id":statuses[1].id,"title":"step","status":"failed"},
                {"id":statuses[2].id,"title":"step","status":"ready"}
            ])
        );
        assert_eq!(
            result["previous"],
            json!({"runId":"previous-run","outcome":"failed","reason":"last failure","summary":"partial"})
        );

        let mut empty = TaskItem::new("empty");
        empty.id = ctx.task_id.clone();
        empty.runs = None;
        ctx.project.tasks.delete(&ctx.task_id).unwrap();
        ctx.project.tasks.create(empty).unwrap();
        let result = dispatch(&ctx, request(2, "run.context", json!({})))["result"].clone();
        assert_eq!(result["resume"], json!({"total":0,"done":0,"pending":[]}));
        assert!(result.get("previous").is_none());
    }

    #[test]
    fn workflow_can_propose_and_list_without_creating_a_task() {
        let (_directory, ctx) = context();
        let proposal = dispatch(
            &ctx,
            request(1, "tasks.propose", json!({"title":"follow up"})),
        );
        assert_eq!(proposal["error"]["code"], Value::Null);
        let proposal_id = proposal["result"]["proposalId"].as_str().unwrap();
        assert!(ctx.project.tasks.get(proposal_id).is_err());
        let listed = dispatch(&ctx, request(2, "proposals.list", json!({})));
        assert_eq!(
            listed["result"],
            json!([{"id":proposal_id,"title":"follow up","status":"pending"}])
        );
    }

    #[test]
    fn workflow_can_propose_each_kind_with_a_presentation_hint() {
        let (_directory, ctx) = context();
        let mut current = TaskItem::new("current");
        current.id = ctx.task_id.clone();
        let current = ctx.project.tasks.create(current).unwrap();

        let task = dispatch(
            &ctx,
            request(
                1,
                "tasks.propose",
                json!({"title":"single","presentation":"display"}),
            ),
        );
        assert_eq!(task["error"]["code"], Value::Null);

        let batch = dispatch(
            &ctx,
            request(
                2,
                "tasks.propose_batch",
                json!({
                    "sourceTaskId":current.id,
                    "presentation":"notify",
                    "items":[
                        {"key":"first","title":"First step"},
                        {"key":"second","title":"Second step","dependsOnKey":"first"}
                    ]
                }),
            ),
        );
        assert_eq!(batch["error"]["code"], Value::Null);

        let subtasks = dispatch(
            &ctx,
            request(
                3,
                "tasks.propose_subtasks",
                json!({
                    "taskId":current.id,
                    "items":[{"title":"child"}],
                    "presentation":"display"
                }),
            ),
        );
        assert_eq!(subtasks["error"]["code"], Value::Null);

        let records = ctx.project.proposals.list().unwrap().records;
        assert_eq!(records.len(), 3);
        assert!(records
            .iter()
            .any(|proposal| proposal.presentation == Presentation::Display));
        assert!(records
            .iter()
            .any(|proposal| proposal.kind == ProposalKind::Tasks));
        assert!(records
            .iter()
            .any(|proposal| proposal.kind == ProposalKind::Subtasks));
        assert!(records
            .iter()
            .all(|proposal| proposal.status == ProposalStatus::Pending));
        assert_eq!(ctx.project.tasks.list().unwrap().records.len(), 1);
    }

    #[test]
    #[ignore = "requires uv and Python"]
    fn propose_split_script_persists_proposal_without_creating_tasks() {
        let directory = tempdir().unwrap();
        let state = ProjectState::default();
        state.open(directory.path(), NoopSink).unwrap();
        let project = state.services().unwrap();
        let task = project
            .tasks
            .create(TaskItem::new("original task"))
            .unwrap();
        let sdk_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sdk")
            .join("python");
        let script = sdk_dir.join("examples").join("propose_split.py");
        let mut child = Command::new("uv")
            .arg("run")
            .arg("--script")
            .arg(&script)
            .current_dir(&project.root)
            .env("PYTHONPATH", &sdk_dir)
            .env("CAIRN_RUN_ID", "integration-run")
            .env("CAIRN_API_VERSION", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("uv must be installed to run the ignored integration test");
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut input = child.stdin.take().unwrap();
        let context = RpcContext {
            run_id: "integration-run".into(),
            task_id: task.id.clone(),
            workflow: "propose".into(),
            project: project.clone(),
            finish: Arc::new(Mutex::new(None)),
            record: Arc::new(Mutex::new(super::super::RunRecord {
                run_id: "integration-run".into(),
                task_id: task.id.clone(),
                workflow: "propose".into(),
                source: super::super::workflows::WorkflowSource::Project,
                script_hash: "hash".into(),
                started_at: 1,
                ended_at: None,
                outcome: None,
                reason: None,
                summary: None,
                steps: Vec::new(),
            })),
            run_directory: project.root.join(".cairn/runs/integration-run"),
            sink: Arc::new(NoopSink),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: project.root.join(".cairn/runs/integration-run/trace.jsonl"),
        };
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let response = handle_line(&context, line.trim_end());
            serde_json::to_writer(&mut input, &response).unwrap();
            input.write_all(b"\n").unwrap();
            input.flush().unwrap();
        }
        drop(input);
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "workflow failed: {stderr}");

        let proposals = project.proposals.list().unwrap().records;
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].status, ProposalStatus::Pending);
        assert_eq!(proposals[0].kind, ProposalKind::Tasks);
        assert_eq!(proposals[0].payload.title(), "First step");
        assert!(project
            .root
            .join(".cairn/runs/proposals")
            .join(format!("{}.json", proposals[0].id))
            .is_file());
        let tasks = project.tasks.list().unwrap().records;
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, task.id);
    }

    #[test]
    #[ignore = "requires uv and Python"]
    fn steps_script_fails_second_subtask_and_retry_resume_lists_remaining_steps() {
        let directory = tempdir().unwrap();
        let state = ProjectState::default();
        let sink = RecordingSink::default();
        state.open(directory.path(), sink.clone()).unwrap();
        let project = state.services().unwrap();
        let mut task = TaskItem::new("step integration");
        let mut first = SubTask::new("first");
        first.description = Some("succeeds".into());
        let second = SubTask::new("FAIL: second");
        let third = SubTask::new("third");
        task.sub_tasks = Some(vec![first, second, third]);
        let task = project.tasks.create(task).unwrap();
        let step_ids = task
            .sub_tasks
            .as_ref()
            .unwrap()
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let run_id = "integration-run";
        let task = project
            .tasks
            .start_with_run(&task.id, task.rev, run_id.into(), Actor::Ui)
            .unwrap();
        let run_directory = project.root.join(".cairn/runs").join(run_id);
        let record = super::super::RunRecord {
            run_id: run_id.into(),
            task_id: task.id.clone(),
            workflow: "steps".into(),
            source: super::super::workflows::WorkflowSource::Project,
            script_hash: "test-hash".into(),
            started_at: 1,
            ended_at: None,
            outcome: None,
            reason: None,
            summary: None,
            steps: Vec::new(),
        };
        super::super::write_run_record(&run_directory, &record).unwrap();
        let sdk_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sdk")
            .join("python");
        let script = sdk_dir.join("examples").join("steps.py");
        let mut child = Command::new("uv")
            .arg("run")
            .arg("--script")
            .arg(&script)
            .current_dir(&project.root)
            .env("PYTHONPATH", &sdk_dir)
            .env("CAIRN_RUN_ID", run_id)
            .env("CAIRN_API_VERSION", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("uv must be installed to run the ignored integration test");
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut input = child.stdin.take().unwrap();
        let context = RpcContext {
            run_id: run_id.into(),
            task_id: task.id.clone(),
            workflow: "steps".into(),
            project: project.clone(),
            finish: Arc::new(Mutex::new(None)),
            record: Arc::new(Mutex::new(record)),
            run_directory: run_directory.clone(),
            sink: Arc::new(sink),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: run_directory.join("trace.jsonl"),
        };
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let response = handle_line(&context, line.trim_end());
            serde_json::to_writer(&mut input, &response).unwrap();
            input.write_all(b"\n").unwrap();
            input.flush().unwrap();
        }
        drop(input);
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "workflow failed: {stderr}");
        assert_eq!(
            context.finish.lock().unwrap().as_ref().unwrap().outcome,
            RunOutcome::Failed
        );
        let first_run_task = project.tasks.get(&task.id).unwrap();
        assert_eq!(
            first_run_task
                .sub_tasks
                .as_ref()
                .unwrap()
                .iter()
                .map(|item| item.status)
                .collect::<Vec<_>>(),
            [
                TaskStatus::NeedsReview,
                TaskStatus::Failed,
                TaskStatus::Ready
            ]
        );
        {
            let mut record = context.record.lock().unwrap();
            record.ended_at = Some(now_ms());
            record.outcome = Some(RunOutcome::Failed);
            record.reason = Some("Step failed: second".into());
            super::super::write_run_record(&run_directory, &record).unwrap();
        }
        let failed_task = project
            .tasks
            .set_status(
                &task.id,
                TaskStatus::Failed,
                first_run_task.rev,
                Actor::System,
            )
            .unwrap();
        let ready_task = project
            .tasks
            .set_status(&task.id, TaskStatus::Ready, failed_task.rev, Actor::Ui)
            .unwrap();
        let retry_id = "integration-retry";
        let retry_task = project
            .tasks
            .start_with_run(&task.id, ready_task.rev, retry_id.into(), Actor::Ui)
            .unwrap();
        let retry_dir = project.root.join(".cairn/runs").join(retry_id);
        let retry_record = super::super::RunRecord {
            run_id: retry_id.into(),
            task_id: task.id.clone(),
            workflow: "steps".into(),
            source: super::super::workflows::WorkflowSource::Project,
            script_hash: "test-hash".into(),
            started_at: 3,
            ended_at: None,
            outcome: None,
            reason: None,
            summary: None,
            steps: Vec::new(),
        };
        super::super::write_run_record(&retry_dir, &retry_record).unwrap();
        let retry_context = RpcContext {
            run_id: retry_id.into(),
            task_id: task.id,
            workflow: "steps".into(),
            project: project.clone(),
            finish: Arc::new(Mutex::new(None)),
            record: Arc::new(Mutex::new(retry_record)),
            run_directory: retry_dir,
            sink: Arc::new(NoopSink),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: project
                .root
                .join(".cairn/runs/integration-retry/trace.jsonl"),
        };
        let result =
            dispatch(&retry_context, request(20, "run.context", json!({})))["result"].clone();
        assert_eq!(
            result["resume"]["pending"],
            json!([
                {"id":step_ids[1],"title":"FAIL: second","status":"failed"},
                {"id":step_ids[2],"title":"third","status":"ready"}
            ])
        );
        assert_eq!(result["previous"]["outcome"], "failed");
        assert_eq!(retry_task.status, TaskStatus::Running);
    }
}
