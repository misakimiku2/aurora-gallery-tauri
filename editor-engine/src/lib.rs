//! Aurora 编辑器的 Rust 合成核心（管线换血阶段 1，设计见
//! `docs/编辑器管线换血-阶段1设计.md`）。
//!
//! ## 定位
//!
//! 文档状态 → 合成帧。**预览与导出走同一条合成代码**——"两端一致性"整类 bug 在这一层消失。
//!
//! 阶段 1 的合成算术复用 `aurora_core::imaging` 的原语（decode/调色/不透明度/蒙版/仿射/
//! 混合，各带自己的单测），engine 负责有状态的编排：解码缓存（拖滑杆不再反复解码）→
//! 参数指纹与区域渲染（阶段 1 内逐步加）→ 三档帧输出（M2）。
//! 合成顺序与算术与 legacy（src-tauri 旧实现，测试里保留为 parity 参照）逐字节一致——
//! parity 是本阶段的验收标尺，阶段 2 改 f32 内部算术时必须显式重定义误差口径。
//!
//! ## 地基（vendor 于 PhotoCraft v0.15.1，见 third-party/photocraft/README.md）
//!
//! - `photocraft-geom`：Rect/TileCoord（溢出安全）；
//! - `photocraft-color`：33 档混合公式（含 PS 实测修正与非分离 gamut 守卫）；
//! - `photocraft-raster`：256² 瓦片 + Arc COW 稀疏 Surface——阶段 2 像素真身的容器；
//!   瓦片 Arc 指针即内容指纹，是失效协议（revision + damage）的缓存键基础。
//!
//! 阶段 1 像素真身仍在前端位图仓（脏矩形上传进来），阶段 2 迁入 engine。

pub mod composite;
pub mod doc_engine;
pub mod payload;

pub use composite::{composite_document, composite_region, DocumentComposer, Region};
pub use doc_engine::{
    DocEngine, DisplayDocument, DisplayGroup, DisplayLayer, DisplayMask, MaskSource, PixelSource,
};
pub use payload::{
    apply_adjustments, AdjustRequest, CanvasRequest, DocumentRequest, LayerGroupRequest,
    LayerRequest, MaskRequest,
};

#[cfg(test)]
mod smoke {
    use photocraft_color::blend::{blend_rgb, BlendMode};
    use photocraft_color::PixelFormat;
    use photocraft_geom::Rect;
    use photocraft_raster::Surface;

    /// RGBA8 Surface 的写入/读出与默认像素语义——这是全引擎的存储地基，
    /// 口径必须与我们前端位图仓（canvas ImageData，非预乘）逐位一致。
    #[test]
    fn surface_rgba8_roundtrip() {
        let mut s = Surface::new(PixelFormat::RGBA8);
        let r = Rect::from_xywh(10, 20, 8, 6);
        let mut px = vec![0u8; 8 * 6 * 4];
        for (i, p) in px.chunks_exact_mut(4).enumerate() {
            p[0] = 200;
            p[1] = i as u8;
            p[2] = 40;
            p[3] = 255;
        }
        s.write_interleaved(r, &px);

        let mut out = vec![[0u8; 4]; 8 * 6];
        s.read_rgba8_into(r, &mut out);
        assert_eq!(out[0], [200, 0, 40, 255]);
        assert_eq!(out[47], [200, 47, 40, 255]);

        // 未触碰区域读默认像素（透明黑）——稀疏瓦片的语义
        let mut far = vec![[9u8; 4]; 1];
        s.read_rgba8_into(Rect::from_xywh(500, 500, 1, 1), &mut far);
        assert_eq!(far[0], [0, 0, 0, 0]);
    }

    /// with_default（Reveal-All 蒙版/白底场景用）+ fill_rect + 混合金值。
    /// 混合金值与 core `imaging::blend` 的单测同源——两个实现必须给同一个数。
    #[test]
    fn fill_and_blend_golden_values() {
        let mut s = Surface::with_default(PixelFormat::RGBA8, &[1.0, 1.0, 1.0, 1.0]);
        s.fill_rect(Rect::from_xywh(0, 0, 4, 4), &[1.0, 0.0, 0.0, 1.0]);
        let mut out = vec![[0u8; 4]; 16];
        s.read_rgba8_into(Rect::from_xywh(0, 0, 4, 4), &mut out);
        assert_eq!(out[0], [255, 0, 0, 255]);
        assert_eq!(out[15], [255, 0, 0, 255]);

        // Multiply：W3C 可分离公式
        let m = blend_rgb(BlendMode::Multiply, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
        assert!((m[0] - 0.25).abs() < 1e-5);
        // Hue（非可分离）：金值与 core imaging::blend 的 non_separable_golden_values 相同
        let h = blend_rgb(BlendMode::Hue, [0.8, 0.2, 0.2], [0.1, 0.1, 0.9]);
        assert!((h[0] - 0.314).abs() < 1e-3 && (h[2] - 0.914).abs() < 1e-3, "{h:?}");
    }
}
