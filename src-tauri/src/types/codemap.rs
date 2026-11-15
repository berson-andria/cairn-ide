use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Enum,
    Trait,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Struct => "struct",
            SymbolKind::Enum => "enum",
            SymbolKind::Trait => "trait",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "function" => SymbolKind::Function,
            "method" => SymbolKind::Method,
            "struct" => SymbolKind::Struct,
            "enum" => SymbolKind::Enum,
            "trait" => SymbolKind::Trait,
            _ => return None,
        })
    }

    /// Kinds that get a behavioral summary and take part in the call graph.
    pub fn is_callable(self) -> bool {
        matches!(self, SymbolKind::Function | SymbolKind::Method)
    }
}

/// One named item of the code map (function, method, type...).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    /// `<file>::<qualified_name>::<kind>`, with `#2`, `#3`... when that repeats in a file.
    pub id: String,
    /// Path relative to the workspace root, always with `/`.
    pub file: String,
    pub kind: SymbolKind,
    pub name: String,
    /// `Type::method`, `module::function`...
    pub qualified_name: String,
    /// Declaration up to (not including) the body, whitespace collapsed.
    pub signature: String,
    pub start_byte: usize,
    pub end_byte: usize,
    /// 1-based, inclusive.
    pub start_line: usize,
    pub end_line: usize,
    /// Qualified name of the enclosing impl / trait / module.
    pub parent: Option<String>,
    /// blake3 of the full item text.
    pub body_hash: String,
    pub summary: Option<String>,
    /// `body_hash` the summary was written for. The summary is stale when this differs from `body_hash`.
    pub summary_hash: Option<String>,
}

impl Symbol {
    pub fn is_summary_stale(&self) -> bool {
        self.kind.is_callable() && self.summary_hash.as_deref() != Some(self.body_hash.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub scanned: usize,
    pub parsed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub removed: usize,
    pub symbols: usize,
}

/// How a call was written, which decides how it can be resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallKind {
    /// `foo()`
    Bare,
    /// `Type::foo()` / `module::foo()` / `Self::foo()`
    Path,
    /// `self.foo()`
    SelfMethod,
    /// `value.foo()`
    Method,
}

/// One call found inside a function body. Only names: resolving them to symbols happens at query time,
/// so a callee that is added or edited later in another file is still found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRef {
    /// Id of the calling symbol.
    pub from: String,
    pub name: String,
    /// `Type` in `Type::foo()`, `module` in `module::foo()`.
    pub qualifier: Option<String>,
    pub kind: CallKind,
}

/// What parsing one file produces.
#[derive(Debug, Clone, Default)]
pub struct Extracted {
    pub symbols: Vec<Symbol>,
    pub calls: Vec<CallRef>,
}

/// A caller or callee. `exact` is false when the name matched several candidates and the map cannot tell which.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub symbol: Symbol,
    pub exact: bool,
}

/// The workspace as folders -> files -> symbols.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TreeNode {
    Folder {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
    File {
        name: String,
        path: String,
        lang: String,
        symbols: Vec<Symbol>,
    },
}

/// A language found in the workspace whose parser is not installed yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingLanguage {
    pub name: String,
    /// How many files are waiting for it.
    pub files: usize,
}
