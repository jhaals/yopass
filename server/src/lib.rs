//! Yopass server, Rust implementation (published as `jhaals/yopass:latest`).
//!
//! The wire contract and stored data format match the Go server in `pkg/server`.

pub mod app;
pub mod armor;
pub mod audit;
pub mod auth;
pub mod config;
pub mod db;
pub mod files;
pub mod handlers;
pub mod license;
pub mod lifecycle;
pub mod metrics;
pub mod serve;
pub mod server;
pub mod util;
pub mod webhook;
