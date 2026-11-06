//! A Memcached backend over a small, hand-written text protocol client.
//!
//! The client is deliberately ours: claim recovery depends on knowing exactly
//! what was sent, and it never resends a command behind the caller's back.

use super::pool::{Pool, REVALIDATE_AFTER};
use super::{
    Authorize, CLAIM_RECORD_TTL, Database, DbError, OP_TIMEOUT, Secret, UPDATE_RETRIES, UpdateFn,
    decode, encode, require_lifetime,
};
use crate::util::{generate_id, now_unix};
use async_trait::async_trait;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufStream};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// A flagged marker holds only the random claim ID, never ciphertext.
const CLAIM_FLAG: u32 = 1 << 31;
const CLAIM_ATTEMPTS: usize = 3;
const MAX_CONNECTIONS: usize = 128;
const MAX_KEY_LENGTH: usize = 250;
/// Memcached refuses far smaller items by default; this bounds what a broken or
/// hostile peer can make us allocate.
const MAX_VALUE_LENGTH: usize = 128 << 20;
const MAX_LINE_LENGTH: u64 = 2048;

struct Item {
    value: Vec<u8>,
    flags: u32,
    cas: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum CasOutcome {
    Stored,
    Exists,
    NotFound,
}

struct Conn {
    stream: BufStream<TcpStream>,
}

fn protocol_error(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

impl Conn {
    async fn dial(address: &str) -> io::Result<Self> {
        let stream = TcpStream::connect(address).await?;
        stream.set_nodelay(true)?;
        Ok(Self {
            stream: BufStream::new(stream),
        })
    }

    async fn read_line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        let read = (&mut self.stream)
            .take(MAX_LINE_LENGTH)
            .read_line(&mut line)
            .await?;
        if read == 0 || !line.ends_with("\r\n") {
            return Err(protocol_error("unexpected end of memcached reply"));
        }
        line.truncate(line.len() - 2);
        Ok(line)
    }

    async fn gets(&mut self, key: &str) -> io::Result<Option<Item>> {
        self.stream
            .write_all(format!("gets {key}\r\n").as_bytes())
            .await?;
        self.stream.flush().await?;
        let line = self.read_line().await?;
        if line == "END" {
            return Ok(None);
        }
        let mut fields = line.split(' ');
        if fields.next() != Some("VALUE") || fields.next() != Some(key) {
            // A desynchronized connection must never serve another key's value.
            return Err(protocol_error("unexpected memcached gets reply"));
        }
        let number = |field: Option<&str>| {
            field
                .and_then(|f| f.parse::<u64>().ok())
                .ok_or_else(|| protocol_error("malformed memcached VALUE line"))
        };
        let flags = number(fields.next())? as u32;
        let length = number(fields.next())? as usize;
        let cas = number(fields.next())?;
        if length > MAX_VALUE_LENGTH {
            return Err(protocol_error("memcached value too large"));
        }
        let mut value = vec![0; length + 2];
        self.stream.read_exact(&mut value).await?;
        if !value.ends_with(b"\r\n") {
            return Err(protocol_error("malformed memcached value"));
        }
        value.truncate(length);
        if self.read_line().await? != "END" {
            return Err(protocol_error("missing memcached END"));
        }
        Ok(Some(Item { value, flags, cas }))
    }

    /// Written through the stream's buffer, which sends a small request as one
    /// write and a large value straight from its own memory, without a copy.
    async fn store(&mut self, command: String, value: &[u8]) -> io::Result<String> {
        self.stream.write_all(command.as_bytes()).await?;
        self.stream.write_all(b"\r\n").await?;
        self.stream.write_all(value).await?;
        self.stream.write_all(b"\r\n").await?;
        self.stream.flush().await?;
        self.read_line().await
    }

    async fn set(&mut self, key: &str, value: &[u8], flags: u32, ttl: i64) -> io::Result<()> {
        let command = format!("set {key} {flags} {ttl} {}", value.len());
        match self.store(command, value).await?.as_str() {
            "STORED" => Ok(()),
            reply => Err(protocol_error(&format!("memcached set: {reply}"))),
        }
    }

    async fn cas(
        &mut self,
        key: &str,
        value: &[u8],
        flags: u32,
        ttl: i64,
        cas: u64,
    ) -> io::Result<CasOutcome> {
        let command = format!("cas {key} {flags} {ttl} {} {cas}", value.len());
        match self.store(command, value).await?.as_str() {
            "STORED" => Ok(CasOutcome::Stored),
            "EXISTS" => Ok(CasOutcome::Exists),
            "NOT_FOUND" => Ok(CasOutcome::NotFound),
            reply => Err(protocol_error(&format!("memcached cas: {reply}"))),
        }
    }

    async fn delete(&mut self, key: &str) -> io::Result<bool> {
        self.stream
            .write_all(format!("delete {key}\r\n").as_bytes())
            .await?;
        self.stream.flush().await?;
        match self.read_line().await?.as_str() {
            "DELETED" => Ok(true),
            "NOT_FOUND" => Ok(false),
            reply => Err(protocol_error(&format!("memcached delete: {reply}"))),
        }
    }

    async fn version(&mut self) -> io::Result<()> {
        self.stream.write_all(b"version\r\n").await?;
        self.stream.flush().await?;
        let line = self.read_line().await?;
        if line.starts_with("VERSION ") {
            Ok(())
        } else {
            Err(protocol_error("unexpected memcached version reply"))
        }
    }
}

/// Keys become part of a text protocol line. Route validation already restricts
/// them; this is the last line of defense against command injection.
fn check_key(key: &str) -> Result<(), DbError> {
    if key.is_empty() || key.len() > MAX_KEY_LENGTH || key.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(DbError::Backend("invalid memcached key".into()));
    }
    Ok(())
}

/// Lifetimes above 30 days must be absolute timestamps in Memcached. The stored
/// JSON keeps the relative duration expected by other backends.
pub fn memcached_expiration(seconds: i32, now: i64) -> Result<i64, DbError> {
    if seconds <= 30 * 86400 {
        return Ok(i64::from(seconds));
    }
    if now < 0 || now > i64::from(i32::MAX) - i64::from(seconds) {
        return Err(DbError::Backend(
            "expiration cannot be represented by Memcached".into(),
        ));
    }
    Ok(now + i64::from(seconds))
}

pub struct Memcached {
    address: String,
    pool: Pool<Conn>,
}

fn io_error(error: io::Error) -> DbError {
    DbError::Backend(error.to_string())
}

fn timed_out(_: tokio::time::error::Elapsed) -> DbError {
    DbError::Backend("memcached operation timed out".into())
}

impl Memcached {
    pub fn new(address: &str) -> Self {
        Self {
            address: address.to_owned(),
            pool: Pool::new(MAX_CONNECTIONS),
        }
    }

    async fn connect(&self) -> Result<Conn, DbError> {
        timeout(OP_TIMEOUT, Conn::dial(&self.address))
            .await
            .map_err(timed_out)?
            .map_err(io_error)
    }

    /// Runs one command on a pooled connection, closing it on any failure so a
    /// late reply can never be read as the answer to a later command.
    async fn with_conn<T, F>(&self, op: F) -> Result<T, DbError>
    where
        F: AsyncFnOnce(&mut Conn) -> io::Result<T>,
    {
        let (lease, idle) = self
            .pool
            .check_out(OP_TIMEOUT)
            .await
            .map_err(|e| DbError::Backend(e.into()))?;
        let mut conn = match idle {
            Some((conn, age)) if age < REVALIDATE_AFTER => conn,
            Some((mut conn, _)) => match timeout(OP_TIMEOUT, conn.version()).await {
                Ok(Ok(())) => conn,
                _ => self.connect().await?,
            },
            None => self.connect().await?,
        };
        let result = timeout(OP_TIMEOUT, op(&mut conn))
            .await
            .map_err(timed_out)?
            .map_err(io_error)?;
        self.pool.check_in(conn, &lease);
        Ok(result)
    }

    /// A flagged claim marker counts as absent for every operation.
    async fn fetch(&self, key: &str) -> Result<Item, DbError> {
        check_key(key)?;
        match self.with_conn(async |c| c.gets(key).await).await? {
            Some(item) if item.flags & CLAIM_FLAG == 0 => Ok(item),
            _ => Err(DbError::NotFound),
        }
    }

    /// A CAS claim leaves a recognizable marker so a lost STORED reply can be
    /// recovered. Never follow it with a delete, which could remove a replacement.
    async fn claim(&self, key: &str, item: &Item) -> Result<(), DbError> {
        let claim_id = generate_id();
        let ttl = CLAIM_RECORD_TTL as i64;
        let mut last_error = DbError::Backend("memcached claim failed".into());
        for _ in 0..CLAIM_ATTEMPTS {
            let attempt = self
                .with_conn(async |c| {
                    c.cas(key, claim_id.as_bytes(), CLAIM_FLAG, ttl, item.cas)
                        .await
                })
                .await;
            if let Ok(CasOutcome::Stored) = attempt {
                return Ok(());
            }
            if let Err(error) = attempt {
                last_error = error;
            }
            match self.with_conn(async |c| c.gets(key).await).await {
                Ok(None) => return Err(DbError::NotFound),
                Err(error) => last_error = error,
                Ok(Some(current)) => {
                    if current.flags & CLAIM_FLAG != 0 && current.value == claim_id.as_bytes() {
                        return Ok(()); // our command applied, only its reply was lost
                    }
                    if current.cas != item.cas {
                        return Err(DbError::NotFound);
                    }
                    // The original version is still present. Retrying the same
                    // CAS cannot claim a replacement, even if the first arrives late.
                }
            }
        }
        Err(last_error)
    }

    async fn read_authorized(
        &self,
        key: &str,
        authorize: &Authorize<'_>,
        delete_value: bool,
    ) -> Result<Secret, DbError> {
        let item = self.fetch(key).await?;
        let secret = decode(&item.value)?;
        authorize(&secret).map_err(DbError::Aborted)?;
        if secret.one_time || delete_value {
            self.claim(key, &item).await?;
        }
        Ok(secret)
    }
}

#[async_trait]
impl Database for Memcached {
    async fn status(&self, key: &str) -> Result<Secret, DbError> {
        decode(&self.fetch(key).await?.value)
    }

    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError> {
        self.read_authorized(key, authorize, false).await
    }

    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError> {
        self.read_authorized(key, authorize, true).await.map(drop)
    }

    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError> {
        check_key(key)?;
        require_lifetime(secret)?;
        let data = encode(secret)?;
        let ttl = memcached_expiration(secret.expiration, now_unix())?;
        self.with_conn(async |c| c.set(key, data.as_bytes(), 0, ttl).await)
            .await
    }

    async fn delete(&self, key: &str) -> Result<bool, DbError> {
        check_key(key)?;
        self.with_conn(async |c| c.delete(key).await).await
    }

    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError> {
        for _ in 0..UPDATE_RETRIES {
            let item = self.fetch(key).await?;
            let updated = update(decode(&item.value)?)?;
            require_lifetime(&updated)?;
            let data = encode(&updated)?;
            let ttl = memcached_expiration(updated.expiration, now_unix())?;
            let outcome = self
                .with_conn(async |c| c.cas(key, data.as_bytes(), item.flags, ttl, item.cas).await)
                .await?;
            match outcome {
                CasOutcome::Stored => return Ok(()),
                CasOutcome::NotFound => return Err(DbError::NotFound),
                CasOutcome::Exists => {}
            }
        }
        Err(DbError::Backend("update lost too many races".into()))
    }

    async fn health(&self) -> Result<(), DbError> {
        self.with_conn(async |c| c.gets("__yopass_health_check__").await)
            .await
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cannot_inject_commands() {
        for bad in [
            "",
            "a b",
            "a\r\nflush_all",
            "a\nb",
            "a\tb",
            "a\u{7f}",
            &"x".repeat(MAX_KEY_LENGTH + 1),
        ] {
            assert!(check_key(bad).is_err(), "{bad:?}");
        }
        assert!(check_key("stream:12345678-1234-1234-1234-123456789012").is_ok());
        assert!(check_key("request/AbCdEf0123456789GhIjKl").is_ok());
    }

    #[test]
    fn long_lifetimes_become_absolute_timestamps() {
        let now = 1_700_000_000;
        assert_eq!(memcached_expiration(3600, now).unwrap(), 3600);
        assert_eq!(memcached_expiration(30 * 86400, now).unwrap(), 30 * 86400);
        assert_eq!(
            memcached_expiration(90 * 86400, now).unwrap(),
            now + 90 * 86400
        );
        assert!(memcached_expiration(90 * 86400, i64::from(i32::MAX) - 1).is_err());
    }

    /// A scripted server: `respond` answers each command line, `None` hangs up.
    async fn fake(
        respond: impl Fn(&str) -> Option<Vec<u8>> + Send + Sync + 'static,
    ) -> (Memcached, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let respond = std::sync::Arc::new(respond);
        let counter = connections.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let respond = respond.clone();
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    loop {
                        let mut line = String::new();
                        if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        if line.starts_with("set ") || line.starts_with("cas ") {
                            let mut data = String::new();
                            stream.read_line(&mut data).await.unwrap();
                        }
                        match respond(line.trim_end()) {
                            Some(reply) => stream.get_mut().write_all(&reply).await.unwrap(),
                            None => return,
                        }
                    }
                });
            }
        });
        (Memcached::new(&address), connections)
    }

    fn connections(count: &std::sync::atomic::AtomicUsize) -> usize {
        count.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn item(secret: &Secret) -> Vec<u8> {
        let data = encode(secret).unwrap();
        format!("VALUE k 0 {} 7\r\n{data}\r\nEND\r\n", data.len()).into_bytes()
    }

    fn one_time() -> Secret {
        Secret {
            expiration: 3600,
            message: "m".into(),
            one_time: true,
            ..Secret::default()
        }
    }

    #[tokio::test]
    async fn protocol_violations_fail_and_drop_the_connection() {
        let too_large = format!("VALUE k 0 {} 1\r\n", MAX_VALUE_LENGTH + 1);
        let long_line = format!("VALUE {}", "k".repeat(4096));
        for reply in [
            // Another key's value: a desynchronized connection must not serve it.
            "VALUE other 0 1 1\r\nx\r\nEND\r\n",
            "VALUE k 0 abc 1\r\n",
            "VALUE k 0 1\r\n",
            too_large.as_str(),
            "VALUE k 0 1 1\r\nxyz",
            "VALUE k 0 1 1\r\nx\r\nNOPE\r\n",
            "garbage\r\n",
            long_line.as_str(),
            "END",
        ] {
            let owned = reply.to_owned();
            let (db, count) = fake(move |_| Some(owned.clone().into_bytes())).await;
            let error = db.status("k").await.unwrap_err();
            assert!(matches!(error, DbError::Backend(_)), "{reply:?}: {error:?}");
            let _ = db.status("k").await;
            assert_eq!(
                connections(&count),
                2,
                "{reply:?}: a failed connection was reused"
            );
        }
        let (db, _) = fake(|_| None).await;
        assert!(matches!(db.status("k").await, Err(DbError::Backend(_))));
    }

    #[tokio::test]
    async fn unexpected_store_replies_are_errors() {
        let secret = one_time();
        let (db, _) = fake(|line| {
            Some(match line.split(' ').next().unwrap() {
                "set" => b"SERVER_ERROR out of memory\r\n".to_vec(),
                "delete" => b"ERROR\r\n".to_vec(),
                "gets" => item(&one_time()),
                _ => b"ERROR\r\n".to_vec(),
            })
        })
        .await;
        let put = db.put("k", &secret).await.unwrap_err();
        assert!(format!("{put:?}").contains("out of memory"), "{put:?}");
        assert!(matches!(db.delete("k").await, Err(DbError::Backend(_))));
        assert!(matches!(
            db.update("k", &|s| Ok(s)).await,
            Err(DbError::Backend(_))
        ));
    }

    /// A claim whose CAS never applies gives up instead of reporting success,
    /// whether the follow-up read sees the original value or fails itself.
    #[tokio::test]
    async fn claims_give_up_after_their_attempts() {
        for failing_reads in [false, true] {
            let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = reads.clone();
            let (db, _) = fake(move |line| {
                Some(match line.split(' ').next().unwrap() {
                    "gets" => {
                        let first = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
                        if first || !failing_reads {
                            item(&one_time())
                        } else {
                            b"garbage\r\n".to_vec()
                        }
                    }
                    _ => b"SERVER_ERROR busy\r\n".to_vec(),
                })
            })
            .await;
            let result = db.get_authorized("k", &|_| Ok(())).await;
            assert!(matches!(result, Err(DbError::Backend(_))), "{result:?}");
            assert_eq!(
                reads.load(std::sync::atomic::Ordering::SeqCst),
                1 + CLAIM_ATTEMPTS,
                "every attempt rechecks the value"
            );
        }
    }

    #[tokio::test]
    async fn idle_connections_are_revalidated_before_reuse() {
        let healthy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = healthy.clone();
        let (db, count) = fake(move |line| {
            Some(if line == "version" {
                if flag.load(std::sync::atomic::Ordering::SeqCst) {
                    b"VERSION 1.6.0\r\n".to_vec()
                } else {
                    b"ERROR\r\n".to_vec()
                }
            } else {
                b"END\r\n".to_vec()
            })
        })
        .await;
        assert!(matches!(db.status("k").await, Err(DbError::NotFound)));
        db.pool.age_idle(REVALIDATE_AFTER);
        assert!(matches!(db.status("k").await, Err(DbError::NotFound)));
        assert_eq!(connections(&count), 1, "a live connection is kept");

        healthy.store(false, std::sync::atomic::Ordering::SeqCst);
        db.pool.age_idle(REVALIDATE_AFTER);
        assert!(matches!(db.status("k").await, Err(DbError::NotFound)));
        assert_eq!(
            connections(&count),
            2,
            "a connection failing the probe is replaced"
        );
    }

    #[tokio::test]
    async fn a_silent_server_times_out() {
        let (db, _) = fake(|_| Some(Vec::new())).await;
        let started = std::time::Instant::now();
        let error = db.status("k").await.unwrap_err();
        assert!(format!("{error:?}").contains("timed out"), "{error:?}");
        assert!(started.elapsed() < OP_TIMEOUT * 2);
    }
}
