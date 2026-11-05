//! 导出为对话框桥集成测试:定型管线(临时 Session 三条命令)零文档改动、
//! 缩放/重采样/压平语义、图层级源尺寸、大小估计。

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

fn preview_px(p: &aurora_editor::export_dialog::ExportPreview, x: usize, y: usize) -> [u8; 4] {
    let i = (y * p.rendered.width as usize + x) * 4;
    [
        p.rendered.pixels[i],
        p.rendered.pixels[i + 1],
        p.rendered.pixels[i + 2],
        p.rendered.pixels[i + 3],
    ]
}

/// 上游 export_pixels:scale 模式逐边独立 round(101×101 @50% = 51×51,而非共享
/// 同一缩放系数的 50×50);pixels 模式显式 W/H 生效;max_side 先压长边再 round。
#[test]
fn export_pixels_rounds_each_side_and_honors_explicit_size() {
    let f = json!({ "sizing": "scale", "scale": 50 });
    assert_eq!(aurora_editor::export_dialog::export_pixels(101.0, 101.0, &f, None).unwrap(), (51.0, 51.0));
    assert_eq!(aurora_editor::export_dialog::export_pixels(8.0, 100.0, &f, None).unwrap(), (4.0, 50.0));

    let px = json!({ "sizing": "pixels", "width": 300, "height": 100 });
    assert_eq!(aurora_editor::export_dialog::export_pixels(1000.0, 500.0, &px, None).unwrap(), (300.0, 100.0));
    // scale 模式忽略显式尺寸
    let mixed = json!({ "sizing": "scale", "scale": 100, "width": 300, "height": 100 });
    assert_eq!(aurora_editor::export_dialog::export_pixels(1000.0, 500.0, &mixed, None).unwrap(), (1000.0, 500.0));

    // 预览代理:长边压到 512 再 round
    let f = json!({ "sizing": "scale", "scale": 100 });
    let (w, h) = aurora_editor::export_dialog::export_pixels(2000.0, 1000.0, &f, Some(512)).unwrap();
    assert_eq!((w, h), (512.0, 256.0));
    // 越界报错(上游 finite_px)
    assert!(aurora_editor::export_dialog::export_pixels(10.0, 10.0, &json!({"sizing":"pixels","width":0,"height":10}), None).is_err());
    assert!(aurora_editor::export_dialog::export_pixels(10.0, 10.0, &json!({"sizing":"scale","scale":0}), None).is_err());
}

/// 缩放+重编码落盘:源文档/会话零改动(预览与导出走文档克隆),输出尺寸=标签尺寸。
#[test]
fn export_document_to_scales_without_touching_source() {
    let mut m = EditorManager::new();
    let doc = m.new_document(100, 50, "white").unwrap();
    let rev = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    let dir = std::env::temp_dir().join(format!("aurora-export-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("out.png");
    let path = path.to_str().unwrap();

    let r = m
        .export_document_to(doc, None, path, &json!({ "format": "png", "sizing": "scale", "scale": 50, "resample": "nearest", "transparency": true }))
        .unwrap();
    assert_eq!((r["width"].clone(), r["height"].clone()), (json!(50), json!(25)), "output is scaled: {r}");
    assert!(r["bytes"].as_u64().unwrap() > 0);
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..4], &[0x89, b'P', b'N', b'G'], "real PNG encode");
    // 源文档零改动:revision 不动、整幅仍是 100×50
    assert_eq!(m.run(doc, "document.inspect", json!({})).unwrap().revision, rev);
    assert_eq!((m.render_full(doc).unwrap().width, m.render_full(doc).unwrap().height), (100, 50));

    std::fs::remove_dir_all(&dir).ok();
}

/// nearest 200%:每源像素放大成精确 2×2 块(上游 nearest_neighbor_doubles_each_pixel)。
#[test]
fn preview_nearest_doubles_pixels_into_exact_blocks() {
    let mut m = EditorManager::new();
    let doc = m.new_document(4, 4, "white").unwrap();
    // 右下角红点(小笔径,远离左上角)
    let mut p0 = brush_params(json!([[3, 3, 1.0]]), "#ff0000");
    p0["size"] = json!(2.0);
    m.stroke_begin(doc, "paint.stroke", p0, false).unwrap();
    m.stroke_commit(doc).unwrap();

    let p = m
        .export_preview(doc, None, &json!({ "format": "png", "sizing": "scale", "scale": 200, "resample": "nearest" }))
        .unwrap();
    assert_eq!((p.rendered.width, p.rendered.height), (8, 8));
    // G 通道(红≈0/白=255);nearest 语义:每源像素→精确 2×2 块(块内一致),不渗色
    assert_eq!(preview_px(&p, 0, 0)[1], 255, "untouched corner stays pure white");
    assert_eq!(preview_px(&p, 6, 6)[1], preview_px(&p, 7, 7)[1], "nearest: 2×2 block uniform");
    assert_eq!(preview_px(&p, 4, 4)[1], preview_px(&p, 5, 5)[1], "nearest: 2×2 block uniform");
    assert!(preview_px(&p, 7, 7)[1] < 128, "painted corner stays dark: {}", preview_px(&p, 7, 7)[1]);
}

/// transparency=false(jpg 强制):压平到不透明背景,透明洞被填(上游 export_document
/// 的 layer.flattenImage 分支)。
#[test]
fn preview_flattens_when_transparency_off() {
    let mut m = EditorManager::new();
    let doc = m.new_document(16, 16, "transparent").unwrap();
    m.stroke_begin(doc, "paint.stroke", brush_params(json!([[8, 8, 1.0]]), "#ff0000"), false).unwrap();
    m.stroke_commit(doc).unwrap();

    let on = m.export_preview(doc, None, &json!({ "format": "png", "sizing": "scale", "scale": 100, "transparency": true })).unwrap();
    assert_eq!(preview_px(&on, 0, 0)[3], 0, "transparency on: corner stays transparent");
    let off = m.export_preview(doc, None, &json!({ "format": "png", "sizing": "scale", "scale": 100, "transparency": false })).unwrap();
    assert_eq!(preview_px(&off, 0, 0)[3], 255, "transparency off: flattened opaque");
}

/// 图层级导出:源尺寸=图层内容边界(裁剪到自身像素),而非整幅文档。
#[test]
fn layer_export_source_is_trimmed_to_its_pixels() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "white").unwrap();
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    let st = m.state(doc).unwrap();
    let layer = st["activeLayer"].as_u64().unwrap();
    m.stroke_begin(doc, "paint.stroke", brush_params(json!([[20, 20, 1.0]]), "#00ff00"), false).unwrap();
    m.stroke_commit(doc).unwrap();

    let p = m.export_preview(doc, Some(layer), &json!({ "format": "png", "sizing": "scale", "scale": 100 })).unwrap();
    assert!(p.src_w < 32 && p.src_h < 32, "layer source is trimmed to its pixels: {}x{}", p.src_w, p.src_h);
    assert!(p.src_w > 0 && p.src_h > 0);
    let full = m.export_preview(doc, None, &json!({ "format": "png", "sizing": "scale", "scale": 100 })).unwrap();
    assert_eq!((full.src_w, full.src_h), (32, 32), "document-level source is the whole canvas");
}

/// 大小估计:小图全量内存编码=精确值与落盘字节数一致(上游 the_estimate_is_the_exported_files_size)。
#[test]
fn estimate_matches_exported_size_for_small_images() {
    let mut m = EditorManager::new();
    let doc = m.new_document(16, 16, "white").unwrap();
    let est = m
        .export_estimate(doc, None, &json!({ "format": "png", "sizing": "scale", "scale": 100, "transparency": true }))
        .unwrap();
    assert_eq!(est["exact"], json!(true));
    let dir = std::env::temp_dir().join(format!("aurora-est-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("est.png");
    let r = m.export_document_to(doc, None, path.to_str().unwrap(), &json!({ "format": "png", "sizing": "scale", "scale": 100, "transparency": true })).unwrap();
    assert_eq!(est["bytes"], r["bytes"], "exact estimate equals the written file size");
    std::fs::remove_dir_all(&dir).ok();
}
