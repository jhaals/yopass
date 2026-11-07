//! A minimal connection pool. A connection returns to the pool only through an
//! explicit `check_in`, so anything that failed, timed out or holds server-side
//! state is closed by simply being dropped.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Semaphore, SemaphorePermit};

/// Idle connections older than this are probed before reuse.
pub(super) const REVALIDATE_AFTER: Duration = Duration::from_secs(15);

pub(super) struct Pool<T> {
    idle: Mutex<Vec<(T, Instant)>>,
    permits: Semaphore,
    /// Bumped by `clear`, so connections out at the time cannot come back.
    epoch: AtomicU64,
}

/// The right to use one connection, until dropped.
pub(super) struct Lease<'a> {
    _permit: SemaphorePermit<'a>,
    epoch: u64,
}

impl<T> Pool<T> {
    pub(super) fn new(max_connections: usize) -> Self {
        Self {
            idle: Mutex::new(Vec::new()),
            permits: Semaphore::new(max_connections),
            epoch: AtomicU64::new(0),
        }
    }

    /// Waits for capacity and returns an idle connection, if any, with its age.
    pub(super) async fn check_out(
        &self,
        wait: Duration,
    ) -> Result<(Lease<'_>, Option<(T, Duration)>), &'static str> {
        let permit = tokio::time::timeout(wait, self.permits.acquire())
            .await
            .map_err(|_| "timed out waiting for a database connection")?
            .map_err(|_| "database connection pool closed")?;
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        let lease = Lease {
            _permit: permit,
            epoch: self.epoch.load(Ordering::SeqCst),
        };
        let conn = idle.pop().map(|(conn, since)| (conn, since.elapsed()));
        Ok((lease, conn))
    }

    /// Returns a connection for reuse, unless the pool was cleared since it
    /// was checked out.
    pub(super) fn check_in(&self, conn: T, lease: &Lease<'_>) {
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        if lease.epoch == self.epoch.load(Ordering::SeqCst) {
            idle.push((conn, Instant::now()));
        }
    }

    /// Lets a connection opened under `lease` after a clear return to the pool.
    pub(super) fn renew(&self, lease: &mut Lease<'_>) {
        lease.epoch = self.epoch.load(Ordering::SeqCst);
    }

    /// Drops every idle connection, and every busy one when it comes back.
    pub(super) fn clear(&self) {
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        self.epoch.fetch_add(1, Ordering::SeqCst);
        idle.clear();
    }

    #[cfg(test)]
    pub(super) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Makes idle connections look older, so tests reach the revalidation path.
    #[cfg(test)]
    pub(super) fn age_idle(&self, by: Duration) {
        for (_, since) in self.idle.lock().unwrap().iter_mut() {
            *since = since.checked_sub(by).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_clear_also_retires_connections_that_were_out() {
        let pool = Pool::new(4);
        let (before, _) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        pool.check_in("idle", &before);
        let (out, idle) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        assert_eq!(idle.map(|(c, _)| c), Some("idle"));
        pool.check_in("kept", &before);
        pool.clear();
        pool.check_in("stale", &out);
        drop((before, out));
        let (after, idle) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        assert!(idle.is_none(), "nothing from before the clear comes back");
        pool.check_in("fresh", &after);
        let (_, idle) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        assert_eq!(idle.map(|(c, _)| c), Some("fresh"));
    }

    #[tokio::test]
    async fn a_renewed_lease_may_return_a_connection_opened_after_a_clear() {
        let pool = Pool::new(4);
        let (mut lease, _) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        pool.clear();
        pool.renew(&mut lease);
        pool.check_in("fresh", &lease);
        drop(lease);
        let (_, idle) = pool.check_out(Duration::from_secs(1)).await.unwrap();
        assert_eq!(idle.map(|(c, _)| c), Some("fresh"));
    }
}
