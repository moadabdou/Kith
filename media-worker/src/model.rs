use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MediaEvent {
    pub r#type: String,
    pub version: u32,
    pub payload: FileUploadPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FileUploadPayload {
    pub attachment_id: String,
    pub channel_id: String,
    pub uploader_id: String,
    pub filename: String,
    pub content_type: String,
    pub byte_size: i64,
    pub sha256: String,
    pub s3_bucket: String,
    pub s3_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailInfo {
    pub width: u32,
    pub height: u32,
    pub size: usize,
    pub s3_key: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct ThumbnailOutput {
    pub tier: u32,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub extension: String,
}

#[derive(Debug, Clone)]
pub struct ProcessedMedia {
    pub width: u32,
    pub height: u32,
    pub sanitized_bytes: Option<Vec<u8>>,
    pub thumbnails: Vec<ThumbnailOutput>,
}

