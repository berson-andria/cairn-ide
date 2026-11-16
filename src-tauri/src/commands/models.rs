use std::{
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[tauri::command]
pub async fn model_test_local(
    gguf_path: String,
    gpu_layers: u32,
    context_size: u32,
    threads: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        test_local_model(&gguf_path, gpu_layers, context_size, threads)
    })
    .await
    .map_err(|error| format!("Local model test failed: {error}"))?
}

fn test_local_model(
    gguf_path: &str,
    gpu_layers: u32,
    context_size: u32,
    threads: u32,
) -> Result<String, String> {
    if !Path::new(gguf_path).is_file() {
        return Err(format!("GGUF model file was not found: {gguf_path}"));
    }

    let mut child = Command::new("llama-cli")
        .args([
            "-m".to_owned(),
            gguf_path.to_owned(),
            "-c".into(),
            context_size.to_string(),
            "-ngl".into(),
            gpu_layers.to_string(),
            "-t".into(),
            threads.max(1).to_string(),
            "-n".into(),
            "1".into(),
            "-p".into(),
            "Reply with OK.".into(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start llama.cpp (llama-cli): {error}"))?;

    match wait_for_model(&mut child, Duration::from_secs(90)) {
        Ok(true) => Ok("Model loaded and generated a token successfully.".into()),
        Ok(false) => {
            Err("llama.cpp could not load or run this model (non-zero exit status).".into())
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn wait_for_model(child: &mut Child, timeout: Duration) -> Result<bool, String> {
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not read llama.cpp process status: {error}"))?
        {
            return Ok(status.success());
        }
        if started.elapsed() >= timeout {
            return Err("Timed out after 90 seconds while loading the model.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}
