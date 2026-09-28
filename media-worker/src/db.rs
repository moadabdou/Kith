use std::collections::HashMap;
use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::model::ThumbnailInfo;

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
}

impl Database {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .context("Failed to connect to PostgreSQL")?;

        Ok(Self { pool })
    }

    /// Updates the attachment status to ready with computed dimensions and thumbnails metadata.
    pub async fn update_ready(
        &self,
        attachment_id: i64,
        width: u32,
        height: u32,
        thumbnails: &HashMap<String, ThumbnailInfo>,
    ) -> Result<()> {
        let thumbnails_json = serde_json::to_value(thumbnails)
            .context("Failed to serialize thumbnails map")?;

        sqlx::query(
            r#"
            UPDATE attachments
            SET status = 'ready',
                width = $2,
                height = $3,
                thumbnails = $4
            WHERE id = $1
            "#,
        )
        .bind(attachment_id)
        .bind(width as i32)
        .bind(height as i32)
        .bind(thumbnails_json)
        .execute(&self.pool)
        .await
        .with_context(|| format!("Failed to update attachment {} to ready", attachment_id))?;

        Ok(())
    }

    /// Marks the attachment as failed if processing encountered a terminal error.
    pub async fn update_failed(&self, attachment_id: i64) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE attachments
            SET status = 'failed'
            WHERE id = $1
            "#,
        )
        .bind(attachment_id)
        .execute(&self.pool)
        .await
        .with_context(|| format!("Failed to update attachment {} to failed", attachment_id))?;

        Ok(())
    }
}
