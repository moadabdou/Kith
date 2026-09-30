use std::collections::HashMap;
use anyhow::{Context, Result};
use async_nats::jetstream::{
    self,
    consumer::{pull::Config as PullConfig, AckPolicy},
};
use futures::StreamExt;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::db::Database;
use crate::model::{FileUploadPayload, MediaEvent, ThumbnailInfo};
use crate::processor::{is_supported_image, process_image, ProcessorError};
use crate::storage::Storage;
use crate::video::{is_supported_video, process_video};

pub struct Consumer {
    cfg: Config,
    storage: Storage,
    db: Database,
}

impl Consumer {
    pub fn new(cfg: Config, storage: Storage, db: Database) -> Self {
        Self { cfg, storage, db }
    }

    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
        info!(
            "Connecting to NATS at {} for stream {}",
            self.cfg.nats_url, self.cfg.stream_name
        );

        let nats_client = async_nats::connect(&self.cfg.nats_url)
            .await
            .context("Failed to connect to NATS server")?;

        // Client is Arc-backed: cheap to clone for completion-event publishes
        // alongside the JetStream consumer below.
        let js = jetstream::new(nats_client.clone());

        // Ensure stream exists or get stream handle
        let stream = js
            .get_stream(&self.cfg.stream_name)
            .await
            .with_context(|| format!("JetStream stream {} not found", self.cfg.stream_name))?;

        // Create or get durable pull consumer
        let consumer = stream
            .create_consumer(PullConfig {
                durable_name: Some(self.cfg.durable_name.clone()),
                filter_subject: self.cfg.consumer_subject.clone(),
                ack_policy: AckPolicy::Explicit,
                ack_wait: std::time::Duration::from_secs(5),
                max_deliver: 3,
                ..Default::default()
            })
            .await
            .context("Failed to create or retrieve JetStream pull consumer")?;

        info!(
            "JetStream consumer '{}' active on subject '{}'. Listening for events...",
            self.cfg.durable_name, self.cfg.consumer_subject
        );

        let mut messages = consumer
            .messages()
            .await
            .context("Failed to establish JetStream message stream")?;

        loop {
            if *shutdown.borrow() {
                info!("Shutdown initiated. Exiting consumer loop.");
                break;
            }

            let msg = tokio::select! {
                res = shutdown.changed() => {
                    if res.is_ok() && *shutdown.borrow() {
                        info!("Shutdown signal received. Stopping pull consumer and exiting gracefully.");
                    }
                    break;
                }
                msg_opt = messages.next() => {
                    match msg_opt {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => {
                            warn!("Transient error pulling message from JetStream: {:?}", e);
                            continue;
                        }
                        None => {
                            info!("Message stream closed.");
                            break;
                        }
                    }
                }
            };

            if let Err(e) = self.handle_message(&nats_client, &msg.payload).await {
                error!("Error processing media event: {:?}", e);
            }

            if let Err(e) = msg.ack().await {
                error!("Failed to ACK JetStream message: {:?}", e);
            }
        }

        Ok(())
    }

    async fn handle_message(&self, nats: &async_nats::Client, payload_bytes: &[u8]) -> Result<()> {
        let event: MediaEvent = match serde_json::from_slice(payload_bytes) {
            Ok(evt) => evt,
            Err(e) => {
                warn!("Ignoring invalid JSON message: {:?}", e);
                return Ok(());
            }
        };

        if event.r#type != "FILE_UPLOAD" {
            info!("Ignoring non-upload event type: {}", event.r#type);
            return Ok(());
        }

        let p = event.payload;
        let attachment_id: i64 = match p.attachment_id.parse() {
            Ok(id) => id,
            Err(_) => {
                warn!("Invalid snowflake attachment_id: {}", p.attachment_id);
                return Ok(());
            }
        };

        info!(
            "Processing upload job: id={}, filename='{}', type='{}', size={}B",
            attachment_id, p.filename, p.content_type, p.byte_size
        );

        // Resolve the rendered message for live-update routing. Best-effort:
        // message_id is NULL until the uploader sends the message, in which
        // case the send response already carries final state and no event
        // is needed. Never fail the job over a notify-path lookup.
        let link: Option<(String, String, String)> = match self.db.message_link(attachment_id).await {
            Ok(Some((message_id, channel_id))) => {
                match self.db.channel_guild(channel_id).await {
                    Ok(Some(guild_id)) => Some((
                        guild_id.to_string(),
                        channel_id.to_string(),
                        message_id.to_string(),
                    )),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("Live-update guild lookup failed for attachment {}: {:?}", attachment_id, e);
                        None
                    }
                }
            }
            Ok(None) => None,
            Err(e) => {
                warn!("Live-update link lookup failed for attachment {}: {:?}", attachment_id, e);
                None
            }
        };

        if is_supported_image(&p.content_type) {
            match self.handle_image(attachment_id, &p).await {
                Ok(()) => {}
                Err(e) => {
                    // S3 download failure already marked the row failed above;
                    // still notify so the tile flips instead of hanging.
                    if let Some((guild_id, channel_id, message_id)) = &link {
                        self.notify_message_updated(nats, guild_id, channel_id, message_id).await;
                    }
                    return Err(e);
                }
            }
        } else if is_supported_video(&p.content_type) {
            match self.handle_video(attachment_id, &p).await {
                Ok(()) => {}
                Err(e) => {
                    if let Some((guild_id, channel_id, message_id)) = &link {
                        self.notify_message_updated(nats, guild_id, channel_id, message_id).await;
                    }
                    return Err(e);
                }
            }
        } else {
            info!(
                "Content type '{}' is neither an image nor a video requiring processing. Marking ready.",
                p.content_type
            );
            self.db
                .update_ready(attachment_id, 0, 0, None, &HashMap::new())
                .await?;
        }

        if let Some((guild_id, channel_id, message_id)) = &link {
            self.notify_message_updated(nats, guild_id, channel_id, message_id).await;
        }

        Ok(())
    }

    /// Publishes a MESSAGE_UPDATE hint so clients viewing the message flip
    /// the attachment tile without a refresh. Slim payload (ids only): the
    /// client refetches authoritative metadata (fresh signed URLs) via REST.
    /// Best-effort by design — a failed publish must never fail the job.
    /// The gateway already fans MESSAGE_UPDATE out on channel-scoped lanes,
    /// so no gateway changes are required.
    async fn notify_message_updated(
        &self,
        nats: &async_nats::Client,
        guild_id: &str,
        channel_id: &str,
        message_id: &str,
    ) {
        let envelope = message_update_envelope(guild_id, channel_id, message_id);
        let bytes = match serde_json::to_vec(&envelope) {
            Ok(b) => b,
            Err(e) => {
                warn!("Failed to serialize MESSAGE_UPDATE for message {}: {:?}", message_id, e);
                return;
            }
        };
        let subject = format!("kith.events.{}", guild_id);
        if let Err(e) = nats.publish(subject.clone(), bytes::Bytes::from(bytes)).await {
            warn!("Failed to publish MESSAGE_UPDATE for message {}: {:?}", message_id, e);
        } else {
            info!("Published MESSAGE_UPDATE for message {} (attachment terminal).", message_id);
        }
    }

    async fn handle_image(&self, attachment_id: i64, p: &FileUploadPayload) -> Result<()> {
        // 1. Download raw file from MinIO
        let raw_bytes = match self.storage.download_object(&p.s3_bucket, &p.s3_key).await {
            Ok(b) => b,
            Err(e) => {
                error!("Failed to download object from S3: {:?}", e);
                self.db.update_failed(attachment_id).await?;
                return Err(e);
            }
        };

        // 2. Process image with Rayon thread pool
        let content_type = p.content_type.clone();
        let process_result = tokio::task::spawn_blocking(move || {
            process_image(&raw_bytes, &content_type)
        })
        .await
        .context("Worker thread join error")?;

        let processed = match process_result {
            Ok(res) => res,
            Err(ProcessorError::DecompressionBomb { width, height }) => {
                warn!(
                    "Decompression bomb rejected for attachment {}: {}x{}",
                    attachment_id, width, height
                );
                self.db.update_failed(attachment_id).await?;
                return Ok(());
            }
            Err(e) => {
                error!("Image processing failed for attachment {}: {:?}", attachment_id, e);
                self.db.update_failed(attachment_id).await?;
                return Ok(()); // Cleanly ACK message so unprocessable media does not loop
            }
        };

        // 3. Upload sanitized full image (EXIF stripped) if available
        if let Some(clean_bytes) = processed.sanitized_bytes {
            if let Err(e) = self.storage.upload_object(&p.s3_bucket, &p.s3_key, clean_bytes, &p.content_type).await {
                warn!("Failed to overwrite S3 object with EXIF-stripped image: {:?}", e);
            }
        }

        // 4. Upload thumbnails to MinIO
        let mut thumbnail_map: HashMap<String, ThumbnailInfo> = HashMap::new();

        for thumb in processed.thumbnails {
            let thumb_key = format!(
                "attachments/{}/{}/thumb_{}{}",
                p.channel_id, p.attachment_id, thumb.tier, thumb.extension
            );

            let thumb_size = thumb.bytes.len();
            self.storage
                .upload_object(&p.s3_bucket, &thumb_key, thumb.bytes, &thumb.content_type)
                .await
                .with_context(|| format!("Failed to upload thumbnail tier {} to S3", thumb.tier))?;

            let public_url = self.storage.public_url(&p.s3_bucket, &thumb_key);

            thumbnail_map.insert(
                thumb.tier.to_string(),
                ThumbnailInfo {
                    width: thumb.width,
                    height: thumb.height,
                    size: thumb_size,
                    s3_key: thumb_key,
                    url: public_url,
                },
            );
        }

        // 4. Update PostgreSQL state to ready
        self.db
            .update_ready(
                attachment_id,
                processed.width,
                processed.height,
                None,
                &thumbnail_map,
            )
            .await?;

        info!(
            "Successfully processed image attachment {}: dimensions={}x{}, {} thumbnails generated.",
            attachment_id,
            processed.width,
            processed.height,
            thumbnail_map.len()
        );

        Ok(())
    }

    async fn handle_video(&self, attachment_id: i64, p: &FileUploadPayload) -> Result<()> {
        // 1. Download raw video file from MinIO
        let raw_bytes = match self.storage.download_object(&p.s3_bucket, &p.s3_key).await {
            Ok(b) => b,
            Err(e) => {
                error!("Failed to download video from S3: {:?}", e);
                self.db.update_failed(attachment_id).await?;
                return Err(e);
            }
        };

        // 2. Process video: probe metadata, extract poster, encode WebP + thumbnails
        let processed = match process_video(&raw_bytes, attachment_id, &p.content_type).await {
            Ok(res) => res,
            Err(e) => {
                error!("Video processing failed for attachment {}: {:?}", attachment_id, e);
                self.db.update_failed(attachment_id).await?;
                return Ok(()); // Mark failed in DB and cleanly return Ok so message is ACKed
            }
        };

        let mut thumbnail_map: HashMap<String, ThumbnailInfo> = HashMap::new();

        // 3. Upload master poster frame to MinIO: attachments/{channel_id}/{attachment_id}/poster.webp
        let poster_key = format!("attachments/{}/{}/poster.webp", p.channel_id, p.attachment_id);
        let poster_size = processed.poster_bytes.len();
        self.storage
            .upload_object(&p.s3_bucket, &poster_key, processed.poster_bytes, "image/webp")
            .await
            .with_context(|| "Failed to upload video poster frame to S3")?;

        let poster_url = self.storage.public_url(&p.s3_bucket, &poster_key);
        thumbnail_map.insert(
            "poster".to_string(),
            ThumbnailInfo {
                width: processed.metadata.width,
                height: processed.metadata.height,
                size: poster_size,
                s3_key: poster_key,
                url: poster_url,
            },
        );

        // 4. Upload downscaled preview tiers to MinIO
        for thumb in processed.thumbnails {
            let thumb_key = format!(
                "attachments/{}/{}/thumb_{}{}",
                p.channel_id, p.attachment_id, thumb.tier, thumb.extension
            );

            let thumb_size = thumb.bytes.len();
            self.storage
                .upload_object(&p.s3_bucket, &thumb_key, thumb.bytes, &thumb.content_type)
                .await
                .with_context(|| format!("Failed to upload thumbnail tier {} to S3", thumb.tier))?;

            let public_url = self.storage.public_url(&p.s3_bucket, &thumb_key);
            thumbnail_map.insert(
                thumb.tier.to_string(),
                ThumbnailInfo {
                    width: thumb.width,
                    height: thumb.height,
                    size: thumb_size,
                    s3_key: thumb_key,
                    url: public_url,
                },
            );
        }

        // 5. Update PostgreSQL state to ready with duration and dimensions
        self.db
            .update_ready(
                attachment_id,
                processed.metadata.width,
                processed.metadata.height,
                Some(processed.metadata.duration_seconds),
                &thumbnail_map,
            )
            .await?;

        info!(
            "Successfully processed video attachment {}: dimensions={}x{}, duration={:.2}s, poster & {} thumbnails generated.",
            attachment_id,
            processed.metadata.width,
            processed.metadata.height,
            processed.metadata.duration_seconds,
            thumbnail_map.len() - 1
        );

        Ok(())
    }
}

/// Builds the gateway envelope for a processing-completion hint. Shape must
/// match the API's events.Event contract the gateway bus parses:
/// {type, version, guild_id, payload}. Slim payload (ids only) — the client
/// refetches full metadata via REST. extract_channel_id() in the gateway
/// reads payload["channel_id"], so no gateway changes are needed.
fn message_update_envelope(guild_id: &str, channel_id: &str, message_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "MESSAGE_UPDATE",
        "version": 1,
        "guild_id": guild_id,
        "payload": {
            "id": message_id,
            "channel_id": channel_id,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::message_update_envelope;

    #[test]
    fn message_update_envelope_matches_gateway_contract() {
        let v = message_update_envelope("100", "200", "300");
        assert_eq!(v["type"], "MESSAGE_UPDATE");
        assert_eq!(v["version"], 1);
        assert_eq!(v["guild_id"], "100");
        assert_eq!(v["payload"]["id"], "300");
        assert_eq!(v["payload"]["channel_id"], "200");
    }
}
