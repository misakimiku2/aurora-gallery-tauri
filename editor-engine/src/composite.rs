//! 文档合成编排（阶段 1 自 `src-tauri/src/editor_commands.rs` 迁入）。
//!
//! ## 与 legacy 的关系（这是本文件最重要的约定）
//!
//! `composite_document` 的**合成顺序与算术必须与 legacy 逐字节一致**：
//! 解码 → 调色 → 不透明度 → 蒙版 → 仿射重采样 → 合成（顺序定死，防"顺手优化"；
//! 不透明度在重采样前——在 composite 里乘会连插值 alpha 再乘、边缘发暗，§6 第 14 条）。
//! 阶段 1 相对 legacy 的**唯一新增是解码缓存**（拖滑杆不再反复解码 24MP JPEG）；
//! `tests` 里有 parity 测试逐字节比对两者。阶段 2 引入 f32 内部算术时，parity
//! 允许的误差要在设计稿里显式定义，不能悄悄漂。
//!
//! 蒙版解链（`mask.matrix` 有值）：把蒙版 warp 到**图层内容空间**
//! （`inv(M_layer)·M_mask`）后仍走同一条 `apply_mask_image` 乘法——与 CSS 包裹
//! 渲染（A 壳 + B 壳的逆矩阵换算）数学同构，两端不各推一次。

use crate::payload::{apply_adjustments, parse_background, DocumentRequest};
use aurora_core::imaging::{self, AffineMatrix, BlendMode, CanvasBackground};
use image::RgbaImage;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

/// 解码缓存：路径 → (mtime, 解码图)。**命中条件含 mtime**——文件被重写（画笔烘焙
/// 原地覆写同一文件名）必须重新解码，不然显示的是旧像素。
///
/// 存 `Arc` 取用时 clone：24MP memcpy ≈ 几十 ms，仍比重新解码（几百 ms）便宜一个量级；
/// 阶段 2 像素真身迁入 engine（COW 瓦片）后这层克隆消失。
struct DecodedCache {
    entries: HashMap<String, (SystemTime, Arc<RgbaImage>)>,
    order: Vec<String>,
    capacity: usize,
}

impl DecodedCache {
    fn new(capacity: usize) -> Self {
        Self { entries: HashMap::new(), order: Vec::new(), capacity: capacity.max(1) }
    }

    fn get(&mut self, path: &str) -> Result<RgbaImage, String> {
        let mtime = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok(); // 读不到 mtime（文件正被写/权限）：不缓存，直接解码
        if let Some(mtime) = mtime {
            if let Some((cached_at, img)) = self.entries.get(path) {
                if *cached_at == mtime {
                    return Ok((**img).clone());
                }
            }
        }
        let img = Arc::new(imaging::decode_file(path).map_err(|e| e.to_string())?);
        let out = (*img).clone();
        if let Some(mtime) = mtime {
            if !self.entries.contains_key(path) {
                self.order.push(path.to_string());
            }
            if self.order.len() > self.capacity {
                let evict = self.order.remove(0);
                self.entries.remove(&evict);
            }
            self.entries.insert(path.to_string(), (mtime, img));
        }
        Ok(out)
    }
}

/// 合成状态持有者（阶段 1 = 解码缓存；阶段 2 扩展为图层参数指纹 + Surface 缓存）。
pub struct DocumentComposer {
    cache: DecodedCache,
}

impl DocumentComposer {
    pub fn new() -> Self {
        Self { cache: DecodedCache::new(8) }
    }

    /// 公开解码口（doc_engine 的 File 模式图层/蒙版走这里——与无状态编排共用同一缓存）。
    pub fn decode(&mut self, path: &str) -> Result<RgbaImage, String> {
        self.cache.get(path)
    }
}

impl Default for DocumentComposer {
    fn default() -> Self {
        Self::new()
    }
}

/// 按文档状态合成出全分辨率 RGBA（预览/导出/帧输出共用这一条路）。
pub fn composite_document(
    composer: &mut DocumentComposer,
    doc: &DocumentRequest,
) -> Result<RgbaImage, String> {
    let (decoded, group_specs) = prep_document(composer, doc)?;
    let groups = build_groups(&decoded, &group_specs, |m| m);
    imaging::composite_grouped(
        doc.canvas.width,
        doc.canvas.height,
        parse_background(doc.canvas.background.as_deref()),
        &groups,
    )
    .map_err(|e| e.to_string())
}

/// 视口区域：文档空间的原点（可为小数——zoom<100% 时前端视口原点落在文档像素之间）
/// + 输出尺寸 + 缩放（1 = 文档像素 1:1；<1 = 一屏塞下更多文档）。
#[derive(Debug, Clone, Copy)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// 只合成文档的一个矩形区域（视口帧的核心：24MP 文档在 400% 缩放下可见区域只有
/// 几十万像素）。数学：区域画布上的层矩阵 = S(s) ∘ T(-o) ∘ M——dest 像素 (x,y)
/// 采样 doc 点 (o + (x,y)/s)，与"全量渲染再裁剪"在 s=1 且 o 为整数时**逐位一致**
/// （bilinear 采样坐标完全相同，parity 测试锁住）。
pub fn composite_region(
    composer: &mut DocumentComposer,
    doc: &DocumentRequest,
    region: Region,
) -> Result<RgbaImage, String> {
    if region.width == 0 || region.height == 0 {
        return Err("区域尺寸为 0".into());
    }
    let scale = if region.scale > 0.0 { region.scale } else { 1.0 };
    let (decoded, group_specs) = prep_document(composer, doc)?;
    let shift = move |m: AffineMatrix| {
        let t = AffineMatrix::from_array([1.0, 0.0, 0.0, 1.0, -region.x, -region.y]);
        let s = AffineMatrix::from_array([scale, 0.0, 0.0, scale, 0.0, 0.0]);
        AffineMatrix::concat(s, AffineMatrix::concat(t, m))
    };
    let groups = build_groups(&decoded, &group_specs, shift);
    imaging::composite_grouped(
        region.width,
        region.height,
        parse_background(doc.canvas.background.as_deref()),
        &groups,
    )
    .map_err(|e| e.to_string())
}

/// 组员预处理：解码（缓存）→ 调色 → 不透明度 → 蒙版（顺序契约见文件头），
/// 产出扁平解码图 + 组规格；矩阵换算留给调用方（全量 / 区域两条入口共用）。
fn prep_document(
    composer: &mut DocumentComposer,
    doc: &DocumentRequest,
) -> Result<(Vec<RgbaImage>, Vec<(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)>), String>
{
    let mut decoded: Vec<RgbaImage> = Vec::new();
    let mut group_specs: Vec<(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)> =
        Vec::new();
    for g in &doc.groups {
        let mut members = Vec::new();
        for l in &g.layers {
            let mut img = apply_adjustments(composer.cache.get(&l.path)?, l.adjust);
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
                            let mask_img = composer.cache.get(&mask_req.path)?;
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
    Ok((decoded, group_specs))
}

/// 组规格 → `CompositeGroup`；`map_matrix` 供区域合成换算矩阵（全量入口传恒等）。
fn build_groups<'a>(
    decoded: &'a [RgbaImage],
    group_specs: &[(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)],
    map_matrix: impl Fn(AffineMatrix) -> AffineMatrix,
) -> Vec<imaging::CompositeGroup<'a>> {
    group_specs
        .iter()
        .map(|(opacity, blend, members)| imaging::CompositeGroup {
            opacity: *opacity,
            blend: *blend,
            layers: members
                .iter()
                .map(|(idx, matrix, blend, clipped)| imaging::CompositeLayer {
                    src: &decoded[*idx],
                    matrix: map_matrix(*matrix),
                    blend: *blend,
                    clipped: *clipped,
                })
                .collect(),
        })
        .collect()
}

/// legacy 参照：迁入前的 `composite_document` 原样（无缓存、每次直接解码）。
/// test-only 保留——parity 的标尺，阶段 2 改内部算术时这里的口径必须显式重定义。
#[cfg(test)]
pub(crate) fn legacy_composite_document(doc: &DocumentRequest) -> Result<RgbaImage, String> {
    let mut decoded: Vec<RgbaImage> = Vec::new();
    let mut group_specs: Vec<(u8, BlendMode, Vec<(usize, AffineMatrix, BlendMode, bool)>)> =
        Vec::new();
    for g in &doc.groups {
            let mut members = Vec::new();
            for l in &g.layers {
                let mut img = apply_adjustments(
                    imaging::decode_file(&l.path).map_err(|e| e.to_string())?,
                    l.adjust,
                );
                imaging::apply_opacity(&mut img, l.opacity.unwrap_or(100).min(100));
                if let Some(mask_req) = &l.mask {
                    if !mask_req.path.is_empty() {
                        match mask_req.matrix {
                            None => imaging::apply_mask(&mut img, &mask_req.path)
                                .map_err(|e| e.to_string())?,
                            Some(mask_matrix) => {
                                let layer_matrix = AffineMatrix::from_array(l.matrix);
                                let to_local = AffineMatrix::concat(
                                    layer_matrix.invert().map_err(|e| e.to_string())?,
                                    AffineMatrix::from_array(mask_matrix),
                                );
                                let mask_img = imaging::decode_file(&mask_req.path)
                                    .map_err(|e| e.to_string())?;
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
        imaging::composite_grouped(
            doc.canvas.width,
            doc.canvas.height,
            parse_background(doc.canvas.background.as_deref()),
            &groups,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    //! parity 测试：引擎合成 vs legacy 参照实现（上方的 test-only 函数）
    //! + 解码缓存一致性 + 区域合成与引擎状态机的一致性。

    use super::*;
    use aurora_core::imaging::EncodeFormat;
    use std::path::PathBuf;

    // ---- fixtures ----

    fn fixture_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-engine-parity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建 fixture 目录");
        dir
    }

    /// 确定性渐变图（每个 (x,y) 的颜色是坐标的函数）。
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

    /// 半透明形状：左半不透明红、右半 alpha 渐隐——剪贴/混合的边缘行为都要吃得到。
    fn alpha_shape(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for (x, _, p) in img.enumerate_pixels_mut() {
            let a = if x < w / 2 { 255u8 } else { 255 - ((x - w / 2) as u16 * 255 / (w / 2) as u16) as u8 };
            p.0 = [200, 30, 30, a];
        }
        img
    }

    fn write_png(name: &str, img: &RgbaImage) -> String {
        let bytes = imaging::encode(img, EncodeFormat::Png, 0).expect("编码 fixture PNG");
        let path = fixture_dir().join(name);
        std::fs::write(&path, &bytes).expect("写 fixture");
        // JSON 字符串里不能出现裸反斜杠（\U 是非法转义）：统一成正斜杠，
        // Windows 的文件 API 原生接受
        path.to_string_lossy().replace('\\', "/")
    }

    /// 蒙版图：亮度渐变（对角线从黑到白）+ 一角全黑。
    fn mask_image(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let l = ((x + y) * 255 / (w + h) as u32) as u8;
            let v = if x < w / 8 && y < h / 8 { 0 } else { l };
            p.0 = [v, v, v, 255];
        }
        img
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

    fn run_parity(json: &str, what: &str) {
        let doc: DocumentRequest = serde_json::from_str(json).expect("载荷反序列化");
        let legacy = legacy_composite_document(&doc).expect("legacy 合成失败");
        let mut composer = DocumentComposer::new();
        let engine = composite_document(&mut composer, &doc).expect("engine 合成失败");
        assert_same(&legacy, &engine, what);
        // 热缓存二跑：命中缓存路径也必须逐字节一致
        let engine_warm = composite_document(&mut composer, &doc).expect("engine 热缓存合成失败");
        assert_same(&engine, &engine_warm, &format!("{what}: 热缓存"));
    }

    // ---- parity 用例 ----

    #[test]
    fn parity_single_layer() {
        let base = write_png("parity-base.png", &gradient(64, 48, 1));
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"white"}},
                "groups":[{{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}}]}}"#
        );
        run_parity(&json, "单层");
    }

    #[test]
    fn parity_blend_opacity_adjust() {
        let base = write_png("parity-base2.png", &gradient(64, 48, 2));
        let top = write_png("parity-top.png", &alpha_shape(32, 24));
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"transparent"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"layers":[{{"path":"{top}","matrix":[1.5,0,0,1.5,8,6],
                     "adjust":{{"brightness":20,"contrast":10,"saturation":-30,"temperature":15}},
                     "opacity":60,"blend":"multiply"}}]}}
                ]}}"#
        );
        run_parity(&json, "混合+不透明度+调色");
    }

    #[test]
    fn parity_group_clipped_linked_and_unlinked_masks() {
        let base = write_png("parity-base3.png", &gradient(64, 48, 3));
        let top = write_png("parity-top2.png", &alpha_shape(32, 24));
        let top2 = write_png("parity-top3.png", &alpha_shape(40, 20));
        let mask = write_png("parity-mask.png", &mask_image(32, 24));
        // 组 2：链接蒙版层 → 剪贴进它的成员 → 解链蒙版层（自己的矩阵）
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"black"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"opacity":85,"blend":"screen","layers":[
                    {{"path":"{top}","matrix":[1.2,0,0,1.2,6,4],
                      "mask":{{"path":"{mask}","matrix":null}}}},
                    {{"path":"{top2}","matrix":[0.8,0,0,0.8,10,10],"clipped":true,
                      "opacity":70,"blend":"hue"}},
                    {{"path":"{top}","matrix":[1,0,0,1,20,16],
                      "mask":{{"path":"{mask}","matrix":[0.5,0,0,0.5,8,4]}}}}
                  ]}}
                ]}}"#
        );
        run_parity(&json, "组+剪贴+链接/解链蒙版");
    }

    /// serde 形状抽查：camelCase 的 adjust、blend 字符串档位（含非可分离 hue）
    /// 都要进得了 engine 的载荷——IPC 契约的 engine 侧镜像。
    #[test]
    fn payload_reads_camel_case_and_blend_strings() {
        let base = write_png("parity-base4.png", &gradient(16, 16, 4));
        let json = format!(
            r#"{{"canvas":{{"width":16,"height":16,"background":null}},
                "groups":[{{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0],
                  "adjust":{{"brightness":5}},"blend":"hue"}}]}}]}}"#
        );
        let doc: DocumentRequest = serde_json::from_str(&json).expect("camelCase 载荷必须可解析");
        let layer = &doc.groups[0].layers[0];
        assert_eq!(layer.adjust.map(|a| a.brightness), Some(5.0));
        assert_eq!(layer.blend.as_deref(), Some("hue"));
        assert_eq!(BlendMode::parse("hue"), BlendMode::Hue, "非可分离档位必须进得了 parse");
    }

    // ---- 区域合成 parity（视口帧的正确性标尺）----

    fn crop(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> RgbaImage {
        let mut out = RgbaImage::new(w, h);
        for dy in 0..h {
            for dx in 0..w {
                out.put_pixel(dx, dy, img.get_pixel(x + dx, y + dy).0.into());
            }
        }
        out
    }

    /// 最复杂的载荷（组+剪贴+链接/解链蒙版）上验证：区域合成（整数原点、s=1）
    /// == 全量渲染再裁剪，逐字节。这是"视口帧与 settle 帧所见即所得"的数学根基。
    #[test]
    fn region_matches_full_render_crop() {
        let base = write_png("region-base.png", &gradient(64, 48, 5));
        let top = write_png("region-top.png", &alpha_shape(32, 24));
        let top2 = write_png("region-top2.png", &alpha_shape(40, 20));
        let mask = write_png("region-mask.png", &mask_image(32, 24));
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"black"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"opacity":85,"blend":"screen","layers":[
                    {{"path":"{top}","matrix":[1.2,0,0,1.2,6,4],
                      "mask":{{"path":"{mask}","matrix":null}}}},
                    {{"path":"{top2}","matrix":[0.8,0,0,0.8,10,10],"clipped":true,
                      "opacity":70,"blend":"hue"}},
                    {{"path":"{top}","matrix":[1,0,0,1,20,16],
                      "mask":{{"path":"{mask}","matrix":[0.5,0,0,0.5,8,4]}}}}
                  ]}}
                ]}}"#
        );
        let doc: DocumentRequest = serde_json::from_str(&json).unwrap();
        let full = legacy_composite_document(&doc).unwrap();

        for (rx, ry, rw, rh) in [(0u32, 0u32, 64u32, 48u32), (8, 4, 40, 30), (30, 20, 20, 16)] {
            let mut composer = DocumentComposer::new();
            let region = composite_region(
                &mut composer,
                &doc,
                Region { x: rx as f64, y: ry as f64, width: rw, height: rh, scale: 1.0 },
            )
            .unwrap();
            assert_same(&crop(&full, rx, ry, rw, rh), &region, &format!("region ({rx},{ry},{rw},{rh})"));
        }
    }

    // ---- 上机基准（#[ignore]，手动跑）----

    /// 设计稿 §9 留的两个未知数在这里出数：
    /// `cargo test --release --offline -- --ignored --nocapture bench_region`
    /// 输出：Tier A 的 24MP JPEG 编码耗时（settle 帧落盘的成本）与
    /// Tier B 的区域合成收益（视口帧 vs 全量，决定交互帧的帧率上限）。
    #[test]
    #[ignore = "上机基准：release + --ignored --nocapture 手动跑"]
    fn bench_region_vs_full_and_jpeg_encode() {
        // 6000×4000 = 24MP 三层文档（一层带链接蒙版 + 一层混合）
        let (w, h) = (6000u32, 4000u32);
        let base = write_png("bench-base.png", &gradient(w, h, 7));
        let top = write_png("bench-top.png", &alpha_shape(w / 2, h / 2));
        let top2 = write_png("bench-top2.png", &alpha_shape(w / 3, h / 3));
        let mask = write_png("bench-mask.png", &mask_image(w / 2, h / 2));
        let json = format!(
            r#"{{"canvas":{{"width":{w},"height":{h},"background":"white"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"layers":[
                    {{"path":"{top}","matrix":[1,0,0,1,500,400],"blend":"multiply",
                      "mask":{{"path":"{mask}","matrix":null}}}},
                    {{"path":"{top2}","matrix":[0.5,0,0,0.5,3000,2500],"blend":"screen","opacity":70}}
                  ]}}
                ]}}"#
        );
        let doc: DocumentRequest = serde_json::from_str(&json).unwrap();
        let mut composer = DocumentComposer::new();

        let t0 = std::time::Instant::now();
        let full = composite_document(&mut composer, &doc).unwrap();
        let full_t = t0.elapsed();

        let t1 = std::time::Instant::now();
        let region = composite_region(
            &mut composer,
            &doc,
            Region { x: 2200.0, y: 1500.0, width: 1600, height: 1000, scale: 1.0 },
        )
        .unwrap();
        let region_t = t1.elapsed();

        // 热缓存下区域与全量必须仍逐位一致（bench 顺手当 parity 用）
        assert_same(&crop(&full, 2200, 1500, 1600, 1000), &region, "bench region");

        let t2 = std::time::Instant::now();
        let jpeg = imaging::encode(&full, EncodeFormat::Jpeg, 92).unwrap();
        let jpeg_t = t2.elapsed();

        println!("== M2 基准（24MP × 3 层） ==");
        println!("全量合成:        {full_t:?}");
        println!("区域合成 1600×1000: {region_t:?}");
        println!("24MP JPEG q92 编码: {jpeg_t:?}（{} KB）", jpeg.len() / 1024);
    }

    /// 缩放区域（zoom<100% 的形态）：s=0.5、原点 (0,0) 的区域渲染 ==
    /// "所有矩阵 ×0.5、画布减半"的全量渲染的左上裁剪。
    #[test]
    fn scaled_region_matches_scaled_full_render() {
        let base = write_png("sregion-base.png", &gradient(64, 48, 6));
        let top = write_png("sregion-top.png", &alpha_shape(32, 24));
        let json = format!(
            r#"{{"canvas":{{"width":64,"height":48,"background":"white"}},
                "groups":[
                  {{"layers":[{{"path":"{base}","matrix":[1,0,0,1,0,0]}}]}},
                  {{"layers":[{{"path":"{top}","matrix":[2,0,0,2,4,4],"blend":"multiply","opacity":80}}]}}
                ]}}"#
        );
        let orig: DocumentRequest = serde_json::from_str(&json).unwrap();

        // 缩放全量参照：画布与全部矩阵 ×0.5（与 S(0.5)∘T(0)∘M 的区域矩阵同一几何）
        let mut scaled = orig.clone();
        scaled.canvas.width = 32;
        scaled.canvas.height = 24;
        for g in &mut scaled.groups {
            for l in &mut g.layers {
                let m = l.matrix;
                l.matrix = [m[0] * 0.5, m[1] * 0.5, m[2] * 0.5, m[3] * 0.5, m[4] * 0.5, m[5] * 0.5];
            }
        }
        let scaled_full = legacy_composite_document(&scaled).unwrap();

        let mut composer = DocumentComposer::new();
        let region = composite_region(
            &mut composer,
            &orig,
            Region { x: 0.0, y: 0.0, width: 32, height: 24, scale: 0.5 },
        )
        .unwrap();
        assert_same(&scaled_full, &region, "缩放区域");
    }
}
