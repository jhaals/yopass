//! An in-process backend for tests. It implements the same contract as the real
//! backends but cannot be selected through configuration.

use super::{Authorize, Database, DbError, Secret, UpdateFn, require_lifetime};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct MemoryDb {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    version: u64,
    items: HashMap<String, Item>,
}

#[derive(Clone)]
struct Item {
    secret: Secret,
    version: u64,
    expires: Instant,
}

impl MemoryDb {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn keys(&self) -> Vec<String> {
        let state = self.lock();
        state.items.keys().cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn snapshot(&self, key: &str) -> Result<Item, DbError> {
        self.lock()
            .items
            .get(key)
            .filter(|item| item.expires > Instant::now())
            .cloned()
            .ok_or(DbError::NotFound)
    }

    /// Removes exactly the version that was authorized.
    fn claim(&self, key: &str, version: u64) -> Result<(), DbError> {
        let mut state = self.lock();
        match state.items.get(key) {
            Some(item) if item.version == version => {
                state.items.remove(key);
                Ok(())
            }
            _ => Err(DbError::NotFound),
        }
    }

    fn store(state: &mut State, key: &str, secret: Secret) {
        state.version += 1;
        let item = Item {
            expires: Instant::now() + Duration::from_secs(secret.expiration.max(0) as u64),
            secret,
            version: state.version,
        };
        state.items.insert(key.to_owned(), item);
    }
}

#[async_trait]
impl Database for MemoryDb {
    async fn status(&self, key: &str) -> Result<Secret, DbError> {
        Ok(self.snapshot(key)?.secret)
    }

    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError> {
        let item = self.snapshot(key)?;
        authorize(&item.secret).map_err(DbError::Aborted)?;
        if item.secret.one_time {
            self.claim(key, item.version)?;
        }
        Ok(item.secret)
    }

    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError> {
        let item = self.snapshot(key)?;
        authorize(&item.secret).map_err(DbError::Aborted)?;
        self.claim(key, item.version)
    }

    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError> {
        require_lifetime(secret)?;
        Self::store(&mut self.lock(), key, secret.clone());
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<bool, DbError> {
        Ok(self.lock().items.remove(key).is_some())
    }

    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError> {
        for _ in 0..super::UPDATE_RETRIES {
            let item = self.snapshot(key)?;
            let updated = update(item.secret)?;
            require_lifetime(&updated)?;
            let mut state = self.lock();
            if state
                .items
                .get(key)
                .is_some_and(|c| c.version == item.version)
            {
                Self::store(&mut state, key, updated);
                return Ok(());
            }
        }
        Err(DbError::Backend("update lost too many races".into()))
    }

    async fn health(&self) -> Result<(), DbError> {
        Ok(())
    }
}
