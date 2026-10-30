//! Integrated-terminal PTY bridge.
//!
//! Spawns a shell inside a pseudo-terminal (ConPTY on Windows, openpty elsewhere) and relays:
//!   shell output  -> frontend, as `PtyEvent::Data` over a Tauri `Channel`
//!   keystrokes    <- frontend, via `pty_write`
//!   window resize <- frontend, via `pty_resize`

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::Channel, State};
use uuid::Uuid;

/// Serialized as `{ "event": "data" | "exit", "data": ... }`.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Terminal output (always valid UTF-8; split multi-byte characters are held back until complete).
    Data(String),
    /// The shell ended; carries its exit code.
    Exit(Option<u32>),
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(Arc<Mutex<HashMap<String, PtySession>>>);

fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Present on every Windows install. Pass `shell: "pwsh.exe"` from the frontend to use PowerShell 7.
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, PtyState>,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("could not open a pty: {e}"))?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    if let Some(args) = args {
        cmd.args(args);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start '{program}': {e}"))?;
    // The child owns the slave end now; keeping ours open would stop the reader from ever seeing EOF.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let id = Uuid::new_v4().to_string();
    let sessions = state.0.clone();
    sessions.lock().map_err(|_| "pty state poisoned")?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            killer,
        },
    );

    // Output pump. A plain thread: reading a pty is blocking I/O and shouldn't occupy the async runtime.
    let out = on_event.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new(); // bytes of a UTF-8 character cut in half by the read boundary
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);

            let ready = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                // Incomplete character at the end: send what's valid, keep the tail for the next read.
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                // Genuinely invalid bytes: send everything, lossily.
                Err(_) => pending.len(),
            };
            if ready == 0 {
                continue;
            }
            let text = String::from_utf8_lossy(&pending[..ready]).into_owned();
            pending.drain(..ready);
            if out.send(PtyEvent::Data(text)).is_err() {
                break; // frontend is gone
            }
        }
    });

    // Waits for the shell to end. On Windows the reader gets no EOF until the pty is closed,
    // so closing it (dropping the session) is part of the shutdown.
    let exit_channel = on_event;
    let exit_id = id.clone();
    thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        thread::sleep(Duration::from_millis(100)); // let the reader drain the last output
        if let Ok(mut map) = sessions.lock() {
            map.remove(&exit_id);
        }
        let _ = exit_channel.send(PtyEvent::Exit(code));
    });

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|_| "pty state poisoned")?;
    let session = map.get_mut(&id).ok_or("unknown terminal")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|_| "pty state poisoned")?;
    let session = map.get(&id).ok_or("unknown terminal")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    // Take the session out first so the map isn't locked while we kill.
    let session = state
        .0
        .lock()
        .map_err(|_| "pty state poisoned")?
        .remove(&id);
    if let Some(mut s) = session {
        let _ = s.killer.kill();
        // dropping `s` closes the pty
    }
    Ok(())
}
