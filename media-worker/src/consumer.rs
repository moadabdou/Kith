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

            if let Err(e) = self.handle_message(&msg.payload).await {
                error!("Error processing media event: {:?}", e);
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

        if is_supported_image(&p.content_type) {
            self.handle_image(attachment_id, &p).await?;
        } else if is_supported_video(&p.content_type) {
            self.handle_video(attachment_id, &p).await?;
        } else {
            info!(
                "Content type '{}' is neither an image nor a video requiring processing. Marking ready.",
                p.content_type
            );
            self.db
                .update_ready(attachment_id, 0, 0, None, &HashMap::new())
                .await?;
        }

        Ok(())
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
