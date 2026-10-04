use anyhow::{Context, Result};
use async_nats::Client;
use bytes::Bytes;
use tracing::{info, warn};

use crate::model::{GatewayEvent, MessageAckPayload};

#[derive(Clone)]
pub struct NatsPublisher {
    client: Client,
}

impl NatsPublisher {
    pub async fn new(nats_url: &str) -> Result<Self> {
        info!("Connecting to NATS at {}", nats_url);
        let client = async_nats::connect(nats_url)
            .await
            .context("Failed to connect to NATS")?;
        Ok(Self { client })
    }

    /// Shares the underlying connection for the mention-counter consumer.
    /// `async_nats::Client` is cheaply cloneable and multiplexed.
    pub fn client(&self) -> Client {
        self.client.clone()
    }

    pub async fn publish_ack(&self, user_id: i64, channel_id: i64, message_id: i64) {
        let virtual_guild = format!("user_{}", user_id);
        let event = GatewayEvent {
            event_type: "MESSAGE_ACK".to_string(),
            version: 1,
            guild_id: virtual_guild.clone(),
            payload: MessageAckPayload {
                channel_id: channel_id.to_string(),
                message_id: message_id.to_string(),
                version: None,
            },
        };

        let bytes = match serde_json::to_vec(&event) {
            Ok(b) => Bytes::from(b),
            Err(e) => {
                warn!("Failed to serialize MESSAGE_ACK event: {:?}", e);
                return;
            }
        };

        let subject = format!("kith.events.{}", virtual_guild);
        if let Err(e) = self.client.publish(subject, bytes).await {
            warn!("Failed to publish MESSAGE_ACK to NATS: {:?}", e);
        }
    }
}
