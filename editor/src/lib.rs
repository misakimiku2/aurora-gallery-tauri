//! aurora-editor — photocraft 引擎的编辑器桥(无 tauri/UI 依赖)。
//!
//! 职责:文档生命周期、通用 JSON 命令桥([`Session::execute`])、
//! CPU 合成渲染([`photocraft_compose`])与状态自省(`document.inspect`)。
//! src-tauri 的 editor_* 命令是这里的薄包装;引擎的增量协议
//! (revision / last_damage / view_revision)经 [`RunOutcome`] 透传给前端。

use photocraft_engine::doc::DocId;
use photocraft_engine::{file_cmds, Session};
use photocraft_geom::Rect;
use serde_json::{json, Value};

pub mod outline;

#[derive(Debug)]
pub struct EditorError(pub String);

impl std::fmt::Display for EditorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EditorError {}

impl From<photocraft_engine::EngineError> for EditorError {
    fn from(e: photocraft_engine::EngineError) -> Self {
        Self(format!("engine: {e}"))
    }
}

impl From<std::io::Error> for EditorError {
    fn from(e: std::io::Error) -> Self {
        Self(format!("io: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, EditorError>;

/// 一次命令执行的增量信息;前端据此决定重拉哪块画面、哪份状态。
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub revision: u64,
    /// 视图级变化(通道眼睛、目标切换)的计数;像素缓存可忽略这些 revision。
    pub view_revision: u64,
    /// 文档坐标系损伤矩形 (x, y, w, h);`None` = 假定全变。
    pub damage: Option<(i32, i32, u32, u32)>,
    pub result: Value,
}

/// 合成好的 RGBA8(straight alpha,行主序)。
#[derive(Debug, Clone)]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

pub struct EditorManager {
    session: Session,
}

impl Default for EditorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl EditorManager {
    pub fn new() -> Self {
        Self { session: Session::new() }
    }

    fn index_of(&self, doc: u64) -> Result<usize> {
        self.session
            .documents()
            .iter()
            .position(|d| d.doc.id == DocId(doc))
            .ok_or_else(|| EditorError(format!("no open document {doc}")))
    }

    fn activate(&mut self, doc: u64) -> Result<()> {
        let i = self.index_of(doc)?;
        self.session.set_active(i);
        Ok(())
    }

    fn active_id(&self) -> Result<u64> {
        self.session.active().map(|d| d.doc.id.0).ok_or_else(|| EditorError("no active document".into()))
    }

    /// 从内存字节打开文档。`name` 用于格式识别与显示名(带扩展名)。
    pub fn open_bytes(&mut self, name: &str, bytes: &[u8], path: Option<String>) -> Result<u64> {
        file_cmds::open_bytes_as(&mut self.session, name, bytes, None, path)?;
        self.active_id()
    }

    /// 从路径打开(同目录存在 `<stem>.psd` 伴生时由调用方先尝试 PSD)。
    pub fn open_path(&mut self, path: &str) -> Result<u64> {
        let bytes = std::fs::read(path)?;
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        self.open_bytes(&name, &bytes, Some(path.to_string()))
    }

    /// 新建文档;`background`:"white" | "black" | "transparent" | "#rrggbb"。
    pub fn new_document(&mut self, width: u32, height: u32, background: &str) -> Result<u64> {
        self.session.execute("file.new", json!({"width": width, "height": height, "background": background}))?;
        self.active_id()
    }

    /// 关闭文档(丢弃未保存修改,与 PS 一致;保存由调用方先行决定)。
    pub fn close(&mut self, doc: u64) -> Result<()> {
        self.run(doc, "file.close", json!({})).map(|_| ())
    }

    /// 通用命令桥。所有编辑行为都从这里过(与 photocraft CLI/MCP 同一入口),
    /// 命令 id 与参数 schema 见 `photocraft_engine::commands::command_specs()`。
    /// 若命令本身关闭了目标文档(file.close 等),返回的增量为空值。
    pub fn run(&mut self, doc: u64, cmd: &str, params: Value) -> Result<RunOutcome> {
        self.activate(doc)?;
        let result = self.session.execute(cmd, params)?;
        let outcome = match self.session.active() {
            Some(st) if st.doc.id == DocId(doc) => RunOutcome {
                revision: st.revision,
                view_revision: st.view_revision,
                damage: st.last_damage.map(|r| (r.x0, r.y0, r.width(), r.height())),
                result,
            },
            _ => RunOutcome { revision: 0, view_revision: 0, damage: None, result },
        };
        Ok(outcome)
    }

    /// 全分辨率合成(文档像素;前端 100% 视图位图源)。
    pub fn render_full(&mut self, doc: u64) -> Result<Rendered> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let rect = Rect::from_xywh(0, 0, st.doc.size.width, st.doc.size.height);
        let img = photocraft_compose::render(&st.doc, rect).to_rgba8();
        Ok(Rendered { width: img.width, height: img.height, pixels: img.pixels })
    }

    /// 降采样合成(导航器/首屏大图);保持宽高比,输出不超过 `max_w`×`max_h`。
    pub fn render_reduced(&mut self, doc: u64, max_w: u32, max_h: u32) -> Result<Rendered> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let scale = (max_w as f64 / st.doc.size.width.max(1) as f64)
            .min(max_h as f64 / st.doc.size.height.max(1) as f64)
            .min(1.0);
        let w = ((st.doc.size.width as f64 * scale).round() as u32).max(1);
        let h = ((st.doc.size.height as f64 * scale).round() as u32).max(1);
        let img = photocraft_compose::render_reduced(&st.doc, w, h).to_rgba8();
        Ok(Rendered { width: img.width, height: img.height, pixels: img.pixels })
    }

    /// 状态自省:图层树/历史/选区/通道,透传引擎 `document.inspect`,
    /// 并补上会话级的前/背景色(`inspect::session` 的字段,前端要一轮拿全)。
    pub fn state(&mut self, doc: u64) -> Result<Value> {
        self.activate(doc)?;
        let mut v = self.session.execute("document.inspect", json!({}))?;
        let session = photocraft_engine::inspect::session(&self.session);
        if let Some(obj) = v.as_object_mut() {
            for key in ["foreground", "background"] {
                if let Some(x) = session.get(key) {
                    obj.insert(key.into(), x.clone());
                }
            }
            // 历史面板的"当前状态"下标(document.inspect 未含;entries = 过去 + 当前 + 可重做)
            if let Some(st) = self.session.active() {
                obj.insert("historyCurrent".into(), json!(st.history.past_len()));
            }
            // 图层面板的混合模式下拉(layer_modes 的显示标签,与 setProps 的 blend 参数同源)
            if !obj.contains_key("blendModes") {
                obj.insert(
                    "blendModes".into(),
                    json!(photocraft_color::blend::BlendMode::layer_modes().map(|m| m.label()).collect::<Vec<_>>()),
                );
            }
        }
        Ok(v)
    }

    /// 打开中的文档 id 列表。
    pub fn documents(&self) -> Vec<u64> {
        self.session.documents().iter().map(|d| d.doc.id.0).collect()
    }

    /// 选区轮廓(mask 阈值 0.5 的边界,合并后的水平/垂直线段,文档像素坐标)。
    /// `step` 为采样步长(前端按视图 zoom 给:2^floor(log2(1/zoom)),zoom≥100% 时为 1);
    /// 服务端再经 `bounded_step` 把采样网格压到 ≤2²⁰ 格。无选区返回 None。
    /// 蚂蚁线画真实轮廓(加减/羽化/反选后的形状都正确),而非 selectionBounds 外接框。
    pub fn selection_outline(&mut self, doc: u64, step: u32) -> Result<Option<Value>> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let sel = match st.doc.selection.as_ref() {
            Some(s) => s,
            None => return Ok(None),
        };
        let bounds = sel.content_bounds();
        let step = outline::bounded_step(bounds, step);
        let segs = outline::outline_scaled(sel, bounds, step);
        let flat: Vec<[i32; 4]> = segs.iter().map(|(a, b)| [a[0], a[1], b[0], b[1]]).collect();
        Ok(Some(json!({ "step": step, "segments": flat })))
    }
}
