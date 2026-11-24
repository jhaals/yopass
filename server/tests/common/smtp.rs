//! A plaintext SMTP server that records the mails it accepts.

use std::sync::atomic::{AtomicUsize, Ordering};
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
}

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
            let address = || {
                let start = line.find('<').unwrap() + 1;
                line[start..line.find('>').unwrap()].to_owned()
            };
            let reply = if line.starts_with("EHLO") {
                "250-fake\r\n250 AUTH PLAIN".to_owned()
            } else if let Some(login) = line.strip_prefix("AUTH PLAIN ") {
                self.logins.lock().unwrap().push(login.to_owned());
                "235 ok".to_owned()
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
                    format!("{} no", self.reject_code.load(Ordering::SeqCst))
                } else {
                    "250 ok".to_owned()
                }
            } else if line == "DATA" {
                write.write_all(b"354 go\r\n").await.unwrap();
                let mut data = String::new();
                while let Ok(Some(line)) = lines.next_line().await {
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
                "250 ok".to_owned()
            } else if line == "QUIT" {
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
