//! M0 最小桥集成测试:新建文档 → 设色 → 选区 → 画笔描边 → 合成断言 → 撤销/重做。
//! 证明 vendored 引擎经 aurora-editor 可完整驱动(命令桥 + 增量协议 + 合成)。

use aurora_editor::{EditorManager, Rendered};
use serde_json::json;

fn px(img: &Rendered, x: usize, y: usize) -> [u8; 3] {
    let i = (y * img.width as usize + x) * 4;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
}

#[test]
fn bitmap_roundtrip() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();

    // 白色背景层,全幅合成正确
    let before = m.render_full(doc).unwrap();
    assert_eq!((before.width, before.height), (64, 64));
    assert_eq!(px(&before, 0, 0), [255, 255, 255]);

    // 前景色红、背景色白
    m.run(doc, "tools.setColors", json!({"foreground": "#ff0000", "background": "#ffffff"})).unwrap();

    // 矩形选区(选区不改变像素,但入历史)
    let sel = m.run(doc, "select.rect", json!({"x": 8, "y": 8, "width": 40, "height": 40})).unwrap();
    assert_eq!(sel.result, serde_json::Value::Null);

    // 画笔描边:选区内画一条过 (32,32) 的短线;revision 前进、damage 有值
    let stroke = m.run(doc, "paint.stroke", json!({"points": [[24, 24, 0.5], [40, 40, 0.5]]})).unwrap();
    assert!(stroke.revision > sel.revision, "revision should advance: {} -> {}", sel.revision, stroke.revision);
    let damage = stroke.damage.expect("paint stroke reports damage");
    assert!(damage.2 > 0 && damage.3 > 0, "damage has extent: {damage:?}");

    let after = m.render_full(doc).unwrap();
    let c = px(&after, 32, 32);
    assert!(c[0] > 200 && c[1] < 80 && c[2] < 80, "stroke center should be red, got {c:?}");
    assert_eq!(px(&after, 2, 2), [255, 255, 255], "outside stroke stays white");

    // 撤销恢复白底,重做恢复红笔
    m.run(doc, "edit.undo", json!({})).unwrap();
    let undone = m.render_full(doc).unwrap();
    assert_eq!(px(&undone, 32, 32), [255, 255, 255]);
    m.run(doc, "edit.redo", json!({})).unwrap();
    let redone = m.render_full(doc).unwrap();
    assert!(px(&redone, 32, 32)[0] > 200, "redo restores the stroke");

    // 降采样合成保持宽高比与上界
    let thumb = m.render_reduced(doc, 16, 8).unwrap();
    assert_eq!((thumb.width, thumb.height), (8, 8));

    // 状态自省:图层/选区/前后景色/历史/撤销可用性
    let state = m.state(doc).unwrap();
    let layers = state["layers"].as_array().expect("layers array");
    assert!(!layers.is_empty());
    assert_eq!(state["hasSelection"], serde_json::Value::Bool(true));
    assert_eq!(state["canUndo"], serde_json::Value::Bool(true));
    let hist = state["history"].as_array().expect("history array");
    assert!(hist.len() >= 2, "selection + stroke are history steps: {hist:?}");
    assert!(state["foreground"][0].as_f64().unwrap() > 0.9, "foreground is red: {:?}", state["foreground"]);

    // 关闭后文档列表为空,再操作报错
    m.close(doc).unwrap();
    assert!(m.documents().is_empty());
    assert!(m.render_full(doc).is_err());
}
