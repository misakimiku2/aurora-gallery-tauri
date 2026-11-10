//! 自由变换进入数据桥集成测试:变换框口径(transform_frame)、预览背景"抽走"层、
//! 层纹理与选区加权、锁定/空内容拒绝;全程零文档改动零历史。

use aurora_editor::EditorManager;
use serde_json::{json, Value};

fn brush_params(points: Value, color: &str) -> Value {
    json!({
        "points": points,
        "size": 12.0,
        "hardness": 1.0,
        "opacity": 1.0,
        "flow": 1.0,
        "spacing": 0.25,
        "smoothing": 0.0,
        "color": color,
        "erase": false,
    })
}

fn px(img: &aurora_editor::Rendered, x: usize, y: usize) -> [u8; 4] {
    let i = (y * img.width as usize + x) * 4;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], img.pixels[i + 3]]
}

/// 基本进入:frame = 层内容外接矩形;bg 在层的像素处是透明(层被抽走)、
/// tex 在同一处有层像素;文档 revision 零变化。
#[test]
fn transform_begin_frames_the_layer_and_extracts_it_from_the_background() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "transparent").unwrap();
    m.stroke_begin(doc, "paint.stroke", brush_params(json!([[8, 8, 1.0]]), "#ff0000"), false).unwrap();
    m.stroke_commit(doc).unwrap();
    let rev = m.state(doc).unwrap()["revision"].clone();
    let hist = m.state(doc).unwrap()["history"].as_array().unwrap().len();

    let r = m.transform_begin(doc).unwrap();
    let frame = r.info["frame"].as_array().unwrap();
    // 内容外接矩形(笔径 12 的 dab 在 (8,8),尺寸与软边有关,只验证框住内容且小于画布)
    let (fx0, fy0, fx1, fy1) = (frame[0].as_i64().unwrap(), frame[1].as_i64().unwrap(), frame[2].as_i64().unwrap(), frame[3].as_i64().unwrap());
    assert!(fx0 <= 8 && fy0 <= 8 && fx1 > 8 && fy1 > 8, "frame contains the dab: {frame:?}");
    assert!(fx1 < 32 && fy1 < 32, "frame is the content bounds, not the canvas");
    assert_eq!(r.info["kind"], json!("Pixel"));
    assert_eq!(r.bg.width, (fx1 - fx0) as u32, "bg covers the frame");
    assert_eq!(r.tex.width, r.bg.width, "tex covers the same rect");

    // 层被抽走:bg 的 dab 处透明;taking tex 的 dab 处红色不透明
    let dab_x = (8 - fx0) as usize;
    let dab_y = (8 - fy0) as usize;
    assert_eq!(px(&r.bg, dab_x, dab_y)[3], 0, "bg has the layer extracted");
    let t = px(&r.tex, dab_x, dab_y);
    assert!(t[3] > 200 && t[0] > 200, "tex has the layer pixel: {t:?}");

    // 零文档改动零历史
    let st = m.state(doc).unwrap();
    assert_eq!(st["revision"], rev);
    assert_eq!(st["history"].as_array().unwrap().len(), hist);
}

/// 带选区:tex 的 alpha 按选区灰度加权(上游 split_selected 抬起语义;羽化边缘权重
/// 渐变),frame = 选区自身 bounds(PS:框和蚂蚁线是一个矩形)。
#[test]
fn transform_begin_with_selection_frames_the_selection_and_weights_the_texture() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "transparent").unwrap();
    m.run(doc, "select.rect", json!({ "x": 4, "y": 4, "width": 6, "height": 6, "feather": 2 })).unwrap();
    m.stroke_begin(doc, "paint.stroke", brush_params(json!([[6, 6, 1.0]]), "#ff0000"), false).unwrap();
    m.stroke_commit(doc).unwrap();

    let r = m.transform_begin(doc).unwrap();
    let frame = r.info["frame"].as_array().unwrap();
    let (fx0, fy0, fx1, fy1) = (frame[0].as_i64().unwrap(), frame[1].as_i64().unwrap(), frame[2].as_i64().unwrap(), frame[3].as_i64().unwrap());
    assert!(fx0 <= 4 && fy0 <= 4 && fx1 >= 10 && fy1 >= 10, "frame covers the feathered selection: {frame:?}");

    // dab 中心 (6,6) = 选区中心,权重满;羽化把选区外(dab 溢出部分,如 (10,6))压到近零
    let at = |x: i64, y: i64| {
        let i = ((y - fy0) as usize * r.tex.width as usize + (x - fx0) as usize) * 4 + 3;
        r.tex.pixels[i]
    };
    assert!(at(6, 6) > 100, "selection centre keeps alpha: {}", at(6, 6));
    assert!(at(10, 6) < 50, "outside the selection is weighted away: {}", at(10, 6));
}

/// 空内容(未画过的空层)拒绝;背景层(画布大小内容)可变换。
#[test]
fn transform_begin_refuses_empty_layers() {
    let mut m = EditorManager::new();
    let doc = m.new_document(16, 16, "white").unwrap();
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    let err = m.transform_begin(doc).unwrap_err().to_string();
    assert!(err.contains("nothing to transform"), "empty layer refuses: {err}");
}

/// 锁定层拒绝(位置锁;Background 自身不算锁——上游提交时自动转普通层)。
#[test]
fn transform_begin_refuses_a_locked_layer() {
    let mut m = EditorManager::new();
    let doc = m.new_document(16, 16, "white").unwrap();
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    m.stroke_begin(doc, "paint.stroke", brush_params(json!([[8, 8, 1.0]]), "#ff0000"), false).unwrap();
    m.stroke_commit(doc).unwrap();
    m.run(doc, "layer.lockLayers", json!({ "position": true })).unwrap();
    let err = m.transform_begin(doc).unwrap_err().to_string();
    assert!(err.contains("locked"), "locked layer refuses: {err}");
}
