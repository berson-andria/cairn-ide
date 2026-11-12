//! "Askpass": how git and ssh ask a GUI app for a password, a key passphrase or a yes/no answer.
//!
//! git calls the program named in GIT_ASKPASS, and ssh the one in SSH_ASKPASS, with the question as
//! argument 1, and reads the answer from its standard output (a non-zero exit means "cancelled").
//! This is what VS Code does too. Here the app's OWN executable is that program:
//!
//!   git_run ──spawns──▶ git ──▶ ssh/credential ──▶ this exe in helper mode (env GITIDE_ASKPASS_TOKEN set)
//!                                                       │ one JSON line over 127.0.0.1 + token
//!   Angular dialog ◀── "askpass-request" event ◀── server thread in the running app
//!   Angular dialog ──▶ askpass_answer command ──▶ server thread ──▶ helper prints the answer ──▶ git/ssh
//!
//! Lives in src-tauri/src/commands/askpass.rs (add `pub mod askpass;` to commands/mod.rs).
//! Needs in Cargo.toml: getrandom = "0.2", serde_json = "1".

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
/// Set (with the address) only on the environment of the git processes this app starts.
pub const ENV_ADDR: &str = "GITIDE_ASKPASS_ADDR";
pub const ENV_TOKEN: &str = "GITIDE_ASKPASS_TOKEN";

/// Shorter than git_run's timeout, so a forgotten dialog ends the request, not the whole git process.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(280);

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    prompt: String,
    /// ssh's SSH_ASKPASS_PROMPT=confirm: a yes/no question, answered by exit code only.
    confirm: bool,
}

#[derive(Serialize, Deserialize)]
struct Reply {
    /// None = the user cancelled.
    answer: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AskpassEvent {
    id: u64,
    prompt: String,
    confirm: bool,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Option<String>>>>>;

/// Tauri managed state: `app.manage(Askpass::start(app.handle().clone())?)`.
pub struct Askpass {
    addr: String,
    token: String,
    pending: Pending,
}

impl Askpass {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let addr = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        let token = random_token()?;
        let pending: Pending = Arc::default();
        let next_id = Arc::new(AtomicU64::new(1));

        let (t, p) = (token.clone(), pending.clone());
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (app, token, pending, next_id) =
                    (app.clone(), t.clone(), p.clone(), next_id.clone());
                thread::spawn(move || {
                    let _ = serve(stream, &app, &token, &pending, &next_id);
                });
            }
        });

        Ok(Self {
            addr,
            token,
            pending,
        })
    }

    /// Environment for a git child process: makes git and ssh call this exe for their questions.
    /// GIT_ASKPASS in the environment wins over a repository's own `core.askPass`.
    pub fn env(&self) -> Vec<(&'static str, String)> {
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        vec![
            ("GIT_ASKPASS", exe.clone()),
            ("SSH_ASKPASS", exe),
            // Without this ssh only uses SSH_ASKPASS when DISPLAY is set (X11).
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            (ENV_ADDR, self.addr.clone()),
            (ENV_TOKEN, self.token.clone()),
        ]
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// One helper connection: read the question, ask the frontend, wait, send the answer back.
fn serve(
    stream: TcpStream,
    app: &AppHandle,
    token: &str,
    pending: &Pending,
    next_id: &AtomicU64,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut line = String::new();
    BufReader::new((&stream).take(8192)).read_line(&mut line)?;
    let Ok(request) = serde_json::from_str::<Request>(&line) else {
        return Ok(());
    };
    if request.token != token {
        return Ok(()); // some other local process
    }

    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending.lock().unwrap().insert(id, tx);
    let _ = app.emit(
        "askpass-request",
        AskpassEvent {
            id,
            prompt: request.prompt,
            confirm: request.confirm,
        },
    );

    let answer = rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or(None);
    pending.lock().unwrap().remove(&id);

    let mut out = &stream;
    writeln!(
        out,
        "{}",
        serde_json::to_string(&Reply { answer }).unwrap_or_default()
    )
}

/// Called by the Angular dialog: the typed answer, or null when cancelled.
#[tauri::command]
pub fn askpass_answer(state: State<'_, Askpass>, id: u64, answer: Option<String>) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(answer);
    }
}

/// True in the helper process: the variable exists only in the environment of git processes
/// started by git_run, so a normal launch of the app never takes this path.
pub fn is_helper() -> bool {
    std::env::var_os(ENV_TOKEN).is_some()
}

/// Helper mode: answer one git / ssh question and exit. Called from main() before Tauri starts.
pub fn run_helper() -> ExitCode {
    let (Ok(addr), Ok(token)) = (std::env::var(ENV_ADDR), std::env::var(ENV_TOKEN)) else {
        return ExitCode::FAILURE;
    };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let confirm = std::env::var("SSH_ASKPASS_PROMPT").map_or(false, |v| v == "confirm");

    let Ok(mut stream) = TcpStream::connect(&addr) else {
        return ExitCode::FAILURE;
    };
    let request = serde_json::to_string(&Request {
        token,
        prompt,
        confirm,
    })
    .unwrap_or_default();
    if writeln!(stream, "{request}").is_err() {
        return ExitCode::FAILURE;
    }

    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return ExitCode::FAILURE;
    }
    match serde_json::from_str::<Reply>(&line) {
        Ok(Reply {
            answer: Some(answer),
        }) => {
            if !confirm {
                println!("{answer}");
            }
            ExitCode::SUCCESS
        }
        _ => ExitCode::FAILURE, // cancelled, timed out, or the app is gone
    }
}
