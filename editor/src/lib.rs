//! aurora-editor — photocraft 引擎的编辑器桥(无 tauri/UI 依赖)。
//!
//! 职责:文档生命周期、通用 JSON 命令桥([`Session::execute`])、
//! CPU 合成渲染([`photocraft_compose`])与状态自省(`document.inspect`)。
//! src-tauri 的 editor_* 命令是这里的薄包装;引擎的增量协议
//! (revision / last_damage / view_revision)经 [`RunOutcome`] 透传给前端。

use photocraft_engine::brush_cmds::LiveStroke;
use photocraft_engine::doc::DocId;
use photocraft_engine::float_cmds;
use photocraft_engine::layer_multi_cmds;
use photocraft_engine::paint::StrokePoint;
use photocraft_engine::retouch_cmds::LiveDab;
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

/// live 描边的一帧增量:文档坐标矩形 + 该区域的合成像素(来自 stroke 的文档克隆)。
/// 空矩形(width=0)表示本帧无变化。
#[derive(Debug, Clone)]
pub struct StrokeFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl StrokeFrame {
    fn empty() -> Self {
        Self { x: 0, y: 0, width: 0, height: 0, pixels: Vec::new() }
    }
}

/// 进行中的 live 描边的引擎侧载体。画笔/铅笔走 [`LiveStroke`],
/// 顺序 dab 工具(blur/sharpen/smudge)走 [`LiveDab`];两者生命周期同构。
enum LiveKind {
    Brush(LiveStroke),
    Dab(LiveDab),
}

impl LiveKind {
    fn doc(&self) -> &photocraft_engine::doc::Document {
        match self {
            LiveKind::Brush(l) => &l.doc,
            LiveKind::Dab(l) => &l.doc,
        }
    }

    fn bounds(&self) -> Rect {
        match self {
            LiveKind::Brush(l) => l.bounds(),
            LiveKind::Dab(l) => l.bounds(),
        }
    }

    fn push(&mut self, pts: &[StrokePoint]) -> Result<Rect> {
        match self {
            LiveKind::Brush(l) => l.push(pts).map_err(Into::into),
            LiveKind::Dab(l) => l.push(pts).map_err(Into::into),
        }
    }
}

/// 一支 live 描边的完整状态:引擎对象 + begin 时的原始参数 + 全部点。
/// commit 时把参数原样回放(只换 points/seed),引擎 `LiveCommit::matches`
/// 比对命中即直接采用 live 像素,不再整笔重渲染。
struct LiveStrokeState {
    kind: LiveKind,
    cmd: String,
    params: Value,
    /// 全部点三元组 [x, y, pressure](begin 首点 + 每次 push 的批次)。
    points: Vec<[f64; 3]>,
    /// 已返回给前端的帧矩形之并——commit 的 fromLive 帧只需补未送达的部分
    /// (dab 族收尾 dab 只写进 live 文档,不经 push 返回;点击式点画同理)。
    returned: Rect,
    /// 灰度查看中画蒙版:帧取蒙版表面灰度而非合成(前端请求),值为 begin 时的活动图层 id。
    frame_mask: Option<u64>,
}

pub struct EditorManager {
    session: Session,
    live: Option<LiveStrokeState>,
}

impl Default for EditorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl EditorManager {
    pub fn new() -> Self {
        Self { session: Session::new(), live: None }
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

    /// 从路径打开。**同名 .psd 分层伴生优先**(拍板:编辑过的图重开恢复图层):
    /// `foo.jpg` 旁存在 `foo.psd` 时打开 PSD 字节,但会话路径仍记原图——
    /// [`Self::save`] 继续配对「原图平面导出 + .psd 伴生」。
    pub fn open_path(&mut self, path: &str) -> Result<u64> {
        let p = std::path::Path::new(path);
        let psd = p.with_extension("psd");
        if psd != p && psd.is_file() {
            let bytes = std::fs::read(&psd)?;
            let psd_name = psd.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "companion.psd".into());
            file_cmds::open_bytes_as(&mut self.session, &psd_name, &bytes, None, Some(path.to_string()))?;
            // 文档主身份是原图:标题与图库对应关系都按原图名
            if let Some(st) = self.session.active_mut() {
                let doc = std::sync::Arc::make_mut(&mut st.doc);
                doc.name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or(psd_name);
            }
            return self.active_id();
        }
        let bytes = std::fs::read(path)?;
        let name = p
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
    /// 进行中的 live 描边一并丢弃(其文档克隆随会话释放)。
    pub fn close(&mut self, doc: u64) -> Result<()> {
        self.live = None;
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

    // ---- live 描边(画笔族)----
    //
    // 口径与 photocraft UI(canvas.rs EngineStroke)一致:落笔时 begin(params 带首点,
    // 引擎在文档克隆上直接渲染真像素),拖动中每帧 push 一批点并按返回的 damage 矩形
    // 局部合成给前端,抬笔 commit——用 begin 的原参数回放命令,引擎比对命中(fromLive)
    // 直接采用 live 像素,零重渲染。

    fn doc_size(&self) -> Result<(u32, u32)> {
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        Ok((st.doc.size.width, st.doc.size.height))
    }

    /// live 文档(克隆)上合成 `dmg` 区域;空/越界矩形 → 空帧。
    fn live_frame(kind: &LiveKind, size: (u32, u32), dmg: Rect) -> Result<StrokeFrame> {
        let full = Rect::from_xywh(0, 0, size.0, size.1);
        let r = dmg.intersect(&full);
        if r.is_empty() {
            return Ok(StrokeFrame::empty());
        }
        let img = photocraft_compose::render(kind.doc(), r).to_rgba8();
        Ok(StrokeFrame { x: r.x0, y: r.y0, width: img.width, height: img.height, pixels: img.pixels })
    }

    /// live 文档(克隆)上取目标图层**蒙版表面**的灰度帧(灰度查看中画蒙版的逐笔预览):
    /// 合成帧对灰度画布是错误内容(会把合成像素贴进灰度位图),改为直接采样蒙版表面,
    /// 白=显示 黑=隐藏,与 mask_snapshot/灰度查看同一语义。图层丢失/无蒙版 → 空帧。
    fn live_mask_frame(kind: &LiveKind, size: (u32, u32), dmg: Rect, layer: u64) -> Result<StrokeFrame> {
        let full = Rect::from_xywh(0, 0, size.0, size.1);
        Self::live_mask_frame_layer(kind.doc(), dmg.intersect(&full), layer)
    }

    /// 同上,但从指定文档取(commit 补差帧从提交后的正式文档取,live 帧从克隆取)。
    fn live_mask_frame_layer(doc: &photocraft_engine::doc::Document, r: Rect, layer: u64) -> Result<StrokeFrame> {
        if r.is_empty() {
            return Ok(StrokeFrame::empty());
        }
        let Some(l) = find_layer(doc.layers.as_slice(), layer) else {
            return Ok(StrokeFrame::empty());
        };
        let Some(mask) = l.mask.as_ref() else {
            return Ok(StrokeFrame::empty());
        };
        let w = r.width() as usize;
        let h = r.height() as usize;
        let mut row = vec![0f32; w];
        let mut px = vec![0u8; w * h * 4];
        for j in 0..h {
            mask.surface.sample_row_strided(r.y0 + j as i32, r.x0, 1, 0, &mut row);
            for (i, v) in row.iter().enumerate() {
                let g = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                let o = (j * w + i) * 4;
                px[o] = g;
                px[o + 1] = g;
                px[o + 2] = g;
                px[o + 3] = 255;
            }
        }
        Ok(StrokeFrame { x: r.x0, y: r.y0, width: r.width(), height: r.height(), pixels: px })
    }

    /// 落笔:按命令族创建 live 描边并渲染首点。`params` 须含 `points`(首点起),
    /// 参数原样留存,commit 时回放。命令族:`paint.stroke`(画笔/橡皮,erase 参数)、
    /// `paint.pencil`;`paint.blur` / `paint.sharpen` / `paint.smudge`(顺序 dab 工具)。
    /// `mask_frames`:灰度查看中画蒙版——帧取活动图层蒙版表面灰度(逐笔预览),
    /// 合成帧对灰度画布是错误内容。
    pub fn stroke_begin(&mut self, doc: u64, cmd: &str, params: Value, mask_frames: bool) -> Result<StrokeFrame> {
        self.activate(doc)?;
        if self.live.is_some() {
            // 上一笔被前端遗弃(异常路径未走到 commit/cancel)。描边协议本身是严格串行的
            // (begin→push→commit,下一笔 begin 到来即证明旧笔已死):自动丢弃自愈,
            // 否则一次前端异常会让画笔永久 "a stroke is already active"。
            self.live = None;
        }
        let pts = params
            .get("points")
            .and_then(Value::as_array)
            .ok_or_else(|| EditorError(format!("{cmd}: missing `points`")))?;
        let mut points = Vec::with_capacity(pts.len());
        for v in pts {
            let a = v.as_array().ok_or_else(|| EditorError(format!("{cmd}: points must be [x,y,pressure] arrays")))?;
            let g = |i: usize| a.get(i).and_then(Value::as_f64).ok_or_else(|| EditorError(format!("{cmd}: point needs x and y")));
            points.push([g(0)?, g(1)?, a.get(2).and_then(Value::as_f64).unwrap_or(1.0)]);
        }
        let kind = match cmd {
            "paint.stroke" | "paint.pencil" => LiveKind::Brush(LiveStroke::begin_with(&self.session, cmd, &params)?),
            "paint.blur" | "paint.sharpen" | "paint.smudge" => LiveKind::Dab(LiveDab::begin(&self.session, cmd, &params)?),
            other => return Err(EditorError(format!("{other}: not a live-stroke command"))),
        };
        let size = self.doc_size()?;
        // 灰度帧的蒙版取 begin 时的活动图层(live 克隆上的同一 id)
        let frame_mask = if mask_frames {
            self.session.active().and_then(|st| st.active_layer).map(|id| id.0)
        } else {
            None
        };
        let frame = match frame_mask {
            Some(layer) => Self::live_mask_frame(&kind, size, kind.bounds(), layer)?,
            None => Self::live_frame(&kind, size, kind.bounds())?,
        };
        let returned = Rect::from_xywh(frame.x, frame.y, frame.width, frame.height);
        self.live = Some(LiveStrokeState {
            kind,
            cmd: cmd.into(),
            params,
            points,
            returned: if frame.width > 0 { returned } else { Rect::EMPTY },
            frame_mask,
        });
        Ok(frame)
    }

    /// 拖动中投点:`flat` 为 [x,y,pressure, x,y,pressure, …] 三元组序列。
    /// 返回本批点改变的区域的合成像素(增量帧)。
    pub fn stroke_push(&mut self, doc: u64, flat: &[f64]) -> Result<StrokeFrame> {
        self.activate(doc)?;
        if flat.len() % 3 != 0 {
            return Err(EditorError("stroke_push: points must be [x,y,pressure] triples".into()));
        }
        let pts: Vec<StrokePoint> = flat.chunks_exact(3).map(|c| StrokePoint::new(c[0], c[1], c[2] as f32)).collect();
        let size = self.doc_size()?;
        let st = self.live.as_mut().ok_or_else(|| EditorError("no active stroke".into()))?;
        let dmg = st.kind.push(&pts)?;
        for c in flat.chunks_exact(3) {
            st.points.push([c[0], c[1], c[2]]);
        }
        let frame = match st.frame_mask {
            Some(layer) => Self::live_mask_frame(&st.kind, size, dmg, layer)?,
            None => Self::live_frame(&st.kind, size, dmg)?,
        };
        if frame.width > 0 {
            st.returned = st.returned.union(&Rect::from_xywh(frame.x, frame.y, frame.width, frame.height));
        }
        Ok(frame)
    }

    /// 抬笔:递交 live 像素并以 begin 原参数回放命令(引擎比对命中则 `fromLive:true`,
    /// 直接采用 live 像素);推进一步历史。返回值口径同 [`Self::run`],并附带一笔
    /// **补差帧**:damage 中尚未返回给前端的部分(dab 族收尾 dab、点击式点画只写进
    /// live 文档,不经 push 链路;fromLive 命中时前端不再整幅重渲,这帧必须补上)。
    pub fn stroke_commit(&mut self, doc: u64) -> Result<(RunOutcome, StrokeFrame)> {
        self.activate(doc)?;
        let live = self.live.take().ok_or_else(|| EditorError("no active stroke".into()))?;
        let returned = live.returned;
        // Brush 族 commit 必须带 begin 生成的 seed(matches 单独比对);dab 族无 seed,不能带。
        let seed = match &live.kind {
            LiveKind::Brush(l) => Some(l.seed),
            LiveKind::Dab(_) => None,
        };
        match live.kind {
            LiveKind::Brush(l) => self.session.offer_live_stroke(l)?,
            LiveKind::Dab(l) => self.session.offer_live_dab(l)?,
        }
        let mut p = live.params;
        p["points"] = Value::Array(live.points.iter().map(|c| json!([c[0], c[1], c[2]])).collect());
        if let Some(s) = seed {
            p["seed"] = json!(s);
        }
        let cmd = live.cmd;
        let result = self.session.execute(&cmd, p)?;
        let outcome = match self.session.active() {
            Some(st) if st.doc.id == DocId(doc) => RunOutcome {
                revision: st.revision,
                view_revision: st.view_revision,
                damage: st.last_damage.map(|r| (r.x0, r.y0, r.width(), r.height())),
                result,
            },
            _ => RunOutcome { revision: 0, view_revision: 0, damage: None, result },
        };
        // 补差帧:提交后 damage(dab 族收尾含在内)未被此前帧覆盖的部分,从正式文档渲染。
        let size = self.doc_size()?;
        let dmg = match outcome.damage {
            Some((x, y, w, h)) if w > 0 && h > 0 => Rect::from_xywh(x, y, w, h),
            _ => Rect::EMPTY,
        };
        let missing = dmg.intersect(&Rect::from_xywh(0, 0, size.0, size.1));
        let frame = if missing.is_empty() || missing.union(&returned) == returned {
            StrokeFrame::empty()
        } else {
            let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
            // 灰度查看中画蒙版:补差帧同样取蒙版表面灰度(正式文档,提交后的终态)
            match live.frame_mask {
                Some(layer) => Self::live_mask_frame_layer(&st.doc, missing, layer)?,
                None => {
                    let img = photocraft_compose::render(&st.doc, missing).to_rgba8();
                    StrokeFrame { x: missing.x0, y: missing.y0, width: img.width, height: img.height, pixels: img.pixels }
                }
            }
        };
        Ok((outcome, frame))
    }

    /// 放弃进行中的描边(不产生历史;画布应回退到 revision 快照重渲)。
    pub fn stroke_cancel(&mut self, doc: u64) -> Result<()> {
        self.activate(doc)?;
        self.live = None;
        Ok(())
    }

    /// 移动工具拖拽的预览帧(photocraft move_ui 口径:拖动中纯函数合成,提交才一条命令):
    /// - `target:"float"`:选区像素浮动预览。前端按下时已跑 `select.float {0,0}` 切割,
    ///   拖动中不跑命令;`dx/dy` 为自最近一次已提交浮动偏移以来的增量,
    ///   引擎 `displayed` 把浮动件按 offset+extra 合成。
    /// - `target:"layer"`:整层平移预览,`dx/dy` 为总位移;引擎 `moved` 纯函数
    ///   (克隆文档平移选中层,Text/Shape 只挪元数据),不入历史。
    /// `x/y/w/h` 为要合成的区域(前端算的脏矩形:上一帧位置 ∪ 当前位置)。
    pub fn move_frame(&mut self, doc: u64, target: &str, dx: i32, dy: i32, x: i32, y: i32, w: u32, h: u32) -> Result<StrokeFrame> {
        self.activate(doc)?;
        let size = self.doc_size()?;
        let rect = Rect::from_xywh(x, y, w, h).intersect(&Rect::from_xywh(0, 0, size.0, size.1));
        if rect.is_empty() {
            return Ok(StrokeFrame::empty());
        }
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let img = match target {
            "float" => {
                let preview = float_cmds::displayed(st, (dx, dy))
                    .ok_or_else(|| EditorError("no floating selection".into()))?;
                photocraft_compose::render(&preview, rect).to_rgba8()
            }
            "layer" => {
                let ids = Self::move_targets(st);
                let preview = layer_multi_cmds::moved(&st.doc, &ids, dx, dy)?;
                photocraft_compose::render(&preview, rect).to_rgba8()
            }
            other => return Err(EditorError(format!("{other}: not a move target"))),
        };
        Ok(StrokeFrame { x: rect.x0, y: rect.y0, width: img.width, height: img.height, pixels: img.pixels })
    }

    /// 移动目标:全部选中层,否则活动层(上游 move_targets 的简化:不含链接层扩散)。
    fn move_targets(st: &photocraft_engine::DocState) -> Vec<photocraft_engine::doc::LayerId> {
        if !st.selected_layers.is_empty() {
            st.selected_layers.clone()
        } else {
            st.active_layer.into_iter().collect()
        }
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

    /// 保存(拍板:Ctrl+S **覆盖原图 + 同名 .psd 分层伴生**):
    /// ① 平面导出覆盖原图——不传 quality,引擎 `apply_file_encoding` 按打开时的
    ///    编码质量回写(PS Save 口径);`photocraft_format::atomic_write` 原子写,
    ///    失败不毁旧文件;
    /// ② 同目录 `<stem>.psd` 分层伴生(maximize compatibility,PS 默认)。
    /// 无路径文档(剪贴板新建等)报错。返回 `{imagePath, psdPath, psdExisted}`。
    pub fn save(&mut self, doc: u64) -> Result<Value> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let path = st.path.clone().ok_or_else(|| EditorError("document has no file path".into()))?;
        let opts = Self::save_opts(&st.doc);
        let image = photocraft_io::export(&st.doc, &path, &opts)
            .map_err(|e| EditorError(format!("encode {path}: {e}")))?;
        photocraft_format::atomic_write(std::path::Path::new(&path), &image.bytes)
            .map_err(|e| EditorError(format!("write {path}: {e}")))?;
        let psd_path = std::path::Path::new(&path).with_extension("psd");
        let psd_existed = psd_path.is_file();
        let psd_str = psd_path.to_string_lossy().into_owned();
        let psd = photocraft_io::export(&st.doc, &psd_str, &opts)
            .map_err(|e| EditorError(format!("encode {psd_str}: {e}")))?;
        photocraft_format::atomic_write(&psd_path, &psd.bytes)
            .map_err(|e| EditorError(format!("write {psd_str}: {e}")))?;
        // PS 口径:保存完成 → 已存水位推到当前 revision(前端状态点变绿)
        if let Some(st) = self.session.active_mut() {
            st.saved_to(path.clone());
        }
        Ok(json!({ "imagePath": path, "psdPath": psd_str, "psdExisted": psd_existed }))
    }

    /// 另存为(PS 口径:**文档改绑新路径**,此后 Ctrl+S 写新文件):
    /// 选 `.psd`/`.psb` = 分层保存(无伴生);其他扩展名 = 平面导出 + 同目录
    /// `<stem>.psd` 分层伴生。**按新扩展名真重编码**(photocraft_io::export
    /// 依扩展名走对应编码器,不是改后缀)。返回 `{imagePath, psdPath?}`。
    pub fn save_as(&mut self, doc: u64, path: &str) -> Result<Value> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let layered = matches!(ext.as_str(), "psd" | "psb");
        let opts = Self::save_opts(&st.doc);
        let r = photocraft_io::export(&st.doc, path, &opts)
            .map_err(|e| EditorError(format!("encode {path}: {e}")))?;
        photocraft_format::atomic_write(std::path::Path::new(path), &r.bytes)
            .map_err(|e| EditorError(format!("write {path}: {e}")))?;
        let psd_path = if layered {
            None
        } else {
            let p = std::path::Path::new(path).with_extension("psd");
            let psd_str = p.to_string_lossy().into_owned();
            let psd = photocraft_io::export(&st.doc, &psd_str, &opts)
                .map_err(|e| EditorError(format!("encode {psd_str}: {e}")))?;
            photocraft_format::atomic_write(&p, &psd.bytes)
                .map_err(|e| EditorError(format!("write {psd_str}: {e}")))?;
            Some(psd_str)
        };
        if let Some(st) = self.session.active_mut() {
            st.saved_to(path.to_string());
        }
        Ok(json!({ "imagePath": path, "psdPath": psd_path }))
    }

    /// 导出为指定路径的平面文件(M3 的"导出为";不动会话路径、不写 .psd 伴生)。
    /// 返回字节数。
    pub fn export_as(&mut self, doc: u64, path: &str) -> Result<usize> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let r = photocraft_io::export(&st.doc, path, &Self::save_opts(&st.doc))
            .map_err(|e| EditorError(format!("encode {path}: {e}")))?;
        photocraft_format::atomic_write(std::path::Path::new(path), &r.bytes)
            .map_err(|e| EditorError(format!("write {path}: {e}")))?;
        Ok(r.bytes.len())
    }

    /// 保存/导出共用的编码选项:平面格式按打开时的编码质量回写(PS Save 口径),
    /// PSD 侧取默认(image previews + maximize compatibility 均开,同 PS Always Save)。
    fn save_opts(doc: &photocraft_engine::doc::Document) -> photocraft_io::ExportOptions {
        let mut opts = photocraft_io::ExportOptions::default();
        photocraft_io::apply_file_encoding(doc, &mut opts.encode);
        opts
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
                // 编辑器状态点:revision 超过已存水位 = 有未保存修改(view-only 不算)
                obj.insert("dirty".into(), json!(st.revision > st.saved_revision));
            }
            // 图层面板的混合模式下拉(layer_modes 的显示标签,与 setProps 的 blend 参数同源)
            if !obj.contains_key("blendModes") {
                obj.insert(
                    "blendModes".into(),
                    json!(photocraft_color::blend::BlendMode::layer_modes().map(|m| m.label()).collect::<Vec<_>>()),
                );
            }
            // 图层面板的蒙版徽标态(inspect 的 hasMask 只是布尔):layerId → enabled/linked
            if let Some(st) = self.session.active() {
                let mut info = serde_json::Map::new();
                collect_mask_info(&st.doc.layers, &mut info);
                obj.insert("maskInfo".into(), Value::Object(info));
            }
        }
        Ok(v)
    }

    /// 蒙版快照:指定图层的像素蒙版灰度 RGBA(白=显示 黑=隐藏),整幅文档范围,
    /// k 步长采样使输出不超过 maxW×maxH(图层蒙版缩略图与灰度查看共用)。
    /// 蒙版是稀疏 tile 表面,按行跨步采样只触落到样本的 tile;未触碰区域=默认值。
    pub fn mask_snapshot(&mut self, doc: u64, layer: u64, max_w: u32, max_h: u32) -> Result<Rendered> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let l = find_layer(&st.doc.layers, layer)
            .ok_or_else(|| EditorError(format!("no layer {layer}")))?;
        let mask = l
            .mask
            .as_ref()
            .ok_or_else(|| EditorError(format!("layer {layer} has no layer mask")))?;
        let (w, h) = (st.doc.size.width.max(1), st.doc.size.height.max(1));
        let k: u32 = 1
            .max(w.div_ceil(max_w.max(1)))
            .max(h.div_ceil(max_h.max(1)));
        let ow = w.div_ceil(k);
        let oh = h.div_ceil(k);
        let mut row = vec![0f32; ow as usize];
        let mut px = vec![0u8; (ow * oh * 4) as usize];
        for j in 0..oh {
            mask.surface.sample_row_strided((j * k) as i32, 0, k as i32, 0, &mut row);
            for (i, v) in row.iter().enumerate() {
                let g = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                let o = ((j * ow) as usize + i) * 4;
                px[o] = g;
                px[o + 1] = g;
                px[o + 2] = g;
                px[o + 3] = 255;
            }
        }
        Ok(Rendered { width: ow, height: oh, pixels: px })
    }

    /// 图层内容缩略图:图层自身像素(不含蒙版/混合,PS 口径——蒙版有自己的缩略图),
    /// 帧取内容边界∩画布(空内容回退整幅画布),最长边采样 ≤maxSide;透明区 straight alpha。
    /// 非像素层(调整/编组/文字等无 raster surface)报错,前端按 kind 显示图标。
    pub fn layer_thumbnail(&mut self, doc: u64, layer: u64, max_side: u32) -> Result<Rendered> {
        self.activate(doc)?;
        let st = self.session.active().ok_or_else(|| EditorError("no active document".into()))?;
        let l = find_layer(&st.doc.layers, layer)
            .ok_or_else(|| EditorError(format!("no layer {layer}")))?;
        let surface = l
            .surface()
            .ok_or_else(|| EditorError(format!("layer {layer} has no raster content")))?;
        let canvas = Rect::from_xywh(0, 0, st.doc.size.width, st.doc.size.height);
        let bounds = surface.content_bounds().intersect(&canvas);
        let frame = if bounds.is_empty() { canvas } else { bounds };
        let side = i64::from(max_side.max(8));
        let fw = i64::from(frame.width().max(1));
        let fh = i64::from(frame.height().max(1));
        // i64::div_ceil 在本工具链仍属 unstable(签名整除走手写;全为正数)
        let ceil = |a: i64, b: i64| (a + b - 1) / b;
        let k = ceil(fw.max(fh), side).max(1);
        let ow = (ceil(fw, k)).max(1) as u32;
        let oh = (ceil(fh, k)).max(1) as u32;
        let n = surface.channels();
        let fmt = surface.format();
        let mut px = vec![0f32; n];
        let mut out = vec![0u8; (ow * oh * 4) as usize];
        for ty in 0..oh {
            let y = frame.y0 + (i64::from(ty) * k).min(fh - 1) as i32;
            for tx in 0..ow {
                let x = frame.x0 + (i64::from(tx) * k).min(fw - 1) as i32;
                surface.read_pixel(x, y, &mut px);
                let [r, g, b, a] = photocraft_raster::to_rgba(&fmt, &px[..n]);
                let o = ((ty * ow + tx) * 4) as usize;
                out[o] = (r * 255.0).round() as u8;
                out[o + 1] = (g * 255.0).round() as u8;
                out[o + 2] = (b * 255.0).round() as u8;
                out[o + 3] = (a * 255.0).round() as u8;
            }
        }
        Ok(Rendered { width: ow, height: oh, pixels: out })
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

/// 按 id 在图层树(含编组子层)里找图层。
fn find_layer(layers: &[photocraft_engine::doc::Layer], id: u64) -> Option<&photocraft_engine::doc::Layer> {
    for l in layers {
        if l.id.0 == id {
            return Some(l);
        }
        if let photocraft_engine::doc::LayerContent::Group(g) = &l.content {
            if let Some(found) = find_layer(&g.children, id) {
                return Some(found);
            }
        }
    }
    None
}

/// 收集带像素蒙版的图层的 enabled/linked(图层面板徽标态),含编组子层。
fn collect_mask_info(layers: &[photocraft_engine::doc::Layer], out: &mut serde_json::Map<String, Value>) {
    for l in layers {
        if let Some(m) = &l.mask {
            out.insert(l.id.0.to_string(), json!({ "enabled": m.enabled, "linked": m.linked }));
        }
        if let photocraft_engine::doc::LayerContent::Group(g) = &l.content {
            collect_mask_info(&g.children, out);
        }
    }
}
