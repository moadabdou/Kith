use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub scylla_hosts: Vec<String>,
    pub scylla_keyspace: String,
    pub database_url: Option<String>,
    pub nats_url: Option<String>,
    pub jwt_secret: String,
    pub log_level: String,
    /// JetStream stream carrying bus events (default KITH_EVENTS).
    pub nats_stream: String,
    /// Durable consumer name for the mention counter. Shared across replicas
    /// so scale-out behaves as a queue group (each message counted once).
    pub nats_consumer_durable: String,
    /// Filter subject for the consumer (default kith.events.>).
    pub nats_consumer_filter: String,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8085);

        let scylla_hosts_str = env::var("SCYLLA_HOSTS").unwrap_or_else(|_| "127.0.0.1:9042".to_string());
        let scylla_hosts = scylla_hosts_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let scylla_keyspace = env::var("SCYLLA_KEYSPACE").unwrap_or_else(|_| "kith".to_string());
        let database_url = env::var("DATABASE_URL").ok();
        let nats_url = env::var("NATS_URL").ok();
        let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| "dev-jwt-secret-change-me".to_string());
        let log_level = env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string());
        let nats_stream = env::var("NATS_STREAM").unwrap_or_else(|_| "KITH_EVENTS".to_string());
        let nats_consumer_durable =
            env::var("NATS_CONSUMER_DURABLE").unwrap_or_else(|_| "kith-read-states".to_string());
        let nats_consumer_filter =
            env::var("NATS_CONSUMER_FILTER").unwrap_or_else(|_| "kith.events.>".to_string());

        Self {
            port,
            scylla_hosts,
            scylla_keyspace,
            database_url,
            nats_url,
            jwt_secret,
            log_level,
            nats_stream,
            nats_consumer_durable,
            nats_consumer_filter,
        }
    }
}
