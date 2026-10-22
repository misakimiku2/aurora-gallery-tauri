//! 解码：任意受支持格式 → RGBA8。
//!
//! 统一转 RGBA8 而不是保留原始色彩类型（灰度、16 位、带 ICC 的 CMYK 等），原因是
//! 编辑器的图层合成、混合模式与笔刷都按 RGBA8 建模（设计方案 §4.5 的 8 位边界）。
//! 十六位图会在这里降到 8 位，这是已登记的取舍，不是 bug。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use image::RgbaImage;

use super::ImageError;

/// 编辑器可导入的格式（扩展名小写、不含点）。
///
/// 只列库里真会有的：`image` 还能解 tga/pnm/hdr/dds/qoi，但那些既不进画廊也不进
/// `file_types::SUPPORTED_IMAGE_EXTENSIONS`，列进来只会让 UI 白开一个入口。
///
/// `tif` 与 `tiff` 两个写法都在表里——Phase 0 清理的旧账之一就是 `file_types` 曾经
/// 只认 `tiff` 而 `mime_for_extension` 认 `tif`，同一种格式两道门两种答案。
pub const EDITOR_DECODABLE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "tiff", "tif", "ico",
];

/// Phase 0 明确排除的格式（拍板依据见模块文档「格式口径」）。
///
/// 排除的是**编辑入口**，不是入库：这些格式的图在画廊里照常显示，只是拖不进画布。
pub const EDITOR_EXCLUDED_EXTENSIONS: &[&str] = &["avif", "svg", "jxl"];

/// 取小写扩展名（不含点）；无扩展名返回空串。
fn lowercase_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 从文件路径解码。
///
/// 先按扩展名拦一手排除格式，给出「编辑器不支持」这种能直接显示给用户的错误，而不是
/// 让 `image` 抛一句 `The image format could not be determined`。扩展名对不上但内容是
/// 有效图片的情况（改过后缀）仍然走内容探测，不因此失败。
///
/// 保留 `image` 的默认解码内存上限（512 MiB 分配）：画布来源是用户拖进来的任意文件，
/// 一张精心构造的 PNG 能解出几 GB，这是编辑器进程最容易被一击打死的入口。
pub fn decode_file(path: &str) -> Result<RgbaImage, ImageError> {
    let ext = lowercase_extension(path);
    if EDITOR_EXCLUDED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(ImageError::UnsupportedFormat(ext));
    }

    let file =
        File::open(path).map_err(|e| ImageError::Decode(format!("打开文件失败({path}): {e}")))?;
    let mut reader = image::io::Reader::new(BufReader::new(file));
    reader = reader
        .with_guessed_format()
        .map_err(|e| ImageError::Decode(format!("探测格式失败({path}): {e}")))?;
    reader
        .decode()
        .map(|dyn_img| dyn_img.to_rgba8())
        .map_err(|e| ImageError::Decode(format!("{path}: {e}")))
}

/// 从内存字节解码（拖拽上传、剪贴板、视频抽帧产物都走这里）。
///
/// 没有路径就拿不到扩展名，格式完全靠内容探测——所以排除格式在这里表现为普通的解码
/// 失败（`image` 认不出 avif/svg/jxl 的格式），错误文案不如 [`decode_file`] 精确。
/// 需要精确文案的调用方先拿路径问 [`is_excluded_extension`]。
pub fn decode_bytes(bytes: &[u8]) -> Result<RgbaImage, ImageError> {
    if bytes.is_empty() {
        return Err(ImageError::Decode("空数据".to_string()));
    }
    image::load_from_memory(bytes)
        .map(|dyn_img| dyn_img.to_rgba8())
        .map_err(|e| ImageError::Decode(e.to_string()))
}

/// 该扩展名是否属 Phase 0 排除清单（供调用方在只有路径时给精确提示）。
pub fn is_excluded_extension(ext: &str) -> bool {
    EDITOR_EXCLUDED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}
