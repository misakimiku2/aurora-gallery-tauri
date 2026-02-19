use base64::{engine::general_purpose, Engine as _};
use image::DynamicImage;
use jxl_oxide::JxlImage;
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};

pub static ACTIVE_HEAVY_DECODES: AtomicUsize = AtomicUsize::new(0);
pub const MAX_CONCURRENT_HEAVY_DECODES: usize = 3;

pub fn is_jxl(buffer: &[u8]) -> bool {
    if buffer.starts_with(&[0xFF, 0x0A]) {
        return true;
    }
    if buffer.len() >= 12 && (&buffer[0..12] == &[0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A] || &buffer[0..12] == b"\x00\x00\x00\x0cJXL \x0d\x0a\x87\x0a") {
        return true;
    }
    false
}

pub fn is_avif(buffer: &[u8]) -> bool {
    if buffer.len() >= 12 {
        let ftyp = &buffer[4..12];
        if ftyp == b"ftypavif" || ftyp == b"ftypavis" {
            return true;
        }
    }
    false
}

pub fn get_image_dimensions(path: &str) -> (u32, u32) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0),
    };

    use std::io::{Read, Seek, SeekFrom};
    let mut buffer = [0u8; 16];
    let n = file.read(&mut buffer).unwrap_or(0);
    let buf = &buffer[..n];
    let _ = file.seek(SeekFrom::Start(0));

    if is_jxl(buf) || path.to_lowercase().ends_with(".jxl") {
        if let Ok(jxl) = jxl_oxide::JxlImage::builder().open(path) {
            return (jxl.width(), jxl.height());
        }
    }

    if is_avif(buf) || path.to_lowercase().ends_with(".avif") {
        if let Ok(dim) = image::image_dimensions(path) {
            return dim;
        }
    }

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        imageinfo::ImageInfo::from_file(&mut file)
    }));
    
    match result {
        Ok(Ok(info)) => (info.size.width as u32, info.size.height as u32),
        Ok(Err(_)) => (0, 0),
        Err(_) => {
            eprintln!("[Warning] imageinfo panicked while processing: {}", path);
            (0, 0)
        }
    }
}

#[tauri::command]
pub async fn get_avif_preview(path: String) -> Result<String, String> {
    use std::fs;

    let result = tokio::task::spawn_blocking(move || {
        let content = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
        Ok(format!("data:image/avif;base64,{}", general_purpose::STANDARD.encode(content)))
    }).await.map_err(|e| e.to_string())?;
    
    result
}

#[tauri::command]
pub async fn get_jxl_preview(path: String) -> Result<String, String> {
    use fast_image_resize as fr;
    use std::num::NonZeroU32;

    while ACTIVE_HEAVY_DECODES.load(Ordering::Relaxed) >= MAX_CONCURRENT_HEAVY_DECODES {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    ACTIVE_HEAVY_DECODES.fetch_add(1, Ordering::SeqCst);

    let result = (async {
        let jxl_image = JxlImage::builder().open(&path).map_err(|e| format!("JXL error: {:?}", e))?;
        
        let render = jxl_image.render_frame(0).map_err(|e| format!("Render error: {:?}", e))?;
        let framebuffer = render.image_all_channels();
        
        let width = framebuffer.width() as u32;
        let height = framebuffer.height() as u32;
        let channels = framebuffer.channels();
        let buf = framebuffer.buf();
        
        let mut img = if channels == 3 {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, pixels).ok_or("Failed to create RgbImage")?)
        } else {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RgbaImage")?)
        };

        let max_dimension = 2560;
        if width > max_dimension || height > max_dimension {
            let (new_width, new_height) = if width > height {
                (max_dimension, (max_dimension as f32 * (height as f32 / width as f32)) as u32)
            } else {
                ((max_dimension as f32 * (width as f32 / height as f32)) as u32, max_dimension)
            };

            if let (Some(w_nz), Some(h_nz), Some(nw_nz), Some(nh_nz)) = (
                NonZeroU32::new(width), NonZeroU32::new(height),
                NonZeroU32::new(new_width), NonZeroU32::new(new_height)
            ) {
                let pixel_type = if channels == 3 { fr::PixelType::U8x3 } else { fr::PixelType::U8x4 };
                let src_pixels = if channels == 3 { img.to_rgb8().into_raw() } else { img.to_rgba8().into_raw() };
                let src_image = fr::Image::from_vec_u8(w_nz, h_nz, src_pixels, pixel_type).map_err(|e| e.to_string())?;
                let mut dst_image = fr::Image::new(nw_nz, nh_nz, pixel_type);
                let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
                resizer.resize(&src_image.view(), &mut dst_image.view_mut()).map_err(|e| e.to_string())?;
                
                let buffer = dst_image.buffer().to_vec();
                img = if channels == 3 {
                    match image::RgbImage::from_raw(new_width, new_height, buffer) {
                        Some(rgb_img) => DynamicImage::ImageRgb8(rgb_img),
                        None => return Err("Failed to create RGB image from resized buffer".to_string()),
                    }
                } else {
                    match image::RgbaImage::from_raw(new_width, new_height, buffer) {
                        Some(rgba_img) => DynamicImage::ImageRgba8(rgba_img),
                        None => return Err("Failed to create RGBA image from resized buffer".to_string()),
                    }
                };
            }
        }

        let mut buffer = Vec::new();
        img.write_to(&mut Cursor::new(&mut buffer), image::ImageFormat::WebP).map_err(|e| e.to_string())?;
        
        Ok(format!("data:image/webp;base64,{}", general_purpose::STANDARD.encode(buffer)))
    }).await;

    ACTIVE_HEAVY_DECODES.fetch_sub(1, Ordering::SeqCst);
    result
}
