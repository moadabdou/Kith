use std::sync::Arc;
use anyhow::{Context, Result};
use scylla::{Session, SessionBuilder};
use scylla::statement::prepared_statement::PreparedStatement;
use tracing::info;

use crate::model::ReadState;

#[derive(Clone)]
pub struct ScyllaDb {
    session: Arc<Session>,
    upsert_stmt: PreparedStatement,
    get_stmt: PreparedStatement,
    list_stmt: PreparedStatement,
}

impl ScyllaDb {
    pub async fn new(hosts: &[String], keyspace: &str) -> Result<Self> {
        info!("Connecting to ScyllaDB hosts: {:?}, keyspace: {}", hosts, keyspace);

        let mut builder = SessionBuilder::new().known_nodes(hosts);
        builder = builder.use_keyspace(keyspace, false);

        let session = Arc::new(
            builder
                .build()
                .await
                .context("Failed to build ScyllaDB session")?,
        );

        let upsert_query = "INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count) VALUES (?, ?, ?, ?)";
        let mut upsert_stmt = session
            .prepare(upsert_query)
            .await
            .context("Failed to prepare upsert query")?;
        upsert_stmt.set_is_idempotent(true);

        let get_query = "SELECT user_id, channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = ? AND channel_id = ?";
        let mut get_stmt = session
            .prepare(get_query)
            .await
            .context("Failed to prepare get query")?;
        get_stmt.set_is_idempotent(true);

        let list_query = "SELECT user_id, channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = ?";
        let mut list_stmt = session
            .prepare(list_query)
            .await
            .context("Failed to prepare list query")?;
        list_stmt.set_is_idempotent(true);

        Ok(Self {
            session,
            upsert_stmt,
            get_stmt,
            list_stmt,
        })
    }

    pub async fn upsert(
        &self,
        user_id: i64,
        channel_id: i64,
        last_read_message_id: i64,
        mention_count: i32,
    ) -> Result<()> {
        self.session
            .execute_unpaged(
                &self.upsert_stmt,
                (user_id, channel_id, last_read_message_id, mention_count),
            )
            .await
            .context("Scylla upsert execution failed")?;
        Ok(())
    }

    pub async fn get(&self, user_id: i64, channel_id: i64) -> Result<Option<ReadState>> {
        let result = self
            .session
            .execute_unpaged(&self.get_stmt, (user_id, channel_id))
            .await
            .context("Scylla get execution failed")?;

        let rows = result.into_rows_result()?;
        let mut rows_typed = rows.rows::<(i64, i64, i64, i32)>()?;

        if let Some(row) = rows_typed.next() {
            let (uid, cid, mid, mcount) = row?;
            Ok(Some(ReadState {
                user_id: uid,
                channel_id: cid,
                last_read_message_id: mid,
                mention_count: mcount,
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn list_by_user(&self, user_id: i64) -> Result<Vec<ReadState>> {
        let result = self
            .session
            .execute_unpaged(&self.list_stmt, (user_id,))
            .await
            .context("Scylla list_by_user execution failed")?;

        let rows = result.into_rows_result()?;
        let rows_typed = rows.rows::<(i64, i64, i64, i32)>()?;

        let mut states = Vec::new();
        for row in rows_typed {
            let (uid, cid, mid, mcount) = row?;
            states.push(ReadState {
                user_id: uid,
                channel_id: cid,
                last_read_message_id: mid,
                mention_count: mcount,
            });
        }
        Ok(states)
    }
}
