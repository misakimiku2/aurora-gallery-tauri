//! 图片编辑器（C11）的 Rust 侧命令。
//!
//! 设计依据：`docs/图片编辑与封面合成-设计方案.md` §3.1、`docs/图片编辑-最小图层模型设计.md`。
//!
//! ## 前端在"看"，Rust 在"算"
//!
//! - **显示**：画布直接渲染**原文件**（前端 `convertFileSrc` + 仿射矩阵），Rust 不参与。
//!   所以"前端永远看不到全分辨率像素"这句话在 v2 已不成立——§3.1 约束的是**处理**
//!   （不让像素进 JS 做运算、不让全分辨率字节过 IPC），不是显示。
//! - **计算**：解码、调色、仿射重采样、合成、编码全在 `aurora_core::imaging`。
//!   进出 WebView 的只有**图层代理图**（缩略图 / 超大图打底）与**导出产物字节**。
//!
//! ## 三个命令
//!
//! - `editor_load_layer_proxy`：一张图层的 ≤2048 JPEG + 自然尺寸 + **EXIF 方向**。
//!   前端拿它做缩略图，并用 `orientation` 把方向折进图层变换。
//! - `editor_render_document`：按文档状态合成一张预览（超大图打底用，尚未接线）。
//! - `editor_export_document`：全分辨率合成并写盘。
//!
//! v1 的三条旧命令（`editor_load_preview` / `editor_render_preview` /
//! `editor_export_image`）已随 S5 前端切换删除。
//! S5 落地时旧命令一并删除（`docs/图片编辑-最小图层模型设计.md` §8）。

use aurora_core::imaging::{self, AffineMatrix, CanvasBackground, CompositeLayer, EncodeFormat};
use base64::{engine::general_purpose, Engine as _};
use image::RgbaImage;
use serde::{Deserialize, Serialize};

/// 代理图最长边上限（设计方案 §3.1：代理图长边 ≤ 2048px）。
///
/// 2048 不是随手取的：状态栏要显示「当前看到的是代理还是全分辨率」，而 2048 在
/// 1440p 窗口下按 100% 显示时已接近 1:1，用户不会误判锐度；同时一张 6000×4000 的
/// 原图降到这个尺寸后内存占用从 ~96MB 掉到 ~12MB。
const PREVIEW_MAX_EDGE: u32 = 2048;

/// 代理图 JPEG 质量。
///
/// 90 是「看不出压缩痕迹」与「体积可接受」的平衡点：2048px 的复杂照片约 400–800KB，
/// base64 之后 0.5–1MB，单文档加载感知不到延迟。代理图本身**不是持久产物**（每次打开
/// 重新生成），所以不必为体积做更激进的压缩。
const PREVIEW_JPEG_QUALITY: u8 = 90;

/// 导出成品的 JPEG 质量。
///
/// 比代理图的 90 高一档：代理图是"看"的，导出是"留"的，多花几十 KB 换画质值得。
const EXPORT_JPEG_QUALITY: u8 = 92;

/// 导出结果（前端用来提示"导出到哪儿了、多大"）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorExportResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// 按扩展名决定编码格式。**不支持就报错，不猜**——`foo.avif` 静默写成 PNG
/// 会让用户拿到一个扩展名与内容不符的文件。
fn encode_format_from_path(target: &str) -> Result<EncodeFormat, String> {
    let ext = std::path::Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok(EncodeFormat::Png),
        "jpg" | "jpeg" => Ok(EncodeFormat::Jpeg),
        // 导出用无损 WebP：有损 WebP 需要 libwebp，而本项目刻意不引那份 C 依赖
        "webp" => Ok(EncodeFormat::WebpLossless),
        _ => Err(format!(
            "不支持的导出格式: .{ext}（支持 png / jpg / webp）"
        )),
    }
}

/// 调色请求。四个参数都是 `-100 ..= 100`，0 = 不变（与前端滑杆同一口径）。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct AdjustRequest {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
}

impl AdjustRequest {
    fn is_noop(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.temperature == 0.0
    }
}

/// 在全分辨率像素上应用调色。
///
/// 放在 **crop 之后、resize 之前**：裁剪先缩小处理面积，而在全分辨率上做乘加能让
/// clamp 更准（先缩放到代理尺寸再调色会把超界的高光提前压平）。
fn apply_adjustments(image: RgbaImage, adjust: Option<AdjustRequest>) -> RgbaImage {
    let Some(a) = adjust else { return image };
    if a.is_noop() {
        return image; // 全 0 时一个像素都不碰
    }
    // 前端用 -100..100，core 用 -1..1
    let matrix = imaging::ColorMatrix::from_adjustments(
        a.brightness / 100.0,
        a.contrast / 100.0,
        a.saturation / 100.0,
        a.temperature / 100.0,
    );
    imaging::apply_color_matrix(&image, &matrix)
}

// ============================================================================
// v2 · 最小图层模型（S4）
//
// 前端把「画布 + 图层（含仿射六参）」整份丢过来，Rust 只负责按同一组数做全分辨率合成。
// 六参由前端 `layerTransform.ts` 的 `composeMatrix` 算出，**两端共用同一组数**（设计稿
// §3.1），所以这里不接收 rotation / flip / scale 这类语义参数——避免再推导一次。
// ============================================================================

/// 画布请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRequest {
    pub width: u32,
    pub height: u32,
    /// `'transparent'`（默认） / `'white'` / `'black'`
    pub background: Option<String>,
}

/// 单个图层请求。
#[derive(Debug, Clone, Deserialize)]
pub struct LayerRequest {
    /// 源文件路径
    pub path: String,
    /// CSS 顺序的仿射六参 `[a,b,c,d,e,f]`
    pub matrix: [f64; 6],
    /// 调色（-100..100）；不传 = 不动
    pub adjust: Option<AdjustRequest>,
}

/// 整份文档（画布 + 自底向上的图层）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRequest {
    pub canvas: CanvasRequest,
    pub layers: Vec<LayerRequest>,
}

fn parse_background(raw: Option<&str>) -> CanvasBackground {
    match raw.unwrap_or("transparent").to_ascii_lowercase().as_str() {
        "white" => CanvasBackground::White,
        "black" => CanvasBackground::Black,
        _ => CanvasBackground::Transparent,
    }
}

/// 按文档状态合成出全分辨率 RGBA。
///
/// 顺序：**解码 → 调色 → 仿射重采样 → 合成到画布**。调色放在重采样之前，因为它
/// 与位置无关，先做能让后续重采样拿到最终颜色（顺序反过来在本项目里结果一致，
/// 但定死一处才不会有人"顺手优化"）。
fn composite_document(doc: &DocumentRequest) -> Result<RgbaImage, String> {
    let decoded: Vec<RgbaImage> = doc
        .layers
        .iter()
        .map(|l| imaging::decode_file(&l.path).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;

    let prepared: Vec<RgbaImage> = decoded
        .into_iter()
        .zip(doc.layers.iter())
        .map(|(img, l)| Ok(apply_adjustments(img, l.adjust)))
        .collect::<Result<_, String>>()?;

    let layers: Vec<CompositeLayer<'_>> = prepared
        .iter()
        .zip(doc.layers.iter())
        .map(|(img, l)| CompositeLayer { src: img, matrix: AffineMatrix::from_array(l.matrix) })
        .collect();

    imaging::composite(
        doc.canvas.width,
        doc.canvas.height,
        parse_background(doc.canvas.background.as_deref()),
        &layers,
    )
    .map_err(|e| e.to_string())
}

/// 单个图层的代理图（**不含任何变换**）。
///
/// 变换交给前端 CSS（预览）与本文件的仿射合成（导出），所以这张图是"没变换过"的那张——
/// 缓存键因此不必含变换，命中率不再被拖动打散（设计稿 §4.2）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerProxy {
    /// 源图自然尺寸（前端算定界框缩放比要用）
    pub natural_width: u32,
    pub natural_height: u32,
    /// EXIF 方向 1..=8（1 = 不用转）。
    ///
    /// 这个值必须由 Rust 给：浏览器显示 `<img>` 时会**自动**按 EXIF 转正，而
    /// `decode_file` 拿的是存储方向——两边不一致就是「屏幕正的、导出躺的」。
    /// 前端因此显式关掉浏览器的自动旋转（`imageOrientation: 'none'`），
    /// 把这里读到的角度一次性折进图层的 rotation/flip。
    pub orientation: u8,
    pub preview_width: u32,
    pub preview_height: u32,
    pub data_url: String,
}

/// 取一个图层的代理图：解码 → 调色 → 降采样，不套变换。
#[tauri::command]
pub async fn editor_load_layer_proxy(
    path: String,
    adjust: Option<AdjustRequest>,
) -> Result<LayerProxy, String> {
    tokio::task::spawn_blocking(move || {
        // 先读方向：它只看文件头 256KB，比解码整张图便宜得多
        let orientation = imaging::read_orientation(&path);
        let rgba = imaging::decode_file(&path).map_err(|e| e.to_string())?;
        let (natural_width, natural_height) = (rgba.width(), rgba.height());
        let image = apply_adjustments(rgba, adjust);

        let proxy = imaging::resize_to_max_edge(&image, PREVIEW_MAX_EDGE).map_err(|e| e.to_string())?;
        let (preview_width, preview_height) = (proxy.width(), proxy.height());
        let jpeg =
            imaging::encode(&proxy, EncodeFormat::Jpeg, PREVIEW_JPEG_QUALITY).map_err(|e| e.to_string())?;

        Ok(LayerProxy {
            natural_width,
            natural_height,
            orientation,
            preview_width,
            preview_height,
            data_url: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(&jpeg)
            ),
        })
    })
    .await
    .map_err(|e| format!("图层代理任务失败: {e}"))?
}

/// 整份文档的合成分辨率预览（供超大图打底、以及将来多图层合成用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRender {
    /// 画布尺寸
    pub width: u32,
    pub height: u32,
    pub preview_width: u32,
    pub preview_height: u32,
    pub data_url: String,
}

/// 按文档状态合成并降采样出预览图。
#[tauri::command]
pub async fn editor_render_document(doc: DocumentRequest) -> Result<DocumentRender, String> {
    tokio::task::spawn_blocking(move || {
        let canvas = composite_document(&doc)?;
        let (width, height) = (canvas.width(), canvas.height());
        let proxy = imaging::resize_to_max_edge(&canvas, PREVIEW_MAX_EDGE).map_err(|e| e.to_string())?;
        let (preview_width, preview_height) = (proxy.width(), proxy.height());
        let jpeg =
            imaging::encode(&proxy, EncodeFormat::Jpeg, PREVIEW_JPEG_QUALITY).map_err(|e| e.to_string())?;

        Ok(DocumentRender {
            width,
            height,
            preview_width,
            preview_height,
            data_url: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(&jpeg)
            ),
        })
    })
    .await
    .map_err(|e| format!("文档合成任务失败: {e}"))?
}

/// 把整份文档导出成一张图片（**全分辨率**，不受 2048 代理上限影响）。
///
/// 与预览走同一组仿射六参，所以"看到的就是导出的"。
#[tauri::command]
pub async fn editor_export_document(
    doc: DocumentRequest,
    target_path: String,
    quality: Option<u8>,
) -> Result<EditorExportResult, String> {
    tokio::task::spawn_blocking(move || {
        let image = composite_document(&doc)?;
        let format = encode_format_from_path(&target_path)?;
        let bytes = imaging::encode(&image, format, quality.unwrap_or(EXPORT_JPEG_QUALITY))
            .map_err(|e| e.to_string())?;

        std::fs::write(&target_path, &bytes)
            .map_err(|e| format!("写入失败({target_path}): {e}"))?;

        Ok(EditorExportResult {
            path: target_path,
            width: image.width(),
            height: image.height(),
            bytes: bytes.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}
