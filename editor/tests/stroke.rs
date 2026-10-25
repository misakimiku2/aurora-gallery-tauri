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
    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[20, 32, 1.0]]), "#ff0000", false)).unwrap();
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

    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[16, 32, 1.0]]), "#ff0000", true)).unwrap();
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
    let _ = m.stroke_begin(doc, "paint.blur", p).unwrap();
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
    let f0 = m.stroke_begin(doc, "paint.blur", p).unwrap();
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
    let _ = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[8, 8, 1.0]]), "#ff0000", false)).unwrap();
    let f1 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[40, 40, 1.0]]), "#0000ff", false)).unwrap();
    assert!(f1.width > 0, "second begin recovers");
    let (out, _) = m.stroke_commit(doc).unwrap();
    assert_eq!(out.result.get("fromLive"), Some(&json!(true)));
    // 文档上只有第二笔(蓝);被遗弃的第一笔从未提交
    assert!(full_px(&mut m, doc, 40, 40)[2] > 200, "second stroke committed");
    assert_eq!(full_px(&mut m, doc, 8, 8), [255, 255, 255], "abandoned stroke never lands");
}

#[test]
fn stroke_error_paths() {
    let mut m = EditorManager::new();
    let doc = m.new_document(32, 32, "white").unwrap();
    let base = m.run(doc, "document.inspect", json!({})).unwrap().revision;

    // 未知命令族 / 缺 points / 无描边时 push/commit
    assert!(m.stroke_begin(doc, "select.rect", json!({"points": [[1, 1, 1]]})).is_err());
    assert!(m.stroke_begin(doc, "paint.stroke", json!({})).is_err());
    assert!(m.stroke_push(doc, &[1.0, 1.0, 1.0]).is_err());
    assert!(m.stroke_commit(doc).is_err());

    // 非法坐标:整批拒绝(引擎 check_coords),描边仍在,可正常提交
    let f0 = m.stroke_begin(doc, "paint.stroke", brush_params(json!([[5, 5, 1.0]]), "#ff0000", false)).unwrap();
    assert!(f0.width > 0);
    assert!(m.stroke_push(doc, &[6.0, 6.0, 1.0, 1e9, 1e9, 1.0]).is_err());

    // 取消:无历史步(revision 不动),再 commit 报错
    m.stroke_cancel(doc).unwrap();
    assert!(m.stroke_commit(doc).is_err());
    let after = m.run(doc, "document.inspect", json!({})).unwrap();
    assert_eq!(after.revision, base, "cancelled stroke leaves no history");
}
