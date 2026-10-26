//! live 描边桥集成测试:画笔/橡皮(LiveStroke)与顺序 dab 工具(LiveDab)的
//! begin → push → commit 生命周期、fromLive 提交握手、增量帧字节、异常路径。

use aurora_editor::{EditorManager, StrokeFrame};
use serde_json::{json, Value};

fn px(f: &StrokeFrame, x: usize, y: usize) -> [u8; 3] {
    let i = (y * f.width as usize + x) * 4;
    [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2]]
}

fn in_frame(f: &StrokeFrame, x: i64, y: i64) -> bool {
    x >= f.x as i64 && y >= f.y as i64 && (x - f.x as i64) < f.width as i64 && (y - f.y as i64) < f.height as i64
}

fn full_px(m: &mut EditorManager, doc: u64, x: usize, y: usize) -> [u8; 3] {
    let img = m.render_full(doc).unwrap();
    let i = (y * img.width as usize + x) * 4;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]
}

fn brush_params(points: Value, color: &str, erase: bool) -> Value {
    json!({
        "points": points,
        "size": 12.0,
        "hardness": 1.0,
        "opacity": 1.0,
        "flow": 1.0,
        "spacing": 0.25,
        "smoothing": 0.0,
        "color": color,
        "erase": erase,
    })
}

#[test]
fn brush_live_stroke_commits_from_live() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    // 落笔:首点帧覆盖起点,且是红色笔画(文档克隆上的真像素)
    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[20, 32, 1.0]]), "#ff0000", false), false).unwrap();
    assert!(f0.width > 0 && f0.height > 0, "begin renders the first dab: {f0:?}");
    assert!(in_frame(&f0, 20, 32));
    let c = px(&f0, (20 - f0.x) as usize, (32 - f0.y) as usize);
    assert!(c[0] > 200 && c[1] < 80, "first dab is red, got {c:?}");

    // 拖动:两批点,帧覆盖新增区域
    let f1 = m.stroke_push(doc, &[30.0, 32.0, 1.0, 40.0, 32.0, 1.0]).unwrap();
    assert!(f1.width > 0 && f1.height > 0);
    assert!(in_frame(&f1, 40, 32), "frame covers the pushed extent");
    // 描边未提交:正式文档(会话 doc)不变,revision 停在 base
    let mid = m.run(doc, "document.inspect", json!({})).unwrap().revision;
    assert_eq!(mid, base, "live preview does not touch the session document");

    // 抬笔:命中 live 像素(fromLive),推进一步历史
    let (out, tail) = m.stroke_commit(doc).unwrap();
    assert!(out.revision > base);
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)), "commit takes the live pixels: {}", out.result);
    let d = out.damage.expect("commit reports damage");
    assert!(d.2 > 0 && d.3 > 0);
    // 全程帧已覆盖 damage:补差帧为空(前端据此跳过整幅重渲)
    assert_eq!(tail.width, 0, "fully shown stroke needs no catch-up frame: {tail:?}");

    // 提交后的正式文档与预览一致:路径中点为红,远处为白
    assert!(full_px(&mut m, doc, 30, 32)[0] > 200, "midpoint painted");
    assert_eq!(full_px(&mut m, doc, 5, 5), [255, 255, 255], "far corner untouched");

    // 一步撤销回到白底
    m.run(doc, "edit.undo", json!({})).unwrap();
    assert_eq!(full_px(&mut m, doc, 30, 32), [255, 255, 255]);
}

#[test]
fn eraser_is_paint_stroke_with_erase() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();

    // 先画黑线(Background 层锁定透明度:擦除=涂背景色,这里背景色=白)
    m.run(doc, "paint.stroke", brush_params(json!([[16, 32, 1.0], [48, 32, 1.0]]), "#000000", false)).unwrap();
    assert!(full_px(&mut m, doc, 32, 32)[0] < 80, "black line painted");
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[16, 32, 1.0]]), "#ff0000", true), false).unwrap();
    assert!(f0.width > 0);
    let _ = m.stroke_push(doc, &[32.0, 32.0, 1.0, 48.0, 32.0, 1.0]).unwrap();
    let (out, _) = m.stroke_commit(doc).unwrap();
    assert!(out.revision > base);
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)));
    // 擦掉黑线:中点回到白(锁定透明度的 Background 上是涂背景色)
    let c = full_px(&mut m, doc, 32, 32);
    assert!(c[0] > 200, "erased midpoint back to background: {c:?}");
}

#[test]
fn dab_tools_live_then_commit() {
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    // 画一条黑线当模糊对象
    m.run(doc, "paint.stroke", brush_params(json!([[16, 32, 1.0], [48, 32, 1.0]]), "#000000", false)).unwrap();
    let before = m.render_full(doc).unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    // blur:retouch 族参数单位是百分数(hardness/opacity/flow/spacing)。
    // 首点帧可以为空(会话默认平滑 0.1 会扣住首 dab,收尾 dab 在 commit 补)。
    let p = json!({
        "points": [[16, 32, 1.0]],
        "size": 20.0, "hardness": 80, "opacity": 100, "flow": 100, "spacing": 25,
        "strength": 80,
    });
    let _ = m.stroke_begin(doc, "paint.blur", p, false).unwrap();
    let f1 = m.stroke_push(doc, &[32.0, 32.0, 1.0, 48.0, 32.0, 1.0]).unwrap();
    assert!(f1.width > 0 && f1.height > 0);
    let (out, tail) = m.stroke_commit(doc).unwrap();
    assert!(out.revision > base);
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)), "dab commit takes live pixels");
    // 收尾 dab(平滑扣住的尾部)不经 push 链路:补差帧必须落在 damage 内
    let dmg = out.damage.unwrap();
    assert!(
        tail.width == 0
            || (dmg.0 <= tail.x && dmg.1 <= tail.y && dmg.0 + dmg.2 as i32 >= tail.x + tail.width as i32),
        "catch-up frame within damage: {tail:?} vs {dmg:?}"
    );

    // 模糊真实生效:黑线硬边被软化,文档内确有像素变化
    let after = m.render_full(doc).unwrap();
    let changed = before
        .pixels
        .chunks_exact(4)
        .zip(after.pixels.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    assert!(changed > 0, "blur changed {changed} pixels");
    // 补差帧像素与提交后的正式文档一致(fromLive:帧即提交结果)
    if tail.width > 0 {
        let x = (32 - tail.x).max(0) as usize;
        let y = (32 - tail.y).max(0) as usize;
        if x < tail.width as usize && y < tail.height as usize {
            assert_eq!(px(&tail, x, y), full_px(&mut m, doc, 32, 32), "catch-up frame matches the committed doc");
        }
    }
}

#[test]
fn dab_tap_dot_is_delivered() {
    // 点击式点画(无拖动):首帧可空(平滑扣住首 dab),像素必须由 commit 补差帧送达
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    m.run(doc, "paint.stroke", brush_params(json!([[24, 40, 1.0], [40, 40, 1.0]]), "#000000", false)).unwrap();
    let before = full_px(&mut m, doc, 32, 40);
    assert!(before[0] < 80, "black line under the tap point");

    let p = json!({
        "points": [[32, 40, 1.0]],
        "size": 16.0, "hardness": 80, "opacity": 100, "flow": 100, "spacing": 25, "strength": 90,
    });
    let f0 = m.stroke_begin(doc, "paint.blur", p, false).unwrap();
    let (out, tail) = m.stroke_commit(doc).unwrap();
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)));
    if f0.width == 0 {
        assert!(tail.width > 0 && tail.height > 0, "undelivered tap pixels must come in the catch-up frame: {tail:?}");
        // 补差帧像素与提交后的正式文档一致
        let x = (32 - tail.x).max(0) as usize;
        let y = (40 - tail.y).max(0) as usize;
        if x < tail.width as usize && y < tail.height as usize {
            assert_eq!(px(&tail, x, y), full_px(&mut m, doc, 32, 40), "catch-up frame matches the committed doc");
        }
    }
}

#[test]
fn stroke_begin_recovers_from_abandoned_live() {
    // 前端异常路径可能遗留未 commit/cancel 的 live:下一次 begin 自愈(丢弃旧笔),
    // 而不是永久 "a stroke is already active"(用户实测:十余笔后画笔/橡皮全失灵)
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    let _ = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[8, 8, 1.0]]), "#ff0000", false), false).unwrap();
    let f1 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[40, 40, 1.0]]), "#0000ff", false), false).unwrap();
    assert!(f1.width > 0, "second begin recovers");
    let (out, _) = m.stroke_commit(doc).unwrap();
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)));
    // 文档上只有第二笔(蓝);被遗弃的第一笔从未提交
    assert!(full_px(&mut m, doc, 40, 40)[2] > 200, "second stroke committed");
    assert_eq!(full_px(&mut m, doc, 8, 8), [255, 255, 255], "abandoned stroke never lands");
}

#[test]
fn float_drag_previews_and_drops_as_one_move() {
    // 移动工具·选区像素(photocraft move_ui 口径):
    // 按下 select.float 切割(零历史)→ 拖动纯函数预览 → select.float 提交偏移(仍零历史)
    // → select.drop 落定 = 一步 "Move" 历史
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    m.run(doc, "paint.stroke", brush_params(json!([[20, 20, 1.0], [44, 20, 1.0]]), "#000000", false)).unwrap();
    m.run(doc, "select.rect", json!({"x": 18, "y": 12, "width": 28, "height": 16})).unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;
    let before = m.render_full(doc).unwrap();

    // 按下即切割:revision 不动(零历史)
    let cut = m.run(doc, "select.float", json!({"dx": 0, "dy": 0})).unwrap();
    assert_eq!(cut.revision, base, "float cut adds no history");
    assert_eq!(cut.result["offset"], json!([0, 0]));

    // 预览帧:displayed 合成(浮动件按未提交增量挪动)。切割后原位显示与切割前同像素;
    // extra=(10,0) 时选区右缘外出现黑、原左缘露出白
    let f0 = m.move_frame(doc, "float", 0, 0, 0, 0, 64, 64).unwrap();
    assert!(f0.width == 64 && f0.height == 64);
    let f1 = m.move_frame(doc, "float", 10, 0, 0, 0, 64, 64).unwrap();
    let changed = f0
        .pixels
        .chunks_exact(4)
        .zip(f1.pixels.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    assert!(changed > 0, "preview moves the piece: {changed} px changed");

    // 提交总位移(仍零历史,保持浮动)+ 落定 = 一步历史
    let commit = m.run(doc, "select.float", json!({"dx": 10, "dy": 0})).unwrap();
    assert_eq!(commit.revision, base);
    assert_eq!(commit.result["offset"], json!([10, 0]));
    let drop = m.run(doc, "select.drop", json!({})).unwrap();
    assert!(drop.revision > base, "drop is one history step");
    assert_eq!(drop.result["dropped"], json!(true));

    // 落定后:右移后的线与原位的洞(白)
    let after = m.render_full(doc).unwrap();
    let diff = before
        .pixels
        .chunks_exact(4)
        .zip(after.pixels.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    assert!(diff > 0, "pixels moved");

    // 一步 undo 拿回全部
    m.run(doc, "edit.undo", json!({})).unwrap();
    let undone = m.render_full(doc).unwrap();
    assert_eq!(undone.pixels, before.pixels, "one undo restores the pre-move pixels");

    // 无浮动时 float 预览报错(选区还在但已 drop → 重新切割会再切;先取消选区再验)
    m.run(doc, "select.deselect", json!({})).unwrap();
    assert!(m.move_frame(doc, "float", 0, 0, 0, 0, 8, 8).is_err());
}

#[test]
fn layer_drag_preview_and_translate() {
    // 移动工具·整层:moved 纯函数预览(不入历史)→ layer.translate 一步 "Move"
    let mut m = EditorManager::new();
    let doc = m.new_document(64, 64, "white").unwrap();
    // 新建透明层画黑块(Background 锁定移不动,用普通层)
    m.run(doc, "layer.new.layer", json!({})).unwrap();
    m.run(doc, "paint.stroke", brush_params(json!([[10, 10, 1.0], [30, 10, 1.0]]), "#000000", false)).unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;
    let before = m.render_full(doc).unwrap();

    // 预览:整层平移 8px(选区无 → bounds 即活动层)
    let f0 = m.move_frame(doc, "layer", 8, 0, 0, 0, 64, 64).unwrap();
    assert_eq!(f0.width, 64);
    let changed = before
        .pixels
        .chunks_exact(4)
        .zip(f0.pixels.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    assert!(changed > 0, "layer preview shifts content");
    // 预览不入历史
    let mid = m.run(doc, "document.inspect", json!({})).unwrap().revision;
    assert_eq!(mid, base, "preview adds no history");

    // 提交:一条 translate 一步历史
    let out = m.run(doc, "layer.translate", json!({"dx": 8, "dy": 0})).unwrap();
    assert!(out.revision > base);
    let after = m.render_full(doc).unwrap();
    let moved_px = after
        .pixels
        .chunks_exact(4)
        .zip(f0.pixels.chunks_exact(4))
        .filter(|(a, b)| a[..3] != b[..3])
        .count();
    assert_eq!(moved_px, 0, "commit matches the preview frame");
    m.run(doc, "edit.undo", json!({})).unwrap();
    let undone = m.render_full(doc).unwrap();
    assert_eq!(undone.pixels, before.pixels, "one undo restores");
}

#[test]
fn save_overwrites_image_and_psd_companion_restores_layers() {
    // M3 保存链路(拍板:Ctrl+S 覆盖原图 + 同名 .psd 分层伴生,重开优先伴生):
    // 造白 PNG → 打开 → 新层画红 → save(原图平面导出 + .psd)→ 重开 = 2 层(PSD 伴生恢复)
    let dir = std::env::temp_dir().join(format!("aurora-save-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let img = dir.join("t.png");
    let psd = dir.join("t.psd");
    let img_s = img.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&img);
    let _ = std::fs::remove_file(&psd);

    let mut m = EditorManager::new();
    let doc = m.new_document(32, 24, "white").unwrap();
    m.export_as(doc, &img_s).unwrap();
    assert!(img.is_file(), "export_as wrote the flat png");
    assert!(!psd.exists(), "export_as writes no companion");

    let doc2 = m.open_path(&img_s).unwrap();
    assert_eq!(m.run(doc2, "document.inspect", json!({})).unwrap().result["layers"].as_array().unwrap().len(), 1);

    // 新层画红笔(分层证据:平面图上只有一个 Background)
    m.run(doc2, "layer.new.layer", json!({})).unwrap();
    m.run(doc2, "tools.setColors", json!({"foreground": "#ff0000"})).unwrap();
    m.run(doc2, "paint.stroke", brush_params(json!([[8, 12, 1.0], [24, 12, 1.0]]), "#ff0000", false)).unwrap();

    // 保存:原图被覆盖 + .psd 伴生新建;已存水位推进(状态点变绿)
    assert_eq!(m.state(doc2).unwrap()["dirty"], json!(true), "edits mark dirty");
    let out = m.save(doc2).unwrap();
    assert_eq!(out["imagePath"], json!(img_s));
    assert_eq!(out["psdPath"], json!(psd.to_string_lossy().into_owned()));
    assert_eq!(out["psdExisted"], json!(false));
    assert!(psd.is_file(), "psd companion written");
    assert_eq!(m.state(doc2).unwrap()["dirty"], json!(false), "save clears dirty");
    assert!(m.render_full(doc2).is_ok());

    // 重开:伴生 PSD 优先 → 两层(平面 png 只能还原出一层 Background)
    let doc3 = m.open_path(&img_s).unwrap();
    let st = m.run(doc3, "document.inspect", json!({})).unwrap().result;
    let layers = st["layers"].as_array().unwrap();
    assert_eq!(layers.len(), 2, "psd companion restores layers, got {}", st["layers"]);
    // 合成里红笔可见(重开即所见)
    let c = full_px(&mut m, doc3, 16, 12);
    assert!(c[0] > 200 && c[1] < 80, "stroke visible after reopen, got {c:?}");

    // 二次保存:psdExisted=true
    let out2 = m.save(doc3).unwrap();
    assert_eq!(out2["psdExisted"], json!(true));

    // 无路径文档(剪贴板新建)报错
    let doc4 = m.new_document(8, 8, "white").unwrap();
    assert!(m.save(doc4).is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn save_as_reencodes_to_chosen_format_and_rebinds() {
    // 另存为(用户口径:打开 jpg 另存 png,产物必须是真 PNG 而非改后缀):
    // photocraft_io::export 按目标扩展名走对应编码器 → 魔数断言;文档改绑新路径
    let dir = std::env::temp_dir().join(format!("aurora-saveas-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let jpg = dir.join("src.jpg");
    let png = dir.join("dst.png");
    let webp = dir.join("dst.webp");
    let jpg_s = jpg.to_string_lossy().into_owned();
    let png_s = png.to_string_lossy().into_owned();
    let webp_s = webp.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&jpg);
    let _ = std::fs::remove_file(&png);
    let _ = std::fs::remove_file(&webp);

    let mut m = EditorManager::new();
    let doc = m.new_document(32, 24, "white").unwrap();
    m.export_as(doc, &jpg_s).unwrap();
    assert_eq!(std::fs::read(&jpg).unwrap()[..3], [0xFF, 0xD8, 0xFF], "source is a real jpeg");

    let doc2 = m.open_path(&jpg_s).unwrap();
    m.run(doc2, "paint.stroke", brush_params(json!([[8, 12, 1.0], [24, 12, 1.0]]), "#ff0000", false)).unwrap();

    // 另存为 PNG:真 PNG 魔数 + 文档改绑(随后的 save 写 png 而非原 jpg)
    let out = m.save_as(doc2, &png_s).unwrap();
    assert_eq!(out["imagePath"], json!(png_s));
    assert_eq!(out["psdPath"], json!(dir.join("dst.psd").to_string_lossy().into_owned()), "flat save-as writes a companion");
    assert_eq!(std::fs::read(&png).unwrap()[..4], [0x89, b'P', b'N', b'G'], "save-as png is a real png, not a renamed jpeg");
    assert_eq!(m.state(doc2).unwrap()["dirty"], json!(false));

    // 改绑验证:再画一笔 → Ctrl+S 语义的 save() 写的是新文件(dst.png 被重写,src.jpg 不动)
    let jpg_before = std::fs::metadata(&jpg).unwrap().modified().unwrap();
    let png_before = std::fs::metadata(&png).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    m.run(doc2, "paint.stroke", brush_params(json!([[12, 8, 1.0], [20, 16, 1.0]]), "#0000ff", false)).unwrap();
    assert_eq!(m.state(doc2).unwrap()["dirty"], json!(true));
    m.save(doc2).unwrap();
    assert_ne!(std::fs::metadata(&png).unwrap().modified().unwrap(), png_before, "png rewritten after rebind");
    assert_eq!(std::fs::metadata(&jpg).unwrap().modified().unwrap(), jpg_before, "original jpg untouched after save-as rebind");
    // dst.psd 伴生也在第二次保存时更新
    assert!(dir.join("dst.psd").is_file());

    // 另存为 WebP:真 WebP(RIFF....WEBP)
    m.save_as(doc2, &webp_s).unwrap();
    let w = std::fs::read(&webp).unwrap();
    assert_eq!(&w[..4], b"RIFF", "webp riff header");
    assert_eq!(&w[8..12], b"WEBP", "webp magic");

    // 另存为 .psd:分层保存且无重复伴生(psdPath 缺省)
    let psd_target = dir.join("layered.psd");
    let out2 = m.save_as(doc2, &psd_target.to_string_lossy()).unwrap();
    assert_eq!(out2["psdPath"], json!(null), "psd target writes no extra companion");
    assert!(psd_target.is_file());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stroke_error_paths() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "white").unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    // 未知命令族 / 缺 points / 无描边时 push/commit
    assert!(m.stroke_begin(doc, "select.rect", json!({"points": [[1, 1, 1]]}), false).is_err());
    assert!(m.stroke_begin(doc, "paint.stroke", json!({}), false).is_err());
    assert!(m.stroke_push(doc, &[1.0, 1.0, 1.0]).is_err());
    assert!(m.stroke_commit(doc).is_err());

    // 非法坐标:整批拒绝(引擎 check_coords),描边仍在,可正常提交
    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[5, 5, 1.0]]), "#ff0000", false), false).unwrap();
    assert!(f0.width > 0);
    assert!(m.stroke_push(doc, &[6.0, 6.0, 1.0, 1e9, 1e9, 1.0]).is_err());

    // 取消:无历史步(revision 不动),再 commit 报错
    m.stroke_cancel(doc).unwrap();
    assert!(m.stroke_commit(doc).is_err());
    let after = m.run(doc, "document.inspect", json!({})).unwrap();
    assert_eq!(after.revision, base, "cancelled stroke leaves no history");
}
