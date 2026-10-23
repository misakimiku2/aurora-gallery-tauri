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
//!   进出 WebView 的只有**图层代理图**、**文档合成预览**，以及导出结果的元数据
//!   （路径 / 尺寸 / 字节数）——产物字节直接写盘，不过 IPC。
//!
//! ## 五条命令
//!
//! - `editor_load_layer_proxy`：一张图层的 ≤2048 JPEG + 自然尺寸 + **EXIF 方向**。
//!   前端拿它做缩略图，并用 `orientation` 把方向折进图层变换。
//! - `editor_render_document`：按文档状态合成一张预览（超大图打底用，尚未接线）。
//! - `editor_export_document`：全分辨率合成并写盘。
//! - `editor_save_project`：把文档存成 `.aurora` 工程（自包含 ZIP，写侧在 Rust）。
//! - `editor_open_project`：读 `.aurora`，图层图解到系统临时目录并回传路径。
//!
//! v1 的三条旧命令（`editor_load_preview` / `editor_render_preview` /
//! `editor_export_image`）已随 S5 前端切换删除。
//! S5 落地时旧命令一并删除（`docs/图片编辑-最小图层模型设计.md` §8）。

use aurora_core::editor_project::{self, ProjectAdjust, ProjectCanvas, ProjectBox};
use aurora_core::imaging::{
    self, AffineMatrix, BlendMode, CanvasBackground, CompositeLayer, EncodeFormat,
};
use base64::{engine::general_purpose, Engine as _};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 代理图最长边上限（设计方案 §3.1：代理图长边 ≤ 2048px）。
///
/// 2048 是体积与清晰度的平衡点：代理图只服务缩略图与超大图打底（画布直接显示原文件），
/// 2048 长边在常见窗口下已足够清楚；同时一张 6000×4000 的
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

/// 在**仿射重采样之前**对全分辨率图层执行调色。
///
/// 调色与位置无关，先算完颜色再交给 `warp_into`；全程不经过代理尺寸，clamp 直接
/// 作用在原始像素上（v2 导出路径里没有 crop / resize 这两步）。
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
    /// 不透明度百分比（0..=100）；不传 = 100（完全不透明）
    ///
    /// 混合模式（kebab-case：`multiply` / `color-dodge`…）。不传或认不出来 = `normal`。
    /// 名字与 CSS 的 `mix-blend-mode` 同名，前端预览直接交给 CSS，两端不用再翻译一次。
    #[serde(default)]
    pub blend: Option<String>,
    ///
    /// 用百分比而不是 0..1 的浮点：与 PS/前端滑杆同口径，JSON 里也是人能读的整数。
    /// 前端 `layerOpacity()` 出口径，两端的钳位规则一致。
    #[serde(default)]
    pub opacity: Option<u8>,
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
/// 顺序：**解码 → 调色 → 不透明度 → 仿射重采样 → 合成到画布**。调色与不透明度都与位置
/// 无关，先做能让后续重采样拿到最终像素（顺序反过来在本项目里结果一致，但定死一处才不会
/// 有人"顺手优化"）。不透明度落成 alpha 缩放，理由见 `imaging::opacity` 的文件头。
fn composite_document(doc: &DocumentRequest) -> Result<RgbaImage, String> {
    let decoded: Vec<RgbaImage> = doc
        .layers
        .iter()
        .map(|l| imaging::decode_file(&l.path).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;

    let prepared: Vec<RgbaImage> = decoded
        .into_iter()
        .zip(doc.layers.iter())
        .map(|(img, l)| {
            let mut img = apply_adjustments(img, l.adjust);
            imaging::apply_opacity(&mut img, l.opacity.unwrap_or(100).min(100));
            Ok(img)
        })
        .collect::<Result<_, String>>()?;

    let layers: Vec<CompositeLayer<'_>> = prepared
        .iter()
        .zip(doc.layers.iter())
        .map(|(img, l)| CompositeLayer {
            src: img,
            matrix: AffineMatrix::from_array(l.matrix),
            blend: l.blend.as_deref().map(BlendMode::parse).unwrap_or_default(),
        })
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

/// 整份文档的合成分辨率预览（供超大图打底与多图层合成预览；前端尚未接线）。
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

// ============================================================================
// 工程文件（.aurora）· 存与开
//
// 为什么写侧不放在前端：参考模式的 `serializeSessionToZip` 会把每张图层图
// `read_file_as_base64` 拉进 WebView 再交给 JSZip（设计方案 §4.4 已裁定编辑器不复用），
// 全分辨率字节过一遍 IPC + base64 多 1/3 体积，直接顶穿内存目标。这里只传参数与路径，
// 字节全程在 Rust 进程内流式搬运。
// ============================================================================

/// 待保存的图层。字段名与前端 `EditorLayer` 对齐，`box` 因 Rust 保留字改名。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayerRequest {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 源文件路径。空串 = 无源图（保存时跳过 `images/`，读侧会丢弃该层）
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub natural_width: u32,
    #[serde(default)]
    pub natural_height: u32,
    #[serde(default = "default_visible")]
    pub visible: bool,
    /// 不透明度百分比（0..=100）。前端老版本不带这个字段时按 100 处理。
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    /// 混合模式（kebab-case）。前端老版本不带这个字段时按 `normal` 处理。
    #[serde(default)]
    pub blend: BlendMode,
    #[serde(default, rename = "box")]
    pub frame: ProjectBox,
    #[serde(default)]
    pub adjust: Option<ProjectAdjust>,
}

fn default_visible() -> bool {
    true
}

fn default_opacity() -> u8 {
    100
}

/// 保存请求：整份文档的**语义参数**（定界框 + 调色），不含仿射矩阵。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveRequest {
    /// 文档名（写进 manifest.sessionName，Tab 标题也用它）
    #[serde(default)]
    pub name: String,
    pub canvas: ProjectCanvas,
    #[serde(default)]
    pub layers: Vec<ProjectLayerRequest>,
    #[serde(default)]
    pub active_layer_id: Option<String>,
}

/// 把整份文档存成 `.aurora`（自包含 ZIP）。
#[tauri::command]
pub async fn editor_save_project(
    doc: ProjectSaveRequest,
    target_path: String,
) -> Result<editor_project::SaveReport, String> {
    tokio::task::spawn_blocking(move || {
        let layers: Vec<editor_project::SaveLayer> = doc
            .layers
            .into_iter()
            .map(|l| editor_project::SaveLayer {
                id: l.id,
                name: l.name,
                source: l.source,
                natural_width: l.natural_width,
                natural_height: l.natural_height,
                visible: l.visible,
                opacity: l.opacity,
                blend: l.blend,
                frame: l.frame,
                adjust: l.adjust,
            })
            .collect();

        editor_project::save_project(
            std::path::Path::new(&target_path),
            &doc.name,
            &doc.canvas,
            &layers,
            doc.active_layer_id.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("保存任务失败: {e}"))?
}

/// 工程图缓存的落点：系统临时目录下一个**共享**目录（不按文档分）。
///
/// 共享的理由是文件名本身是内容哈希（`images/<md5>.<ext>`）：同一张底图在多个文档里
/// 只落一份，重开文档时大小一致就跳过解压。分目录反而会把这份收益抹掉。
fn project_cache_dir() -> PathBuf {
    std::env::temp_dir().join("aurora-editor-projects")
}

/// 清理 30 天没用过的解压缓存。最佳努力：任何错误都吞掉（缓存坏了最坏是重新解一次）。
///
/// TTL 取 30 天而不是 1 天：命中的缓存**不会**刷新 mtime（大小一致就跳过重写），
/// 所以"每天打开的老工程"在 7 天 TTL 下会被突然清掉，而那一刻它可能正开着。
/// 30 天足够让任何打开中的标签都不受影响。
fn prune_project_cache(dir: &std::path::Path) {
    const TTL: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        // 正在被查看的图会被 WebView2 持有句柄，删除失败——忽略即可
        if now.duration_since(modified).map(|d| d > TTL).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 打开一份 `.aurora` 工程，返回画布与图层（图层图已解到临时目录）。
#[tauri::command]
pub async fn editor_open_project(path: String) -> Result<editor_project::OpenedProject, String> {
    tokio::task::spawn_blocking(move || {
        let dir = project_cache_dir();
        prune_project_cache(&dir);
        editor_project::open_project(std::path::Path::new(&path), &dir)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("打开任务失败: {e}"))?
}
