//! Place 拖放桥集成测试:place_bytes 智能对象层(居中/fit 缩放/层名/历史标签)、
//! 提交折叠成一步 "Place Embedded"(fold label)、取消收回(take_back_made)。

use aurora_editor::EditorManager;
use serde_json::{json, Value};

/// 造一张 w×h 的白底 PNG 字节(引擎建文档→export_as 真编码→读回字节)。
fn png_bytes(tag: u32, w: u32, h: u32) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!("aurora-place-test-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(format!("src-{w}x{h}.png"));
    let ps = p.to_string_lossy().into_owned();
    let mut m = EditorManager::new();
    let d = m.new_document(w, h, "white").unwrap();
    m.export_as(d, &ps).unwrap();
    let bytes = std::fs::read(&p).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(&bytes[..4], &[0x89, b'P', b'N', b'G'], "fixture is a real png");
    bytes
}

fn layer_ids(st: &Value) -> Vec<u64> {
    st["layers"].as_array().unwrap().iter().map(|l| l["id"].as_u64().unwrap()).collect()
}

/// Place 语义:居中、超出画布等比 fit 缩放、智能对象层、层名=文件 stem、
/// 一步 "Place Embedded" 历史、返回值 bounds/scale/smartObject。
#[test]
fn place_centers_fit_scales_and_names_the_layer() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "transparent").unwrap();
    let hist0 = m.state(doc).unwrap()["history"].as_array().unwrap().len();

    // 32×16 放进 64×64:原尺寸居中
    let r = m.place(doc, "patch.png", png_bytes(1, 32, 16)).unwrap();
    assert_eq!(r["scale"], json!(100.0));
    assert_eq!(r["bounds"], json!([16.0, 24.0, 48.0, 40.0]));
    assert_eq!(r["smartObject"], json!(true));
    let layer = r["layer"].as_u64().unwrap();
    let st = m.state(doc).unwrap();
    assert_eq!(st["activeLayer"], json!(layer), "placed layer becomes active");
    let placed = st["layers"].as_array().unwrap().iter().find(|l| l["id"] == json!(layer)).unwrap();
    assert_eq!(placed["name"], json!("patch"), "layer name is the file stem");
    assert_eq!(placed["kind"], json!("Smart Object"), "smart object by default (prefs)");
    let hist = st["history"].as_array().unwrap();
    assert_eq!(hist.len(), hist0 + 1);
    assert_eq!(hist.last().unwrap(), &json!("Place Embedded"));

    // 128×128 放进 64×64:fit 缩放 50% 占满画布居中
    let r2 = m.place(doc, "big.png", png_bytes(1, 128, 128)).unwrap();
    assert_eq!(r2["scale"], json!(50.0));
    assert_eq!(r2["bounds"], json!([0.0, 0.0, 64.0, 64.0]));
}

/// 提交折叠:place+变换两步并成一步,标签 "Place Embedded"(fold_made 对 Place
/// set_current_label);折叠后 undo 一次同时撤掉置入与变换(purge_last 语义)。
#[test]
fn place_transform_folds_into_one_place_embedded_step() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "transparent").unwrap();
    let r = m.place(doc, "logo.png", png_bytes(2, 32, 32)).unwrap();
    let layer = r["layer"].as_u64().unwrap();

    // 变换一步(quad 平移 8,8;上游 edit.transform 对 Smart 层=非破坏保变换)
    m.run(doc, "edit.transform", json!({ "layer": layer, "rect": [16.0, 24.0, 48.0, 40.0], "quad": [[24.0, 32.0], [56.0, 32.0], [56.0, 48.0], [24.0, 48.0]] })).unwrap();
    let hist: Vec<String> = m.state(doc).unwrap()["history"].as_array().unwrap()
        .iter().map(|h| h.as_str().unwrap().to_string()).collect();
    assert_eq!(hist.last().map(String::as_str), Some("Free Transform"), "two steps before the fold");

    // 折叠(守卫:变换步执行前的快照还没有该层)→ 一步 "Place Embedded"
    let f = m.fold_transform_copy(doc, 0, layer, Some("Place Embedded")).unwrap();
    assert_eq!(f["folded"], json!(true));
    let hist: Vec<String> = m.state(doc).unwrap()["history"].as_array().unwrap()
        .iter().map(|h| h.as_str().unwrap().to_string()).collect();
    assert_eq!(hist.last().map(String::as_str), Some("Place Embedded"), "fold renames the surviving step");
    assert!(m.state(doc).unwrap()["layers"].as_array().unwrap().iter().any(|l| l["id"] == json!(layer)), "layer survives the fold");
}

/// 取消收回:take_back_made 对 placed 层原样成立(最后一步=置入步,执行前快照无该层)
/// → undo+清 redo,置入从未发生。
#[test]
fn cancel_takes_back_the_placed_layer() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "transparent").unwrap();
    let r = m.place(doc, "logo.png", png_bytes(3, 32, 32)).unwrap();
    let layer = r["layer"].as_u64().unwrap();
    assert!(layer_ids(&m.state(doc).unwrap()).contains(&layer));

    let t = m.take_back_made(doc, layer).unwrap();
    assert_eq!(t["took"], json!(true));
    let st = m.state(doc).unwrap();
    assert!(!layer_ids(&st).contains(&layer), "placed layer is gone");
    assert_eq!(st["history"].as_array().unwrap().last().unwrap(), &json!("Open"), "back to the open state");
}
