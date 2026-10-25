//! 合成载荷（阶段 1 自 `src-tauri/src/editor_commands.rs` 原样迁入，2026-10-26）。
//!
//! **serde 形状是跨 IPC 契约，一个键都不能动**（进度文档 §6.20/§6.24）：
//! `DocumentRequest` 整体 camelCase（`activeLayerId` 这类键在 canvas 层还没出现，
//! 但蒙版/调色字段全靠它）、blend 收 **Option<String>**（未知档位落 normal，
//! 强类型枚举会在"新前端 + 旧二进制"时拒收整份请求——§6.24 的实测教训）。
//! src-tauri 的 IPC 契约测试把这些形状钉死在 Rust 侧，改动必须两边一起过。
//!
//! 前端 `renderPayload.buildRenderGroups` 是这份载荷的生产者；分段/可见性剪除/
//! 蒙版链接语义/剪贴/缺省口径已经在**前端**收敛完，engine 只按语义合成。

use aurora_core::imaging::{self, CanvasBackground};
use image::RgbaImage;
use serde::Deserialize;

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
    pub fn is_noop(&self) -> bool {
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
pub fn apply_adjustments(image: RgbaImage, adjust: Option<AdjustRequest>) -> RgbaImage {
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
    /// 混合模式（kebab-case：`multiply` / `color-dodge`…）。不传或认不出来 = `normal`。
    /// 名字与 CSS 的 `mix-blend-mode` 同名，前端预览直接交给 CSS，两端不用再翻译一次。
    #[serde(default)]
    pub blend: Option<String>,
    /// 不透明度百分比（0..=100）；不传 = 100（完全不透明）。
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

fn default_opacity() -> u8 {
    100
}

/// 整份文档（画布 + 自底向上的**分段**）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRequest {
    pub canvas: CanvasRequest,
    pub groups: Vec<LayerGroupRequest>,
}

pub(crate) fn parse_background(raw: Option<&str>) -> CanvasBackground {
    match raw.unwrap_or("transparent").to_ascii_lowercase().as_str() {
        "white" => CanvasBackground::White,
        "black" => CanvasBackground::Black,
        _ => CanvasBackground::Transparent,
    }
}
