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

fn lock(s: &State<EditorState>) -> Result<std::sync::MutexGuard<'_, EditorManager>, String> {
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

/// 关闭文档(未保存修改直接丢弃,保存流程由前端先行决定)。
#[tauri::command]
pub fn editor_close(s: State<EditorState>, doc: u64) -> Result<(), String> {
    let mut m = lock(&s)?;
    m.close(doc).map_err(|e| e.to_string())
}
