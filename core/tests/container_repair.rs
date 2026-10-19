//! `container_repair` 编排层的集成测试。
//!
//! 放成集成测试（而不是 `#[cfg(test)] mod tests`）有两个理由：
//! 1. 桌面和安卓都是从 crate **外面**调这些 pub API，这样能顺带验出可见性漏配；
//! 2. 该层唯一不可逆的动作是往用户媒体文件里写 4 个字节，值得单独一套端到端字节级断言。

use aurora_core::container_repair::{durations_of, repair_file, revert_file};
use aurora_core::db::container_repairs::{self, create_table};
use aurora_core::mp4_editlist;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

// --------------------------------------------------------------- 合成容器

fn bx(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
    v.extend_from_slice(tag);
    v.extend_from_slice(payload);
    v
}
fn b32(x: u32) -> Vec<u8> {
    x.to_be_bytes().to_vec()
}
fn b16(x: u16) -> Vec<u8> {
    x.to_be_bytes().to_vec()
}

/// 单 trak 的撒谎容器。
///
/// movie timescale = 1_000_000；轨 timescale = 1000、duration = 4,174,471 → 4174.471 s；
/// `elst` 单条 media_time=0、segment_duration = 2,770,890,000 → 2770.89 s。
/// 覆盖率 0.66 < 0.9、截断 1403 s > 5 s → 判坏。
fn lying_bytes() -> Vec<u8> {
    let mut mvhd_p = vec![0u8; 4];
    mvhd_p.extend_from_slice(&b32(0));
    mvhd_p.extend_from_slice(&b32(0));
    mvhd_p.extend_from_slice(&b32(1_000_000));
    mvhd_p.extend_from_slice(&b32(9_999_999));
    mvhd_p.extend_from_slice(&vec![0u8; 4 + 2 + 2 + 8 + 36 + 24 + 4]);

    let mut mdhd_p = vec![0u8; 4];
    mdhd_p.extend_from_slice(&b32(0));
    mdhd_p.extend_from_slice(&b32(0));
    mdhd_p.extend_from_slice(&b32(1000));
    mdhd_p.extend_from_slice(&b32(4_174_471));
    mdhd_p.extend_from_slice(&[0u8; 4]);

    let mut hdlr_p = vec![0u8; 4];
    hdlr_p.extend_from_slice(&b32(0));
    hdlr_p.extend_from_slice(b"vide");
    hdlr_p.extend_from_slice(&[0u8; 13]);

    let mut elst_p = vec![0u8; 4];
    elst_p.extend_from_slice(&b32(1));
    elst_p.extend_from_slice(&b32(2_770_890_000));
    elst_p.extend_from_slice(&0i32.to_be_bytes());
    elst_p.extend_from_slice(&b16(1));
    elst_p.extend_from_slice(&b16(0));

    let mut mdia_inner = Vec::new();
    mdia_inner.extend_from_slice(&bx(b"mdhd", &mdhd_p));
    mdia_inner.extend_from_slice(&bx(b"hdlr", &hdlr_p));
    mdia_inner.extend_from_slice(&bx(b"minf", &[]));

    let mut trak_inner = Vec::new();
    trak_inner.extend_from_slice(&bx(b"tkhd", &vec![0u8; 84]));
    trak_inner.extend_from_slice(&bx(b"mdia", &mdia_inner));
    trak_inner.extend_from_slice(&bx(b"edts", &bx(b"elst", &elst_p)));

    let mut moov_inner = Vec::new();
    moov_inner.extend_from_slice(&bx(b"mvhd", &mvhd_p));
    moov_inner.extend_from_slice(&bx(b"trak", &trak_inner));

    let mut file = Vec::new();
    file.extend_from_slice(&bx(b"ftyp", b"isom"));
    file.extend_from_slice(&bx(b"moov", &moov_inner));
    file
}

/// `elst` 第一条的 `segment_duration` 字段绝对偏移（合成件里位置固定，测试直接算）。
fn first_segment_field(bytes: &[u8]) -> usize {
    let v = {
        let dir = std::env::temp_dir().join(format!("aurora-cr-probe-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("probe.mp4");
        std::fs::write(&p, bytes).unwrap();
        let verdict = mp4_editlist::inspect(&p);
        let _ = std::fs::remove_file(&p);
        verdict
    };
    // elst 类型字段偏移 + 8（ver/flags 4 + entry_count 4）
    (v.repair_targets()[0] as usize) + 8
}

struct Fixture {
    dir: PathBuf,
    path: PathBuf,
    original: Vec<u8>,
    conn: Connection,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "aurora-crepair-{}-{}-{}",
            std::process::id(),
            name,
            uuid4()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let original = lying_bytes();
        let path = dir.join("v.mp4");
        std::fs::write(&path, &original).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        create_table(&conn).unwrap();
        Self { dir, path, original, conn }
    }

    fn bytes(&self) -> Vec<u8> {
        std::fs::read(&self.path).unwrap()
    }

    /// 模拟「字节已被遮蔽，但台账里没有账」：别人修的、或台账丢了。
    fn force_mask_without_ledger(&self) -> usize {
        let verdict = mp4_editlist::inspect(&self.path);
        let off = verdict.repair_targets()[0] as usize;
        let mut b = self.bytes();
        b[off..off + 4].copy_from_slice(b"free");
        std::fs::write(&self.path, &b).unwrap();
        off
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn uuid4() -> String {
    // 测试专用、只为目录名不撞车，不要求密码学质量
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", ns, std::process::id())
}

// --------------------------------------------------------------------- 测试

#[test]
fn repair_records_ledger_and_is_idempotent() {
    let f = Fixture::new("ledger");
    let r = repair_file(&f.conn, &f.path, "desktop");
    assert_eq!(r.status, "repaired", "实际 {r:?}");
    assert_eq!(r.offsets.len(), 1, "合成件只有 1 处 elst");
    assert!(
        r.hidden_ms > 1_000_000,
        "应报出被藏的毫秒，实际 {}",
        r.hidden_ms
    );

    let ledger = container_repairs::get(&f.conn, &f.path.to_string_lossy())
        .unwrap()
        .expect("修复必须留台账，否则无法还原");
    assert_eq!(ledger.offsets, r.offsets);
    assert_eq!(ledger.origin, "desktop");

    // 第二次再调用不该重复写盘
    let again = repair_file(&f.conn, &f.path, "desktop");
    assert_eq!(again.status, "alreadyRepaired", "重复修应报 alreadyRepaired，实际 {again:?}");
    assert_ne!(f.bytes(), f.original, "文件确实已被改过 4 字节");
}

#[test]
fn revert_restores_bytes_exactly_and_closes_ledger() {
    let f = Fixture::new("revert");
    assert_eq!(repair_file(&f.conn, &f.path, "desktop").status, "repaired");
    assert_ne!(f.bytes(), f.original);

    let back = revert_file(&f.conn, &f.path);
    assert_eq!(back.status, "repaired", "还原应成功，实际 {back:?}");
    assert_eq!(f.bytes(), f.original, "还原必须逐字节等价");
    assert!(
        container_repairs::get(&f.conn, &f.path.to_string_lossy())
            .unwrap()
            .is_none(),
        "还原后台账应注销"
    );
    // 还原后应重新回到「可修」而不是卡死在中间态
    assert_eq!(repair_file(&f.conn, &f.path, "desktop").status, "repaired");
}

/// 本层最重要的安全行为：**没有台账就拒绝还原**，绝不靠猜偏移去写用户的文件。
#[test]
fn revert_refuses_without_ledger_and_writes_nothing() {
    let f = Fixture::new("nolowledge");
    f.force_mask_without_ledger();
    let before = f.bytes();

    let r = revert_file(&f.conn, &f.path);
    assert_eq!(r.status, "failed");
    assert_eq!(r.error.as_deref(), Some("noLedger"));
    assert_eq!(f.bytes(), before, "拒绝还原时必须一个字节都不写");
}

/// 已遮蔽但无台账的文件要能被点名报出来，而不是被静默当成健康放行。
#[test]
fn masked_without_ledger_is_surfaced_not_silently_healthy() {
    let f = Fixture::new("maskednol");
    f.force_mask_without_ledger();

    let r = repair_file(&f.conn, &f.path, "android");
    assert_eq!(r.status, "maskedNoLedger", "实际 {r:?}");
    assert!(!r.offsets.is_empty(), "应把疑似偏移报出来供人工排查");
    assert!(
        container_repairs::get(&f.conn, &f.path.to_string_lossy())
            .unwrap()
            .is_none(),
        "推断出来的偏移不该被当作台账写入"
    );
}

#[test]
fn non_mp4_is_a_strict_no_op() {
    let f = Fixture::new("noops");
    let junk_bytes: Vec<u8> = (0..2048u32).map(|i| (i % 199) as u8).collect();
    let junk = f.dir.join("junk.mp4");
    std::fs::write(&junk, &junk_bytes).unwrap();

    let r = repair_file(&f.conn, &junk, "desktop");
    assert_eq!(r.status, "notApplicable", "实际 {r:?}");
    assert!(r.offsets.is_empty());
    assert_eq!(std::fs::read(&junk).unwrap(), junk_bytes, "不该被动过一个字节");
}

/// 覆盖率满的 edit list 属于正常文件，修它就是把好文件改坏。
#[test]
fn full_length_edit_list_is_left_alone() {
    let f = Fixture::new("fullcov");
    let mut b = f.original.clone();
    let field = first_segment_field(&b);
    // segment_duration: 2,770,890,000 → 4,174,471,000（movie ts 1e6 → 4174.471 s = 全片）
    b[field..field + 4].copy_from_slice(&4_174_471_000u32.to_be_bytes());
    let ok = f.dir.join("ok.mp4");
    std::fs::write(&ok, &b).unwrap();

    let r = repair_file(&f.conn, &ok, "desktop");
    assert_eq!(r.status, "healthy", "覆盖全片的 edit list 不该被修，实际 {r:?}");
    assert_eq!(std::fs::read(&ok).unwrap(), b, "healthy 判定后必须零写入");
}

/// 拿不到写权限（只读盘、网络盘、被占用）时：报 failed、不 panic、扫描要继续。
#[test]
fn unwritable_file_fails_gracefully() {
    let f = Fixture::new("readonly");
    set_readonly(&f.path, true);
    let r = repair_file(&f.conn, &f.path, "desktop");
    let restored = {
        set_readonly(&f.path, false);
        f.bytes() == f.original
    };
    assert_eq!(r.status, "failed", "只读文件应报 failed 而不是 panic，实际 {r:?}");
    assert!(r.error.is_some(), "要带上失败原因");
    assert!(restored, "写不动时文件必须原样");
}

#[test]
fn durations_reports_both_calibers() {
    let f = Fixture::new("durations");
    let d = durations_of(&f.path).unwrap();
    assert_eq!(d.table_ms, 4_174_471, "采样表口径应为 4174.471s");
    assert_eq!(d.elst_ms, 2_770_890, "elst 口径应为 2770.89s");
    assert!(durations_of(Path::new("Z:\\definitely-not-here.mp4")).is_none());
}

fn set_readonly(path: &Path, on: bool) {
    // `set_readonly` 是 std::fs::Permissions 的固有方法，跨平台可用，不需要 Ext trait
    let mut p = std::fs::metadata(path).unwrap().permissions();
    p.set_readonly(on);
    std::fs::set_permissions(path, p).unwrap();
}

/// 真实样本端到端验证（`#[ignore]`，只在开发机上按环境变量手动跑）。
///
/// 存在的理由：前面所有断言都建在我自己按规范拼的合成字节上。合成件能过，
/// 不代表真文件上也对（这次门禁就连错两次：只读第一条 elst、要求 media_time=0）。
/// 这条拿真文件跑完整链路，并钉住三条硬事实：
/// 1. 修复后文件**体积一字节不变**；
/// 2. 全文件差异**恰好 8 字节**（视频轨 + 音轨各 4 个类型标识字节）；
/// 3. 按台账还原后与原文件**逐字节相同**。
///
/// 只在临时副本上操作，绝不碰 `AURORA_ELST_REPAIR_SAMPLE` 指向的原件。
/// 跑法：`AURORA_ELST_REPAIR_SAMPLE=<mp4 路径> cargo test --test container_repair -- --ignored --nocapture`
#[test]
#[ignore = "需要本机样本；用 AURORA_ELST_REPAIR_SAMPLE 指定路径手动跑"]
fn repair_real_sample_end_to_end() {
    let src = std::env::var("AURORA_ELST_REPAIR_SAMPLE").expect("未设置 AURORA_ELST_REPAIR_SAMPLE");
    let dir = std::env::temp_dir().join(format!("aurora-cr-real-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("sample.mp4");
    std::fs::copy(&src, &copy).expect("复制样本到临时目录失败");
    let original = std::fs::read(&copy).unwrap();
    let size = original.len();

    let conn = Connection::open_in_memory().unwrap();
    create_table(&conn).unwrap();

    let before = aurora_core::mp4_editlist::inspect(&copy);
    println!(
        "修复前: status={:?} 采样表={}ms elst={}ms 藏={:.1}分钟",
        std::mem::discriminant(&before),
        durations_of(&copy).map(|d| d.table_ms).unwrap_or(-1),
        durations_of(&copy).map(|d| d.elst_ms).unwrap_or(-1),
        before.hidden_secs() / 60.0,
    );
    assert!(
        matches!(before, aurora_core::mp4_editlist::ContainerVerdict::Lying { .. }),
        "样本应当被判为撒谎 edit list"
    );

    let r = aurora_core::container_repair::repair_file(&conn, &copy, "desktop");
    assert_eq!(r.status, "repaired", "实际 {r:?}");
    let after = std::fs::read(&copy).unwrap();

    assert_eq!(after.len(), size, "体积必须一字节不变");
    let diff: Vec<usize> = (0..size).filter(|i| after[*i] != original[*i]).collect();
    println!("差异字节数={} 偏移={:?}", diff.len(), diff);
    assert_eq!(diff.len(), 8, "只应改动 2 条轨 × 4 字节类型标识");
    for g in diff.chunks(4) {
        assert_eq!(&original[g[0]..g[0] + 4], b"elst", "改的必须是 elst 类型字段");
        assert_eq!(&after[g[0]..g[0] + 4], b"free");
    }
    // 除这 8 字节外，画面/音频数据一个都没动
    assert!(diff.iter().all(|i| *i < 4_000_000), "改动应全在 moov 头部区域内");

    let back = aurora_core::container_repair::revert_file(&conn, &copy);
    assert_eq!(back.status, "repaired");
    assert_eq!(std::fs::read(&copy).unwrap(), original, "还原必须逐字节等价");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 真实样本上的 `mdat` 合并验证（`#[ignore]`，开发机按环境变量手动跑）。
///
/// 这条不是重复劳动：`mp4_mdat` 的合成件只证明「代码按我想的做」，这一条证明
/// 「我想的确实是那只真实下载件」—— 具体要钉死三件事：
/// 1. 改动恰好 4 个字节，且落在**第一个 mdat 的长度字段**上（不是任何别处）；
/// 2. 合并后顶层链只剩 1 个 mdat（这才是播放器不再走链的原因）；
/// 3. 台账能把它逐字节还原回去。
///
/// 台架侧已经量过效果本身（5406 ms → 154 ms，`range-harness/`），这里只验字节。
/// 只在临时副本上操作，绝不碰 `AURORA_MDAT_SAMPLE` 指向的原件。
///
/// 跑法：`AURORA_MDAT_SAMPLE=<mp4 路径> cargo test --test container_repair -- --ignored --nocapture`
#[test]
#[ignore = "需要本机样本；用 AURORA_MDAT_SAMPLE 指定路径手动跑"]
fn mdat_merge_on_real_sample() {
    let src = std::env::var("AURORA_MDAT_SAMPLE").expect("未设置 AURORA_MDAT_SAMPLE");
    let dir = std::env::temp_dir().join(format!("aurora-mdat-real-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("sample.mp4");
    std::fs::copy(&src, &copy).expect("复制样本到临时目录失败");
    let original = std::fs::read(&copy).unwrap();
    let size = original.len();

    let runs_before = aurora_core::mp4_mdat::runs(&copy).expect("顶层链应当可信");
    let biggest = runs_before
        .iter()
        .max_by_key(|r| r.count)
        .expect("样本应当有 mdat 段");
    println!(
        "合并前: mdat 段数={} 最大段 count={} span={:.1}MiB",
        runs_before.len(),
        biggest.count,
        (biggest.end - biggest.start) as f64 / 1048576.0,
    );
    assert!(
        biggest.count >= 64,
        "样本的碎片数应当够到阈值，实际 {}",
        biggest.count
    );

    let conn = Connection::open_in_memory().unwrap();
    create_table(&conn).unwrap();

    let plan = aurora_core::mp4_mdat::plan(&copy).expect("应当产出合并补丁");
    assert_eq!(plan.kind, "mdatSpan");
    assert_eq!(plan.offset, biggest.start, "写的就是第一个 mdat 的长度字段");
    let table_ms_before = durations_of(&copy).map(|d| d.table_ms).unwrap_or(-1);

    let r = aurora_core::container_repair::repair_file(&conn, &copy, "desktop");
    assert_eq!(r.status, "repaired", "实际 {r:?}");
    assert!(r.merged, "状态里要看得见动了 mdat");

    let after = std::fs::read(&copy).unwrap();
    assert_eq!(after.len(), size, "体积必须一字节不变");
    let diff: Vec<usize> = (0..size).filter(|i| after[*i] != original[*i]).collect();
    println!("差异字节数={} 偏移={:?}", diff.len(), diff);
    assert_eq!(diff.len(), 4, "mdat 合并只改 4 个长度字节");
    assert_eq!(diff[0], plan.offset as usize);
    let new_span = size as u64 - plan.offset;
    assert_eq!(
        u32::from_be_bytes([after[diff[0]], after[diff[0] + 1], after[diff[0] + 2], after[diff[0] + 3]]),
        new_span as u32,
        "新长度应当正好等于「从这里到文件尾」"
    );

    let runs_after = aurora_core::mp4_mdat::runs(&copy).unwrap();
    assert_eq!(runs_after.len(), 1, "顶层链应当塌成一个 mdat");
    assert_eq!(runs_after[0].count, 1);
    assert!(
        aurora_core::mp4_mdat::plan(&copy).is_none(),
        "合并后再扫不该又产出补丁（幂等）"
    );

    // 时长口径不能被这一步改变
    assert_eq!(
        durations_of(&copy).map(|d| d.table_ms),
        Some(table_ms_before),
        "采样表时长口径必须与合并前一致"
    );

    let back = aurora_core::container_repair::revert_file(&conn, &copy);
    assert_eq!(back.status, "repaired", "实际 {back:?}");
    assert_eq!(std::fs::read(&copy).unwrap(), original, "还原必须逐字节等价");
    let runs_reverted = aurora_core::mp4_mdat::runs(&copy).unwrap();
    assert_eq!(
        runs_reverted.iter().max_by_key(|r| r.count).unwrap().count,
        biggest.count,
        "还原后碎片结构应当完整复现（碎片头一直躺在 payload 里）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 钉死一个**真机刚踩到**的坑：两类补丁分属不同轮次时，台账必须累加而不是覆盖。
///
/// 现场是这样发生的：上一版程序扫过一遍、把 `elst` 遮蔽成 `free` 并记了账；这一版
/// 多了 `mdat` 合并，`planned_patches()` 只看得到「还剩 mdat 没修」，于是那一轮的
/// `record()` 用**只含 mdat 一笔**的新行 UPSERT 覆盖了旧行 —— elst 那 8 个字节改前的
/// 值就此丢失，`revert` 只能还原一半，文件永远回不到原始字节。库里那条真账现在就是
/// `offsets=''` + 只有 `mdatSpan` 的形态，所以这条测试不是假想敌。
#[test]
fn ledger_accumulates_across_runs_and_reverts_to_pristine() {
    let dir = std::env::temp_dir().join(format!("aurora-ledger-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("both.mp4");

    // 一只同时带撒谎 edit list 和碎片 mdat 链的文件
    let mut bytes = lying_bytes();
    for _ in 0..200 {
        bytes.extend_from_slice(&bx(b"mdat", &[0u8; 512]));
    }
    std::fs::write(&p, &bytes).unwrap();

    let conn = Connection::open_in_memory().unwrap();
    create_table(&conn).unwrap();

    // ── 模拟「上一版程序」：只修 elst，并按**老格式**记账（patches 列为空）──
    let elst_targets = mp4_editlist::inspect(&p).repair_targets();
    assert_eq!(elst_targets.len(), 1, "夹具应当正好有一条撒谎 elst");
    mp4_editlist::apply_mask(&p, &elst_targets).unwrap();
    container_repairs::record(
        &conn,
        &container_repairs::ContainerRepair {
            path: p.to_string_lossy().into_owned(),
            offsets: elst_targets.clone(),
            patches: Vec::new(),
            hidden_ms: 1,
            table_ms: 2,
            elst_ms: 3,
            repaired_at: 1,
            origin: "desktop".into(),
        },
    )
    .unwrap();

    // ── 这一版扫到同一个文件：只规划得出 mdat 一笔 ──
    let r = repair_file(&conn, &p, "desktop");
    assert_eq!(r.status, "repaired", "{r:?}");
    assert!(r.merged, "本轮动的确实是 mdat 链");

    let row = container_repairs::get(&conn, &p.to_string_lossy())
        .unwrap()
        .expect("台账必须有账");
    assert_eq!(row.patches.len(), 2, "两轮补丁都要在账上：{:?}", row.patches);
    assert!(row.patches.iter().any(|p| p.kind == "elstMask"), "旧的那笔不能丢");
    assert!(row.patches.iter().any(|p| p.kind == "mdatSpan"), "新的一笔要记下");
    assert_eq!(row.offsets, elst_targets, "旧列仍留 elst 偏移，老程序也还能还原这一半");
    assert_eq!(
        row.patches.iter().find(|p| p.kind == "elstMask").unwrap().expect,
        *b"elst",
        "同一偏移上以**旧账**为准（那才是文件原本的值）"
    );

    // ── 还原必须回到原始字节：两类改动都撤销 ──
    let back = revert_file(&conn, &p);
    assert_eq!(back.status, "repaired", "{back:?}");
    assert_eq!(std::fs::read(&p).unwrap(), bytes, "跨轮累加的账要能一路还原到原始字节");
    assert!(
        container_repairs::get(&conn, &p.to_string_lossy()).unwrap().is_none(),
        "还原完账要销掉"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
