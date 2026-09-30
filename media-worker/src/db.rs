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

    /// Updates the attachment status to ready with computed dimensions, duration, and thumbnails metadata.
    pub async fn update_ready(
        &self,
        attachment_id: i64,
        width: u32,
        height: u32,
        duration_seconds: Option<f64>,
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
                duration_seconds = $4,
                thumbnails = $5
            WHERE id = $1
            "#,
        )
        .bind(attachment_id)
        .bind(width as i32)
        .bind(height as i32)
        .bind(duration_seconds)
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

    /// Returns the linked (message_id, channel_id) for live-update routing.
    /// message_id is NULL until the uploader sends the message (presign ->
    /// PUT -> complete all precede send), so callers must skip the event
    /// when it is absent: the send response already carries final state.
    pub async fn message_link(&self, attachment_id: i64) -> Result<Option<(i64, i64)>> {
        let row: Option<(Option<i64>, i64)> = sqlx::query_as(
            r#"SELECT message_id, channel_id FROM attachments WHERE id = $1"#,
        )
        .bind(attachment_id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to look up attachment message link")?;

        Ok(row.and_then(|(message_id, channel_id)| message_id.map(|mid| (mid, channel_id))))
    }

    /// Returns the guild owning a channel, if any (DM/standalone channels
    /// have none and need no guild-scoped fan-out).
    pub async fn channel_guild(&self, channel_id: i64) -> Result<Option<i64>> {
        let row: Option<(Option<i64>,)> = sqlx::query_as(
            r#"SELECT guild_id FROM channels WHERE id = $1"#,
        )
        .bind(channel_id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to look up channel guild")?;

        Ok(row.and_then(|(guild_id,)| guild_id))
    }
}
