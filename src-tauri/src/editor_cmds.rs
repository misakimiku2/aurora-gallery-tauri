//! 图片编辑器 v3:photocraft 引擎的 Tauri 命令层(aurora-editor 桥的薄包装)。
//! 渲染走原始字节(8 字节小端头 w,h + RGBA8),避免 JSON 数组的序列化开销。

use aurora_editor::EditorManager;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

pub struct EditorState(pub Mutex<EditorManager>);

impl Default for EditorState {
    fn default() -> Self {
        Self(Mutex::new(EditorManager::new()))
    }
}

fn lock<'a>(s: &'a State<'_, EditorState>) -> Result<std::sync::MutexGuard<'a, EditorManager>, String> {
    s.0.lock().map_err(|_| "editor lock poisoned".to_string())
}

/// 打开图片进编辑器。返回 {docId, width, height}。
#[tauri::command]
pub fn editor_open(s: State<EditorState>, path: String) -> Result<Value, String> {
    let mut m = lock(&s)?;
    let id = m.open_path(&path).map_err(|e| e.to_string())?;
    let st = m.state(id).map_err(|e| e.to_string())?;
    Ok(json!({
        "docId": id,
        "path": path,
        "width": st["width"],
        "height": st["height"],
        "name": st["name"],
    }))
}

/// 通用 JSON 命令桥(与 photocraft CLI/MCP 同一入口)。
#[tauri::command]
pub fn editor_run(s: State<EditorState>, doc: u64, cmd: String, params: Value) -> Result<Value, String> {
    let mut m = lock(&s)?;
    let o = m.run(doc, &cmd, params).map_err(|e| e.to_string())?;
    Ok(json!({
        "revision": o.revision,
        "viewRevision": o.view_revision,
        "damage": o.damage,
        "result": o.result,
    }))
}

/// 合成画布位图:给 maxW/maxH 时降采样(导航器/大图首屏),否则全分辨率。
/// 返回 [w:u32 LE][h:u32 LE][RGBA8…]。
#[tauri::command]
pub fn editor_render(s: State<EditorState>, doc: u64, maxW: Option<u32>, maxH: Option<u32>) -> Result<Response, String> {
    let mut m = lock(&s)?;
    let img = match (maxW, maxH) {
        (Some(w), Some(h)) => m.render_reduced(doc, w, h),
        _ => m.render_full(doc),
    }
    .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(8 + img.pixels.len());
    bytes.extend_from_slice(&(img.width as u32).to_le_bytes());
    bytes.extend_from_slice(&(img.height as u32).to_le_bytes());
    bytes.extend_from_slice(&img.pixels);
    Ok(Response::new(bytes))
}

/// 状态自省:图层树/历史/选区/前后景色(document.inspect + 会话级颜色)。
#[tauri::command]
pub fn editor_state(s: State<EditorState>, doc: u64) -> Result<Value, String> {
    let mut m = lock(&s)?;
    m.state(doc).map_err(|e| e.to_string())
}

/// 选区真实轮廓(边界线段,文档坐标;蚂蚁线数据源)。无选区返回 null。
#[tauri::command]
pub fn editor_selection_outline(s: State<EditorState>, doc: u64, step: Option<u32>) -> Result<Option<Value>, String> {
    let mut m = lock(&s)?;
    m.selection_outline(doc, step.unwrap_or(1)).map_err(|e| e.to_string())
}

/// live 描边帧字节协议:[x:i32 LE][y:i32 LE][w:u32 LE][h:u32 LE][RGBA8…](文档坐标矩形);
/// w=0 表示本帧无变化。
fn stroke_frame_bytes(f: aurora_editor::StrokeFrame) -> Response {
    let mut bytes = Vec::with_capacity(16 + f.pixels.len());
    bytes.extend_from_slice(&(f.x as i32).to_le_bytes());
    bytes.extend_from_slice(&(f.y as i32).to_le_bytes());
    bytes.extend_from_slice(&(f.width as u32).to_le_bytes());
    bytes.extend_from_slice(&(f.height as u32).to_le_bytes());
    bytes.extend_from_slice(&f.pixels);
    Response::new(bytes)
}

/// 落笔:按命令族创建 live 描边(paint.stroke/paint.pencil 走 LiveStroke,
/// paint.blur|sharpen|smudge 走 LiveDab),渲染首点并返回增量帧。
#[tauri::command]
pub fn editor_stroke_begin(s: State<EditorState>, doc: u64, cmd: String, params: Value) -> Result<Response, String> {
    let mut m = lock(&s)?;
    let f = m.stroke_begin(doc, &cmd, params).map_err(|e| e.to_string())?;
    Ok(stroke_frame_bytes(f))
}

/// 拖动中投点(三元组 [x,y,pressure,…] 平铺),返回本批点改变区域的增量帧。
#[tauri::command]
pub fn editor_stroke_push(s: State<EditorState>, doc: u64, points: Vec<f64>) -> Result<Response, String> {
    let mut m = lock(&s)?;
    let f = m.stroke_push(doc, &points).map_err(|e| e.to_string())?;
    Ok(stroke_frame_bytes(f))
}

/// 抬笔:递交 live 像素并回放命令(fromLive 命中则引擎零重渲染),入一步历史。
/// 响应 = [jsonLen:u32 LE][RunOutcome JSON][描边补差帧(x,y,w,h 头 + RGBA)];帧 w=0 表示无需补差。
#[tauri::command]
pub fn editor_stroke_commit(s: State<EditorState>, doc: u64) -> Result<Response, String> {
    let mut m = lock(&s)?;
    let (o, f) = m.stroke_commit(doc).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(&json!({
        "revision": o.revision,
        "viewRevision": o.view_revision,
        "damage": o.damage,
        "result": o.result,
    }))
    .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(20 + json.len() + f.pixels.len());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(&(f.x as i32).to_le_bytes());
    bytes.extend_from_slice(&(f.y as i32).to_le_bytes());
    bytes.extend_from_slice(&(f.width as u32).to_le_bytes());
    bytes.extend_from_slice(&(f.height as u32).to_le_bytes());
    bytes.extend_from_slice(&f.pixels);
    Ok(Response::new(bytes))
}

/// 放弃进行中的描边(无历史)。
#[tauri::command]
pub fn editor_stroke_cancel(s: State<EditorState>, doc: u64) -> Result<(), String> {
    let mut m = lock(&s)?;
    m.stroke_cancel(doc).map_err(|e| e.to_string())
}

/// 移动工具拖拽预览帧:target="float"(选区像素浮动,dx/dy 为未提交增量)或
/// "layer"(整层平移,dx/dy 为总位移);x/y/w/h 为脏矩形(文档坐标)。
#[tauri::command]
pub fn editor_move_frame(
    s: State<EditorState>, doc: u64, target: String, dx: i32, dy: i32, x: i32, y: i32, w: u32, h: u32,
) -> Result<Response, String> {
    let mut m = lock(&s)?;
    let f = m.move_frame(doc, &target, dx, dy, x, y, w, h).map_err(|e| e.to_string())?;
    Ok(stroke_frame_bytes(f))
}


/// 关闭文档(未保存修改直接丢弃,保存流程由前端先行决定)。
#[tauri::command]
pub fn editor_close(s: State<EditorState>, doc: u64) -> Result<(), String> {
    let mut m = lock(&s)?;
    m.close(doc).map_err(|e| e.to_string())
}

/// 保存(拍板:Ctrl+S 覆盖原图 + 同名 .psd 分层伴生;引擎原子写,失败不毁旧文件)。
#[tauri::command]
pub fn editor_save(s: State<EditorState>, doc: u64) -> Result<Value, String> {
    let mut m = lock(&s)?;
    m.save(doc).map_err(|e| e.to_string())
}

/// 导出为指定路径的平面文件(不动会话路径、不写伴生)。
#[tauri::command]
pub fn editor_export_as(s: State<EditorState>, doc: u64, path: String) -> Result<Value, String> {
    let mut m = lock(&s)?;
    let n = m.export_as(doc, &path).map_err(|e| e.to_string())?;
    Ok(json!({ "bytes": n }))
}
