//! 有状态文档引擎（阶段 1 的 D6 画笔接缝，设计稿 §4/§6）。
//!
//! ## 与 `composite.rs`（无状态编排）的关系
//!
//! `composite_document` 每次调用都从**文件**解码并全量 prep——这对导出是对的，
//! 但对"画笔笔划逐帧更新"是灾难：像素真身在前端位图仓里，文件要等空闲烘焙才更新。
//! 本模块为此而生：**像素上传进来**（笔划脏矩形逐帧、物化时整层分条），按图层缓存
//! prep 结果，只对脏矩形重算。
//!
//! ## 为什么"脏矩形重 prep"是逐位安全的
//!
//! prep 的三个算子——调色（ColorMatrix）、不透明度（alpha 缩放）、蒙版（乘
//! `apply_mask_image`，全白跳过也是逐像素）——**全是逐像素、与位置无关的算子**：
//! 输出像素只依赖同位置的输入像素。所以"对矩形 R 重跑 prep" ≡ "全量 prep 后
//! 裁出 R"，parity 测试把这件事钉死。非逐点的重采样（warp）永远最后做、按区域。
//! 例外：**解链蒙版**的 warp 依赖矩阵几何，矩形路径不覆盖——解链层的蒙版变更走全量。
//!
//! ## 缓存的生命周期
//!
//! 每层两个指纹：`params_fp`（矩阵/调色/不透明度/蒙版模式/源身份，apply 时重算）
//! 与整体 `fp`（再 ⊕ pixels_rev/mask_rev）。参数没变、只变像素/蒙版 → 矩形重 prep；
//! 否则全量（蒙版解码缓存/解链 warp 只在这条路上刷新）。steady state 命中缓存的
//! 层是 `Arc::clone`（零 memcpy）——真正的写时共享要等阶段 2 的 COW 瓦片。

use crate::composite::DocumentComposer;
use crate::payload::{parse_background, AdjustRequest};
use aurora_core::imaging::{self, AffineMatrix, BlendMode};
use image::RgbaImage;
use std::collections::HashMap;
use std::sync::Arc;

/// 显示载荷的图层像素源：文件（没画过/被逐出的层）或引擎内上传仓（画过的层）。
/// serde 用 `mode` 标签（`{"mode":"file","path":…}` / `{"mode":"store"}`）——
/// 跨 IPC 枚举收字符串标签，未知档位在 parse 层落安全值（§6.24 同款口径）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum PixelSource {
    File { path: String },
    Store,
}

/// 显示载荷的蒙版：文件蒙版（没画过）或上传蒙版（画过）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum MaskSource {
    /// 与旧载荷同语义：path + 可选解链矩阵（None = 链接拉伸）
    File { path: String, matrix: Option<[f64; 6]> },
    /// 上传蒙版真身；解链时带蒙版自己的矩阵（链接 = None）
    Store { matrix: Option<[f64; 6]> },
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMask {
    pub source: MaskSource,
    /// 停用（PS 的 Shift+点缩略图）：不参与合成，数据保留
    #[serde(default)]
    pub disabled: bool,
}

/// 显示载荷的单层（= 旧 `LayerRequest` + `id` + 像素源模式 + 像素尺寸）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayLayer {
    /// 前端图层 id（上传通道按它寻址；蒙版 = `{id}::mask`）
    pub id: String,
    pub source: PixelSource,
    /// store 模式层的像素尺寸（首片上传前引擎按它分配画布）
    #[serde(default)]
    pub pixel_width: u32,
    #[serde(default)]
    pub pixel_height: u32,
    pub matrix: [f64; 6],
    #[serde(default)]
    pub adjust: Option<AdjustRequest>,
    #[serde(default)]
    pub blend: Option<String>,
    #[serde(default)]
    pub opacity: Option<u8>,
    #[serde(default)]
    pub mask: Option<DisplayMask>,
    #[serde(default)]
    pub clipped: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayGroup {
    #[serde(default = "default_group_opacity")]
    pub opacity: u8,
    #[serde(default)]
    pub blend: Option<String>,
    pub layers: Vec<DisplayLayer>,
}

fn default_group_opacity() -> u8 {
    100
}

/// 显示载荷（画布 + 自底向上分段）。语义与 `DocumentRequest` 完全一致，
/// 只多了 id 与像素源模式——file 模式逐字节等价于旧载荷（parity 测试锁）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDocument {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub background: Option<String>,
    pub groups: Vec<DisplayGroup>,
}

impl DisplayDocument {
    /// 从旧载荷构造（全部 file 模式）——parity 测试与"没画过的文档"走这里。
    pub fn from_request(doc: &crate::payload::DocumentRequest) -> Self {
        Self {
            width: doc.canvas.width,
            height: doc.canvas.height,
            background: doc.canvas.background.clone(),
            groups: doc
                .groups
                .iter()
                .map(|g| DisplayGroup {
                    opacity: g.opacity,
                    blend: g.blend.clone(),
                    layers: g
                        .layers
                        .iter()
                        .map(|l| DisplayLayer {
                            id: format!("file:{}", l.path),
                            source: PixelSource::File { path: l.path.clone() },
                            pixel_width: 0,
                            pixel_height: 0,
                            matrix: l.matrix,
                            adjust: l.adjust,
                            blend: l.blend.clone(),
                            opacity: l.opacity,
                            mask: l.mask.as_ref().map(|m| DisplayMask {
                                source: MaskSource::File {
                                    path: m.path.clone(),
                                    matrix: m.matrix,
                                },
                                disabled: false,
                            }),
                            clipped: l.clipped,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// 单层的像素仓 + prep 缓存。**蒙版槽（`{id}::mask`）的 `pixels` 就是蒙版像素**
/// （upload_region 按键写入同一个字段，读侧也读它——2026-10-26 曾因字段分叉
/// 导致 store 蒙版整个不生效，parity 抓回）。
#[derive(Default)]
struct LayerSlot {
    pixels: Option<RgbaImage>,
    /// 解码后的蒙版（File 模式 = 解码缓存、Store 模式 = 上传仓的镜像），
    /// 供矩形重 prep 裁矩形用（避免每帧重解码/整图克隆）
    mask_decoded: Option<RgbaImage>,
    /// prep 结果（adjust+opacity+蒙版乘法后、重采样前）；Arc 让命中路径零拷贝
    prepped: Option<Arc<RgbaImage>>,
    prepped_fp: u64,
    params_fp: u64,
    /// 自上次 prep 后累积的脏矩形（层像素坐标）
    dirty: Option<(u32, u32, u32, u32)>,
    pixels_rev: u64,
    mask_rev: u64,
}

impl LayerSlot {
    fn mark_dirty(&mut self, rect: (u32, u32, u32, u32)) {
        self.dirty = Some(match self.dirty {
            None => rect,
            Some((x, y, w, h)) => {
                let x0 = x.min(rect.0);
                let y0 = y.min(rect.1);
                let x1 = (x + w).max(rect.0 + rect.2);
                let y1 = (y + h).max(rect.1 + rect.3);
                (x0, y0, x1 - x0, y1 - y0)
            }
        });
    }
}

/// 每 Tab 一份的文档引擎（src-tauri 侧按 tabId 路由）。
#[derive(Default)]
pub struct DocEngine {
    doc: Option<DisplayDocument>,
    slots: HashMap<String, LayerSlot>,
    /// file 模式解码（与无状态编排共用同一缓存）
    composer: DocumentComposer,
}

impl DocEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 应用文档参数。像素仓按 id 保留——重排/换参数不清空上传的像素；删层连带丢仓。
    pub fn apply_document(&mut self, doc: DisplayDocument) {
        let mut live: Vec<String> = Vec::new();
        for g in &doc.groups {
            for l in &g.layers {
                live.push(l.id.clone());
                if l.mask.is_some() {
                    live.push(mask_key(&l.id));
                }
            }
        }
        self.slots.retain(|k, _| live.contains(k));
        self.doc = Some(doc);
    }

    /// 上传像素矩形（RGBA 非预乘、行紧凑，覆盖矩形 `(x,y,rect_w,rect_h)`）。
    /// `key` = 图层 id 或 `{id}::mask`。首片上传按 `(layer_w, layer_h)` 分配画布。
    #[allow(clippy::too_many_arguments)]
    pub fn upload_region(
        &mut self,
        key: &str,
        layer_w: u32,
        layer_h: u32,
        x: u32,
        y: u32,
        rect_w: u32,
        rect_h: u32,
        data: &[u8],
    ) -> Result<(), String> {
        if layer_w == 0 || layer_h == 0 || rect_w == 0 || rect_h == 0 {
            return Err("上传尺寸为 0".into());
        }
        if x + rect_w > layer_w || y + rect_h > layer_h {
            return Err(format!(
                "上传矩形越界: ({x},{y},{rect_w},{rect_h}) in {layer_w}x{layer_h}"
            ));
        }
        let expected = rect_w as usize * rect_h as usize * 4;
        if data.len() != expected {
            return Err(format!("上传字节量不符：{} != {}", data.len(), expected));
        }
        let slot = self.slots.entry(key.to_string()).or_default();
        let img = slot
            .pixels
            .get_or_insert_with(|| RgbaImage::new(layer_w, layer_h));
        if img.width() != layer_w || img.height() != layer_h {
            return Err(format!(
                "上传尺寸与既有像素不符：{layer_w}x{layer_h} vs {}x{}",
                img.width(),
                img.height()
            ));
        }
        // 行拷贝（ImageBuffer 行主序：dst 行 = (y+row)*layer_w + x 起、rect_w 长）
        let raw = img.as_mut();
        let row_bytes = rect_w as usize * 4;
        for row in 0..rect_h as usize {
            let src = &data[row * row_bytes..(row + 1) * row_bytes];
            let dst = ((y as usize + row) * layer_w as usize + x as usize) * 4;
            raw[dst..dst + row_bytes].copy_from_slice(src);
        }
        if key.ends_with(MASK_SUFFIX) {
            slot.mask_rev += 1;
        } else {
            slot.pixels_rev += 1;
        }
        slot.mark_dirty((x, y, rect_w, rect_h));
        Ok(())
    }

    /// 合成整份文档（settle 帧）。语义与无状态 `composite_document` 一致（parity 锁）。
    pub fn composite_settle(&mut self) -> Result<RgbaImage, String> {
        let doc = self.doc.clone().ok_or("文档未应用")?;
        self.composite_impl(doc.width, doc.height, &doc, |m| m)
    }

    /// 合成视口区域（交互帧）。矩阵换算与 `composite_region` 同一数学。
    pub fn composite_viewport(
        &mut self,
        x: f64,
        y: f64,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<RgbaImage, String> {
        let doc = self.doc.clone().ok_or("文档未应用")?;
        if width == 0 || height == 0 {
            return Err("视口尺寸为 0".into());
        }
        let scale = if scale > 0.0 { scale } else { 1.0 };
        self.composite_impl(width, height, &doc, move |m| {
            let t = AffineMatrix::from_array([1.0, 0.0, 0.0, 1.0, -x, -y]);
            let s = AffineMatrix::from_array([scale, 0.0, 0.0, scale, 0.0, 0.0]);
            AffineMatrix::concat(s, AffineMatrix::concat(t, m))
        })
    }

    /// 当前帧的像素版本号（前端上传后的失效对账用）。
    pub fn layer_pixels_rev(&self, key: &str) -> Option<u64> {
        self.slots.get(key).map(|s| s.pixels_rev)
    }

    fn composite_impl(
        &mut self,
        width: u32,
        height: u32,
        doc: &DisplayDocument,
        map_matrix: impl Fn(AffineMatrix) -> AffineMatrix,
    ) -> Result<RgbaImage, String> {
        let background = parse_background(doc.background.as_deref());
        let mut decoded: Vec<Arc<RgbaImage>> = Vec::new();
        let mut group_specs: Vec<(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)> =
            Vec::new();
        for g in &doc.groups {
            let mut members = Vec::new();
            for l in &g.layers {
                let prepped = self.prep_layer(l)?;
                decoded.push(prepped);
                members.push((
                    decoded.len() - 1,
                    map_matrix(AffineMatrix::from_array(l.matrix)),
                    l.blend.as_deref().map(BlendMode::parse).unwrap_or_default(),
                    l.clipped,
                ));
            }
            group_specs.push((
                g.opacity.min(100),
                g.blend.as_deref().map(BlendMode::parse).unwrap_or_default(),
                members,
            ));
        }
        let groups: Vec<imaging::CompositeGroup<'_>> = group_specs
            .iter()
            .map(|(opacity, blend, members)| imaging::CompositeGroup {
                opacity: *opacity,
                blend: *blend,
                layers: members
                    .iter()
                    .map(|(idx, matrix, blend, clipped)| imaging::CompositeLayer {
                        src: &decoded[*idx],
                        matrix: *matrix,
                        blend: *blend,
                        clipped: *clipped,
                    })
                    .collect(),
            })
            .collect();
        imaging::composite_grouped(width, height, background, &groups).map_err(|e| e.to_string())
    }

    /// 单层 prep（带缓存）。命中 = Arc 克隆（零 memcpy）；像素/蒙版变更且参数没变
    /// （且非解链 store 蒙版）= 矩形重 prep；否则全量重 prep。
    fn prep_layer(&mut self, l: &DisplayLayer) -> Result<Arc<RgbaImage>, String> {
        let params_fp = self.params_fingerprint(l);
        let mask_rev = if l.mask.is_some() {
            self.slots.get(&mask_key(&l.id)).map(|s| s.mask_rev).unwrap_or(0)
        } else {
            0
        };
        let pixels_rev = self.slots.get(&l.id).map(|s| s.pixels_rev).unwrap_or(0);
        let fp = fingerprint(pixels_rev, mask_rev, params_fp);

        // 命中：零拷贝返回
        if let Some(slot) = self.slots.get(&l.id) {
            if slot.prepped_fp == fp {
                if let Some(p) = &slot.prepped {
                    return Ok(p.clone());
                }
            }
        }

        // File 模式现在就解码（composer 缓存；参数没变的层在上面已命中返回）。
        // Store 模式只查存在性——**矩形路径借引用不克隆**（整层克隆曾把大笔刷拖卡：
        // 每帧 ~20MB memcpy，2026-10-26 用户实测后改的），只有全量重 prep 才克隆。
        // 蒙版解码同理（矩形路径用槽里的 mask_decoded 缓存，不重解码）。
        let file_pixels: Option<RgbaImage> = match &l.source {
            PixelSource::File { path } => Some(self.composer.decode(path)?),
            PixelSource::Store => None,
        };
        let has_source = match &l.source {
            PixelSource::File { .. } => true,
            PixelSource::Store => self
                .slots
                .get(&l.id)
                .map(|s| s.pixels.is_some())
                .unwrap_or(false),
        };
        if !has_source {
            // 还没上传过：按"无像素"渲染（前端只会在物化+上传完成后切显示）
            return Ok(Arc::new(RgbaImage::new(1, 1)));
        }

        // 矩形重 prep 的门槛：上一次 prep 存在、参数没变、有脏矩形、
        // 且不是"解链 store 蒙版"（它的 warp 依赖矩阵，矩形路径不覆盖）
        let unlinked_store_mask = matches!(
            &l.mask,
            Some(DisplayMask { source: MaskSource::Store { matrix: Some(_) }, disabled: false })
        );
        let rect_ok = {
            let slot = self.slots.get(&l.id);
            slot.and_then(|s| s.prepped.as_ref()).is_some()
                && slot.map(|s| s.params_fp) == Some(params_fp)
                && slot.and_then(|s| s.dirty).is_some()
                && !unlinked_store_mask
        };

        if rect_ok {
            self.rect_reprep(l, file_pixels, fp)
        } else {
            let source = match &l.source {
                PixelSource::File { .. } => file_pixels.ok_or("解码失败")?,
                PixelSource::Store => self
                    .slots
                    .get(&l.id)
                    .and_then(|s| s.pixels.clone())
                    .ok_or("像素仓为空")?,
            };
            let mask_img: Option<RgbaImage> = match &l.mask {
                None => None,
                Some(m) if m.disabled => None,
                Some(m) => match &m.source {
                    MaskSource::File { path, .. } => Some(self.composer.decode(path)?),
                    MaskSource::Store { .. } => self
                        .slots
                        .get(&mask_key(&l.id))
                        .and_then(|s| s.pixels.clone()),
                },
            };
            self.full_reprep(l, source, mask_img, fp, params_fp).map(Arc::new)
        }
    }

    /// 单层参数指纹（不含像素版本——只变像素不该惊动全量 prep）。
    fn params_fingerprint(&self, l: &DisplayLayer) -> u64 {
        let mut h = 0x9E37_79B9_7F4A_7C15u64;
        let mut mix = |v: u64| h = h.wrapping_mul(31).wrapping_add(v);
        for v in l.matrix {
            mix(v.to_bits() as u64);
        }
        mix(l.pixel_width as u64);
        mix(l.pixel_height as u64);
        if let Some(a) = &l.adjust {
            mix(a.brightness.to_bits() as u64);
            mix(a.contrast.to_bits() as u64);
            mix(a.saturation.to_bits() as u64);
            mix(a.temperature.to_bits() as u64);
        }
        mix(l.opacity.unwrap_or(100) as u64);
        match &l.source {
            PixelSource::File { path: p } => {
                mix(1);
                mix(hash_str(p));
            }
            PixelSource::Store => mix(2),
        }
        match &l.mask {
            None => mix(0),
            Some(m) => {
                mix(if m.disabled { 3 } else { 4 });
                match &m.source {
                    MaskSource::File { path, matrix } => {
                        mix(5);
                        mix(hash_str(path));
                        mix(matrix.map_or(7, |v| v[0].to_bits() as u64));
                    }
                    MaskSource::Store { matrix } => {
                        mix(6);
                        mix(matrix.map_or(7, |v| v[0].to_bits() as u64));
                    }
                }
            }
        }
        h
    }

    /// 全量重 prep：像素克隆 → 逐点算子区 → 缓存。
    fn full_reprep(
        &mut self,
        l: &DisplayLayer,
        source: RgbaImage,
        mut mask_img: Option<RgbaImage>,
        fp: u64,
        params_fp: u64,
    ) -> Result<RgbaImage, String> {
        let mut img = source;
        apply_pointwise(&mut img, l, &mask_img)?;
        let slot = self.slots.entry(l.id.clone()).or_default();
        slot.prepped = Some(Arc::new(img));
        slot.prepped_fp = fp;
        slot.params_fp = params_fp;
        slot.dirty = None;
        // 蒙版解码缓存（矩形重 prep 裁矩形用）
        slot.mask_decoded = mask_img.take();
        Ok(slot.prepped.as_ref().expect("刚存入").as_ref().clone())
    }

    /// 矩形重 prep：把变更的源/蒙版矩形拷进缓存，只对矩形重跑逐点算子
    /// （逐位等价于全量重 prep——`rect_reprep_equals_fresh_full` 钉死）。
    fn rect_reprep(
        &mut self,
        l: &DisplayLayer,
        file_pixels: Option<RgbaImage>,
        fp: u64,
    ) -> Result<Arc<RgbaImage>, String> {
        let mask_key = mask_key(&l.id);
        let rect = {
            let slot = self.slots.get(&l.id).ok_or("层仓不存在")?;
            slot.dirty.ok_or("无脏矩形")?
        };
        let mut prepped = match self.slots.get_mut(&l.id).and_then(|s| s.prepped.take()) {
            Some(arc) => match Arc::try_unwrap(arc) {
                Ok(img) => img,
                Err(arc) => (*arc).clone(),
            },
            None => return Err("矩形重 prep 缺少缓存".into()),
        };
        // 1) 变更的源矩形拷进 prepped（File 模式源是解码克隆；Store 模式直读仓）
        match file_pixels {
            Some(fp_img) => rect_copy(&mut prepped, &fp_img, rect),
            None => {
                let slot = self.slots.get(&l.id).ok_or("层仓不存在")?;
                let pixels = slot.pixels.as_ref().ok_or("像素仓为空")?;
                rect_copy(&mut prepped, pixels, rect);
            }
        }
        // 2) 蒙版矩形同步进解码缓存（蒙版上传路径；蒙版槽的 pixels = 蒙版像素）
        {
            let slot = self.slots.get(&mask_key);
            if let (Some(mask_pixels), Some(cached)) =
                (slot.and_then(|s| s.pixels.clone()), self.slots.get_mut(&l.id).and_then(|s| s.mask_decoded.as_mut()))
            {
                if cached.width() == mask_pixels.width() && cached.height() == mask_pixels.height() {
                    rect_copy(cached, &mask_pixels, rect);
                }
            }
        }
        // 3) 逐点算子重跑矩形（蒙版用解码缓存裁同一矩形）
        let mask_rect = {
            let slot = self.slots.get(&l.id).ok_or("层仓不存在")?;
            slot.mask_decoded.as_ref().map(|m| rect_img(m, rect))
        };
        apply_pointwise_rect(&mut prepped, l, mask_rect.as_ref(), rect)?;
        let slot = self.slots.get_mut(&l.id).ok_or("层仓不存在")?;
        slot.prepped = Some(Arc::new(prepped.clone()));
        slot.prepped_fp = fp;
        slot.dirty = None;
        Ok(Arc::new(prepped))
    }
}

const MASK_SUFFIX: &str = "::mask";

fn mask_key(layer_id: &str) -> String {
    format!("{layer_id}{MASK_SUFFIX}")
}

fn fingerprint(pixels_rev: u64, mask_rev: u64, params_fp: u64) -> u64 {
    params_fp
        .wrapping_mul(31)
        .wrapping_add(pixels_rev)
        .wrapping_mul(31)
        .wrapping_add(mask_rev)
}

fn hash_str(s: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// 逐点算子区（顺序契约：调色 → 不透明度 → 蒙版；重采样在 composite 里）。
/// 全量 prep 用这一份。蒙版语义：链接（矩阵 None）直接 `apply_mask_image`
/// （尺寸不符时它内部 Triangle 拉伸，与 legacy 的 `apply_mask` 同一条路径，
/// parity 逐位）；解链（矩阵 Some）先 warp 到图层内容空间再乘。
fn apply_pointwise(
    img: &mut RgbaImage,
    l: &DisplayLayer,
    mask_img: &Option<RgbaImage>,
) -> Result<(), String> {
    apply_adjust_rect(img, &l.adjust, None);
    imaging::apply_opacity(img, l.opacity.unwrap_or(100).min(100));
    if let (Some(m), Some(mask)) = (&l.mask, mask_img) {
        if !m.disabled {
            match &m.source {
                MaskSource::File { matrix: None, .. } | MaskSource::Store { matrix: None } => {
                    imaging::apply_mask_image(img, mask);
                }
                _ => {
                    let mask_matrix = match &m.source {
                        MaskSource::File { matrix: Some(mm), .. } => *mm,
                        MaskSource::Store { matrix: Some(mm) } => *mm,
                        _ => unreachable!("上面已排除链接分支"),
                    };
                    let layer_matrix = AffineMatrix::from_array(l.matrix);
                    let to_local = AffineMatrix::concat(
                        layer_matrix.invert().map_err(|e| e.to_string())?,
                        AffineMatrix::from_array(mask_matrix),
                    );
                    let warped = imaging::warp_affine(
                        mask,
                        img.width(),
                        img.height(),
                        to_local,
                        imaging::Sampling::Bilinear,
                    )
                    .map_err(|e| e.to_string())?;
                    imaging::apply_mask_image(img, &warped);
                }
            }
        }
    }
    Ok(())
}

/// 调色（全量或矩形：`rect = None` 作用整图）。与 legacy 的 apply_adjustments
/// 同一矩阵口径（-100..100 → -1..1）。
fn apply_adjust_rect(
    img: &mut RgbaImage,
    adjust: &Option<AdjustRequest>,
    rect: Option<(u32, u32, u32, u32)>,
) {
    let Some(a) = adjust else { return };
    if a.brightness == 0.0 && a.contrast == 0.0 && a.saturation == 0.0 && a.temperature == 0.0 {
        return; // 全 0 时一个像素都不碰（与 legacy 同口径）
    }
    let matrix = imaging::ColorMatrix::from_adjustments(
        a.brightness / 100.0,
        a.contrast / 100.0,
        a.saturation / 100.0,
        a.temperature / 100.0,
    );
    match rect {
        None => *img = imaging::apply_color_matrix(img, &matrix),
        Some(r) => {
            let mut sub = rect_img(img, r);
            sub = imaging::apply_color_matrix(&sub, &matrix);
            rect_write(img, &sub, r);
        }
    }
}

/// 矩形限定的逐点算子（蒙版用**预解码缓存**裁同一矩形——apply_mask_image 对
/// 同尺寸输入不做内部 resize，纯逐点乘法，与全量 prep 逐位等价）。
fn apply_pointwise_rect(
    img: &mut RgbaImage,
    l: &DisplayLayer,
    mask_rect_img: Option<&RgbaImage>,
    rect: (u32, u32, u32, u32),
) -> Result<(), String> {
    apply_adjust_rect(img, &l.adjust, Some(rect));
    let mut sub = rect_img(img, rect);
    imaging::apply_opacity(&mut sub, l.opacity.unwrap_or(100).min(100));
    if let (Some(m), Some(mask)) = (&l.mask, mask_rect_img) {
        if !m.disabled {
            imaging::apply_mask_image(&mut sub, mask);
        }
    }
    rect_write(img, &sub, rect);
    Ok(())
}

fn rect_img(img: &RgbaImage, rect: (u32, u32, u32, u32)) -> RgbaImage {
    let (x, y, w, h) = rect;
    let mut out = RgbaImage::new(w, h);
    let row_len = w as usize * 4;
    for row in 0..h as usize {
        let src_off = ((y as usize + row) * img.width() as usize + x as usize) * 4;
        out.as_mut()[row * row_len..(row + 1) * row_len]
            .copy_from_slice(&img.as_raw()[src_off..src_off + row_len]);
    }
    out
}

fn rect_copy(dst: &mut RgbaImage, src: &RgbaImage, rect: (u32, u32, u32, u32)) {
    let (x, y, w, h) = rect;
    let row_len = w as usize * 4;
    for row in 0..h as usize {
        let src_off = ((y as usize + row) * src.width() as usize + x as usize) * 4;
        let dst_off = ((y as usize + row) * dst.width() as usize + x as usize) * 4;
        dst.as_mut()[dst_off..dst_off + row_len]
            .copy_from_slice(&src.as_raw()[src_off..src_off + row_len]);
    }
}

/// 把矩形子图写回大图（`sub` 恰是 `rect` 的内容，按它自己的行序拷——与
/// `rect_copy` 的"同坐标空间"约定不同，别混用）。
fn rect_write(dst: &mut RgbaImage, sub: &RgbaImage, rect: (u32, u32, u32, u32)) {
    let (x, y, w, h) = rect;
    let row_len = w as usize * 4;
    for row in 0..h as usize {
        let src_off = row * row_len;
        let dst_off = ((y as usize + row) * dst.width() as usize + x as usize) * 4;
        dst.as_mut()[dst_off..dst_off + row_len]
            .copy_from_slice(&sub.as_raw()[src_off..src_off + row_len]);
    }
}

#[cfg(test)]
mod tests {
    //! 引擎状态机的 parity 三件套 + 视口一致性。
    //! legacy 参照 = `crate::composite::legacy_composite_document`（迁前原样）。

    use super::*;
    use crate::composite::legacy_composite_document;
    use aurora_core::imaging::EncodeFormat;
    use std::path::PathBuf;

    // ---- fixtures（与 composite tests 同款的最小复制，保持测试隔离）----

    /// fixture 文件名在各测试间共用（de-*.png）——cargo 并行跑测试时"写同名文件
    /// vs 读"会竞争出字节级假差异，这把锁把 fixture 的写+读串行化。
    static FIXTURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn fixture_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aurora-docengine-parity-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("创建 fixture 目录");
        dir
    }

    fn gradient(w: u32, h: u32, seed: u8) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            p.0 = [
                x as u8 ^ seed,
                (y as u8).wrapping_add(seed),
                ((x + y) as u8) / 2 + seed / 3,
                255,
            ];
        }
        img
    }

    fn alpha_shape(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for (x, _, p) in img.enumerate_pixels_mut() {
            let a = if x < w / 2 {
                255u8
            } else {
                255 - ((x - w / 2) as u16 * 255 / (w / 2) as u16) as u8
            };
            p.0 = [200, 30, 30, a];
        }
        img
    }

    fn mask_image(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let l = ((x + y) * 255 / (w + h) as u32) as u8;
            let v = if x < w / 8 && y < h / 8 { 0 } else { l };
            p.0 = [v, v, v, 255];
        }
        img
    }

    fn write_png(name: &str, img: &RgbaImage) -> String {
        let bytes = imaging::encode(img, EncodeFormat::Png, 0).expect("编码 fixture PNG");
        let path = fixture_dir().join(name);
        std::fs::write(&path, &bytes).expect("写 fixture");
        path.to_string_lossy().replace('\\', "/")
    }

    fn assert_same(a: &RgbaImage, b: &RgbaImage, what: &str) {
        assert_eq!(a.dimensions(), b.dimensions(), "{what}: 尺寸不一致");
        if a.as_raw() != b.as_raw() {
            let diff = a
                .as_raw()
                .iter()
                .zip(b.as_raw())
                .position(|(x, y)| x != y)
                .expect("内容不同却找不到差异数据");
            panic!("{what}: 第 {diff} 字节起不一致（parity 破坏，禁止静默漂移）");
        }
    }

    fn crop(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> RgbaImage {
        rect_img(img, (x, y, w, h))
    }

    /// 三层文档：底图 + multiply 混合带链接蒙版层 + 解链蒙版层（最重的语义组合）。
    fn fixture_request() -> (crate::payload::DocumentRequest, String, String, String, String) {
        let base = write_png("de-base.png", &gradient(64, 48, 11));
        let top = write_png("de-top.png", &alpha_shape(32, 24));
        let top2 = write_png("de-top2.png", &alpha_shape(40, 20));
        let mask = write_png("de-mask.png", &mask_image(32, 24));
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"black"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"opacity":85,"blend":"screen","layers":[
                    {{"path":"{top}","matrix":[1.2,0,0,1.2,6,4],
                      "adjust":{{"brightness":15,"saturation":-20}},
                      "mask":{{"path":"{mask}","matrix":null}}}},
                    {{"path":"{top2}","matrix":[0.8,0,0,0.8,10,10],"clipped":true,
                      "opacity":70,"blend":"hue"}}
                  ]}}
                ]}}"#
        );
        let doc: crate::payload::DocumentRequest = serde_json::from_str(&json).unwrap();
        (doc, base, top, top2, mask)
    }

    /// parity ①：file 模式（DisplayDocument::from_request）== legacy 逐字节。
    #[test]
    fn file_mode_matches_legacy() {
        let _guard = FIXTURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (doc, _, _, _, _) = fixture_request();
        let legacy = legacy_composite_document(&doc).unwrap();
        let mut engine = DocEngine::new();
        engine.apply_document(DisplayDocument::from_request(&doc));
        let got = engine.composite_settle().unwrap();
        assert_same(&legacy, &got, "file 模式 == legacy");
        // 缓存命中路径（第二跑）也必须一致
        let got2 = engine.composite_settle().unwrap();
        assert_same(&legacy, &got2, "file 模式热缓存 == legacy");
    }

    /// 全局唯一 id（跨组不冲突——按组 enumerate 会撞名，2026-10-26 踩过）构造
    /// 显示文档；`store_dims` 返回 Some 的层走 store 模式（含蒙版），返回像素尺寸。
    fn display_with_store_ids(
        doc: &crate::payload::DocumentRequest,
        store_dims: impl Fn(&crate::payload::LayerRequest) -> Option<(u32, u32)>,
    ) -> (DisplayDocument, Vec<String>) {
        let mut n = 0usize;
        let mut store_ids: Vec<String> = Vec::new();
        let groups = doc
            .groups
            .iter()
            .map(|g| DisplayGroup {
                opacity: g.opacity,
                blend: g.blend.clone(),
                layers: g
                    .layers
                    .iter()
                    .map(|l| {
                        let id = format!("L{n}");
                        n += 1;
                        let dims = store_dims(l);
                        if dims.is_some() {
                            store_ids.push(id.clone());
                        }
                        DisplayLayer {
                            id: id.clone(),
                            source: if dims.is_some() {
                                PixelSource::Store
                            } else {
                                PixelSource::File { path: l.path.clone() }
                            },
                            pixel_width: dims.map(|d| d.0).unwrap_or(0),
                            pixel_height: dims.map(|d| d.1).unwrap_or(0),
                            matrix: l.matrix,
                            adjust: l.adjust,
                            blend: l.blend.clone(),
                            opacity: l.opacity,
                            mask: l.mask.as_ref().map(|m| DisplayMask {
                                source: if dims.is_some() {
                                    MaskSource::Store { matrix: m.matrix }
                                } else {
                                    MaskSource::File {
                                        path: m.path.clone(),
                                        matrix: m.matrix,
                                    }
                                },
                                disabled: false,
                            }),
                            clipped: l.clipped,
                        }
                    })
                    .collect(),
            })
            .collect();
        (
            DisplayDocument {
                width: doc.canvas.width,
                height: doc.canvas.height,
                background: doc.canvas.background.clone(),
                groups,
            },
            store_ids,
        )
    }

    /// parity ②：store 上传（整层一片）== 同内容 file 模式 == legacy。
    #[test]
    fn store_upload_matches_file() {
        let _guard = FIXTURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (doc, base, top, _top2, mask) = fixture_request();
        let legacy = legacy_composite_document(&doc).unwrap();

        let mut engine = DocEngine::new();
        let (display, store_ids) =
            display_with_store_ids(&doc, |l| l.adjust.is_some().then(|| (32u32, 24u32)));
        let store_id = store_ids[0].clone();
        // 整层 + 整蒙版各一片上传
        let top_img = image::open(&top).unwrap().to_rgba8();
        let mask_img = image::open(&mask).unwrap().to_rgba8();
        engine.apply_document(display);
        engine
            .upload_region(&store_id, 32, 24, 0, 0, 32, 24, top_img.as_raw())
            .unwrap();
        engine
            .upload_region(&format!("{store_id}::mask"), 32, 24, 0, 0, 32, 24, mask_img.as_raw())
            .unwrap();
        let _ = base;
        let got = engine.composite_settle().unwrap();
        assert_same(&legacy, &got, "store 上传 == file == legacy");
    }

    /// parity ③（本模块的价值主张）：脏矩形重 prep == "全新引擎灌最终像素"的全量 prep。
    #[test]
    fn rect_reprep_equals_fresh_full() {
        let _guard = FIXTURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (doc, _base, top, _top2, _mask) = fixture_request();
        let top_img = image::open(&top).unwrap().to_rgba8();
        let (tw, th) = (top_img.width(), top_img.height());
        let build_doc = || {
            let (display, ids) =
                display_with_store_ids(&doc, |l| l.adjust.is_some().then(|| (tw, th)));
            assert_eq!(ids.len(), 1, "fixture 只有带调色的那一层走 store");
            (display, ids[0].clone())
        };

        // 引擎 A：先灌初版像素 → settle（全量 prep + 缓存）→ 灌脏矩形 → settle（矩形路径）
        let mut engine_a = DocEngine::new();
        let (doc_a, id_a) = build_doc();
        engine_a.apply_document(doc_a);
        engine_a
            .upload_region(&id_a, tw, th, 0, 0, tw, th, top_img.as_raw())
            .unwrap();
        let _ = engine_a.composite_settle().unwrap();
        // "笔划"：改 8×8 一块
        let mut patch = vec![0u8; 8 * 8 * 4];
        for (i, p) in patch.chunks_exact_mut(4).enumerate() {
            p[0] = 20;
            p[1] = 240;
            p[2] = 60;
            p[3] = ((i * 7) % 256) as u8;
        }
        engine_a
            .upload_region(&id_a, tw, th, 5, 7, 8, 8, &patch)
            .unwrap();
        let after_rect = engine_a.composite_settle().unwrap();

        // 引擎 B：直接灌"初版 + 补丁合并"的最终像素 → settle（全新全量 prep）
        let mut final_img = top_img.clone();
        for row in 0..8usize {
            for col in 0..8usize {
                let off = (row * 8 + col) * 4;
                final_img.put_pixel((5 + col) as u32, (7 + row) as u32, image::Rgba([
                    patch[off], patch[off + 1], patch[off + 2], patch[off + 3],
                ]));
            }
        }
        let mut engine_b = DocEngine::new();
        let (doc_b, id_b) = build_doc();
        engine_b.apply_document(doc_b);
        engine_b
            .upload_region(&id_b, tw, th, 0, 0, tw, th, final_img.as_raw())
            .unwrap();
        let fresh = engine_b.composite_settle().unwrap();

        assert_same(&fresh, &after_rect, "矩形重 prep == 全新全量 prep");
    }

    /// 视口一致性：参数变更（缓存命中/重 prep 混合）后，视口 == settle 裁剪。
    #[test]
    fn viewport_matches_settle_crop_across_param_changes() {
        let _guard = FIXTURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (doc, _base, top, _top2, _mask) = fixture_request();
        let top_img = image::open(&top).unwrap().to_rgba8();
        let (tw, th) = (top_img.width(), top_img.height());

        let mut engine = DocEngine::new();
        let mut display = DisplayDocument::from_request(&doc);
        // 把第 1 组第 0 层换成 store（有像素、有调色、有链接蒙版——最复杂组合）
        for g in &mut display.groups {
            for l in &mut g.layers {
                if l.adjust.is_some() {
                    l.id = "L1".into();
                    l.source = PixelSource::Store;
                    l.pixel_width = tw;
                    l.pixel_height = th;
                    if let Some(m) = &mut l.mask {
                        if let MaskSource::File { matrix, .. } = &m.source {
                            m.source = MaskSource::Store { matrix: *matrix };
                        }
                    }
                }
            }
        }
        engine.apply_document(display.clone());
        engine
            .upload_region("L1", tw, th, 0, 0, tw, th, top_img.as_raw())
            .unwrap();
        let settle1 = engine.composite_settle().unwrap();
        let vp = engine.composite_viewport(8.0, 4.0, 40, 30, 1.0).unwrap();
        assert_same(&crop(&settle1, 8, 4, 40, 30), &vp, "视口 == settle 裁剪（初版）");

        // 参数变更（拖调色滑杆）：全量重 prep 后视口仍 == settle 裁剪
        let mut display2 = display.clone();
        for g in &mut display2.groups {
            for l in &mut g.layers {
                if l.id == "L1" {
                    l.adjust.as_mut().unwrap().brightness = -40.0;
                }
            }
        }
        engine.apply_document(display2);
        let settle2 = engine.composite_settle().unwrap();
        let vp2 = engine.composite_viewport(8.0, 4.0, 40, 30, 1.0).unwrap();
        assert_same(&crop(&settle2, 8, 4, 40, 30), &vp2, "视口 == settle 裁剪（调色后）");
        // 调色必须真的生效（两版 settle 不同——防"改了参数画面不动"的假引擎）
        assert_ne!(settle1.as_raw(), settle2.as_raw(), "参数变更必须改变输出");
    }

    /// 临时诊断（--ignored --nocapture）：逐字节找出 engine vs legacy 的首个分歧。
    #[test]
    #[ignore = "临时诊断"]
    fn dbg_layer_diff() {
        let (doc, _b, _t, _t2, _m) = fixture_request();
        let legacy = legacy_composite_document(&doc).unwrap();
        let mut engine = DocEngine::new();
        engine.apply_document(DisplayDocument::from_request(&doc));
        let got = engine.composite_settle().unwrap();
        let w = legacy.width() as usize;
        let diff = legacy
            .as_raw()
            .iter()
            .zip(got.as_raw())
            .position(|(a, b)| a != b)
            .map(|i| (i / 4 % w, i / 4 / w, i % 4, i / 4));
        println!("首差: {diff:?}");
        if let Some((x, y, c, pi)) = diff {
            let pi = pi as usize * 4;
            println!("legacy@({x},{y})ch{c}: {:?}", &legacy.as_raw()[pi..pi + 4]);
            println!("engine@({x},{y})ch{c}: {:?}", &got.as_raw()[pi..pi + 4]);
        }
        println!("dims: {:?} vs {:?}", legacy.dimensions(), got.dimensions());
    }
}
