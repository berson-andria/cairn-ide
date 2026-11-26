use keyring::{Entry, Error};

const SERVICE_NAME: &str = "praide-ide";

fn entry(id: &str) -> Result<Entry, String> {
    if id.trim().is_empty() {
        return Err("Secret reference must not be empty".into());
    }
    Entry::new(SERVICE_NAME, id).map_err(|error| format!("OS keychain is unavailable: {error}"))
}

#[tauri::command]
pub fn secret_set(id: String, value: String) -> Result<(), String> {
    entry(&id)?
        .set_password(&value)
        .map_err(|error| format!("Unable to save secret in the OS keychain: {error}"))
}

#[tauri::command]
pub fn secret_get(id: String) -> Result<String, String> {
    entry(&id)?.get_password().map_err(|error| match error {
        Error::NoEntry => "No secret is saved for this model".into(),
        other => format!("Unable to read secret from the OS keychain: {other}"),
    })
}

#[tauri::command]
pub fn secret_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to delete secret from the OS keychain: {error}"
        )),
    }
}
