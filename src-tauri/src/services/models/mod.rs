use crate::services::service_error::{ServiceError, ServiceErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const MODEL_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_ERROR_BODY_CHARS: usize = 300;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CALL_FILE_BYTES: usize = 1024 * 1024;
const MAX_CALLS_PER_RUN_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub model_type: String,
    #[serde(default)]
    pub context_limit: Option<u64>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub api_key_ref: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Registry {
    pub models: Vec<ModelEntry>,
    pub default_model: Option<String>,
}

impl Registry {
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join("settings.json");
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) => {
                tauri_plugin_log::log::warn!(
                    "Could not read user settings {}: {error}",
                    path.display()
                );
                return Self::default();
            }
        };
        let settings: Value = match serde_json::from_str(&contents) {
            Ok(settings) => settings,
            Err(error) => {
                tauri_plugin_log::log::warn!(
                    "Could not parse user settings {}: {error}",
                    path.display()
                );
                return Self::default();
            }
        };
        let Some(settings) = settings.as_object() else {
            tauri_plugin_log::log::warn!(
                "User settings {} must contain a JSON object",
                path.display()
            );
            return Self::default();
        };

        let models = match settings.get("models.registry").and_then(Value::as_str) {
            Some(raw) if raw.is_empty() => Vec::new(),
            Some(raw) => match serde_json::from_str::<Vec<ModelEntry>>(raw) {
                Ok(models) => {
                    let mut ids = HashSet::new();
                    if models.iter().all(|model| {
                        !model.id.trim().is_empty()
                            && matches!(model.model_type.as_str(), "api" | "local")
                            && ids.insert(model.id.as_str())
                    }) {
                        models
                    } else {
                        tauri_plugin_log::log::warn!(
                            "Model registry in {} contains an invalid entry",
                            path.display()
                        );
                        return Self::default();
                    }
                }
                Err(error) => {
                    tauri_plugin_log::log::warn!(
                        "Could not parse model registry in {}: {error}",
                        path.display()
                    );
                    return Self::default();
                }
            },
            None if settings.get("models.registry").is_none() => Vec::new(),
            None => {
                tauri_plugin_log::log::warn!(
                    "Model registry in {} must be a JSON string",
                    path.display()
                );
                return Self::default();
            }
        };
        let default_model = match settings.get("models.defaultModel") {
            None => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            Some(Value::String(_)) | Some(Value::Null) => None,
            Some(_) => {
                tauri_plugin_log::log::warn!(
                    "Default model in {} must be a string",
                    path.display()
                );
                return Self::default();
            }
        };

        Self {
            models,
            default_model,
        }
    }

    pub fn model(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|model| model.id == id)
    }

    pub fn list(&self) -> Vec<Value> {
        self.models
            .iter()
            .map(|model| {
                let mut item = json!({
                    "id":model.id,
                    "default":self.default_model.as_deref() == Some(model.id.as_str())
                });
                if let Some(context_limit) = model.context_limit {
                    item["contextLimit"] = json!(context_limit);
                }
                item
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompletion {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    pub usage: Usage,
    pub model: String,
    pub ms: u64,
}

pub trait SecretProvider: Send + Sync {
    fn get(&self, reference: &str) -> Result<String, String>;
}

pub struct KeyringSecretProvider;

impl SecretProvider for KeyringSecretProvider {
    fn get(&self, reference: &str) -> Result<String, String> {
        keyring::Entry::new("cairn-ide", reference)
            .and_then(|entry| entry.get_password())
            .map_err(|error| error.to_string())
    }
}

#[derive(Default)]
pub struct ModelCallControl {
    cancelled: AtomicBool,
    active_agent: Mutex<Option<ureq::Agent>>,
}

impl ModelCallControl {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn install_agent(&self, agent: &ureq::Agent) -> Result<(), ServiceError> {
        let mut active = self
            .active_agent
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.is_cancelled() {
            agent.clone().shutdown();
            return Err(ServiceError::new(
                ServiceErrorCode::ModelUnavailable,
                "The run was cancelled",
            ));
        }
        *active = Some(agent.clone());
        Ok(())
    }

    fn clear_agent(&self) {
        self.active_agent
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(agent) = self
            .active_agent
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            agent.shutdown();
        }
    }
}

pub trait ModelClient: Send + Sync {
    fn complete(
        &self,
        entry: &ModelEntry,
        messages: &[ChatMessage],
        max_tokens: Option<u64>,
        temperature: Option<f64>,
        stop: Option<Value>,
        json_mode: bool,
        control: &ModelCallControl,
    ) -> Result<ProviderCompletion, ServiceError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCompletion {
    pub text: String,
    pub finish_reason: Option<String>,
    pub usage: Usage,
    pub safe_messages: Vec<ChatMessage>,
}

pub struct OpenAiCompatible {
    secrets: Arc<dyn SecretProvider>,
}

impl Default for OpenAiCompatible {
    fn default() -> Self {
        Self::new(Arc::new(KeyringSecretProvider))
    }
}

impl OpenAiCompatible {
    pub fn new(secrets: Arc<dyn SecretProvider>) -> Self {
        Self { secrets }
    }
}

impl ModelClient for OpenAiCompatible {
    fn complete(
        &self,
        entry: &ModelEntry,
        messages: &[ChatMessage],
        max_tokens: Option<u64>,
        temperature: Option<f64>,
        stop: Option<Value>,
        json_mode: bool,
        control: &ModelCallControl,
    ) -> Result<ProviderCompletion, ServiceError> {
        let Some(base_url) = entry
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            return Err(ServiceError::new(
                ServiceErrorCode::ModelUnavailable,
                format!(
                    "model {} has no endpoint; register the server as an API model with a baseUrl",
                    entry.id
                ),
            ));
        };
        let endpoint = completion_endpoint(base_url).map_err(|_| {
            ServiceError::new(
                ServiceErrorCode::ModelUnavailable,
                format!("Model endpoint for {} is invalid", entry.id),
            )
        })?;
        let host_port = endpoint_host_port(base_url);
        let api_key = if let Some(reference) = entry.api_key_ref.as_deref() {
            let key = self.secrets.get(reference).map_err(|_| {
                ServiceError::new(
                    ServiceErrorCode::ModelUnavailable,
                    format!("Could not retrieve API credentials for model {}", entry.id),
                )
            })?;
            if key.is_empty() {
                return Err(ServiceError::new(
                    ServiceErrorCode::ModelUnavailable,
                    format!("API credential for model {} is empty", entry.id),
                ));
            }
            Some(key)
        } else {
            None
        };

        let model_name = entry.model_name.as_deref().unwrap_or(&entry.id);
        let mut body = json!({
            "model":model_name,
            "messages":messages
        });
        if let Some(max_tokens) = max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(temperature) = temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(stop) = stop {
            body["stop"] = stop;
        }
        if json_mode {
            body["response_format"] = json!({"type":"json_object"});
        }
        let body = serde_json::to_string(&body)
            .map_err(|error| ServiceError::new(ServiceErrorCode::ModelError, error.to_string()))?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(MODEL_TIMEOUT))
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .into();
        control.install_agent(&agent)?;
        let mut request = agent
            .post(&endpoint)
            .header("Content-Type", "application/json");
        if let Some(key) = api_key.as_deref() {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        let response = request.send(body);
        let result = match response {
            Ok(response) => {
                let status = response.status();
                let response_body: Result<String, ureq::Error> = response
                    .into_body()
                    .with_config()
                    .limit(MAX_RESPONSE_BYTES)
                    .read_to_string();
                let response_body = match response_body {
                    Ok(body) => body,
                    Err(_) => {
                        control.clear_agent();
                        return Err(ServiceError::new(
                            ServiceErrorCode::ModelUnavailable,
                            format!("Could not reach model endpoint {host_port}"),
                        ));
                    }
                };
                if status != 200 {
                    let redacted = redact_text(&response_body, api_key.as_deref());
                    let short = truncate_chars(&redacted, MAX_ERROR_BODY_CHARS);
                    Err(ServiceError::new(
                        ServiceErrorCode::ModelError,
                        format!("Model endpoint returned HTTP {status}: {short}"),
                    ))
                } else {
                    parse_completion(&response_body)
                        .map(|mut completion| {
                            completion.text = redact_text(&completion.text, api_key.as_deref());
                            completion.safe_messages = messages
                                .iter()
                                .map(|message| ChatMessage {
                                    role: message.role.clone(),
                                    content: redact_text(&message.content, api_key.as_deref()),
                                })
                                .collect();
                            completion
                        })
                        .map_err(|message| {
                            ServiceError::new(
                                ServiceErrorCode::ModelError,
                                format!("Invalid response from model {}: {message}", entry.id),
                            )
                        })
                }
            }
            Err(_) => Err(ServiceError::new(
                ServiceErrorCode::ModelUnavailable,
                format!("Could not reach model endpoint {host_port}"),
            )),
        };
        control.clear_agent();
        result
    }
}

fn completion_endpoint(base_url: &str) -> Result<String, ()> {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || base.contains(['?', '#'])
    {
        return Err(());
    }
    let authority = base
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or_default()
        .split(|character| matches!(character, '/' | '?' | '#'))
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_owned())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

fn endpoint_host_port(base_url: &str) -> String {
    let base_url = base_url.trim();
    let authority = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url)
        .split(|character| matches!(character, '/' | '?' | '#'))
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    if authority.starts_with('[') {
        if authority.contains("]:") {
            authority.to_owned()
        } else {
            format!(
                "{authority}:{}",
                if base_url
                    .split_once("://")
                    .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("https"))
                {
                    443
                } else {
                    80
                }
            )
        }
    } else if authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
    {
        authority.to_owned()
    } else {
        format!(
            "{authority}:{}",
            if base_url
                .split_once("://")
                .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("https"))
            {
                443
            } else {
                80
            }
        )
    }
}

fn parse_completion(body: &str) -> Result<ProviderCompletion, &'static str> {
    let response: Value = serde_json::from_str(body).map_err(|_| "response is not valid JSON")?;
    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or("response has no choices")?;
    let text = choice
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or("first choice has no text content")?;
    let usage = response.get("usage").unwrap_or(&Value::Null);
    Ok(ProviderCompletion {
        text: text.to_owned(),
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
        usage: Usage {
            prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_u64),
            completion_tokens: usage.get("completion_tokens").and_then(Value::as_u64),
        },
        safe_messages: Vec::new(),
    })
}

fn redact_text(text: &str, secret: Option<&str>) -> String {
    let text = secret.filter(|secret| !secret.is_empty()).map_or_else(
        || text.to_owned(),
        |secret| text.replace(secret, "[REDACTED]"),
    );
    redact_key_like_strings(&text)
}

fn redact_key_like_strings(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    let lowercase = text.to_ascii_lowercase();
    for (marker, prefix_len) in [
        ("bearer ", 7),
        ("sk-", 3),
        ("key-", 4),
        ("api_key=", 8),
        ("api-key=", 8),
    ] {
        let mut search_from = 0;
        while let Some(found) = lowercase[search_from..].find(marker) {
            let start = search_from + found;
            if start < cursor {
                search_from = start + prefix_len;
                continue;
            }
            output.push_str(&text[cursor..start]);
            output.push_str("[REDACTED]");
            let token_start = start + prefix_len;
            let token_end = text[token_start..]
                .find(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '"' | '\'' | ',' | ';' | ')' | ']' | '}')
                })
                .map_or(text.len(), |offset| token_start + offset);
            cursor = token_end;
            search_from = token_end;
        }
    }
    output.push_str(&text[cursor..]);
    output
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut result = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        result.push_str("...");
    }
    result
}

pub struct ModelBroker {
    pub registry: Arc<Registry>,
    client: Arc<dyn ModelClient>,
    control: Arc<ModelCallControl>,
    run_directory: PathBuf,
    call_index: std::sync::atomic::AtomicU64,
    serial: Mutex<()>,
}

impl ModelBroker {
    pub fn new(
        registry: Arc<Registry>,
        client: Arc<dyn ModelClient>,
        control: Arc<ModelCallControl>,
        run_directory: PathBuf,
    ) -> Self {
        Self {
            registry,
            client,
            control,
            run_directory,
            call_index: std::sync::atomic::AtomicU64::new(0),
            serial: Mutex::new(()),
        }
    }

    pub fn list(&self) -> Vec<Value> {
        self.registry.list()
    }

    pub fn with_default_client(
        registry: Arc<Registry>,
        control: Arc<ModelCallControl>,
        run_directory: PathBuf,
    ) -> Self {
        Self::new(
            registry,
            Arc::new(OpenAiCompatible::default()),
            control,
            run_directory,
        )
    }

    pub fn complete(
        &self,
        model_id: Option<&str>,
        messages: &[ChatMessage],
        max_tokens: Option<u64>,
        temperature: Option<f64>,
        stop: Option<Value>,
        json_mode: bool,
    ) -> Result<ModelCompletion, ServiceError> {
        validate_messages(messages)?;
        let model_id = match model_id {
            Some(id) => id,
            None => self
                .registry
                .default_model
                .as_deref()
                .ok_or_else(|| ServiceError::validation("no default model"))?,
        };
        let entry = self
            .registry
            .model(model_id)
            .ok_or_else(|| ServiceError::validation("model is not registered"))?;
        if let Some(context_limit) = entry.context_limit {
            let input_chars = messages
                .iter()
                .map(|message| message.content.chars().count() as u64)
                .sum::<u64>();
            let estimated_tokens = (input_chars / 3).saturating_add(max_tokens.unwrap_or(0));
            if estimated_tokens > context_limit {
                return Err(ServiceError::new(
                    ServiceErrorCode::ContextTooLarge,
                    format!(
                        "estimated context {estimated_tokens} exceeds model context limit {context_limit}"
                    ),
                ));
            }
        }
        let _serial = self
            .serial
            .lock()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        if self.control.is_cancelled() {
            return Err(ServiceError::new(
                ServiceErrorCode::ModelUnavailable,
                "The run was cancelled",
            ));
        }
        let started = Instant::now();
        let completion = self.client.complete(
            entry,
            messages,
            max_tokens,
            temperature,
            stop,
            json_mode,
            &self.control,
        )?;
        let ms = started.elapsed().as_millis() as u64;
        let result = ModelCompletion {
            text: completion.text,
            finish_reason: completion.finish_reason,
            usage: completion.usage,
            model: entry.id.clone(),
            ms,
        };
        self.write_call_file(&completion.safe_messages, &result);
        Ok(result)
    }

    fn write_call_file(&self, messages: &[ChatMessage], completion: &ModelCompletion) {
        let calls_dir = self.run_directory.join("calls");
        if let Err(error) = fs::create_dir_all(&calls_dir) {
            tauri_plugin_log::log::error!("Could not create model call directory: {error}");
            return;
        }
        let call_index = self.call_index.fetch_add(1, Ordering::SeqCst) + 1;
        let path = calls_dir.join(format!("{call_index}.json"));
        let mut saved_messages = messages.to_vec();
        let mut saved_text = completion.text.clone();
        let mut record = json!({
            "messages":saved_messages,
            "text":saved_text
        });
        let mut encoded = match serde_json::to_vec(&record) {
            Ok(encoded) => encoded,
            Err(error) => {
                tauri_plugin_log::log::error!("Could not encode model call record: {error}");
                return;
            }
        };
        if encoded.len() > MAX_CALL_FILE_BYTES {
            let mut content_budget = MAX_CALL_FILE_BYTES / (saved_messages.len() + 1) / 12;
            while encoded.len() > MAX_CALL_FILE_BYTES {
                for message in &mut saved_messages {
                    message.content = truncate_chars(&message.content, content_budget);
                }
                saved_text = truncate_chars(&saved_text, content_budget);
                record = json!({"messages":saved_messages,"text":saved_text});
                encoded = match serde_json::to_vec(&record) {
                    Ok(encoded) => encoded,
                    Err(error) => {
                        tauri_plugin_log::log::error!(
                            "Could not encode model call record: {error}"
                        );
                        return;
                    }
                };
                content_budget = content_budget.saturating_mul(3) / 4;
                if content_budget == 0 && encoded.len() > MAX_CALL_FILE_BYTES {
                    break;
                }
            }
        }
        if encoded.len() > MAX_CALL_FILE_BYTES {
            tauri_plugin_log::log::error!("Model call record exceeds its 1 MB file limit");
            return;
        }
        let entries = match fs::read_dir(&calls_dir) {
            Ok(entries) => entries,
            Err(error) => {
                tauri_plugin_log::log::error!("Could not inspect model call directory: {error}");
                return;
            }
        };
        let mut used_bytes = 0u64;
        for item in entries {
            let entry = match item {
                Ok(entry) => entry,
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not inspect model call file: {error}");
                    return;
                }
            };
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    tauri_plugin_log::log::error!("Could not inspect model call file: {error}");
                    return;
                }
            };
            if metadata.is_file() {
                used_bytes = used_bytes.saturating_add(metadata.len());
            }
        }
        if used_bytes.saturating_add(encoded.len() as u64) > MAX_CALLS_PER_RUN_BYTES {
            tauri_plugin_log::log::warn!(
                "Model call records reached the 20 MB limit for run {}",
                self.run_directory.display()
            );
            return;
        }
        if let Err(error) = fs::write(path, encoded) {
            tauri_plugin_log::log::error!("Could not write model call record: {error}");
        }
    }
}

fn validate_messages(messages: &[ChatMessage]) -> Result<(), ServiceError> {
    if messages.len() > 100 {
        return Err(ServiceError::validation(
            "messages must contain at most 100 items",
        ));
    }
    let char_count = messages
        .iter()
        .map(|message| message.content.chars().count())
        .sum::<usize>();
    if char_count > 1_000_000 {
        return Err(ServiceError::validation(
            "messages must contain at most 1,000,000 characters",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        thread,
        time::Duration,
    };
    use tempfile::tempdir;

    struct TestSecrets(Option<String>);

    impl SecretProvider for TestSecrets {
        fn get(&self, _reference: &str) -> Result<String, String> {
            self.0.clone().ok_or_else(|| "missing".into())
        }
    }

    fn entry(base_url: String, key_ref: Option<&str>) -> ModelEntry {
        ModelEntry {
            id: "test-model".into(),
            model_type: "api".into(),
            context_limit: Some(4096),
            provider: Some("custom".into()),
            base_url: Some(base_url),
            model_name: Some("remote-name".into()),
            api_key_ref: key_ref.map(str::to_owned),
        }
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0; 1];
        while !request.ends_with(b"\r\n\r\n") {
            if stream.read_exact(&mut byte).is_err() {
                break;
            }
            request.push(byte[0]);
        }
        let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or_default();
        let mut body = vec![0; content_length];
        let _ = stream.read_exact(&mut body);
        request.extend(body);
        String::from_utf8_lossy(&request).into_owned()
    }

    fn server(response: String) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let _ = stream.write_all(response.as_bytes());
            request
        });
        (format!("http://{address}"), handle)
    }

    fn ok_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn registry_loads_missing_and_corrupt_files_as_empty() {
        let directory = tempdir().unwrap();
        assert!(Registry::load(directory.path()).models.is_empty());
        fs::write(directory.path().join("settings.json"), "{").unwrap();
        assert!(Registry::load(directory.path()).models.is_empty());
        fs::write(
            directory.path().join("settings.json"),
            r#"{"models.registry":"not-json"}"#,
        )
        .unwrap();
        assert!(Registry::load(directory.path()).models.is_empty());
    }

    #[test]
    fn models_list_omits_urls_and_key_references() {
        let registry = Registry {
            models: vec![entry(
                "https://private.example/v1".into(),
                Some("model:private"),
            )],
            default_model: Some("test-model".into()),
        };
        let rendered = serde_json::to_string(&registry.list()).unwrap();
        assert!(rendered.contains("test-model"));
        assert!(rendered.contains("contextLimit"));
        assert!(rendered.contains("\"default\":true"));
        assert!(!rendered.contains("private.example"));
        assert!(!rendered.contains("model:private"));
    }

    #[test]
    fn loaded_registry_snapshot_is_unchanged_after_settings_are_edited() {
        let directory = tempdir().unwrap();
        let (old_url, old_server) = server(ok_response(
            r#"{"choices":[{"message":{"content":"old endpoint"},"finish_reason":"stop"}]}"#,
        ));
        let old_model = entry(old_url, None);
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_string(&json!({
                "models.registry":serde_json::to_string(&[old_model]).unwrap(),
                "models.defaultModel":"test-model"
            }))
            .unwrap(),
        )
        .unwrap();
        let snapshot = Arc::new(Registry::load(directory.path()));
        fs::write(
            directory.path().join("settings.json"),
            r#"{"models.registry":"[]","models.defaultModel":""}"#,
        )
        .unwrap();
        let broker = ModelBroker::with_default_client(
            snapshot,
            Arc::new(ModelCallControl::default()),
            directory.path().join("run"),
        );
        let result = broker
            .complete(
                None,
                &[ChatMessage {
                    role: MessageRole::User,
                    content: "test".into(),
                }],
                None,
                None,
                None,
                false,
            )
            .unwrap();
        assert_eq!(result.model, "test-model");
        assert!(old_server
            .join()
            .unwrap()
            .contains("\"model\":\"remote-name\""));
    }

    #[test]
    fn model_call_files_redact_keys_from_messages_and_response() {
        let key = "test-api-secret";
        let body = format!(
            r#"{{"choices":[{{"message":{{"content":"response {key}"}},"finish_reason":"stop"}}],"usage":{{}}}}"#
        );
        let (url, server_thread) = server(ok_response(&body));
        let registry = Arc::new(Registry {
            models: vec![entry(url, Some("model:test-model"))],
            default_model: Some("test-model".into()),
        });
        let directory = tempdir().unwrap();
        let broker = ModelBroker::new(
            registry,
            Arc::new(OpenAiCompatible::new(Arc::new(TestSecrets(Some(
                key.into(),
            ))))),
            Arc::new(ModelCallControl::default()),
            directory.path().join("run"),
        );
        let result = broker
            .complete(
                None,
                &[ChatMessage {
                    role: MessageRole::User,
                    content: format!("use {key}"),
                }],
                None,
                None,
                None,
                false,
            )
            .unwrap();
        let request = server_thread.join().unwrap();
        let call_file = fs::read_to_string(directory.path().join("run/calls/1.json")).unwrap();
        assert!(request.contains(&format!("Bearer {key}")));
        assert!(!result.text.contains(key));
        assert!(!call_file.contains(key));
        assert!(call_file.contains("[REDACTED]"));
    }

    #[test]
    fn openai_compatible_parses_success_and_sends_bearer_only_with_key_reference() {
        let body = r#"{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#;
        let (url, server_thread) = server(ok_response(body));
        let client = OpenAiCompatible::new(Arc::new(TestSecrets(Some("secret-value".into()))));
        let control = ModelCallControl::default();
        let result = client
            .complete(
                &entry(url, Some("model:test-model")),
                &[ChatMessage {
                    role: MessageRole::User,
                    content: "say hello".into(),
                }],
                Some(32),
                None,
                None,
                false,
                &control,
            )
            .unwrap();
        let request = server_thread.join().unwrap();
        assert_eq!(result.text, "hello");
        assert_eq!(result.finish_reason.as_deref(), Some("stop"));
        assert_eq!(result.usage.prompt_tokens, Some(12));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-value"));
        assert!(request.contains(r#""model":"remote-name""#));
        assert!(request.contains(r#""max_tokens":32"#));

        let (url, server_thread) = server(ok_response(body));
        client
            .complete(
                &entry(url, None),
                &[ChatMessage {
                    role: MessageRole::User,
                    content: "say hello".into(),
                }],
                None,
                None,
                None,
                false,
                &ModelCallControl::default(),
            )
            .unwrap();
        assert!(!server_thread
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
    }

    #[test]
    fn refused_connection_reports_host_and_port_without_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = OpenAiCompatible::default()
            .complete(
                &entry(format!("http://{address}"), None),
                &[],
                None,
                None,
                None,
                false,
                &ModelCallControl::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::ModelUnavailable);
        assert!(error.message.contains(&address.to_string()));
        assert!(!error.message.contains("Bearer"));
    }

    #[test]
    fn local_model_without_endpoint_returns_registration_guidance() {
        let error = OpenAiCompatible::default()
            .complete(
                &ModelEntry {
                    id: "local-model".into(),
                    model_type: "local".into(),
                    context_limit: Some(4096),
                    provider: None,
                    base_url: None,
                    model_name: None,
                    api_key_ref: None,
                },
                &[],
                None,
                None,
                None,
                false,
                &ModelCallControl::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::ModelUnavailable);
        assert_eq!(
            error.message,
            "model local-model has no endpoint; register the server as an API model with a baseUrl"
        );
    }

    #[test]
    fn http_error_is_truncated_and_redacts_key_like_strings() {
        let secret = "secret-value";
        let response_body = format!("sk-secret-value echoed {secret} {}", "x".repeat(500));
        let response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
        let (url, server) = server(response);
        let error = OpenAiCompatible::new(Arc::new(TestSecrets(Some(secret.into()))))
            .complete(
                &entry(url, Some("model:test-model")),
                &[],
                None,
                None,
                None,
                false,
                &ModelCallControl::default(),
            )
            .unwrap_err();
        let request = server.join().unwrap();
        assert_eq!(error.code, ServiceErrorCode::ModelError);
        assert!(error.message.contains("HTTP 500"));
        assert!(!error.message.contains(secret));
        assert!(error.message.contains("[REDACTED]"));
        let body = error.message.split_once(": ").unwrap().1;
        assert!(body.chars().count() <= MAX_ERROR_BODY_CHARS + 3);
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-value"));
    }

    #[test]
    fn cancelling_model_call_shuts_down_slow_request_quickly() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            accepted_tx.send(()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut probe = [0; 1];
            while Instant::now() < deadline {
                match stream.read(&mut probe) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => break,
                }
            }
            closed_tx.send(()).unwrap();
        });
        let control = Arc::new(ModelCallControl::default());
        let call_control = control.clone();
        let client = Arc::new(OpenAiCompatible::default());
        let call = thread::spawn(move || {
            client.complete(
                &entry(format!("http://{address}"), None),
                &[],
                None,
                None,
                None,
                false,
                &call_control,
            )
        });
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let started = Instant::now();
        control.cancel();
        let _ = call.join().unwrap();
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("client connection remained open after cancellation");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancellation took {:?}",
            started.elapsed()
        );
        server.join().unwrap();
    }
}
