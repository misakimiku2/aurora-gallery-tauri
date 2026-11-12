//! 内容识别缩放桥集成测试:进入区(选区 content_bounds / 层内容 bounds)、bg「层内清区」
//! 语义、tex 不做选区加权、后台预览线程雕刻代理、提交 job 一步 "Content-Aware Scale"。

use aurora_editor::EditorManager;
use serde_json::{json, Value};

fn px(img: &aurora_editor::Rendered, x: usize, y: usize) -> [u8; 4] {
    let i = (y * img.width as usize + x) * 4;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], img.pixels[i + 3]]
}

/// 进入区与 bg 清区:有选区时 region=选区 content_bounds(bg 在该矩形内=层被清空,
/// tex=全分辨率层像素**不带**选区加权——区域整体是缩放对象);info 带 channels 表。
#[test]
fn cas_begin_frames_the_selection_and_clears_it_in_the_background() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 48, "transparent").unwrap();
    m.run(doc, "layer.new.layer", json!({"name": "A"})).unwrap();
    m.run(doc, "select.rect", json!({"x": 8, "y": 8, "width": 40, "height": 24})).unwrap();
    m.run(doc, "edit.fill", json!({"color": "#ff0000"})).unwrap();
    let rev = m.state(doc).unwrap()["revision"].clone();
    let hist = m.state(doc).unwrap()["history"].as_array().unwrap().len();

    let r = m.cas_begin(doc).unwrap();
    let frame = r.info["frame"].as_array().unwrap();
    // region=选区自身 content_bounds(硬边选区=精确矩形 [8,8,48,32])
    assert_eq!(frame, json!([8, 8, 48, 32]).as_array().unwrap(), "region is the selection bounds");
    assert_eq!(r.info["kind"], json!("Pixel"));
    assert!(r.info["channels"].is_array(), "info carries the alpha channel names");
    assert_eq!(r.bg.width, 40, "bg covers the region");
    assert_eq!(r.tex.width, r.bg.width);

    // bg:层内 region 已清空(单层文档=透明;上游 try_clear_surface 同语义)
    assert_eq!(px(&r.bg, 1, 1)[3], 0, "bg has the region cleared in the layer");
    // tex:区域整体不透明红色(无选区 alpha 加权——对比自由变换的 split 语义)
    let t = px(&r.tex, 1, 1);
    assert!(t[3] > 200 && t[0] > 200, "tex is the full region pixel: {t:?}");

    // 零文档改动零历史
    let st = m.state(doc).unwrap();
    assert_eq!(st["revision"], rev);
    assert_eq!(st["history"].as_array().unwrap().len(), hist);
}

/// 无选区:region=层内容 bounds;空层拒绝(引擎 cas_plan 同报错)。
#[test]
fn cas_begin_without_selection_uses_layer_content_bounds_and_rejects_empty() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 48, "transparent").unwrap();
    m.run(doc, "layer.new.layer", json!({"name": "A"})).unwrap();
    m.run(doc, "select.rect", json!({"x": 4, "y": 4, "width": 20, "height": 10})).unwrap();
    m.run(doc, "edit.fill", json!({"color": "#00ff00"})).unwrap();
    m.run(doc, "select.deselect", json!({})).unwrap();

    let r = m.cas_begin(doc).unwrap();
    assert_eq!(r.info["frame"], json!([4, 4, 24, 14]), "region is the layer content bounds");

    // 空层(无像素)拒绝
    m.run(doc, "layer.new.layer", json!({"name": "B"})).unwrap();
    let err = m.cas_begin(doc).unwrap_err().to_string();
    assert!(err.contains("empty"), "empty layer is rejected: {err}");
}

/// 后台预览:起跑返回代理尺寸(≤384),轮询到 done 拿到同尺寸 RGBA;
/// 新 start 取消旧线程(收发不串号);坏参数与命令同报错。
#[test]
fn cas_preview_carves_a_reduced_copy_and_replaces_running_ones() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 48, "transparent").unwrap();
    m.run(doc, "layer.new.layer", json!({"name": "A"})).unwrap();
    m.run(doc, "select.rect", json!({"x": 0, "y": 0, "width": 64, "height": 48})).unwrap();
    m.run(doc, "edit.fill", json!({"color": "#ff0000"})).unwrap();
    m.run(doc, "select.deselect", json!({})).unwrap();

    let size = m.cas_preview_start(doc, 1, json!({"width": 32}), 384).unwrap();
    assert_eq!(size, [32, 48], "preview size follows the params");

    let mut done = None;
    for _ in 0..2000 {
        let p = m.cas_preview_poll();
        if p.state == "done" {
            assert_eq!(p.tag, 1);
            done = Some((p.width, p.height, p.pixels));
            break;
        }
        assert_eq!(p.state, "running", "no failure expected: {:?}", p.error);
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let (w, h, pixels) = done.expect("preview finishes");
    assert_eq!([w, h], [32, 48]);
    assert_eq!(pixels.len(), (w * h * 4) as usize);
    // 纯红块收窄 32:接缝处仍是红色系(保护色不保证,只验不透明)
    assert!(pixels[3] > 200, "preview pixel is opaque");

    // 换参数重起:旧线程被取消,新 tag 认路
    m.cas_preview_start(doc, 2, json!({"width": 16}), 384).unwrap();
    let mut done2 = false;
    for _ in 0..2000 {
        let p = m.cas_preview_poll();
        if p.state == "done" {
            assert_eq!(p.tag, 2, "the second start's result comes back");
            done2 = true;
            break;
        }
        if p.state == "failed" {
            // 首条线程被取消不影响第二条:failed 只能是第二条(罕见),失败也认
            done2 = p.tag == 2;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert!(done2, "restarted preview settles");

    // 坏参数与命令同报错(cas_plan 共享)
    let err = m.cas_preview_start(doc, 3, json!({"width": 0}), 384).unwrap_err().to_string();
    assert!(err.contains("1..60000"), "bad width rejected: {err}");

    // 停:再轮询回 idle
    m.cas_preview_stop();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert_eq!(m.cas_preview_poll().state, "idle");
}

/// 提交 job:Session 后台跑,apply 落文档=一步 "Content-Aware Scale",
/// 结果 bounds=目标矩形;undo 一步还原。job 事件经 cas_job_poll 排干。
#[test]
fn cas_commit_runs_as_a_job_and_applies_one_history_step() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 48, "transparent").unwrap();
    m.run(doc, "layer.new.layer", json!({"name": "A"})).unwrap();
    m.run(doc, "select.rect", json!({"x": 0, "y": 0, "width": 64, "height": 48})).unwrap();
    m.run(doc, "edit.fill", json!({"color": "#ff0000"})).unwrap();
    m.run(doc, "select.deselect", json!({})).unwrap();
    let hist = m.state(doc).unwrap()["history"].as_array().unwrap().len();

    let started = m.cas_commit(doc, json!({"width": 40, "height": 48, "x": 10, "y": 2})).unwrap();
    assert!(started["job"].is_u64(), "a background job started: {started}");

    let mut result = None;
    for _ in 0..4000 {
        let events = m.cas_job_poll();
        for e in events.as_array().unwrap() {
            if e["command"] == "edit.contentAwareScale" {
                if let Some(v) = e["outcome"].get("done") {
                    result = Some(v.clone());
                } else if let Some(msg) = e["outcome"].get("failed").and_then(Value::as_str) {
                    panic!("job failed: {msg}");
                }
            }
        }
        if result.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let v = result.expect("job completes");
    assert_eq!(v["to"], json!([40, 48]));
    assert_eq!(v["bounds"], json!([10, 2, 40, 48]), "result placed at x/y");

    let st = m.state(doc).unwrap();
    let hist2 = st["history"].as_array().unwrap();
    assert_eq!(hist2.len(), hist + 1, "one history step");
    assert_eq!(hist2.last().unwrap(), "Content-Aware Scale");
    // 内容边界=放置矩形
    let r = m.cas_begin(doc).unwrap();
    assert_eq!(r.info["frame"], json!([10, 2, 50, 50]));

    m.run(doc, "edit.undo", json!({})).unwrap();
    let st = m.state(doc).unwrap();
    assert_eq!(st["history"].as_array().unwrap().len(), hist, "undo restores");
}
