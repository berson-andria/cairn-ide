use grep_searcher::{Searcher, Sink, SinkMatch};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")] // Maps Rust snake_case to JavaScript camelCase automatically
pub struct LineMatch {
    pub line_number: u64,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

pub struct FileSearchSink<'a> {
    pub matches: &'a mut Vec<LineMatch>,
}

impl<'a> Sink for FileSearchSink<'a> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        let text = String::from_utf8_lossy(mat.bytes()).trim().to_string();
        self.matches.push(LineMatch {
            line_number: mat.line_number().unwrap_or(0),
            text,
        });
        Ok(true)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNameSearchResult {
    pub file_name: String,
    pub path: String,
}

/// Filters sent by the search panel. Every field is optional on the JS side.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// Comma-separated globs, e.g. "*.ts, src/**". Empty = everything.
    pub include: String,
    /// Comma-separated globs, e.g. "**/*.spec.ts, dist".
    pub exclude: String,
    /// Search exactly these files (the open editors) instead of walking the workspace.
    pub only_paths: Option<Vec<String>>,
    /// Match case
    pub case_sensitive: bool,
    /// Match whole word
    pub whole_word: bool,
}
