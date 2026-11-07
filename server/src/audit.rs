//! Structured audit logging to NDJSON. Secret content never appears here, only
//! fingerprints and metadata. Every event is retained: dropping or sampling
//! would let someone hide secret reads by generating noise.

use crate::auth::Session;
use crate::util::redact_secret_id;
use serde::Serialize;
use std::io::Write;
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Success,
    Failure,
    Denied,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuditEvent {
    #[serde(with = "time::serde::rfc3339")]
    pub timestamp: OffsetDateTime,
    pub event: &'static str,
    pub outcome: Outcome,
    pub client_ip: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub secret_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub user_email: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub user_subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_time: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_seconds: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_auth: Option<bool>,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub error: &'static str,
}

pub struct AuditLogger {
    output: Mutex<Box<dyn Write + Send>>,
}

impl AuditLogger {
    pub fn new(output: Box<dyn Write + Send>) -> Self {
        Self {
            output: Mutex::new(output),
        }
    }

    /// Appends to `path` (created private), or writes to stdout when it is `None`.
    pub fn open(path: Option<&str>) -> std::io::Result<Self> {
        let output: Box<dyn Write + Send> = match path {
            None => Box::new(std::io::stdout()),
            Some(path) => {
                use std::os::unix::fs::OpenOptionsExt;
                Box::new(
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .mode(0o600)
                        .open(path)?,
                )
            }
        };
        Ok(Self::new(output))
    }

    pub fn log(&self, event: &AuditEvent) {
        let Ok(mut line) = serde_json::to_vec(event) else {
            tracing::error!("failed to encode audit event");
            return;
        };
        line.push(b'\n');
        let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        // One write call per record keeps lines whole in an O_APPEND file.
        if let Err(error) = output.write_all(&line).and_then(|()| output.flush()) {
            tracing::error!(error = %error, "failed to write audit event");
        }
    }
}

/// Emits audit events for one request. It carries the fields shared by every
/// event a handler logs, so call sites only state the outcome and reason.
#[derive(Clone)]
pub struct Auditor {
    logger: Option<Arc<AuditLogger>>,
    event: &'static str,
    client_ip: String,
    secret_id: String,
    user_email: String,
    user_subject: String,
}

/// The optional fields of one audit record.
#[derive(Clone, Copy, Default)]
pub struct Fields {
    pub one_time: Option<bool>,
    pub expiration: Option<i32>,
    pub require_auth: Option<bool>,
}

impl Auditor {
    pub fn new(
        logger: Option<Arc<AuditLogger>>,
        event: &'static str,
        client_ip: String,
        session: Option<&Session>,
    ) -> Self {
        Self {
            logger,
            event,
            client_ip,
            secret_id: String::new(),
            user_email: session.map(|s| s.email.clone()).unwrap_or_default(),
            user_subject: session.map(|s| s.sub.clone()).unwrap_or_default(),
        }
    }

    /// Attaches the fingerprint of `id`; the raw key is never stored.
    pub fn set_secret_id(&mut self, id: &str) {
        self.secret_id = redact_secret_id(id);
    }

    pub fn set_user(&mut self, email: &str, subject: &str) {
        self.user_email = email.to_owned();
        self.user_subject = subject.to_owned();
    }

    /// A copy logging under another name, for secondary events like cleanup failures.
    pub fn with_event(&self, event: &'static str) -> Self {
        Self {
            event,
            ..self.clone()
        }
    }

    fn log(&self, outcome: Outcome, error: &'static str, fields: Fields) {
        if let Some(logger) = &self.logger {
            logger.log(&AuditEvent {
                timestamp: OffsetDateTime::now_utc(),
                event: self.event,
                outcome,
                client_ip: self.client_ip.clone(),
                secret_id: self.secret_id.clone(),
                user_email: self.user_email.clone(),
                user_subject: self.user_subject.clone(),
                one_time: fields.one_time,
                expiration_seconds: fields.expiration,
                require_auth: fields.require_auth,
                error,
            });
        }
    }

    pub fn success(&self, fields: Fields) {
        self.log(Outcome::Success, "", fields);
    }

    pub fn failure(&self, reason: &'static str) {
        self.log(Outcome::Failure, reason, Fields::default());
    }

    pub fn failure_with(&self, reason: &'static str, fields: Fields) {
        self.log(Outcome::Failure, reason, fields);
    }

    pub fn denied(&self, reason: &'static str) {
        self.log(Outcome::Denied, reason, Fields::default());
    }

    pub fn denied_with(&self, reason: &'static str, fields: Fields) {
        self.log(Outcome::Denied, reason, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn event(name: &'static str) -> AuditEvent {
        AuditEvent {
            timestamp: OffsetDateTime::now_utc(),
            event: name,
            outcome: Outcome::Success,
            client_ip: "203.0.113.9".into(),
            secret_id: String::new(),
            user_email: String::new(),
            user_subject: String::new(),
            one_time: None,
            expiration_seconds: None,
            require_auth: None,
            error: "",
        }
    }

    #[test]
    fn file_output_is_private_and_appends_whole_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.log");
        let path = path.to_str().unwrap();
        AuditLogger::open(Some(path)).unwrap().log(&event("first"));
        // A restart appends rather than truncating the trail.
        AuditLogger::open(Some(path)).unwrap().log(&event("second"));
        let text = std::fs::read_to_string(path).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["event"], "first");
        assert_eq!(lines[1]["event"], "second");
        // Optional fields are omitted rather than written empty.
        assert!(lines[0].get("secret_id").is_none());
        assert!(lines[0].get("error").is_none());
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_uncreatable_file_is_an_error_and_stdout_always_opens() {
        assert!(AuditLogger::open(Some("/nonexistent/dir/audit.log")).is_err());
        assert!(AuditLogger::open(None).is_ok());
    }

    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("disk full"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_failing_writer_does_not_take_the_request_down() {
        AuditLogger::new(Box::new(Broken)).log(&event("lost"));
    }
}
