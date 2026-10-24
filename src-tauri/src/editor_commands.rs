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

/// 图层蒙版请求。`matrix` 有值 = **解链**（蒙版自己的画布空间矩阵）；
/// 缺省 / null = **链接**（蒙版拉伸铺满图层内容，与 CSS `mask-size: 100% 100%` 同口径）。
#[derive(Debug, Clone, Deserialize)]
pub struct MaskRequest {
    pub path: String,
    #[serde(default)]
    pub matrix: Option<[f64; 6]>,
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
    /// 图层蒙版（null = 无）。语义见 `imaging::mask`（蒙版值 = 亮度 × alpha）。
    #[serde(default)]
    pub mask: Option<MaskRequest>,
    /// 剪贴蒙版：只显示在同分段内下方基础层有像素处（吃基础层 alpha）。
    #[serde(default)]
    pub clipped: bool,
}

/// 一个**组**的分段（PS 的组语义）：成员先互相合成，组画布按组的 opacity/blend
/// 整体叠到底板。平层 = 单成员组（opacity 100 / blend normal）——前端
/// `splitSegments` 出口径，渲染（CSS 嵌套 div）与导出共用同一份分段。
#[derive(Debug, Clone, Deserialize)]
pub struct LayerGroupRequest {
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    #[serde(default)]
    pub blend: Option<String>,
    pub layers: Vec<LayerRequest>,
}

/// 整份文档（画布 + 自底向上的**分段**）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRequest {
    pub canvas: CanvasRequest,
    pub groups: Vec<LayerGroupRequest>,
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
/// 顺序：**解码 → 调色 → 不透明度 → 蒙版 → 仿射重采样 → 合成到画布**。调色、不透明度、
/// 蒙版都与位置无关（前两个动 RGB/alpha、蒙版动 alpha），先做完再重采样，让后续步骤
/// 拿到最终像素（顺序反过来在本项目里结果一致，但定死一处才不会有人"顺手优化"）。
/// 不透明度落成 alpha 缩放、蒙版落成 alpha 乘蒙版值，理由分别见 `imaging::opacity`
/// 与 `imaging::mask` 的文件头。
///
/// 蒙版解链（`mask.matrix` 有值）：把蒙版 warp 到**图层内容空间**
/// （`inv(M_layer)·M_mask`）后仍走同一条 `apply_mask_image` 乘法——与 CSS 包裹
/// 渲染（A 壳 + B 壳的逆矩阵换算）数学同构，两端不各推一次。
fn composite_document(doc: &DocumentRequest) -> Result<RgbaImage, String> {
    // 组员的解码图必须活到合成结束：先收进本层 Vec，再组装带生命周期的 CompositeGroup
    let mut decoded: Vec<RgbaImage> = Vec::new();
    let mut group_specs: Vec<(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)> =
        Vec::new();
    for g in &doc.groups {
        let mut members = Vec::new();
        for l in &g.layers {
            let mut img =
                apply_adjustments(imaging::decode_file(&l.path).map_err(|e| e.to_string())?, l.adjust);
            imaging::apply_opacity(&mut img, l.opacity.unwrap_or(100).min(100));
            // 蒙版失败让整份导出失败（而不是静默丢蒙版）：用户屏幕上看着有渐隐边缘，
            // 成品里却是硬边——那比报错糟糕得多
            if let Some(mask_req) = &l.mask {
                if !mask_req.path.is_empty() {
                    match mask_req.matrix {
                        None => imaging::apply_mask(&mut img, &mask_req.path).map_err(|e| e.to_string())?,
                        Some(mask_matrix) => {
                            let layer_matrix = AffineMatrix::from_array(l.matrix);
                            // 蒙版源 → 内容空间：inv(M_layer)·M_mask（CSS 的 B 壳换算）
                            let to_local = AffineMatrix::concat(
                                layer_matrix.invert().map_err(|e| e.to_string())?,
                                AffineMatrix::from_array(mask_matrix),
                            );
                            let mask_img = imaging::decode_file(&mask_req.path).map_err(|e| e.to_string())?;
                            let warped = imaging::warp_affine(
                                &mask_img,
                                img.width(),
                                img.height(),
                                to_local,
                                imaging::Sampling::Bilinear,
                            )
                            .map_err(|e| e.to_string())?;
                            imaging::apply_mask_image(&mut img, &warped);
                        }
                    }
                }
            }
            let idx = decoded.len();
            decoded.push(img);
            members.push((
                idx,
                AffineMatrix::from_array(l.matrix),
                l.blend.as_deref().map(BlendMode::parse).unwrap_or_default(),
                l.clipped,
            ));
        }
        group_specs.push((g.opacity.min(100), g.blend.as_deref().map(BlendMode::parse).unwrap_or_default(), members));
    }

    let groups: Vec<imaging::CompositeGroup<'_>> = group_specs
        .iter()
        .map(|(opacity, blend, members)| imaging::CompositeGroup {
            opacity: *opacity,
            blend: *blend,
            layers: members
                .iter()
                .map(|(idx, matrix, blend, clipped)| CompositeLayer {
                    src: &decoded[*idx],
                    matrix: *matrix,
                    blend: *blend,
                    clipped: *clipped,
                })
                .collect(),
        })
        .collect();

    imaging::composite_grouped(
        doc.canvas.width,
        doc.canvas.height,
        parse_background(doc.canvas.background.as_deref()),
        &groups,
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
    /// 锁像素 / 锁位置。老前端不带字段时按 false（未锁）处理。
    #[serde(default)]
    pub lock_pixel: bool,
    #[serde(default)]
    pub lock_position: bool,
    /// 条目类型："layer"（缺省）/ "group"（组行，source 为空串）
    #[serde(default)]
    pub layer_kind: String,
    #[serde(default)]
    pub group_id: Option<String>,
    /// 图层蒙版的源文件路径。空串 / 缺省 = 无蒙版（`images/` 里也就不存它的字节）。
    /// ⚠️ camelCase 键（`maskSource`）——本结构整体 `rename_all = "camelCase"`，
    /// 前端发 snake_case 会被静默丢掉（2026-10-24 前的 lock/group 字段就丢过，
    /// 见文件尾的 IPC 契约测试）。
    #[serde(default)]
    pub mask_source: String,
    /// 解链蒙版自己的定界框；缺省 / null = 链接（跟图层同框）
    #[serde(default)]
    pub mask_box: Option<ProjectBox>,
    /// 蒙版被停用（PS 的 Shift+点缩略图）：合成按无蒙版走，数据保留。缺省 false。
    /// ⚠️ camelCase 键（`maskDisabled`），与 maskSource 同一教训
    #[serde(default)]
    pub mask_disabled: bool,
    /// 剪贴蒙版（裁进下方最近的基础层）。缺省 false。
    #[serde(default)]
    pub clipped: bool,
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
                mask_source: l.mask_source,
                mask_box: l.mask_box,
                mask_disabled: l.mask_disabled,
                clipped: l.clipped,
                natural_width: l.natural_width,
                natural_height: l.natural_height,
                visible: l.visible,
                opacity: l.opacity,
                blend: l.blend,
                lock_pixel: l.lock_pixel,
                lock_position: l.lock_position,
                layer_kind: l.layer_kind,
                group_id: l.group_id,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// **IPC 键名契约**：前端 `buildSavePayload` 发什么键，这里就必须能读回什么。
    ///
    /// 背景（2026-10-24 修的存量 bug）：`ProjectLayerRequest` 整体挂着
    /// `rename_all = "camelCase"`，而前端曾按 snake_case 发 `lock_pixel` /
    /// `layer_kind` / `group_id`——serde 对未知键不报错、缺字段走 default，
    /// 锁定与编组**存盘后再打开无声丢失**。core 层的往返单测直接构造
    /// `SaveLayer`、不穿这层 IPC，所以一直是绿的。这条测试把前端实际发出的
    /// JSON 形状钉死在这里，两边谁改了键名当场红。
    #[test]
    fn project_save_request_reads_frontend_camel_case_keys() {
        let json = r#"{
            "name": "文档",
            "canvas": {"width": 100, "height": 80, "background": "white"},
            "activeLayerId": "l1",
            "layers": [{
                "id": "l1",
                "name": "底图",
                "source": "C:/pics/a.png",
                "naturalWidth": 100,
                "naturalHeight": 50,
                "visible": true,
                "opacity": 80,
                "blend": "multiply",
                "lockPixel": true,
                "lockPosition": false,
                "layerKind": "layer",
                "groupId": "g1",
                "maskSource": "C:/pics/mask.png",
                "maskBox": {"x": 1, "y": 1, "w": 60, "h": 30, "rotation": 0,
                             "flipH": false, "flipV": false, "skewX": 0, "skewY": 0},
                "maskDisabled": true,
                "clipped": true,
                "box": {"x": 1, "y": 2, "w": 100, "h": 50, "rotation": 0,
                         "flipH": false, "flipV": false, "skewX": 0, "skewY": 0},
                "adjust": {"brightness": 5, "contrast": 0, "saturation": 0, "temperature": 0}
            }]
        }"#;
        let req: ProjectSaveRequest = serde_json::from_str(json).expect("前端载荷必须可解析");
        let l = &req.layers[0];
        assert_eq!(l.lock_pixel, true);
        assert_eq!(l.lock_position, false);
        assert_eq!(l.layer_kind, "layer");
        assert_eq!(l.group_id.as_deref(), Some("g1"));
        assert_eq!(l.mask_source, "C:/pics/mask.png");
        assert_eq!(l.mask_box.as_ref().expect("解链框必须可读").w, 60.0);
        assert!(l.mask_disabled, "停用标志必须可读（camelCase：maskDisabled）");
        assert!(l.clipped, "剪贴标志必须可读");
        assert_eq!(l.blend, BlendMode::Multiply);
        assert_eq!(l.opacity, 80);
        // box → frame 的 rename 也在这一条里顺带锁住（§6 第 8 条的坑）
        assert_eq!(l.frame.w, 100.0);
    }

    /// 合成请求（导出 / 全览）的形状契约：前端 `buildRenderGroups` 发的是
    /// `groups` 分段（编组落地后的形状）。全览图一度还在发旧的 `layers` 平铺
    /// 形状，Rust 侧 `groups` 缺字段直接反序列化失败、错误又被前端 catch
    /// 吞掉——全览静默失效。这条把两端的形状钉在一起。
    #[test]
    fn document_request_reads_frontend_group_segments() {
        let json = r#"{
            "canvas": {"width": 10, "height": 10, "background": "transparent"},
            "groups": [{
                "opacity": 85,
                "blend": "screen",
                "layers": [{
                    "path": "C:/pics/a.png",
                    "matrix": [1, 0, 0, 1, 0, 0],
                    "adjust": null,
                    "opacity": 60,
                    "blend": "multiply",
                    "mask": {"path": "C:/pics/mask.png", "matrix": null},
                    "clipped": false
                }, {
                    "path": "C:/pics/b.png",
                    "matrix": [2, 0, 0, 2, 1, 1],
                    "adjust": null,
                    "opacity": 100,
                    "blend": "normal",
                    "mask": {"path": "C:/pics/mask2.png", "matrix": [1, 0, 0, 1, 3, 4]},
                    "clipped": true
                }]
            }]
        }"#;
        let doc: DocumentRequest = serde_json::from_str(json).expect("groups 分段必须可解析");
        assert_eq!(doc.groups.len(), 1);
        assert_eq!(doc.groups[0].opacity, 85);
        let l = &doc.groups[0].layers[0];
        assert_eq!(l.opacity, Some(60));
        assert_eq!(l.blend.as_deref(), Some("multiply"));
        // 链接蒙版：matrix 缺省 = null（Rust 走拉伸预乘路径）
        let m = l.mask.as_ref().expect("蒙版对象必须可读");
        assert_eq!(m.path, "C:/pics/mask.png");
        assert!(m.matrix.is_none(), "链接蒙版的 matrix 应为 null");
        assert!(!l.clipped);
        // 解链蒙版 + 剪贴
        let l2 = &doc.groups[0].layers[1];
        let m2 = l2.mask.as_ref().unwrap();
        assert_eq!(m2.matrix, Some([1.0, 0.0, 0.0, 1.0, 3.0, 4.0]));
        assert!(l2.clipped);

        // 旧的平铺形状必须被拒（缺 groups 字段）——静默兼容只会把形状漂移藏回去
        let legacy = r#"{
            "canvas": {"width": 10, "height": 10, "background": "transparent"},
            "layers": []
        }"#;
        assert!(serde_json::from_str::<DocumentRequest>(legacy).is_err());
    }
}
