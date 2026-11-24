//! A plaintext SMTP server that records the mails it accepts.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

pub struct Received {
    pub from: String,
    pub to: String,
    pub data: String,
}

/// It offers PLAIN authentication, accepting anything, and no STARTTLS.
#[derive(Clone, Default)]
pub struct Smtp {
    pub mails: Arc<Mutex<Vec<Received>>>,
    /// How many RCPT commands to answer with `reject_code` first.
    pub rejections: Arc<AtomicUsize>,
    pub reject_code: Arc<AtomicUsize>,
    pub attempts: Arc<AtomicUsize>,
    /// The credentials clients presented, as sent.
    pub logins: Arc<Mutex<Vec<String>>>,
    /// Answer every login with a permanent refusal.
    pub refuse_logins: Arc<AtomicBool>,
    /// Every command line received, mail content excluded.
    pub commands: Arc<Mutex<Vec<String>>>,
    /// What to do once a mail is taken: answer (the default), `HANG_UP`,
    /// `GO_QUIET`, or answer and then `IGNORE_QUIT`. Either way the mail counts
    /// as received.
    pub after_mail: Arc<AtomicUsize>,
}

/// A `reject_code` that makes the refusal unreadable.
pub const GARBLED: usize = 0;
pub const HANG_UP: usize = 1;
pub const GO_QUIET: usize = 2;
pub const IGNORE_QUIT: usize = 3;

impl Smtp {
    pub async fn start() -> (Self, u16) {
        let smtp = Self::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = smtp.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(server.clone().session(stream));
            }
        });
        (smtp, port)
    }

    async fn session(self, stream: tokio::net::TcpStream) {
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let (mut from, mut to) = (String::new(), String::new());
        write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
        while let Ok(Some(line)) = lines.next_line().await {
            self.commands.lock().unwrap().push(line.clone());
            let address = || {
                let start = line.find('<').unwrap() + 1;
                line[start..line.find('>').unwrap()].to_owned()
            };
            let reply = if line.starts_with("EHLO") {
                "250-fake\r\n250 AUTH PLAIN".to_owned()
            } else if let Some(login) = line.strip_prefix("AUTH PLAIN ") {
                self.logins.lock().unwrap().push(login.to_owned());
                if self.refuse_logins.load(Ordering::SeqCst) {
                    "535 no".to_owned()
                } else {
                    "235 ok".to_owned()
                }
            } else if line.starts_with("MAIL FROM") {
                from = address();
                "250 ok".to_owned()
            } else if line.starts_with("RCPT TO") {
                to = address();
                self.attempts.fetch_add(1, Ordering::SeqCst);
                let reject = self
                    .rejections
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok();
                if reject {
                    match self.reject_code.load(Ordering::SeqCst) {
                        // Not a valid reply, and it quotes the recipient.
                        GARBLED => format!("550x {to}"),
                        code => format!("{code} no"),
                    }
                } else {
                    "250 ok".to_owned()
                }
            } else if line == "DATA" {
                write.write_all(b"354 go\r\n").await.unwrap();
                let mut data = String::new();
                loop {
                    // A mail cut off before its final dot was not received.
                    let Ok(Some(line)) = lines.next_line().await else {
                        return;
                    };
                    if line == "." {
                        break;
                    }
                    data += &line;
                    data.push('\n');
                }
                self.mails.lock().unwrap().push(Received {
                    from: from.clone(),
                    to: to.clone(),
                    data,
                });
                match self.after_mail.load(Ordering::SeqCst) {
                    HANG_UP => return,
                    GO_QUIET => std::future::pending::<()>().await,
                    _ => {}
                }
                "250 ok".to_owned()
            } else if line == "QUIT" {
                if self.after_mail.load(Ordering::SeqCst) == IGNORE_QUIT {
                    std::future::pending::<()>().await;
                }
                let _ = write.write_all(b"221 bye\r\n").await;
                return;
            } else {
                "250 ok".to_owned()
            };
            write
                .write_all(format!("{reply}\r\n").as_bytes())
                .await
                .unwrap();
        }
    }

    pub fn count(&self) -> usize {
        self.mails.lock().unwrap().len()
    }

    pub async fn wait_for(&self, count: usize) {
        super::eventually("mail delivery", async || self.count() >= count).await;
    }

    /// Long enough for a queued mail to arrive, had one been sent.
    pub async fn expect_none_beyond(&self, count: usize) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(self.count(), count);
    }
}
