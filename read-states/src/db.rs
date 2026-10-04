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
    put_index_stmt: PreparedStatement,
    get_index_stmt: PreparedStatement,
    del_index_stmt: PreparedStatement,
}

/// TTL for mention-index rows (Issue #122 follow-up): bounds table growth.
/// A delete arriving after expiry simply cannot decrement — the ack path
/// clears counts anyway, so the worst case is a stale +1 until read.
const MENTION_INDEX_TTL_SECS: i64 = 30 * 24 * 3600;

/// Pure increment guard (Issue #122 follow-up): a message only counts while
/// unread. Makes ack-then-increment orderings safe (stale event skips).
pub fn should_count(last_read_message_id: i64, message_id: i64) -> bool {
    message_id > last_read_message_id
}

/// Pure decrement guard: floor at zero; only unread messages decrement.
pub fn should_decrement(last_read_message_id: i64, mention_count: i32, message_id: i64) -> bool {
    mention_count > 0 && message_id > last_read_message_id
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

        // Mention index for exact delete-decrements (Issue #122 follow-up).
        // Created idempotently so existing clusters need no migration step;
        // api/cql/006 + deploy CQL carry the canonical definition.
        session
            .query_unpaged(
                "CREATE TABLE IF NOT EXISTS message_mention_index (message_id bigint PRIMARY KEY, channel_id bigint, user_ids list<bigint>)",
                &[],
            )
            .await
            .context("Failed to ensure message_mention_index table")?;

        let mut put_index_stmt = session
            .prepare(format!(
                "INSERT INTO message_mention_index (message_id, channel_id, user_ids) VALUES (?, ?, ?) USING TTL {}",
                MENTION_INDEX_TTL_SECS
            ))
            .await
            .context("Failed to prepare put_index query")?;
        put_index_stmt.set_is_idempotent(true);

        let mut get_index_stmt = session
            .prepare("SELECT channel_id, user_ids FROM message_mention_index WHERE message_id = ?")
            .await
            .context("Failed to prepare get_index query")?;
        get_index_stmt.set_is_idempotent(true);

        let mut del_index_stmt = session
            .prepare("DELETE FROM message_mention_index WHERE message_id = ?")
            .await
            .context("Failed to prepare del_index query")?;
        del_index_stmt.set_is_idempotent(true);

        Ok(Self {
            session,
            upsert_stmt,
            get_stmt,
            list_stmt,
            put_index_stmt,
            get_index_stmt,
            del_index_stmt,
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

    /// Increments a recipient's mention count for a message, but only while
    /// the message is unread. Returns true when the count moved.
    pub async fn increment_mentions(
        &self,
        user_id: i64,
        channel_id: i64,
        message_id: i64,
    ) -> Result<bool> {
        let current = self.get(user_id, channel_id).await?;
        let (last_read, count) = match current {
            Some(st) => (st.last_read_message_id, st.mention_count),
            None => (0, 0),
        };
        if !should_count(last_read, message_id) {
            return Ok(false);
        }
        self.upsert(user_id, channel_id, last_read, count.saturating_add(1))
            .await?;
        Ok(true)
    }

    /// Decrements a recipient's mention count for a deleted message, floored
    /// at zero and only while the message was unread. Returns true on move.
    pub async fn decrement_for_delete(
        &self,
        user_id: i64,
        channel_id: i64,
        message_id: i64,
    ) -> Result<bool> {
        let current = match self.get(user_id, channel_id).await? {
            Some(st) => st,
            None => return Ok(false),
        };
        if !should_decrement(
            current.last_read_message_id,
            current.mention_count,
            message_id,
        ) {
            return Ok(false);
        }
        self.upsert(
            user_id,
            channel_id,
            current.last_read_message_id,
            current.mention_count - 1,
        )
        .await?;
        Ok(true)
    }

    /// Records which users a message mentioned, for exact delete-decrements.
    pub async fn put_mention_index(
        &self,
        message_id: i64,
        channel_id: i64,
        user_ids: Vec<i64>,
    ) -> Result<()> {
        self.session
            .execute_unpaged(&self.put_index_stmt, (message_id, channel_id, user_ids))
            .await
            .context("Scylla put_mention_index execution failed")?;
        Ok(())
    }

    /// Takes (reads + deletes) the mention index for a message. Returns the
    /// channel and mentioned user ids, or None when unknown/expired.
    pub async fn take_mention_index(
        &self,
        message_id: i64,
    ) -> Result<Option<(i64, Vec<i64>)>> {
        let result = self
            .session
            .execute_unpaged(&self.get_index_stmt, (message_id,))
            .await
            .context("Scylla take_mention_index get failed")?;
        let rows = result.into_rows_result()?;
        let mut rows_typed = rows.rows::<(i64, Vec<i64>)>()?;
        let found: Option<(i64, Vec<i64>)> = match rows_typed.next() {
            Some(row) => Some(row?),
            None => None,
        };
        if found.is_some() {
            self.session
                .execute_unpaged(&self.del_index_stmt, (message_id,))
                .await
                .context("Scylla take_mention_index delete failed")?;
        }
        Ok(found)
    }
}
