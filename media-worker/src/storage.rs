use anyhow::{Context, Result};
use reqwest::Client;

use crate::config::Config;

#[derive(Clone)]
pub struct Storage {
    client: Client,
    endpoint: String,
    public_url_base: String,
}

impl Storage {
    pub fn new(cfg: &Config) -> Self {
        let endpoint = if cfg.s3_endpoint.starts_with("http://") || cfg.s3_endpoint.starts_with("https://") {
            cfg.s3_endpoint.trim_end_matches('/').to_string()
        } else {
            format!("http://{}", cfg.s3_endpoint.trim_end_matches('/'))
        };

        Self {
            client: Client::builder().build().unwrap_or_default(),
            endpoint,
            public_url_base: cfg.s3_public_url.trim_end_matches('/').to_string(),
        }
    }

    /// Downloads the raw object bytes from MinIO/S3.
    pub async fn download_object(&self, bucket: &str, key: &str) -> Result<Vec<u8>> {
        let url = format!("{}/{}/{}", self.endpoint, bucket, key);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("Failed to send GET request to S3: {}", url))?;

        if !resp.status().is_success() {
            anyhow::bail!("S3 GET returned error status {}: url={}", resp.status(), url);
        }

        let bytes = resp
            .bytes()
            .await
            .context("Failed to read S3 response body bytes")?;

        Ok(bytes.to_vec())
    }

    /// Uploads thumbnail bytes to MinIO/S3.
    pub async fn upload_object(
        &self,
        bucket: &str,
        key: &str,
        data: Vec<u8>,
        content_type: &str,
    ) -> Result<()> {
        let url = format!("{}/{}/{}", self.endpoint, bucket, key);
        let resp = self
            .client
            .put(&url)
            .header("Content-Type", content_type)
            .body(data)
            .send()
            .await
            .with_context(|| format!("Failed to send PUT request to S3: {}", url))?;

        if !resp.status().is_success() {
            anyhow::bail!("S3 PUT returned error status {}: url={}", resp.status(), url);
        }

        Ok(())
    }

    /// Formats the public URL for an object.
    pub fn public_url(&self, bucket: &str, key: &str) -> String {
        format!("{}/{}/{}", self.public_url_base, bucket, key)
    }
}
