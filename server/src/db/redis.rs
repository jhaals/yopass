//! The Redis and Valkey backend.
//!
//! WATCH state belongs to a connection, so each operation owns its connection
//! exclusively for its whole duration. The client never resends a command: a
//! plain SET sent twice could restore a value after it was claimed.

use super::pool::{Lease, Pool, REVALIDATE_AFTER};
use super::sentinel;
use super::{
    Authorize, CLAIM_RECORD_TTL, Database, DbError, OP_TIMEOUT, Secret, UPDATE_RETRIES, UpdateFn,
    decode, encode, require_lifetime,
};
use crate::util::generate_id;
use async_trait::async_trait;
use futures_util::StreamExt;
use redis::AsyncConnectionConfig;
use redis::aio::MultiplexedConnection;
use redis::sentinel::SentinelClient;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const MAX_CONNECTIONS: usize = 128;

/// The failover announcement of a Sentinel: the payload is
/// `<master name> <old ip> <old port> <new ip> <new port>`.
const SWITCH_MASTER: &str = "+switch-master";

/// A Sentinel that ended or refused the subscription is tried again after this.
const RESUBSCRIBE_AFTER: Duration = Duration::from_secs(1);

/// A silent subscription is pinged this often: one that died unnoticed would
/// never announce anything.
const PING_SENTINEL_EVERY: Duration = Duration::from_secs(5);

const INVALID_URL: &str =
    "redis: invalid connection URL; check the scheme and percent-encode credentials";

enum Target {
    Server(Box<redis::Client>),
    Sentinel(Box<Sentinel>),
}

struct Sentinel {
    /// Held for a lookup, which needs `&mut`, so one runs at a time and the
    /// callers waiting meanwhile take its result.
    lookup: tokio::sync::Mutex<SentinelClient>,
    /// The primary the last lookup found, until a Sentinel or a connection
    /// shows it moved, and a generation bumped on every forget, so a lookup
    /// that started before one cannot bring the old primary back.
    primary: std::sync::Mutex<(u64, Option<redis::Client>)>,
    /// Every Sentinel, for `follow`, and the URL's settings.
    sentinels: Vec<redis::Client>,
    config: sentinel::SentinelConfig,
    switch: Arc<Switch>,
    /// One `follow` per Sentinel, aborted when this is dropped.
    followers: std::sync::Mutex<tokio::task::JoinSet<()>>,
}

/// What `follow` heard.
#[derive(Default)]
struct Switch {
    /// The primary may have moved: taken by `conn`.
    switched: AtomicBool,
    /// The primary last announced, used by the next lookup instead of asking
    /// Sentinel: until it is demoted, the old primary still answers as one, and
    /// the Sentinel leading a failover can name it for a while. Not checked
    /// further: one that is a replica again answers READONLY, which retires it.
    announced: std::sync::Mutex<Option<(String, u16)>>,
}

impl Switch {
    fn announced(&self) -> std::sync::MutexGuard<'_, Option<(String, u16)>> {
        self.announced.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Reads `<master name> <old ip> <old port> <new ip> <new port>`.
fn new_primary(payload: &[u8], master_name: &str) -> Option<(String, u16)> {
    let payload = std::str::from_utf8(payload).ok()?;
    match payload.split(' ').collect::<Vec<_>>()[..] {
        [name, _, _, host, port] if name == master_name => {
            Some((host.to_owned(), port.parse().ok()?))
        }
        _ => None,
    }
}

/// Sets `switched` when the Sentinel behind `client` announces another primary
/// for `master_name`. The old primary cannot tell: Sentinel demotes it, and
/// disconnects its clients, only some ten seconds after the switch, and until
/// then it takes writes that the new primary never sees. Every new subscription
/// sets it too, for an announcement made while nobody listened. A Sentinel
/// that does not answer or refuses to be subscribed to changes nothing.
async fn follow(client: redis::Client, master_name: String, switch: Arc<Switch>) {
    loop {
        let subscribe = async {
            let mut pubsub = client.get_async_pubsub().await?;
            pubsub.subscribe(SWITCH_MASTER).await?;
            Ok::<_, redis::RedisError>(pubsub)
        };
        if let Ok(Ok(pubsub)) = tokio::time::timeout(OP_TIMEOUT, subscribe).await {
            switch.switched.store(true, Ordering::SeqCst);
            let (mut sink, mut announcements) = pubsub.split();
            loop {
                match tokio::time::timeout(PING_SENTINEL_EVERY, announcements.next()).await {
                    Ok(Some(announcement)) => {
                        let payload = announcement.get_payload_bytes();
                        if let Some(primary) = new_primary(payload, &master_name) {
                            *switch.announced() = Some(primary);
                            switch.switched.store(true, Ordering::SeqCst);
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        let pong = sink.ping::<redis::Value>();
                        if !matches!(tokio::time::timeout(OP_TIMEOUT, pong).await, Ok(Ok(_))) {
                            break;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(RESUBSCRIBE_AFTER).await;
    }
}

impl Sentinel {
    fn state(&self) -> std::sync::MutexGuard<'_, (u64, Option<redis::Client>)> {
        self.primary.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Caches `client` unless the primary was forgotten since `generation`.
    fn remember(&self, generation: u64, client: &redis::Client) -> bool {
        let mut state = self.state();
        let current = state.0 == generation;
        if current {
            state.1 = Some(client.clone());
        }
        current
    }

    fn forget(&self) {
        let mut state = self.state();
        state.0 += 1;
        state.1 = None;
    }

    /// Starts a `follow` on every Sentinel, unless they run. With the first
    /// lookup rather than in `new`, which has no runtime to spawn on.
    fn listen(&self) {
        let mut followers = self.followers.lock().unwrap_or_else(|e| e.into_inner());
        // A `follow` never returns: these went down with their runtime.
        while followers.try_join_next().is_some() {}
        if followers.is_empty() {
            for client in &self.sentinels {
                let (master_name, switch) = (self.config.master_name.clone(), self.switch.clone());
                followers.spawn(follow(client.clone(), master_name, switch));
            }
        }
    }

    /// The primary, looked up through Sentinel when none is known.
    async fn primary(&self) -> Result<redis::Client, DbError> {
        if let Some(client) = self.state().1.clone() {
            return Ok(client);
        }
        self.listen();
        let lookup = async {
            let mut sentinel = self.lookup.lock().await;
            let generation = match &*self.state() {
                (_, Some(client)) => return Ok(client.clone()),
                (generation, None) => *generation,
            };
            let announced = self.switch.announced().clone();
            let client = match &announced {
                Some((host, port)) => sentinel::primary_at(&self.config, host, *port),
                None => sentinel.async_get_client().await,
            }
            .map_err(backend)?;
            // Kept for the next lookup if a retire overtook this one.
            if self.remember(generation, &client) && announced.is_some() {
                let mut current = self.switch.announced();
                if *current == announced {
                    *current = None;
                }
            }
            Ok(client)
        };
        tokio::time::timeout(OP_TIMEOUT, lookup)
            .await
            .map_err(|_| DbError::Backend("redis: Sentinel lookup timed out".into()))?
    }
}

pub struct Redis {
    target: Target,
    pool: Pool<MultiplexedConnection>,
}

/// READONLY as the reply, or as the reason a transaction was aborted.
fn is_readonly(error: &redis::RedisError) -> bool {
    // Cheap: the errors of an aborted transaction are shared.
    error
        .clone()
        .into_server_errors()
        .is_some_and(|errors| errors.iter().any(|(_, error)| error.code() == "READONLY"))
}

// Only the error kind: connection errors can quote the URL and its credentials.
fn backend(error: redis::RedisError) -> DbError {
    DbError::Backend(format!("redis: {:?}", error.kind()))
}

/// Hash-tagged so the claim transaction stays in one cluster slot: cluster-mode
/// endpoints reject it with CROSSSLOT otherwise.
fn claim_key(key: &str) -> String {
    format!("claim:{{{key}}}")
}

impl Redis {
    /// Errors never quote the URL: it can contain credentials.
    pub fn new(url: &str) -> Result<Self, String> {
        let parsed = url::Url::parse(url).map_err(|_| INVALID_URL.to_owned())?;
        let target = if sentinel::is_sentinel_url(&parsed) {
            let config = sentinel::parse(&parsed)?;
            Target::Sentinel(Box::new(Sentinel {
                lookup: tokio::sync::Mutex::new(sentinel::client(&config)?),
                primary: std::sync::Mutex::new((0, None)),
                sentinels: sentinel::sentinels(&config)?,
                config,
                switch: Arc::default(),
                followers: std::sync::Mutex::new(tokio::task::JoinSet::new()),
            }))
        } else if parsed.query_pairs().any(|(name, _)| name == "master_name") {
            // An empty master_name: Go rejects it as an unknown option.
            return Err(INVALID_URL.to_owned());
        } else {
            Target::Server(Box::new(
                redis::Client::open(url).map_err(|_| INVALID_URL.to_owned())?,
            ))
        };
        Ok(Self {
            target,
            pool: Pool::new(MAX_CONNECTIONS),
        })
    }

    async fn connect(&self) -> Result<MultiplexedConnection, DbError> {
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(OP_TIMEOUT))
            .set_response_timeout(Some(OP_TIMEOUT));
        let client = match &self.target {
            Target::Server(client) => (**client).clone(),
            Target::Sentinel(sentinel) => sentinel.primary().await?,
        };
        let connected = client
            .get_multiplexed_async_connection_with_config(&config)
            .await;
        // Even a timeout: a primary that went down may never answer again.
        connected.map_err(|error| {
            self.retire();
            backend(error)
        })
    }

    /// Through Sentinel, forgets every connection and the primary itself. A
    /// single server has nowhere else to go: `failed` decides about its pool.
    fn retire(&self) {
        if let Target::Sentinel(sentinel) = &self.target {
            // Primary first: a connection opened in between must not outlive the clear.
            sentinel.forget();
            self.pool.clear();
        }
    }

    /// A failover that no Sentinel announced (see `follow`) still shows up as
    /// dropped connections, since Sentinel disconnects the clients of a
    /// demoted primary, or as READONLY from it, also inside an aborted
    /// transaction (EXECABORT, which OOM causes too). Every idle connection
    /// may then point at the wrong node, so all of them go, and new ones ask
    /// Sentinel again. A timeout says nothing about the node, so Sentinel
    /// keeps them. A single server drops its idle connections on READONLY and
    /// on any connection failure, but not on another error reply.
    fn failed(&self, error: redis::RedisError) -> DbError {
        let dropped = error.is_connection_dropped() && !error.is_timeout();
        let readonly = is_readonly(&error);
        if readonly || dropped {
            self.retire();
        }
        // Even a single address can move, as a DNS name of a managed primary
        // does, and what broke one connection, such as a proxy in between
        // restarting, has usually broken them all.
        if let Target::Server(_) = self.target
            && (readonly || error.is_io_error())
        {
            self.pool.clear();
        }
        backend(error)
    }

    /// An idle connection is still usable: it answers, and through Sentinel it
    /// still reaches the primary.
    async fn revalidate(&self, conn: &mut MultiplexedConnection) -> bool {
        match self.target {
            Target::Server(_) => {
                let alive: redis::RedisResult<()> = redis::cmd("PING").query_async(conn).await;
                alive.is_ok()
            }
            Target::Sentinel(_) => {
                let role: redis::RedisResult<redis::Role> =
                    redis::cmd("ROLE").query_async(conn).await;
                let primary = matches!(role, Ok(redis::Role::Primary { .. }));
                if role.is_ok() && !primary {
                    self.retire();
                }
                primary
            }
        }
    }

    /// A fresh connection may return to the pool even if a retire came while
    /// `lease` was held, but not one that a retire overtook.
    async fn connect_renewed(
        &self,
        lease: &mut Lease<'_>,
    ) -> Result<MultiplexedConnection, DbError> {
        // Before connecting: a retire while it connects then still drops it.
        self.pool.renew(lease);
        self.connect().await
    }

    /// A reusable connection plus the permit bounding concurrent backend use.
    async fn conn(&self) -> Result<(Lease<'_>, MultiplexedConnection), DbError> {
        // Before anything is taken from the pool: a Sentinel announced another
        // primary, and the old one still accepts what the new one never sees.
        if let Target::Sentinel(sentinel) = &self.target
            && sentinel.switch.switched.swap(false, Ordering::SeqCst)
        {
            self.retire();
        }
        let (mut lease, idle) = self
            .pool
            .check_out(OP_TIMEOUT)
            .await
            .map_err(|e| DbError::Backend(e.into()))?;
        let conn = match idle {
            Some((conn, age)) if age < REVALIDATE_AFTER => conn,
            Some((mut conn, _)) => {
                if self.revalidate(&mut conn).await {
                    return Ok((lease, conn));
                }
                self.connect_renewed(&mut lease).await?
            }
            None => self.connect_renewed(&mut lease).await?,
        };
        Ok((lease, conn))
    }

    /// WATCH begins before the read, so even an identical-value rewrite
    /// invalidates the claim. Authorization and delivery use the same snapshot.
    async fn read_authorized(
        &self,
        key: &str,
        authorize: &Authorize<'_>,
        delete_value: bool,
    ) -> Result<Secret, DbError> {
        let (lease, mut conn) = self.conn().await?;
        let Some(value) = watch_get(&mut conn, key)
            .await
            .map_err(|e| self.failed(e))?
        else {
            self.pool.check_in(conn, &lease);
            return Err(DbError::NotFound);
        };
        let secret = match decode(&value) {
            Ok(secret) => secret,
            Err(error) => {
                self.pool.check_in(conn, &lease);
                return Err(error);
            }
        };
        if let Err(abort) = authorize(&secret) {
            self.pool.check_in(conn, &lease);
            return Err(DbError::Aborted(abort));
        }
        if !secret.one_time && !delete_value {
            self.pool.check_in(conn, &lease);
            return Ok(secret);
        }

        let claim_id = generate_id();
        let claim = claim_key(key);
        let exec: redis::RedisResult<Option<(i64, ())>> = redis::pipe()
            .atomic()
            .del(key)
            .cmd("SET")
            .arg(&claim)
            .arg(&claim_id)
            .arg("EX")
            .arg(CLAIM_RECORD_TTL)
            .query_async(&mut conn)
            .await;
        match exec {
            Ok(Some((1, ()))) => {
                self.pool.check_in(conn, &lease);
                Ok(secret)
            }
            // A failed WATCH (nil) or a value already gone: another caller won.
            Ok(_) => {
                self.pool.check_in(conn, &lease);
                Err(DbError::NotFound)
            }
            // An error reply, such as EXECABORT from a demoted primary, is an
            // answer rather than a lost one: no claim marker of ours can exist.
            Err(error) if error.code().is_some() => Err(self.failed(error)),
            // The reply was lost, so the transaction may have applied, or may
            // still apply. The permit goes first: settling needs a connection.
            Err(error) => {
                drop(conn);
                drop(lease);
                // First, so settling does not reuse a connection to a demoted primary.
                let failure = self.failed(error);
                // Settling has one try: it must not land on a connection that
                // went silent together with this one, which a timeout keeps.
                self.pool.clear();
                if self.settle_lost_claim(key, &claim, &claim_id).await {
                    Ok(secret)
                } else {
                    Err(failure)
                }
            }
        }
    }

    /// Decides a claim whose EXEC reply was lost. Only the marker with our random
    /// ID proves this caller owns the secret. Without it, the old EXEC may still
    /// be queued behind the timeout, so touching the key fences it: its WATCH
    /// then aborts it, the secret stays intact and the caller reports an error.
    async fn settle_lost_claim(&self, key: &str, claim: &str, claim_id: &str) -> bool {
        let Ok((lease, mut conn)) = self.conn().await else {
            return false;
        };
        for _ in 0..UPDATE_RETRIES {
            // PTTL before the marker: a stale EXEC landing between the two reads
            // then shows up as our marker rather than as a vanished key.
            let state: redis::RedisResult<(i64, Option<String>)> = redis::pipe()
                .cmd("UNWATCH")
                .ignore()
                .cmd("WATCH")
                .arg(key)
                .ignore()
                .cmd("PTTL")
                .arg(key)
                .cmd("GET")
                .arg(claim)
                .query_async(&mut conn)
                .await;
            let (ttl, owner) = match state {
                Ok(state) => state,
                Err(error) => {
                    self.failed(error);
                    return false;
                }
            };
            if owner.as_deref() == Some(claim_id) {
                self.pool.check_in(conn, &lease);
                return true;
            }
            // Gone (-2), or without a lifetime (-1), which nothing stores.
            if ttl <= 0 {
                self.pool.check_in(conn, &lease);
                return false;
            }
            let fence: redis::RedisResult<Option<(i64,)>> = redis::pipe()
                .atomic()
                .cmd("PEXPIRE")
                .arg(key)
                .arg(ttl)
                .query_async(&mut conn)
                .await;
            match fence {
                Ok(Some(_)) => {
                    self.pool.check_in(conn, &lease);
                    return false;
                }
                // The key changed meanwhile, perhaps by our own EXEC: look again.
                Ok(None) => {}
                Err(error) => {
                    self.failed(error);
                    return false;
                }
            }
        }
        false
    }
}

/// WATCH and GET in one round trip; the pipeline keeps their order. The leading
/// UNWATCH clears whatever an earlier user left watched, so a connection can go
/// back to the pool without its own UNWATCH round trip: stale WATCH state only
/// matters to an EXEC, and every EXEC follows this.
async fn watch_get(
    conn: &mut MultiplexedConnection,
    key: &str,
) -> redis::RedisResult<Option<Vec<u8>>> {
    let (value,): (Option<Vec<u8>>,) = redis::pipe()
        .cmd("UNWATCH")
        .ignore()
        .cmd("WATCH")
        .arg(key)
        .ignore()
        .cmd("GET")
        .arg(key)
        .query_async(conn)
        .await?;
    Ok(value)
}

#[async_trait]
impl Database for Redis {
    async fn status(&self, key: &str) -> Result<Secret, DbError> {
        let (lease, mut conn) = self.conn().await?;
        let value: Option<Vec<u8>> = redis::cmd("GET")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| self.failed(e))?;
        self.pool.check_in(conn, &lease);
        decode(&value.ok_or(DbError::NotFound)?)
    }

    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError> {
        self.read_authorized(key, authorize, false).await
    }

    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError> {
        self.read_authorized(key, authorize, true).await.map(drop)
    }

    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError> {
        require_lifetime(secret)?;
        let data = encode(secret)?;
        // Sized up front, so it does not reallocate while filling; sending
        // still packs one more copy.
        let mut set = redis::Cmd::with_capacity(5, key.len() + data.len() + 16);
        set.arg("SET")
            .arg(key)
            .arg(data)
            .arg("EX")
            .arg(secret.expiration);
        let (lease, mut conn) = self.conn().await?;
        let _: () = set
            .query_async(&mut conn)
            .await
            .map_err(|e| self.failed(e))?;
        self.pool.check_in(conn, &lease);
        Ok(())
    }

    async fn create(&self, key: &str, secret: &Secret) -> Result<bool, DbError> {
        require_lifetime(secret)?;
        let data = encode(secret)?;
        let (lease, mut conn) = self.conn().await?;
        let stored: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(data)
            .arg("NX")
            .arg("EX")
            .arg(secret.expiration)
            .query_async(&mut conn)
            .await
            .map_err(|e| self.failed(e))?;
        self.pool.check_in(conn, &lease);
        Ok(stored.is_some())
    }

    async fn delete(&self, key: &str) -> Result<bool, DbError> {
        let (lease, mut conn) = self.conn().await?;
        let removed: i64 = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(|e| self.failed(e))?;
        self.pool.check_in(conn, &lease);
        Ok(removed == 1)
    }

    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError> {
        let (lease, mut conn) = self.conn().await?;
        for _ in 0..UPDATE_RETRIES {
            let Some(value) = watch_get(&mut conn, key)
                .await
                .map_err(|e| self.failed(e))?
            else {
                self.pool.check_in(conn, &lease);
                return Err(DbError::NotFound);
            };
            let updated = match decode(&value).and_then(update) {
                Ok(updated) => updated,
                Err(error) => {
                    self.pool.check_in(conn, &lease);
                    return Err(error);
                }
            };
            if let Err(error) = require_lifetime(&updated) {
                self.pool.check_in(conn, &lease);
                return Err(error);
            }
            let data = match encode(&updated) {
                Ok(data) => data,
                Err(error) => {
                    self.pool.check_in(conn, &lease);
                    return Err(error);
                }
            };
            let exec: redis::RedisResult<Option<((),)>> = redis::pipe()
                .atomic()
                .cmd("SET")
                .arg(key)
                .arg(data)
                .arg("EX")
                .arg(updated.expiration)
                .query_async(&mut conn)
                .await;
            let exec = match exec {
                Ok(exec) => exec,
                Err(error) => return Err(self.failed(error)),
            };
            if exec.is_some() {
                self.pool.check_in(conn, &lease);
                return Ok(());
            }
        }
        self.pool.check_in(conn, &lease);
        Err(DbError::Backend("update lost too many races".into()))
    }

    async fn health(&self) -> Result<(), DbError> {
        let (lease, mut conn) = self.conn().await?;
        // Through Sentinel, ROLE: a demoted primary still answers PING.
        if !self.revalidate(&mut conn).await {
            return Err(DbError::Backend(
                "redis: not the primary or not answering".into(),
            ));
        }
        self.pool.check_in(conn, &lease);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_key_shares_the_secrets_cluster_slot() {
        assert_eq!(claim_key("AbC123"), "claim:{AbC123}");
    }

    #[test]
    fn url_errors_never_contain_credentials() {
        for password in [
            "hunter2%",
            "hunter2/x",
            "hunter2?x",
            "1/hunter2",
            "1?hunter2",
        ] {
            for url in [
                format!("redis://:{password}@localhost:6379/0"),
                format!("redis://:{password}@localhost:26379/0?master_name=mymaster"),
            ] {
                if let Err(error) = Redis::new(&url) {
                    assert!(!error.contains("hunter2"), "credential leaked: {error}");
                }
            }
        }
        assert!(Redis::new("not a url").is_err());
    }

    #[test]
    fn a_master_name_selects_sentinel_and_an_empty_one_fails() {
        let redis = Redis::new("redis://localhost:26379/0?master_name=m").unwrap();
        assert!(matches!(redis.target, Target::Sentinel(_)));
        let redis = Redis::new("redis://localhost:6379/0").unwrap();
        assert!(matches!(redis.target, Target::Server(_)));
        assert!(Redis::new("redis://localhost:6379/0?master_name=").is_err());
    }

    fn sentinel(db: &Redis) -> &Sentinel {
        match &db.target {
            Target::Sentinel(sentinel) => sentinel,
            Target::Server(_) => panic!("not a Sentinel target"),
        }
    }

    #[test]
    fn only_a_sign_of_failover_forgets_the_primary() {
        let db = Redis::new("redis://127.0.0.1:1/?master_name=m").unwrap();
        let sentinel = sentinel(&db);
        let client = redis::Client::open("redis://127.0.0.1:2/").unwrap();
        let cached = |db: &Redis| sentinel.state().1.is_some() && db.pool.epoch() == 0;

        sentinel.remember(0, &client);
        db.failed(redis::make_extension_error("EXECABORT".into(), None));
        db.failed(redis::make_extension_error("OOM".into(), None));
        db.failed(std::io::Error::from(std::io::ErrorKind::TimedOut).into());
        assert!(cached(&db), "an abort, OOM or timeout keeps the primary");

        db.failed(redis::make_extension_error("READONLY".into(), None));
        assert!(!cached(&db), "READONLY forgets it and the pool");

        let generation = sentinel.state().0;
        sentinel.remember(generation, &client);
        db.failed(std::io::Error::from(std::io::ErrorKind::ConnectionReset).into());
        assert!(
            sentinel.state().1.is_none(),
            "a dropped connection forgets it"
        );

        // A lookup that began before the forget must not bring the old primary back.
        sentinel.remember(generation, &client);
        assert!(sentinel.state().1.is_none());
    }

    /// What `follow` heard counts before the next operation takes a
    /// connection: the primary known until then is not even dialled.
    #[tokio::test]
    async fn a_switch_announced_by_sentinel_forgets_the_primary() {
        let old = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let db = Redis::new("redis://127.0.0.1:1/?master_name=m").unwrap();
        let sentinel = sentinel(&db);
        let url = format!("redis://{}/", old.local_addr().unwrap());
        sentinel.remember(0, &redis::Client::open(url).unwrap());

        sentinel.switch.switched.store(true, Ordering::SeqCst);
        // No Sentinel answers on port 1, so nothing names a primary.
        assert!(db.conn().await.is_err());
        assert!(sentinel.state().1.is_none() && db.pool.epoch() == 1);
        let dialled = tokio::time::timeout(Duration::from_millis(50), old.accept()).await;
        assert!(dialled.is_err(), "the old primary was still used");
    }

    /// The announced primary is dialled without asking Sentinel, whose
    /// leader can still name the old one for a while.
    #[tokio::test]
    async fn the_announced_primary_is_used_without_a_lookup() {
        let new = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = new.local_addr().unwrap().port();
        // No Sentinel answers on port 1: only the announcement names a primary.
        let db = Redis::new("redis://127.0.0.1:1/?master_name=m").unwrap();
        let payload = format!("m 127.0.0.1 16400 127.0.0.1 {port}");
        let announced = new_primary(payload.as_bytes(), "m");
        assert_eq!(announced, Some(("127.0.0.1".to_owned(), port)));
        assert_eq!(new_primary(payload.as_bytes(), "other"), None);
        let switch = &sentinel(&db).switch;
        *switch.announced() = announced;
        switch.switched.store(true, Ordering::SeqCst);

        let connecting = tokio::time::timeout(Duration::from_millis(200), db.conn());
        let dialled = tokio::time::timeout(Duration::from_secs(1), new.accept());
        let (_, dialled) = tokio::join!(connecting, dialled);
        assert!(dialled.is_ok(), "the announced primary was not dialled");
    }

    #[test]
    fn a_single_server_keeps_its_pool_on_error_replies_only() {
        let db = Redis::new("redis://127.0.0.1:1/0").unwrap();
        db.failed(redis::make_extension_error("EXECABORT".into(), None));
        db.failed(redis::make_extension_error("WRONGTYPE".into(), None));
        assert_eq!(db.pool.epoch(), 0, "an error reply keeps the pool");
        // What broke one connection has usually broken the idle ones too.
        for (kind, epoch) in [
            (std::io::ErrorKind::ConnectionReset, 1),
            (std::io::ErrorKind::UnexpectedEof, 2),
            (std::io::ErrorKind::TimedOut, 3),
        ] {
            db.failed(std::io::Error::from(kind).into());
            assert_eq!(db.pool.epoch(), epoch, "{kind:?}");
        }
        // A DNS name that moved to a new primary leaves every pooled one behind.
        db.failed(redis::make_extension_error("READONLY".into(), None));
        assert_eq!(db.pool.epoch(), 4);
    }

    /// A forwarder to the real Redis whose connections can be cut on demand.
    async fn cuttable(
        upstream: String,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let handles = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let tracked = handles.clone();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let upstream = upstream.clone();
                let task = tokio::spawn(async move {
                    let mut server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                });
                tracked.lock().unwrap().push(task.abort_handle());
            }
        });
        (address, handles)
    }

    #[tokio::test]
    async fn a_dead_idle_connection_is_replaced() {
        let Some(upstream) = upstream() else {
            return;
        };
        let (address, handles) = cuttable(upstream).await;
        let db = Redis::new(&format!("redis://{address}/0")).unwrap();
        let key = crate::util::generate_id();
        let secret = Secret {
            expiration: 60,
            message: "m".into(),
            ..Secret::default()
        };
        db.put(&key, &secret).await.unwrap();
        for handle in handles.lock().unwrap().drain(..) {
            handle.abort();
        }
        db.pool.age_idle(REVALIDATE_AFTER);
        assert_eq!(db.status(&key).await.unwrap().message, "m");
    }

    /// Counts client sends: the client waits for each reply, so one send is one
    /// round trip, and a pipeline goes out as a single send.
    async fn counting(
        upstream: String,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let sends = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = sends.clone();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let (upstream, counter) = (upstream.clone(), counter.clone());
                tokio::spawn(async move {
                    let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let (mut client_read, mut client_write) = client.into_split();
                    let (mut server_read, mut server_write) = server.into_split();
                    tokio::spawn(async move {
                        let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
                    });
                    let mut buffer = vec![0u8; 64 << 10];
                    while let Ok(read) = client_read.read(&mut buffer).await {
                        if read == 0 || server_write.write_all(&buffer[..read]).await.is_err() {
                            break;
                        }
                        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }
        });
        (address, sends)
    }

    /// A replica reached as a plain address, as a DNS name of a managed primary
    /// does after a failover: the claim's EXEC aborts with READONLY inside.
    #[tokio::test]
    async fn a_claim_on_a_replica_clears_the_pool() {
        if std::env::var("SENTINEL_URL").is_err() {
            return;
        }
        let mut nodes = Vec::new();
        for port in [16400, 16401] {
            let url = format!("redis://:redis-pw@127.0.0.1:{port}/0");
            let mut conn = redis::Client::open(url.as_str())
                .unwrap()
                .get_multiplexed_async_connection()
                .await
                .unwrap();
            let role: redis::Role = redis::cmd("ROLE").query_async(&mut conn).await.unwrap();
            nodes.push((matches!(role, redis::Role::Primary { .. }), url, conn));
        }
        nodes.sort_by_key(|(primary, ..)| !primary);
        let key = crate::util::generate_id();
        let secret = Secret {
            expiration: 60,
            message: "m".into(),
            one_time: true,
            ..Secret::default()
        };
        let primary = &mut nodes[0].2;
        let _: () = redis::cmd("SET")
            .arg(&key)
            .arg(encode(&secret).unwrap())
            .arg("EX")
            .arg(60)
            .query_async(primary)
            .await
            .unwrap();
        let _: i64 = redis::cmd("WAIT")
            .arg(1)
            .arg(5000)
            .query_async(primary)
            .await
            .unwrap();

        let db = Redis::new(&nodes[1].1).unwrap();
        assert_eq!(db.status(&key).await.unwrap().message, "m");
        assert_eq!(db.pool.epoch(), 0);
        assert!(db.get(&key).await.is_err());
        assert_eq!(
            db.pool.epoch(),
            1,
            "READONLY inside EXECABORT clears the pool"
        );
    }

    fn upstream() -> Option<String> {
        let parsed = url::Url::parse(&std::env::var("REDIS_URL").ok()?).unwrap();
        Some(format!(
            "{}:{}",
            parsed.host_str().unwrap(),
            parsed.port().unwrap_or(6379)
        ))
    }

    /// A one-time read without a receipt: status, receipt check, claim.
    #[tokio::test]
    async fn a_one_time_read_takes_four_round_trips() {
        use std::sync::atomic::Ordering::SeqCst;
        let Some(upstream) = upstream() else {
            return;
        };
        let (address, sends) = counting(upstream).await;
        let db = Redis::new(&format!("redis://{address}/0")).unwrap();
        let key = crate::util::generate_id();
        let secret = Secret {
            expiration: 60,
            message: "m".into(),
            one_time: true,
            ..Secret::default()
        };
        db.put(&key, &secret).await.unwrap();
        sends.store(0, SeqCst);

        db.status(&key).await.unwrap();
        assert!(matches!(
            db.update(&format!("missing-{key}"), &|v| Ok(v)).await,
            Err(DbError::NotFound)
        ));
        assert_eq!(db.get(&key).await.unwrap().message, "m");
        assert_eq!(sends.load(SeqCst), 4);
        assert!(matches!(db.status(&key).await, Err(DbError::NotFound)));
    }

    impl Redis {
        async fn pool_ttl_kept(&self, key: &str) -> bool {
            let (_permit, mut conn) = self.conn().await.unwrap();
            let ttl: i64 = redis::cmd("PTTL")
                .arg(key)
                .query_async(&mut conn)
                .await
                .unwrap();
            ttl > 50_000
        }
    }

    /// A claim whose reply was lost must not apply later: the settle step fences
    /// the stale EXEC, so the secret stays intact for a retry.
    #[tokio::test]
    async fn a_lost_claim_is_fenced_or_proven() {
        let Ok(url) = std::env::var("REDIS_URL") else {
            return;
        };
        let db = Redis::new(&url).unwrap();
        let key = crate::util::generate_id();
        let claim = claim_key(&key);
        let secret = Secret {
            expiration: 60,
            message: "m".into(),
            one_time: true,
            ..Secret::default()
        };
        db.put(&key, &secret).await.unwrap();

        // A claim still queued on a connection whose reply timed out.
        let mut stale = redis::Client::open(url.as_str())
            .unwrap()
            .get_multiplexed_async_connection()
            .await
            .unwrap();
        assert!(watch_get(&mut stale, &key).await.unwrap().is_some());
        assert!(!db.settle_lost_claim(&key, &claim, "stale-id").await);
        let late: Option<(i64, ())> = redis::pipe()
            .atomic()
            .del(&key)
            .cmd("SET")
            .arg(&claim)
            .arg("stale-id")
            .query_async(&mut stale)
            .await
            .unwrap();
        assert!(late.is_none(), "the fenced EXEC applied");
        assert_eq!(db.status(&key).await.unwrap().message, "m");
        assert!(
            db.pool_ttl_kept(&key).await,
            "the fence must keep the lifetime"
        );

        // The marker with our ID proves the claim applied.
        let _: () = redis::cmd("SET")
            .arg(&claim)
            .arg("mine")
            .query_async(&mut stale)
            .await
            .unwrap();
        assert!(db.settle_lost_claim(&key, &claim, "mine").await);

        // Nothing left to claim and no marker of ours.
        db.delete(&key).await.unwrap();
        assert!(!db.settle_lost_claim(&key, &claim_key("x"), "mine").await);
    }

    #[tokio::test]
    async fn a_multi_view_read_takes_three_round_trips() {
        use std::sync::atomic::Ordering::SeqCst;
        let Some(upstream) = upstream() else {
            return;
        };
        let (address, sends) = counting(upstream).await;
        let db = Redis::new(&format!("redis://{address}/0")).unwrap();
        let key = crate::util::generate_id();
        let secret = Secret {
            expiration: 60,
            message: "m".into(),
            ..Secret::default()
        };
        db.put(&key, &secret).await.unwrap();
        sends.store(0, SeqCst);
        db.status(&key).await.unwrap();
        assert!(matches!(
            db.update(&format!("missing-{key}"), &|v| Ok(v)).await,
            Err(DbError::NotFound)
        ));
        db.get(&key).await.unwrap();
        assert_eq!(sends.load(SeqCst), 3);
        // A pooled connection with stale WATCH state still claims correctly.
        let one_time = Secret {
            one_time: true,
            ..secret
        };
        db.put(&key, &one_time).await.unwrap();
        assert_eq!(db.get(&key).await.unwrap().message, "m");
        assert!(matches!(db.get(&key).await, Err(DbError::NotFound)));
    }

    /// `follow` against a plain Redis, which takes the same SUBSCRIBE and PUBLISH
    /// as a Sentinel: it takes its own primary's announcement, skips another's, and
    /// subscribes again when the connection drops.
    #[tokio::test]
    async fn follow_takes_its_announcements_and_resubscribes() {
        use std::sync::atomic::Ordering::SeqCst;
        let Ok(url) = std::env::var("REDIS_URL") else {
            return;
        };
        async fn until(what: &str, condition: impl Fn() -> bool) {
            for _ in 0..500 {
                if condition() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("never happened: {what}");
        }
        let client = redis::Client::open(url.as_str()).unwrap();
        let mut conn = client.get_multiplexed_async_connection().await.unwrap();
        let master = format!("m-{}", generate_id());
        let switch = Arc::new(Switch::default());
        let follower = tokio::spawn(follow(client, master.clone(), switch.clone()));
        until("subscribed", || switch.switched.swap(false, SeqCst)).await;

        for payload in [
            "other 10.0.0.1 6379 10.0.0.2 6379".to_owned(),
            format!("{master} 10.0.0.1 6379 10.0.0.3 6380"),
        ] {
            let heard: i64 = redis::cmd("PUBLISH")
                .arg(SWITCH_MASTER)
                .arg(payload)
                .query_async(&mut conn)
                .await
                .unwrap();
            assert!(heard >= 1);
        }
        let ours = Some(("10.0.0.3".to_owned(), 6380));
        until("announced", || *switch.announced() == ours).await;
        assert!(switch.switched.swap(false, SeqCst));

        // Ends the subscription the way a restarting Sentinel would.
        let _: i64 = redis::cmd("CLIENT")
            .arg(&["KILL", "TYPE", "pubsub"][..])
            .query_async(&mut conn)
            .await
            .unwrap();
        until("subscribed again", || switch.switched.swap(false, SeqCst)).await;
        follower.abort();
    }
}
