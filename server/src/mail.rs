//! Emails a secret's creator when it is first viewed, and a request's creator
//! when it is fulfilled. Delivery follows the webhook model: a bounded queue and
//! one background worker, so handlers never wait on the mail server and a mail
//! that cannot be sent is logged and dropped.
//!
//! Addresses are stored sealed next to the receipt or request they belong to and
//! only opened here. Mails never carry a link to a secret.

use crate::auth::{CookieCodec, SEAL_MARGIN};
use crate::lifecycle::Receipt;
use crate::metrics::delivery_counter;
use crate::util::{generate_id, redact_secret_id};
use lettre::Message;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::{Credentials, DEFAULT_MECHANISMS};
use lettre::transport::smtp::client::{AsyncSmtpConnection, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use prometheus::{CounterVec, Registry};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc2822;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub const MAX_LABEL_LENGTH: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpTls {
    /// Upgrade with STARTTLS and refuse to continue without it.
    Starttls,
    /// TLS from the first byte.
    Implicit,
    /// Plaintext, for a relay on a trusted network.
    None,
}

impl std::str::FromStr for SmtpTls {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "starttls" => Ok(Self::Starttls),
            "implicit" => Ok(Self::Implicit),
            "none" => Ok(Self::None),
            _ => Err("expected starttls, implicit or none".into()),
        }
    }
}

#[derive(Clone)]
pub struct MailConfig {
    pub host: String,
    /// The usual port of the TLS mode when unset: 587, 465 or 25.
    pub port: Option<u16>,
    pub username: String,
    pub password: String,
    pub from: String,
    pub tls: SmtpTls,
    pub app_name: String,
    /// Where the creator uses this instance; shown in the mail when known.
    pub public_url: String,
    /// Seals addresses at rest.
    pub sealer: CookieCodec,
    pub max_attempts: u32,
    /// Bounds one whole delivery attempt, from connecting to the last reply.
    pub timeout: Duration,
    pub backoff: Duration,
    pub queue_size: usize,
}

impl MailConfig {
    pub fn new(host: impl Into<String>, from: impl Into<String>, sealer: CookieCodec) -> Self {
        Self {
            host: host.into(),
            port: None,
            username: String::new(),
            password: String::new(),
            from: from.into(),
            tls: SmtpTls::Starttls,
            app_name: String::new(),
            public_url: String::new(),
            sealer,
            max_attempts: 3,
            timeout: Duration::from_secs(30),
            backoff: Duration::from_secs(2),
            queue_size: 256,
        }
    }
}

/// Whether `value` works as a sender address. A display name is accepted but
/// not used: mails are sent under the app name.
pub fn is_valid_sender(value: &str) -> bool {
    value.parse::<Mailbox>().is_ok()
}

/// Whether mail can be addressed to `email`. Checked at opt-in, so an address
/// the mailer would refuse is reported then, not dropped at the first view.
pub fn is_valid_recipient(email: &str) -> bool {
    email.parse::<lettre::Address>().is_ok()
}

/// What is sealed into a receipt or request record.
#[derive(Serialize, Deserialize)]
struct Recipient {
    email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    label: String,
}

/// How one delivery attempt ended.
enum Attempt {
    Delivered,
    /// Nothing reached the server, or it refused for now.
    Retry,
    /// Refused for good, or the outcome is unknown.
    GiveUp,
}

struct Mail {
    event: &'static str,
    secret_id: String,
    message: Message,
}

struct Shared {
    host: String,
    port: u16,
    tls: SmtpTls,
    /// Absent only for plaintext.
    tls_parameters: Option<TlsParameters>,
    credentials: Option<Credentials>,
    from: Mailbox,
    app_name: String,
    public_url: String,
    sealer: CookieCodec,
    max_attempts: u32,
    timeout: Duration,
    backoff: Duration,
    queue: mpsc::Sender<Mail>,
    deliveries: Option<CounterVec>,
}

#[derive(Clone)]
pub struct Mailer {
    shared: Arc<Shared>,
    stop: CancellationToken,
    tasks: TaskTracker,
}

/// Binds a sealed value to its record, so it cannot be moved to another one.
fn seal_name(id: &str) -> String {
    format!("notify/{id}")
}

fn timestamp(unix: i64) -> String {
    OffsetDateTime::from_unix_timestamp(unix)
        .ok()
        .and_then(|at| at.format(&Rfc2822).ok())
        .unwrap_or_default()
}

impl Mailer {
    /// Validates the configuration and starts the delivery worker. Nothing
    /// connects to the mail server until the first mail.
    pub fn start(config: MailConfig, registry: Option<&Registry>) -> Result<Self, String> {
        let sender: Mailbox = config
            .from
            .parse()
            .map_err(|_| "SMTP from address is not a valid email address".to_owned())?;
        let app_name = if config.app_name.is_empty() {
            "Yopass".to_owned()
        } else {
            config.app_name
        };
        let from = Mailbox::new(Some(app_name.clone()), sender.email);
        let tls_parameters = match config.tls {
            SmtpTls::None => None,
            SmtpTls::Starttls | SmtpTls::Implicit => Some(
                TlsParameters::new(config.host.clone())
                    .map_err(|error| format!("invalid SMTP configuration: {error}"))?,
            ),
        };
        let port = config.port.unwrap_or(match config.tls {
            SmtpTls::Starttls => 587,
            SmtpTls::Implicit => 465,
            SmtpTls::None => 25,
        });
        let credentials = (!config.username.is_empty())
            .then(|| Credentials::new(config.username, config.password));
        let deliveries = registry.map(|registry| {
            delivery_counter(
                registry,
                "yopass_email_deliveries_total",
                "Email notifications by event name and outcome (delivered, failed, dropped).",
            )
        });
        let (queue, receiver) = mpsc::channel(config.queue_size);
        let mailer = Self {
            shared: Arc::new(Shared {
                host: config.host,
                port,
                tls: config.tls,
                tls_parameters,
                credentials,
                from,
                app_name,
                public_url: config.public_url.trim_end_matches('/').to_owned(),
                sealer: config.sealer,
                max_attempts: config.max_attempts,
                timeout: config.timeout,
                backoff: config.backoff,
                queue,
                deliveries,
            }),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
        };
        mailer.tasks.spawn(mailer.clone().delivery_worker(receiver));
        mailer.tasks.close();
        Ok(mailer)
    }

    /// Drops queued mails and abandons a delivery in flight, counting each.
    pub async fn stop(&self) {
        self.stop.cancel();
        self.tasks.wait().await;
    }

    /// Seals the address to notify about record `id`, and the label to show in
    /// that mail, for storage with the record. `lifetime` is the record's, in
    /// seconds.
    pub fn seal(&self, id: &str, email: &str, label: &str, lifetime: i32) -> String {
        let recipient = Recipient {
            email: email.to_owned(),
            label: label.to_owned(),
        };
        // The record's own TTL decides how long the value lives.
        self.shared
            .sealer
            .seal(
                &seal_name(id),
                &recipient,
                i64::from(lifetime) + SEAL_MARGIN,
            )
            .expect("two strings always serialize and encrypt")
    }

    /// `receipt` is the one just marked viewed, still holding its sealed address.
    pub(crate) fn secret_viewed(&self, id: &str, kind: &str, receipt: &Receipt) {
        let event = "secret.viewed";
        let sealed = receipt.notify.as_deref();
        let Some(recipient) = sealed.and_then(|sealed| self.open(event, id, sealed)) else {
            return;
        };
        let mut body = "A secret you shared was viewed.\n\n".to_owned();
        if !recipient.label.is_empty() {
            body += &format!("Label: {}\n", recipient.label);
        }
        body += &format!(
            "Kind: {kind}\nOne-time: {}\nCreated: {}\nViewed: {}\nID: {}\n",
            if receipt.one_time { "yes" } else { "no" },
            timestamp(receipt.created_at),
            timestamp(receipt.viewed_at),
            redact_secret_id(id),
        );
        if !self.shared.public_url.is_empty() {
            body += &format!("\n{}\n", self.shared.public_url);
        }
        self.enqueue(event, id, &recipient.email, "your secret was viewed", body);
    }

    /// The mail has no label: request labels are not the server's to read.
    pub fn request_fulfilled(
        &self,
        id: &str,
        sealed: &str,
        kind: &str,
        created_at: i64,
        fulfilled_at: i64,
    ) {
        let event = "request.fulfilled";
        let Some(recipient) = self.open(event, id, sealed) else {
            return;
        };
        let mut body = format!(
            "A secret request you created was fulfilled.\n\nKind: {kind}\nCreated: {}\nFulfilled: {}\nID: {}\n\nCollect the secret from your request list, in the browser that created the request.\n",
            timestamp(created_at),
            timestamp(fulfilled_at),
            redact_secret_id(id),
        );
        if !self.shared.public_url.is_empty() {
            body += &format!("{}/#/requests\n", self.shared.public_url);
        }
        self.enqueue(
            event,
            id,
            &recipient.email,
            "your secret request was fulfilled",
            body,
        );
    }

    /// Mails a recipient the code that opens restricted secret `id`. Returns
    /// whether the mail was queued; delivery failures are logged and counted.
    pub fn recipient_code(&self, id: &str, to: &str, code: &str, valid_until: i64) -> bool {
        let body = format!(
            "Your code to open a secret on {}:\n\n    {code}\n\nIt is valid until {} and works once.\nNever share this code with anyone.\n\nIf you did not ask for it, ignore this email.\n",
            self.shared.app_name,
            timestamp(valid_until),
        );
        self.enqueue("recipient.code", id, to, "your one-time code", body)
    }

    fn count(&self, event: &str, outcome: &str) {
        if let Some(deliveries) = &self.shared.deliveries {
            deliveries.with_label_values(&[event, outcome]).inc();
        }
    }

    fn open(&self, event: &'static str, id: &str, sealed: &str) -> Option<Recipient> {
        let recipient = self.shared.sealer.open(&seal_name(id), sealed);
        if recipient.is_none() {
            tracing::warn!(
                event,
                secret_id = redact_secret_id(id),
                "mail: stored address cannot be read (was the session key changed?), not notifying"
            );
            self.count(event, "dropped");
        }
        recipient
    }

    /// Returns whether the mail was queued.
    fn enqueue(
        &self,
        event: &'static str,
        id: &str,
        to: &str,
        subject: &str,
        body: String,
    ) -> bool {
        let secret_id = redact_secret_id(id);
        let message = to.parse().ok().and_then(|address| {
            Message::builder()
                .from(self.shared.from.clone())
                .to(Mailbox::new(None, address))
                .subject(format!("{}: {subject}", self.shared.app_name))
                // The sender's domain: the default would be "localhost", which
                // spam filters count against a mail.
                .message_id(Some(format!(
                    "<{}@{}>",
                    generate_id(),
                    self.shared.from.email.domain()
                )))
                .header(ContentType::TEXT_PLAIN)
                .body(body)
                .ok()
        });
        let Some(message) = message else {
            tracing::warn!(
                event,
                secret_id,
                "mail: cannot build message, not notifying"
            );
            self.count(event, "dropped");
            return false;
        };
        let mail = Mail {
            event,
            secret_id,
            message,
        };
        let Err(error) = self.shared.queue.try_send(mail) else {
            return true;
        };
        // Closed means the delivery worker is gone, normally after stop(), not a flood.
        let (message, mail) = match error {
            mpsc::error::TrySendError::Full(mail) => ("mail: queue full, dropping mail", mail),
            mpsc::error::TrySendError::Closed(mail) => {
                ("mail: mailer stopped, dropping mail", mail)
            }
        };
        tracing::error!(event, secret_id = mail.secret_id, "{message}");
        self.count(event, "dropped");
        false
    }

    async fn delivery_worker(self, mut receiver: mpsc::Receiver<Mail>) {
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => {
                    while let Ok(mail) = receiver.try_recv() {
                        self.abandon(&mail);
                    }
                    return;
                }
                mail = receiver.recv() => match mail {
                    Some(mail) => self.deliver(mail).await,
                    None => return,
                },
            }
        }
    }

    async fn deliver(&self, mail: Mail) {
        let mut backoff = self.shared.backoff;
        for attempt in 1..=self.shared.max_attempts {
            let submitting = AtomicBool::new(false);
            // Only connecting has a timeout of its own: a server that accepts
            // and then goes quiet would hold the one worker forever.
            let outcome = tokio::select! {
                outcome = tokio::time::timeout(
                    self.shared.timeout,
                    self.attempt(&mail, &submitting),
                ) => outcome,
                // Shutdown does not wait on a mail server that may never answer.
                _ = self.stop.cancelled() => return self.abandon(&mail),
            };
            match outcome {
                Ok(Attempt::Delivered) => {
                    self.count(mail.event, "delivered");
                    return;
                }
                Ok(Attempt::GiveUp) => break,
                Ok(Attempt::Retry) => {}
                Err(_) => {
                    tracing::warn!(
                        event = mail.event,
                        secret_id = mail.secret_id,
                        "mail: delivery attempt timed out"
                    );
                    if submitting.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
            if attempt < self.shared.max_attempts {
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => backoff *= 2,
                    _ = self.stop.cancelled() => return self.abandon(&mail),
                }
            }
        }
        tracing::error!(
            event = mail.event,
            secret_id = mail.secret_id,
            "mail: delivery failed permanently"
        );
        self.count(mail.event, "failed");
    }

    /// Connects, sets up TLS as configured and signs in. Nothing of a mail is
    /// sent here, so whatever fails is safe to try again.
    async fn connect(&self) -> Result<AsyncSmtpConnection, lettre::transport::smtp::Error> {
        let shared = &self.shared;
        let hello = ClientId::default();
        // Connecting gets a third of an attempt's time, leaving the rest for
        // the conversation.
        let connect_timeout = Some(shared.timeout / 3);
        // Implicit TLS starts with the handshake; the other modes with the
        // server's greeting.
        let wrapper = match shared.tls {
            SmtpTls::Implicit => shared.tls_parameters.clone(),
            SmtpTls::Starttls | SmtpTls::None => None,
        };
        let server = (shared.host.as_str(), shared.port);
        let mut connection =
            AsyncSmtpConnection::connect_tokio1(server, connect_timeout, &hello, wrapper, None)
                .await?;
        if shared.tls == SmtpTls::Starttls
            && let Some(parameters) = &shared.tls_parameters
        {
            // An error when the server does not offer STARTTLS: there is no
            // carrying on in plaintext.
            connection.starttls(parameters.clone(), &hello).await?;
        }
        if let Some(credentials) = &shared.credentials {
            connection.auth(DEFAULT_MECHANISMS, credentials).await?;
        }
        Ok(connection)
    }

    /// One delivery attempt. `submitting` is set once the mail itself is on its
    /// way. From then on a failure without a refusal from the server may mean
    /// the server has the mail, and trying again would deliver a second copy.
    async fn attempt(&self, mail: &Mail, submitting: &AtomicBool) -> Attempt {
        let mut connection = match self.connect().await {
            Ok(connection) => connection,
            Err(error) => {
                self.log_failure(mail, &error);
                // Refused for good, as with a wrong password.
                return if error.is_permanent() {
                    Attempt::GiveUp
                } else {
                    Attempt::Retry
                };
            }
        };
        submitting.store(true, Ordering::Relaxed);
        let message = &mail.message;
        match connection
            .send(message.envelope(), &message.formatted())
            .await
        {
            Ok(_) => {
                // The mail is delivered. The goodbye is said on the side, so a
                // server slow to answer it cannot run out the attempt's time.
                // Shutdown does not wait for it.
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(1), connection.quit()).await;
                });
                Attempt::Delivered
            }
            Err(error) => {
                self.log_failure(mail, &error);
                // Only a temporary refusal says the server did not take the mail
                // and may take it later.
                if error.is_transient() {
                    Attempt::Retry
                } else {
                    Attempt::GiveUp
                }
            }
        }
    }

    fn log_failure(&self, mail: &Mail, error: &lettre::transport::smtp::Error) {
        let (event, secret_id) = (mail.event, &mail.secret_id);
        // What the server sent may quote the recipient, so a reply is logged by
        // its code and an unreadable one not at all. Connection and TLS errors
        // carry no address.
        match error.status() {
            Some(code) => {
                tracing::warn!(event, secret_id, smtp_status = %code, "mail: server refused the mail")
            }
            None if error.is_response() => {
                tracing::warn!(
                    event,
                    secret_id,
                    "mail: server sent a reply that cannot be read"
                )
            }
            None => {
                tracing::warn!(event, secret_id, error = %error, "mail: delivery attempt failed")
            }
        }
    }

    /// A mail still queued or in flight at shutdown. An interrupted delivery
    /// has an unknown outcome, so neither is reported as a failure.
    fn abandon(&self, mail: &Mail) {
        tracing::warn!(
            event = mail.event,
            secret_id = mail.secret_id,
            "mail: mailer stopped, dropping mail"
        );
        self.count(mail.event, "dropped");
    }
}
