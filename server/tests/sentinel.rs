//! Redis Sentinel against a real Sentinel set: the primary is found through
//! Sentinel and followed across a failover without a restart.
//!
//! Start one with `tests/sentinel.sh DIR` and export the URL it prints as
//! SENTINEL_URL. The database contract and the Go comparison also run on it.

mod common;

use common::{sentinel_conn, sentinel_node, sentinel_primary, sentinel_url};
use redis::AsyncCommands;
use std::time::Duration;
use yopass_server::db::redis::Redis;
use yopass_server::db::{Database, DbError, Secret};

const MASTER: &str = "mymaster";

fn secret(one_time: bool) -> Secret {
    Secret {
        message: "sentinel".into(),
        expiration: 3600,
        one_time,
        require_auth: false,
    }
}

async fn role(url: &str, address: &(String, u16)) -> String {
    let role: Vec<redis::Value> = redis::cmd("ROLE")
        .query_async(&mut sentinel_node(url, address).await)
        .await
        .unwrap();
    match &role[0] {
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        other => format!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_primary_is_followed_across_a_failover() {
    let Some(url) = sentinel_url() else {
        eprintln!("skipped: set SENTINEL_URL (see tests/sentinel.sh)");
        return;
    };
    let db = Redis::new(&url).unwrap();
    let mut sentinel = sentinel_conn(&url).await;
    let old = sentinel_primary(&mut sentinel).await;

    db.put("sentinel:kept", &secret(false)).await.unwrap();
    db.put("sentinel:once", &secret(true)).await.unwrap();
    // Replicated before the failover, so the new primary has them. A set
    // that just failed back may still be reconnecting its replica.
    let mut on_old = sentinel_node(&url, &old).await;
    let mut replicas = 0;
    for _ in 0..30 {
        let acked: redis::RedisResult<i64> = redis::cmd("WAIT")
            .arg(1)
            .arg(500)
            .query_async(&mut on_old)
            .await;
        replicas = acked.unwrap_or(0);
        if replicas == 1 {
            break;
        }
    }
    assert_eq!(replicas, 1, "the replica is not in sync");
    // Fill the pool with idle connections to the old primary.
    let warm: Vec<_> = (0..8).map(|_| db.status("sentinel:kept")).collect();
    for status in futures_util::future::join_all(warm).await {
        status.unwrap();
    }

    failover(&mut sentinel, false).await;
    let mut new = old.clone();
    for _ in 0..300 {
        new = sentinel_primary(&mut sentinel).await;
        if new != old && role(&url, &new).await == "master" && role(&url, &old).await == "slave" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_ne!(new, old, "the failover did not complete");

    // The first operation may still meet the old primary; one failure must
    // retire every pooled connection to it.
    let mut failures = 0;
    while db.put("sentinel:after", &secret(false)).await.is_err() {
        failures += 1;
        assert!(failures <= 1, "pooled connections outlived the failover");
    }
    let mut on_new = sentinel_node(&url, &new).await;
    let stored: Option<String> = on_new.get("sentinel:after").await.unwrap();
    assert!(stored.is_some(), "the write must reach the new primary");

    // Data from before the failover, and a one-time secret delivered once.
    assert!(db.status("sentinel:kept").await.is_ok());
    let allow = |_: &Secret| Ok(());
    db.get_authorized("sentinel:once", &allow).await.unwrap();
    assert!(matches!(
        db.get_authorized("sentinel:once", &allow).await,
        Err(DbError::NotFound)
    ));
    db.health().await.unwrap();

    // Fail back, so the set is as the script started it, once the demoted
    // node has resynced enough for Sentinel to promote it.
    failover(&mut sentinel, true).await;
    for _ in 0..300 {
        if sentinel_primary(&mut sentinel).await == old && role(&url, &old).await == "master" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the set did not fail back");
}

/// Asks Sentinel to fail over, retrying while it knows no eligible replica yet.
/// `after_failover` also retries while Sentinel finishes the previous one; the
/// first call does not, so it never retries into a failover it did not start.
async fn failover(sentinel: &mut redis::aio::MultiplexedConnection, after_failover: bool) {
    for attempt in 0.. {
        let failover: redis::RedisResult<()> = redis::cmd("SENTINEL")
            .arg("FAILOVER")
            .arg(MASTER)
            .query_async(sentinel)
            .await;
        match failover {
            Ok(()) => return,
            Err(error) if attempt < 100 => {
                let text = format!("{error:?}");
                assert!(
                    text.contains("NOGOODSLAVE") || (after_failover && text.contains("INPROG")),
                    "{error:?}"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(error) => panic!("{error:?}"),
        }
    }
}
