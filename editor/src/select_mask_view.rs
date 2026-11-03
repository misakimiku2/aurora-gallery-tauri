//! Select and Mask 对话框的预览(上游 ui-egui/src/select_mask_view.rs 移植,去 egui 化):
//! 文档降采样为 proxy(1/k)→ 精修(内联 Session 跑 select.refineEdge,输出强制
//! selection、去污关、radius/feather/笔划 ÷k)→ 七种视图改写 proxy 文档(覆盖 veil 层/
//! 活动层蒙版,蚂蚁线选区恒随行)→ 渲染 RGBA + 精修选区轮廓(坐标 ×k 回文档空间)。
//! 对话框的 OK 走引擎 select.refineEdge 正式提交(一步 "Select and Mask");预览零改动。

use photocraft_algo::matting;
use photocraft_algo::selection::mask_from_surface;
use photocraft_color::{Color, PixelFormat};
use photocraft_engine::doc::{Document, Fill, Layer, LayerContent, LayerId, LayerMask};
use photocraft_geom::Rect;
use photocraft_raster::Surface;
use serde_json::{Value, json};

use crate::outline;

/// The engine command behind Select › Select and Mask….
pub const COMMAND: &str = "select.refineEdge";

/// 视图模式(上游 Mode;F 键按 ALL 顺序循环)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    OnionSkin,
    MarchingAnts,
    Overlay,
    OnBlack,
    OnWhite,
    BlackWhite,
    OnLayers,
}

impl Mode {
    pub const ALL: [Mode; 7] = [
        Mode::OnionSkin,
        Mode::MarchingAnts,
        Mode::Overlay,
        Mode::OnBlack,
        Mode::OnWhite,
        Mode::BlackWhite,
        Mode::OnLayers,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Mode::OnionSkin => "onionSkin",
            Mode::MarchingAnts => "marchingAnts",
            Mode::Overlay => "overlay",
            Mode::OnBlack => "onBlack",
            Mode::OnWhite => "onWhite",
            Mode::BlackWhite => "blackWhite",
            Mode::OnLayers => "onLayers",
        }
    }

    pub fn from_id(id: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.id() == id)
    }

    /// 该视图的默认不透明度(%;None=无)。
    pub fn default_opacity(self) -> Option<f32> {
        match self {
            Mode::OnionSkin | Mode::Overlay => Some(50.0),
            Mode::OnBlack | Mode::OnWhite => Some(100.0),
            Mode::MarchingAnts | Mode::BlackWhite | Mode::OnLayers => None,
        }
    }
}

/// 预览请求的视图参数(上游 View)。
#[derive(Clone, Copy, Debug)]
pub struct View {
    pub mode: Mode,
    pub opacity: f32,
    pub show_edge: bool,
    pub show_original: bool,
}

/// 一次预览的产物。
pub struct ViewResult {
    pub width: u32,
    pub height: u32,
    /// 合成视图的 RGBA8(代理分辨率 = 文档 1/k)。
    pub rgba: Vec<u8>,
    /// 精修选区的蚂蚁线段(文档坐标,已 ×k 放回;[x0,y0,x1,y1] 平铺)。
    pub outline: Vec<[i32; 4]>,
    /// 代理的 k(调用方换算位图→文档缩放)。
    pub k: u32,
}

/// 降采样因子(上游 proxy::factor:≤2×预览预算=1,否则 sqrt 上取整,≥2)。
pub fn factor(doc: &Document) -> u32 {
    const PREVIEW_PIXELS: u64 = 2_500_000;
    let px = doc.size.area();
    if px <= PREVIEW_PIXELS * 2 {
        return 1;
    }
    (((px as f64) / PREVIEW_PIXELS as f64).sqrt().ceil() as u32).max(2)
}

/// 像素长度参数(radius/feather)按 k 折算(上游 length)。
fn length(params: &Value, key: &str, k: u32) -> f64 {
    params.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0).max(0.0) / f64::from(k.max(1))
}

/// 单通道覆盖度:area 内为 values,其余为 outside(上游 Coverage)。
struct Coverage {
    area: Rect,
    values: Vec<f32>,
    outside: f32,
}

impl Coverage {
    fn empty() -> Coverage {
        Coverage { area: Rect::EMPTY, values: Vec::new(), outside: 0.0 }
    }

    /// 读选区/图层蒙版(默认像素外扩时 area 取整画布,否则取内容界)。
    fn read(s: Option<&Surface>, canvas: Rect) -> Coverage {
        let Some(s) = s else { return Coverage::empty() };
        let outside = s.default_pixel().first().copied().unwrap_or(0.0).clamp(0.0, 1.0);
        let area = if outside == 0.0 { s.content_bounds().intersect(&canvas) } else { canvas };
        Coverage { area, values: mask_from_surface(Some(s), area), outside }
    }

    /// `s` 边缘两侧 r px 的带(grown−shrunk,Show Edge 用)。
    fn edge_band(s: Option<&Surface>, canvas: Rect, r: usize) -> Coverage {
        let Some(s) = s else { return Coverage::empty() };
        let reach = i32::try_from(r).unwrap_or(i32::MAX).saturating_add(1);
        let outside = s.default_pixel().first().copied().unwrap_or(0.0);
        let area = if outside == 0.0 { s.content_bounds().inflate(reach).intersect(&canvas) } else { canvas };
        let (w, h) = (area.width() as usize, area.height() as usize);
        let values = mask_from_surface(Some(s), area);
        let grown = matting::morph(&values, w, h, r, true);
        let shrunk = matting::morph(&values, w, h, r, false);
        if grown.len() != values.len() || shrunk.len() != values.len() {
            return Coverage::empty();
        }
        Coverage { area, values: grown.iter().zip(&shrunk).map(|(g, s)| (g - s).clamp(0.0, 1.0)).collect(), outside: 0.0 }
    }

    fn at(&self, x: i32, y: i32) -> f32 {
        if !self.area.contains(x, y) {
            return self.outside;
        }
        let i = (y - self.area.y0) as usize * self.area.width() as usize + (x - self.area.x0) as usize;
        self.values.get(i).copied().unwrap_or(self.outside)
    }

    /// GRAY8 蒙版面,f(coverage)(上游 surface)。
    fn surface(&self, f: impl Fn(f32) -> f32) -> Surface {
        let g = |v: f32| f(v).clamp(0.0, 1.0);
        let mut s = Surface::with_default(PixelFormat::GRAY8, &[g(self.outside)]);
        if !self.area.is_empty() && self.values.len() == self.area.width() as usize * self.area.height() as usize {
            let bytes: Vec<u8> = self.values.iter().map(|v| (g(*v) * 255.0).round() as u8).collect();
            s.write_interleaved(self.area, &bytes);
        }
        s
    }
}

/// 内联 Session 跑 select.refineEdge,输出强制 selection(上游 refine;vendor 无
/// set_inline_job_ctx,不支持中途取消——前端泵串行调用,天然无并发)。
fn refine(proxy: &Document, active: Option<LayerId>, params: &Value, k: u32) -> Option<Option<Surface>> {
    let mut s = photocraft_engine::Session::new();
    s.add_document(proxy.clone(), None);
    if let Some(id) = active {
        s.select_layer(id).ok()?;
    }
    let mut p = params.as_object().cloned().unwrap_or_default();
    p.retain(|key, _| !key.starts_with("__"));
    p.insert("output".into(), json!("selection"));
    p.insert("decontaminate".into(), json!(false));
    for key in ["radius", "feather"] {
        if p.contains_key(key) {
            p.insert(key.into(), json!(length(params, key, k)));
        }
    }
    if let Some(strokes) = p.get("refineStrokes").and_then(Value::as_array).cloned() {
        let kf = f64::from(k.max(1));
        let scaled: Vec<Value> = strokes
            .into_iter()
            .map(|mut s| {
                if let Some(o) = s.as_object_mut() {
                    if let Some(size) = o.get("size").and_then(Value::as_f64) {
                        o.insert("size".into(), json!((size / kf).max(1.0)));
                    }
                    if let Some(pts) = o.get_mut("points").and_then(Value::as_array_mut) {
                        for pt in pts.iter_mut() {
                            if let Some(xy) = pt.as_array_mut() {
                                xy.iter_mut().for_each(|v| {
                                    if let Some(n) = v.as_f64() {
                                        *v = json!(n / kf);
                                    }
                                });
                            }
                        }
                    }
                }
                s
            })
            .collect();
        p.insert("refineStrokes".into(), Value::Array(scaled));
    }
    s.execute(COMMAND, Value::Object(p)).ok()?;
    Some(s.active()?.doc.selection.clone())
}

/// 实心填充 veil 层(上游 veil)。
fn veil(name: &str, color: Color, opacity: f32, mask: Option<Surface>) -> Layer {
    let mut l = Layer::new(name, LayerContent::Fill(Fill::Solid(color)));
    l.opacity = opacity;
    l.mask = mask.map(|surface| LayerMask { surface, ..LayerMask::reveal_all() });
    l
}

/// 把 proxy 文档改写成 `view` 下的 `coverage` 展示(上游 show)。
fn show(doc: &mut Document, active: Option<LayerId>, view: &View, coverage: &Coverage) {
    let o = view.opacity;
    doc.selection = Some(coverage.surface(|v| v));
    match view.mode {
        Mode::MarchingAnts => {}
        Mode::Overlay => doc.layers.push(veil("Overlay", Color::rgb(1.0, 0.0, 0.0), o, Some(coverage.surface(|v| 1.0 - v)))),
        Mode::OnBlack => doc.layers.push(veil("On Black", Color::BLACK, o, Some(coverage.surface(|v| 1.0 - v)))),
        Mode::OnWhite => doc.layers.push(veil("On White", Color::WHITE, o, Some(coverage.surface(|v| 1.0 - v)))),
        Mode::BlackWhite => {
            doc.layers.push(veil("Black", Color::BLACK, 1.0, None));
            doc.layers.push(veil("White", Color::WHITE, 1.0, Some(coverage.surface(|v| v))));
        }
        Mode::OnLayers | Mode::OnionSkin => {
            let Some(id) = active else { return };
            if view.mode == Mode::OnionSkin {
                // 只留被蒙版处理的层(含其组/内容)可见(上游同款路径互斥)
                if let Some(path) = doc.path_of(id) {
                    let others: Vec<LayerId> =
                        doc.walk().into_iter().filter(|(p, _, _)| !path.starts_with(p) && !p.starts_with(&path)).map(|(_, _, l)| l.id).collect();
                    for other in others {
                        if let Some(l) = doc.layer_mut(other) {
                            l.visible = false;
                        }
                    }
                }
            }
            let keep = if view.mode == Mode::OnionSkin { 1.0 - o } else { 0.0 };
            let surface = coverage.surface(|v| v + (1.0 - v) * keep);
            if let Some(l) = doc.layer_mut(id) {
                l.mask = Some(LayerMask { surface, ..LayerMask::reveal_all() });
            }
        }
    }
}

/// Select and Mask 预览:代理文档按 `view` 展示精修后的选区(上游 preview_document)。
/// 返回合成 RGBA(代理分辨率)+ 精修选区轮廓(×k 回文档空间)。
pub fn preview_view(doc: &Document, active: Option<LayerId>, params: &Value, view: &View) -> Result<ViewResult, String> {
    let k = factor(doc);
    let mut proxy = photocraft_compose::proxy::proxy_document(doc, k);
    let active = active.filter(|id| proxy.layer(*id).is_some());
    // 起点:选区,否则活动层蒙版(引擎命令同口径)
    let original = proxy
        .selection
        .clone()
        .or_else(|| active.and_then(|id| proxy.layer(id)).and_then(|l| l.mask.as_ref()).map(|m| m.surface.clone()));
    let canvas = Rect::new(0, 0, proxy.size.width as i32, proxy.size.height as i32);
    let coverage = if view.show_edge {
        Coverage::edge_band(original.as_ref(), canvas, length(params, "radius", k).round().clamp(1.0, 250.0) as usize)
    } else if view.show_original {
        Coverage::read(original.as_ref(), canvas)
    } else {
        match refine(&proxy, active, params, k) {
            Some(sel) => Coverage::read(sel.as_ref(), canvas),
            None => return Err("refine failed".into()),
        }
    };
    show(&mut proxy, active, view, &coverage);
    let rect = Rect::new(0, 0, proxy.size.width as i32, proxy.size.height as i32);
    let img = photocraft_compose::render(&proxy, rect).to_rgba8();
    // 蚂蚁线:代理选区轮廓(step=1 代理分辨率),坐标 ×k 回文档空间
    let outline = proxy
        .selection
        .as_ref()
        .map(|sel| {
            let bounds = sel.content_bounds();
            let segs = outline::outline_scaled(sel, bounds, 1);
            segs.iter()
                .map(|(a, b)| [(a[0] * k as i32), (a[1] * k as i32), (b[0] * k as i32), (b[1] * k as i32)])
                .collect::<Vec<[i32; 4]>>()
        })
        .unwrap_or_default();
    Ok(ViewResult { width: img.width, height: img.height, rgba: img.pixels, outline, k })
}
