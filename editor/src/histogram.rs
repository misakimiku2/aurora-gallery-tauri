//! 色阶/曲线编辑器的直方图(上游 photocraft ui-egui/src/tone.rs 移植,去 egui,
//! 只取 RGB 空间 4 组:复合亮度 + R + G + B)。
//!
//! 直方图不是引擎命令,是桥层对文档克隆合成计数:调整层编辑器看
//! [`HistSource::BelowLayer`](隐藏该调整层后的合成=调整实际收到的图像),
//! 整层直方图用 [`HistSource::Layer`](只显示该层分支)。像素按原值计数、
//! 从不做面积平均(平均缩略图会在边缘格发明出图像里没有的灰,#6538):
//! 大图用最近邻代理计数(cache level > 1),其余分带全量精确计数。

use photocraft_engine::doc::{Document, Layer, LayerId};
use rayon::prelude::*;

/// 一组 256-bin 直方图要看的像素范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistSource {
    /// 调整层下方的合成(该调整实际收到的输入)。
    BelowLayer(LayerId),
    /// 单个图层自身(隐藏其余全部分支)。
    Layer(LayerId),
}

/// RGB 空间的 4 组 256-bin 直方图:0=复合(R+G+B)/3,1..3=R/G/B。
pub type RgbHistograms = Vec<[u32; 256]>;

/// 只显示持有 `id` 的图层分支;返回 `id` 是否在 `layers` 里。
fn isolate(layers: &mut [Layer], id: LayerId) -> bool {
    let mut found = false;
    for l in layers.iter_mut() {
        let here = l.id == id || l.children_mut().is_some_and(|c| isolate(c, id));
        l.visible = here;
        found |= here;
    }
    found
}

/// `doc` 在 `source` 视角下的 RGB 直方图(复合 + R/G/B)。
pub fn compute_histograms(doc: &Document, source: HistSource) -> RgbHistograms {
    let mut h = vec![[0u32; 256]; 4];
    composite_bins(doc, source, &mut h);
    h
}

/// 合成计数的 cache level:1=每个文档像素都数了;更高=缩小的最近邻代理顶替
/// (Photoshop 直方图缓存层级口径)。空图/异常时 0。
fn composite_bins(doc: &Document, source: HistSource, h: &mut [[u32; 256]]) -> u32 {
    let mut d = doc.clone();
    match source {
        HistSource::BelowLayer(hide) => {
            if let Some(l) = d.layer_mut(hide) {
                l.visible = false;
            }
        }
        HistSource::Layer(id) => {
            isolate(&mut d.layers, id);
        }
    }
    let longest = d.size.width.max(d.size.height);
    let k = longest / 768;
    let (d, level) = if k >= 2
        && d.size.area() > photocraft_compose::PROXY_THUMBNAIL_PIXELS
        && photocraft_compose::proxy::proxy_faithful(&d)
    {
        (
            photocraft_compose::proxy::proxy_document(&d, k),
            k.next_power_of_two().ilog2() + 1,
        )
    } else {
        (d, 1)
    };
    let _ = photocraft_compose::render_bands(&d, d.bounds(), 0, |band| -> Result<(), ()> {
        let part = band
            .px
            .par_chunks(64 * 1024)
            .map(|px| {
                let mut part = vec![[0u32; 256]; h.len()];
                count_pixels(px, &mut part);
                part
            })
            .reduce(
                || vec![[0u32; 256]; h.len()],
                |mut a, b| {
                    for (dst, src) in a.iter_mut().zip(&b) {
                        for (x, y) in dst.iter_mut().zip(src) {
                            *x = x.saturating_add(*y);
                        }
                    }
                    a
                },
            );
        for (dst, src) in h.iter_mut().zip(&part) {
            for (a, b) in dst.iter_mut().zip(src) {
                *a = a.saturating_add(*b);
            }
        }
        Ok(())
    });
    level
}

/// 把 straight-alpha 合成像素按原值计数进 `h`(透明像素跳过);
/// 0=复合 (R+G+B)/3,1..3=R/G/B(上游 count_pixels 的 RGB 空间分支)。
fn count_pixels(px: &[[f32; 4]], h: &mut [[u32; 256]]) {
    let bin = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as usize;
    let mut add = |c: usize, b: usize| {
        if let Some(n) = h.get_mut(c).and_then(|ch| ch.get_mut(b)) {
            *n = n.saturating_add(1);
        }
    };
    for p in px {
        // NaN alpha 也跳过。
        if p[3].is_nan() || p[3] <= 0.0 {
            continue;
        }
        let q = [p[0], p[1], p[2]].map(bin);
        for (c, v) in q.iter().enumerate() {
            add(c + 1, *v);
        }
        add(0, (q[0] + q[1] + q[2]) / 3);
    }
}

/// 直方图的显示缩放:柱高 = v / top 钳到 1,线性对齐最高 bin(Photoshop 口径)。
/// 稀疏直方图不能按排序百分位取 top(少数量样本会被画成满高,#6574)。
pub fn histogram_scale_top(h: &[u32; 256]) -> f32 {
    h.iter().copied().max().unwrap_or(1).max(1) as f32 * 1.1
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 调整层下方直方图看的是调整收到的图像,不是调整结果:
    /// 白图 + 反相调整层,直方图在白处有值、黑处为 0。
    #[test]
    fn below_layer_ignores_the_edited_adjustment() {
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 64})).unwrap(); // white
        s.execute("layer.newAdjustmentLayer.invert", json!({})).unwrap();
        let st = s.active().unwrap();
        let h = compute_histograms(&st.doc, HistSource::BelowLayer(st.active_layer.unwrap()));
        assert!(h[0][255] > 0 && h[0][0] == 0, "sees the white image, not the inverted result");
    }

    /// 整层直方图只看该层:上方黑层不算进背景层的直方图。
    #[test]
    fn layer_source_sees_only_that_layer() {
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 32, "height": 32})).unwrap(); // white background
        let bg = s.active().unwrap().doc.layers[0].id;
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("select.rect", json!({"x": 0, "y": 0, "width": 32, "height": 32})).unwrap();
        s.execute("edit.fill", json!({"color": "#000000"})).unwrap();
        let st = s.active().unwrap();
        let h = compute_histograms(&st.doc, HistSource::Layer(bg));
        assert!(h[0][255] > 0 && h[0][0] == 0, "the black layer above is hidden");
    }

    /// 黑白对半图只数到 0 和 255 两级,不许有发明出来的中间灰(#6538),且每个像素都数到。
    #[test]
    fn split_image_counts_only_black_and_white() {
        for (w, hgt, split) in [(1000u32, 1000u32, 334u32), (777, 333, 389), (64, 64, 32)] {
            let mut s = photocraft_engine::Session::new();
            s.execute("file.new", json!({"width": w, "height": hgt})).unwrap();
            s.execute("layer.new.layer", json!({})).unwrap();
            s.execute("select.rect", json!({"x": 0, "y": 0, "width": split, "height": hgt})).unwrap();
            s.execute("edit.fill", json!({"color": "#000000"})).unwrap();
            s.execute("select.deselect", json!({})).unwrap();
            let st = s.active().unwrap();
            // 不存在的图层 id = 整图直方图(上游面板同口径 BelowLayer(u64::MAX))
            let h = compute_histograms(&st.doc, HistSource::BelowLayer(LayerId(u64::MAX)));
            for c in 0..4 {
                let stray: Vec<(usize, u32)> =
                    h[c].iter().copied().enumerate().filter(|&(i, v)| v > 0 && i != 0 && i != 255).collect();
                assert!(stray.is_empty(), "{w}x{hgt} split {split}, channel {c}: invented values {stray:?}");
                assert_eq!(u64::from(h[c][0]), u64::from(split) * u64::from(hgt), "black pixels");
                assert_eq!(u64::from(h[c][255]), u64::from(w - split) * u64::from(hgt), "white pixels");
            }
        }
    }

    /// 柱高线性对齐最高 bin:90/10 黑白图的小柱是大柱的 1/9,不是满高(#6574)。
    #[test]
    fn scale_is_proportional_for_two_level_images() {
        let mut h = [0u32; 256];
        h[0] = 100_000;
        h[255] = 900_000;
        let top = histogram_scale_top(&h);
        let small = (h[0] as f32 / top).min(1.0);
        let big = (h[255] as f32 / top).min(1.0);
        assert!((small / big - 1.0 / 9.0).abs() < 0.02);
    }

    /// 稀疏直方图的 top 不能退化成 1.1(几百个样本被画成和几十万一样高)。
    #[test]
    fn scale_does_not_degenerate_on_sparse_histograms() {
        let mut h = [0u32; 256];
        h[0] = 500_000;
        h[128] = 300;
        h[255] = 500_000;
        let top = histogram_scale_top(&h);
        assert!(top > h[128] as f32);
    }
}
