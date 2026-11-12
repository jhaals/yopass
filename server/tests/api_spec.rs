//! Keeps docs/openapi.yaml and the router in step: a route added or removed
//! without updating the spec fails here.

mod common;

use common::*;
use serde_json::Value;
use std::collections::BTreeSet;

const SPEC: &str = include_str!("../../docs/openapi.yaml");
const ROUTER_SOURCE: &str = include_str!("../src/app.rs");

/// Routes the spec leaves out on purpose: ops, the metrics listener and the
/// OIDC browser flow.
const NOT_IN_SPEC: &[&str] = &[
    "/health",
    "/ready",
    "/version",
    "/logo",
    "/metrics",
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    "/auth/me",
];

const METHODS: &[&str] = &["get", "post", "put", "delete"];

fn spec() -> Value {
    serde_yaml_ng::from_str(SPEC).expect("docs/openapi.yaml is not valid YAML")
}

/// Every `(METHOD, path)` the spec documents.
fn operations(spec: &Value) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for (path, item) in spec["paths"].as_object().expect("paths") {
        for method in METHODS {
            if item.get(*method).is_some() {
                found.push((method.to_uppercase(), path.clone()));
            }
        }
    }
    found
}

/// Every `(METHOD, path)` the router registers.
///
/// shortcut: reads the path literal after each `.route(` and the `get(`, `post(`,
/// `put(` and `delete(` calls up to the next one, so a route built any other way
/// (a loop, a macro, a variable) goes unseen. Upgrade by exposing the route
/// table from the router if that ever happens.
fn router_operations() -> BTreeSet<(String, String)> {
    // Stop at the unit tests, which build their own routers.
    let source = ROUTER_SOURCE.split("#[cfg(test)]").next().unwrap();
    let mut found = BTreeSet::new();
    for rest in source.split(".route(").skip(1) {
        let Some(rest) = rest.trim_start().strip_prefix('"') else {
            continue;
        };
        let Some(end) = rest.find('"') else { continue };
        let (path, handlers) = (&rest[..end], &rest[end..]);
        for method in METHODS {
            let call = format!("{method}(");
            // Not preceded by a name character, so `forget(` or `get_x(` do not count.
            let is_call = handlers
                .match_indices(&call)
                .any(|(i, _)| !handlers[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_'));
            if is_call {
                found.insert((method.to_uppercase(), path.to_owned()));
            }
        }
    }
    found
}

#[test]
fn spec_is_structurally_valid_openapi_3() {
    let spec = spec();
    assert!(
        spec["openapi"]
            .as_str()
            .is_some_and(|v| v.starts_with("3."))
    );
    assert!(spec["info"]["title"].is_string() && spec["info"]["version"].is_string());

    let operations = operations(&spec);
    assert!(!operations.is_empty());
    for (method, path) in &operations {
        let operation = &spec["paths"][path][method.to_lowercase()];
        assert!(
            operation["responses"]
                .as_object()
                .is_some_and(|r| !r.is_empty()),
            "{method} {path} has no responses"
        );
        assert!(
            operation["operationId"].is_string(),
            "{method} {path} has no operationId"
        );
        // Every `{name}` in the path needs a parameter, here or on the path item.
        let declared: Vec<&Value> = spec["paths"][path]["parameters"]
            .as_array()
            .into_iter()
            .chain(operation["parameters"].as_array())
            .flatten()
            .collect();
        for segment in path.split('/').filter(|s| s.starts_with('{')) {
            let name = segment.trim_matches(|c| c == '{' || c == '}');
            assert!(
                declared.iter().any(|p| p["name"] == name
                    || p["$ref"]
                        .as_str()
                        .is_some_and(|r| { r.to_lowercase().ends_with(&format!("/{name}")) })),
                "{method} {path}: no `{name}` parameter"
            );
        }
    }

    let mut refs = Vec::new();
    collect_refs(&spec, &mut refs);
    for target in refs {
        let pointer = target.strip_prefix('#').expect("only local $refs");
        assert!(spec.pointer(pointer).is_some(), "dangling $ref {target}");
    }
}

fn collect_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                match child {
                    Value::String(target) if key == "$ref" => out.push(target.clone()),
                    _ => collect_refs(child, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, out)),
        _ => {}
    }
}

#[tokio::test]
async fn every_documented_operation_is_answered_by_a_route() {
    // Licensed, with uploads and prefetch on (the defaults), so every route exists.
    let harness = Builder::new().licensed().build();
    for (method, path) in operations(&spec()) {
        let url = path.replace("{key}", UUID_KEY);
        let response = harness.send(req(&method, &url)).await;
        // An unmatched route falls through to the static-file 404 page.
        assert_ne!(
            response.text(),
            "404 page not found\n",
            "{method} {path} is in the spec but the server has no such route"
        );
    }
}

#[test]
fn every_server_route_is_documented_or_excluded() {
    let documented: BTreeSet<(String, String)> = operations(&spec()).into_iter().collect();
    let routes = router_operations();
    assert!(routes.len() > 10, "route parser found {routes:?}");
    for (method, path) in &routes {
        assert!(
            documented.contains(&(method.clone(), path.clone()))
                || NOT_IN_SPEC.contains(&path.as_str()),
            "route {method} {path} is neither in docs/openapi.yaml nor in NOT_IN_SPEC"
        );
    }
    // The other direction: a documented operation the router no longer registers.
    for (method, path) in &documented {
        assert!(
            routes.contains(&(method.clone(), path.clone())),
            "{method} {path} is documented but not routed"
        );
    }
}
