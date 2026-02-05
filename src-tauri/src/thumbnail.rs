// Moved from main.rs — thumbnail generation, batch thumbnails and drag-preview
use serde::Serialize;
use std::path::Path;
use std::fs;
use std::io::{Read, BufWriter, BufReader};
use std::num::NonZeroU32;
use tauri;
use fast_image_resize as fr;
use image::codecs::jpeg::{JpegEncoder, JpegDecoder};
use image::ImageFormat;
use image;
use rayon::prelude::*;
use crate::color_extractor;

#[derive(Clone, Serialize)]
pub struct BatchResult {
    pub path: String,
    pub url: Option<String>,
}

// Core thumbnail generation (kept synchronous; invoked from spawn_blocking)
pub(crate) fn process_single_thumbnail(file_path: &str, cache_root: &Path) -> Option<String> {
    use std::io::BufWriter;

    let image_path = Path::new(file_path);
    if !image_path.exists() || file_path.contains(".Aurora_Cache") {
        return None;
    }

    // Quick hash
    let metadata = fs::metadata(image_path).ok()?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    let mut file = fs::File::open(image_path).ok()?;
    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer).unwrap_or(0);

    let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
    let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();

    let jpg_cache_file_path = cache_root.join(format!("{}.jpg", cache_filename));
    let webp_cache_file_path = cache_root.join(format!("{}.webp", cache_filename));

    if jpg_cache_file_path.exists() {
        return Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
    }
    if webp_cache_file_path.exists() {
        return Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
    }

    let file = fs::File::open(image_path).ok()?;
    let reader = BufReader::new(file);
    let format = image::guess_format(&buffer[..bytes_read]).unwrap_or(ImageFormat::Png);

    let img = if format == ImageFormat::Jpeg {
        let mut decoder = JpegDecoder::new(reader).ok()?;
        decoder.scale(256, 256).ok()?;
        image::DynamicImage::from_decoder(decoder).ok()?
    } else {
        let mut image_reader = image::io::Reader::new(reader);
        image_reader.set_format(format);
        image_reader.no_limits();
        image_reader.decode().ok()?
    };

    let width = img.width();
    let height = img.height();
    const TARGET_MIN_SIZE: u32 = 256;
    let (dst_width, dst_height) = if width < height {
        let ratio = height as f32 / width as f32;
        (TARGET_MIN_SIZE, (TARGET_MIN_SIZE as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((TARGET_MIN_SIZE as f32 * ratio) as u32, TARGET_MIN_SIZE)
    };

    let src_width = NonZeroU32::new(width)?;
    let src_height = NonZeroU32::new(height)?;
    let dst_width_nz = NonZeroU32::new(dst_width)?;
    let dst_height_nz = NonZeroU32::new(dst_height)?;

    // Optimization: Only use RGBA if the image format actually supports alpha
    // And check for actual transparency on the SMALL thumbnail to save time.
    if img.color().has_alpha() {
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgba8().into_raw(),
            fr::PixelType::U8x4,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        // Check transparency on the SMALL thumbnail buffer
        let pixels = dst_image.buffer();
        let has_actual_transparency = pixels.chunks_exact(4).any(|p| p[3] < 255);

        if !cache_root.exists() { let _ = fs::create_dir_all(cache_root); }

        if has_actual_transparency {
            let cache_file = fs::File::create(&webp_cache_file_path).ok()?;
            let mut writer = BufWriter::new(cache_file);
            let resized_img = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())?);
            resized_img.write_to(&mut writer, ImageFormat::WebP).ok()?;
            Some(webp_cache_file_path.to_str().unwrap_or_default().to_string())
        } else {
            // If no transparency was actually found, save as JPEG to save space
            let cache_file = fs::File::create(&jpg_cache_file_path).ok()?;
            let mut writer = BufWriter::new(cache_file);
            let mut encoder = JpegEncoder::new_with_quality(&mut writer, 80);
            
            // Convert RGBA to RGB for JPEG
            let rgb_buffer: Vec<u8> = pixels.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            encoder.encode(&rgb_buffer, dst_width, dst_height, image::ColorType::Rgb8.into()).ok()?;
            Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string())
        }
    } else {
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgb8().into_raw(),
            fr::PixelType::U8x3,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        if !cache_root.exists() { let _ = fs::create_dir_all(cache_root); }
        let cache_file = fs::File::create(&jpg_cache_file_path).ok()?;
        let mut writer = BufWriter::new(cache_file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, 80);
        encoder.encode(dst_image.buffer(), dst_width, dst_height, image::ColorType::Rgb8.into()).ok()?;
        Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string())
    }
}

#[derive(Clone, Serialize)]
pub struct ThumbnailBatchResult {
    pub path: String,
    pub url: Option<String>,
    pub colors: Option<Vec<color_extractor::ColorResult>>,
    pub from_cache: bool,
}

#[tauri::command]
pub async fn get_thumbnail(file_path: String, cache_root: String) -> Result<Option<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() { let _ = fs::create_dir_all(root); }
        process_single_thumbnail(&file_path, root)
    }).await;

    match result { Ok(val) => Ok(val), Err(e) => Err(e.to_string()) }
}

#[tauri::command]
pub async fn get_thumbnails_batch(
    file_paths: Vec<String>,
    cache_root: String,
    on_event: tauri::ipc::Channel<ThumbnailBatchResult>,
    _app: tauri::AppHandle
) -> Result<(), String> {
    let file_paths_clone2 = file_paths;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() { let _ = fs::create_dir_all(root); }

        file_paths_clone2.par_iter().for_each(|path| {
            use std::fs;
            use std::io::Read;

            let image_path = Path::new(path);
            if !image_path.exists() || path.contains(".Aurora_Cache") {
                let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url: None, colors: None, from_cache: false });
                return;
            }

            let metadata = match fs::metadata(image_path) { Ok(m) => m, Err(_) => { let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url: None, colors: None, from_cache: false }); return; } };
            let size = metadata.len();
            let modified = metadata.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0);

            let mut file = match fs::File::open(image_path) { Ok(f) => f, Err(_) => { let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url: None, colors: None, from_cache: false }); return; } };
            let mut buffer = [0u8; 4096];
            let bytes_read = file.read(&mut buffer).unwrap_or(0);

            let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
            let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();

            let jpg_cache_file_path = root.join(format!("{}.jpg", cache_filename));
            let webp_cache_file_path = root.join(format!("{}.webp", cache_filename));

            if jpg_cache_file_path.exists() {
                let url = Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url, colors: None, from_cache: true });
                return;
            }
            if webp_cache_file_path.exists() {
                let url = Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url, colors: None, from_cache: true });
                return;
            }

            let url = process_single_thumbnail(path, root);
            let _ = on_event.send(ThumbnailBatchResult { path: path.clone(), url, colors: None, from_cache: false });
        });
        Ok(())
    }).await;

    match result { Ok(val) => val, Err(e) => Err(e.to_string()) }
}

#[tauri::command]
pub async fn generate_drag_preview(
    thumbnail_paths: Vec<String>,
    total_count: usize,
    cache_root: String,
) -> Result<Option<String>, String> {
    use std::io::BufWriter;
    use image::{ImageBuffer, Rgba, RgbaImage, ImageEncoder};
    use image::imageops::{overlay, resize, FilterType};
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        // 预览图尺寸
        const PREVIEW_SIZE: u32 = 128;
        const THUMB_SIZE: u32 = 100;
        const BORDER_WIDTH: u32 = 2;
        
        // 创建透明背景
        let mut canvas: RgbaImage = ImageBuffer::from_pixel(
            PREVIEW_SIZE, 
            PREVIEW_SIZE, 
            Rgba([0, 0, 0, 0])
        );
        
        // 最多显示3个缩略图
        let preview_count = thumbnail_paths.len().min(3);
        
        // 加载并绘制每个缩略图（从后往前绘制，最后一个在最上面）
        for (i, thumb_path) in thumbnail_paths.iter().take(preview_count).enumerate().rev() {
            let thumb_path = Path::new(thumb_path);
            if !thumb_path.exists() {
                continue;
            }
            
            // 加载缩略图
            let img = match image::open(thumb_path) {
                Ok(img) => img,
                Err(_) => continue,
            };
            
            // 调整大小
            let thumb = resize(&img, THUMB_SIZE - BORDER_WIDTH * 2, THUMB_SIZE - BORDER_WIDTH * 2, FilterType::Triangle);
            
            // 创建带白色边框的缩略图
            let mut bordered: RgbaImage = ImageBuffer::from_pixel(
                THUMB_SIZE,
                THUMB_SIZE,
                Rgba([255, 255, 255, 230]) // 白色边框，略微透明
            );
            
            // 将缩略图放在边框中央
            overlay(&mut bordered, &thumb, BORDER_WIDTH as i64, BORDER_WIDTH as i64);
            
            // 计算位置偏移（堆叠效果）
            let offset_x = match i {
                0 => (PREVIEW_SIZE - THUMB_SIZE) / 2,
                1 => (PREVIEW_SIZE - THUMB_SIZE) / 2 - 8,
                _ => (PREVIEW_SIZE - THUMB_SIZE) / 2 + 8,
            };
            let offset_y = (PREVIEW_SIZE - THUMB_SIZE) / 2 + (i as u32) * 6;
            
            // 绘制到画布
            overlay(&mut canvas, &bordered, offset_x as i64, offset_y as i64);
        }
        
        // 如果有多个文件，添加计数徽章（总是显示，即使只有1个文件也显示）
        if total_count > 1 {
            // 绘制蓝色圆形徽章
            let badge_size = 28u32;
            let badge_x = PREVIEW_SIZE - badge_size - 4;
            let badge_y = PREVIEW_SIZE - badge_size - 4;
            
            // 绘制圆形背景
            for y in 0..badge_size {
                for x in 0..badge_size {
                    let dx = x as f32 - badge_size as f32 / 2.0;
                    let dy = y as f32 - badge_size as f32 / 2.0;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist <= badge_size as f32 / 2.0 {
                        let px = badge_x + x;
                        let py = badge_y + y;
                        if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                            canvas.put_pixel(px, py, Rgba([37, 99, 235, 255])); // 蓝色
                        }
                    }
                }
            }
            
            // 绘制数字
            let count_text = total_count.to_string();
            // 使用简单的位图字体绘制数字
            // 数字 0-9 的 5x7 位图
            let digit_bitmaps: [[[u8; 5]; 7]; 10] = [
                // 0
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 1
                [[0,0,1,0,0], [0,1,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,1,1,1,0]],
                // 2
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1]],
                // 3
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 4
                [[1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 5
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 6
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 7
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 8
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 9
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
            ];
            
            let digit_width = 5u32;
            let digit_height = 7u32;
            let spacing = 1u32;
            let total_text_width = (digit_width + spacing) * count_text.len() as u32 - spacing;
            let text_start_x = badge_x + (badge_size - total_text_width) / 2;
            let text_start_y = badge_y + (badge_size - digit_height) / 2;
            
            // 绘制每个数字
            for (char_idx, ch) in count_text.chars().enumerate() {
                if let Some(digit) = ch.to_digit(10) {
                    let digit_bitmap = &digit_bitmaps[digit as usize];
                    let digit_x = text_start_x + (digit_width + spacing) * char_idx as u32;
                    
                    for (row_idx, row) in digit_bitmap.iter().enumerate() {
                        for (col_idx, &pixel) in row.iter().enumerate() {
                            if pixel == 1 {
                                let px = digit_x + col_idx as u32;
                                let py = text_start_y + row_idx as u32;
                                if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                                    canvas.put_pixel(px, py, Rgba([255, 255, 255, 255])); // 白色
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // 保存预览图到缓存目录
        let cache_path = Path::new(&cache_root);
        if !cache_path.exists() {
            let _ = fs::create_dir_all(cache_path);
        }
        
        let preview_file = cache_path.join("_drag_preview.png");
        
        let file = match fs::File::create(&preview_file) {
            Ok(f) => f,
            Err(_) => return None,
        };
        let writer = BufWriter::new(file);
        
        let encoder = image::codecs::png::PngEncoder::new(writer);
        match encoder.write_image(
            canvas.as_raw(),
            PREVIEW_SIZE,
            PREVIEW_SIZE,
            image::ColorType::Rgba8,
        ) {
            Ok(_) => Some(preview_file.to_str().unwrap_or_default().to_string()),
            Err(_) => None,
        }
    }).await;

    match result { Ok(val) => Ok(val), Err(e) => Err(e.to_string()) }
}
