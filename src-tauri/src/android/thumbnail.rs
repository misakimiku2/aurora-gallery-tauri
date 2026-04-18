use image::DynamicImage;
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use serde::Serialize;

const THUMBNAIL_SIZE: u32 = 256;
const JPEG_QUALITY: u8 = 80;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir {:?}: {}", cache_dir, e))?;
    }

    let cache_key = compute_cache_key(image_path)?;
    let cache_filename = format!("{}.jpg", &cache_key);
    let cache_path = cache_dir.join(&cache_filename);

    if cache_path.exists() {
        return Ok(ThumbnailResult {
            path: image_path.to_string(),
            thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
            width: 0,
            height: 0,
        });
    }

    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", image_path));
    }

    let img = load_image(path)?;
    let (width, height) = (img.width(), img.height());

    let thumbnail = resize_image(&img, THUMBNAIL_SIZE);

    let file = File::create(&cache_path)
        .map_err(|e| format!("Failed to create cache file {:?}: {}", cache_path, e))?;
    let mut writer = BufWriter::new(file);

    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY);
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
    let file = File::open(path)
        .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;
    let reader = BufReader::new(file);

    let mut image_reader = image::io::Reader::new(reader);
    image_reader = image_reader.with_guessed_format()
        .map_err(|e| format!("Failed to guess format: {:?}", e))?;

    image_reader.decode()
        .map_err(|e| format!("Failed to decode {:?}: {}", path, e))
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

    let resized = img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3);
    DynamicImage::ImageRgb8(resized.to_rgb8())
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

#[cfg(target_os = "android")]
pub fn get_android_system_thumbnail<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject<'a>,
    image_id: i64,
    cache_dir: &Path,
) -> Result<Option<String>, String> {
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }

    let cache_filename = format!("sys_{}.jpg", image_id);
    let cache_path = cache_dir.join(&cache_filename);

    if cache_path.exists() {
        return Ok(Some(cache_path.to_string_lossy().to_string()));
    }

    let content_resolver = env.call_method(
        activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[]
    ).map_err(|e| format!("Failed to get content resolver: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

    let uri_class = env.find_class("android/content/ContentUris")
        .map_err(|e| format!("Failed to find ContentUris: {:?}", e))?;

    let media_class = env.find_class("android/provider/MediaStore$Images$Media")
        .map_err(|e| format!("Failed to find MediaStore class: {:?}", e))?;

    let content_uri = env.get_static_field(
        media_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;"
    ).map_err(|e| format!("Failed to get EXTERNAL_CONTENT_URI: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert URI: {:?}", e))?;

    let image_uri = env.call_static_method(
        &uri_class,
        "withAppendedId",
        "(Landroid/net/Uri;J)Landroid/net/Uri;",
        &[
            jni::objects::JValue::Object(&content_uri),
            jni::objects::JValue::Long(image_id),
        ],
    ).map_err(|e| format!("Failed to append id: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

    let size_class = env.find_class("android/util/Size")
        .map_err(|e| format!("Failed to find Size class: {:?}", e))?;
    let size_obj = env.new_object(
        &size_class,
        "(II)V",
        &[jni::objects::JValue::Int(256), jni::objects::JValue::Int(256)],
    ).map_err(|e| format!("Failed to create Size: {:?}", e))?;

    let thumbnail_result = env.call_method(
        &content_resolver,
        "loadThumbnail",
        "(Landroid/net/Uri;Landroid/util/Size;Landroid/os/CancellationSignal;)Landroid/graphics/Bitmap;",
        &[
            jni::objects::JValue::Object(&image_uri),
            jni::objects::JValue::Object(&size_obj),
            jni::objects::JValue::Object(&jni::objects::JObject::null()),
        ],
    );

    match thumbnail_result {
        Ok(bitmap_val) => {
            let bitmap = bitmap_val.l()
                .map_err(|e| format!("Failed to get bitmap: {:?}", e))?;

            if bitmap.is_null() {
                return Ok(None);
            }

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

            Ok(Some(cache_path.to_string_lossy().to_string()))
        }
        Err(_) => Ok(None),
    }
}
