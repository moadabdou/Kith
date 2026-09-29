use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use anyhow::{Context, Result};
use image::{imageops::FilterType, ImageFormat};
use rayon::prelude::*;
use serde::Deserialize;
use tracing::{debug, info};

use crate::model::ThumbnailOutput;
use crate::processor::{calculate_aspect_dimensions, MAX_DIMENSION, MAX_PIXELS, THUMBNAIL_TIERS};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Checks whether the given MIME type represents a video format supported for processing.
pub fn is_supported_video(content_type: &str) -> bool {
    matches!(
        content_type,
        "video/mp4" | "video/webm" | "video/quicktime" | "video/x-matroska" | "video/ogg"
    )
}

/// RAII wrapper around a temporary file on disk that cleans up on drop.
pub struct TempFile {
    path: PathBuf,
}

impl TempFile {
    pub async fn create_with_data(attachment_id: i64, ext: &str, data: &[u8]) -> Result<Self> {
        let count = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let filename = format!("media_{}_{}_{}.{}", attachment_id, std::process::id(), count, ext);
        let path = std::env::temp_dir().join(filename);

        tokio::fs::write(&path, data)
            .await
            .with_context(|| format!("Failed to write temporary video file: {:?}", path))?;

        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FfprobeFormat {
    duration: Option<String>,
    bit_rate: Option<String>,
    format_name: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct VideoProcessResult {
    pub metadata: VideoMetadata,
    pub poster_bytes: Vec<u8>,
    pub thumbnails: Vec<ThumbnailOutput>,
}

/// Probes media container metadata (duration, resolution, codecs, bitrate) using ffprobe.
pub async fn probe_video(path: &Path) -> Result<VideoMetadata> {
    let path_str = path
        .to_str()
        .context("Invalid UTF-8 in video file path")?;

    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new("ffprobe")
            .args(&[
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                path_str,
            ])
            .output(),
    )
    .await
    .context("ffprobe execution timed out after 15 seconds")?
    .context("Failed to execute ffprobe process")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffprobe exited with status {:?}: {}", output.status.code(), stderr);
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .context("Failed to parse ffprobe JSON output")?;

    let video_stream = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));

    let audio_stream = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let width = video_stream.and_then(|s| s.width).unwrap_or(0);
    let height = video_stream.and_then(|s| s.height).unwrap_or(0);
    let video_codec = video_stream.and_then(|s| s.codec_name.clone());
    let audio_codec = audio_stream.and_then(|s| s.codec_name.clone());

    // Duration: check format first, then video stream
    let duration_seconds = parsed
        .format
        .as_ref()
        .and_then(|f| f.duration.as_deref())
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            video_stream
                .and_then(|s| s.duration.as_deref())
                .and_then(|d| d.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    let bitrate = parsed
        .format
        .as_ref()
        .and_then(|f| f.bit_rate.as_deref())
        .and_then(|b| b.parse::<u64>().ok())
        .or_else(|| {
            video_stream
                .and_then(|s| s.bit_rate.as_deref())
                .and_then(|b| b.parse::<u64>().ok())
        });

    info!(
        "Probed video: {}x{}, duration={:.2}s, v_codec={:?}, a_codec={:?}, bitrate={:?}",
        width, height, duration_seconds, video_codec, audio_codec, bitrate
    );

    Ok(VideoMetadata {
        width,
        height,
        duration_seconds,
        video_codec,
        audio_codec,
        bitrate,
    })
}

/// Extracts a single representative video keyframe using ffmpeg at ~1s offset.
pub async fn extract_poster_frame(path: &Path, duration_seconds: f64) -> Result<Vec<u8>> {
    let path_str = path
        .to_str()
        .context("Invalid UTF-8 in video file path")?;

    // Seek offset: 1.0s if video is at least 1.5s, else midpoint (or 0s)
    let seek_offset = if duration_seconds >= 1.5 {
        1.0
    } else if duration_seconds > 0.0 {
        duration_seconds / 2.0
    } else {
        0.0
    };

    let ss_arg = format!("{:.3}", seek_offset);
    debug!("Extracting poster frame at offset {}s from {:?}", ss_arg, path);

    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new("ffmpeg")
            .args(&[
                "-nostdin",
                "-ss", &ss_arg,
                "-i", path_str,
                "-vframes", "1",
                "-f", "image2pipe",
                "-vcodec", "png",
                "-"
            ])
            .output(),
    )
    .await
    .context("ffmpeg poster extraction timed out after 20 seconds")?
    .context("Failed to execute ffmpeg process")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffmpeg poster extraction exited with status {:?}: {}", output.status.code(), stderr);
    }

    let png_bytes = output.stdout;
    if png_bytes.is_empty() {
        anyhow::bail!("ffmpeg generated an empty poster frame stream");
    }

    Ok(png_bytes)
}

/// Processes a video file: writes to temp file, probes metadata, extracts poster frame,
/// and downscales preview thumbnails in parallel via Rayon.
pub async fn process_video(
    raw_bytes: &[u8],
    attachment_id: i64,
    content_type: &str,
) -> Result<VideoProcessResult> {
    let ext = match content_type {
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        "video/ogg" => "ogv",
        _ => "mp4",
    };

    let temp_file = TempFile::create_with_data(attachment_id, ext, raw_bytes).await?;

    // 1. Probe video streams and duration
    let metadata = probe_video(temp_file.path()).await?;

    // 2. Extract keyframe as PNG
    let png_bytes = extract_poster_frame(temp_file.path(), metadata.duration_seconds).await?;

    // 3. Offload image decoding, validation & Rayon WebP thumbnail generation to blocking pool
    let process_result = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, Vec<ThumbnailOutput>)> {
        let img = image::load_from_memory(&png_bytes)
            .context("Failed to decode extracted poster PNG buffer")?;

        let orig_w = img.width();
        let orig_h = img.height();

        if orig_w > MAX_DIMENSION || orig_h > MAX_DIMENSION || (orig_w as u64 * orig_h as u64) > MAX_PIXELS {
            anyhow::bail!("Poster frame dimensions ({}x{}) exceed safety limits", orig_w, orig_h);
        }

        // Encode full poster frame to WebP
        let mut poster_buf = Cursor::new(Vec::new());
        img.write_to(&mut poster_buf, ImageFormat::WebP)
            .context("Failed to encode master poster frame as WebP")?;
        let poster_bytes = poster_buf.into_inner();

        // Generate 4 standard downscaled thumbnail tiers in parallel
        let thumbnails: Result<Vec<ThumbnailOutput>> = THUMBNAIL_TIERS
            .par_iter()
            .map(|&tier| {
                let (target_w, target_h) = calculate_aspect_dimensions(orig_w, orig_h, tier);
                let filter = if target_w < orig_w / 2 {
                    FilterType::Lanczos3
                } else {
                    FilterType::Triangle
                };

                let resized = img.resize(target_w, target_h, filter);
                let mut buf = Cursor::new(Vec::new());
                resized
                    .write_to(&mut buf, ImageFormat::WebP)
                    .with_context(|| format!("Failed to encode tier {} thumbnail", tier))?;

                Ok(ThumbnailOutput {
                    tier,
                    width: target_w,
                    height: target_h,
                    bytes: buf.into_inner(),
                    content_type: "image/webp".to_string(),
                    extension: ".webp".to_string(),
                })
            })
            .collect();

        let thumbnails = thumbnails?;
        Ok((poster_bytes, thumbnails))
    })
    .await
    .context("Rayon blocking task failed")??;

    let (poster_bytes, thumbnails) = process_result;

    Ok(VideoProcessResult {
        metadata,
        poster_bytes,
        thumbnails,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_supported_video() {
        assert!(is_supported_video("video/mp4"));
        assert!(is_supported_video("video/webm"));
        assert!(is_supported_video("video/quicktime"));
        assert!(is_supported_video("video/x-matroska"));
        assert!(is_supported_video("video/ogg"));

        assert!(!is_supported_video("image/png"));
        assert!(!is_supported_video("image/jpeg"));
        assert!(!is_supported_video("application/pdf"));
        assert!(!is_supported_video("text/plain"));
    }

    #[tokio::test]
    async fn test_temp_file_cleanup_on_drop() {
        let dummy_data = b"test video data payload";
        let path_clone;
        {
            let temp = TempFile::create_with_data(12345, "mp4", dummy_data)
                .await
                .expect("TempFile creation failed");
            path_clone = temp.path().to_path_buf();
            assert!(path_clone.exists(), "Temp file must exist while in scope");
            let read_bytes = tokio::fs::read(&path_clone).await.unwrap();
            assert_eq!(read_bytes, dummy_data);
        }
        assert!(!path_clone.exists(), "Temp file must be removed on drop");
    }

    #[test]
    fn test_parse_ffprobe_json() {
        let sample_json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "duration": "12.500000",
                    "bit_rate": "2500000"
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "duration": "12.500000"
                }
            ],
            "format": {
                "duration": "12.500000",
                "bit_rate": "2628000",
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
            }
        }"#;

        let parsed: FfprobeOutput = serde_json::from_str(sample_json).unwrap();
        let video_stream = parsed
            .streams
            .iter()
            .find(|s| s.codec_type.as_deref() == Some("video"))
            .unwrap();

        assert_eq!(video_stream.width, Some(1920));
        assert_eq!(video_stream.height, Some(1080));
        assert_eq!(video_stream.codec_name.as_deref(), Some("h264"));
        assert_eq!(parsed.format.unwrap().duration.as_deref(), Some("12.500000"));
    }

    #[tokio::test]
    async fn test_process_corrupt_video() {
        let corrupt_data = b"corrupt binary data not a valid video stream";
        let result = process_video(corrupt_data, 99999, "video/mp4").await;
        assert!(result.is_err(), "Corrupt video data must return an error");
    }
}
