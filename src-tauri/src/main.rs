// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    // git / ssh start this same executable as their askpass program. Answer the question and
    // leave before any window or plugin is created.
    if praide_lib::is_askpass_helper() {
        return praide_lib::run_askpass_helper();
    }
    praide_lib::run();
    ExitCode::SUCCESS
}
