use image::DynamicImage;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::num::NonZeroU32;
use std::path::Path;
use serde::Serialize;
use fast_image_resize as fr;
use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::ImageFormat;

const THUMBNAIL_SIZE: u32 = 256;
const JPEG_QUALITY: u8 = 80;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResult {
    pub path: String,
    pub thumbnail_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub upgrading: bool,
}

pub fn check_thumbnail_cache(image_path: &str, cache_dir: &Path) -> Option<String> {
    let cache_key = compute_cache_key(image_path).ok()?;
    let jpg_filename = format!("{}_q{}.jpg", &cache_key, JPEG_QUALITY);
    let jpg_path = cache_dir.join(&jpg_filename);
    if jpg_path.exists() {
        return Some(jpg_path.to_string_lossy().to_string());
    }
    let webp_filename = format!("{}_q{}.webp", &cache_key, JPEG_QUALITY);
    let webp_path = cache_dir.join(&webp_filename);
    if webp_path.exists() {
        return Some(webp_path.to_string_lossy().to_string());
    }
    None
}

pub fn generate_thumbnail(
    image_path: &str,
    cache_dir: &Path,
) -> Result<ThumbnailResult, String> {
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir {:?}: {}", cache_dir, e))?;
    }

    let cache_key = compute_cache_key(image_path)?;
    let cache_filename = format!("{}_q{}.jpg", &cache_key, JPEG_QUALITY);
    let cache_path = cache_dir.join(&cache_filename);

    if cache_path.exists() {
        return Ok(ThumbnailResult {
            path: image_path.to_string(),
            thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
            width: 0,
            height: 0,
            upgrading: false,
        });
    }

    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", image_path));
    }

    let img = load_image(path)?;
    let (width, height) = (img.width(), img.height());

    let (dst_width, dst_height) = compute_thumbnail_size(width, height, THUMBNAIL_SIZE);
    let has_alpha = img.color().has_alpha();

    if has_alpha {
        let src_image = fr::Image::from_vec_u8(
            NonZeroU32::new(width).ok_or("Invalid width")?,
            NonZeroU32::new(height).ok_or("Invalid height")?,
            img.to_rgba8().into_raw(),
            fr::PixelType::U8x4,
        ).map_err(|e| format!("Failed to create src image: {:?}", e))?;

        let mut dst_image = fr::Image::new(
            NonZeroU32::new(dst_width).ok_or("Invalid dst width")?,
            NonZeroU32::new(dst_height).ok_or("Invalid dst height")?,
            src_image.pixel_type(),
        );
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut())
            .map_err(|e| format!("Failed to resize: {:?}", e))?;

        let pixels = dst_image.buffer();
        let has_actual_transparency = pixels.chunks_exact(4).any(|p| p[3] < 255);

        if has_actual_transparency {
            let webp_cache_filename = format!("{}_q{}.webp", &cache_key, JPEG_QUALITY);
            let webp_cache_path = cache_dir.join(&webp_cache_filename);
            let resized_img = image::DynamicImage::ImageRgba8(
                image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())
                    .ok_or("Failed to create image buffer")?
            );
            let cache_file = File::create(&webp_cache_path)
                .map_err(|e| format!("Failed to create cache file: {:?}", e))?;
            let mut writer = BufWriter::new(cache_file);
            resized_img.write_to(&mut writer, ImageFormat::WebP)
                .map_err(|e| format!("Failed to encode WebP: {}", e))?;

            return Ok(ThumbnailResult {
                path: image_path.to_string(),
                thumbnail_path: Some(webp_cache_path.to_string_lossy().to_string()),
                width,
                height,
                upgrading: false,
            });
        }

        let rgb_buffer: Vec<u8> = pixels.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let file = File::create(&cache_path)
            .map_err(|e| format!("Failed to create cache file {:?}: {}", cache_path, e))?;
        let mut writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
        encoder.encode(&rgb_buffer, dst_width, dst_height, image::ColorType::Rgb8.into())
            .map_err(|e| format!("Failed to encode: {}", e))?;
    } else {
        let src_image = fr::Image::from_vec_u8(
            NonZeroU32::new(width).ok_or("Invalid width")?,
            NonZeroU32::new(height).ok_or("Invalid height")?,
            img.to_rgb8().into_raw(),
            fr::PixelType::U8x3,
        ).map_err(|e| format!("Failed to create src image: {:?}", e))?;

        let mut dst_image = fr::Image::new(
            NonZeroU32::new(dst_width).ok_or("Invalid dst width")?,
            NonZeroU32::new(dst_height).ok_or("Invalid dst height")?,
            src_image.pixel_type(),
        );
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut())
            .map_err(|e| format!("Failed to resize: {:?}", e))?;

        let file = File::create(&cache_path)
            .map_err(|e| format!("Failed to create cache file {:?}: {}", cache_path, e))?;
        let mut writer = BufWriter::new(file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
        encoder.encode(dst_image.buffer(), dst_width, dst_height, image::ColorType::Rgb8.into())
            .map_err(|e| format!("Failed to encode: {}", e))?;
    }

    Ok(ThumbnailResult {
        path: image_path.to_string(),
        thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
        width,
        height,
        upgrading: false,
    })
}

fn compute_thumbnail_size(width: u32, height: u32, target_size: u32) -> (u32, u32) {
    if width < height {
        let ratio = height as f32 / width as f32;
        (target_size, (target_size as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((target_size as f32 * ratio) as u32, target_size)
    }
}

fn compute_cache_key(image_path: &str) -> Result<String, String> {
    let path = Path::new(image_path);
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to get metadata for {}: {}", image_path, e))?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    let cache_key = format!("{}-{}-{}", size, modified, image_path);
    let hash = format!("{:x}", md5::compute(cache_key.as_bytes()));
    Ok(hash[..24].to_string())
}

fn load_image(path: &Path) -> Result<DynamicImage, String> {
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
        decoder.scale(THUMBNAIL_SIZE as u16, THUMBNAIL_SIZE as u16)
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
                    upgrading: false,
                });
            }
        }

        on_progress(i + 1, total);
    }

    Ok(results)
}

#[cfg(target_os = "android")]
pub fn get_android_system_thumbnail<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject<'a>,
    image_id: i64,
    cache_dir: &Path,
) -> Result<Option<(String, u32, u32)>, String> {
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }

    let cache_filename = format!("sys_{}_q{}.jpg", image_id, JPEG_QUALITY);
    let cache_path = cache_dir.join(&cache_filename);

    if cache_path.exists() {
        let (w, h) = image::image_dimensions(&cache_path).unwrap_or((0u32, 0u32));
        log::info!("[Thumbnail] System cache hit: imageId={}, dimensions={}x{}", image_id, w, h);
        return Ok(Some((cache_path.to_string_lossy().to_string(), w, h)));
    }

    let content_resolver = env.call_method(
        activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[]
    ).map_err(|e| format!("Failed to get content resolver: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

    let thumbnails_class = env.find_class("android/provider/MediaStore$Images$Thumbnails")
        .map_err(|e| format!("Failed to find Thumbnails class: {:?}", e))?;

    let mini_kind = env.get_static_field(
        &thumbnails_class, "MINI_KIND", "I",
    ).map_err(|e| format!("Failed to get MINI_KIND: {:?}", e))?
    .i().unwrap_or(1);

    let thumbnail_result = env.call_static_method(
        &thumbnails_class,
        "getThumbnail",
        "(Landroid/content/ContentResolver;JILandroid/graphics/BitmapFactory$Options;)Landroid/graphics/Bitmap;",
        &[
            jni::objects::JValue::Object(&content_resolver),
            jni::objects::JValue::Long(image_id),
            jni::objects::JValue::Int(mini_kind),
            jni::objects::JValue::Object(&jni::objects::JObject::null()),
        ],
    );

    match thumbnail_result {
        Ok(bitmap_val) => {
            let bitmap = bitmap_val.l()
                .map_err(|e| format!("Failed to get bitmap: {:?}", e))?;

            if bitmap.is_null() {
                log::warn!("[Thumbnail] MINI_KIND bitmap is null: imageId={}", image_id);
                return Ok(None);
            }

            let bmp_width = env.call_method(&bitmap, "getWidth", "()I", &[])
                .map(|v| v.i().unwrap_or(0)).unwrap_or(0);
            let bmp_height = env.call_method(&bitmap, "getHeight", "()I", &[])
                .map(|v| v.i().unwrap_or(0)).unwrap_or(0);
            log::info!("[Thumbnail] MINI_KIND bitmap size: {}x{} for imageId={}", bmp_width, bmp_height, image_id);

            let baos_class = env.find_class("java/io/ByteArrayOutputStream")
                .map_err(|e| format!("Failed to find ByteArrayOutputStream: {:?}", e))?;
            let baos = env.new_object(
                &baos_class, "()V", &[],
            ).map_err(|e| format!("Failed to create ByteArrayOutputStream: {:?}", e))?;

            let compress_format_class = env.find_class("android/graphics/Bitmap$CompressFormat")
                .map_err(|e| format!("Failed to find CompressFormat: {:?}", e))?;
            let jpeg_format = env.get_static_field(
                &compress_format_class, "JPEG", "Landroid/graphics/Bitmap$CompressFormat;",
            ).map_err(|e| format!("Failed to get JPEG format: {:?}", e))?
            .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

            let compress_ok = env.call_method(
                &bitmap,
                "compress",
                "(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z",
                &[
                    jni::objects::JValue::Object(&jpeg_format),
                    jni::objects::JValue::Int(JPEG_QUALITY as i32),
                    jni::objects::JValue::Object(&baos),
                ],
            ).map_err(|e| format!("Failed to compress bitmap: {:?}", e))?
            .z().unwrap_or(false);

            let _ = env.call_method(&bitmap, "recycle", "()V", &[]);

            if !compress_ok {
                return Ok(None);
            }

            let byte_array = env.call_method(
                &baos, "toByteArray", "()[B", &[],
            ).map_err(|e| format!("Failed to get byte array: {:?}", e))?
            .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

            let jbyte_array: jni::objects::JByteArray = byte_array.into();

            let byte_array_len = env.get_array_length(&jbyte_array)
                .map_err(|e| format!("Failed to get array length: {:?}", e))?;

            if byte_array_len <= 0 {
                return Ok(None);
            }

            let mut buf = vec![0i8; byte_array_len as usize];
            env.get_byte_array_region(
                &jbyte_array, 0, &mut buf,
            ).map_err(|e| format!("Failed to get byte array region: {:?}", e))?;

            let jpeg_data: Vec<u8> = buf.iter().map(|&b| b as u8).collect();
            std::fs::write(&cache_path, &jpeg_data)
                .map_err(|e| format!("Failed to write cache file: {}", e))?;

            Ok(Some((cache_path.to_string_lossy().to_string(), bmp_width as u32, bmp_height as u32)))
        }
        Err(_) => Ok(None),
    }
}
