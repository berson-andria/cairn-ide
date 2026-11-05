use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    #[serde(flatten)]
    pub base: BaseNode,
    pub content: String,
    pub extension: String,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    #[serde(flatten)]
    pub base: BaseNode,
    pub is_expanded: bool,
    pub children: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Node {
    File(FileNode),
    Folder(FolderNode),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    pub line_number: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub matches: Vec<LineMatch>,
}
