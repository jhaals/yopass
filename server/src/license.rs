//! Business license verification. A license is a JWT signed with ES256.

use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const LICENSE_PUBLIC_KEY: &[u8] = include_bytes!("../../pkg/server/license_public.pem");
const WARN_WINDOW_SECONDS: i64 = 30 * 86400;
const WARN_INTERVAL_SECONDS: i64 = 86400;

/// The outcome of license verification. Feature gates must call
/// `currently_valid`, which also accounts for expiry while the process runs.
#[derive(Clone, Debug, Default)]
pub struct License {
    pub valid: bool,
    pub expires_at: Option<i64>,
    pub licensee: String,
}

#[derive(Deserialize)]
struct Claims {
    exp: Option<i64>,
    #[serde(default)]
    cn: String,
    #[serde(default)]
    sub: String,
}

impl License {
    /// A license valid until `expires_at`, for tests and embedders.
    pub fn valid_until(expires_at: i64) -> Self {
        Self {
            valid: true,
            expires_at: Some(expires_at),
            licensee: String::new(),
        }
    }

    pub fn currently_valid(&self) -> bool {
        self.valid && self.expires_at.is_some_and(|e| crate::util::now_unix() < e)
    }

    /// A verified key whose expiry has passed. An expired license degrades
    /// gracefully; a missing or forged one is not "expired".
    pub fn expired(&self) -> bool {
        self.expires_at
            .is_some_and(|e| crate::util::now_unix() >= e)
    }

    pub fn days_until_expiry(&self) -> f64 {
        self.expires_at
            .map_or(0.0, |e| (e - crate::util::now_unix()) as f64 / 86400.0)
    }

    pub fn verify(key: &str) -> Self {
        Self::verify_with_key(key, LICENSE_PUBLIC_KEY)
    }

    /// Never fails hard: any problem is logged and yields an invalid license.
    pub fn verify_with_key(key: &str, public_key_pem: &[u8]) -> Self {
        if key.is_empty() {
            return Self::default();
        }
        let decoding_key = match DecodingKey::from_ec_pem(public_key_pem) {
            Ok(decoding_key) => decoding_key,
            Err(error) => {
                tracing::warn!(error = %error, "license: failed to parse public key");
                return Self::default();
            }
        };
        // The algorithm is pinned, so an HS256 token signed with the public key
        // or an "alg: none" token cannot verify. Expiry is judged below because
        // an expired but authentic key must still report when it expired.
        let mut validation = Validation::new(Algorithm::ES256);
        validation.validate_exp = false;
        validation.validate_nbf = true;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let claims = match jsonwebtoken::decode::<Claims>(key, &decoding_key, &validation) {
            Ok(token) => token.claims,
            Err(error) => {
                tracing::warn!(error = %error, "license: key verification failed");
                return Self::default();
            }
        };
        let licensee = if claims.cn.is_empty() {
            claims.sub
        } else {
            claims.cn
        };
        let Some(exp) = claims.exp else {
            tracing::warn!("license: key has no expiry, rejecting");
            return Self::default();
        };
        let valid = exp > crate::util::now_unix();
        if !valid {
            tracing::warn!(licensee, expired_at = exp, "license: key has expired");
        }
        Self {
            valid,
            expires_at: Some(exp),
            licensee,
        }
    }

    /// Warns daily during the last 30 days and logs an error at expiry. Feature
    /// gates read the clock directly, so this exists for operator visibility.
    pub async fn monitor_expiry(self, interval: Duration, stop: CancellationToken) {
        if !self.valid {
            return;
        }
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        let mut last_warned = i64::MIN;
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = ticker.tick() => {}
            }
            if !self.currently_valid() {
                tracing::error!(
                    licensee = self.licensee,
                    "license has expired: business features are disabled; provide a renewed license key and restart"
                );
                return;
            }
            let now = crate::util::now_unix();
            let remaining = self.expires_at.unwrap_or(now) - now;
            if remaining <= WARN_WINDOW_SECONDS
                && now.saturating_sub(last_warned) >= WARN_INTERVAL_SECONDS
            {
                tracing::warn!(
                    licensee = self.licensee,
                    days_until_expiry = self.days_until_expiry(),
                    "license expires soon: business features will be disabled at expiry"
                );
                last_warned = now;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_unix;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    // Throwaway P-256 keys generated for these tests only.
    const PRIVATE_KEY: &str = include_str!("../tests/fixtures/ec_private.pem");
    const PUBLIC_KEY: &str = include_str!("../tests/fixtures/ec_public.pem");
    const OTHER_PRIVATE_KEY: &str = include_str!("../tests/fixtures/ec_other_private.pem");

    fn sign(claims: serde_json::Value) -> String {
        encode(
            &Header::new(Algorithm::ES256),
            &claims,
            &EncodingKey::from_ec_pem(PRIVATE_KEY.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    fn verify(token: &str) -> License {
        License::verify_with_key(token, PUBLIC_KEY.as_bytes())
    }

    #[test]
    fn empty_key_is_no_license() {
        let license = verify("");
        assert!(!license.valid && !license.expired() && license.expires_at.is_none());
        assert_eq!(license.days_until_expiry(), 0.0);
    }

    #[test]
    fn valid_key() {
        let license = verify(&sign(json!({"exp": now_unix() + 3600, "sub": "acme"})));
        assert!(license.currently_valid());
        assert!(!license.expired());
        assert_eq!(license.licensee, "acme");
    }

    #[test]
    fn company_name_claim_wins_over_subject() {
        let license = verify(&sign(
            json!({"exp": now_unix() + 3600, "sub": "s", "cn": "Acme Inc"}),
        ));
        assert_eq!(license.licensee, "Acme Inc");
    }

    #[test]
    fn expired_key_is_recognized_but_not_valid() {
        let license = verify(&sign(json!({"exp": now_unix() - 10, "sub": "acme"})));
        assert!(!license.valid && !license.currently_valid());
        assert!(license.expired());
        assert_eq!(license.licensee, "acme");
        assert!(license.days_until_expiry() < 0.0);
    }

    #[test]
    fn key_without_expiry_is_rejected() {
        let license = verify(&sign(json!({"sub": "acme"})));
        assert!(!license.valid && !license.expired());
    }

    #[test]
    fn forged_keys_are_not_even_expired() {
        let forged = encode(
            &Header::new(Algorithm::ES256),
            &json!({"exp": now_unix() - 10}),
            &EncodingKey::from_ec_pem(OTHER_PRIVATE_KEY.as_bytes()).unwrap(),
        )
        .unwrap();
        for token in [forged.as_str(), "not.a.jwt", "garbage"] {
            let license = verify(token);
            assert!(!license.valid && !license.expired(), "{token}");
        }
    }

    #[test]
    fn algorithm_confusion_is_rejected() {
        let claims = json!({"exp": now_unix() + 3600});
        // HS256 signed with the public key bytes as the shared secret.
        let hs256 = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(PUBLIC_KEY.as_bytes()),
        )
        .unwrap();
        assert!(!verify(&hs256).valid);
        // Unsigned "alg: none" token.
        use base64::Engine;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let none = format!(
            "{}.{}.",
            engine.encode(r#"{"alg":"none","typ":"JWT"}"#),
            engine.encode(claims.to_string())
        );
        assert!(!verify(&none).valid);
    }

    #[test]
    fn embedded_public_key_parses() {
        // A garbage token still has to get past key parsing to be rejected.
        assert!(DecodingKey::from_ec_pem(LICENSE_PUBLIC_KEY).is_ok());
    }

    #[test]
    fn invalid_public_key_yields_no_license() {
        let token = sign(json!({"exp": now_unix() + 3600}));
        assert!(!License::verify_with_key(&token, b"not a pem").valid);
    }

    #[test]
    fn runtime_expiry_degrades_without_restart() {
        let mut license = License::valid_until(now_unix() + 3600);
        assert!(license.currently_valid());
        license.expires_at = Some(now_unix() - 1);
        assert!(!license.currently_valid() && license.expired());
    }

    #[derive(Clone, Default)]
    struct Logs(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Logs {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Logs {
        fn count(&self, needle: &str) -> usize {
            String::from_utf8_lossy(&self.0.lock().unwrap())
                .matches(needle)
                .count()
        }
    }

    /// Runs the monitor with a fast tick until it returns or `run_for` passes.
    async fn monitor(license: License, run_for: Duration) -> (Logs, bool) {
        let logs = Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let stop = CancellationToken::new();
        let task = license.monitor_expiry(Duration::from_millis(1), stop.clone());
        let returned = tokio::time::timeout(run_for, task).await.is_ok();
        (logs, returned)
    }

    #[tokio::test]
    async fn monitor_exits_at_once_without_a_valid_license() {
        let (logs, returned) = monitor(License::default(), Duration::from_secs(1)).await;
        assert!(returned);
        assert_eq!(logs.count("license"), 0);
    }

    #[tokio::test]
    async fn monitor_reports_the_expiry_and_exits() {
        let expired = License::valid_until(now_unix() - 1);
        let (logs, returned) = monitor(expired, Duration::from_secs(1)).await;
        assert!(returned, "the monitor must stop after the expiry");
        assert_eq!(logs.count("license has expired"), 1);
    }

    #[tokio::test]
    async fn monitor_warns_once_a_day_in_the_last_month() {
        let soon = License::valid_until(now_unix() + 10 * 86400);
        let (logs, returned) = monitor(soon, Duration::from_millis(100)).await;
        assert!(!returned);
        assert_eq!(
            logs.count("license expires soon"),
            1,
            "warnings are throttled"
        );

        let later = License::valid_until(now_unix() + 90 * 86400);
        let (logs, _) = monitor(later, Duration::from_millis(50)).await;
        assert_eq!(logs.count("license expires soon"), 0);
    }

    #[tokio::test]
    async fn monitor_stops_when_cancelled() {
        let stop = CancellationToken::new();
        stop.cancel();
        let license = License::valid_until(now_unix() + 90 * 86400);
        tokio::time::timeout(
            Duration::from_secs(1),
            license.monitor_expiry(Duration::from_millis(1), stop),
        )
        .await
        .expect("a cancelled monitor returns");
    }
}
