use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Result of one non-interactive Git invocation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
}

/// Subcommands the frontend may run (the FIRST argument). Extend as features need them.
/// This keeps `git_run` from being a general "run anything" bridge, which matters once an AI agent
/// or any rendered content can reach the frontend.
const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "status",
    "rev-parse",
    "show",
    "diff",
    "log",
    "ls-files",
    "cat-file",
    "check-ref-format", //
    "add",
    "restore",
    "reset",
    "commit",
    "branch",
    "switch",
    "checkout",
    "stash",
    "merge",
    "tag", //
    "fetch",
    "pull",
    "push",
    "remote",
    "init",
    "clone",  //
    "clean",  // only in the exact form `clean -f -- <paths>`, see `validate`
    "config", // only reading/setting user.name and user.email, see `validate`
    "blame",  // only `blame --porcelain [--contents -] -- <path>`, see `validate`
];

/// Options that make git write arbitrary files, run programs, or inject config. Checked before any `--`.
const FORBIDDEN_OPTION_PREFIXES: &[&str] = &[
    "--output",
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--open-files-in-pager",
    "--config",
];

/// Subcommands that can run external diff/textconv programs named in a repository's own config.
const DIFFING: &[&str] = &["diff", "show", "log"];

/// Commands whose arguments are file paths. For these, "*" and "[" in a name are literal characters.
/// NOT set for everything: with it on, `git stash push --include-untracked` stops removing untracked
/// files from the working tree and the later `stash pop` fails.
const LITERAL_PATHSPEC_COMMANDS: &[&str] = &[
    "add", "reset", "restore", "clean", "diff", "log", "ls-files", "show", "blame",
];

/// Largest text the frontend may send to a command on standard input (an editor buffer for blame).
const MAX_STDIN_BYTES: usize = 16 * 1024 * 1024;

fn validate(args: &[String], has_stdin: bool) -> Result<(), String> {
    let subcommand = args.first().map(String::as_str).unwrap_or("");
    if !ALLOWED_SUBCOMMANDS.contains(&subcommand) {
        return Err(format!("Git subcommand not allowed: \"{subcommand}\""));
    }
    // Standard input exists for exactly one purpose: blaming an unsaved editor buffer.
    if has_stdin && subcommand != "blame" {
        return Err("This git command does not take standard input.".into());
    }
    if let Some(bad) = args
        .iter()
        .take_while(|a| a.as_str() != "--")
        .find(|a| FORBIDDEN_OPTION_PREFIXES.iter().any(|p| a.starts_with(p)))
    {
        return Err(format!("Git option not allowed: \"{bad}\""));
    }
    match subcommand {
        // clean deletes files, so only the narrowest form is accepted, and only ever with explicit paths.
        "clean" => {
            let narrow = args.get(1).map(String::as_str) == Some("-f")
                && args.get(2).map(String::as_str) == Some("--");
            if !narrow {
                return Err("Only `git clean -f -- <paths>` is allowed.".into());
            }
        }
        // Only the author identity may be read or set. Config can name programs git runs
        // (core.sshCommand, aliases, hooks path...), so everything else stays off limits.
        "config" => {
            let key_ok = |i: usize| {
                matches!(
                    args.get(i).map(String::as_str),
                    Some("user.name") | Some("user.email")
                )
            };
            let read = args.len() == 3 && args[1] == "--get" && key_ok(2);
            let write = args.len() == 4
                && (args[1] == "--global" || args[1] == "--local")
                && key_ok(2)
                && !args[3].starts_with('-');
            if !(read || write) {
                return Err("Only reading or setting user.name and user.email is allowed.".into());
            }
        }
        // Exactly two shapes. `--contents <file>` would let git read an arbitrary file, so only `--contents -`
        // (standard input) is accepted, and only together with the text that goes on it.
        "blame" => {
            let on_disk =
                args.len() == 4 && args[1] == "--porcelain" && args[2] == "--" && !has_stdin;
            let on_buffer = args.len() == 6
                && args[1] == "--porcelain"
                && args[2] == "--contents"
                && args[3] == "-"
                && args[4] == "--"
                && has_stdin;
            if !(on_disk || on_buffer) {
                return Err(
                    "Only `git blame --porcelain [--contents -] -- <path>` is allowed.".into(),
                );
            }
        }
        // clone's -u (upload-pack) and -c (config) both run arbitrary programs.
        "clone" => {
            if args.iter().any(|a| a == "-u" || a == "-c") {
                return Err("This git clone option is not allowed.".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Runs the command, killing it if it takes longer than `timeout`. Fetch/pull/push can otherwise wait
/// forever for a credential prompt nobody can see.
fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
    input: Option<String>,
) -> Result<Output, String> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Git: {error}"))?;

    if let Some(text) = input {
        if let Some(mut pipe) = child.stdin.take() {
            // On its own thread: a big buffer would block us while git is blocked writing its output.
            // The pipe is dropped when the closure ends, which is what tells git the input is complete.
            thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            });
        }
    }

    // Both pipes must be drained while we wait, or a chatty command blocks on a full pipe.
    let mut stdout = child.stdout.take().ok_or("Git gave no stdout handle")?;
    let mut stderr = child.stderr.take().ok_or("Git gave no stderr handle")?;
    let out_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let err_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                // The readers are NOT joined: a helper process git started (ssh, a credential
                // manager) may still hold the pipes open and would block us for good.
                return Err(format!(
                    "Git did not finish within {} seconds and was stopped.",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(15)),
        }
    };

    Ok(Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Run Git directly (without a shell or terminal) in the requested working directory.
/// Arguments are passed as individual argv entries, so callers pass e.g. `["status", "--short"]`.
/// `timeout_secs` defaults to 60; network commands should pass a larger value.
/// `stdin` is only accepted for `git blame --contents -`.
#[tauri::command]
pub async fn git_run(
    cwd: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
    stdin: Option<String>,
) -> Result<GitCommandOutput, String> {
    validate(&args, stdin.is_some())?;
    if stdin.as_ref().map_or(false, |s| s.len() > MAX_STDIN_BYTES) {
        return Err("That text is too large to send to git.".into());
    }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(60).clamp(1, 1800));

    tauri::async_runtime::spawn_blocking(move || {
        let cwd_path = Path::new(&cwd);
        if !cwd_path.is_dir() {
            return Err(format!("Git working directory does not exist: {cwd}"));
        }

        let mut command = Command::new("git");
        command
            .arg("--no-pager")
            // Background status refreshes must not take `.git/index.lock` or rewrite the index: that
            // collides with git commands you run in the terminal, and the index write would itself
            // trigger the file watcher, which would trigger another refresh.
            .arg("--no-optional-locks")
            .args(["-c", "color.ui=false"])
            // Real file names in output instead of "\303\274" escapes.
            .args(["-c", "core.quotepath=false"])
            // A repository's own config can name a program to run here (fsmonitor). Never let it.
            .args(["-c", "core.fsmonitor=false"]);

        let mut rest = args.into_iter();
        let first = rest.next().unwrap_or_default();
        command.arg(&first);
        if DIFFING.contains(&first.as_str()) {
            command.args(["--no-ext-diff", "--no-textconv"]);
        }
        // Blame also runs textconv programs named in a repository's config unless told not to.
        if first == "blame" {
            command.arg("--no-textconv");
        }
        command.args(rest);

        if LITERAL_PATHSPEC_COMMANDS.contains(&first.as_str()) {
            command.env("GIT_LITERAL_PATHSPECS", "1");
        }

        command
            .current_dir(cwd_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            // Nothing can answer an editor. `:` is a no-op, so e.g. a merge keeps its default message.
            .env("GIT_EDITOR", ":")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat");

        // Without this, every call flashes a console window on Windows (this is a GUI process).
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let output = run_with_timeout(command, timeout, stdin)?;

        Ok(GitCommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code(),
            success: output.status.success(),
        })
    })
    .await
    .map_err(|error| format!("Git command task failed: {error}"))?
}
