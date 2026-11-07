//! The database contract, run against every reachable backend.

mod common;

use common::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::task::JoinSet;
use yopass_server::db::memcached::Memcached;
use yopass_server::db::redis::Redis;
use yopass_server::db::{Abort, Database, DbError, Secret};
use yopass_server::util::generate_id;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn exactly_one_caller_wins_a_one_time_claim() {
    for (name, db) in backends() {
        for _ in 0..10 {
            let key = generate_id();
            db.put(&key, &secret("encrypted", true)).await.unwrap();
            let mut tasks = JoinSet::new();
            let start = Arc::new(tokio::sync::Barrier::new(20));
            for _ in 0..20 {
                let (db, key, start) = (db.clone(), key.clone(), start.clone());
                tasks.spawn(async move {
                    start.wait().await;
                    db.get(&key).await
                });
            }
            let mut wins = 0;
            while let Some(result) = tasks.join_next().await {
                match result.unwrap() {
                    Ok(value) => {
                        wins += 1;
                        assert_eq!(value.message, "encrypted", "{name}");
                    }
                    Err(DbError::NotFound) => {}
                    Err(error) => panic!("{name}: unexpected claim error: {error}"),
                }
            }
            assert_eq!(wins, 1, "{name}: secret delivered {wins} times");
            assert!(
                matches!(db.status(&key).await, Err(DbError::NotFound)),
                "{name}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn claim_and_delete_racing_never_deliver_after_removal() {
    for (name, db) in backends() {
        for _ in 0..20 {
            let key = generate_id();
            db.put(&key, &secret("encrypted", true)).await.unwrap();
            let (a, b) = (db.clone(), db.clone());
            let (ka, kb) = (key.clone(), key.clone());
            let claim = tokio::spawn(async move { a.get(&ka).await });
            let delete = tokio::spawn(async move { b.delete_authorized(&kb, &|_| Ok(())).await });
            let (claim, delete) = (claim.await.unwrap(), delete.await.unwrap());
            let winners = usize::from(claim.is_ok()) + usize::from(delete.is_ok());
            assert_eq!(
                winners, 1,
                "{name}: exactly one of claim and delete must win"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multi_view_values_stay_readable() {
    for (name, db) in backends() {
        let key = generate_id();
        db.put(&key, &secret("encrypted", false)).await.unwrap();
        for _ in 0..3 {
            assert_eq!(db.get(&key).await.unwrap().message, "encrypted", "{name}");
        }
        assert!(db.delete(&key).await.unwrap(), "{name}");
        assert!(!db.delete(&key).await.unwrap(), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_never_consumes() {
    for (name, db) in backends() {
        let key = generate_id();
        db.put(&key, &secret("encrypted", true)).await.unwrap();
        for _ in 0..3 {
            assert!(db.status(&key).await.unwrap().one_time, "{name}");
        }
        assert_eq!(db.get(&key).await.unwrap().message, "encrypted", "{name}");
    }
}

#[derive(Clone, Copy, Debug)]
enum Interference {
    Put,
    Update,
    Delete,
    IdenticalPut,
    IdenticalUpdate,
    DeleteRecreate,
}

/// A claim must fail if any write replaced the authorized snapshot, even with
/// identical content: its access policy was checked on the old version.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn claim_rejects_a_replaced_value() {
    use Interference::*;
    for (name, db) in backends() {
        for operation in [
            Put,
            Update,
            Delete,
            IdenticalPut,
            IdenticalUpdate,
            DeleteRecreate,
        ] {
            let key = generate_id();
            let original = secret("original", true);
            db.put(&key, &original).await.unwrap();
            let replacement =
                if matches!(operation, IdenticalPut | IdenticalUpdate | DeleteRecreate) {
                    original.clone()
                } else {
                    Secret {
                        message: "replacement".into(),
                        expiration: 60,
                        one_time: false,
                        require_auth: true,
                    }
                };
            let calls = AtomicUsize::new(0);
            let (interfering, k, r) = (db.clone(), key.clone(), replacement.clone());
            let result = db
                .get_authorized(&key, &|snapshot| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(snapshot, &original);
                    let (db, k, r) = (interfering.clone(), k.clone(), r.clone());
                    block_on(async move {
                        match operation {
                            Put | IdenticalPut => db.put(&k, &r).await.unwrap(),
                            Update | IdenticalUpdate => {
                                let r = r.clone();
                                db.update(&k, &move |_| Ok(r.clone())).await.unwrap();
                            }
                            Delete => {
                                db.delete(&k).await.unwrap();
                            }
                            DeleteRecreate => {
                                db.delete(&k).await.unwrap();
                                db.put(&k, &r).await.unwrap();
                            }
                        }
                    });
                    Ok(())
                })
                .await;
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{name}/{operation:?}");
            assert!(
                matches!(result, Err(DbError::NotFound)),
                "{name}/{operation:?}: stale claim returned {result:?}"
            );
            if !matches!(operation, Delete) {
                let current = db.status(&key).await.unwrap();
                assert_eq!(
                    current, replacement,
                    "{name}/{operation:?}: replacement changed"
                );
                db.delete(&key).await.unwrap();
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn denied_authorization_leaves_the_value_intact() {
    for (name, db) in backends() {
        let key = generate_id();
        let original = Secret {
            require_auth: true,
            ..secret("protected", true)
        };
        db.put(&key, &original).await.unwrap();
        for _ in 0..3 {
            let denied = db
                .get_authorized(&key, &|_| Err(Abort::Unauthenticated))
                .await;
            assert!(
                matches!(denied, Err(DbError::Aborted(Abort::Unauthenticated))),
                "{name}"
            );
            assert_eq!(
                db.status(&key).await.unwrap(),
                original,
                "{name}: denied read consumed value"
            );
            let denied = db
                .delete_authorized(&key, &|_| Err(Abort::DomainForbidden))
                .await;
            assert!(
                matches!(denied, Err(DbError::Aborted(Abort::DomainForbidden))),
                "{name}"
            );
            assert_eq!(
                db.status(&key).await.unwrap(),
                original,
                "{name}: denied delete removed value"
            );
        }
        // Denials must not leak connection state into the next authorized claim.
        assert_eq!(db.get(&key).await.unwrap().message, "protected", "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authorized_delete_preserves_a_replacement() {
    for (name, db) in backends() {
        for one_time in [false, true] {
            let key = generate_id();
            let original = secret("encrypted", one_time);
            db.put(&key, &original).await.unwrap();
            let (interfering, k, o) = (db.clone(), key.clone(), original.clone());
            let raced = db
                .delete_authorized(&key, &|_| {
                    let (db, k, o) = (interfering.clone(), k.clone(), o.clone());
                    block_on(async move { db.put(&k, &o).await.unwrap() });
                    Ok(())
                })
                .await;
            assert!(matches!(raced, Err(DbError::NotFound)), "{name}");
            assert_eq!(
                db.status(&key).await.unwrap(),
                original,
                "{name}: replacement lost"
            );

            let seen = original.clone();
            db.delete_authorized(&key, &|snapshot| {
                assert_eq!(snapshot, &seen);
                Ok(())
            })
            .await
            .unwrap();
            assert!(
                matches!(db.status(&key).await, Err(DbError::NotFound)),
                "{name}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn updates_are_atomic_under_contention() {
    for (name, db) in backends() {
        let key = generate_id();
        let initial = Secret {
            message: "0".into(),
            expiration: 60,
            ..Secret::default()
        };
        db.put(&key, &initial).await.unwrap();
        let mut tasks = JoinSet::new();
        for _ in 0..12 {
            let (db, key) = (db.clone(), key.clone());
            tasks.spawn(async move {
                for _ in 0..20 {
                    let done = db
                        .update(&key, &|mut value| {
                            value.message = (value.message.parse::<u32>().unwrap() + 1).to_string();
                            Ok(value)
                        })
                        .await;
                    if done.is_ok() {
                        return 1;
                    }
                }
                0
            });
        }
        let mut applied = 0;
        while let Some(result) = tasks.join_next().await {
            applied += result.unwrap();
        }
        let stored: u32 = db.status(&key).await.unwrap().message.parse().unwrap();
        assert_eq!(stored, applied, "{name}: a concurrent update was lost");
        assert!(applied > 0, "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn update_aborts_and_missing_keys() {
    for (name, db) in backends() {
        let key = generate_id();
        let missing = db.update(&key, &|value| Ok(value)).await;
        assert!(matches!(missing, Err(DbError::NotFound)), "{name}");
        db.put(&key, &secret("kept", false)).await.unwrap();
        let aborted = db
            .update(&key, &|_| Err(DbError::Aborted(Abort::Unchanged)))
            .await;
        assert!(
            matches!(aborted, Err(DbError::Aborted(Abort::Unchanged))),
            "{name}"
        );
        assert_eq!(db.status(&key).await.unwrap().message, "kept", "{name}");
        // The next operation on that connection must not inherit its WATCH.
        db.update(&key, &|mut value| {
            value.message = "changed".into();
            Ok(value)
        })
        .await
        .unwrap();
        assert_eq!(db.status(&key).await.unwrap().message, "changed", "{name}");
    }
}

/// Zero means "never expire" to the backends, so it must never be stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn values_without_a_lifetime_are_refused() {
    for (name, db) in backends() {
        let key = generate_id();
        let forever = Secret {
            message: "m".into(),
            ..Secret::default()
        };
        assert!(db.put(&key, &forever).await.is_err(), "{name}");
        assert!(
            matches!(db.status(&key).await, Err(DbError::NotFound)),
            "{name}"
        );
        db.put(&key, &secret("m", false)).await.unwrap();
        let unbounded = db
            .update(&key, &|_| {
                Ok(Secret {
                    message: "x".into(),
                    ..Secret::default()
                })
            })
            .await;
        assert!(unbounded.is_err(), "{name}");
        assert_eq!(db.status(&key).await.unwrap().message, "m", "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn values_expire() {
    for (name, db) in backends() {
        let key = generate_id();
        let short = Secret {
            expiration: 1,
            ..secret("m", false)
        };
        db.put(&key, &short).await.unwrap();
        assert!(db.status(&key).await.is_ok(), "{name}");
        tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
        assert!(
            matches!(db.status(&key).await, Err(DbError::NotFound)),
            "{name}"
        );
    }
}

/// Lifetimes past Memcached's 30-day relative limit must not expire immediately.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn long_lifetimes_survive() {
    for (name, db) in backends() {
        let key = generate_id();
        let long = Secret {
            expiration: 90 * 86400,
            ..secret("m", false)
        };
        db.put(&key, &long).await.unwrap();
        assert_eq!(
            db.status(&key).await.unwrap().expiration,
            90 * 86400,
            "{name}"
        );
        db.update(&key, &|value| Ok(value)).await.unwrap();
        assert!(db.status(&key).await.is_ok(), "{name}");
        db.delete(&key).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn health_succeeds() {
    for (name, db) in backends() {
        db.health().await.unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

async fn lossy_redis(url: &str, command: &'static [u8]) -> (LossyProxy, Arc<dyn Database>) {
    let parsed = url::Url::parse(url).unwrap();
    let upstream = format!(
        "{}:{}",
        parsed.host_str().unwrap(),
        parsed.port().unwrap_or(6379)
    );
    let proxy = LossyProxy::start(upstream, command).await;
    let db: Arc<dyn Database> =
        Arc::new(Redis::new(&format!("redis://{}{}", proxy.address, parsed.path())).unwrap());
    (proxy, db)
}

async fn lossy_backends(
    redis_command: &'static [u8],
    memcached_command: &'static [u8],
) -> Vec<(&'static str, LossyProxy, Arc<dyn Database>)> {
    let mut list = Vec::new();
    if let Some(url) = redis_url() {
        let (proxy, db) = lossy_redis(&url, redis_command).await;
        list.push(("redis", proxy, db));
    }
    if let Some(url) = std::env::var("VALKEY_URL").ok().filter(|v| !v.is_empty()) {
        let (proxy, db) = lossy_redis(&url, redis_command).await;
        list.push(("valkey", proxy, db));
    }
    if let Some(address) = memcached_addr() {
        let proxy = LossyProxy::start(address, memcached_command).await;
        let db: Arc<dyn Database> = Arc::new(Memcached::new(&proxy.address));
        list.push(("memcached", proxy, db));
    }
    list
}

const REDIS_EXEC: &[u8] = b"EXEC\r\n";
const MEMCACHED_CAS: &[u8] = b"cas ";

/// The claim applied but its reply was lost: the caller must still get the secret,
/// exactly once, and everyone else must see it gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_claim_reply_still_delivers_exactly_once() {
    for (name, proxy, db) in lossy_backends(REDIS_EXEC, MEMCACHED_CAS).await {
        for delete_value in [false, true] {
            let key = generate_id();
            let original = secret("encrypted", !delete_value);
            db.put(&key, &original).await.unwrap();
            proxy.fault.store(FAULT_LOST_REPLY, Ordering::SeqCst);
            if delete_value {
                db.delete_authorized(&key, &|_| Ok(()))
                    .await
                    .unwrap_or_else(|e| panic!("{name}: applied delete lost: {e}"));
            } else {
                assert_eq!(
                    db.get(&key)
                        .await
                        .unwrap_or_else(|e| panic!("{name}: applied claim lost: {e}")),
                    original
                );
            }
            assert_eq!(
                proxy.fault.load(Ordering::SeqCst),
                FAULT_NONE,
                "{name}: no reply was lost"
            );
            assert!(
                matches!(db.get(&key).await, Err(DbError::NotFound)),
                "{name}"
            );
            assert!(
                matches!(db.status(&key).await, Err(DbError::NotFound)),
                "{name}"
            );
            assert!(
                matches!(db.update(&key, &|v| Ok(v)).await, Err(DbError::NotFound)),
                "{name}"
            );
        }
    }
}

/// The claim never reached the backend: the secret must not be lost.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_claim_command_keeps_the_secret_retrievable() {
    for (name, proxy, db) in lossy_backends(REDIS_EXEC, MEMCACHED_CAS).await {
        let key = generate_id();
        let original = secret("encrypted", true);
        db.put(&key, &original).await.unwrap();
        proxy.fault.store(FAULT_LOST_COMMAND, Ordering::SeqCst);
        // Either outcome is fine as long as the secret is delivered once.
        let got = match db.get(&key).await {
            Ok(value) => value,
            Err(_) => db
                .get(&key)
                .await
                .unwrap_or_else(|e| panic!("{name}: secret lost: {e}")),
        };
        assert_eq!(got, original, "{name}");
        assert!(
            matches!(db.get(&key).await, Err(DbError::NotFound)),
            "{name}"
        );
    }
}

/// Another caller won, and this caller's reply was lost too: no second delivery.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_reply_after_losing_the_race_delivers_nothing() {
    for (name, proxy, db) in lossy_backends(REDIS_EXEC, MEMCACHED_CAS).await {
        let key = generate_id();
        db.put(&key, &secret("encrypted", true)).await.unwrap();
        // A separate client, so the winner's traffic does not trip the fault.
        let winner = direct_client(name);
        let (w, k, fault) = (winner.clone(), key.clone(), proxy.fault.clone());
        let result = db
            .get_authorized(&key, &|_| {
                let (w, k) = (w.clone(), k.clone());
                block_on(async move { w.get(&k).await.unwrap() });
                fault.store(FAULT_LOST_REPLY, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(result.is_err(), "{name}: secret delivered twice");
    }
}

fn direct_client(name: &str) -> Arc<dyn Database> {
    match name {
        "memcached" => Arc::new(Memcached::new(&memcached_addr().unwrap())),
        "valkey" => Arc::new(Redis::new(&std::env::var("VALKEY_URL").unwrap()).unwrap()),
        _ => Arc::new(Redis::new(&redis_url().unwrap()).unwrap()),
    }
}

/// A write whose reply was lost is reported as failed and never sent again: a
/// delayed copy could restore a value after it was claimed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn writes_are_never_resent() {
    for (name, proxy, db) in lossy_backends(b"\r\nSET\r\n", b"set ").await {
        let key = generate_id();
        proxy.fault.store(FAULT_LOST_REPLY, Ordering::SeqCst);
        let before = proxy.seen.load(Ordering::SeqCst);
        assert!(
            db.put(&key, &secret("foo", true)).await.is_err(),
            "{name}: Put succeeded though its reply was lost"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(
            proxy.seen.load(Ordering::SeqCst) - before,
            1,
            "{name}: SET was resent"
        );
        db.delete(&key).await.unwrap();
    }
}

#[tokio::test]
async fn health_fails_when_the_backend_is_unreachable() {
    assert!(Memcached::new("127.0.0.1:1").health().await.is_err());
    assert!(
        Redis::new("redis://127.0.0.1:1/0")
            .unwrap()
            .health()
            .await
            .is_err()
    );
}

/// Writes bytes that are not a record, as a foreign writer or corruption would.
async fn store_raw(name: &str, key: &str, value: &str) {
    if name == "memcached" {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut conn = tokio::net::TcpStream::connect(memcached_addr().unwrap())
            .await
            .unwrap();
        let command = format!("set {key} 0 60 {}\r\n{value}\r\n", value.len());
        conn.write_all(command.as_bytes()).await.unwrap();
        let mut reply = [0; 8];
        conn.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"STORED\r\n");
    } else {
        let mut conn = if name == "sentinel" {
            let url = sentinel_url().unwrap();
            let primary = sentinel_primary(&mut sentinel_conn(&url).await).await;
            sentinel_node(&url, &primary).await
        } else {
            let url = if name == "valkey" {
                std::env::var("VALKEY_URL").unwrap()
            } else {
                redis_url().unwrap()
            };
            redis::Client::open(url.as_str())
                .unwrap()
                .get_multiplexed_async_connection()
                .await
                .unwrap()
        };
        let () = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("EX")
            .arg(60)
            .query_async(&mut conn)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn undecodable_records_are_errors_and_are_never_consumed() {
    for (name, db) in backends() {
        if name == "memory" {
            continue;
        }
        let key = generate_id();
        store_raw(name, &key, "not json").await;
        let backend = |result: Result<(), DbError>| matches!(result, Err(DbError::Backend(_)));
        assert!(backend(db.status(&key).await.map(drop)), "{name}: status");
        assert!(
            backend(db.get_authorized(&key, &|_| Ok(())).await.map(drop)),
            "{name}: claim"
        );
        assert!(
            backend(db.delete_authorized(&key, &|_| Ok(())).await),
            "{name}: authorized delete"
        );
        assert!(backend(db.update(&key, &|s| Ok(s)).await), "{name}: update");

        // Over HTTP it is an outage, never content and never "not found".
        let harness = Builder::with_db(db.clone()).build();
        let response = harness.get(&format!("/secret/{key}")).await;
        assert!(
            response.status.is_server_error(),
            "{name}: {}",
            response.status
        );
        assert!(!response.text().contains("not json"));
        assert!(!response.text().contains(&key));
        // Still there for an operator to inspect.
        assert!(
            db.delete(&key).await.unwrap(),
            "{name}: the record was consumed"
        );
    }
}
