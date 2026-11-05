//! 导出为对话框(上游 crates/ui-egui/src/export_dialog.rs 的桥层移植,零引擎改动):
//! 临时 Session 克隆文档跑 `edit.convertToProfile`(srgb)→ `image.imageSize`(缩放+
//! 重采样)→ `layer.flattenImage`(不透明输出)三条命令定型文档克隆,**会话文档
//! 零改动**;预览=限边出图 RGBA,估计=内存编码报字节(≤40MP 精确,否则代理按像素
//! 数比例折算),落盘=photocraft_io::export+原子写。编码参数(质量/无损/元数据/
//! TGA 位深/ICC)照上游 settings→io_options 映射透传。

use photocraft_engine::doc::{Document, LayerId};
use photocraft_engine::Session;
use photocraft_geom::Rect;
use serde_json::{json, Value};

use crate::{EditorError, Rendered, Result};

/// 上游 RESAMPLE(export_preset_cmds);未知值报错不静默回退(上游同款口径)。
const RESAMPLE: [&str; 6] = [
    "bicubicAutomatic",
    "bicubic",
    "bicubicSmoother",
    "bicubicSharper",
    "bilinear",
    "nearest",
];
/// 上游 DEFAULT_RESAMPLE:Photoshop 的 Export As 默认两次立方(自动)。
const DEFAULT_RESAMPLE: &str = "bicubicAutomatic";
/// 上游 MAX_PX(`image.imageSize` 每边上限)。
pub const MAX_PX: f64 = 300_000.0;
/// 上游 EXACT_ESTIMATE_PX:不超过此像素数时大小估计走全量编码(精确),
/// 否则用代理编码按像素数比例折算。
const EXACT_ESTIMATE_PX: f64 = 40.0 * 1000.0 * 1000.0;
/// 预览/估计代理的长边上限(ICO 256;上游 preview_proxy)。
const PROXY_SIDE: u32 = 512;

fn s_f(f: &Value, k: &str) -> String {
    f.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn s_fmt(f: &Value) -> String {
    let v = s_f(f, "format");
    if v.is_empty() { "png".into() } else { v }
}

fn n_f(f: &Value, k: &str, d: f64) -> f64 {
    f.get(k).and_then(Value::as_f64).unwrap_or(d)
}

fn lossless(f: &Value) -> bool {
    f.get("lossless").and_then(Value::as_bool).unwrap_or(false)
}

/// 上游 export_resample:`v` 是 [`RESAMPLE`] 之一才放行(Export As 从不静默回退)。
fn export_resample(v: &str) -> std::result::Result<&'static str, String> {
    RESAMPLE
        .iter()
        .copied()
        .find(|k| *k == v)
        .ok_or_else(|| format!("resample must be one of {}", RESAMPLE.join(", ")))
}

/// 上游 resample_method:预览代理(max_side)重采样强制 bilinear 保性能,
/// nearest 除外——硬像素边正是选它的意义,且不额外花钱。
fn resample_method(f: &Value, max_side: Option<u32>) -> std::result::Result<String, String> {
    let chosen = match f.get("resample") {
        None | Some(Value::Null) => DEFAULT_RESAMPLE,
        Some(v) => export_resample(v.as_str().ok_or("resample must be a string")?)?,
    };
    Ok(if max_side.is_some() && chosen != "nearest" { "bilinear".into() } else { chosen.into() })
}

fn finite_px(v: f64) -> std::result::Result<f64, String> {
    if !v.is_finite() || !(1.0..=MAX_PX).contains(&v) {
        return Err(format!("export size must be within 1..={MAX_PX} pixels"));
    }
    Ok(v.round())
}

fn scaled_size(w: f64, h: f64, scale: f64) -> (f64, f64) {
    ((w * scale).round().max(1.0), (h * scale).round().max(1.0))
}

/// 上游 export_pixels(纯函数,测试钉死):显式 W/H 只在 pixels 模式生效;scale 模式
/// 按百分比逐边独立 round(永不低于 1);max_side 先压长边再 round。
pub fn export_pixels(src_w: f64, src_h: f64, f: &Value, max_side: Option<u32>) -> std::result::Result<(f64, f64), String> {
    let explicit = if s_f(f, "sizing") == "pixels" {
        f.get("width").and_then(Value::as_f64).zip(f.get("height").and_then(Value::as_f64))
    } else {
        None
    };
    let (mut w, mut h) = if let Some((w, h)) = explicit {
        (finite_px(w)?, finite_px(h)?)
    } else {
        let mut scale = n_f(f, "scale", 100.0) / 100.0;
        if !scale.is_finite() || scale <= 0.0 {
            return Err("export scale must be a positive number".into());
        }
        if let Some(m) = max_side {
            let long = src_w.max(src_h) * scale;
            if long > f64::from(m) {
                scale *= f64::from(m) / long;
            }
        }
        return Ok(scaled_size(src_w, src_h, scale));
    };
    if let Some(m) = max_side {
        let long = w.max(h);
        if long > f64::from(m) && long > 0.0 {
            (w, h) = scaled_size(w, h, f64::from(m) / long);
        }
    }
    Ok((w, h))
}

/// 上游 export_document:临时 Session 三条命令定型文档克隆。缩放判据与尺寸标签
/// 共用 [`export_pixels`]——标签写的就是要导出的真实尺寸。
fn export_stage(doc: &Document, f: &Value, max_side: Option<u32>) -> Result<Document> {
    let resample = resample_method(f, max_side).map_err(EditorError)?;
    let mut session = Session::new();
    session.add_document(doc.clone(), None);
    if s_f(f, "profile") == "srgb" && doc.icc_profile.is_some() {
        session.execute("edit.convertToProfile", json!({ "profile": "srgb", "intent": "perceptual" }))?;
    }
    let (w, h) = export_pixels(f64::from(doc.size.width), f64::from(doc.size.height), f, max_side).map_err(EditorError)?;
    if s_fmt(f) == "ico" && (w > 256.0 || h > 256.0) && max_side.is_none() {
        return Err(EditorError("ICO export is limited to 256 × 256 pixels; reduce the export scale".into()));
    }
    if (w - f64::from(doc.size.width)).abs() >= 1.0 || (h - f64::from(doc.size.height)).abs() >= 1.0 {
        session.execute("image.imageSize", json!({ "width": w, "height": h, "resample": resample }))?;
    }
    if !f.get("transparency").and_then(Value::as_bool).unwrap_or(true) || s_fmt(f) == "jpg" {
        session.execute("layer.flattenImage", json!({}))?;
    }
    Ok(session.active().ok_or_else(|| EditorError("export failed".into()))?.doc.as_ref().clone())
}

/// 上游 settings→ExportOptions 映射(io_options):质量只喂对应格式;Metadata: none
/// 连 EXIF/分辨率一起丢,exif 保 EXIF 丢 XMP 包,all 全保。
fn export_opts(f: &Value) -> photocraft_io::ExportOptions {
    let fmt = s_fmt(f);
    let quality = n_f(f, "quality", 85.0).clamp(1.0, 100.0) as u8;
    let metadata = s_f(f, "metadata");
    let mut opts = photocraft_io::ExportOptions::default();
    if fmt == "jpg" {
        opts.encode.jpeg_quality = quality;
    }
    opts.encode.webp_lossless = fmt != "webp" || lossless(f);
    if fmt == "webp" && !lossless(f) {
        opts.encode.webp_quality = quality;
    }
    opts.encode.embed_icc = f.get("embedProfile").and_then(Value::as_bool).unwrap_or(true);
    opts.encode.embed_metadata = metadata != "none";
    opts.xmp = if metadata == "all" { photocraft_io::XmpEmbed::All } else { photocraft_io::XmpEmbed::None };
    opts.tga_bits = if fmt == "tga" {
        s_f(f, "tgaBits").parse::<u64>().ok().and_then(photocraft_io::TgaBits::from_bits)
    } else {
        None
    };
    opts
}

/// 导出为预览响应:源尺寸(图层级=图层内容边界;前端以此种子 W/H 字段)+
/// 代理定型后的合成 RGBA。
pub struct ExportPreview {
    pub src_w: u32,
    pub src_h: u32,
    pub rendered: Rendered,
}

impl crate::EditorManager {
    /// 导出源:整图文档克隆,或图层级=单层独立文档(`layer_document`:内容边界
    /// 裁剪、蒙版已应用、编组整组合成、透明背景)。
    fn export_source(&mut self, doc: u64, layer: Option<u64>) -> Result<Document> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        match layer {
            Some(id) => {
                photocraft_engine::layer_menu_cmds::layer_document(&st.doc, LayerId(id))
                    .map_err(|e| EditorError(format!("export layer: {e}")))
            }
            None => Ok(st.doc.as_ref().clone()),
        }
    }

    /// 预览:代理(max_side,ICO 256)定型后的合成 RGBA。文档零改动。
    pub fn export_preview(&mut self, doc: u64, layer: Option<u64>, f: &Value) -> Result<ExportPreview> {
        let src = self.export_source(doc, layer)?;
        let (src_w, src_h) = (src.size.width, src.size.height);
        let staged = export_stage(&src, f, Some(if s_fmt(f) == "ico" { 256 } else { PROXY_SIDE }))?;
        let rect = Rect::from_xywh(0, 0, staged.size.width, staged.size.height);
        let img = photocraft_compose::render(&staged, rect).to_rgba8();
        Ok(ExportPreview { src_w, src_h, rendered: Rendered { width: img.width, height: img.height, pixels: img.pixels } })
    }

    /// 文件大小估计(上游 #6595):≤40MP 全量内存编码=精确;否则代理编码按像素数
    /// 比例折算。ICO 超限在精确路径报错(与落盘同源)。
    pub fn export_estimate(&mut self, doc: u64, layer: Option<u64>, f: &Value) -> Result<Value> {
        let src = self.export_source(doc, layer)?;
        let fmt = s_fmt(f);
        let (w, h) = export_pixels(f64::from(src.size.width), f64::from(src.size.height), f, None).map_err(EditorError)?;
        let full = w * h;
        if full <= EXACT_ESTIMATE_PX {
            let staged = export_stage(&src, f, None)?;
            let r = photocraft_io::export(&staged, &format!("estimate.{fmt}"), &export_opts(f))
                .map_err(|e| EditorError(format!("estimate: {e}")))?;
            return Ok(json!({ "bytes": r.bytes.len(), "exact": true }));
        }
        let proxy = export_stage(&src, f, Some(if fmt == "ico" { 256 } else { PROXY_SIDE }))?;
        let r = photocraft_io::export(&proxy, &format!("estimate.{fmt}"), &export_opts(f))
            .map_err(|e| EditorError(format!("estimate: {e}")))?;
        let small = (f64::from(proxy.size.width) * f64::from(proxy.size.height)).max(1.0);
        Ok(json!({ "bytes": (r.bytes.len() as f64 * full / small) as u64, "exact": false }))
    }

    /// 导出为(对话框确认):定型 + 编码落盘(原子写)。文档/会话路径零改动、
    /// 不入历史。返回 `{bytes,width,height,warnings}`。
    pub fn export_document_to(&mut self, doc: u64, layer: Option<u64>, path: &str, f: &Value) -> Result<Value> {
        let src = self.export_source(doc, layer)?;
        let staged = export_stage(&src, f, None)?;
        let r = photocraft_io::export(&staged, path, &export_opts(f))
            .map_err(|e| EditorError(format!("encode {path}: {e}")))?;
        photocraft_format::atomic_write(std::path::Path::new(path), &r.bytes)
            .map_err(|e| EditorError(format!("write {path}: {e}")))?;
        Ok(json!({ "bytes": r.bytes.len(), "width": staged.size.width, "height": staged.size.height, "warnings": r.warnings }))
    }
}
