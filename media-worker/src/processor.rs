use std::io::Cursor;
use image::{imageops::FilterType, ImageFormat};
use rayon::prelude::*;
use thiserror::Error;

use crate::model::{ProcessedMedia, ThumbnailOutput};

pub const THUMBNAIL_TIERS: [u32; 4] = [80, 128, 256, 512];
pub const MAX_DIMENSION: u32 = 8192;
pub const MAX_PIXELS: u64 = 36_000_000;

#[derive(Error, Debug)]
pub enum ProcessorError {
    #[error("Decompression bomb detected: {width}x{height} exceeds safety bounds")]
    DecompressionBomb { width: u32, height: u32 },

    #[error("Failed to decode image: {0}")]
    ImageDecode(#[from] image::ImageError),

    #[error("Failed to read image dimensions: {0}")]
    Io(#[from] std::io::Error),

    #[error("Unsupported media content type: {0}")]
    UnsupportedFormat(String),
}

/// Checks whether the given MIME type represents an image format processed by this worker.
pub fn is_supported_image(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

/// Probes natural dimensions, validates decompression bomb guards,
/// strips EXIF metadata, and generates 4 thumbnails in parallel via Rayon.
pub fn process_image(raw_bytes: &[u8], content_type: &str) -> Result<ProcessedMedia, ProcessorError> {
    if !is_supported_image(content_type) {
        return Err(ProcessorError::UnsupportedFormat(content_type.to_string()));
    }

    // 1. Decompression Bomb Guard: Configure strict limits & probe header dimensions before allocating pixel buffer
    let mut reader = image::ImageReader::new(Cursor::new(raw_bytes))
        .with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024); // 128 MB max memory budget
    reader.limits(limits);

    let (orig_width, orig_height) = reader.into_dimensions()?;

    if orig_width > MAX_DIMENSION
        || orig_height > MAX_DIMENSION
        || (orig_width as u64 * orig_height as u64) > MAX_PIXELS
    {
        return Err(ProcessorError::DecompressionBomb {
            width: orig_width,
            height: orig_height,
        });
    }

    // 2. Decode image buffer within limits (DynamicImage contains pure pixel buffer, stripping all EXIF/GPS chunks)
    let mut decode_reader = image::ImageReader::new(Cursor::new(raw_bytes))
        .with_guessed_format()?;
    let mut decode_limits = image::Limits::default();
    decode_limits.max_image_width = Some(MAX_DIMENSION);
    decode_limits.max_image_height = Some(MAX_DIMENSION);
    decode_limits.max_alloc = Some(128 * 1024 * 1024);
    decode_reader.limits(decode_limits);

    let img = decode_reader.decode()?;

    // 3. Generate sanitized full-resolution image without EXIF/GPS metadata
    let mut sanitized_buf = Cursor::new(Vec::new());
    let format = match content_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => ImageFormat::Jpeg,
    };
    let _ = img.write_to(&mut sanitized_buf, format);
    let sanitized_bytes = if !sanitized_buf.get_ref().is_empty() {
        Some(sanitized_buf.into_inner())
    } else {
        None
    };

    // 4. Parallel thumbnail generation across standard tiers using Rayon
    let thumbnails: Result<Vec<ThumbnailOutput>, ProcessorError> = THUMBNAIL_TIERS
        .par_iter()
        .map(|&tier| {
            // Compute dimensions preserving aspect ratio
            let (target_w, target_h) = calculate_aspect_dimensions(orig_width, orig_height, tier);

            let filter = if tier >= 256 {
                FilterType::Lanczos3
            } else {
                FilterType::Triangle
            };

            let resized = img.resize(target_w, target_h, filter);

            let mut buf = Cursor::new(Vec::new());
            resized.write_to(&mut buf, ImageFormat::WebP)?;

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

    Ok(ProcessedMedia {
        width: orig_width,
        height: orig_height,
        sanitized_bytes,
        thumbnails,
    })
}

/// Calculates aspect-ratio preserving dimensions bounded by max_dim.
pub fn calculate_aspect_dimensions(orig_w: u32, orig_h: u32, max_dim: u32) -> (u32, u32) {
    if orig_w == 0 || orig_h == 0 {
        return (1, 1);
    }

    if orig_w >= orig_h {
        let target_w = max_dim.min(orig_w);
        let target_h = ((orig_h as f64 * target_w as f64) / orig_w as f64).round() as u32;
        (target_w.max(1), target_h.max(1))
    } else {
        let target_h = max_dim.min(orig_h);
        let target_w = ((orig_w as f64 * target_h as f64) / orig_h as f64).round() as u32;
        (target_w.max(1), target_h.max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_aspect_dimensions() {
        // 16:9 Landscape (1920x1080)
        let (w, h) = calculate_aspect_dimensions(1920, 1080, 512);
        assert_eq!(w, 512);
        assert_eq!(h, 288);

        let (w, h) = calculate_aspect_dimensions(1920, 1080, 256);
        assert_eq!(w, 256);
        assert_eq!(h, 144);

        let (w, h) = calculate_aspect_dimensions(1920, 1080, 128);
        assert_eq!(w, 128);
        assert_eq!(h, 72);

        let (w, h) = calculate_aspect_dimensions(1920, 1080, 80);
        assert_eq!(w, 80);
        assert_eq!(h, 45);

        // 9:16 Portrait (1080x1920)
        let (w, h) = calculate_aspect_dimensions(1080, 1920, 512);
        assert_eq!(w, 288);
        assert_eq!(h, 512);

        // Square
        let (w, h) = calculate_aspect_dimensions(500, 500, 128);
        assert_eq!(w, 128);
        assert_eq!(h, 128);
    }
}
