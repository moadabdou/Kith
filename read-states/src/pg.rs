use anyhow::{Context, Result};
use sqlx::PgPool;
use tracing::info;

#[derive(Clone)]
pub struct PgDb {
    pool: PgPool,
}

#[derive(Debug, thiserror::Error)]
pub enum AccessError {
    #[error("Unknown channel")]
    UnknownChannel,
    #[error("Missing channel access")]
    MissingAccess,
    #[error("Internal database error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl PgDb {
    pub async fn new(database_url: &str) -> Result<Self> {
        info!("Connecting to PostgreSQL pool");
        let pool = PgPool::connect(database_url)
            .await
            .context("Failed to connect to PostgreSQL")?;
        Ok(Self { pool })
    }

    pub async fn check_channel_access(&self, user_id: i64, channel_id: i64) -> Result<(), AccessError> {
        let channel_opt = sqlx::query_scalar::<_, i64>("SELECT guild_id FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(&self.pool)
            .await
            .context("Failed to query channel")?;

        let guild_id = match channel_opt {
            Some(gid) => gid,
            None => return Err(AccessError::UnknownChannel),
        };

        // If DM channel (guild_id == 0)
        if guild_id == 0 {
            return Ok(());
        }

        let is_member = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)",
        )
        .bind(guild_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .context("Failed to query guild membership")?;

        if !is_member {
            return Err(AccessError::MissingAccess);
        }

        Ok(())
    }
}
