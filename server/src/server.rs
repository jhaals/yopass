//! Startup and shutdown: turns a validated configuration into running listeners.

use crate::app::{self, App};
use crate::audit::AuditLogger;
use crate::auth::{CookieCodec, Oidc, OidcConfig};
use crate::config::Config;
use crate::db::Database;
use crate::db::memcached::Memcached;
use crate::db::redis::Redis;
use crate::files::FileStore;
use crate::files::database::DatabaseFileStore;
use crate::files::disk::DiskFileStore;
use crate::files::s3::S3FileStore;
use crate::license::License;
use crate::serve::{self, Limits};
use crate::webhook::{WebhookConfig, WebhookNotifier};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Time claims, cleanup and webhooks always get after connections drain.
const CLEANUP_FLOOR: Duration = Duration::from_secs(5);

fn database(config: &Config) -> Result<Arc<dyn Database>, String> {
    match config.database.as_str() {
        "memcached" => Ok(Arc::new(Memcached::new(&config.memcached))),
        "redis" => Ok(Arc::new(Redis::new(&config.redis)?)),
        other => Err(format!(
            "unsupported database, expected 'memcached' or 'redis' got '{other}'"
        )),
    }
}

/// Runs until `shutdown` resolves, verifying the configured license key.
pub async fn run(config: Config, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let license = License::verify(&config.license_key);
    run_with_license(config, license, shutdown).await
}

/// As [`run`] with an already verified license, since the key embedded in the
/// binary cannot be signed for by anything but the license server.
pub async fn run_with_license(
    config: Config,
    license: License,
    shutdown: impl Future<Output = ()>,
) -> Result<(), String> {
    if config.health_check {
        database(&config)?
            .health()
            .await
            .map_err(|e| format!("database health check failed: {e}"))?;
        tracing::info!("Health check passed");
        return Ok(());
    }

    if license.valid {
        tracing::info!(
            licensee = license.licensee,
            days_until_expiry = license.days_until_expiry(),
            "license key verified"
        );
    }
    config.validate(&license)?;
    let settings = config.settings(&license)?;

    let db = database(&config)?;
    let stop = CancellationToken::new();
    let background = tokio_util::task::TaskTracker::new();

    // Everything that can fail runs before any background task starts, so a
    // failed startup leaves nothing running.
    let interval = Duration::from_secs(config.cleanup_interval.max(1));
    let mut sweeper: Option<(&str, Pin<Box<dyn Future<Output = ()> + Send>>)> = None;
    let mut files: Option<Arc<dyn FileStore>> = match config.file_store.as_str() {
        "disk" => {
            let store = DiskFileStore::new(&config.file_store_path).map_err(|e| e.to_string())?;
            let sweep = store.clone().run_cleanup(interval, stop.clone());
            sweeper = Some(("disk", Box::pin(sweep)));
            Some(Arc::new(store))
        }
        "s3" => {
            tracing::info!(
                bucket = config.file_store_s3_bucket,
                prefix = config.file_store_s3_prefix,
                region = config.file_store_s3_region,
                "configured S3 file store"
            );
            if config.file_store_s3_prefix.is_empty() && !config.disable_file_cleanup {
                tracing::warn!(
                    "--file-store-s3-prefix is empty, so cleanup deletes any object in the bucket whose Expires has passed; use a dedicated bucket or a prefix"
                );
            }
            let store = S3FileStore::new(
                &config.file_store_s3_bucket,
                &config.file_store_s3_prefix,
                &config.file_store_s3_endpoint,
                &config.file_store_s3_region,
            )
            .await;
            let sweep = store.clone().run_cleanup(interval, stop.clone());
            sweeper = Some(("S3", Box::pin(sweep)));
            Some(Arc::new(store))
        }
        _ => {
            tracing::info!("no file store configured, using database for file storage");
            Some(Arc::new(DatabaseFileStore::new(db.clone())))
        }
    };
    if settings.disable_upload {
        files = None;
    } else if (settings.max_file_size == 0 || settings.max_file_size > 1 << 20)
        && config.file_store.is_empty()
    {
        // The database store buffers each upload in memory, so 0 (unlimited) is the worst case.
        tracing::warn!(
            "max-file-size exceeds typical database backend limits without a file store configured; consider --file-store disk or --file-store s3"
        );
    }

    let tls = if config.tls_cert.is_empty() {
        None
    } else {
        Some(serve::load_tls(&config.tls_cert, &config.tls_key)?)
    };

    let license_provided = license.currently_valid() || license.expired();
    let mut app = App::new(settings, db, files);
    app.license = license.clone();
    if config.audit_log {
        let path = (!config.audit_log_file.is_empty()).then_some(config.audit_log_file.as_str());
        let logger = AuditLogger::open(path)
            .map_err(|e| format!("failed to initialize audit logger: {e}"))?;
        app.audit_logger = Some(Arc::new(logger));
    }
    // Set up for valid and expired licenses alike: an expiring license must not
    // weaken authentication.
    if license_provided && !config.oidc_issuer.is_empty() {
        let oidc = Oidc::discover(&OidcConfig {
            issuer: config.oidc_issuer.clone(),
            client_id: config.oidc_client_id.clone(),
            client_secret: config.oidc_client_secret.clone(),
            redirect_url: config.oidc_redirect_url.clone(),
            session_key: config.oidc_session_key.clone(),
        })
        .await?;
        app.oidc = Some(oidc);
        app.sessions = Some(CookieCodec::derive(
            &config.oidc_session_key,
            "yopass-session",
        ));
        tracing::info!(
            require_auth = config.require_auth,
            "OIDC authentication enabled"
        );
    }

    let host = if config.address.is_empty() {
        "0.0.0.0"
    } else {
        config.address.as_str()
    };
    let listener = TcpListener::bind((host, config.port))
        .await
        .map_err(|e| format!("could not listen on {host}:{}: {e}", config.port))?;
    let metrics_listener = if config.metrics_port > 0 {
        let port =
            u16::try_from(config.metrics_port).map_err(|_| "invalid --metrics-port".to_owned())?;
        let listener = TcpListener::bind((host, port))
            .await
            .map_err(|e| format!("could not listen on metrics port {port}: {e}"))?;
        Some((listener, port))
    } else {
        None
    };
    if !config.webhook_url.is_empty() {
        let notifier = WebhookNotifier::start(
            WebhookConfig {
                license: Some(license.clone()),
                ..WebhookConfig::new(config.webhook_url.clone(), config.webhook_secret.clone())
            },
            Some(&app.metrics.registry),
        )?;
        app.webhooks = Some(notifier);
    }

    if let (Some((kind, sweep)), false) = (sweeper, config.disable_file_cleanup) {
        tracing::info!(
            interval_seconds = interval.as_secs(),
            "Starting {kind} file store cleanup"
        );
        background.spawn(sweep);
    }
    if license.valid {
        background.spawn(
            license
                .clone()
                .monitor_expiry(Duration::from_secs(3600), stop.clone()),
        );
    }

    let app = Arc::new(app);
    tracing::info!(address = %format!("{host}:{}", config.port), asset_path = app.settings.asset_path, "Starting yopass-next server");
    if let Some((metrics_listener, port)) = metrics_listener {
        tracing::info!(port, "Starting yopass metrics server");
        background.spawn(serve::serve(
            metrics_listener,
            app::metrics_router(app.clone()),
            tls.clone(),
            Limits {
                max_connections: serve::METRICS_CONNECTIONS,
                ..Limits::default()
            },
            stop.clone(),
        ));
    }

    let server = tokio::spawn(serve::serve(
        listener,
        app::router(app.clone()),
        tls,
        Limits {
            max_connections: serve::connection_cap(),
            ..Limits::default()
        },
        stop.clone(),
    ));
    shutdown.await;
    tracing::info!("Shutting down HTTP server");
    // One budget for the whole shutdown, as in the Go server, plus at most
    // CLEANUP_FLOOR, so it fits inside a typical 30s orchestrator grace period.
    let deadline = tokio::time::Instant::now() + serve::SHUTDOWN_GRACE;
    stop.cancel();
    let _ = server.await;
    background.close();
    let _ = tokio::time::timeout_at(deadline, background.wait()).await;
    // Requests already past the connection stage finish their claims and cleanup,
    // with a few seconds even when draining connections used the whole budget.
    let deadline = deadline.max(tokio::time::Instant::now() + CLEANUP_FLOOR);
    app.tasks.close();
    let _ = tokio::time::timeout_at(deadline, app.tasks.wait()).await;
    if let Some(webhooks) = &app.webhooks {
        let _ = tokio::time::timeout_at(deadline, webhooks.stop()).await;
    }
    tracing::info!("Server shut down");
    Ok(())
}
