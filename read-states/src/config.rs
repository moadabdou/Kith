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

        Self {
            port,
            scylla_hosts,
            scylla_keyspace,
            database_url,
            nats_url,
            jwt_secret,
            log_level,
        }
    }
}
