pub mod files;
pub mod rpc;
pub mod workflows;

use crate::services::{
    models::{ModelBroker, ModelCallControl, Registry},
    project::{ProjectServices, ProjectState},
    service_error::{
        now_ms, Actor, ChangeEvent, EventSink, RunOutcome, ServiceError, ServiceErrorCode,
    },
    storage::ensure_cairn_dir,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const DEFAULT_FINISH_GRACE: Duration = Duration::from_secs(5);
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_WORKFLOW: &str = "default";

#[derive(Debug, Clone)]
pub struct RunContext {
    pub run_id: String,
    pub task_id: String,
    pub workflow: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    pub task_id: String,
    pub workflow: String,
    pub source: workflows::WorkflowSource,
    pub script_hash: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RunOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub steps: Vec<RunStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    pub subtask_id: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RunOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(crate) fn recover_interrupted_runs(
    root: &Path,
    tasks: &super::task_service::TaskService,
    sink: &dyn EventSink,
) {
    let runs_directory = root.join(".cairn").join("runs");
    let entries = match fs::read_dir(&runs_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(error) => {
            tauri_plugin_log::log::error!(
                "Could not scan interrupted runs in {}: {error}",
                runs_directory.display()
            );
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Could not inspect run directory in {}: {error}",
                    runs_directory.display()
                );
                continue;
            }
        };
        let run_directory = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Could not inspect run directory {}: {error}",
                    run_directory.display()
                );
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        let run_path = run_directory.join("run.json");
        let bytes = match fs::read(&run_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Could not read run metadata {}: {error}",
                    run_path.display()
                );
                continue;
            }
        };
        let mut record: RunRecord = match serde_json::from_slice(&bytes) {
            Ok(record) => record,
            Err(error) => {
                tauri_plugin_log::log::error!(
                    "Skipping malformed run metadata {}: {error}",
                    run_path.display()
                );
                continue;
            }
        };
        if record.ended_at.is_some() {
            continue;
        }
        let open_steps = record
            .steps
            .iter_mut()
            .filter(|step| step.ended_at.is_none())
            .map(|step| {
                step.ended_at = Some(now_ms());
                step.outcome = Some(RunOutcome::Failed);
                step.reason = Some("interrupted".into());
                (step.subtask_id.clone(), step.summary.clone())
            })
            .collect::<Vec<_>>();
        for (subtask_id, _) in &open_steps {
            if let Err(error) = tasks.set_subtask_status(
                &record.task_id,
                subtask_id,
                crate::types::task::TaskStatus::Failed,
                Actor::System,
            ) {
                if error.code != ServiceErrorCode::NotFound {
                    tauri_plugin_log::log::error!(
                        "Could not recover interrupted subtask {subtask_id} in run {}: {error}",
                        record.run_id
                    );
                }
            }
        }
        record.ended_at = Some(now_ms());
        record.outcome = Some(RunOutcome::Failed);
        record.reason = Some("interrupted (app closed during run)".into());
        if let Err(error) = write_run_record(&run_directory, &record) {
            tauri_plugin_log::log::error!(
                "Could not recover interrupted run metadata {}: {error}",
                run_path.display()
            );
        }
        for (subtask_id, summary) in open_steps {
            sink.emit(ChangeEvent::RunStep {
                run_id: record.run_id.clone(),
                task_id: record.task_id.clone(),
                subtask_id,
                status: crate::types::task::TaskStatus::Failed,
                summary,
                reason: Some("interrupted".into()),
            });
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub script: PathBuf,
    pub root: PathBuf,
    pub sdk_dir: PathBuf,
    pub run_id: String,
}

pub trait ChildProcess: Send {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>>;
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>>;
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
    fn kill(&mut self) -> io::Result<()>;
}

pub trait ChildLauncher: Send + Sync {
    fn spawn(&self, config: &LaunchConfig) -> io::Result<Box<dyn ChildProcess>>;
}

struct SystemLauncher;

impl ChildLauncher for SystemLauncher {
    fn spawn(&self, config: &LaunchConfig) -> io::Result<Box<dyn ChildProcess>> {
        let mut command = Command::new("uv");
        command
            .arg("run")
            .arg("--script")
            .arg(&config.script)
            .current_dir(&config.root)
            .env("PYTHONPATH", &config.sdk_dir)
            .env("CAIRN_RUN_ID", &config.run_id)
            .env("CAIRN_API_VERSION", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let process_tree = match WindowsJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        #[cfg(unix)]
        let process_tree = UnixProcessGroup { id: child.id() };
        Ok(Box::new(SystemChild {
            child,
            process_tree,
        }))
    }
}

struct SystemChild {
    child: Child,
    process_tree: PlatformProcessTree,
}

#[cfg(windows)]
type PlatformProcessTree = WindowsJob;
#[cfg(unix)]
type PlatformProcessTree = UnixProcessGroup;

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// An owned kernel handle is valid to transfer to the run waiter thread.
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &Child) -> io::Result<Self> {
        use std::{mem, os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                mem::size_of_val(&limits) as u32,
            ) != 0;
            let assigned = configured
                && AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) != 0;
            if !assigned {
                let error = io::Error::last_os_error();
                let _ = CloseHandle(handle);
                return Err(error);
            }
            Ok(Self(handle))
        }
    }

    fn kill(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
struct UnixProcessGroup {
    id: u32,
}

#[cfg(unix)]
impl UnixProcessGroup {
    fn kill(&self) -> io::Result<()> {
        if unsafe { libc::kill(-(self.id as i32), libc::SIGKILL) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for UnixProcessGroup {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

impl ChildProcess for SystemChild {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.child.stdin.take().map(|stdin| Box::new(stdin) as _)
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child.stdout.take().map(|stdout| Box::new(stdout) as _)
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child.stderr.take().map(|stderr| Box::new(stderr) as _)
    }
    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        self.child
            .try_wait()
            .map(|status| status.map(|value| value.code().unwrap_or(1)))
    }
    fn kill(&mut self) -> io::Result<()> {
        let tree_result = self.process_tree.kill();
        let child_result = self.child.kill();
        match (tree_result, child_result) {
            (Ok(()), _) | (_, Ok(())) => Ok(()),
            (Err(tree_error), Err(child_error)) => Err(io::Error::new(
                io::ErrorKind::Other,
                format!("process tree kill failed: {tree_error}; child kill failed: {child_error}"),
            )),
        }
    }
}

struct ManagerState {
    starting: bool,
    cancel_requested: bool,
    cancel_reason: Option<String>,
    active: Option<Arc<RunControl>>,
    last: Option<RunRecord>,
}

struct ManagerInner {
    state: Mutex<ManagerState>,
    launcher: Arc<dyn ChildLauncher>,
    timeout: Duration,
    finish_grace: Duration,
    trust_data_dir: Option<PathBuf>,
    manifest_dir: PathBuf,
    resource_dir: Option<PathBuf>,
}

struct RunControl {
    record: Arc<Mutex<RunRecord>>,
    project: Arc<ProjectServices>,
    child: Mutex<Box<dyn ChildProcess>>,
    finish: Arc<Mutex<Option<rpc::FinishRequest>>>,
    stop_reason: Mutex<Option<String>>,
    model_calls: Arc<ModelCallControl>,
    kill_requested: AtomicBool,
    finalized: AtomicBool,
    run_directory: PathBuf,
    sink: Arc<dyn EventSink>,
}

pub struct RunManager {
    inner: Arc<ManagerInner>,
}

struct StartingGuard {
    inner: Arc<ManagerInner>,
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.starting = false;
        if state.active.is_none() {
            state.cancel_requested = false;
            state.cancel_reason = None;
        }
    }
}

impl Drop for RunManager {
    fn drop(&mut self) {
        if let Err(error) = self.run_cancel() {
            tauri_plugin_log::log::error!(
                "Could not stop workflow during manager shutdown: {error}"
            );
        }
    }
}

impl Default for RunManager {
    fn default() -> Self {
        Self::with_options(
            Arc::new(SystemLauncher),
            DEFAULT_RUN_TIMEOUT,
            None,
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            None,
        )
    }
}

impl RunManager {
    pub fn with_resource_dir(resource_dir: Option<PathBuf>) -> Self {
        Self::with_runtime_dirs(resource_dir, None)
    }

    pub fn with_runtime_dirs(
        resource_dir: Option<PathBuf>,
        trust_data_dir: Option<PathBuf>,
    ) -> Self {
        Self::with_options(
            Arc::new(SystemLauncher),
            DEFAULT_RUN_TIMEOUT,
            trust_data_dir,
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            resource_dir,
        )
    }

    pub fn with_options(
        launcher: Arc<dyn ChildLauncher>,
        timeout: Duration,
        trust_data_dir: Option<PathBuf>,
        manifest_dir: PathBuf,
        resource_dir: Option<PathBuf>,
    ) -> Self {
        Self::with_options_and_grace(
            launcher,
            timeout,
            DEFAULT_FINISH_GRACE,
            trust_data_dir,
            manifest_dir,
            resource_dir,
        )
    }

    pub fn with_options_and_grace(
        launcher: Arc<dyn ChildLauncher>,
        timeout: Duration,
        finish_grace: Duration,
        trust_data_dir: Option<PathBuf>,
        manifest_dir: PathBuf,
        resource_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                state: Mutex::new(ManagerState {
                    starting: false,
                    cancel_requested: false,
                    cancel_reason: None,
                    active: None,
                    last: None,
                }),
                launcher,
                timeout,
                finish_grace,
                trust_data_dir,
                manifest_dir,
                resource_dir,
            }),
        }
    }

    pub fn run_start(
        &self,
        projects: &ProjectState,
        task_id: String,
        expected_rev: u64,
        workflow_name: Option<String>,
        sink: Arc<dyn EventSink>,
    ) -> Result<RunRecord, ServiceError> {
        self.run_start_with_registry(
            projects,
            task_id,
            expected_rev,
            workflow_name,
            Arc::new(Registry::default()),
            sink,
        )
    }

    pub fn run_start_with_registry(
        &self,
        projects: &ProjectState,
        task_id: String,
        expected_rev: u64,
        workflow_name: Option<String>,
        registry: Arc<Registry>,
        sink: Arc<dyn EventSink>,
    ) -> Result<RunRecord, ServiceError> {
        self.run_start_with_registry_hooks(
            projects,
            task_id,
            expected_rev,
            workflow_name,
            registry,
            sink,
            || Ok(()),
            || {},
        )
    }

    fn run_start_with_hooks(
        &self,
        projects: &ProjectState,
        task_id: String,
        expected_rev: u64,
        workflow_name: Option<String>,
        sink: Arc<dyn EventSink>,
        after_spawn: impl FnOnce() -> Result<(), ServiceError>,
        before_active: impl FnOnce(),
    ) -> Result<RunRecord, ServiceError> {
        self.run_start_with_registry_hooks(
            projects,
            task_id,
            expected_rev,
            workflow_name,
            Arc::new(Registry::default()),
            sink,
            after_spawn,
            before_active,
        )
    }

    fn run_start_with_registry_hooks(
        &self,
        projects: &ProjectState,
        task_id: String,
        expected_rev: u64,
        workflow_name: Option<String>,
        registry: Arc<Registry>,
        sink: Arc<dyn EventSink>,
        after_spawn: impl FnOnce() -> Result<(), ServiceError>,
        before_active: impl FnOnce(),
    ) -> Result<RunRecord, ServiceError> {
        let project = projects.services()?;
        {
            let mut state = self.lock_state()?;
            if state.active.is_some() || state.starting {
                return Err(ServiceError::new(
                    ServiceErrorCode::RunActive,
                    "A workflow run is already active",
                ));
            }
            state.starting = true;
            state.cancel_requested = false;
            state.cancel_reason = None;
        }
        let _starting = StartingGuard {
            inner: self.inner.clone(),
        };
        self.start_reserved(
            project,
            task_id,
            expected_rev,
            workflow_name.unwrap_or_else(|| DEFAULT_WORKFLOW.into()),
            registry,
            sink,
            after_spawn,
            before_active,
        )
    }

    fn start_reserved(
        &self,
        project: Arc<ProjectServices>,
        task_id: String,
        expected_rev: u64,
        workflow_name: String,
        registry: Arc<Registry>,
        sink: Arc<dyn EventSink>,
        after_spawn: impl FnOnce() -> Result<(), ServiceError>,
        before_active: impl FnOnce(),
    ) -> Result<RunRecord, ServiceError> {
        let workflow = workflows::resolve_with_sources(
            &project.root,
            &workflow_name,
            self.inner.trust_data_dir.as_deref(),
            self.bundled_workflows_dir().as_deref(),
        )?;
        workflows::require_trust(&project.root, &workflow)?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let task =
            project
                .tasks
                .start_with_run(&task_id, expected_rev, run_id.clone(), Actor::Ui)?;
        let run_directory = project.root.join(".cairn").join("runs").join(&run_id);
        if let Err(error) =
            ensure_cairn_dir(&project.root).and_then(|_| fs::create_dir_all(&run_directory))
        {
            fail_running_task(
                &project,
                &task.id,
                &format!("Could not create run directory: {error}"),
            );
            return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
        }
        let record = RunRecord {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            workflow: workflow_name.clone(),
            source: workflow.source,
            script_hash: workflow.script_hash.clone(),
            started_at: now_ms(),
            ended_at: None,
            outcome: None,
            reason: None,
            summary: None,
            steps: Vec::new(),
        };
        if let Err(error) = write_run_record(&run_directory, &record) {
            fail_running_task(
                &project,
                &task.id,
                &format!("Could not write run metadata: {error}"),
            );
            return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
        }
        let Some(sdk_dir) = sdk_dir(
            cfg!(debug_assertions),
            &self.inner.manifest_dir,
            self.inner.resource_dir.as_deref(),
        ) else {
            let reason = "Python SDK resource is unavailable".to_owned();
            return Err(self.fail_start(
                &project,
                &run_directory,
                record,
                reason,
                ServiceErrorCode::RuntimeUnavailable,
                sink,
            ));
        };
        if !sdk_dir.is_dir() {
            let reason = format!("Python SDK directory is unavailable: {}", sdk_dir.display());
            return Err(self.fail_start(
                &project,
                &run_directory,
                record,
                reason,
                ServiceErrorCode::RuntimeUnavailable,
                sink,
            ));
        }
        let verified_workflow = match workflows::resolve_with_sources(
            &project.root,
            &workflow_name,
            self.inner.trust_data_dir.as_deref(),
            self.bundled_workflows_dir().as_deref(),
        ) {
            Ok(workflow) => workflow,
            Err(error) => {
                return Err(self.fail_start(
                    &project,
                    &run_directory,
                    record,
                    error.message,
                    error.code,
                    sink,
                ));
            }
        };
        if let Err(error) = workflows::require_trust(&project.root, &verified_workflow) {
            return Err(self.fail_start(
                &project,
                &run_directory,
                record,
                error.message,
                error.code,
                sink,
            ));
        }
        let mut record = record;
        record.source = verified_workflow.source;
        record.script_hash = verified_workflow.script_hash.clone();
        if let Err(error) = write_run_record(&run_directory, &record) {
            return Err(self.fail_start(
                &project,
                &run_directory,
                record,
                format!("Could not write run metadata: {error}"),
                ServiceErrorCode::Io,
                sink,
            ));
        }
        let launch = LaunchConfig {
            script: verified_workflow.path,
            root: project.root.clone(),
            sdk_dir,
            run_id: run_id.clone(),
        };
        let mut child = match self.inner.launcher.spawn(&launch) {
            Ok(child) => child,
            Err(error) => {
                let reason = format!("Could not start uv: {error}");
                return Err(self.fail_start(
                    &project,
                    &run_directory,
                    record,
                    reason,
                    ServiceErrorCode::RuntimeUnavailable,
                    sink,
                ));
            }
        };
        if let Err(error) = after_spawn() {
            return Err(self.fail_spawned_child(
                child.as_mut(),
                &project,
                &run_directory,
                record,
                error.message,
                error.code,
                sink,
            ));
        }
        let Some(stdin) = child.take_stdin() else {
            return Err(self.fail_spawned_child(
                child.as_mut(),
                &project,
                &run_directory,
                record,
                "Workflow process has no stdin pipe".into(),
                ServiceErrorCode::RuntimeUnavailable,
                sink,
            ));
        };
        let Some(stdout) = child.take_stdout() else {
            return Err(self.fail_spawned_child(
                child.as_mut(),
                &project,
                &run_directory,
                record,
                "Workflow process has no stdout pipe".into(),
                ServiceErrorCode::RuntimeUnavailable,
                sink,
            ));
        };
        let Some(stderr) = child.take_stderr() else {
            return Err(self.fail_spawned_child(
                child.as_mut(),
                &project,
                &run_directory,
                record,
                "Workflow process has no stderr pipe".into(),
                ServiceErrorCode::RuntimeUnavailable,
                sink,
            ));
        };
        let finish = Arc::new(Mutex::new(None));
        let model_calls = Arc::new(ModelCallControl::default());
        let models = Arc::new(ModelBroker::with_default_client(
            registry,
            model_calls.clone(),
            run_directory.clone(),
        ));
        let control = Arc::new(RunControl {
            record: Arc::new(Mutex::new(record.clone())),
            project: project.clone(),
            child: Mutex::new(child),
            finish: finish.clone(),
            stop_reason: Mutex::new(None),
            model_calls,
            kill_requested: AtomicBool::new(false),
            finalized: AtomicBool::new(false),
            run_directory: run_directory.clone(),
            sink: sink.clone(),
        });
        before_active();
        let cancel_reason = {
            let mut state = self.lock_state()?;
            state.starting = false;
            state.active = Some(control.clone());
            if state.cancel_requested {
                state.cancel_requested = false;
                state.cancel_reason.take()
            } else {
                None
            }
        };
        if let Some(reason) = cancel_reason {
            if let Err(error) = terminate(&control, &reason) {
                tauri_plugin_log::log::error!(
                    "Could not terminate workflow requested during startup: {error}"
                );
            }
        }
        sink.emit(ChangeEvent::RunStarted {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            workflow: workflow_name.clone(),
        });
        let rpc_context = Arc::new(rpc::RpcContext {
            run_id: record.run_id.clone(),
            task_id: task_id.clone(),
            workflow: workflow_name,
            project,
            finish,
            record: control.record.clone(),
            run_directory: run_directory.clone(),
            sink: sink.clone(),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: run_directory.join("trace.jsonl"),
            models,
        });
        spawn_rpc_reader(stdout, stdin, rpc_context, control.clone());
        spawn_log_reader(stderr, run_directory.join("run.log"), run_id, task_id, sink);
        spawn_waiter(
            self.inner.clone(),
            control,
            self.inner.timeout,
            self.inner.finish_grace,
        );
        Ok(record)
    }

    fn fail_start(
        &self,
        project: &ProjectServices,
        run_directory: &Path,
        mut record: RunRecord,
        reason: String,
        code: ServiceErrorCode,
        sink: Arc<dyn EventSink>,
    ) -> ServiceError {
        fail_running_task(project, &record.task_id, &reason);
        record.ended_at = Some(now_ms());
        record.outcome = Some(RunOutcome::Failed);
        record.reason = Some(reason.clone());
        if let Err(error) = write_run_record(run_directory, &record) {
            tauri_plugin_log::log::error!("Could not persist failed run metadata: {error}");
        }
        sink.emit(ChangeEvent::RunFinished {
            run_id: record.run_id.clone(),
            task_id: record.task_id.clone(),
            outcome: RunOutcome::Failed,
            reason: Some(reason.clone()),
        });
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last = Some(record);
        ServiceError::new(code, reason)
    }

    fn fail_spawned_child(
        &self,
        child: &mut dyn ChildProcess,
        project: &ProjectServices,
        run_directory: &Path,
        record: RunRecord,
        reason: String,
        code: ServiceErrorCode,
        sink: Arc<dyn EventSink>,
    ) -> ServiceError {
        if let Err(error) = child.kill() {
            tauri_plugin_log::log::error!(
                "Could not kill workflow process after startup failure: {error}"
            );
        }
        self.fail_start(project, run_directory, record, reason, code, sink)
    }

    pub fn run_cancel(&self) -> Result<(), ServiceError> {
        let control = {
            let mut state = self.lock_state()?;
            if state.starting {
                state.cancel_requested = true;
                state.cancel_reason = Some("cancelled".into());
            }
            state.active.clone()
        };
        if let Some(control) = control {
            terminate(&control, "cancelled")?;
        }
        Ok(())
    }

    pub fn cancel_for_project_change(&self, reason: &str) -> Result<(), ServiceError> {
        let control = {
            let mut state = self.lock_state()?;
            if state.starting {
                state.cancel_requested = true;
                state.cancel_reason = Some(reason.to_owned());
            }
            state.active.clone()
        };
        if let Some(control) = control {
            terminate(&control, reason)?;
        }
        Ok(())
    }

    pub fn run_get(&self) -> Result<Option<RunRecord>, ServiceError> {
        let state = self.lock_state()?;
        if let Some(active) = &state.active {
            return Ok(Some(
                active
                    .record
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone(),
            ));
        }
        Ok(state.last.clone())
    }

    pub fn run_get_by_id(
        &self,
        projects: &ProjectState,
        run_id: &str,
    ) -> Result<RunRecord, ServiceError> {
        validate_run_id(run_id)?;
        {
            let state = self.lock_state()?;
            if let Some(active) = &state.active {
                let record = active
                    .record
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                if record.run_id == run_id {
                    return Ok(record);
                }
            }
        }

        let project = projects.services()?;
        let path = project
            .root
            .join(".cairn")
            .join("runs")
            .join(run_id)
            .join("run.json");
        let bytes = fs::read(&path).map_err(|error| {
            let code = if error.kind() == io::ErrorKind::NotFound {
                ServiceErrorCode::NotFound
            } else {
                ServiceErrorCode::Io
            };
            ServiceError::new(code, error.to_string())
        })?;
        let record: RunRecord = serde_json::from_slice(&bytes)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Corrupt, error.to_string()))?;
        if record.run_id != run_id {
            return Err(ServiceError::new(
                ServiceErrorCode::Corrupt,
                "run id does not match directory name",
            ));
        }
        Ok(record)
    }

    pub fn run_list(
        &self,
        projects: &ProjectState,
        limit: u32,
    ) -> Result<Vec<RunRecord>, ServiceError> {
        let project = projects.services()?;
        let runs_directory = project.root.join(".cairn").join("runs");
        let entries = match fs::read_dir(&runs_directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
        };
        let mut records = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        "Could not inspect run directory in {}: {error}",
                        runs_directory.display()
                    );
                    continue;
                }
            };
            if !matches!(entry.file_type(), Ok(file_type) if file_type.is_dir()) {
                continue;
            }
            let run_path = entry.path().join("run.json");
            let bytes = match fs::read(&run_path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    tauri_plugin_log::log::error!(
                        "Could not read run metadata {}: {error}",
                        run_path.display()
                    );
                    continue;
                }
            };
            match serde_json::from_slice::<RunRecord>(&bytes) {
                Ok(record) => records.push(record),
                Err(error) => tauri_plugin_log::log::error!(
                    "Skipping malformed run metadata {}: {error}",
                    run_path.display()
                ),
            }
        }
        records.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });
        records.truncate(limit.clamp(1, 50) as usize);
        Ok(records)
    }

    pub fn run_log(
        &self,
        projects: &ProjectState,
        run_id: &str,
        max_lines: u32,
    ) -> Result<Vec<String>, ServiceError> {
        validate_run_id(run_id)?;
        let project = projects.services()?;
        let log_path = project
            .root
            .join(".cairn")
            .join("runs")
            .join(run_id)
            .join("run.log");
        match read_log_tail(&log_path, max_lines.clamp(1, 2000)) {
            Ok(lines) => Ok(lines),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
        }
    }

    pub fn patch_list(
        &self,
        projects: &ProjectState,
        run_id: Option<&str>,
    ) -> Result<Vec<crate::services::runs::files::PatchSummary>, ServiceError> {
        let run_id = match run_id {
            Some(run_id) => run_id.to_string(),
            None => {
                let state = self.lock_state()?;
                if let Some(active) = &state.active {
                    active
                        .record
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .run_id
                        .clone()
                } else if let Some(last) = &state.last {
                    last.run_id.clone()
                } else {
                    return Ok(Vec::new());
                }
            }
        };
        let project = projects.services()?;
        crate::services::runs::files::patch_list(&project, &run_id)
    }

    pub fn patch_get(
        &self,
        projects: &ProjectState,
        run_id: &str,
        patch_id: &str,
    ) -> Result<crate::services::runs::files::Patch, ServiceError> {
        crate::services::runs::files::patch_get(projects.services()?.as_ref(), run_id, patch_id)
    }

    pub fn patch_discard(
        &self,
        projects: &ProjectState,
        run_id: &str,
        patch_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<crate::services::runs::files::PatchSummary, ServiceError> {
        crate::services::runs::files::patch_discard(
            projects.services()?.as_ref(),
            run_id,
            patch_id,
            sink.as_ref(),
        )
    }

    pub fn patch_apply(
        &self,
        projects: &ProjectState,
        run_id: &str,
        patch_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<crate::services::runs::files::PatchSummary, ServiceError> {
        crate::services::runs::files::patch_apply(
            projects.services()?.as_ref(),
            run_id,
            patch_id,
            sink.as_ref(),
        )
    }

    pub fn workflow_list(
        &self,
        projects: &ProjectState,
    ) -> Result<Vec<workflows::WorkflowInfo>, ServiceError> {
        let project = projects.services()?;
        workflows::list_with_sources(
            &project.root,
            self.inner.trust_data_dir.as_deref(),
            self.bundled_workflows_dir().as_deref(),
        )
    }

    pub fn workspace_trust_status(
        &self,
        projects: &ProjectState,
    ) -> Result<workflows::WorkflowTrustStatus, ServiceError> {
        let project = projects.services()?;
        workflows::trust_status(&project.root, self.inner.trust_data_dir.as_deref())
    }

    pub fn workspace_trust(&self, projects: &ProjectState, hash: &str) -> Result<(), ServiceError> {
        let project = projects.services()?;
        workflows::trust(&project.root, hash, self.inner.trust_data_dir.as_deref())
    }

    pub fn workspace_trust_revoke(&self, projects: &ProjectState) -> Result<(), ServiceError> {
        let project = projects.services()?;
        workflows::revoke(&project.root, self.inner.trust_data_dir.as_deref())
    }

    fn bundled_workflows_dir(&self) -> Option<PathBuf> {
        workflows::bundled_workflows_dir(
            cfg!(debug_assertions),
            &self.inner.manifest_dir,
            self.inner.resource_dir.as_deref(),
        )
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, ManagerState>, ServiceError> {
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner()))
    }
}

pub fn sdk_dir(
    debug_build: bool,
    manifest_dir: &Path,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    if debug_build {
        Some(manifest_dir.join("..").join("sdk").join("python"))
    } else {
        resource_dir.map(|directory| directory.join("sdk").join("python"))
    }
}

fn validate_run_id(run_id: &str) -> Result<(), ServiceError> {
    if (1..=64).contains(&run_id.len())
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err(ServiceError::validation(
            "Run id must match [A-Za-z0-9-]{1,64}",
        ))
    }
}

fn read_log_tail(path: &Path, max_lines: u32) -> io::Result<Vec<String>> {
    const BLOCK_SIZE: u64 = 8192;

    let mut file = fs::File::open(path)?;
    let end = file.seek(SeekFrom::End(0))?;
    if end == 0 {
        return Ok(Vec::new());
    }

    let mut scan_end = end;
    let mut last_byte = [0];
    file.seek(SeekFrom::Start(end - 1))?;
    file.read_exact(&mut last_byte)?;
    if last_byte[0] == b'\n' {
        scan_end -= 1;
    }

    let mut start = 0;
    let mut cursor = scan_end;
    let mut delimiters = 0;
    let wanted = max_lines.clamp(1, 2000);
    let mut block = vec![0; BLOCK_SIZE as usize];
    while cursor > 0 && delimiters < wanted {
        let block_start = cursor.saturating_sub(BLOCK_SIZE);
        let block_len = (cursor - block_start) as usize;
        file.seek(SeekFrom::Start(block_start))?;
        file.read_exact(&mut block[..block_len])?;
        for (index, byte) in block[..block_len].iter().enumerate().rev() {
            if *byte == b'\n' {
                delimiters += 1;
                if delimiters == wanted {
                    start = block_start + index as u64 + 1;
                    break;
                }
            }
        }
        if delimiters == wanted {
            break;
        }
        cursor = block_start;
    }

    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((end - start) as usize);
    file.take(end - start).read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::to_owned)
        .collect())
}

fn write_run_record(directory: &Path, record: &RunRecord) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    fs::write(directory.join("run.json"), bytes)
}

fn fail_running_task(project: &ProjectServices, task_id: &str, reason: &str) {
    match project.tasks.get(task_id) {
        Ok(task) if task.status == crate::types::task::TaskStatus::Running => {
            if let Err(error) = project.tasks.set_status(
                task_id,
                crate::types::task::TaskStatus::Failed,
                task.rev,
                Actor::System,
            ) {
                tauri_plugin_log::log::error!(
                    "Could not fail task {task_id} after run start error ({reason}): {error}"
                );
            }
        }
        Ok(_) => {}
        Err(error) => tauri_plugin_log::log::error!(
            "Could not read task {task_id} after run start error ({reason}): {error}"
        ),
    }
}

fn terminate(control: &RunControl, reason: &str) -> Result<(), ServiceError> {
    control.model_calls.cancel();
    let mut stop_reason = control
        .stop_reason
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if stop_reason.is_none() {
        *stop_reason = Some(reason.to_owned());
    }
    drop(stop_reason);
    if !control.kill_requested.swap(true, Ordering::SeqCst) {
        let result = {
            let mut child = control
                .child
                .lock()
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            match child.kill() {
                Ok(()) => Ok(()),
                Err(kill_error) => match child.try_wait() {
                    Ok(Some(_)) => Ok(()),
                    Ok(None) => Err(kill_error),
                    Err(wait_error) => Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!("kill failed: {kill_error}; wait failed: {wait_error}"),
                    )),
                },
            }
        };
        if let Err(error) = result {
            control.kill_requested.store(false, Ordering::SeqCst);
            return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
        }
    }
    Ok(())
}

fn spawn_rpc_reader(
    mut stdout: Box<dyn Read + Send>,
    stdin: Box<dyn Write + Send>,
    context: Arc<rpc::RpcContext>,
    control: Arc<RunControl>,
) {
    let stdin = Arc::new(Mutex::new(stdin));
    thread::spawn(move || {
        let mut lines = rpc::LineBuffer::default();
        let mut bytes = [0u8; 8192];
        loop {
            let size = match stdout.read(&mut bytes) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) => {
                    tauri_plugin_log::log::error!("Workflow RPC stdout read failed: {error}");
                    let _ = terminate(&control, "RPC transport error");
                    break;
                }
            };
            for line in rpc::split_lines(&mut lines, &bytes[..size]) {
                let response = match line {
                    Ok(line) => rpc::handle_line(&context, &line),
                    Err(response) => {
                        rpc::append_trace(&context.trace_path, None, None, &response, 0);
                        response
                    }
                };
                let encoded = match serde_json::to_vec(&response) {
                    Ok(encoded) => encoded,
                    Err(error) => {
                        tauri_plugin_log::log::error!(
                            "Could not encode workflow RPC response: {error}"
                        );
                        continue;
                    }
                };
                let write_result = stdin
                    .lock()
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))
                    .and_then(|mut writer| {
                        writer.write_all(&encoded)?;
                        writer.write_all(b"\n")?;
                        writer.flush()
                    });
                if let Err(error) = write_result {
                    tauri_plugin_log::log::error!("Workflow RPC stdin write failed: {error}");
                    let _ = terminate(&control, "RPC transport error");
                    break;
                }
                if context.version_mismatch.load(Ordering::SeqCst) {
                    let _ = terminate(&control, "SDK API version mismatch");
                    break;
                }
            }
        }
    });
}

fn spawn_log_reader(
    mut stderr: Box<dyn Read + Send>,
    log_path: PathBuf,
    run_id: String,
    _task_id: String,
    sink: Arc<dyn EventSink>,
) {
    thread::spawn(move || {
        let mut log = match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(file) => Some(file),
            Err(error) => {
                tauri_plugin_log::log::error!("Could not create workflow log: {error}");
                None
            }
        };
        let mut logged_bytes = 0;
        if let Some(file) = log.as_ref() {
            match file.metadata() {
                Ok(metadata) => logged_bytes = metadata.len(),
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not inspect workflow log size: {error}");
                    log = None;
                }
            }
        }
        let mut pending = Vec::new();
        let mut batch_started = Instant::now();
        let mut partial = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let size = match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) => {
                    tauri_plugin_log::log::error!("Workflow stderr read failed: {error}");
                    break;
                }
            };
            let raw = &chunk[..size];
            if let Some(file) = log.as_mut() {
                let remaining = MAX_LOG_BYTES.saturating_sub(logged_bytes) as usize;
                let take = raw.len().min(remaining);
                if take > 0 {
                    if let Err(error) = file.write_all(&raw[..take]) {
                        tauri_plugin_log::log::error!("Could not append workflow log: {error}");
                        log = None;
                    } else {
                        logged_bytes += take as u64;
                    }
                }
            }
            for byte in raw {
                if *byte == b'\n' {
                    if partial.last() == Some(&b'\r') {
                        partial.pop();
                    }
                    pending.push(String::from_utf8_lossy(&partial).into_owned());
                    partial.clear();
                } else {
                    if partial.len() < MAX_LOG_BYTES as usize {
                        partial.push(*byte);
                    }
                }
            }
            if batch_started.elapsed() >= Duration::from_millis(200) && !pending.is_empty() {
                sink.emit(ChangeEvent::RunLog {
                    run_id: run_id.clone(),
                    lines: std::mem::take(&mut pending),
                });
                batch_started = Instant::now();
            }
        }
        if !partial.is_empty() {
            pending.push(String::from_utf8_lossy(&partial).into_owned());
        }
        if !pending.is_empty() {
            let interval = Duration::from_millis(200);
            if let Some(remaining) = interval.checked_sub(batch_started.elapsed()) {
                thread::sleep(remaining);
            }
            sink.emit(ChangeEvent::RunLog {
                run_id,
                lines: pending,
            });
        }
    });
}

fn spawn_waiter(
    inner: Arc<ManagerInner>,
    control: Arc<RunControl>,
    timeout: Duration,
    finish_grace: Duration,
) {
    thread::spawn(move || {
        let started = Instant::now();
        let mut finish_deadline = None;
        let exit_code = loop {
            let finish_received = control
                .finish
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some();
            if finish_received && finish_deadline.is_none() {
                finish_deadline = Some(Instant::now() + finish_grace);
            }
            let stop_reason = control
                .stop_reason
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if let Some(reason) = stop_reason {
                if !control.kill_requested.load(Ordering::SeqCst) {
                    if let Err(error) = terminate(&control, &reason) {
                        tauri_plugin_log::log::error!("Could not terminate workflow: {error}");
                    }
                }
            } else if let Some(deadline) = finish_deadline {
                if Instant::now() >= deadline && !control.kill_requested.load(Ordering::SeqCst) {
                    if let Err(error) = kill_process_tree(&control) {
                        tauri_plugin_log::log::error!(
                            "Could not terminate workflow after run.finish: {error}"
                        );
                    }
                }
            } else if started.elapsed() >= timeout {
                if let Err(error) = terminate(&control, "timeout") {
                    tauri_plugin_log::log::error!(
                        "Could not terminate timed-out workflow: {error}"
                    );
                }
            }
            let wait_result = match control.child.lock() {
                Ok(mut child) => child.try_wait(),
                Err(error) => Err(io::Error::new(io::ErrorKind::Other, error.to_string())),
            };
            match wait_result {
                Ok(Some(code)) => break code,
                Ok(None) => {}
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not wait for workflow process: {error}");
                    let _ = terminate(&control, &format!("process wait failed: {error}"));
                    break 1;
                }
            }
            thread::sleep(Duration::from_millis(50));
        };
        finalize(&inner, &control, exit_code);
    });
}

fn kill_process_tree(control: &RunControl) -> Result<(), ServiceError> {
    control.model_calls.cancel();
    if control.kill_requested.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = {
        let mut child = control
            .child
            .lock()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        match child.kill() {
            Ok(()) => Ok(()),
            Err(kill_error) => match child.try_wait() {
                Ok(Some(_)) => Ok(()),
                Ok(None) => Err(kill_error),
                Err(wait_error) => Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("kill failed: {kill_error}; wait failed: {wait_error}"),
                )),
            },
        }
    };
    result.map_err(|error| {
        control.kill_requested.store(false, Ordering::SeqCst);
        ServiceError::new(ServiceErrorCode::Io, error.to_string())
    })
}

fn finalize(inner: &ManagerInner, control: &Arc<RunControl>, exit_code: i32) {
    if control.finalized.swap(true, Ordering::SeqCst) {
        return;
    }
    finalize_after_guard(inner, control, exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        project::ProjectState,
        service_error::{NoopSink, RecordingSink, ServiceErrorCode},
    };
    use crate::types::task::{SubTask, TaskStatus};
    use std::{io::Cursor, sync::atomic::AtomicI32};
    use tempfile::tempdir;

    struct FakeState {
        exit_code: AtomicI32,
    }

    struct FakeChild(Arc<FakeState>);

    impl ChildProcess for FakeChild {
        fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
            Some(Box::new(io::sink()))
        }
        fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
            Some(Box::new(Cursor::new(Vec::<u8>::new())))
        }
        fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
            Some(Box::new(Cursor::new(Vec::<u8>::new())))
        }
        fn try_wait(&mut self) -> io::Result<Option<i32>> {
            let code = self.0.exit_code.load(Ordering::SeqCst);
            Ok((code >= 0).then_some(code))
        }
        fn kill(&mut self) -> io::Result<()> {
            self.0.exit_code.store(137, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeLauncher {
        state: Arc<FakeState>,
        fail: bool,
    }

    impl ChildLauncher for FakeLauncher {
        fn spawn(&self, _: &LaunchConfig) -> io::Result<Box<dyn ChildProcess>> {
            if self.fail {
                return Err(io::Error::new(io::ErrorKind::NotFound, "uv missing"));
            }
            Ok(Box::new(FakeChild(self.state.clone())))
        }
    }

    struct Harness {
        _root: tempfile::TempDir,
        _data: tempfile::TempDir,
        project: Arc<ProjectState>,
        task_id: String,
        manager: RunManager,
        fake: Arc<FakeState>,
        sink: RecordingSink,
    }

    fn harness(timeout: Duration, fail_spawn: bool) -> Harness {
        harness_with_grace(timeout, DEFAULT_FINISH_GRACE, fail_spawn)
    }

    fn harness_with_grace(timeout: Duration, finish_grace: Duration, fail_spawn: bool) -> Harness {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(workflow_dir.join("flow.py"), "pass").unwrap();
        let workflow = workflows::resolve_in(root.path(), "flow", Some(data.path())).unwrap();
        workflows::trust(root.path(), &workflow.script_hash, Some(data.path())).unwrap();
        let sink = RecordingSink::default();
        let project = Arc::new(ProjectState::default());
        project.open(root.path(), sink.clone()).unwrap();
        let task = project
            .services()
            .unwrap()
            .tasks
            .create(crate::types::task::TaskItem::new("task"))
            .unwrap();
        let fake = Arc::new(FakeState {
            exit_code: AtomicI32::new(-1),
        });
        let manager = RunManager::with_options_and_grace(
            Arc::new(FakeLauncher {
                state: fake.clone(),
                fail: fail_spawn,
            }),
            timeout,
            finish_grace,
            Some(data.path().to_path_buf()),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            None,
        );
        Harness {
            _root: root,
            _data: data,
            project,
            task_id: task.id,
            manager,
            fake,
            sink,
        }
    }

    #[test]
    fn run_list_sorts_limits_and_skips_corrupt_records() {
        let root = tempdir().unwrap();
        let project = ProjectState::default();
        project.open(root.path(), NoopSink).unwrap();
        let manager = RunManager::default();
        let runs_directory = root.path().join(".cairn/runs");

        for record in [
            RunRecord {
                run_id: "older".into(),
                task_id: "task-1".into(),
                workflow: "default".into(),
                source: workflows::WorkflowSource::Project,
                script_hash: "hash".into(),
                started_at: 10,
                ended_at: Some(11),
                outcome: Some(RunOutcome::NeedsReview),
                reason: None,
                summary: None,
                steps: Vec::new(),
            },
            RunRecord {
                run_id: "active".into(),
                task_id: "task-2".into(),
                workflow: "default".into(),
                source: workflows::WorkflowSource::Global,
                script_hash: "global-hash".into(),
                started_at: 30,
                ended_at: None,
                outcome: None,
                reason: None,
                summary: None,
                steps: Vec::new(),
            },
            RunRecord {
                run_id: "middle".into(),
                task_id: "task-3".into(),
                workflow: "other".into(),
                source: workflows::WorkflowSource::Project,
                script_hash: "hash".into(),
                started_at: 20,
                ended_at: Some(21),
                outcome: Some(RunOutcome::Failed),
                reason: Some("failure".into()),
                summary: Some("summary".into()),
                steps: Vec::new(),
            },
        ] {
            write_run_record(&runs_directory.join(&record.run_id), &record).unwrap();
        }
        let corrupt_directory = runs_directory.join("corrupt");
        fs::create_dir_all(&corrupt_directory).unwrap();
        fs::write(corrupt_directory.join("run.json"), "{").unwrap();

        let records = manager.run_list(&project, 50).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.run_id.as_str())
                .collect::<Vec<_>>(),
            ["active", "middle", "older"]
        );
        assert_eq!(
            manager
                .run_list(&project, 2)
                .unwrap()
                .iter()
                .map(|record| record.run_id.as_str())
                .collect::<Vec<_>>(),
            ["active", "middle"]
        );
        assert_eq!(
            serde_json::to_value(&records[0]).unwrap(),
            serde_json::json!({
                "runId": "active",
                "taskId": "task-2",
                "workflow": "default",
                "source": "global",
                "scriptHash": "global-hash",
                "startedAt": 30,
                "steps": []
            })
        );
    }

    #[test]
    fn run_log_reads_tail_validates_ids_and_clamps_limits() {
        let root = tempdir().unwrap();
        let project = ProjectState::default();
        project.open(root.path(), NoopSink).unwrap();
        let manager = RunManager::default();
        let log_directory = root.path().join(".cairn/runs/run-1");
        fs::create_dir_all(&log_directory).unwrap();
        let contents = (0..10_000)
            .map(|line| format!("line-{line}\n"))
            .collect::<String>();
        fs::write(log_directory.join("run.log"), contents).unwrap();

        assert_eq!(
            manager.run_log(&project, "run-1", 3).unwrap(),
            ["line-9997", "line-9998", "line-9999"]
        );
        assert_eq!(
            serde_json::to_value(manager.run_log(&project, "run-1", 2).unwrap()).unwrap(),
            serde_json::json!(["line-9998", "line-9999"])
        );
        assert_eq!(
            manager.run_log(&project, "run-1", 0).unwrap(),
            ["line-9999"]
        );
        let clamped = manager.run_log(&project, "run-1", 10_000).unwrap();
        assert_eq!(clamped.len(), 2000);
        assert_eq!(clamped.first().map(String::as_str), Some("line-8000"));
        assert_eq!(clamped.last().map(String::as_str), Some("line-9999"));

        fs::write(log_directory.join("empty.log"), "").unwrap();
        assert!(read_log_tail(&log_directory.join("empty.log"), 20)
            .unwrap()
            .is_empty());
        assert!(manager.run_log(&project, "missing", 20).unwrap().is_empty());

        let unopened_project = ProjectState::default();
        for invalid in [r"..\x".to_owned(), "../x".to_owned(), "x".repeat(65)] {
            assert_eq!(
                manager
                    .run_log(&unopened_project, &invalid, 10)
                    .unwrap_err()
                    .code,
                ServiceErrorCode::Validation
            );
        }
    }

    #[test]
    fn run_get_by_id_reads_finished_records_and_reports_invalid_or_missing_ids() {
        let root = tempdir().unwrap();
        let project = ProjectState::default();
        project.open(root.path(), NoopSink).unwrap();
        let manager = RunManager::default();
        let finished = RunRecord {
            run_id: "finished-run".into(),
            task_id: "task-1".into(),
            workflow: "default".into(),
            source: workflows::WorkflowSource::Project,
            script_hash: "hash".into(),
            started_at: 10,
            ended_at: Some(11),
            outcome: Some(RunOutcome::NeedsReview),
            reason: None,
            summary: None,
            steps: Vec::new(),
        };
        write_run_record(
            &root
                .path()
                .join(".cairn")
                .join("runs")
                .join(&finished.run_id),
            &finished,
        )
        .unwrap();

        assert_eq!(
            manager
                .run_get_by_id(&project, &finished.run_id)
                .unwrap()
                .run_id,
            finished.run_id
        );
        assert_eq!(
            manager
                .run_get_by_id(&project, "../invalid")
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        assert_eq!(
            manager
                .run_get_by_id(&project, "missing-run")
                .unwrap_err()
                .code,
            ServiceErrorCode::NotFound
        );
    }

    #[test]
    fn legacy_run_json_without_steps_deserializes_with_empty_steps() {
        let legacy = serde_json::json!({
            "runId":"old-run",
            "taskId":"task-id",
            "workflow":"default",
            "source":"global",
            "scriptHash":"hash",
            "startedAt":1,
            "endedAt":2,
            "outcome":"needs_review"
        });
        let record: RunRecord = serde_json::from_value(legacy).unwrap();
        assert!(record.steps.is_empty());
    }

    fn start(harness: &Harness) -> Result<RunRecord, ServiceError> {
        let task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        harness.manager.run_start(
            &harness.project,
            task.id,
            task.rev,
            Some("flow".into()),
            Arc::new(harness.sink.clone()),
        )
    }

    fn wait_outcome(manager: &RunManager) -> RunRecord {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(record) = manager.run_get().unwrap() {
                if record.outcome.is_some() {
                    return record;
                }
            }
            assert!(Instant::now() < deadline, "run did not finalize");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_inactive(manager: &RunManager) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if manager.lock_state().unwrap().active.is_none() {
                return;
            }
            assert!(Instant::now() < deadline, "run did not become inactive");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn context_attempt(harness: &Harness, run: &RunRecord) -> serde_json::Value {
        let context = rpc::RpcContext {
            run_id: run.run_id.clone(),
            task_id: run.task_id.clone(),
            workflow: run.workflow.clone(),
            project: harness.project.services().unwrap(),
            finish: Arc::new(Mutex::new(None)),
            record: Arc::new(Mutex::new(run.clone())),
            run_directory: harness
                ._root
                .path()
                .join(".cairn")
                .join("runs")
                .join(&run.run_id),
            sink: Arc::new(NoopSink),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: harness._root.path().join("trace.jsonl"),
            models: Arc::new(ModelBroker::with_default_client(
                Arc::new(Registry::default()),
                Arc::new(ModelCallControl::default()),
                harness
                    ._root
                    .path()
                    .join(".cairn")
                    .join("runs")
                    .join(&run.run_id),
            )),
        };
        rpc::dispatch(
            &context,
            rpc::RpcRequest {
                id: serde_json::json!(1),
                method: "run.context".into(),
                params: serde_json::json!({}),
            },
        )["result"]["attempt"]
            .clone()
    }

    #[test]
    fn fake_launcher_run_context_reports_first_and_retry_attempts() {
        let harness = harness(Duration::from_secs(3), false);
        let first = start(&harness).unwrap();
        assert_eq!(context_attempt(&harness, &first), 1);
        harness.fake.exit_code.store(0, Ordering::SeqCst);
        wait_outcome(&harness.manager);
        wait_inactive(&harness.manager);

        let task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        harness
            .project
            .services()
            .unwrap()
            .tasks
            .set_status(
                &task.id,
                crate::types::task::TaskStatus::Ready,
                task.rev,
                Actor::Ui,
            )
            .unwrap();
        harness.fake.exit_code.store(-1, Ordering::SeqCst);

        let retry = start(&harness).unwrap();
        assert_eq!(context_attempt(&harness, &retry), 2);
        harness.manager.run_cancel().unwrap();
        wait_inactive(&harness.manager);
    }

    #[test]
    fn stale_revision_during_finalization_retries_once() {
        let h = harness(Duration::from_secs(3), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        let tasks = h.project.services().unwrap().tasks.clone();
        let task_id = h.task_id.clone();
        let mut bumped = false;
        finalize_after_guard_with_hook(&h.manager.inner, &control, 0, || {
            if !bumped {
                let task = tasks.get(&task_id).unwrap();
                tasks
                    .set_acceptance_criteria(&task_id, Some("concurrent update".into()), task.rev)
                    .unwrap();
                bumped = true;
            }
        });
        control.finalized.store(true, Ordering::SeqCst);
        h.fake.exit_code.store(0, Ordering::SeqCst);
        wait_inactive(&h.manager);

        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::NeedsReview
        );
        let run = h.manager.run_get().unwrap().unwrap();
        assert_eq!(run.outcome, Some(RunOutcome::NeedsReview));
        assert!(run.reason.is_none());
    }

    #[test]
    fn repeated_stale_revision_persists_task_update_failure_without_panicking() {
        let h = harness(Duration::from_secs(3), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        let tasks = h.project.services().unwrap().tasks.clone();
        let task_id = h.task_id.clone();
        let mut updates = 0;
        finalize_after_guard_with_hook(&h.manager.inner, &control, 0, || {
            updates += 1;
            let task = tasks.get(&task_id).unwrap();
            tasks
                .set_acceptance_criteria(
                    &task_id,
                    Some(format!("concurrent update {updates}")),
                    task.rev,
                )
                .unwrap();
        });
        control.finalized.store(true, Ordering::SeqCst);
        h.fake.exit_code.store(0, Ordering::SeqCst);
        wait_inactive(&h.manager);

        let run = h.manager.run_get().unwrap().unwrap();
        assert_eq!(updates, 2);
        assert!(run
            .reason
            .as_deref()
            .unwrap()
            .starts_with("could not update task:"));
        let path = h
            ._root
            .path()
            .join(".cairn/runs")
            .join(&run.run_id)
            .join("run.json");
        let persisted: RunRecord = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.reason, run.reason);
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Running
        );
    }

    #[test]
    fn poisoned_record_lock_does_not_prevent_cleanup_or_a_new_run() {
        let h = harness(Duration::from_secs(3), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        let record = control.clone();
        let poisoner = thread::spawn(move || {
            let _guard = record.record.lock().unwrap();
            panic!("poison run record lock");
        });
        assert!(poisoner.join().is_err());
        h.fake.exit_code.store(0, Ordering::SeqCst);
        wait_inactive(&h.manager);
        assert_eq!(
            h.manager.run_get().unwrap().unwrap().outcome,
            Some(RunOutcome::NeedsReview)
        );

        h.fake.exit_code.store(-1, Ordering::SeqCst);
        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        h.project
            .services()
            .unwrap()
            .tasks
            .set_status(
                &h.task_id,
                crate::types::task::TaskStatus::Ready,
                task.rev,
                Actor::Ui,
            )
            .unwrap();
        start(&h).unwrap();
        h.manager.run_cancel().unwrap();
        wait_inactive(&h.manager);
    }

    struct StartOnFinishedSink {
        manager: Arc<ManagerInner>,
        project: Arc<ProjectState>,
        attempted: AtomicBool,
        result: Mutex<Option<Result<(), ServiceErrorCode>>>,
    }

    impl EventSink for StartOnFinishedSink {
        fn emit(&self, event: ChangeEvent) {
            let ChangeEvent::RunFinished { task_id, .. } = event else {
                return;
            };
            if self.attempted.swap(true, Ordering::SeqCst) {
                return;
            }
            let project_services = self.project.services().unwrap();
            let task = project_services.tasks.get(&task_id).unwrap();
            project_services
                .tasks
                .set_status(
                    &task_id,
                    crate::types::task::TaskStatus::Ready,
                    task.rev,
                    Actor::Ui,
                )
                .unwrap();
            let task = project_services.tasks.get(&task_id).unwrap();
            let manager = RunManager {
                inner: self.manager.clone(),
            };
            let result = manager
                .run_start(
                    &self.project,
                    task_id,
                    task.rev,
                    Some("flow".into()),
                    Arc::new(NoopSink),
                )
                .map(|_| ())
                .map_err(|error| error.code);
            *self.result.lock().unwrap() = Some(result);
        }
    }

    fn active_rpc_context(harness: &Harness, run: &RunRecord) -> rpc::RpcContext {
        let control = harness
            .manager
            .lock_state()
            .unwrap()
            .active
            .clone()
            .unwrap();
        rpc::RpcContext {
            run_id: run.run_id.clone(),
            task_id: run.task_id.clone(),
            workflow: run.workflow.clone(),
            project: control.project.clone(),
            finish: control.finish.clone(),
            record: control.record.clone(),
            run_directory: control.run_directory.clone(),
            sink: control.sink.clone(),
            version_mismatch: Arc::new(AtomicBool::new(false)),
            trace_path: harness._root.path().join("trace.jsonl"),
            models: Arc::new(ModelBroker::with_default_client(
                Arc::new(Registry::default()),
                Arc::new(ModelCallControl::default()),
                control.run_directory.clone(),
            )),
        }
    }

    fn rpc_request(id: u64, method: &str, params: serde_json::Value) -> rpc::RpcRequest {
        rpc::RpcRequest {
            id: serde_json::json!(id),
            method: method.into(),
            params,
        }
    }

    #[test]
    fn fake_launcher_steps_fail_then_retry_resumes_unfinished_subtasks() {
        let harness = harness(Duration::from_secs(3), false);
        let mut task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        let mut subtasks = Vec::new();
        for title in ["first", "second", "third"] {
            let subtask = SubTask::new(title);
            task = harness
                .project
                .services()
                .unwrap()
                .tasks
                .add_subtask(&task.id, subtask, task.rev)
                .unwrap();
            subtasks.push(task.sub_tasks.as_ref().unwrap().last().unwrap().clone());
        }

        let first = start(&harness).unwrap();
        let context = active_rpc_context(&harness, &first);
        for (request_id, method, params) in [
            (
                1,
                "step.start",
                serde_json::json!({"subtaskId":subtasks[0].id}),
            ),
            (
                2,
                "step.finish",
                serde_json::json!({"subtaskId":subtasks[0].id,"outcome":"needs_review"}),
            ),
            (
                3,
                "step.start",
                serde_json::json!({"subtaskId":subtasks[1].id}),
            ),
            (
                4,
                "step.finish",
                serde_json::json!({"subtaskId":subtasks[1].id,"outcome":"failed","reason":"step 2 failed"}),
            ),
            (
                5,
                "run.finish",
                serde_json::json!({"outcome":"failed","reason":"step 2 failed"}),
            ),
        ] {
            let response = rpc::dispatch(&context, rpc_request(request_id, method, params));
            assert!(response.get("error").is_none(), "{response}");
        }
        harness.fake.exit_code.store(0, Ordering::SeqCst);
        let first_result = wait_outcome(&harness.manager);
        wait_inactive(&harness.manager);
        assert_eq!(first_result.outcome, Some(RunOutcome::Failed));
        let failed_task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        assert_eq!(failed_task.status, TaskStatus::Failed);
        assert_eq!(
            failed_task
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

        harness
            .project
            .services()
            .unwrap()
            .tasks
            .set_status(
                &harness.task_id,
                TaskStatus::Ready,
                failed_task.rev,
                Actor::Ui,
            )
            .unwrap();
        harness.fake.exit_code.store(-1, Ordering::SeqCst);
        let retry = start(&harness).unwrap();
        let retry_context = active_rpc_context(&harness, &retry);
        let resume = rpc::dispatch(
            &retry_context,
            rpc_request(6, "run.context", serde_json::json!({})),
        )["result"]["resume"]
            .clone();
        assert_eq!(
            resume["pending"],
            serde_json::json!([
                {"id":subtasks[1].id,"title":"second","status":"failed"},
                {"id":subtasks[2].id,"title":"third","status":"ready"}
            ])
        );
        assert_eq!(
            rpc::dispatch(
                &retry_context,
                rpc_request(7, "run.context", serde_json::json!({})),
            )["result"]["previous"]["outcome"],
            "failed"
        );
        harness.fake.exit_code.store(0, Ordering::SeqCst);
        wait_outcome(&harness.manager);
        wait_inactive(&harness.manager);
    }

    #[test]
    fn finalization_fails_running_subtask_and_closes_open_step() {
        let harness = harness(Duration::from_secs(3), false);
        let mut task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        let subtask = SubTask::new("unfinished");
        task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .add_subtask(&task.id, subtask.clone(), task.rev)
            .unwrap();
        let subtask = task.sub_tasks.as_ref().unwrap()[0].clone();

        let run = start(&harness).unwrap();
        let context = active_rpc_context(&harness, &run);
        let response = rpc::dispatch(
            &context,
            rpc_request(1, "step.start", serde_json::json!({"subtaskId":subtask.id})),
        );
        assert!(response.get("error").is_none());
        let control = harness
            .manager
            .lock_state()
            .unwrap()
            .active
            .clone()
            .unwrap();
        finalize_after_guard(&harness.manager.inner, &control, 9);
        control.finalized.store(true, Ordering::SeqCst);
        harness.fake.exit_code.store(0, Ordering::SeqCst);
        wait_inactive(&harness.manager);

        let finalized_task = harness
            .project
            .services()
            .unwrap()
            .tasks
            .get(&harness.task_id)
            .unwrap();
        assert_eq!(finalized_task.status, TaskStatus::Failed);
        assert_eq!(
            finalized_task.sub_tasks.as_ref().unwrap()[0].status,
            TaskStatus::Failed
        );
        let finalized_run: RunRecord = serde_json::from_slice(
            &fs::read(
                harness
                    ._root
                    .path()
                    .join(".cairn/runs")
                    .join(run.run_id)
                    .join("run.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            finalized_run.steps[0].reason.as_deref(),
            Some("step not finished")
        );
        assert_eq!(finalized_run.steps[0].outcome, Some(RunOutcome::Failed));
        assert_eq!(task.sub_tasks.unwrap()[0].status, TaskStatus::Ready);
    }

    #[test]
    fn run_finished_sink_can_start_another_run() {
        let h = harness(Duration::from_secs(3), false);
        let sink = Arc::new(StartOnFinishedSink {
            manager: h.manager.inner.clone(),
            project: h.project.clone(),
            attempted: AtomicBool::new(false),
            result: Mutex::new(None),
        });
        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        h.manager
            .run_start(
                &h.project,
                task.id,
                task.rev,
                Some("flow".into()),
                sink.clone(),
            )
            .unwrap();
        h.fake.exit_code.store(0, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if sink.result.lock().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "finish sink did not start a run");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*sink.result.lock().unwrap(), Some(Ok(())));
        wait_inactive(&h.manager);
    }

    #[test]
    fn run_finish_needs_review_is_applied_after_exit() {
        let h = harness(Duration::from_secs(3), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        *control.finish.lock().unwrap() = Some(rpc::FinishRequest {
            outcome: RunOutcome::NeedsReview,
            summary: Some("review".into()),
            reason: None,
        });
        h.fake.exit_code.store(0, Ordering::SeqCst);
        let record = wait_outcome(&h.manager);
        assert_eq!(record.outcome, Some(RunOutcome::NeedsReview));
        assert_eq!(record.summary.as_deref(), Some("review"));
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::NeedsReview
        );
    }

    #[test]
    fn run_finish_hang_is_killed_after_grace_and_keeps_requested_status() {
        let h = harness_with_grace(Duration::from_secs(3), Duration::from_millis(40), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        *control.finish.lock().unwrap() = Some(rpc::FinishRequest {
            outcome: RunOutcome::Failed,
            summary: Some("finished".into()),
            reason: Some("workflow requested failure".into()),
        });

        let record = wait_outcome(&h.manager);
        assert_eq!(record.outcome, Some(RunOutcome::Failed));
        assert_eq!(record.reason.as_deref(), Some("workflow requested failure"));
        assert_eq!(record.summary.as_deref(), Some("finished"));
        assert_eq!(h.fake.exit_code.load(Ordering::SeqCst), 137);
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Failed
        );
    }

    #[test]
    fn run_finish_outcome_wins_over_nonzero_process_exit() {
        let h = harness_with_grace(Duration::from_secs(3), Duration::from_millis(100), false);
        start(&h).unwrap();
        let control = h.manager.lock_state().unwrap().active.clone().unwrap();
        *control.finish.lock().unwrap() = Some(rpc::FinishRequest {
            outcome: RunOutcome::NeedsReview,
            summary: Some("ready for review".into()),
            reason: None,
        });
        h.fake.exit_code.store(1, Ordering::SeqCst);

        let record = wait_outcome(&h.manager);
        assert_eq!(record.outcome, Some(RunOutcome::NeedsReview));
        assert_eq!(record.summary.as_deref(), Some("ready for review"));
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::NeedsReview
        );
    }

    #[test]
    fn normal_exit_and_nonzero_exit_finalize_expected_status() {
        let normal = harness(Duration::from_secs(3), false);
        start(&normal).unwrap();
        normal.fake.exit_code.store(0, Ordering::SeqCst);
        assert_eq!(
            wait_outcome(&normal.manager).outcome,
            Some(RunOutcome::NeedsReview)
        );

        let failed = harness(Duration::from_secs(3), false);
        start(&failed).unwrap();
        failed.fake.exit_code.store(1, Ordering::SeqCst);
        let record = wait_outcome(&failed.manager);
        assert_eq!(record.outcome, Some(RunOutcome::Failed));
        assert_eq!(record.reason.as_deref(), Some("exit code 1"));
    }

    #[test]
    fn cancel_timeout_and_project_close_fail_the_run() {
        let cancelled = harness(Duration::from_secs(3), false);
        start(&cancelled).unwrap();
        cancelled.manager.run_cancel().unwrap();
        assert_eq!(
            wait_outcome(&cancelled.manager).reason.as_deref(),
            Some("cancelled")
        );

        let timed = harness(Duration::from_millis(30), false);
        start(&timed).unwrap();
        assert_eq!(
            wait_outcome(&timed.manager).reason.as_deref(),
            Some("timeout")
        );

        let closed = harness(Duration::from_secs(3), false);
        start(&closed).unwrap();
        closed
            .manager
            .cancel_for_project_change("project closed")
            .unwrap();
        assert_eq!(
            wait_outcome(&closed.manager).reason.as_deref(),
            Some("project closed")
        );
    }

    #[test]
    fn spawn_failure_fails_task_and_returns_runtime_error() {
        let h = harness(Duration::from_secs(3), true);
        assert_eq!(
            start(&h).unwrap_err().code,
            ServiceErrorCode::RuntimeUnavailable
        );
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Failed
        );
    }

    #[test]
    fn untrusted_or_edited_workflow_leaves_task_ready() {
        let h = harness(Duration::from_secs(3), false);
        fs::remove_file(h._data.path().join("workflow-trust.json")).unwrap();
        let error = start(&h).unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::TrustRequired);
        assert_eq!(
            error.message,
            "Workflows in this project are not trusted. Review them in Settings."
        );
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Ready
        );

        let workflow = workflows::resolve_in(h._root.path(), "flow", Some(h._data.path())).unwrap();
        workflows::trust(h._root.path(), &workflow.script_hash, Some(h._data.path())).unwrap();
        fs::write(
            h._root.path().join(".cairn/workflows/helper.py"),
            "VALUE = 1",
        )
        .unwrap();
        let error = start(&h).unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::TrustRequired);
        assert_eq!(
            error.message,
            "Workflows in this project are not trusted. Review them in Settings."
        );
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Ready
        );
    }

    #[test]
    fn bundled_and_global_runs_start_without_project_approval() {
        let layout = tempdir().unwrap();
        let manifest_dir = layout.path().join("repo").join("src-tauri");
        let sdk_dir = manifest_dir.join("..").join("sdk").join("python");
        let bundled_dir = sdk_dir.join("workflows");
        fs::create_dir_all(&bundled_dir).unwrap();
        let bundled_name = format!("bundled-{}", uuid::Uuid::new_v4().simple());
        fs::write(bundled_dir.join(format!("{bundled_name}.py")), "pass").unwrap();

        let global_name = format!("global-{}", uuid::Uuid::new_v4().simple());
        let global_dir = dirs::config_dir().unwrap().join("cairn").join("workflows");
        fs::create_dir_all(&global_dir).unwrap();
        let global_path = global_dir.join(format!("{global_name}.py"));
        fs::write(&global_path, "pass").unwrap();

        for (workflow_name, expected_source) in [
            (bundled_name.as_str(), workflows::WorkflowSource::Bundled),
            (global_name.as_str(), workflows::WorkflowSource::Global),
        ] {
            let root = tempdir().unwrap();
            let data = tempdir().unwrap();
            let projects = ProjectState::default();
            projects.open(root.path(), NoopSink).unwrap();
            let task = projects
                .services()
                .unwrap()
                .tasks
                .create(crate::types::task::TaskItem::new("trusted source"))
                .unwrap();
            let fake = Arc::new(FakeState {
                exit_code: AtomicI32::new(-1),
            });
            let manager = RunManager::with_options(
                Arc::new(FakeLauncher {
                    state: fake,
                    fail: false,
                }),
                Duration::from_secs(3),
                Some(data.path().to_path_buf()),
                manifest_dir.clone(),
                None,
            );
            let run = manager
                .run_start(
                    &projects,
                    task.id,
                    task.rev,
                    Some(workflow_name.into()),
                    Arc::new(NoopSink),
                )
                .unwrap();
            assert_eq!(run.source, expected_source);
            manager.run_cancel().unwrap();
            wait_inactive(&manager);
        }

        fs::remove_file(global_path).unwrap();
    }

    #[test]
    fn project_trust_commands_require_an_open_project() {
        let manager = RunManager::default();
        let projects = ProjectState::default();
        assert_eq!(
            manager.workspace_trust_status(&projects).unwrap_err().code,
            ServiceErrorCode::NoProject
        );
        assert_eq!(
            manager.workspace_trust(&projects, "hash").unwrap_err().code,
            ServiceErrorCode::NoProject
        );
        assert_eq!(
            manager.workspace_trust_revoke(&projects).unwrap_err().code,
            ServiceErrorCode::NoProject
        );
    }

    #[test]
    fn active_run_blocks_second_start_and_user_status_is_not_overwritten() {
        let h = harness(Duration::from_secs(3), false);
        start(&h).unwrap();
        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        assert_eq!(
            h.manager
                .run_start(
                    &h.project,
                    task.id.clone(),
                    task.rev,
                    Some("flow".into()),
                    Arc::new(h.sink.clone())
                )
                .unwrap_err()
                .code,
            ServiceErrorCode::RunActive
        );
        h.project
            .services()
            .unwrap()
            .tasks
            .complete(&h.task_id, task.rev)
            .unwrap();
        h.fake.exit_code.store(0, Ordering::SeqCst);
        wait_outcome(&h.manager);
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Completed
        );
    }

    #[test]
    fn failed_start_clears_a_poisoned_state_reservation() {
        let h = harness(Duration::from_secs(3), false);
        let inner = h.manager.inner.clone();
        let poisoner = thread::spawn(move || {
            let _state = inner.state.lock().unwrap();
            panic!("poison run manager state lock");
        });
        assert!(poisoner.join().is_err());

        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        assert_eq!(
            h.manager
                .run_start(
                    &h.project,
                    task.id.clone(),
                    task.rev,
                    Some("missing-workflow".into()),
                    Arc::new(h.sink.clone()),
                )
                .unwrap_err()
                .code,
            ServiceErrorCode::WorkflowNotFound
        );
        assert!(!h.manager.lock_state().unwrap().starting);

        start(&h).unwrap();
        assert!(h.manager.lock_state().unwrap().active.is_some());
        h.manager.run_cancel().unwrap();
        wait_inactive(&h.manager);
    }

    #[test]
    fn post_spawn_startup_error_kills_child_and_fails_task() {
        let h = harness(Duration::from_secs(3), false);
        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        let error = h
            .manager
            .run_start_with_hooks(
                &h.project,
                task.id,
                task.rev,
                Some("flow".into()),
                Arc::new(h.sink.clone()),
                || {
                    Err(ServiceError::new(
                        ServiceErrorCode::Io,
                        "forced error after spawn",
                    ))
                },
                || {},
            )
            .unwrap_err();

        assert_eq!(error.code, ServiceErrorCode::Io);
        assert_eq!(h.fake.exit_code.load(Ordering::SeqCst), 137);
        assert_eq!(
            h.project
                .services()
                .unwrap()
                .tasks
                .get(&h.task_id)
                .unwrap()
                .status,
            crate::types::task::TaskStatus::Failed
        );
        assert!(h.manager.lock_state().unwrap().active.is_none());
    }

    #[test]
    fn startup_cancel_and_project_close_are_applied_after_activation() {
        let cancelled = harness(Duration::from_secs(3), false);
        let task = cancelled
            .project
            .services()
            .unwrap()
            .tasks
            .get(&cancelled.task_id)
            .unwrap();
        cancelled
            .manager
            .run_start_with_hooks(
                &cancelled.project,
                task.id,
                task.rev,
                Some("flow".into()),
                Arc::new(cancelled.sink.clone()),
                || Ok(()),
                || cancelled.manager.run_cancel().unwrap(),
            )
            .unwrap();
        assert_eq!(
            wait_outcome(&cancelled.manager).reason.as_deref(),
            Some("cancelled")
        );

        let closed = harness(Duration::from_secs(3), false);
        let task = closed
            .project
            .services()
            .unwrap()
            .tasks
            .get(&closed.task_id)
            .unwrap();
        closed
            .manager
            .run_start_with_hooks(
                &closed.project,
                task.id,
                task.rev,
                Some("flow".into()),
                Arc::new(closed.sink.clone()),
                || Ok(()),
                || {
                    closed
                        .manager
                        .cancel_for_project_change("project closed")
                        .unwrap()
                },
            )
            .unwrap();
        assert_eq!(
            wait_outcome(&closed.manager).reason.as_deref(),
            Some("project closed")
        );
    }

    struct RunGetOnStartSink {
        manager: Arc<ManagerInner>,
        observed: Mutex<Option<RunRecord>>,
    }

    impl EventSink for RunGetOnStartSink {
        fn emit(&self, event: ChangeEvent) {
            let ChangeEvent::RunStarted { run_id, .. } = event else {
                return;
            };
            let manager = RunManager {
                inner: self.manager.clone(),
            };
            let record = manager.run_get().unwrap().unwrap();
            assert_eq!(record.run_id, run_id);
            *self.observed.lock().unwrap() = Some(record);
        }
    }

    #[test]
    fn run_started_sink_observes_the_active_run() {
        let h = harness(Duration::from_secs(3), false);
        let sink = Arc::new(RunGetOnStartSink {
            manager: h.manager.inner.clone(),
            observed: Mutex::new(None),
        });
        let task = h.project.services().unwrap().tasks.get(&h.task_id).unwrap();
        let run = h
            .manager
            .run_start(
                &h.project,
                task.id,
                task.rev,
                Some("flow".into()),
                sink.clone(),
            )
            .unwrap();

        let observed = sink.observed.lock().unwrap().clone().unwrap();
        assert_eq!(observed.run_id, run.run_id);
        assert!(observed.ended_at.is_none());
        h.manager.run_cancel().unwrap();
        wait_inactive(&h.manager);
    }

    #[test]
    #[ignore = "requires uv and a working Python runtime"]
    fn real_hello_workflow_runs_through_uv_and_the_sdk() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(
            workflow_dir.join("hello.py"),
            include_str!("../../../../sdk/python/examples/hello.py"),
        )
        .unwrap();
        let project_sink = RecordingSink::default();
        let projects = ProjectState::default();
        projects.open(root.path(), project_sink.clone()).unwrap();
        let task = projects
            .services()
            .unwrap()
            .tasks
            .create(crate::types::task::TaskItem::new("integration"))
            .unwrap();
        let workflow = workflows::resolve_in(root.path(), "hello", Some(data.path())).unwrap();
        workflows::trust(root.path(), &workflow.script_hash, Some(data.path())).unwrap();
        let manager = RunManager::with_options(
            Arc::new(SystemLauncher),
            Duration::from_secs(90),
            Some(data.path().to_path_buf()),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            None,
        );
        manager
            .run_start(
                &projects,
                task.id.clone(),
                task.rev,
                Some("hello".into()),
                Arc::new(project_sink),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        let record = loop {
            if let Some(record) = manager.run_get().unwrap() {
                if record.outcome.is_some() {
                    break record;
                }
            }
            assert!(Instant::now() < deadline, "real uv workflow did not finish");
            thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(record.outcome, Some(RunOutcome::NeedsReview));
        assert!(record.summary.unwrap().contains("integration"));
    }

    #[test]
    fn sdk_dir_selects_development_and_resource_locations() {
        let manifest = Path::new("repo/src-tauri");
        assert_eq!(
            sdk_dir(true, manifest, None).unwrap(),
            manifest.join("../sdk/python")
        );
        assert_eq!(
            sdk_dir(false, manifest, Some(Path::new("resources"))).unwrap(),
            Path::new("resources/sdk/python")
        );
        assert!(sdk_dir(false, manifest, None).is_none());
    }

    #[test]
    #[ignore = "requires uv and a working Python runtime"]
    fn cancelling_workflow_kills_its_python_process() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        let script = workflow_dir.join("sleepy.py");
        fs::write(
            &script,
            "# /// script\n# requires-python = \">=3.10\"\n# dependencies = []\n# ///\nimport cairn\nimport os, time\nprint(os.getpid(), flush=True)\ntime.sleep(120)\n",
        )
        .unwrap();
        let sink = RecordingSink::default();
        let project = ProjectState::default();
        project.open(root.path(), sink.clone()).unwrap();
        let task = project
            .services()
            .unwrap()
            .tasks
            .create(crate::types::task::TaskItem::new("sleeping integration"))
            .unwrap();
        let workflow = workflows::resolve_in(root.path(), "sleepy", Some(data.path())).unwrap();
        workflows::trust(root.path(), &workflow.script_hash, Some(data.path())).unwrap();
        let manager = RunManager::with_options(
            Arc::new(SystemLauncher),
            Duration::from_secs(180),
            Some(data.path().to_path_buf()),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            None,
        );
        let run = manager
            .run_start(
                &project,
                task.id,
                task.rev,
                Some("sleepy".into()),
                Arc::new(sink),
            )
            .unwrap();
        let log_path = root
            .path()
            .join(".cairn/runs")
            .join(&run.run_id)
            .join("run.log");
        let deadline = Instant::now() + Duration::from_secs(30);
        let pid = loop {
            if let Ok(log) = fs::read_to_string(&log_path) {
                if let Some(pid) = log.lines().find_map(|line| line.trim().parse::<u32>().ok()) {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "workflow did not print its PID; log={:?}, run={:?}",
                fs::read_to_string(&log_path),
                manager
                    .run_get()
                    .ok()
                    .flatten()
                    .map(|record| (record.outcome, record.reason))
            );
            thread::sleep(Duration::from_millis(100));
        };
        assert!(
            process_is_running(pid),
            "workflow exited before cancellation"
        );
        manager.run_cancel().unwrap();
        assert_eq!(wait_outcome(&manager).outcome, Some(RunOutcome::Failed));
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_is_running(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !process_is_running(pid),
            "workflow Python process survived cancel"
        );
    }

    #[cfg(windows)]
    fn process_is_running(pid: u32) -> bool {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, STILL_ACTIVE},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut exit_code = 0;
            let running = GetExitCodeProcess(process, &mut exit_code) != 0
                && exit_code == STILL_ACTIVE as u32;
            let _ = CloseHandle(process);
            running
        }
    }

    #[cfg(unix)]
    fn process_is_running(pid: u32) -> bool {
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

fn finalize_after_guard(inner: &ManagerInner, control: &Arc<RunControl>, exit_code: i32) {
    finalize_after_guard_with_hook(inner, control, exit_code, || {});
}

fn finalize_task_status(
    project: &ProjectServices,
    task_id: &str,
    status: crate::types::task::TaskStatus,
    actor: Actor,
    mut before_set: impl FnMut(),
) -> Result<Option<crate::types::task::TaskStatus>, ServiceError> {
    let mut task = project.tasks.get(task_id)?;
    if task.status != crate::types::task::TaskStatus::Running {
        return Ok(Some(task.status));
    }

    for attempt in 0..=1 {
        before_set();
        match project.tasks.set_status(task_id, status, task.rev, actor) {
            Ok(_) => return Ok(None),
            Err(error) if error.code == ServiceErrorCode::StaleRev && attempt == 0 => {
                task = project.tasks.get(task_id)?;
                if task.status != crate::types::task::TaskStatus::Running {
                    return Ok(Some(task.status));
                }
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("both status update attempts must return or fail")
}

fn finalize_after_guard_with_hook(
    inner: &ManagerInner,
    control: &Arc<RunControl>,
    exit_code: i32,
    before_status_set: impl FnMut(),
) {
    let stop_reason = control
        .stop_reason
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let finish = control
        .finish
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let (outcome, reason, summary) = if let Some(reason) = stop_reason {
        (
            RunOutcome::Failed,
            Some(reason),
            finish.and_then(|value| value.summary),
        )
    } else if let Some(finish) = finish {
        (finish.outcome, finish.reason, finish.summary)
    } else if exit_code == 0 {
        (RunOutcome::NeedsReview, None, None)
    } else {
        (
            RunOutcome::Failed,
            Some(format!("exit code {exit_code}")),
            None,
        )
    };
    let task_id = control
        .record
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .task_id
        .clone();
    fail_running_subtasks(control, &task_id);
    close_open_steps(control);
    let status = match outcome {
        RunOutcome::NeedsReview => crate::types::task::TaskStatus::NeedsReview,
        RunOutcome::Failed => crate::types::task::TaskStatus::Failed,
    };
    let actor = match outcome {
        RunOutcome::NeedsReview => Actor::Script,
        RunOutcome::Failed => Actor::System,
    };
    let mut reason = reason;
    match finalize_task_status(&control.project, &task_id, status, actor, before_status_set) {
        Ok(Some(status)) => tauri_plugin_log::log::warn!(
            "Task {task_id} is {status:?}; run finalization will not overwrite it"
        ),
        Ok(None) => {}
        Err(error) => {
            let message = format!("could not update task: {error}");
            tauri_plugin_log::log::error!("Could not finalize run task {task_id}: {error}");
            reason = Some(message);
        }
    }
    let record = {
        let mut record = control
            .record
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        record.ended_at = Some(now_ms());
        record.outcome = Some(outcome);
        record.reason = reason.clone();
        record.summary = summary;
        if let Err(error) = write_run_record(&control.run_directory, &record) {
            tauri_plugin_log::log::error!("Could not update run metadata: {error}");
        }
        record.clone()
    };
    {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.last = Some(record.clone());
        if state
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, control))
        {
            state.active = None;
        }
    }
    control.sink.emit(ChangeEvent::RunFinished {
        run_id: record.run_id.clone(),
        task_id: record.task_id.clone(),
        outcome,
        reason: record.reason.clone(),
    });
}

fn fail_running_subtasks(control: &RunControl, task_id: &str) {
    let task = match control.project.tasks.get(task_id) {
        Ok(task) => task,
        Err(error) => {
            tauri_plugin_log::log::error!("Could not inspect subtasks for run {task_id}: {error}");
            return;
        }
    };
    for subtask in task
        .sub_tasks
        .unwrap_or_default()
        .into_iter()
        .filter(|subtask| subtask.status == crate::types::task::TaskStatus::Running)
    {
        if let Err(error) = control.project.tasks.set_subtask_status(
            task_id,
            &subtask.id,
            crate::types::task::TaskStatus::Failed,
            Actor::System,
        ) {
            tauri_plugin_log::log::error!(
                "Could not fail running subtask {} for run {task_id}: {error}",
                subtask.id
            );
        }
    }
}

fn close_open_steps(control: &RunControl) {
    let mut events = Vec::new();
    {
        let mut record = control
            .record
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for index in 0..record.steps.len() {
            if record.steps[index].ended_at.is_some() {
                continue;
            }
            let subtask_id = record.steps[index].subtask_id.clone();
            record.steps[index].ended_at = Some(now_ms());
            record.steps[index].outcome = Some(RunOutcome::Failed);
            record.steps[index].reason = Some("step not finished".into());
            if let Err(error) = write_run_record(&control.run_directory, &record) {
                tauri_plugin_log::log::error!("Could not persist failed run step: {error}");
            }
            events.push(ChangeEvent::RunStep {
                run_id: record.run_id.clone(),
                task_id: record.task_id.clone(),
                subtask_id,
                status: crate::types::task::TaskStatus::Failed,
                summary: record.steps[index].summary.clone(),
                reason: Some("step not finished".into()),
            });
        }
    }
    for event in events {
        control.sink.emit(event);
    }
}
