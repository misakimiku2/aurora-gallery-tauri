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

/// M3 蒙版基础:加蒙版 → 蒙版目标上画黑 → 快照/合成/状态自省一致;启停与灰度视图的自省。
#[test]
fn mask_snapshot_target_stroke_and_state() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "white").unwrap();

    let layer_id = m.state(doc).unwrap()["layers"][0]["id"].as_u64().unwrap();

    // 无蒙版:快照报错,inspect 无 maskInfo 条目
    assert!(m.mask_snapshot(doc, layer_id, 16, 16).is_err());

    // 加全白蒙版:快照未触碰区域 = 默认值(白=显示)
    m.run(doc, "layer.layerMask.revealAll", json!({ "layer": layer_id })).unwrap();
    let snap = m.mask_snapshot(doc, layer_id, 16, 16).unwrap();
    assert_eq!((snap.width, snap.height), (16, 16));
    assert_eq!(&snap.pixels[0..4], &[255, 255, 255, 255]);

    // state():maskInfo(enabled/linked)+ channels.target
    let st = m.state(doc).unwrap();
    let info = &st["maskInfo"][layer_id.to_string()];
    assert_eq!(info["enabled"], json!(true));
    assert_eq!(info["linked"], json!(true));

    // 蒙版编辑目标 + 黑笔(target:"mask"):蒙版变黑处像素被隐藏(合成 alpha=0)
    m.run(doc, "channel.target", json!({ "channel": "mask" })).unwrap();
    m.run(doc, "tools.setColors", json!({ "foreground": "#000000" })).unwrap();
    m.run(doc, "paint.stroke", json!({ "points": [[8, 8, 1.0], [24, 24, 1.0]], "size": 8, "color": "#000000", "target": "mask" })).unwrap();

    let snap = m.mask_snapshot(doc, layer_id, 16, 16).unwrap();
    let at = |img: &Rendered, x: usize, y: usize| {
        let i = (y * img.width as usize + x) * 4;
        [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], img.pixels[i + 3]]
    };
    assert_eq!(at(&snap, 8, 8), [0, 0, 0, 255], "stroke path is black in the mask");
    assert_eq!(at(&snap, 0, 0), [255, 255, 255, 255], "outside stroke stays white");

    let comp = m.render_full(doc).unwrap();
    assert_eq!(at(&comp, 8, 8)[3], 0, "hidden by mask: alpha 0");
    assert_eq!(at(&comp, 30, 30)[3], 255, "outside stroke stays opaque");

    // 自省跟随目标与灰度视图(view-state 不入历史)
    let st = m.state(doc).unwrap();
    assert_eq!(st["channels"]["target"]["kind"], json!("layerMask"));
    m.run(doc, "view.layerMask", json!({ "layer": layer_id, "mode": "gray" })).unwrap();
    let st = m.state(doc).unwrap();
    assert_eq!(st["layerMaskView"]["mode"], json!("gray"));

    // 停用蒙版:maskInfo.enabled 翻转,合成恢复不透明(蒙版禁用=全显)
    m.run(doc, "layer.layerMask.enabled", json!({ "layer": layer_id, "enabled": false })).unwrap();
    let st = m.state(doc).unwrap();
    assert_eq!(st["maskInfo"][layer_id.to_string()]["enabled"], json!(false));
    let comp = m.render_full(doc).unwrap();
    assert_eq!(at(&comp, 8, 8)[3], 255, "disabled mask reveals everything");
}

/// M3 图层内容缩略图:图层自身像素(不含蒙版),内容边界裁剪,非像素层报错。
#[test]
fn layer_thumbnail_own_pixels_content_bounds() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();

    // 新透明像素层画一笔红;再给它加全黑蒙版——缩略图必须不含蒙版效果(PS 口径)
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    let layer = m.state(doc).unwrap()["activeLayer"].as_u64().unwrap();
    m.run(doc, "tools.setColors", json!({ "foreground": "#ff0000" })).unwrap();
    m.run(doc, "paint.stroke", json!({ "points": [[24, 24, 1.0], [40, 40, 1.0]], "size": 8 })).unwrap();
    m.run(doc, "layer.layerMask.hideAll", json!({ "layer": layer })).unwrap();

    let thumb = m.layer_thumbnail(doc, layer, 64).unwrap();
    assert!(thumb.width <= 64 && thumb.height <= 64, "fits max side: {}x{}", thumb.width, thumb.height);
    let at = |img: &Rendered, x: usize, y: usize| {
        let i = (y * img.width as usize + x) * 4;
        [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], img.pixels[i + 3]]
    };
    let (cx, cy) = (thumb.width as usize / 2, thumb.height as usize / 2);
    let c = at(&thumb, cx, cy);
    assert!(c[0] > 200 && c[1] < 80 && c[2] < 80 && c[3] == 255, "stroke center is red in own-pixel thumb, got {c:?}");
    // 蒙版全黑会隐藏整层,但缩略图仍显示图层自身像素(帧角在笔画外 → 透明)
    let corner = at(&thumb, 0, 0);
    assert_eq!(corner[3], 0, "outside the stroke the thumb is transparent (mask not applied)");

    // 调整层无 raster surface:报错(前端按 kind 出图标)
    m.run(doc, "layer.newAdjustmentLayer.invert", json!({})).unwrap();
    let adj = m.state(doc).unwrap()["activeLayer"].as_u64().unwrap();
    assert!(m.layer_thumbnail(doc, adj, 64).is_err());
}

/// 灰度查看中画蒙版的逐笔预览:mask_frames=true 时 begin/push/补差帧取蒙版表面灰度
/// (此前是合成帧,贴进灰度位图是错误内容,只能等提交后整幅重拉)。
#[test]
fn mask_gray_stroke_frames_live_preview() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    let layer = m.state(doc).unwrap()["activeLayer"].as_u64().unwrap();
    m.run(doc, "layer.layerMask.revealAll", json!({ "layer": layer })).unwrap();
    m.run(doc, "tools.setColors", json!({ "foreground": "#000000" })).unwrap();
    m.run(doc, "channel.target", json!({ "channel": "mask" })).unwrap();
    m.run(doc, "view.layerMask", json!({ "layer": layer, "mode": "gray" })).unwrap();

    let at = |f: &aurora_editor::StrokeFrame, x: i32, y: i32| {
        let i = ((y - f.y) * f.width as i32 + (x - f.x)) as usize * 4;
        [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2], f.pixels[i + 3]]
    };

    // begin(mask_frames=true):首帧即蒙版灰度——笔画中心黑(画黑隐藏),四角 alpha 恒 255(灰度图非透明)
    let f0 = m.stroke_begin(
        doc,
        "paint.stroke",
        json!({ "points": [[32, 32, 1.0]], "size": 12, "color": "#000000", "target": "mask" }),
        true,
    )
    .unwrap();
    assert!(f0.width > 0 && f0.height > 0, "begin frame has content");
    assert_eq!(at(&f0, 32, 32), [0, 0, 0, 255], "stroke point is black in the GRAY mask frame");

    // push:新点处同样灰度
    let f1 = m.stroke_push(doc, &[44.0, 32.0, 1.0]).unwrap();
    if f1.width > 0 {
        assert_eq!(at(&f1, 44, 32), [0, 0, 0, 255], "push frame is gray mask content");
    }

    // commit:历史推进;正式文档的蒙版快照在笔画处为黑
    let (out, _tail) = m.stroke_commit(doc).unwrap();
    assert!(out.revision > 0);
    let snap = m.mask_snapshot(doc, layer, 64, 64).unwrap();
    let idx = (32 * snap.width as usize + 32) * 4;
    assert_eq!(&snap.pixels[idx..idx + 3], &[0, 0, 0], "committed mask is black at the stroke");
}
