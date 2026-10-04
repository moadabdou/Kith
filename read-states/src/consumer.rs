//! Server-side mention counting (Issue #122 follow-up).
//!
//! A JetStream durable consumer on the bus that turns authoritative #121
//! mention payloads into per-recipient `mention_count` increments, so
//! badges survive refresh and roam across devices. Design notes:
//!
//! - The API already validated everything at send time; this consumer
//!   trusts the payload and only fans out.
//! - Every increment is guarded by `message_id > last_read`: ack-then-create
//!   orderings skip, create-then-ack overwrites to zero. Both orders safe.
//! - Counts are advisory: redelivery duplicates are bounded by an in-memory
//!   recently-seen set, and any residual skew clears on read.
//! - Deletes decrement via the mention index (exact recipients recorded at
//!   create with a TTL); unknown/expired entries simply skip.

use std::{
    collections::{HashSet, VecDeque},
    time::Duration,
};

use anyhow::{Context, Result};
use async_nats::jetstream::{self, consumer};
use futures::StreamExt;
use tracing::{debug, error, info, warn};

use crate::{
    db::ScyllaDb,
    model::{BusEnvelope, MessageCreatePayload, MessageDeletePayload},
    nats::NatsPublisher,
    pg::PgDb,
};

/// Cap for the redelivery-dedup set (message ids, FIFO eviction).
const DEDUP_CAP: usize = 10_000;

/// How long a mention-index row lives (also baked into the CQL TTL).
const INDEX_TTL_HINT_SECS: u64 = 30 * 24 * 3600;

/// Parses snowflake id strings, keeping positive ids only.
pub fn parse_id_list(ids: &[String]) -> Vec<i64> {
    ids.iter()
        .filter_map(|s| s.parse::<i64>().ok())
        .filter(|&id| id > 0)
        .collect()
}

/// Merges mention sources into a sorted, deduplicated recipient list with
/// the author excluded. Pure and unit-tested.
pub fn merge_recipients(
    direct: &[i64],
    role_members: &[i64],
    everyone: &[i64],
    author_id: i64,
) -> Vec<i64> {
    let mut set: HashSet<i64> = HashSet::new();
    for id in direct.iter().chain(role_members).chain(everyone) {
        if *id > 0 && *id != author_id {
            set.insert(*id);
        }
    }
    let mut out: Vec<i64> = set.into_iter().collect();
    out.sort_unstable();
    out
}

struct Dedup {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl Dedup {
    fn new() -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    /// Returns true on first sight (caller should process), false on repeat.
    fn check(&mut self, key: String) -> bool {
        if self.seen.contains(&key) {
            return false;
        }
        self.seen.insert(key.clone());
        self.order.push_back(key);
        while self.order.len() > DEDUP_CAP {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
}

pub struct MentionCounter {
    db: ScyllaDb,
    pg: Option<PgDb>,
    dedup: Dedup,
    processed: u64,
}

impl MentionCounter {
    pub fn new(db: ScyllaDb, pg: Option<PgDb>) -> Self {
        Self {
            db,
            pg,
            dedup: Dedup::new(),
            processed: 0,
        }
    }

    async fn handle_create(&mut self, envelope: &BusEnvelope) -> Result<()> {
        let payload: MessageCreatePayload = serde_json::from_value(envelope.payload.clone())
            .context("malformed MESSAGE_CREATE payload")?;
        let message_id: i64 = payload
            .id
            .parse()
            .context("bad message id in MESSAGE_CREATE")?;
        let channel_id: i64 = payload
            .channel_id
            .parse()
            .context("bad channel id in MESSAGE_CREATE")?;
        if message_id <= 0 || channel_id <= 0 {
            anyhow::bail!("non-positive ids in MESSAGE_CREATE");
        }
        if !self.dedup.check(format!("c:{message_id}")) {
            debug!("skipping redelivered MESSAGE_CREATE {message_id}");
            return Ok(());
        }

        let author_id: i64 = payload.author.id.parse().unwrap_or(0);
        let guild_id: i64 = payload.guild_id.parse().unwrap_or(0);
        let direct = parse_id_list(&payload.mentions);
        let role_ids = parse_id_list(&payload.mention_roles);

        let mut role_members: Vec<i64> = Vec::new();
        let mut everyone: Vec<i64> = Vec::new();
        if let Some(pg) = &self.pg {
            if !role_ids.is_empty() && guild_id > 0 {
                match pg.member_ids_for_roles(guild_id, &role_ids).await {
                    Ok(ids) => role_members = ids,
                    Err(e) => warn!("role expansion failed, continuing with direct: {:?}", e),
                }
            }
            if payload.mention_everyone && guild_id > 0 {
                match pg.member_ids(guild_id).await {
                    Ok(ids) => everyone = ids,
                    Err(e) => warn!("everyone expansion failed, continuing with direct: {:?}", e),
                }
            }
        } else if !role_ids.is_empty() || payload.mention_everyone {
            debug!("PG unavailable; skipping role/broadcast expansion");
        }

        let recipients = merge_recipients(&direct, &role_members, &everyone, author_id);
        if recipients.is_empty() {
            return Ok(());
        }

        // Record exact recipients for future deletes (TTL-bounded).
        if let Err(e) = self
            .db
            .put_mention_index(message_id, channel_id, recipients.clone())
            .await
        {
            warn!("put_mention_index failed (deletes will skip): {:?}", e);
        }

        let mut moved = 0;
        for uid in &recipients {
            match self.db.increment_mentions(*uid, channel_id, message_id).await {
                Ok(true) => moved += 1,
                Ok(false) => {}
                Err(e) => warn!("increment_mentions failed for {uid}: {:?}", e),
            }
        }
        self.processed += 1;
        if self.processed % 100 == 0 {
            debug!("mention counter processed={} last_moved={}", self.processed, moved);
        }
        Ok(())
    }

    async fn handle_delete(&mut self, envelope: &BusEnvelope) -> Result<()> {
        let payload: MessageDeletePayload = serde_json::from_value(envelope.payload.clone())
            .context("malformed MESSAGE_DELETE payload")?;
        let message_id: i64 = payload
            .id
            .parse()
            .context("bad message id in MESSAGE_DELETE")?;
        if message_id <= 0 {
            anyhow::bail!("non-positive id in MESSAGE_DELETE");
        }
        if !self.dedup.check(format!("d:{message_id}")) {
            debug!("skipping redelivered MESSAGE_DELETE {message_id}");
            return Ok(());
        }

        let taken = self.db.take_mention_index(message_id).await?;
        let Some((channel_id, user_ids)) = taken else {
            return Ok(());
        };
        for uid in &user_ids {
            match self
                .db
                .decrement_for_delete(*uid, channel_id, message_id)
                .await
            {
                Ok(_) => {}
                Err(e) => warn!("decrement_for_delete failed for {uid}: {:?}", e),
            }
        }
        Ok(())
    }
}

/// Runs the mention-counter consumer forever. Returns only on fatal setup
/// errors; transient message failures are logged and the message is left
/// unacked for JetStream redelivery (max_deliver caps poison).
pub async fn run_mention_counter(
    db: ScyllaDb,
    pg: Option<PgDb>,
    nats: NatsPublisher,
    stream_name: String,
    durable: String,
    filter_subject: String,
) -> Result<()> {
    let js = jetstream::new(nats.client());

    loop {
        match run_consumer_loop(&js, &db, pg.clone(), &stream_name, &durable, &filter_subject).await
        {
            Ok(()) => {
                // Loop only exits cleanly on shutdown; treat as fatal restart.
                anyhow::bail!("consumer loop exited unexpectedly");
            }
            Err(e) => {
                error!("mention consumer error, reconnecting in 5s: {:?}", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

async fn run_consumer_loop(
    js: &jetstream::Context,
    db: &ScyllaDb,
    pg: Option<PgDb>,
    stream_name: &str,
    durable: &str,
    filter_subject: &str,
) -> Result<()> {
    let stream = js
        .get_stream(stream_name)
        .await
        .with_context(|| format!("stream {stream_name} unavailable"))?;

    let consumer = stream
        .get_or_create_consumer(
            durable,
            consumer::pull::Config {
                durable_name: Some(durable.to_string()),
                filter_subject: filter_subject.to_string(),
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(30),
                max_deliver: 3,
                ..Default::default()
            },
        )
        .await
        .context("failed to create durable consumer")?;

    info!(
        "mention counter consuming stream={} durable={} filter={} (index TTL {}s)",
        stream_name, durable, filter_subject, INDEX_TTL_HINT_SECS
    );

    let mut counter = MentionCounter::new(db.clone(), pg);
    let mut messages = consumer.messages().await.context("messages stream")?;

    while let Some(res) = messages.next().await {
        let msg = match res {
            Ok(m) => m,
            Err(e) => {
                warn!("consumer message error: {:?}", e);
                continue;
            }
        };

        let envelope: BusEnvelope = match serde_json::from_slice(&msg.payload) {
            Ok(e) => e,
            Err(e) => {
                warn!("undecodable bus envelope, dropping: {:?}", e);
                if let Err(ae) = msg.ack().await {
                    warn!("jetstream ack failed: {:?}", ae);
                }
                continue;
            }
        };
        let outcome: Result<()> = match envelope.event_type.as_str() {
            "MESSAGE_CREATE" => counter.handle_create(&envelope).await,
            "MESSAGE_DELETE" => counter.handle_delete(&envelope).await,
            _ => Ok(()),
        };

        match outcome {
            Ok(()) => {
                if let Err(e) = msg.ack().await {
                    warn!("jetstream ack failed: {:?}", e);
                }
            }
            Err(e) => {
                // Poison (malformed ids): ack to avoid the redelivery loop —
                // handlers bail before any write on malformed input.
                let poison = e.to_string().contains("bad ") || e.to_string().contains("non-positive");
                if poison {
                    warn!("dropping poison bus message: {:?}", e);
                    if let Err(ae) = msg.ack().await {
                        warn!("jetstream ack failed: {:?}", ae);
                    }
                } else {
                    // Transient (DB/NATS): leave unacked for redelivery.
                    error!("mention processing failed, will redeliver: {:?}", e);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_id_list_keeps_positive_ids() {
        assert_eq!(
            parse_id_list(&["7".to_string(), "abc".to_string(), "0".to_string(), "-3".to_string()]),
            vec![7]
        );
        assert!(parse_id_list(&[]).is_empty());
    }

    #[test]
    fn merge_recipients_dedupes_sorts_excludes_author() {
        assert_eq!(
            merge_recipients(&[9, 3, 9], &[5, 3], &[5, 11], 9),
            vec![3, 5, 11]
        );
        assert!(merge_recipients(&[], &[], &[], 1).is_empty());
    }

    #[test]
    fn bus_envelope_parses_real_create_shape() {
        let raw = serde_json::json!({
            "type": "MESSAGE_CREATE",
            "version": 1,
            "guild_id": "100",
            "payload": {
                "id": "555",
                "channel_id": "200",
                "guild_id": "100",
                "author": { "id": "7", "username": "a", "discriminator": "0001" },
                "content": "hi <@9>",
                "mentions": ["9"],
                "mention_roles": ["30"],
                "mention_everyone": false
            }
        });
        let env: BusEnvelope = serde_json::from_value(raw).unwrap();
        assert_eq!(env.event_type, "MESSAGE_CREATE");
        let p: MessageCreatePayload = serde_json::from_value(env.payload).unwrap();
        assert_eq!(p.author.id, "7");
        assert_eq!(p.mentions, vec!["9".to_string()]);
    }

    #[test]
    fn bus_envelope_tolerates_unknown_shapes() {
        let raw = serde_json::json!({ "type": "PRESENCE_UPDATE", "payload": { "x": 1 } });
        let env: BusEnvelope = serde_json::from_value(raw).unwrap();
        assert_eq!(env.event_type, "PRESENCE_UPDATE");
        assert_eq!(env.guild_id, "");
    }

    #[test]
    fn dedup_first_sight_wins() {
        let mut d = Dedup::new();
        assert!(d.check("c:1".to_string()));
        assert!(!d.check("c:1".to_string()));
        assert!(d.check("c:2".to_string()));
    }
}
