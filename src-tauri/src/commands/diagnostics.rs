use tauri_plugin_log::log::{set_max_level, LevelFilter};

#[tauri::command]
pub fn set_log_level(level: String) -> Result<(), String> {
    let filter = match level.as_str() {
        "trace" => LevelFilter::Trace,
        "debug" => LevelFilter::Debug,
        "info" => LevelFilter::Info,
        "warn" => LevelFilter::Warn,
        "error" => LevelFilter::Error,
        _ => return Err(format!("Unknown log level: {level}")),
    };
    set_max_level(filter);
    Ok(())
}
