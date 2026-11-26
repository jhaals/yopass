//! Emailed one-time codes for restricted recipients the identity provider does
//! not cover. A code proves the recipient's mailbox; the handler then hands out
//! a short grant for that one secret.
//!
//! Each secret has at most one code record, stored sealed in the shared
//! database so every instance agrees on send limits and guesses.

use crate::app::App;
use crate::auth::Recipients;
use crate::db::{Abort, DbError, Secret};
use crate::lifecycle::Kind;
use crate::util::{constant_time_digest_eq, generate_code, now_unix, redact_error};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const CODE_KEY_PREFIX: &str = "code/";
/// How long a code works once sent.
const CODE_LIFETIME: i64 = 600;
/// Codes per secret within one window.
const MAX_SENDS: u8 = 3;
const SEND_WINDOW: i64 = 600;
/// Codes per secret over its whole life: with `MAX_GUESSES` each, at most 50
/// guesses at a million codes, however long the secret lives.
const MAX_TOTAL_SENDS: u8 = 10;
/// Wrong guesses that burn a code.
const MAX_GUESSES: u8 = 5;

#[derive(Serialize, Deserialize)]
struct CodeState {
    /// Empty once used or burnt.
    code: String,
    guesses: u8,
    sends: u8,
    /// Sends over the secret's life, which the record outlives to count them.
    total: u8,
    window_start: i64,
    code_expires: i64,
    /// The secret's own deadline.
    keep_until: i64,
}

impl CodeState {
    /// Kept as long as the secret, and at least until the code and the send
    /// window are over.
    fn ttl(&self, now: i64) -> i32 {
        let until = (self.window_start + SEND_WINDOW)
            .max(self.code_expires)
            .max(self.keep_until);
        (until - now).clamp(0, i64::from(i32::MAX)) as i32
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Requested {
    Sent,
    /// Not the named recipient of a restricted secret, or one who must sign in.
    NotEligible,
    RateLimited,
    MailUnavailable,
    DbUnavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verified {
    /// The recipient's address, to grant access to.
    Granted(String),
    Wrong,
    /// No live code: none sent, expired, used or burnt.
    NoCode,
    DbUnavailable,
}

fn code_key(db_key: &str) -> String {
    format!("{CODE_KEY_PREFIX}{db_key}")
}

/// The recipient who may get a code for the record under `db_key`, and the
/// record's deadline.
async fn eligible_recipient(app: &App, db_key: &str) -> Result<Option<(String, i64)>, DbError> {
    let secret = match app.db.status(db_key).await {
        Ok(secret) => secret,
        Err(DbError::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let Recipients::Restricted(restriction) = app.recipients(db_key, &secret) else {
        return Ok(None);
    };
    Ok(app
        .code_eligible(&restriction.recipient)
        .then_some((restriction.recipient, restriction.expires_at)))
}

/// The code record read a matching address would cost, so response times do
/// not tell a guessed address from the recipient's.
async fn read_like_a_match(app: &App, db_key: &str) {
    let _ = app.db.status(&code_key(db_key)).await;
}

fn seal(app: &App, db_key: &str, state: &CodeState, ttl: i32) -> Result<Secret, DbError> {
    let message = app
        .recipients
        .as_ref()
        .and_then(|codec| codec.seal(&code_key(db_key), state, i64::from(ttl)))
        .ok_or_else(|| DbError::Backend("failed to seal code".into()))?;
    Ok(Secret {
        message,
        expiration: ttl,
        ..Secret::default()
    })
}

fn open(app: &App, db_key: &str, record: &Secret) -> Option<CodeState> {
    app.recipients
        .as_ref()?
        .open(&code_key(db_key), &record.message)
}

/// The code state after sending `code` at `now`, or `None` when a send limit
/// forbids it: 3 per 10-minute window, `MAX_TOTAL_SENDS` over the secret's life.
fn next_code(old: Option<&CodeState>, code: &str, now: i64, keep_until: i64) -> Option<CodeState> {
    let (sends, total, window_start) = match old {
        None => (1, 1, now),
        Some(old) if old.total >= MAX_TOTAL_SENDS => return None,
        Some(old) if now < old.window_start + SEND_WINDOW => {
            if old.sends >= MAX_SENDS {
                return None;
            }
            (old.sends + 1, old.total + 1, old.window_start)
        }
        Some(old) => (1, old.total + 1, now),
    };
    Some(CodeState {
        code: code.to_owned(),
        guesses: 0,
        sends,
        total,
        window_start,
        code_expires: now + CODE_LIFETIME,
        keep_until,
    })
}

/// Sends a new code if `email` is the recipient of restricted secret `id` and
/// may use one. A new code replaces the previous one.
pub async fn request(app: &App, kind: Kind, id: &str, email: &str) -> Requested {
    let db_key = kind.db_key(id);
    let (recipient, keep_until) = match eligible_recipient(app, &db_key).await {
        Ok(Some((recipient, until))) if recipient.eq_ignore_ascii_case(email.trim()) => {
            (recipient, until)
        }
        Ok(_) => {
            read_like_a_match(app, &db_key).await;
            return Requested::NotEligible;
        }
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Unable to read secret");
            return Requested::DbUnavailable;
        }
    };
    let Some(mailer) = app.mailer() else {
        return Requested::MailUnavailable;
    };
    let now = now_unix();
    let code = generate_code();
    let key = code_key(&db_key);
    let limited = || DbError::Aborted(Abort::Unchanged);
    let next = |record: Secret| {
        // Sealed under an old key: the restriction would be unreadable too.
        let old = open(app, &db_key, &record).ok_or_else(limited)?;
        let state = next_code(Some(&old), &code, now, keep_until).ok_or_else(limited)?;
        seal(app, &db_key, &state, state.ttl(now))
    };
    // The first code creates the record. Of racing first requests only one
    // creates it; the others count against it like any later request.
    let mut stored = app.db.update(&key, &next).await;
    if matches!(stored, Err(DbError::NotFound)) {
        let first =
            next_code(None, &code, now, keep_until).expect("a first code is always allowed");
        stored = match seal(app, &db_key, &first, first.ttl(now)) {
            Ok(record) => match app.db.create(&key, &record).await {
                Ok(true) => Ok(()),
                Ok(false) => app.db.update(&key, &next).await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
    }
    match stored {
        Ok(()) => {}
        Err(DbError::Aborted(Abort::Unchanged)) => return Requested::RateLimited,
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Unable to store code");
            return Requested::DbUnavailable;
        }
    }
    if mailer.recipient_code(id, &recipient, &code, now + CODE_LIFETIME) {
        Requested::Sent
    } else {
        Requested::MailUnavailable
    }
}

/// Checks `code` against the live code of secret `id`. A match uses it up; a
/// miss counts as a guess, and the last allowed miss burns it. A guess needs
/// the recipient's address, so a link alone cannot burn the recipient's codes.
pub async fn verify(app: &App, kind: Kind, id: &str, email: &str, code: &str) -> Verified {
    let db_key = kind.db_key(id);
    let recipient = match eligible_recipient(app, &db_key).await {
        Ok(Some((recipient, _))) if recipient.eq_ignore_ascii_case(email.trim()) => recipient,
        Ok(_) => {
            read_like_a_match(app, &db_key).await;
            return Verified::NoCode;
        }
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Unable to read secret");
            return Verified::DbUnavailable;
        }
    };
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Verified::Wrong;
    }
    let matched = Mutex::new(false);
    let now = now_unix();
    let result = app
        .db
        .update(&code_key(&db_key), &|record| {
            let mut state =
                open(app, &db_key, &record).ok_or(DbError::Aborted(Abort::InvalidToken))?;
            if state.code.is_empty() || now >= state.code_expires || state.guesses >= MAX_GUESSES {
                return Err(DbError::Aborted(Abort::InvalidToken));
            }
            let hit = constant_time_digest_eq(code.as_bytes(), state.code.as_bytes());
            if hit {
                state.code.clear();
            } else {
                state.guesses += 1;
                if state.guesses >= MAX_GUESSES {
                    state.code.clear();
                }
            }
            *matched.lock().unwrap_or_else(|e| e.into_inner()) = hit;
            let ttl = state.ttl(now);
            if ttl == 0 {
                return Err(DbError::NotFound);
            }
            seal(app, &db_key, &state, ttl)
        })
        .await;
    match result {
        Ok(()) if *matched.lock().unwrap_or_else(|e| e.into_inner()) => {
            Verified::Granted(recipient)
        }
        Ok(()) => Verified::Wrong,
        Err(DbError::Aborted(_) | DbError::NotFound) => Verified::NoCode,
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Unable to check code");
            Verified::DbUnavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends `code` at each time in turn; returns which were allowed.
    fn sends(times: &[i64]) -> Vec<bool> {
        let mut state: Option<CodeState> = None;
        times
            .iter()
            .map(
                |&now| match next_code(state.as_ref(), "123456", now, 10_000_000) {
                    Some(next) => {
                        state = Some(next);
                        true
                    }
                    None => false,
                },
            )
            .collect()
    }

    #[test]
    fn three_codes_per_window_and_ten_per_secret() {
        // A fourth within the window waits for the next one.
        assert_eq!(sends(&[0, 1, 2, 3]), [true, true, true, false]);
        assert_eq!(sends(&[0, 1, 2, 600]), [true, true, true, true]);
        // Three per window for hours still stops at ten in all.
        let times: Vec<i64> = (0..8)
            .flat_map(|w| [w * 600, w * 600 + 1, w * 600 + 2])
            .collect();
        let allowed = sends(&times);
        assert_eq!(allowed.iter().filter(|a| **a).count(), 10, "{allowed:?}");
        assert!(allowed[10..].iter().all(|a| !a), "{allowed:?}");
    }

    #[test]
    fn the_record_outlives_the_window_while_the_secret_lives() {
        let state = next_code(None, "123456", 0, 86_400).unwrap();
        assert_eq!(state.ttl(0), 86_400);
        let short = next_code(None, "123456", 0, 60).unwrap();
        assert_eq!(short.ttl(0), 600, "the code and its window run out first");
    }
}
