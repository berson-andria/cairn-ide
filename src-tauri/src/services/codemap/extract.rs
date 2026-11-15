//! Tree-sitter -> `Symbol`s. Pure: no disk, no database.

use std::collections::HashMap;

use tree_sitter::{Node, Parser};

use super::languages;
use crate::types::codemap::{CallKind, CallRef, Extracted, Symbol, SymbolKind};

/// Owns one parser per language. A `Parser` is not shareable between threads:
/// give every worker its own `Extractor` (`rayon`'s `map_init` does exactly that).
#[derive(Default)]
pub struct Extractor {
    parsers: HashMap<String, Parser>,
}

impl Extractor {
    pub fn new() -> Self {
        Self::default()
    }

    fn parser(&mut self, lang: &str) -> Result<&mut Parser, String> {
        if !self.parsers.contains_key(lang) {
            let mut parser = Parser::new();
            parser
                .set_language(&languages::load(lang)?)
                .map_err(|e| format!("failed to load the {lang} grammar: {e}"))?;
            self.parsers.insert(lang.to_string(), parser);
        }
        Ok(self.parsers.get_mut(lang).expect("just inserted"))
    }

    /// `file` is the workspace-relative path (it becomes part of every symbol id).
    pub fn extract(&mut self, lang: &str, file: &str, source: &str) -> Result<Extracted, String> {
        let tree = self
            .parser(lang)?
            .parse(source, None)
            .ok_or_else(|| format!("failed to parse {file}"))?;
        let mut walk = Walk {
            src: source.as_bytes(),
            file,
            scope: Vec::new(),
            seen: HashMap::new(),
            out: Vec::new(),
            calls: Vec::new(),
        };
        match lang {
            "rust" => walk.rust(tree.root_node(), false),
            other => return Err(format!("no extractor for {other}")),
        }
        Ok(Extracted {
            symbols: walk.out,
            calls: walk.calls,
        })
    }
}

struct Walk<'a> {
    src: &'a [u8],
    file: &'a str,
    scope: Vec<String>,
    seen: HashMap<String, usize>,
    out: Vec<Symbol>,
    calls: Vec<CallRef>,
}

impl<'a> Walk<'a> {
    fn text(&self, node: Node) -> String {
        String::from_utf8_lossy(&self.src[node.byte_range()]).into_owned()
    }

    fn rust(&mut self, node: Node, in_impl: bool) {
        match node.kind() {
            "function_item" | "function_signature_item" => {
                let kind = if in_impl {
                    SymbolKind::Method
                } else {
                    SymbolKind::Function
                };
                self.emit(node, kind);
                // nested fns are an implementation detail of their parent: not walked
            }
            "struct_item" => self.emit(node, SymbolKind::Struct),
            "enum_item" => self.emit(node, SymbolKind::Enum),
            "trait_item" => {
                self.emit(node, SymbolKind::Trait);
                if let Some(name) = self.name_of(node) {
                    self.scoped(node, name, true);
                }
            }
            "impl_item" => {
                if let Some(ty) = node.child_by_field_name("type") {
                    let name = self.type_name(ty);
                    self.scoped(node, name, true);
                }
            }
            "mod_item" => {
                if let Some(name) = self.name_of(node) {
                    self.scoped(node, name, false);
                }
            }
            _ => self.children(node, in_impl),
        }
    }

    fn children(&mut self, node: Node, in_impl: bool) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.rust(child, in_impl);
        }
    }

    /// Walk the `body` of impl / trait / mod with `name` pushed on the scope.
    fn scoped(&mut self, node: Node, name: String, in_impl: bool) {
        if let Some(body) = node.child_by_field_name("body") {
            self.scope.push(name);
            self.children(body, in_impl);
            self.scope.pop();
        }
    }

    fn name_of(&self, node: Node) -> Option<String> {
        node.child_by_field_name("name").map(|n| self.text(n))
    }

    /// `Foo<T>` -> `Foo`, `a::b::Foo` -> `Foo`, `&Foo` -> text as is.
    fn type_name(&self, ty: Node) -> String {
        let inner = match ty.kind() {
            "generic_type" => ty.child_by_field_name("type"),
            "scoped_type_identifier" | "scoped_identifier" => ty.child_by_field_name("name"),
            _ => None,
        };
        match inner {
            Some(n) => self.type_name(n),
            None => self.text(ty),
        }
    }

    fn signature(&self, node: Node) -> String {
        let end = node
            .child_by_field_name("body")
            .map(|b| b.start_byte())
            .unwrap_or_else(|| node.end_byte());
        let raw = String::from_utf8_lossy(&self.src[node.start_byte()..end]);
        // comments first: a `//` comment ends at its line break, which collapsing would erase
        let collapsed = strip_comments(&raw)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let tidy = collapsed.replace("( ", "(").replace(", )", ")");
        tidy.trim_end_matches(';').trim_end().to_string()
    }

    /// Every `call_expression` in a function body (nested fns and closures count for their parent).
    fn collect_calls(&mut self, body: Node, from: &str) {
        let mut stack = vec![body];
        while let Some(node) = stack.pop() {
            if node.kind() == "call_expression" {
                if let Some(call) = self.call_of(node, from) {
                    if !self.calls.contains(&call) {
                        self.calls.push(call);
                    }
                }
            }
            let mut cursor = node.walk();
            let children: Vec<Node> = node.children(&mut cursor).collect();
            stack.extend(children.into_iter().rev());
        }
    }

    fn call_of(&self, call: Node, from: &str) -> Option<CallRef> {
        let mut callee = call.child_by_field_name("function")?;
        while callee.kind() == "generic_function" {
            callee = callee.child_by_field_name("function")?; // foo::<T>()
        }
        let (name, qualifier, kind) = match callee.kind() {
            "identifier" => (self.text(callee), None, CallKind::Bare),
            "scoped_identifier" => {
                let name = self.text(callee.child_by_field_name("name")?);
                let qualifier = callee
                    .child_by_field_name("path")
                    .map(|p| self.type_name(p));
                (name, qualifier, CallKind::Path)
            }
            "field_expression" => {
                let name = self.text(callee.child_by_field_name("field")?);
                let on_self = callee
                    .child_by_field_name("value")
                    .is_some_and(|v| self.text(v) == "self");
                (
                    name,
                    None,
                    if on_self {
                        CallKind::SelfMethod
                    } else {
                        CallKind::Method
                    },
                )
            }
            _ => return None,
        };
        Some(CallRef {
            from: from.to_string(),
            name,
            qualifier,
            kind,
        })
    }

    fn emit(&mut self, node: Node, kind: SymbolKind) {
        let Some(name) = self.name_of(node) else {
            return;
        };
        let (qualified_name, parent) = if self.scope.is_empty() {
            (name.clone(), None)
        } else {
            let parent = self.scope.join("::");
            (format!("{parent}::{name}"), Some(parent))
        };

        let base_id = format!("{}::{}::{}", self.file, qualified_name, kind.as_str());
        let count = self.seen.entry(base_id.clone()).or_insert(0);
        *count += 1;
        let id = if *count == 1 {
            base_id
        } else {
            format!("{base_id}#{count}")
        };

        if kind.is_callable() {
            if let Some(body) = node.child_by_field_name("body") {
                self.collect_calls(body, &id);
            }
        }

        let body_hash = blake3::hash(&self.src[node.byte_range()])
            .to_hex()
            .to_string();
        let signature = self.signature(node);

        self.out.push(Symbol {
            id,
            file: self.file.to_string(),
            kind,
            name,
            qualified_name,
            signature,
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            start_line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
            parent,
            body_hash,
            summary: None,
            summary_hash: None,
        });
    }
}

/// Removes `// line` and `/* block */` comments (a line comment keeps its line break).
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '/' && chars.peek() == Some(&'/') {
            for n in chars.by_ref() {
                if n == '\n' {
                    out.push('\n');
                    break;
                }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = ' ';
            for n in chars.by_ref() {
                if prev == '*' && n == '/' {
                    break;
                }
                prev = n;
            }
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extractor() -> Extractor {
        languages::test_support::ensure("rust");
        Extractor::new()
    }

    const SAMPLE: &str = r#"
use std::fmt;

pub struct Point { x: i32 }
enum Color { Red }

trait Shape {
    fn area(&self) -> f64;
    fn name(&self) -> String { "shape".into() }
}

impl Point {
    pub fn new(x: i32) -> Self { Point { x } }
    fn helper(&self) {}
}

impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) }
}

impl<T> Wrapper<T> {
    fn get(&self) {}
}

mod util {
    pub fn add(a: i32, b: i32) -> i32 {
        fn inner() {}
        a + b
    }
}

fn top() {}
"#;

    fn run(src: &str) -> Vec<Symbol> {
        extractor()
            .extract("rust", "src/a.rs", src)
            .unwrap()
            .symbols
    }

    fn calls(src: &str) -> Vec<(String, Option<String>, CallKind)> {
        extractor()
            .extract("rust", "src/a.rs", src)
            .unwrap()
            .calls
            .into_iter()
            .map(|c| (c.name, c.qualifier, c.kind))
            .collect()
    }

    fn names(syms: &[Symbol]) -> Vec<(&str, &str)> {
        syms.iter()
            .map(|s| (s.qualified_name.as_str(), s.kind.as_str()))
            .collect()
    }

    #[test]
    fn extracts_items_with_scopes() {
        let syms = run(SAMPLE);
        assert_eq!(
            names(&syms),
            vec![
                ("Point", "struct"),
                ("Color", "enum"),
                ("Shape", "trait"),
                ("Shape::area", "method"),
                ("Shape::name", "method"),
                ("Point::new", "method"),
                ("Point::helper", "method"),
                ("Point::fmt", "method"),
                ("Wrapper::get", "method"),
                ("util::add", "function"),
                ("top", "function"),
            ]
        );
    }

    #[test]
    fn nested_functions_are_not_symbols() {
        assert!(run(SAMPLE).iter().all(|s| s.name != "inner"));
    }

    #[test]
    fn signature_stops_before_body() {
        let syms = run(SAMPLE);
        let add = syms
            .iter()
            .find(|s| s.qualified_name == "util::add")
            .unwrap();
        assert_eq!(add.signature, "pub fn add(a: i32, b: i32) -> i32");
        let area = syms
            .iter()
            .find(|s| s.qualified_name == "Shape::area")
            .unwrap();
        assert_eq!(area.signature, "fn area(&self) -> f64");
    }

    #[test]
    fn spans_slice_back_to_the_item() {
        let syms = run(SAMPLE);
        let top = syms.iter().find(|s| s.name == "top").unwrap();
        assert_eq!(&SAMPLE[top.start_byte..top.end_byte], "fn top() {}");
        assert_eq!(top.start_line, top.end_line);
        assert_eq!(top.parent, None);
        let new = syms.iter().find(|s| s.name == "new").unwrap();
        assert_eq!(new.parent.as_deref(), Some("Point"));
    }

    #[test]
    fn hash_changes_only_for_the_edited_function() {
        let before = run(SAMPLE);
        let after = run(&SAMPLE.replace("fn helper(&self) {}", "fn helper(&self) { let _ = 1; }"));
        for (a, b) in before.iter().zip(&after) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.body_hash != b.body_hash, a.name == "helper", "{}", a.id);
        }
    }

    #[test]
    fn duplicate_ids_get_a_counter() {
        let src = "impl From<A> for X { fn from(a: A) -> X { X } }\nimpl From<B> for X { fn from(b: B) -> X { X } }";
        let syms = run(src);
        let ids: Vec<_> = syms.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["src/a.rs::X::from::method", "src/a.rs::X::from::method#2"]
        );
    }

    #[test]
    fn broken_code_does_not_fail() {
        let syms = run("fn ok() {}\nfn broken( {");
        assert!(syms.iter().any(|s| s.name == "ok"));
    }

    #[test]
    fn records_every_call_shape() {
        let src = r#"
fn caller(p: P) {
    plain();
    Point::new(1);
    Self::build();
    util::helpers::go();
    self.step();
    p.run();
    turbo::<u8>();
    Vec::<u8>::with_capacity(1);
    plain(); // duplicate
    println!("{}", ignored_macro());
}
"#;
        use CallKind::*;
        let got = calls(src);
        let name = |n: &str, q: Option<&str>, k| (n.to_string(), q.map(String::from), k);
        assert_eq!(
            got,
            vec![
                name("plain", None, Bare),
                name("new", Some("Point"), Path),
                name("build", Some("Self"), Path),
                name("go", Some("helpers"), Path),
                name("step", None, SelfMethod),
                name("run", None, Method),
                name("turbo", None, Bare),
                name("with_capacity", Some("Vec"), Path),
            ]
        );
    }

    #[test]
    fn calls_belong_to_their_function_only() {
        let src = "fn a() { x(); }\nfn b() { y(); }\nstruct S;";
        let out = extractor().extract("rust", "f.rs", src).unwrap();
        assert_eq!(out.calls.len(), 2);
        assert_eq!(out.calls[0].from, "f.rs::a::function");
        assert_eq!(out.calls[1].from, "f.rs::b::function");
    }

    #[test]
    fn signature_drops_comments_and_tidies_spacing() {
        let src =
            "fn f(\n    a: i32, // first\n    /* inline */ b: i32, // second\n) -> i32 { a + b }";
        let syms = run(src);
        assert_eq!(syms[0].signature, "fn f(a: i32, b: i32) -> i32");
    }
}
