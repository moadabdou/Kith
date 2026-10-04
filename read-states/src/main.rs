use std::{net::SocketAddr, sync::Arc};
use anyhow::Result;
use axum::{
    routing::{get, post},
    Router,
};
use tokio::signal;
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod auth;
mod config;
mod consumer;
mod db;
mod handlers;
mod model;
mod nats;
mod pg;

use crate::{
    config::Config,
    db::ScyllaDb,
    handlers::{ack_message, get_channel_read_state, get_user_read_states, healthz, AppState},
    nats::NatsPublisher,
    pg::PgDb,
};

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting read-states service (Rust / Axum)");

    let cfg = Config::from_env();

    // 1. Initialize ScyllaDB
    let db = ScyllaDb::new(&cfg.scylla_hosts, &cfg.scylla_keyspace).await?;

    // 2. Initialize PostgreSQL if configured
    let pg = if let Some(pg_url) = &cfg.database_url {
        match PgDb::new(pg_url).await {
            Ok(p) => Some(p),
            Err(e) => {
                error!("Failed to connect to PostgreSQL (channel access checks disabled): {:?}", e);
                None
            }
        }
    } else {
        None
    };

    // 3. Initialize NATS if configured
    let nats = if let Some(nats_url) = &cfg.nats_url {
        match NatsPublisher::new(nats_url).await {
            Ok(n) => Some(n),
            Err(e) => {
                error!("Failed to connect to NATS (event dispatch disabled): {:?}", e);
                None
            }
        }
    } else {
        None
    };

    let state = Arc::new(AppState {
        db,
        pg,
        nats,
        jwt_secret: cfg.jwt_secret,
    });

    // Server-side mention counting (Issue #122 follow-up): JetStream durable
    // consumer turning authoritative mention payloads into per-recipient
    // mention_count increments. Runs alongside HTTP; shares handles.
    if let Some(nats_pub) = state.nats.clone() {
        let db_c = state.db.clone();
        let pg_c = state.pg.clone();
        let stream = cfg.nats_stream.clone();
        let durable = cfg.nats_consumer_durable.clone();
        let filter = cfg.nats_consumer_filter.clone();
        tokio::spawn(async move {
            if let Err(e) =
                consumer::run_mention_counter(db_c, pg_c, nats_pub, stream, durable, filter).await
            {
                error!("mention counter exited: {:?}", e);
            }
        });
    } else {
        error!("NATS unconfigured; mention counting disabled (badges clear-only)");
    }

    let app = Router::new()
        .route("/api/channels/{id}/messages/{mid}/ack", post(ack_message))
        .route("/channels/{id}/messages/{mid}/ack", post(ack_message))
        .route("/api/users/@me/read-states", get(get_user_read_states))
        .route("/users/@me/read-states", get(get_user_read_states))
        .route("/api/channels/{id}/read-state", get(get_channel_read_state))
        .route("/channels/{id}/read-state", get(get_channel_read_state))
        .route("/healthz", get(healthz))
        .route("/api/healthz", get(healthz))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    info!("Read-states listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Read-states service gracefully stopped");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
