//! 轻量非破坏图片调整（设计文档 docs/superpowers/specs/2026-11-13-lightweight-image-adjust-design.md）。
//!
//! 本文件是 `AdjustParams` 契约与几何/影调数学的**权威参考实现**；前端
//! `src/utils/adjustFilter.ts` 的 SVG 滤镜链与 Canvas 预览逐项对齐这里的公式，
//! 两端一致性由本文件单测 + 前端 vitest 钉住。
//!
//! 钉死的约定（改任何一条都要同步前端并跑两端测试）：
//! - 应用顺序：EXIF 方向 → flipH/flipV → rotate90×n（顺时针）→ 拉直 → 裁剪 → 影调 → 编码；
//! - 影调顺序：亮度 → 对比度 → 饱和度 → 色温 → 色调，**每步后 clamp 到 [0,1]**
//!   （与 SVG 滤镜逐原语 clamp 语义一致，见 adjustFilter.ts 注释）；
//! - luma 系数用 Rec709 (0.213, 0.715, 0.072)——与 SVG `feColorMatrix type="saturate"` 完全一致；
//! - 拉直：正角度 = 图像内容**视觉逆时针**（前端 Canvas `ctx.rotate(-rad)` 同向），
//!   输出取与原图同长宽比的最大内接矩形，边缘复制填充（不露黑边）；
//! - `cropNorm` 基于几何矫正完成后的正向图归一化坐标；
//! - 原图字节永不修改：调整只落在 DB（core/src/db/file_edits.rs），烘焙仅产新文件。

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};

pub const LUMA: [f32; 3] = [0.213, 0.715, 0.072];

// ── 契约 ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AdjustParams {
    pub v: u32,
    pub geo: GeoParams,
    pub tone: ToneParams,
}

impl Default for AdjustParams {
    fn default() -> Self {
        AdjustParams { v: 1, geo: GeoParams::default(), tone: ToneParams::default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct GeoParams {
    /// 顺时针 90° 步数（0..3，sanitize 取模）。
    pub rotate90: u8,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 拉直角度，度；正 = 内容视觉逆时针；±15 封顶。
    pub straighten_deg: f32,
    /// 裁剪归一化坐标（几何矫正完成后的正向图坐标）；None = 未裁。
    pub crop_norm: Option<CropNorm>,
}

impl Default for GeoParams {
    fn default() -> Self {
        GeoParams { rotate90: 0, flip_h: false, flip_v: false, straighten_deg: 0.0, crop_norm: None }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CropNorm {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Default for CropNorm {
    fn default() -> Self {
        CropNorm { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ToneParams {
    /// -1..1，0 = 不调。每步后 clamp。
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    /// -1(冷)..1(暖)：R×(1+p·0.25)、B×(1-p·0.25)。
    pub temperature: f32,
    /// -1(绿)..1(品红)：G×(1-t·0.25)。
    pub tint: f32,
}

impl Default for ToneParams {
    fn default() -> Self {
        ToneParams { brightness: 0.0, contrast: 0.0, saturation: 0.0, temperature: 0.0, tint: 0.0 }
    }
}

impl ToneParams {
    pub fn is_default(&self) -> bool {
        *self == ToneParams::default()
    }
}

impl AdjustParams {
    pub fn parse(json: &str) -> Result<AdjustParams, String> {
        let mut p: AdjustParams =
            serde_json::from_str(json).map_err(|e| format!("AdjustParams 解析失败: {}", e))?;
        p.sanitize();
        Ok(p)
    }

    pub fn is_default(&self) -> bool {
        self.geo == GeoParams::default() && self.tone.is_default()
    }

    /// 字段收敛：rotate90 取模、角度/滑杆/裁剪坐标夹进合法区间。脏数据不炸管线。
    pub fn sanitize(&mut self) {
        self.geo.rotate90 %= 4;
        self.geo.straighten_deg = self.geo.straighten_deg.clamp(-15.0, 15.0);
        for v in [
            &mut self.tone.brightness,
            &mut self.tone.contrast,
            &mut self.tone.saturation,
            &mut self.tone.temperature,
            &mut self.tone.tint,
        ] {
            *v = v.clamp(-1.0, 1.0);
        }
        if let Some(c) = &mut self.geo.crop_norm {
            c.x = c.x.clamp(0.0, 1.0);
            c.y = c.y.clamp(0.0, 1.0);
            c.w = c.w.clamp(0.0, 1.0 - c.x).max(0.0);
            c.h = c.h.clamp(0.0, 1.0 - c.y).max(0.0);
            if c.w <= 0.0 || c.h <= 0.0 {
                self.geo.crop_norm = None;
            }
        }
    }
}

/// 有参数时的缩略图缓存键尾巴（与 cache_filename_for 拼接）：params JSON 内容哈希。
pub fn adjust_tag_for(params_json: &str) -> String {
    let hash = format!("{:x}", md5::compute(params_json.as_bytes()));
    format!("-a{}", &hash[..hash.len().min(10)])
}

// ── EXIF 方向 ───────────────────────────────────────────────────────────────

/// 把 EXIF Orientation (1..8) 展开为像素变换，输出「矫正后正立图」。
/// 5/7 = 转置/反转置（镜像水平 + 旋转 270/90 CW），单测用 2×2 非对称图钉死。
pub fn apply_exif_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.fliph().rotate270(),
        6 => img.rotate90(),
        7 => img.fliph().rotate90(),
        8 => img.rotate270(),
        _ => img,
    }
}

// ── 几何 ────────────────────────────────────────────────────────────────────

/// 几何链（不含 EXIF 方向——调用方在解码后先 `apply_exif_orientation`）。
/// 顺序钉死：flip → rotate90 → 拉直 → 裁剪。
pub fn apply_geo(img: DynamicImage, geo: &GeoParams) -> DynamicImage {
    let mut img = img;
    if geo.flip_h {
        img = img.fliph();
    }
    if geo.flip_v {
        img = img.flipv();
    }
    for _ in 0..(geo.rotate90 % 4) {
        img = img.rotate90();
    }
    if geo.straighten_deg.abs() > 0.01 {
        img = straighten_image(&img, geo.straighten_deg);
    }
    if let Some(c) = &geo.crop_norm {
        img = crop_by_norm(&img, c);
    }
    img
}

/// 拉直：内容绕中心旋转 `deg`（正 = 视觉逆时针），输出取**与原图同长宽比**的最大
/// 内接矩形（精确解），双线性采样 + 边缘复制（不露黑边）。
pub fn straighten_image(img: &DynamicImage, deg: f32) -> DynamicImage {
    if deg.abs() < 0.01 {
        return img.clone();
    }
    let (w, h) = (img.width() as f64, img.height() as f64);
    let theta = (deg as f64).to_radians();
    let sin = theta.sin().abs();
    let cos = theta.cos().abs();
    // 同长宽比最大内接矩形（精确解）：中心对称多边形的最大内接中心对称矩形必居中，
    // 半高 y 受四条约束（半宽 = k·y，k = 长/短 ≥1）：
    //   ① y ≤ (W/2)/(c·k + s)        ② y ≤ (W/2)/(c·k − s)（分母>0 才有效）
    //   ③ y ≤ (H/2)/(c + s·k)        ④ y ≤ (H/2)/(c − s·k)（分母>0 才有效）
    // （W=长边,H=短边;θ→0 退化为原尺寸,90° 方图/非方图均正确——近似公式在非方图会露角,
    //  2026-11-13 实测推导后改精确解,前端 inscribedRect 同步）
    let (wl, hl) = if w >= h { (w, h) } else { (h, w) };
    let k = wl / hl;
    let inf = f64::INFINITY;
    let cands = [
        (wl / 2.0) / (cos * k + sin),
        if cos * k > sin { (wl / 2.0) / (cos * k - sin) } else { inf },
        (hl / 2.0) / (cos + sin * k),
        if cos > sin * k { (hl / 2.0) / (cos - sin * k) } else { inf },
    ];
    let y = cands.iter().cloned().fold(inf, f64::min);
    let short2 = (2.0 * y).max(1.0);
    let long2 = k * short2;
    let (w2, h2) = if w >= h { (long2, short2) } else { (short2, long2) };
    let w2 = (w2 as u32).max(1);
    let h2 = (h2 as u32).max(1);

    let src = img.to_rgba8();
    let (sw, sh) = (src.width() as f64, src.height() as f64);
    let (cx, cy) = (sw / 2.0, sh / 2.0);
    let (cx2, cy2) = (w2 as f64 / 2.0, h2 as f64 / 2.0);
    let (cos_t, sin_t) = (theta.cos(), theta.sin());

    let mut out_buf = vec![0u8; (w2 as usize) * (h2 as usize) * 4];
    out_buf
        .par_chunks_exact_mut(4)
        .enumerate()
        .for_each(|(i, px)| {
            let ox = (i as u64 % w2 as u64) as f64 + 0.5;
            let oy = (i as u64 / w2 as u64) as f64 + 0.5;
            let dx = ox - cx2;
            let dy = oy - cy2;
            // 逆映射：输出点绕中心**视觉顺时针**转回源坐标（正角度=内容视觉逆时针）
            let sx = cos_t * dx - sin_t * dy + cx;
            let sy = sin_t * dx + cos_t * dy + cy;
            let sampled = sample_bilinear_clamped(&src, sx, sy);
            px.copy_from_slice(&sampled);
        });

    image::RgbaImage::from_raw(w2, h2, out_buf)
        .map(DynamicImage::ImageRgba8)
        .unwrap_or_else(|| img.clone())
}

/// 双线性采样，坐标夹到源图内（边缘复制，避免旋转露黑边）。
fn sample_bilinear_clamped(src: &image::RgbaImage, x: f64, y: f64) -> [u8; 4] {
    let (w, h) = (src.width() as f64, src.height() as f64);
    let x = x.clamp(0.0, w - 1.0);
    let y = y.clamp(0.0, h - 1.0);
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let x1 = ((x0 + 1) as f64).min(w - 1.0) as i64;
    let y1 = ((y0 + 1) as f64).min(h - 1.0) as i64;
    let fx = (x - x0 as f64) as f32;
    let fy = (y - y0 as f64) as f32;
    let get = |px: i64, py: i64| -> [f32; 4] {
        let p = src.get_pixel(px as u32, py as u32).0;
        [p[0] as f32, p[1] as f32, p[2] as f32, p[3] as f32]
    };
    let p00 = get(x0, y0);
    let p10 = get(x1, y0);
    let p01 = get(x0, y1);
    let p11 = get(x1, y1);
    let mut out = [0u8; 4];
    for c in 0..4 {
        let top = p00[c] + (p10[c] - p00[c]) * fx;
        let bot = p01[c] + (p11[c] - p01[c]) * fx;
        out[c] = (top + (bot - top) * fy).round().clamp(0.0, 255.0) as u8;
    }
    out
}

/// 归一化裁剪：坐标基于当前图（几何矫正完成后的正向图）。
pub fn crop_by_norm(img: &DynamicImage, c: &CropNorm) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let x = (c.x.clamp(0.0, 1.0) * w as f32).round() as u32;
    let y = (c.y.clamp(0.0, 1.0) * h as f32).round() as u32;
    let cw = ((c.w * w as f32).round() as u32)
        .clamp(1, w.saturating_sub(x))
        .max(1);
    let ch = ((c.h * h as f32).round() as u32)
        .clamp(1, h.saturating_sub(y))
        .max(1);
    img.crop_imm(x.min(w.saturating_sub(1)), y.min(h.saturating_sub(1)), cw, ch)
}

// ── 影调 ────────────────────────────────────────────────────────────────────

/// 单像素影调（权威公式，前端 SVG 滤镜逐项对齐）。顺序钉死，**每步后 clamp**。
pub fn apply_tone_rgb(rgb: &mut [f32; 3], t: &ToneParams) {
    // 亮度：v' = v × (1+p)  —— SVG feComponentTransfer linear slope=1+p intercept=0
    let b = 1.0 + t.brightness;
    for v in rgb.iter_mut() {
        *v = (*v * b).clamp(0.0, 1.0);
    }
    // 对比度：v' = (v-0.5)(1+p)+0.5 —— feComponentTransfer linear slope=1+p intercept=-0.5p
    let c = 1.0 + t.contrast;
    for v in rgb.iter_mut() {
        *v = ((*v - 0.5) * c + 0.5).clamp(0.0, 1.0);
    }
    // 饱和度：v' = lerp(gray, v, 1+p) —— feColorMatrix type="saturate" amount=1+p
    let s = 1.0 + t.saturation;
    let gray = LUMA.iter().zip(rgb.iter()).map(|(l, v)| l * v).sum::<f32>();
    for v in rgb.iter_mut() {
        *v = (gray + (*v - gray) * s).clamp(0.0, 1.0);
    }
    // 色温/色调：对角增益矩阵 —— feColorMatrix 自定义 values
    rgb[0] = (rgb[0] * (1.0 + t.temperature * 0.25)).clamp(0.0, 1.0);
    rgb[2] = (rgb[2] * (1.0 - t.temperature * 0.25)).clamp(0.0, 1.0);
    rgb[1] = (rgb[1] * (1.0 - t.tint * 0.25)).clamp(0.0, 1.0);
}

/// 全图影调。RGBA 通道处理（保留 alpha），rayon 并行；默认参数直接返回零拷贝。
pub fn apply_tone(img: DynamicImage, t: &ToneParams) -> DynamicImage {
    if t.is_default() {
        return img;
    }
    let mut buf = img.to_rgba8();
    let tone = t.clone();
    buf.par_chunks_exact_mut(4).for_each(|px| {
        let mut rgb = [
            px[0] as f32 / 255.0,
            px[1] as f32 / 255.0,
            px[2] as f32 / 255.0,
        ];
        apply_tone_rgb(&mut rgb, &tone);
        px[0] = (rgb[0] * 255.0).round().clamp(0.0, 255.0) as u8;
        px[1] = (rgb[1] * 255.0).round().clamp(0.0, 255.0) as u8;
        px[2] = (rgb[2] * 255.0).round().clamp(0.0, 255.0) as u8;
    });
    DynamicImage::ImageRgba8(buf)
}

// ── 渲染（缩略图联动与导出共用） ────────────────────────────────────────────

/// 解码 + EXIF 矫正 + 几何 + 影调。`bake_edits`（导出）与缩略图管线共用，
/// 保证「网格所见 = 导出所得」。
pub fn render_adjusted(src_path: &str, params: &AdjustParams) -> Result<DynamicImage, String> {
    let img = decode_image(src_path)?;
    let orient = crate::image_utils::get_exif_orientation(src_path);
    let img = apply_exif_orientation(img, orient);
    let img = apply_geo(img, &params.geo);
    Ok(apply_tone(img, &params.tone))
}

fn decode_image(path: &str) -> Result<DynamicImage, String> {
    let mut reader = image::io::Reader::open(path)
        .map_err(|e| format!("打开失败 {}: {}", path, e))?
        .with_guessed_format()
        .map_err(|e| format!("识别格式失败 {}: {}", path, e))?;
    reader.no_limits();
    reader
        .decode()
        .map_err(|e| format!("解码失败 {}: {}（AVIF/JXL 暂不支持导出）", path, e))
}

/// 编码为导出字节。返回 (bytes, 扩展名, 宽, 高)。
pub fn encode_dynamic(img: &DynamicImage, format: &str, quality: u8) -> Result<(Vec<u8>, &'static str, u32, u32), String> {
    let (w, h) = (img.width(), img.height());
    match format.to_lowercase().as_str() {
        "png" => {
            let mut cursor = Cursor::new(Vec::new());
            img.write_to(&mut cursor, ImageFormat::Png)
                .map_err(|e| format!("PNG 编码失败: {}", e))?;
            Ok((cursor.into_inner(), "png", w, h))
        }
        "jpeg" | "jpg" => {
            let rgb = img.to_rgb8();
            let mut cursor = Cursor::new(Vec::new());
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality.clamp(1, 100));
            encoder
                .encode(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
                .map_err(|e| format!("JPEG 编码失败: {}", e))?;
            Ok((cursor.into_inner(), "jpg", w, h))
        }
        other => Err(format!("不支持的导出格式: {}（一期支持 png/jpeg）", other)),
    }
}

/// 导出路径：同目录 `<原名>-edited[.N].<ext>`，重名递增序号。
fn next_export_path(src_path: &str, ext: &str) -> PathBuf {
    let src = Path::new(src_path);
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let mut candidate = dir.join(format!("{}-edited.{}", stem, ext));
    let mut n = 2;
    while candidate.exists() && n < 100 {
        candidate = dir.join(format!("{}-edited-{}.{}", stem, n, ext));
        n += 1;
    }
    candidate
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BakeOutcome {
    pub out_path: String,
    pub file_id: String,
    pub width: u32,
    pub height: u32,
}

/// 导出/另存（设计 §9）：烘焙参数为像素并写**新文件**，原图与参数不动。
/// 写盘后按 write_file_bytes_indexed 同款口径入 file_index（含显示宽高），并
/// 发 `metadata-updated` 让网格即时可见。
#[tauri::command]
pub async fn bake_edits(
    app: tauri::AppHandle,
    src_path: String,
    params_json: String,
    format: Option<String>,
    quality: Option<u8>,
    max_width: Option<u32>,
) -> Result<BakeOutcome, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        bake_sync(&app, &src_path, &params_json, format.as_deref(), quality, max_width)
    })
    .await
    .map_err(|e| format!("烘焙任务失败: {}", e))?;
    result
}

fn bake_sync(
    app: &tauri::AppHandle,
    src_path: &str,
    params_json: &str,
    format: Option<&str>,
    quality: Option<u8>,
    max_width: Option<u32>,
) -> Result<BakeOutcome, String> {
    use aurora_core::db::file_index::FileIndexEntry;
    use aurora_core::db::{normalize_path, generate_id, AppDbPool};
    use tauri::Manager;

    let params = AdjustParams::parse(params_json)?;
    if !Path::new(src_path).exists() {
        return Err(format!("源文件不存在: {}", src_path));
    }

    let img = render_adjusted(src_path, &params)?;
    // 导出尺寸控制：只缩不放（显式算目标高，避免 u32::MAX 溢出口径）
    let img = match max_width {
        Some(mw) if mw > 0 && img.width() > mw => {
            let nh = ((img.height() as f64 * (mw as f64 / img.width() as f64)).ceil() as u32).max(1);
            img.resize_exact(mw, nh, image::imageops::FilterType::Triangle)
        }
        _ => img,
    };

    let fmt = format.unwrap_or("jpeg");
    let (bytes, ext, out_w, out_h) = encode_dynamic(&img, fmt, quality.unwrap_or(90))?;

    let out_path = next_export_path(src_path, ext);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {}", e))?;
    }
    // 写盘（三次重试，与 write_file_bytes_indexed 同口径）
    let mut last_err = None;
    for _ in 0..3 {
        match std::fs::write(&out_path, &bytes) {
            Ok(_) => {
                last_err = None;
                break;
            }
            Err(e) => last_err = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if let Some(e) = last_err {
        return Err(format!("写出失败 {}: {}", out_path.display(), e));
    }

    // 入索引（含显示宽高，网格立即可见；烘焙产物无 EXIF 方向，orientation 留空）
    let app_db = app.state::<AppDbPool>().inner().clone();
    let normalized = normalize_path(out_path.to_str().unwrap_or(""));
    let parent_dir = out_path.parent().map(|p| p.to_str().unwrap_or("")).unwrap_or("");
    let entry = FileIndexEntry {
        file_id: generate_id(&normalized),
        parent_id: Some(generate_id(&normalize_path(parent_dir))),
        path: normalized.clone(),
        name: out_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        file_type: "Image".to_string(),
        size: bytes.len() as u64,
        width: Some(out_w),
        height: Some(out_h),
        format: Some(ext.to_string()),
        duration_ms: None,
        frame_rate: None,
        rotation: None,
        video_codec: None,
        bit_rate: None,
        orientation: None,
        created_at: chrono::Utc::now().timestamp(),
        modified_at: chrono::Utc::now().timestamp(),
    };
    {
        let mut conn = app_db.get_connection();
        aurora_core::db::file_index::batch_upsert(&mut conn, &[entry.clone()])
            .map_err(|e| format!("入索引失败: {}", e))?;
    }
    use tauri::Emitter;
    let _ = app.emit("metadata-updated", &[entry.clone()]);

    Ok(BakeOutcome {
        out_path: out_path.to_str().unwrap_or("").to_string(),
        file_id: entry.file_id.clone(),
        width: out_w,
        height: out_h,
    })
}

// ── 测试 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    /// 2×2 非对称测试图：A B / C D
    fn abcd() -> DynamicImage {
        DynamicImage::ImageRgba8(ImageBuffer::from_fn(2, 2, |x, y| match (x, y) {
            (0, 0) => Rgba([255, 0, 0, 255]),   // A 红
            (1, 0) => Rgba([0, 255, 0, 255]),   // B 绿
            (0, 1) => Rgba([0, 0, 255, 255]),   // C 蓝
            _ => Rgba([255, 255, 0, 255]),      // D 黄
        }))
    }

    fn pixels(img: &DynamicImage) -> Vec<[u8; 4]> {
        img.to_rgba8().pixels().map(|p| p.0).collect()
    }

    #[test]
    fn tone_brightness_clamps_and_contrast_centers() {
        let mut t = ToneParams::default();
        // 0.6 + 亮度 1（×2）→ 1.2 → 顶到 1（clamp 后回落不回来：与 SVG 逐原语 clamp 语义一致）
        let mut rgb = [0.6, 0.6, 0.6];
        t.brightness = 1.0;
        apply_tone_rgb(&mut rgb, &t);
        assert_eq!(rgb, [1.0, 1.0, 1.0]);
        // 纯黑乘亮度仍是黑（线性乘的物理含义）
        let mut rgb = [0.0, 0.0, 0.0];
        apply_tone_rgb(&mut rgb, &t);
        assert_eq!(rgb, [0.0, 0.0, 0.0]);
        // 中灰不动（对比度围绕 0.5）
        let mut rgb = [0.5, 0.5, 0.5];
        t.brightness = 0.0;
        t.contrast = 0.8;
        apply_tone_rgb(&mut rgb, &t);
        assert!((rgb[0] - 0.5).abs() < 1e-6);
        // 对比度 -1 → 全部压到 0.5
        t.contrast = -1.0;
        let mut rgb = [0.2, 0.7, 0.4];
        apply_tone_rgb(&mut rgb, &t);
        assert_eq!(rgb, [0.5, 0.5, 0.5]);
    }

    #[test]
    fn tone_saturation_uses_rec709_luma_and_matches_svg() {
        let mut t = ToneParams::default();
        t.saturation = -1.0; // s = 0 → 全变 luma
        let mut rgb = [1.0, 0.0, 0.0];
        apply_tone_rgb(&mut rgb, &t);
        let expected = LUMA[0];
        assert!((rgb[0] - expected).abs() < 1e-6, "纯红去饱和 = R 通道 luma 系数");
        assert!((rgb[1] - expected).abs() < 1e-6);
        // 饱和度 0（s=1）不变
        t.saturation = 0.0;
        let mut rgb = [1.0, 0.0, 0.0];
        apply_tone_rgb(&mut rgb, &t);
        assert_eq!(rgb, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn tone_temperature_warm_and_tint() {
        let mut t = ToneParams::default();
        t.temperature = 1.0; // 暖：R×1.25 B×0.75
        t.tint = -1.0; // 绿：G×1.25
        let mut rgb = [1.0, 1.0, 1.0];
        apply_tone_rgb(&mut rgb, &t);
        assert_eq!(rgb, [1.0, 1.0, 0.75], "白点加暖后 R/G 顶格、B 下降");
    }

    #[test]
    fn exif_orientation_expansion_pinned() {
        // 2×2: A B / C D
        let img = abcd();
        // 2 镜像水平: B A / D C
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 2)), vec![
            [0, 255, 0, 255], [255, 0, 0, 255],
            [255, 255, 0, 255], [0, 0, 255, 255],
        ]);
        // 3 转 180: D C / B A
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 3)), vec![
            [255, 255, 0, 255], [0, 0, 255, 255],
            [0, 255, 0, 255], [255, 0, 0, 255],
        ]);
        // 6 顺时针 90: C A / D B
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 6)), vec![
            [0, 0, 255, 255], [255, 0, 0, 255],
            [255, 255, 0, 255], [0, 255, 0, 255],
        ]);
        // 5 = 镜像水平 + 旋转 270CW = 转置: A C / B D
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 5)), vec![
            [255, 0, 0, 255], [0, 0, 255, 255],
            [0, 255, 0, 255], [255, 255, 0, 255],
        ]);
        // 8 逆时针 90(=270CW): B D / A C
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 8)), vec![
            [0, 255, 0, 255], [255, 255, 0, 255],
            [255, 0, 0, 255], [0, 0, 255, 255],
        ]);
        // 1/0/非法: 原样
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 1)), pixels(&img));
        assert_eq!(pixels(&apply_exif_orientation(img.clone(), 99)), pixels(&img));
    }

    #[test]
    fn crop_norm_maps_top_left_quadrant() {
        // 100×100 亮度渐变图（值 = x），裁右下 1/4：cropNorm(0.5,0.5,0.5,0.5)
        let img = DynamicImage::ImageRgba8(ImageBuffer::from_fn(100, 100, |x, _| Rgba([x as u8, 0, 0, 255])));
        let out = crop_by_norm(&img, &CropNorm { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
        assert_eq!((out.width(), out.height()), (50, 50));
        let p = out.to_rgba8().get_pixel(0, 0).0;
        assert_eq!(p[0], 50, "输出(0,0) 应等于源(50,50)");
        let p = out.to_rgba8().get_pixel(49, 0).0;
        assert_eq!(p[0], 99);
    }

    #[test]
    fn straighten_identity_and_inscribed_dims() {
        let img = DynamicImage::ImageRgba8(ImageBuffer::from_fn(200, 100, |x, y| Rgba([(x % 255) as u8, (y % 255) as u8, 0, 255])));
        // 0° 恒等
        let out = straighten_image(&img, 0.0);
        assert_eq!((out.width(), out.height()), (200, 100));
        // 10°：内接矩形严格变小，长宽比保持 2:1
        let out = straighten_image(&img, 10.0);
        assert!(out.width() < 200 && out.height() < 100, "内接矩形必须小于原图");
        assert!((out.width() as f32 / out.height() as f32 - 2.0).abs() < 0.1, "同长宽比");
        // 中心像素≈源中心（旋转不动中心）
        let src = img.to_rgba8().get_pixel(100, 50).0;
        let dst = out.to_rgba8().get_pixel(out.width() / 2, out.height() / 2).0;
        assert!(
            dst.iter().zip(src.iter()).all(|(a, b)| a.abs_diff(*b) <= 3),
            "中心点采样应落在源中心附近"
        );
    }

    #[test]
    fn params_serde_camel_case_roundtrip_and_sanitize() {
        let json = r#"{
            "v": 1,
            "geo": {"rotate90": 7, "flipH": true, "flipV": false, "straightenDeg": 30.0,
                    "cropNorm": {"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.5}},
            "tone": {"brightness": 0.2, "contrast": -0.1, "saturation": 1.5,
                     "temperature": -0.3, "tint": 0.0}
        }"#;
        let p = AdjustParams::parse(json).expect("parse");
        // sanitize: rotate90 7→3, straighten 30→15, saturation 1.5→1
        assert_eq!(p.geo.rotate90, 3);
        assert!((p.geo.straighten_deg - 15.0).abs() < 1e-6);
        assert!((p.tone.saturation - 1.0).abs() < 1e-6);
        assert!(p.geo.flip_h);
        // 再序列化回来仍是 camelCase 且可解析
        let re = serde_json::to_string(&p).expect("serialize");
        assert!(re.contains("\"flipH\""), "serde camelCase: {}", re);
        assert!(re.contains("\"cropNorm\""));
        let p2 = AdjustParams::parse(&re).expect("reparse");
        assert_eq!(p, p2);
        // 全默认判定
        let d = AdjustParams::default();
        assert!(d.is_default());
        let mut d2 = AdjustParams::default();
        d2.tone.brightness = 0.001;
        assert!(!d2.is_default());
    }

    #[test]
    fn adjust_tag_stable_per_params() {
        let a = adjust_tag_for(r#"{"v":1}"#);
        let b = adjust_tag_for(r#"{"v":1}"#);
        let c = adjust_tag_for(r#"{"v":2}"#);
        assert_eq!(a, b, "同参数同 tag");
        assert_ne!(a, c, "异参数异 tag");
        assert!(a.starts_with("-a"));
        assert_eq!(a.len(), "-a".len() + 10);
    }

    #[test]
    fn encode_png_jpeg_roundtrip() {
        let img = abcd();
        let (bytes, ext, w, h) = encode_dynamic(&img, "png", 90).expect("png");
        assert_eq!(ext, "png");
        assert_eq!((w, h), (2, 2));
        let decoded = image::load_from_memory(&bytes).expect("decode png");
        assert_eq!(pixels(&decoded), pixels(&img), "PNG 无损");

        let (bytes, ext, w, h) = encode_dynamic(&img, "jpeg", 90).expect("jpeg");
        assert_eq!(ext, "jpg");
        assert_eq!((w, h), (2, 2));
        let decoded = image::load_from_memory(&bytes).expect("decode jpeg");
        // JPEG 有损，允许 ±16 容差
        for (a, b) in pixels(&decoded).iter().zip(pixels(&img).iter()) {
            for c in 0..3 {
                assert!(a[c].abs_diff(b[c]) <= 16, "JPEG 容差超标: {:?} vs {:?}", a, b);
            }
        }
        // 不支持的格式明确报错
        assert!(encode_dynamic(&img, "avif", 90).is_err());
    }

    #[test]
    fn render_adjusted_rotates_and_bakes_from_disk() {
        let dir = std::env::temp_dir().join(format!("aurora_adjust_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("src.png");
        let img = abcd();
        img.save(&path).expect("save png");

        let mut params = AdjustParams::default();
        params.geo.rotate90 = 1;
        let out = render_adjusted(path.to_str().unwrap(), &params).expect("render");
        assert_eq!((out.width(), out.height()), (2, 2));
        // 顺时针 90: C A / D B（与 exif_orientation 用例同表）
        assert_eq!(pixels(&out), vec![
            [0, 0, 255, 255], [255, 0, 0, 255],
            [255, 255, 0, 255], [0, 255, 0, 255],
        ]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_export_path_dedupes() {
        let dir = std::env::temp_dir().join(format!("aurora_export_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let src = dir.join("photo.jpg");
        std::fs::write(&src, b"x").expect("seed");
        let first = next_export_path(src.to_str().unwrap(), "jpg");
        assert!(first.ends_with("photo-edited.jpg"));
        std::fs::write(&first, b"x").expect("occupy");
        let second = next_export_path(src.to_str().unwrap(), "jpg");
        assert!(second.ends_with("photo-edited-2.jpg"), "重名递增: {:?}", second);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
