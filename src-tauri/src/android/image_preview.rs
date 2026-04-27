use image::DynamicImage;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::num::NonZeroU32;
use std::path::Path;
use fast_image_resize as fr;
use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::ImageFormat;
use serde::Serialize;

const PREVIEW_MAX_DIMENSION: u32 = 1920;
const PREVIEW_JPEG_QUALITY: u8 = 85;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewResult {
    pub preview_path: String,
    pub original_width: u32,
    pub original_height: u32,
    pub is_downsampled: bool,
    pub is_animated_webp: bool,
}

pub fn generate_image_preview(
    image_path: &str,
    cache_dir: &Path,
) -> Result<ImagePreviewResult, String> {
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir {:?}: {}", cache_dir, e))?;
    }

    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", image_path));
    }

    let is_animated = is_animated_image(path);

    let cache_key = compute_preview_cache_key(image_path)?;
    let preview_filename = format!("preview_{}.jpg", &cache_key);
    let preview_path = cache_dir.join(&preview_filename);

    if preview_path.exists() {
        let (w, h) = get_original_dimensions(path)?;
        return Ok(ImagePreviewResult {
            preview_path: preview_path.to_string_lossy().to_string(),
            original_width: w,
            original_height: h,
            is_downsampled: w > PREVIEW_MAX_DIMENSION || h > PREVIEW_MAX_DIMENSION,
            is_animated_webp: is_animated,
        });
    }

    if is_animated {
        let (w, h) = get_original_dimensions(path)?;
        let needs_downsample = w > PREVIEW_MAX_DIMENSION || h > PREVIEW_MAX_DIMENSION;

        if needs_downsample {
            let img = load_first_frame(path)?;
            let (orig_w, orig_h) = (img.width(), img.height());
            let (dst_width, dst_height) = compute_preview_size(orig_w, orig_h, PREVIEW_MAX_DIMENSION);
            encode_preview(&img, dst_width, dst_height, &preview_path)?;

            Ok(ImagePreviewResult {
                preview_path: preview_path.to_string_lossy().to_string(),
                original_width: orig_w,
                original_height: orig_h,
                is_downsampled: true,
                is_animated_webp: true,
            })
        } else {
            Ok(ImagePreviewResult {
                preview_path: image_path.to_string(),
                original_width: w,
                original_height: h,
                is_downsampled: false,
                is_animated_webp: true,
            })
        }
    } else {
        let img = load_image_for_preview(path)?;
        let (orig_w, orig_h) = (img.width(), img.height());
        let needs_downsample = orig_w > PREVIEW_MAX_DIMENSION || orig_h > PREVIEW_MAX_DIMENSION;

        if needs_downsample {
            let (dst_width, dst_height) = compute_preview_size(orig_w, orig_h, PREVIEW_MAX_DIMENSION);
            encode_preview(&img, dst_width, dst_height, &preview_path)?;

            Ok(ImagePreviewResult {
                preview_path: preview_path.to_string_lossy().to_string(),
                original_width: orig_w,
                original_height: orig_h,
                is_downsampled: true,
                is_animated_webp: false,
            })
        } else {
            Ok(ImagePreviewResult {
                preview_path: image_path.to_string(),
                original_width: orig_w,
                original_height: orig_h,
                is_downsampled: false,
                is_animated_webp: false,
            })
        }
    }
}

fn is_animated_image(path: &Path) -> bool {
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if ext == "gif" {
        return true;
    }

    if ext == "webp" {
        return is_animated_webp(path);
    }

    false
}

fn is_animated_webp(path: &Path) -> bool {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    let mut header = [0u8; 21];
    if file.read_exact(&mut header).is_err() {
        return false;
    }

    if header.len() >= 21 {
        let riff = &header[0..4];
        let webp = &header[8..12];
        if riff == b"RIFF" && webp == b"WEBP" {
            let chunk_type = &header[12..16];
            if chunk_type == b"VP8X" {
                let flags = header[20];
                return (flags & 0x02) != 0;
            }
            if chunk_type == b"VP8 " || chunk_type == b"VP8L" {
                return false;
            }
        }
    }

    false
}

fn get_original_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let mut file = File::open(path)
        .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
    let mut buffer = [0u8; 16];
    let n = file.read(&mut buffer).unwrap_or(0);
    let buf = &buffer[..n];

    if buf.starts_with(b"\x89PNG") || buf.len() >= 4 && &buf[0..4] == b"\x89PNG" {
        if let Ok(dim) = image::image_dimensions(path) {
            return Ok(dim);
        }
    }

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        use std::io::Seek;
        use std::io::SeekFrom;
        let _ = file.seek(SeekFrom::Start(0));
        imageinfo::ImageInfo::from_file(&file)
    }));

    match result {
        Ok(Ok(info)) => Ok((info.size.width as u32, info.size.height as u32)),
        _ => {
            image::image_dimensions(path)
                .map_err(|e| format!("Failed to get dimensions: {}", e))
        }
    }
}

fn load_first_frame(path: &Path) -> Result<DynamicImage, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
    let reader = BufReader::new(file);
    let mut image_reader = image::io::Reader::new(reader);
    image_reader = image_reader.with_guessed_format()
        .map_err(|e| format!("Failed to guess format: {:?}", e))?;
    image_reader.no_limits();
    image_reader.decode()
        .map_err(|e| format!("Failed to decode {:?}: {}", path, e))
}

fn load_image_for_preview(path: &Path) -> Result<DynamicImage, String> {
    let mut file = File::open(path)
        .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer)
        .map_err(|e| format!("Failed to read file {:?}: {}", path, e))?;

    let format = image::guess_format(&buffer[..bytes_read]).ok();

    if format == Some(ImageFormat::Jpeg) {
        let file = File::open(path)
            .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
        let reader = BufReader::new(file);
        let mut decoder = JpegDecoder::new(reader)
            .map_err(|e| format!("Failed to create JPEG decoder: {}", e))?;
        decoder.scale(PREVIEW_MAX_DIMENSION as u16, PREVIEW_MAX_DIMENSION as u16)
            .map_err(|e| format!("Failed to set JPEG scale: {}", e))?;
        DynamicImage::from_decoder(decoder)
            .map_err(|e| format!("Failed to decode JPEG {:?}: {}", path, e))
    } else {
        let file = File::open(path)
            .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
        let reader = BufReader::new(file);
        let mut image_reader = image::io::Reader::new(reader);
        image_reader = image_reader.with_guessed_format()
            .map_err(|e| format!("Failed to guess format: {:?}", e))?;
        image_reader.no_limits();
        image_reader.decode()
            .map_err(|e| format!("Failed to decode {:?}: {}", path, e))
    }
}

fn compute_preview_size(width: u32, height: u32, max_dim: u32) -> (u32, u32) {
    if width <= max_dim && height <= max_dim {
        return (width, height);
    }
    if width >= height {
        let ratio = height as f32 / width as f32;
        (max_dim, (max_dim as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((max_dim as f32 * ratio) as u32, max_dim)
    }
}

fn encode_preview(
    img: &DynamicImage,
    dst_width: u32,
    dst_height: u32,
    output_path: &Path,
) -> Result<(), String> {
    let has_alpha = img.color().has_alpha();

    if has_alpha {
        let src_image = fr::Image::from_vec_u8(
            NonZeroU32::new(img.width()).ok_or("Invalid width")?,
            NonZeroU32::new(img.height()).ok_or("Invalid height")?,
            img.to_rgba8().into_raw(),
            fr::PixelType::U8x4,
        ).map_err(|e| format!("Failed to create src image: {:?}", e))?;

        let mut dst_image = fr::Image::new(
            NonZeroU32::new(dst_width).ok_or("Invalid dst width")?,
            NonZeroU32::new(dst_height).ok_or("Invalid dst height")?,
            src_image.pixel_type(),
        );
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Box));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut())
            .map_err(|e| format!("Failed to resize: {:?}", e))?;

        let pixels = dst_image.buffer();
        let has_actual_transparency = pixels.chunks_exact(4).any(|p| p[3] < 255);

        if has_actual_transparency {
            let resized_img = DynamicImage::ImageRgba8(
                image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())
                    .ok_or("Failed to create image buffer")?
            );
            let cache_file = File::create(output_path)
                .map_err(|e| format!("Failed to create cache file: {:?}", e))?;
            let mut writer = BufWriter::new(cache_file);
            resized_img.write_to(&mut writer, ImageFormat::WebP)
                .map_err(|e| format!("Failed to encode WebP: {}", e))?;
        } else {
            let rgb_buffer: Vec<u8> = pixels.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            let file = File::create(output_path)
                .map_err(|e| format!("Failed to create cache file {:?}: {}", output_path, e))?;
            let mut writer = BufWriter::new(file);
            let mut encoder = JpegEncoder::new_with_quality(&mut writer, PREVIEW_JPEG_QUALITY);
            encoder.encode(&rgb_buffer, dst_width, dst_height, image::ColorType::Rgb8.into())
                .map_err(|e| format!("Failed to encode: {}", e))?;
        }
    } else {
        let src_image = fr::Image::from_vec_u8(
            NonZeroU32::new(img.width()).ok_or("Invalid width")?,
            NonZeroU32::new(img.height()).ok_or("Invalid height")?,
            img.to_rgb8().into_raw(),
            fr::PixelType::U8x3,
        ).map_err(|e| format!("Failed to create src image: {:?}", e))?;

        let mut dst_image = fr::Image::new(
            NonZeroU32::new(dst_width).ok_or("Invalid dst width")?,
            NonZeroU32::new(dst_height).ok_or("Invalid dst height")?,
            src_image.pixel_type(),
        );
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Box));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut())
            .map_err(|e| format!("Failed to resize: {:?}", e))?;

        let file = File::create(output_path)
            .map_err(|e| format!("Failed to create cache file {:?}: {}", output_path, e))?;
        let mut writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, PREVIEW_JPEG_QUALITY);
        encoder.encode(dst_image.buffer(), dst_width, dst_height, image::ColorType::Rgb8.into())
            .map_err(|e| format!("Failed to encode: {}", e))?;
    }

    Ok(())
}

fn compute_preview_cache_key(image_path: &str) -> Result<String, String> {
    let path = Path::new(image_path);
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to get metadata for {}: {}", image_path, e))?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    let cache_key = format!("preview-{}-{}-{}", size, modified, image_path);
    let hash = format!("{:x}", md5::compute(cache_key.as_bytes()));
    Ok(hash[..24].to_string())
}
