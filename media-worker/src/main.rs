mod config;
mod consumer;
mod db;
mod model;
mod processor;
mod storage;
mod video;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // 1. Initialize structured logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,media_worker=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    info!("Starting Kith Media Worker (Rust)");

    // 2. Load configuration
    let cfg = config::Config::from_env()?;

    // 3. Configure Rayon global thread pool for CPU-bound image resizing
    rayon::ThreadPoolBuilder::new()
        .num_threads(cfg.rayon_threads)
        .thread_name(|i| format!("rayon-worker-{}", i))
        .build_global()?;
    info!("Rayon thread pool initialized with {} threads", cfg.rayon_threads);

    // 4. Initialize PostgreSQL connection pool
    let db = db::Database::connect(&cfg.database_url).await?;
    info!("Connected to PostgreSQL database");

    // 5. Initialize S3 / MinIO storage client
    let storage = storage::Storage::new(&cfg);
    info!("MinIO storage client initialized for endpoint: {}", cfg.s3_endpoint);

    // 6. Start JetStream consumer with graceful shutdown handling
    let consumer = consumer::Consumer::new(cfg, storage, db);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    tokio::spawn(async move {
        if let Ok(()) = tokio::signal::ctrl_c().await {
            info!("Shutdown signal received (Ctrl+C). Initiating graceful shutdown...");
            let _ = shutdown_tx.send(true);
        }
    });

    if let Err(e) = consumer.run(shutdown_rx).await {
        tracing::error!("Consumer exited with error: {:?}", e);
    } else {
        info!("Media worker shutdown cleanly.");
    }

    Ok(())
}
