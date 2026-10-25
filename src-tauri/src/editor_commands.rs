//! 图片编辑器（C11）的 Rust 侧命令。
//!
//! 设计依据：`docs/图片编辑与封面合成-设计方案.md` §3.1、`docs/图片编辑-最小图层模型设计.md`、
//! `docs/编辑器管线换血-阶段1设计.md`。
//!
//! ## 前端在"看"，Rust 在"算"
//!
//! - **显示**：画布直接渲染**原文件**（前端 `convertFileSrc` + 仿射矩阵），Rust 不参与。
//!   管线换血阶段 1 之后，这一条由 engine 帧输出逐步接管（M3），命令层不变。
//! - **计算**：解码、调色、仿射重采样、合成、编码的**编排**在 `editor-engine`
//!   （2026-10-26 自本文件迁入，parity 测试逐字节一致）；原语在 `aurora_core::imaging`。
//!   进出 WebView 的只有**图层代理图**、**文档合成预览**，以及导出结果的元数据
//!   （路径 / 尺寸 / 字节数）——产物字节直接写盘，不过 IPC。
//!
//! ## 命令
//!
//! - `editor_load_layer_proxy`：一张图层的 ≤2048 JPEG + 自然尺寸 + **EXIF 方向**。
//!   前端拿它做缩略图，并用 `orientation` 把方向折进图层变换。
//! - `editor_render_document`：按文档状态合成一张预览（全览图接线；超大图打底未接）。
//! - `editor_export_document`：全分辨率合成并写盘。
//! - `editor_save_project`：把文档存成 `.aurora` 工程（自包含 ZIP，写侧在 Rust）。
//! - `editor_open_project`：读 `.aurora`，图层图解到系统临时目录并回传路径。
//!
//! 合成载荷结构体（`DocumentRequest` 一族）与 `apply_adjustments` 已迁到
//! `editor-engine::payload`，这里 re-export 维持既有 `use super::*` 的引用面
//! （IPC 契约测试照旧钉住 serde 形状）。

use aurora_core::editor_project::{self, ProjectAdjust, ProjectCanvas, ProjectBox};
use aurora_core::imaging::{self, BlendMode, EncodeFormat};
use base64::{engine::general_purpose, Engine as _};
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

// 合成载荷与调色：2026-10-26 管线换血阶段 1 迁入 `editor-engine::payload`
// （serde 形状一字未动，IPC 契约测试继续钉住）。这里 re-export 维持引用面。
pub use editor_engine::payload::{
    apply_adjustments, AdjustRequest, CanvasRequest, DocumentRequest, LayerGroupRequest,
    LayerRequest, MaskRequest,
};

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
        // 命令级临时 composer：M1 与旧行为等价（无跨调用状态）；M2 起 per-tab 常驻
        let mut composer = editor_engine::DocumentComposer::new();
        let canvas = editor_engine::composite_document(&mut composer, &doc)?;
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
        let mut composer = editor_engine::DocumentComposer::new();
        let image = editor_engine::composite_document(&mut composer, &doc)?;
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
// 管线换血 M2 · 帧输出（设计稿 §5 的 A/B 两档；C 档脏区随 M3 画笔接缝一起上）
// ============================================================================

/// settle 帧的落点：临时目录下独立目录，30 天 TTL 与工程/画笔缓存同口径。
fn frames_dir() -> PathBuf {
    std::env::temp_dir().join("aurora-editor-frames")
}

/// A 档 settle 帧（文档分辨率，M3 显示切换后的"静置真相"）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleFrame {
    /// 帧文件的绝对路径（前端 `convertFileSrc` 显示，字节不进 JS）
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// `"png"`（透明底文档）或 `"jpg"`
    pub format: String,
}

/// A 档同步内核（命令的 spawn_blocking 里跑；test 直接调）。
fn render_settle_frame_blocking(doc: DocumentRequest) -> Result<SettleFrame, String> {
    let mut composer = editor_engine::DocumentComposer::new();
    let image = editor_engine::composite_document(&mut composer, &doc)?;
    settle_frame_from_image(image)
}

/// A 档：合成文档分辨率整帧 → 按透明度分流编码（JPEG 无 alpha，透明底走 PNG）→
/// **内容哈希做文件名**落盘（同帧重渲染复用现有文件，WebView 图片缓存 + 磁盘双命中）。
/// 低频事件（交互结束/结构变化），24MP 编码几百 ms 可接受；合成与导出同一条
/// engine 路径——"看到的就是导出的"由 parity 测试在源头锁住。
#[tauri::command]
pub async fn editor_render_document_frame(doc: DocumentRequest) -> Result<SettleFrame, String> {
    tokio::task::spawn_blocking(move || render_settle_frame_blocking(doc))
        .await
        .map_err(|e| format!("settle 帧任务失败: {e}"))?
}

/// B 档视口帧槽：合成端**覆盖写**、fetch 端拿当下最新——没有队列就没有积压，
/// 前端拉取慢于合成时自然跳帧（设计稿 §5：交互帧要"永远最新"，这正是自定义协议
/// 相对 Channel 的决定性优势）。Arc 内核让命令能把克隆塞进 spawn_blocking。
#[derive(Default, Clone)]
pub struct ViewportFrameSlot(pub std::sync::Arc<std::sync::Mutex<ViewportSlotInner>>);

#[derive(Default)]
pub struct ViewportSlotInner {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Option<std::sync::Arc<Vec<u8>>>,
}

/// 覆盖式写槽（命令与测试共用）：seq 单调递增，旧帧立即被替换。
fn store_viewport_frame(slot: &ViewportFrameSlot, img: image::RgbaImage) -> u64 {
    let (w, h) = (img.width(), img.height());
    let rgba = std::sync::Arc::new(img.into_raw());
    let mut inner = slot.0.lock().expect("帧槽锁不会中毒：闭包内无 panic 点");
    inner.seq += 1;
    inner.width = w;
    inner.height = h;
    inner.rgba = Some(rgba);
    inner.seq
}

/// B 档同步内核（命令的 spawn_blocking 里跑）。
fn render_viewport_blocking(
    slot: &ViewportFrameSlot,
    doc: DocumentRequest,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    scale: Option<f64>,
) -> Result<u64, String> {
    let mut composer = editor_engine::DocumentComposer::new();
    let img = editor_engine::composite_region(
        &mut composer,
        &doc,
        editor_engine::Region { x, y, width, height, scale: scale.unwrap_or(1.0) },
    )?;
    Ok(store_viewport_frame(slot, img))
}

/// B 档：只合成视口区域（`composite_region`，与全量渲染 parity 逐位一致），
/// 写进最新帧槽，返回本次序号。前端 rAF 节流拉取 `editor-frame://viewport`，
/// 用返回的 seq 与响应头里的 seq 比对判断是否拿到新帧。
#[tauri::command]
pub async fn editor_render_viewport(
    doc: DocumentRequest,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    scale: Option<f64>,
    slot: tauri::State<'_, ViewportFrameSlot>,
) -> Result<u64, String> {
    // Arc 克隆进闭包（State 的借用活不过 spawn_blocking）
    let slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || render_viewport_blocking(&slot, doc, x, y, width, height, scale))
        .await
        .map_err(|e| format!("视口帧任务失败: {e}"))?
}

/// 协议取帧端（lib.rs 的 editor-frame handler 调用；测试直接驱动）：
/// 返回 (http_status, body)，body = 16B LE 头（magic "ARFD" + seq + w + h）+ RGBA。
/// 元数据嵌在字节流里而不是单独一条消息——拆两条要自己解决"流对齐"，不值得。
pub fn viewport_frame_body(slot: &ViewportFrameSlot) -> (u16, Vec<u8>) {
    let Ok(inner) = slot.0.lock() else {
        return (503, b"slot poisoned".to_vec());
    };
    let Some(rgba) = inner.rgba.clone() else {
        return (404, b"empty".to_vec());
    };
    let (seq, w, h) = (inner.seq, inner.width, inner.height);
    drop(inner);
    let mut body = Vec::with_capacity(16 + rgba.len());
    body.extend_from_slice(b"ARFD");
    // seq 截成 u32：16B 定长头是线格式契约（消费端按 4/8/12 偏移解 w/h）；序号
    // 只用于"拿到的是不是新帧"的相等比较，4G 帧后才回绕，无所谓。
    body.extend_from_slice(&(seq as u32).to_le_bytes());
    body.extend_from_slice(&w.to_le_bytes());
    body.extend_from_slice(&h.to_le_bytes());
    body.extend_from_slice(&rgba);
    (200, body)
}

// ============================================================================
// 管线换血 M3 · 有状态文档引擎（D6 画笔接缝的 Rust 半边，设计稿 §4/§6）
//
// engine 按 tabId 持有像素仓（前端位图仓上传进来）+ prep 缓存；显示命令从
// engine 出帧而不是每次从文件重算——画笔笔划的逐帧更新不再依赖空闲烘焙落盘。
// ============================================================================

/// 每 Tab 一份的引擎注册表。Arc 双层让命令把克隆塞进 spawn_blocking
/// （外层 Arc = 注册表行、内层 Arc = engine 本体）。
#[derive(Default, Clone)]
pub struct EngineRegistry(
    pub std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<editor_engine::DocEngine>>>>,
    >,
);

impl EngineRegistry {
    fn slot(
        &self,
        tab_id: &str,
    ) -> std::sync::Arc<std::sync::Mutex<editor_engine::DocEngine>> {
        self.0
            .lock()
            .expect("注册表锁不会中毒")
            .entry(tab_id.to_string())
            .or_default()
            .clone()
    }
}

/// 应用文档参数（语义载荷整体替换；像素仓按图层 id 保留）。
#[tauri::command]
pub fn editor_engine_apply(
    tab_id: String,
    doc: editor_engine::DisplayDocument,
    registry: tauri::State<'_, EngineRegistry>,
) -> Result<(), String> {
    registry.slot(&tab_id).lock().expect("engine 锁").apply_document(doc);
    Ok(())
}

/// 上传像素矩形（RGBA 非预乘、行紧凑，base64 进——与画笔烘焙同一条 IPC 口径）。
/// `key` = 图层 id 或 `{id}::mask`；首片上传按 layerWidth/layerHeight 分配画布。
#[tauri::command]
pub async fn editor_engine_upload_region(
    tab_id: String,
    key: String,
    layer_width: u32,
    layer_height: u32,
    x: u32,
    y: u32,
    rect_width: u32,
    rect_height: u32,
    data_base64: String,
    registry: tauri::State<'_, EngineRegistry>,
) -> Result<(), String> {
    use base64::Engine;
    let slot = registry.slot(&tab_id);
    tokio::task::spawn_blocking(move || {
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|e| format!("上传 base64 解码失败: {e}"))?;
        slot.lock()
            .expect("engine 锁")
            .upload_region(&key, layer_width, layer_height, x, y, rect_width, rect_height, &data)
    })
    .await
    .map_err(|e| format!("上传任务失败: {e}"))?
}

/// 从合成结果出 A 档 settle 帧（M2 的编码/落盘/内容哈希复用；两条命令共用）。
fn settle_frame_from_image(image: image::RgbaImage) -> Result<SettleFrame, String> {
    use std::hash::{Hash, Hasher};
    let has_alpha = image.pixels().any(|p| p.0[3] != 255);
    let (format, ext, bytes) = if has_alpha {
        (
            "png",
            "png",
            imaging::encode(&image, EncodeFormat::Png, 0).map_err(|e| e.to_string())?,
        )
    } else {
        (
            "jpg",
            "jpg",
            imaging::encode(&image, EncodeFormat::Jpeg, EXPORT_JPEG_QUALITY)
                .map_err(|e| e.to_string())?,
        )
    };
    let dir = frames_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let path = dir.join(format!("settle-{:016x}.{ext}", hasher.finish()));
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    prune_project_cache(&dir);
    Ok(SettleFrame {
        path: path.display().to_string(),
        width: image.width(),
        height: image.height(),
        format: format.into(),
    })
}

/// A 档（引擎版）：从 per-tab 引擎合成 settle 帧并落盘。
/// 与无状态版 `editor_render_document_frame` 的差别：像素含**上传仓**（画过的层
/// 不再依赖空闲烘焙落盘），且 prep 走逐层缓存。
#[tauri::command]
pub async fn editor_engine_render_settle(
    tab_id: String,
    registry: tauri::State<'_, EngineRegistry>,
) -> Result<SettleFrame, String> {
    let slot = registry.slot(&tab_id);
    tokio::task::spawn_blocking(move || {
        let image = slot.lock().expect("engine 锁").composite_settle()?;
        settle_frame_from_image(image)
    })
    .await
    .map_err(|e| format!("引擎 settle 任务失败: {e}"))?
}

/// B 档（引擎版）：从 per-tab 引擎合成视口区域帧写槽，返回序号。
#[tauri::command]
pub async fn editor_engine_render_viewport(
    tab_id: String,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    scale: Option<f64>,
    registry: tauri::State<'_, EngineRegistry>,
    slot: tauri::State<'_, ViewportFrameSlot>,
) -> Result<u64, String> {
    let engine = registry.slot(&tab_id);
    let frame_slot = slot.inner().clone();
    tokio::task::spawn_blocking(move || {
        let img = engine.lock().expect("engine 锁").composite_viewport(
            x,
            y,
            width,
            height,
            scale.unwrap_or(1.0),
        )?;
        Ok(store_viewport_frame(&frame_slot, img))
    })
    .await
    .map_err(|e| format!("引擎视口帧任务失败: {e}"))?
}

/// POST /upload 的处理端（lib.rs 的 editor-frame 协议直调）：query 带寻址参数、
/// **请求体就是裸 RGBA**（无 base64/JSON——画笔逐帧上传的主线程开销曾被实测
/// 拖卡大笔刷，2026-10-26 改的）。返回 http 状态码。
///
/// 键值只做白名单字符校验不做 URL 解码（tabId 是内部 uuid、key 是 id 或
/// `{id}::mask`——都不含需要转义的字符；出现异常字符直接 400）。
pub fn engine_upload_from_query(
    registry: &EngineRegistry,
    query: &str,
    body: &[u8],
) -> u16 {
    let mut tab_id = None;
    let mut key = None;
    let mut nums = [0u32; 6];
    let names = ["lw", "lh", "x", "y", "rw", "rh"];
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
        match k {
            "tab_id" => tab_id = Some(v.to_string()),
            "key" => key = Some(v.to_string()),
            "lw" | "lh" | "x" | "y" | "rw" | "rh" => {
                let i = names.iter().position(|n| *n == k).unwrap_or(0);
                match v.parse::<u32>() {
                    Ok(n) => nums[i] = n,
                    Err(_) => return 400,
                }
            }
            _ => return 400,
        }
    }
    let (Some(tab_id), Some(key)) = (tab_id, key) else {
        return 400;
    };
    let [lw, lh, x, y, rw, rh] = nums;
    // 键的白名单：内部 id 是 uuid/`::mask` 后缀，出现其它字符 = 有人在探协议
    let key_ok = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' || c == '.');
    if !key_ok || body.is_empty() {
        return 400;
    }
    match registry
        .slot(&tab_id)
        .lock()
        .expect("engine 锁")
        .upload_region(&key, lw, lh, x, y, rw, rh, body)
    {
        Ok(()) => 200,
        Err(_) => 400,
    }
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
    /// 混合模式（kebab-case **字符串**）。前端老版本不带这个字段时按 `normal` 处理。
    ///
    /// ⚠️ IPC 边界**收字符串不收枚举**：强类型枚举遇上"前端发了新档位、后端还是
    /// 旧二进制"（2026-10-26 非可分离四档上线时的实测：`invalid args 'doc'`，
    /// 整份保存被拒）就全盘失败；字符串 + `BlendMode::parse`（未知落 normal）
    /// 让这类版本错位降级成"那一档暂时当正常渲染"。与渲染路径的
    /// `LayerRequest.blend: Option<String>` 同一口径。
    #[serde(default)]
    pub blend: Option<String>,
    /// 锁透明像素 / 锁像素 / 锁位置。老前端不带字段时按 false（未锁）处理。
    #[serde(default)]
    pub lock_transparent: bool,
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
                blend: l.blend.as_deref().map(BlendMode::parse).unwrap_or_default(),
                lock_transparent: l.lock_transparent,
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

/// 画笔烘焙文件的落点：与工程缓存平级的另一个临时目录。
///
/// 画笔架构是 bake-on-stroke-end（见进度文档画笔轮）：每抬一次笔把整层像素烘成
/// PNG 写进来、前端把 `layer.source` 换成新路径；**旧文件不删**——撤销栈的旧快照
/// 还引用着它们。文件只增不改，清理交给 `prune_project_cache` 的 30 天 TTL
/// （与工程缓存同一口径：正在被 WebView 持有的文件删不掉就留着，下轮再清）。
fn paint_cache_dir() -> PathBuf {
    std::env::temp_dir().join("aurora-editor-paint")
}

/// 画笔缓存目录（首次调用时创建并顺带清一次过期文件）。
/// 前端拿绝对路径写烘焙 PNG（plugin-fs writeFile，不穿自定义 IPC 传大字节）。
#[tauri::command]
pub fn editor_paint_cache_dir() -> Result<String, String> {
    let dir = paint_cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    prune_project_cache(&dir);
    Ok(dir.display().to_string())
}

/// 画笔烘焙文件序号（同毫秒连抬几笔也不撞名——撤销栈靠不同路径区分每一笔）。
static PAINT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 画笔烘焙：前端把合成完的整层 PNG 以 base64 传进来，写进画笔缓存目录，
/// 返回**绝对路径**（前端把它变成 `layer.source` / `mask.source`）。
///
/// `name`（可选）= 前端**预分配**的文件名——性能方案（2026-10-25）要求抬笔瞬间
/// 就把 source 换成新路径（显示走内存画布、文件由后台烘焙补上），路径必须先于
/// 内容存在。不传则自动生成。名字只放行 `[A-Za-z0-9._-]`，防路径注入。
///
/// 走自定义 IPC 而不是 plugin-fs 的 writeFile/readFile：图层与蒙版的源图在用户
/// 任意目录（Pictures/Videos/…），fs 插件的 scope 对绝对路径的匹配并不可靠——
/// 2026-10-24 用户实测 `forbidden path ... allow-read-file`，画笔连原图都读不进
/// 来。自定义命令不受 capabilities 限制，base64 字符串过 IPC 也比字节数组便宜。
/// 顺带清一次过期烘焙文件（read_dir 一趟很便宜，每笔一次可接受）。
#[tauri::command]
pub fn editor_write_paint_png(base64: String, name: Option<String>) -> Result<String, String> {
    use base64::Engine;
    use std::sync::atomic::Ordering;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| {
            log::error!("[画笔] 烘焙 base64 解码失败（长度 {}）: {e}", base64.len());
            format!("base64 解码失败: {e}")
        })?;
    if bytes.is_empty() {
        log::error!("[画笔] 烘焙数据为空");
        return Err("烘焙数据为空".into());
    }
    let file_name = match name {
        Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') => n,
        Some(n) => {
            log::error!("[画笔] 拒绝非法文件名: {n:?}");
            return Err(format!("非法文件名: {n}"));
        }
        None => {
            let seq = PAINT_SEQ.fetch_add(1, Ordering::Relaxed);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("stroke-{now:x}-{seq}.png")
        }
    };
    let dir = paint_cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| {
        log::error!("[画笔] 缓存目录创建失败 {}: {e}", dir.display());
        e.to_string()
    })?;
    let path = dir.join(&file_name);
    std::fs::write(&path, &bytes).map_err(|e| {
        log::error!("[画笔] 烘焙写盘失败 {}: {e}", path.display());
        e.to_string()
    })?;
    log::info!("[画笔] 烘焙落盘 {} ({} 字节)", path.display(), bytes.len());
    prune_project_cache(&dir);
    Ok(path.display().to_string())
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
        // 画笔烘焙文件同口径清理（只按 mtime，不动打开中的判定）
        prune_project_cache(&paint_cache_dir());
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
                "lockTransparent": true,
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
        assert!(l.lock_transparent, "锁透明像素必须可读（camelCase：lockTransparent）");
        assert_eq!(l.lock_pixel, true);
        assert_eq!(l.lock_position, false);
        assert_eq!(l.layer_kind, "layer");
        assert_eq!(l.group_id.as_deref(), Some("g1"));
        assert_eq!(l.mask_source, "C:/pics/mask.png");
        assert_eq!(l.mask_box.as_ref().expect("解链框必须可读").w, 60.0);
        assert!(l.mask_disabled, "停用标志必须可读（camelCase：maskDisabled）");
        assert!(l.clipped, "剪贴标志必须可读");
        // 保存路径的 blend 收**字符串**（宽松 parse 在 save 转换处做）——强类型枚举
        // 遇上"新前端 + 旧二进制"会拒收整份请求（2026-10-26 实测）
        assert_eq!(l.blend.as_deref(), Some("multiply"));
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

    /// 画笔缓存目录：可创建、返回绝对路径、与工程缓存平级（两个目录各管各的文件）。
    #[test]
    fn paint_cache_dir_creates_and_returns_absolute_path() {
        let dir = editor_paint_cache_dir().expect("临时目录必须能创建");
        let p = std::path::Path::new(&dir);
        assert!(p.is_dir(), "返回的路径必须已创建：{dir}");
        assert!(p.is_absolute(), "前端要拿绝对路径写烘焙 PNG");
        assert!(dir.ends_with("aurora-editor-paint"));
    }

    /// base64 烘焙落盘：解码 → 唯一文件名 → 返回绝对路径（前端要变成 layer.source）。
    #[test]
    fn write_paint_png_decodes_and_lands_in_paint_dir() {
        use base64::Engine;
        // PNG 的 8 字节 magic 头就够验证链路（解码→落盘→绝对路径），不必是真图
        let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let path = editor_write_paint_png(b64, None).expect("写入必须成功");
        assert!(path.is_ascii());
        assert!(path.ends_with(".png"), "返回的是 PNG 路径：{path}");
        assert!(std::path::Path::new(&path).is_file(), "文件必须真的落盘：{path}");
        // 坏 base64 要报错而不是 panic
        assert!(editor_write_paint_png("!!!not-base64!!!".into(), None).is_err());
    }

    /// 预分配文件名（性能方案：抬笔先换 source，文件后台补）——合法名照用，
    /// 带路径分隔符的名字必须拒绝（防注入）。
    #[test]
    fn write_paint_png_accepts_preallocated_name_only_when_safe() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(vec![1u8, 2, 3]);
        let named = editor_write_paint_png(b64.clone(), Some("stroke-pre-1.png".into()))
            .expect("合法预分配名必须成功");
        assert!(named.ends_with("stroke-pre-1.png"));
        assert!(std::path::Path::new(&named).is_file());
        // 带路径成分的名字必须拒绝（防注入）——正反斜杠都不行
        assert!(editor_write_paint_png("AAAA".into(), Some("a/b.png".into())).is_err());
        assert!(editor_write_paint_png("AAAA".into(), Some("..\\evil.png".into())).is_err());
    }

    // ---- 管线换血 M2 · 帧输出（A/B 两档的单元验收）----

    /// 造一份单层文档载荷（fixture 图写进临时目录）。
    fn frame_doc(background: Option<&str>, alpha_pixels: bool) -> DocumentRequest {
        let mut img = image::RgbaImage::from_pixel(16, 12, image::Rgba([180, 60, 30, 255]));
        if alpha_pixels {
            img.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
        }
        let bytes = imaging::encode(&img, EncodeFormat::Png, 0).expect("编码 fixture");
        let dir = std::env::temp_dir().join(format!("aurora-frame-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建 fixture 目录");
        let src = dir.join(if alpha_pixels { "frame-src-alpha.png" } else { "frame-src.png" });
        std::fs::write(&src, &bytes).expect("写 fixture");
        DocumentRequest {
            canvas: CanvasRequest {
                width: 16,
                height: 12,
                background: background.map(|s| s.to_string()),
            },
            groups: vec![LayerGroupRequest {
                opacity: 100,
                blend: None,
                layers: vec![LayerRequest {
                    path: src.display().to_string(),
                    matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    adjust: None,
                    blend: None,
                    opacity: None,
                    mask: None,
                    clipped: false,
                }],
            }],
        }
    }

    /// A 档：不透明文档 → JPEG；透明像素 → PNG；同文档重渲染 → 内容哈希同路径
    /// （不重写不刷新 mtime，TTL/缓存口径与工程缓存一致）。
    #[test]
    fn settle_frame_formats_and_hash_dedupe() {
        let jpg = render_settle_frame_blocking(frame_doc(Some("white"), false))
            .expect("不透明文档必须出帧");
        assert_eq!(jpg.format, "jpg", "无 alpha 走 JPEG：{}", jpg.format);
        assert!(jpg.width == 16 && jpg.height == 12);
        assert!(std::path::Path::new(&jpg.path).is_file(), "{}", jpg.path);

        let png = render_settle_frame_blocking(frame_doc(None, true)).expect("透明文档必须出帧");
        assert_eq!(png.format, "png", "有 alpha 走 PNG：{}", png.format);

        let again = render_settle_frame_blocking(frame_doc(Some("white"), false))
            .expect("重复渲染必须成功");
        assert_eq!(again.path, jpg.path, "内容哈希必须复用同一文件（缓存命中）");
    }

    /// B 档：空槽 404；覆盖写 seq 递增；响应体 = "ARFD" 头 + seq/w/h + 最后那帧的字节。
    #[test]
    fn viewport_slot_overwrites_and_body_format() {
        let slot = ViewportFrameSlot::default();
        assert_eq!(viewport_frame_body(&slot).0, 404, "空槽必须 404");

        let seq1 = store_viewport_frame(
            &slot,
            image::RgbaImage::from_pixel(8, 6, image::Rgba([1, 2, 3, 255])),
        );
        let seq2 = store_viewport_frame(
            &slot,
            image::RgbaImage::from_pixel(10, 5, image::Rgba([9, 9, 9, 128])),
        );
        assert_eq!(seq1, 1);
        assert_eq!(seq2, 2, "覆盖写必须递增 seq");

        let (status, body) = viewport_frame_body(&slot);
        assert_eq!(status, 200);
        assert_eq!(&body[0..4], b"ARFD", "magic 是消费端防串流的第一道闸");
        let rd = |off: usize| u64::from(u32::from_le_bytes(body[off..off + 4].try_into().unwrap()));
        assert_eq!(rd(4), 2, "seq 取最新帧");
        assert_eq!(rd(8), 10, "宽度取最新帧");
        assert_eq!(rd(12), 5, "高度取最新帧");
        assert_eq!(body.len(), 16 + 10 * 5 * 4, "体长 = 头 + RGBA");
        // 最后那帧的像素（第二像素 [9,9,9,128]）必须在 body 末尾
        assert_eq!(&body[16 + 4..16 + 8], &[9, 9, 9, 128]);
    }

    /// M3 引擎注册表冒烟：**serde 契约**（DisplayDocument 的 mode 标签/camelCase
    /// 从 JSON 读进）+ apply → upload → 引擎 settle 落盘 → 引擎视口帧进槽。
    /// 这是前端 EngineCanvas 接线将要走的完整 IPC 面。
    #[test]
    fn engine_registry_apply_upload_settle_roundtrip() {
        use base64::Engine;
        let registry = EngineRegistry::default();
        let slot = ViewportFrameSlot::default();

        // 前端将发的载荷形状：mode 标签 + camelCase（16×12 两层，一层 store 带调色）
        let base_img = image::RgbaImage::from_pixel(16, 12, image::Rgba([60, 120, 180, 255]));
        let base_dir =
            std::env::temp_dir().join(format!("aurora-engine-registry-{}", std::process::id()));
        std::fs::create_dir_all(&base_dir).unwrap();
        let base_path = base_dir.join("base.png");
        std::fs::write(
            &base_path,
            imaging::encode(&base_img, EncodeFormat::Png, 0).unwrap(),
        )
        .unwrap();
        let base_path = base_path.to_string_lossy().replace('\\', "/");
        let doc_json = format!(
            r#"{{
            "width": 16, "height": 12, "background": "white",
            "groups": [{{
                "opacity": 100, "blend": null,
                "layers": [
                    {{"id": "base", "source": {{"mode": "file", "path": "{base_path}"}},
                     "pixelWidth": 0, "pixelHeight": 0, "matrix": [1,0,0,1,0,0]}},
                    {{"id": "painted", "source": {{"mode": "store"}},
                     "pixelWidth": 16, "pixelHeight": 12, "matrix": [1,0,0,1,0,0],
                     "adjust": {{"brightness": 10, "contrast": 0, "saturation": 0, "temperature": 0}}}}
                ]
            }}]
        }}"#);
        let doc: editor_engine::DisplayDocument =
            serde_json::from_str(&doc_json).expect("DisplayDocument 的 serde 形状必须可解析");

        // apply → 上传整层（base64 的裸 RGBA）
        registry.slot("tab1").lock().unwrap().apply_document(doc);
        let mut pixels = vec![0u8; 16 * 12 * 4];
        for (i, p) in pixels.chunks_exact_mut(4).enumerate() {
            p[0] = (i % 16) as u8;
            p[1] = (i / 16) as u8;
            p[2] = 90;
            p[3] = 255;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .unwrap();
        registry
            .slot("tab1")
            .lock()
            .unwrap()
            .upload_region("painted", 16, 12, 0, 0, 16, 12, &data)
            .unwrap();

        // 引擎 settle → 落盘（store 层有像素，文件缺失的 base 层按透明容错）
        let image = registry
            .slot("tab1")
            .lock()
            .unwrap()
            .composite_settle()
            .expect("引擎 settle 必须成功");
        let frame = settle_frame_from_image(image).expect("settle 帧必须落盘");
        assert_eq!(frame.format, "jpg", "白底不透明文档走 JPEG：{}", frame.format);
        assert!(std::path::Path::new(&frame.path).is_file());

        // 引擎视口帧 → 槽（seq 1、尺寸正确）
        let img = registry
            .slot("tab1")
            .lock()
            .unwrap()
            .composite_viewport(0.0, 0.0, 16, 12, 1.0)
            .expect("引擎视口合成必须成功");
        let seq = store_viewport_frame(&slot, img);
        assert_eq!(seq, 1);
        let (status, body) = viewport_frame_body(&slot);
        assert_eq!(status, 200);
        let w = u32::from_le_bytes(body[8..12].try_into().unwrap());
        let h = u32::from_le_bytes(body[12..16].try_into().unwrap());
        assert_eq!((w, h), (16, 12));
    }

    /// POST /upload 处理端：query 解析 + 白名单 + 像素真的落进引擎
    /// （"键值被 URL 编码吃掉"类事故在这一层当场红——2026-10-26 实测教训）。
    #[test]
    fn engine_upload_query_parses_and_lands_pixels() {
        let registry = EngineRegistry::default();
        let body: &[u8] = &[10, 20, 30, 255, 40, 50, 60, 255];

        // 白名单外的键（含空格等异常字符）必须 400
        assert_eq!(
            engine_upload_from_query(
                &registry,
                "tab_id=t&key=bad key&lw=2&lh=1&x=0&y=0&rw=2&rh=1",
                body
            ),
            400
        );
        // 字节量不符必须 400
        assert_eq!(
            engine_upload_from_query(
                &registry,
                "tab_id=t&key=layer-x&lw=2&lh=1&x=0&y=0&rw=2&rh=1",
                &[1, 2, 3, 4]
            ),
            400
        );
        // 缺参数必须 400
        assert_eq!(engine_upload_from_query(&registry, "tab_id=t&key=layer-x", body), 400);

        // 正常上传 → 像素落地（合成读回验证）
        assert_eq!(
            engine_upload_from_query(
                &registry,
                "tab_id=t&key=layer-x&lw=2&lh=1&x=0&y=0&rw=2&rh=1",
                body
            ),
            200
        );
        let doc: editor_engine::DisplayDocument = serde_json::from_str(
            r#"{"width":2,"height":1,"background":"white",
                "groups":[{"layers":[
                    {"id":"layer-x","source":{"mode":"store"},"pixelWidth":2,"pixelHeight":1,
                     "matrix":[1,0,0,1,0,0]}]}]}"#,
        )
        .unwrap();
        let engine = registry.slot("t");
        engine.lock().unwrap().apply_document(doc);
        let img = engine.lock().unwrap().composite_settle().unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [10, 20, 30, 255]);
        assert_eq!(img.get_pixel(1, 0).0, [40, 50, 60, 255]);
    }
}
