use image::{DynamicImage, ImageFormat};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use serde::Serialize;

const THUMBNAIL_SIZE: u32 = 256;
const JPEG_QUALITY: u8 = 80;

#[derive(Clone, Serialize)]
pub struct ThumbnailResult {
    pub path: String,
    pub thumbnail_path: Option<String>,
    pub width: u32,
    pub height: u32,
}

pub fn generate_thumbnail(
    image_path: &str,
    cache_dir: &Path,
) -> Result<ThumbnailResult, String> {
    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", image_path));
    }
    
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    
    let cache_key = format!("{}-{}-{}", size, modified, image_path);
    let hash = format!("{:x}", md5::compute(cache_key.as_bytes()));
    let cache_filename = format!("{}.jpg", &hash[..24]);
    let cache_path = cache_dir.join(&cache_filename);
    
    if cache_path.exists() {
        return Ok(ThumbnailResult {
            path: image_path.to_string(),
            thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
            width: 0,
            height: 0,
        });
    }
    
    let img = load_image(path)?;
    let (width, height) = (img.width(), img.height());
    
    let thumbnail = resize_image(&img, THUMBNAIL_SIZE);
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }
    
    let file = File::create(&cache_path)
        .map_err(|e| format!("Failed to create cache file: {}", e))?;
    let writer = BufWriter::new(file);
    
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
    encoder.encode(
        thumbnail.as_bytes(),
        thumbnail.width(),
        thumbnail.height(),
        image::ColorType::Rgb8.into(),
    ).map_err(|e| format!("Failed to encode: {}", e))?;
    
    Ok(ThumbnailResult {
        path: image_path.to_string(),
        thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
        width,
        height,
    })
}

fn load_image(path: &Path) -> Result<DynamicImage, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);
    
    let mut image_reader = image::io::Reader::new(reader);
    image_reader = image_reader.with_guessed_format()
        .map_err(|e| format!("Failed to guess format: {}", e))?;
    
    image_reader.decode()
        .map_err(|e| format!("Failed to decode: {}", e))
}

fn resize_image(img: &DynamicImage, target_size: u32) -> DynamicImage {
    let (width, height) = (img.width(), img.height());
    
    let (new_width, new_height) = if width < height {
        let ratio = height as f32 / width as f32;
        (target_size, (target_size as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((target_size as f32 * ratio) as u32, target_size)
    };
    
    img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
}

pub fn generate_thumbnails_batch(
    image_paths: Vec<String>,
    cache_dir: String,
    on_progress: impl Fn(usize, usize) + Send + Sync + 'static,
) -> Result<Vec<ThumbnailResult>, String> {
    let cache_path = Path::new(&cache_dir);
    let mut results = Vec::new();
    let total = image_paths.len();
    
    for (i, path) in image_paths.iter().enumerate() {
        match generate_thumbnail(path, cache_path) {
            Ok(result) => results.push(result),
            Err(e) => {
                log::warn!("Failed to generate thumbnail for {}: {}", path, e);
                results.push(ThumbnailResult {
                    path: path.clone(),
                    thumbnail_path: None,
                    width: 0,
                    height: 0,
                });
            }
        }
        
        on_progress(i + 1, total);
    }
    
    Ok(results)
}
