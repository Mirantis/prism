//! The deferred tools one request sends, searchable by exact name or by keywords.
//! Built per request from the tools block, so it follows every change to the
//! connected servers.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::IndexSet;
use regex::Regex;

use crate::lib::llm_providers::llm_provider::{DeferredToolDefinition, ToolLoad, ToolLoadRequest};
use crate::lib::tool_search::catalog::locale_compare;

/// Tools a `query` loads.
pub const QUERY_LOAD_COUNT: usize = 5;
/// Tools one call may load by name.
pub const MAX_NAMED_LOADS: usize = 20;
const SUGGESTION_COUNT: usize = 3;

/// BM25 constants, at their usual values.
const K1: f64 = 1.2;
const B: f64 = 0.75;

static CAMEL_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

pub fn search_tokens(text: &str) -> Vec<String> {
    let spaced = CAMEL_BOUNDARY.replace_all(text, "$1 $2");
    let lower = spaced.to_lowercase();
    NON_WORD
        .split(&lower)
        .filter(|token| token.len() > 1)
        .map(str::to_string)
        .collect()
}

/// The name segment after the last `__`: the tool's own name on its server.
pub fn bare_tool_name(name: &str) -> &str {
    match name.rfind("__") {
        Some(at) => &name[at + 2..],
        None => name,
    }
}

struct Document {
    definition: DeferredToolDefinition,
    terms: HashMap<String, usize>,
    length: usize,
}

pub struct ToolIndex {
    by_name: HashMap<String, usize>,
    documents: Vec<Document>,
    document_frequency: HashMap<String, usize>,
    average_length: f64,
}

impl ToolIndex {
    pub fn new(definitions: &[DeferredToolDefinition]) -> Self {
        let mut by_name = HashMap::new();
        let mut documents = Vec::with_capacity(definitions.len());
        let mut document_frequency: HashMap<String, usize> = HashMap::new();
        for definition in definitions {
            // The name counts twice: it is the most specific text a tool has.
            let name_tokens = search_tokens(&definition.name);
            let mut tokens = name_tokens.clone();
            tokens.extend(name_tokens);
            tokens.extend(search_tokens(&definition.description));
            let mut terms: HashMap<String, usize> = HashMap::new();
            for token in &tokens {
                *terms.entry(token.clone()).or_insert(0) += 1;
            }
            for term in terms.keys() {
                *document_frequency.entry(term.clone()).or_insert(0) += 1;
            }
            // A later definition with the same name answers to it, as a map set does.
            by_name.insert(definition.name.clone(), documents.len());
            documents.push(Document {
                definition: definition.clone(),
                terms,
                length: tokens.len(),
            });
        }
        let total: usize = documents.iter().map(|document| document.length).sum();
        let average_length = if documents.is_empty() {
            1.0
        } else {
            total as f64 / documents.len() as f64
        };
        Self {
            by_name,
            documents,
            document_frequency,
            average_length,
        }
    }

    pub fn size(&self) -> usize {
        self.documents.len()
    }

    pub fn definition(&self, name: &str) -> Option<DeferredToolDefinition> {
        self.by_name
            .get(name)
            .map(|index| self.documents[*index].definition.clone())
    }

    /// The best matches for `query`, best first.
    pub fn search(&self, query: &str, limit: usize) -> Vec<String> {
        let terms: IndexSet<String> = search_tokens(query).into_iter().collect();
        if terms.is_empty() {
            return Vec::new();
        }
        let count = self.documents.len() as f64;
        let mut scored: Vec<(String, f64)> = Vec::new();
        for document in &self.documents {
            let mut score = 0.0;
            for term in &terms {
                let Some(frequency) = document.terms.get(term).copied().filter(|f| *f > 0) else {
                    continue;
                };
                let frequency = frequency as f64;
                let documents = self.document_frequency.get(term).copied().unwrap_or(0) as f64;
                let idf = (1.0 + (count - documents + 0.5) / (documents + 0.5)).ln();
                let norm = K1 * (1.0 - B + (B * document.length as f64) / self.average_length);
                score += (idf * frequency * (K1 + 1.0)) / (frequency + norm);
            }
            if score > 0.0 {
                scored.push((document.definition.name.clone(), score));
            }
        }
        scored.sort_by(
            |a, b| match b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal) {
                Ordering::Equal => locale_compare(&a.0, &b.0),
                other => other,
            },
        );
        scored
            .into_iter()
            .take(limit)
            .map(|(name, _)| name)
            .collect()
    }

    /// The deferred tool a requested name means: the exact name, else a
    /// case-insensitive match, else the one tool whose own name it is.
    fn resolve(&self, requested: &str) -> Option<String> {
        if self.by_name.contains_key(requested) {
            return Some(requested.to_string());
        }
        let lower = requested.to_lowercase();
        let caseless: Vec<&Document> = self
            .documents
            .iter()
            .filter(|d| d.definition.name.to_lowercase() == lower)
            .collect();
        if caseless.len() == 1 {
            return Some(caseless[0].definition.name.clone());
        }
        let bare: Vec<&Document> = self
            .documents
            .iter()
            .filter(|d| bare_tool_name(&d.definition.name).to_lowercase() == lower)
            .collect();
        if bare.len() == 1 {
            Some(bare[0].definition.name.clone())
        } else {
            None
        }
    }

    pub fn load(&self, request: &ToolLoadRequest) -> ToolLoad {
        let mut loaded: Vec<String> = Vec::new();
        let mut unmatched: Vec<String> = Vec::new();
        let add = |loaded: &mut Vec<String>, name: String| {
            if !loaded.contains(&name) {
                loaded.push(name);
            }
        };
        for requested in request.names.iter().flatten().take(MAX_NAMED_LOADS) {
            match self.resolve(requested.trim()) {
                Some(name) => add(&mut loaded, name),
                None => unmatched.push(requested.clone()),
            }
        }
        let query = request.query.as_deref().map(str::trim).unwrap_or("");
        if !query.is_empty() {
            let matches = self.search(query, QUERY_LOAD_COUNT);
            if matches.is_empty() {
                unmatched.push(query.to_string());
            }
            for name in matches {
                add(&mut loaded, name);
            }
        }
        let suggestions = if loaded.is_empty() {
            let unique: IndexSet<String> = unmatched
                .iter()
                .flat_map(|text| self.search(text, SUGGESTION_COUNT))
                .collect();
            unique.into_iter().take(SUGGESTION_COUNT).collect()
        } else {
            Vec::new()
        };
        ToolLoad {
            loaded,
            unmatched,
            suggestions,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn define(name: &str, description: &str) -> DeferredToolDefinition {
        DeferredToolDefinition {
            name: name.into(),
            description: description.into(),
            parameters: json!({ "type": "object", "properties": {} })
                .as_object()
                .unwrap()
                .clone(),
        }
    }

    fn index() -> ToolIndex {
        ToolIndex::new(&[
            define(
                "nexus__github__create_issue",
                "Create a new issue in a GitHub repository.",
            ),
            define(
                "nexus__github__list_pull_requests",
                "List pull requests in a repository.",
            ),
            define("nexus__gmail__send_email", "Send an email message."),
            define(
                "nexus__gmail__search_threads",
                "Search mail threads by query.",
            ),
            define(
                "notes__notion__create_page",
                "Create a page in a Notion workspace.",
            ),
        ])
    }

    fn names(names: &[&str]) -> ToolLoadRequest {
        ToolLoadRequest {
            names: Some(names.iter().map(|n| n.to_string()).collect()),
            query: None,
        }
    }

    fn query(query: &str) -> ToolLoadRequest {
        ToolLoadRequest {
            names: None,
            query: Some(query.into()),
        }
    }

    #[test]
    fn loads_an_exact_name_a_different_case_of_one_and_a_tool_by_its_own_name_on_its_server() {
        assert_eq!(
            index()
                .load(&names(&[
                    "nexus__github__create_issue",
                    "NEXUS__GMAIL__SEND_EMAIL",
                    "create_page"
                ]))
                .loaded,
            [
                "nexus__github__create_issue",
                "nexus__gmail__send_email",
                "notes__notion__create_page"
            ]
        );
    }

    #[test]
    fn reports_an_unknown_name_with_the_nearest_tools() {
        let result = index().load(&names(&["send_mail"]));
        assert!(result.loaded.is_empty());
        assert_eq!(result.unmatched, ["send_mail"]);
        assert_eq!(result.suggestions[0], "nexus__gmail__send_email");
    }

    #[test]
    fn loads_the_best_matches_of_a_query_best_first() {
        assert_eq!(
            index().load(&query("open an issue on github")).loaded[0],
            "nexus__github__create_issue"
        );
        assert_eq!(
            index().load(&query("email")).loaded,
            ["nexus__gmail__send_email"]
        );
    }

    #[test]
    fn caps_what_one_call_loads() {
        let many = ToolIndex::new(
            &(0..40)
                .map(|i| define(&format!("s__repo_tool_{i}"), "Read a repository."))
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            many.load(&query("repository")).loaded.len(),
            QUERY_LOAD_COUNT
        );
        let found = many.search("repository", 40);
        let request = ToolLoadRequest {
            names: Some(found),
            query: None,
        };
        assert_eq!(many.load(&request).loaded.len(), MAX_NAMED_LOADS);
    }

    #[test]
    fn reports_a_query_that_matches_nothing() {
        assert_eq!(
            index().load(&query("kubernetes")),
            ToolLoad {
                loaded: Vec::new(),
                unmatched: vec!["kubernetes".into()],
                suggestions: Vec::new(),
            }
        );
    }
}
