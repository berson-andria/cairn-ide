//! Who calls whom, by name. No language server involved: a call written `x.run()` can only be matched to
//! "some method called run", so when several candidates fit, every one is returned and the link is not `exact`.

use crate::types::codemap::{CallKind, CallRef, Symbol, SymbolKind};

/// Last segment of `a::b::Type` -> `Type`.
fn last_segment(path: &str) -> &str {
    path.rsplit("::").next().unwrap_or(path)
}

/// Which of `named` (functions/methods called like `call.name`) can `call` be talking about?
pub fn resolve<'a>(caller: &Symbol, call: &CallRef, named: &'a [Symbol]) -> Vec<&'a Symbol> {
    let same_scope = |s: &&Symbol, scope: &str| s.parent.as_deref().map(last_segment) == Some(scope);

    match call.kind {
        CallKind::Bare => prefer_same_file(caller, named.iter().filter(|s| s.kind == SymbolKind::Function).collect()),

        CallKind::Path => {
            let qualifier = match call.qualifier.as_deref() {
                Some("Self") => caller.parent.as_deref().map(last_segment),
                other => other,
            };
            match qualifier {
                // `crate::foo()`, `self::foo()`, `super::foo()`: a free function somewhere in the crate
                Some("crate" | "self" | "super") => {
                    prefer_same_file(caller, named.iter().filter(|s| s.kind == SymbolKind::Function).collect())
                }
                // `Type::foo()` or `module::foo()`
                Some(q) => named.iter().filter(|s| same_scope(s, q)).collect(),
                None => Vec::new(),
            }
        }

        CallKind::SelfMethod => {
            let own: Vec<&Symbol> = match caller.parent.as_deref().map(last_segment) {
                Some(scope) => named
                    .iter()
                    .filter(|s| s.kind == SymbolKind::Method && same_scope(s, scope))
                    .collect(),
                None => Vec::new(),
            };
            if own.is_empty() {
                named.iter().filter(|s| s.kind == SymbolKind::Method).collect()
            } else {
                own
            }
        }

        CallKind::Method => named.iter().filter(|s| s.kind == SymbolKind::Method).collect(),
    }
}

/// A bare `foo()` most likely means the `foo` next to the caller.
fn prefer_same_file<'a>(caller: &Symbol, candidates: Vec<&'a Symbol>) -> Vec<&'a Symbol> {
    let local: Vec<&Symbol> = candidates.iter().copied().filter(|s| s.file == caller.file).collect();
    if local.is_empty() { candidates } else { local }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(file: &str, qualified: &str, kind: SymbolKind) -> Symbol {
        let (parent, name) = match qualified.rsplit_once("::") {
            Some((p, n)) => (Some(p.to_string()), n.to_string()),
            None => (None, qualified.to_string()),
        };
        Symbol {
            id: format!("{file}::{qualified}::{}", kind.as_str()),
            file: file.into(),
            kind,
            name,
            qualified_name: qualified.into(),
            signature: String::new(),
            start_byte: 0,
            end_byte: 0,
            start_line: 1,
            end_line: 1,
            parent,
            body_hash: String::new(),
            summary: None,
            summary_hash: None,
        }
    }

    fn call(name: &str, qualifier: Option<&str>, kind: CallKind) -> CallRef {
        CallRef { from: String::new(), name: name.into(), qualifier: qualifier.map(Into::into), kind }
    }

    fn ids(found: Vec<&Symbol>) -> Vec<String> {
        found.into_iter().map(|s| s.qualified_name.clone()).collect()
    }

    #[test]
    fn bare_call_prefers_the_same_file() {
        let caller = sym("a.rs", "main", SymbolKind::Function);
        let named = vec![sym("b.rs", "go", SymbolKind::Function), sym("a.rs", "go", SymbolKind::Function)];
        let found = resolve(&caller, &call("go", None, CallKind::Bare), &named);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file, "a.rs");
        // nothing local: every function with that name
        let caller = sym("c.rs", "main", SymbolKind::Function);
        assert_eq!(resolve(&caller, &call("go", None, CallKind::Bare), &named).len(), 2);
    }

    #[test]
    fn path_call_matches_the_type_or_module() {
        let caller = sym("a.rs", "Foo::run", SymbolKind::Method);
        let named = vec![
            sym("a.rs", "Foo::new", SymbolKind::Method),
            sym("a.rs", "Bar::new", SymbolKind::Method),
            sym("a.rs", "util::new", SymbolKind::Function),
        ];
        assert_eq!(ids(resolve(&caller, &call("new", Some("Bar"), CallKind::Path), &named)), ["Bar::new"]);
        assert_eq!(ids(resolve(&caller, &call("new", Some("Self"), CallKind::Path), &named)), ["Foo::new"]);
        assert_eq!(ids(resolve(&caller, &call("new", Some("util"), CallKind::Path), &named)), ["util::new"]);
        assert!(resolve(&caller, &call("new", Some("String"), CallKind::Path), &named).is_empty());
    }

    #[test]
    fn self_method_prefers_own_type_then_any_method() {
        let caller = sym("a.rs", "Foo::run", SymbolKind::Method);
        let named = vec![sym("a.rs", "Foo::step", SymbolKind::Method), sym("a.rs", "Bar::step", SymbolKind::Method)];
        assert_eq!(ids(resolve(&caller, &call("step", None, CallKind::SelfMethod), &named)), ["Foo::step"]);
        let named = vec![sym("a.rs", "Bar::step", SymbolKind::Method)]; // e.g. a trait default
        assert_eq!(ids(resolve(&caller, &call("step", None, CallKind::SelfMethod), &named)), ["Bar::step"]);
    }

    #[test]
    fn value_method_call_matches_every_method_with_that_name() {
        let caller = sym("a.rs", "main", SymbolKind::Function);
        let named = vec![
            sym("a.rs", "A::run", SymbolKind::Method),
            sym("a.rs", "B::run", SymbolKind::Method),
            sym("a.rs", "run", SymbolKind::Function), // a free fn cannot be `x.run()`
        ];
        assert_eq!(ids(resolve(&caller, &call("run", None, CallKind::Method), &named)), ["A::run", "B::run"]);
    }
}
