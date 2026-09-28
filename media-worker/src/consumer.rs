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
use crate::model::{MediaEvent, ThumbnailInfo};
use crate::processor::{is_supported_image, process_image, ProcessorError};
use crate::storage::Storage;

pub struct Consumer {
    cfg: Config,
    storage: Storage,
    db: Database,
}

impl Consumer {
    pub fn new(cfg: Config, storage: Storage, db: Database) -> Self {
        Self { cfg, storage, db }
    }

    pub async fn run(&self) -> Result<()> {
        info!(
            "Connecting to NATS at {} for stream {}",
            self.cfg.nats_url, self.cfg.stream_name
        );

        let nats_client = async_nats::connect(&self.cfg.nats_url)
            .await
            .context("Failed to connect to NATS server")?;

        let js = jetstream::new(nats_client);

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

        while let Some(msg_res) = messages.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                Err(e) => {
                    warn!("Transient error pulling message from JetStream: {:?}", e);
                    continue;
                }
            };

            if let Err(e) = self.handle_message(&msg.payload).await {
                error!("Error processing media event: {:?}", e);
                // In case of error, we can NAK or ACK depending on error type
                // If it's a permanent failure, we already marked DB failed and will ACK
            }

            if let Err(e) = msg.ack().await {
                error!("Failed to ACK JetStream message: {:?}", e);
            }
        }

        Ok(())
    }

    async fn handle_message(&self, payload_bytes: &[u8]) -> Result<()> {
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

        // If not an image (e.g. video or doc), mark ready or pass through
        if !is_supported_image(&p.content_type) {
            info!(
                "Content type '{}' is not an image requiring thumbnail generation. Marking ready.",
                p.content_type
            );
            self.db
                .update_ready(attachment_id, 0, 0, &HashMap::new())
                .await?;
            return Ok(());
        }

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
                return Err(anyhow::anyhow!("Processing failed: {}", e));
            }
        };

        // 3. Upload thumbnails to MinIO
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
                &thumbnail_map,
            )
            .await?;

        info!(
            "Successfully processed attachment {}: dimensions={}x{}, {} thumbnails generated.",
            attachment_id,
            processed.width,
            processed.height,
            thumbnail_map.len()
        );

        Ok(())
    }
}
