//! Generic LSP stdio bridge.
//!
//! The frontend decides which server to run (command + args). Rust only:
//!   * spawns the process,
//!   * parses `Content-Length` framing on stdout and forwards each JSON body,
//!   * frames and writes messages the frontend sends to stdin,
//!   * reports stderr lines and process exit,
//!   * kills the process on request (or when the app drops it).

use std::{collections::HashMap, process::Stdio, sync::Arc};

use serde::Serialize;
use tauri::{ipc::Channel, State};
use tauri_plugin_log::log::log;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

/// Events streamed to the frontend over a Tauri `Channel`.
/// Serialized as `{ "event": "message" | "stderr" | "exit", "data": ... }`.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum LspEvent {
    /// One complete JSON-RPC message body (already de-framed).
    Message(String),
    /// One line from the server's stderr (logs).
    Stderr(String),
    /// The process ended; carries the exit code if there was one.
    Exit(Option<i32>),
}

struct LspHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    kill: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct LspState(Arc<Mutex<HashMap<String, LspHandle>>>);

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, LspState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    on_event: Channel<LspEvent>,
) -> Result<String, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // Don't flash a console window on Windows (CREATE_NO_WINDOW).
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start '{command}': {e}"))?;

    let stdin = child.stdin.take().ok_or("child has no stdin")?;
    let stdout = child.stdout.take().ok_or("child has no stdout")?;
    let stderr = child.stderr.take().ok_or("child has no stderr")?;

    let id = Uuid::new_v4().to_string();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let servers = state.0.clone();

    servers.lock().await.insert(
        id.clone(),
        LspHandle {
            stdin: Arc::new(Mutex::new(stdin)),
            kill: Some(kill_tx),
        },
    );

    tauri::async_runtime::spawn(read_loop(stdout, on_event.clone()));
    tauri::async_runtime::spawn(stderr_loop(stderr, on_event.clone()));

    // This task owns the Child: it waits for exit or a kill request.
    let exit_channel = on_event;
    let exit_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = kill_rx => {
                let _ = child.kill().await;
                None
            }
        };
        let _ = exit_channel.send(LspEvent::Exit(code));
        servers.lock().await.remove(&exit_id);
    });

    Ok(id)
}

#[tauri::command]
pub async fn lsp_send(
    state: State<'_, LspState>,
    id: String,
    message: String,
) -> Result<(), String> {
    // Clone the Arc out so the map lock isn't held during the write.
    let stdin = state
        .0
        .lock()
        .await
        .get(&id)
        .map(|h| h.stdin.clone())
        .ok_or("unknown language server")?;

    let mut writer = stdin.lock().await;
    // Content-Length is the body size in BYTES, not characters.
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    writer
        .write_all(header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer
        .write_all(message.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, id: String) -> Result<(), String> {
    let handle = state.0.lock().await.remove(&id);
    if let Some(mut h) = handle {
        if let Some(tx) = h.kill.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

async fn read_loop(stdout: ChildStdout, channel: Channel<LspEvent>) {
    let mut reader = BufReader::new(stdout);
    loop {
        // Headers: read lines until the blank separator line.
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return, // EOF or broken pipe
                Ok(_) => {}
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let lower = line.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                content_length = value.trim().parse().ok();
            }
        }

        let Some(len) = content_length else { continue };
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        if let Ok(text) = String::from_utf8(body) {
            if channel.send(LspEvent::Message(text)).is_err() {
                return; // frontend is gone
            }
        }
    }
}

async fn stderr_loop(stderr: ChildStderr, channel: Channel<LspEvent>) {
    // Must be drained, otherwise a chatty server can block on a full pipe.
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if channel.send(LspEvent::Stderr(line)).is_err() {
            return;
        }
    }
}
