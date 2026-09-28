use std::env;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Config {
    pub nats_url: String,
    pub stream_name: String,
    pub consumer_subject: String,
    pub durable_name: String,
    pub database_url: String,
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_bucket: String,
    pub s3_public_url: String,
    pub rayon_threads: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, env::VarError> {
        Ok(Self {
            nats_url: env::var("NATS_URL").unwrap_or_else(|_| "nats://nats:4222".to_string()),
            stream_name: env::var("NATS_STREAM").unwrap_or_else(|_| "KITH_MEDIA".to_string()),
            consumer_subject: env::var("NATS_SUBJECT").unwrap_or_else(|_| "kith.media.upload".to_string()),
            durable_name: env::var("NATS_DURABLE").unwrap_or_else(|_| "media-worker-group".to_string()),
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://discord:discord@postgres:5432/discord?sslmode=disable".to_string()),
            s3_endpoint: env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://minio:9000".to_string()),
            s3_access_key: env::var("S3_ACCESS_KEY").unwrap_or_else(|_| "kithadmin".to_string()),
            s3_secret_key: env::var("S3_SECRET_KEY").unwrap_or_else(|_| "kithpassword123".to_string()),
            s3_bucket: env::var("S3_BUCKET_ATTACHMENTS").unwrap_or_else(|_| "attachments".to_string()),
            s3_public_url: env::var("S3_PUBLIC_URL").unwrap_or_else(|_| "http://localhost:9000".to_string()),
            rayon_threads: env::var("RAYON_NUM_THREADS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(4),
        })
    }
}
