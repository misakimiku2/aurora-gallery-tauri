//! 「检测 → 原位修复 → 记台账 → 按台账还原」的编排层。
//!
//! [`crate::mp4_editlist`]（撒谎的 edit list）与 [`crate::mp4_mdat`]（碎片化的 `mdat`
//! 链）各自只做字节级解析和 4 字节改动，不碰数据库；台账在 [`crate::db::container_repairs`]。
//! 这一层把两者串起来 —— **同一个文件、同一趟扫描、同一本账里可能同时有两类补丁** ——
//! 并供桌面（`src-tauri`，自带 Tauri state 的 `AppDbPool`）和安卓（core 的 UniFFI 池）
//! 各传自己的连接复用，不允许在两端各写一套解析或各记一套账。
//!
//! 关键约定：还原**只认台账**。文件里没有 `elst` 名字可找，`mdat` 的旧长度字段更是
//! 合并后毫无痕迹，事后靠启发式猜并不安全（详见 `db::container_repairs` 模块注释）。
//!
//! 两类修复解决的问题不同，别混为一谈：
//! - edit list：管**能不能播到后半片**（播放器认到的可播区间被写小了）；
//! - `mdat` 合并：管**点开要等多久**（Chromium 沿顶层 box 链走几千个头，等于把整只
//!   文件读一遍才起播；实测 5406 ms → 154 ms）。

use std::path::Path;

use rusqlite::Connection;

use crate::db::container_repairs::{self, ContainerRepair};
use crate::mp4_editlist::{self, BytePatch, ContainerVerdict};
use crate::mp4_mdat;

/// 修复结果。`status` 用字符串而不是 Rust enum，是为了让 UniFFI 生成的 Kotlin 绑定
/// 保持简单（两端都只按这几个字面量分支）。
#[derive(Debug, Clone)]
pub struct RepairOutcome {
    pub path: String,
    /// - `repaired`：本次真的改了字节
    /// - `needsRepair`：判定为坏，但这是**预览**（`preview_file`），没动字节
    /// - `alreadyRepaired`：台账里已有记录（或形态已是修好态），没再动
    /// - `maskedNoLedger`：文件看着像被遮蔽过，但台账没有记录 → **不给还原**，只报出来
    /// - `healthy`：没有需要动的地方，不需要修
    /// - `notApplicable`：非 MP4 / 元数据读不动
    /// - `failed`：判定为坏但写盘失败（只读、被占用、没权限……见 `error`）
    pub status: String,
    /// 被藏起来的毫秒数（`healthy`/`notApplicable` 时为 0）。
    pub hidden_ms: i64,
    /// 采样表口径时长（毫秒）。
    pub table_ms: i64,
    /// `elst` 口径时长（毫秒）。
    pub elst_ms: i64,
    /// 本次（或历史上本次记账的）被改动偏移。
    pub offsets: Vec<u64>,
    /// 本次是否动了 `mdat` 链（`elst` 之外的第二种修复）。给日志/界面区分「修了什么」用。
    pub merged: bool,
    pub error: Option<String>,
}

/// 单个文件的时长摘要（供扫描器决定入库值）。
#[derive(Debug, Clone, Copy)]
pub struct ContainerDurations {
    /// 采样表口径（毫秒）——文件里真实装着多少内容。
    pub table_ms: i64,
    /// `elst` 口径（毫秒）——播放器当前认得到的时长。修好后与 `table_ms` 一致。
    pub elst_ms: i64,
}

fn secs_to_ms(s: f64) -> i64 {
    if s.is_finite() && s > 0.0 {
        (s * 1000.0).round() as i64
    } else {
        0
    }
}

/// 最短轨的采样表时长（毫秒）：能播的部分以最短的那条轨为准，
/// 免得视频轨 69:34 / 音轨 40:00 时报出一个放不满的时长。
fn min_table_ms(verdict: &ContainerVerdict) -> i64 {
    let mut acc: Option<i64> = None;
    for t in verdict_tracks(verdict) {
        let ms = secs_to_ms(t.table_secs);
        if ms > 0 {
            acc = Some(acc.map_or(ms, |m: i64| m.min(ms)));
        }
    }
    acc.unwrap_or(0)
}

/// 播放器当前认得到的时长（毫秒）= `elst` 求和后取各轨最小值；没有 edit list 的轨
/// 按采样表时长算（那种轨不被截断）。
fn min_playable_ms(verdict: &ContainerVerdict) -> i64 {
    let mut acc: Option<i64> = None;
    for t in verdict_tracks(verdict) {
        let ms = if t.entries.is_empty() {
            secs_to_ms(t.table_secs)
        } else {
            secs_to_ms(t.elst_secs)
        };
        if ms > 0 {
            acc = Some(acc.map_or(ms, |m: i64| m.min(ms)));
        }
    }
    acc.unwrap_or(0)
}

fn verdict_tracks(verdict: &ContainerVerdict) -> &[mp4_editlist::TrackDiag] {
    match verdict {
        ContainerVerdict::Lying { tracks } | ContainerVerdict::Masked { tracks } => tracks,
        _ => &[],
    }
}

/// 这个文件现在该下哪些补丁：edit list 遮蔽 + `mdat` 链合并。
///
/// 两者**互相独立**：只坏之一的文件也得修（库里两种形态都实测存在）。
/// `verdict` 为 `NotApplicable`/`MoovTooBig` 时一律返回空 —— 看不懂就不许写。
fn planned_patches(path: &Path, verdict: &ContainerVerdict) -> Vec<BytePatch> {
    if matches!(
        verdict,
        ContainerVerdict::NotApplicable | ContainerVerdict::MoovTooBig
    ) {
        return Vec::new();
    }
    let mut out = mp4_editlist::mask_patches(&verdict.repair_targets());
    if let Some(p) = mp4_mdat::plan(path) {
        out.push(p);
    }
    out
}

/// 检测并（必要时）原位修复一个文件，成功则写台账。
///
/// 幂等：已修过的文件返回 `alreadyRepaired`，不会再写一次字节。
/// 失败不 panic、不返回 Err —— 扫描器要在拿不到写权限时**继续干活**，
/// 所以错误一律收进 `status="failed"` + `error`。
pub fn repair_file(conn: &Connection, path: &Path, origin: &str) -> RepairOutcome {
    repair_impl(conn, path, origin, false)
}

/// 只检测、**绝不写盘**。给「先数出有多少要修」这类预览场景用。
///
/// 与 [`repair_file`] 共用同一套判定，因此预览看到的 `status` 和真去修的结果一致，
/// 唯一的区别是该动手的形态报 `needsRepair` 而不是真的动手。
pub fn preview_file(conn: &Connection, path: &Path) -> RepairOutcome {
    repair_impl(conn, path, "preview", true)
}

fn outcome(
    path: String,
    status: &str,
    hidden_ms: i64,
    table_ms: i64,
    elst_ms: i64,
    offsets: Vec<u64>,
    merged: bool,
    error: Option<String>,
) -> RepairOutcome {
    RepairOutcome {
        path,
        status: status.into(),
        hidden_ms,
        table_ms,
        elst_ms,
        offsets,
        merged,
        error,
    }
}

fn repair_impl(conn: &Connection, path: &Path, origin: &str, dry_run: bool) -> RepairOutcome {
    let path_str = path.to_string_lossy().into_owned();
    let verdict = mp4_editlist::inspect(path);
    let table_ms = min_table_ms(&verdict);
    let elst_ms = min_playable_ms(&verdict);
    let hidden_ms = (table_ms - elst_ms).max(0);

    if matches!(
        verdict,
        ContainerVerdict::NotApplicable | ContainerVerdict::MoovTooBig
    ) {
        return outcome(
            path_str,
            "notApplicable",
            0,
            table_ms,
            elst_ms,
            Vec::new(),
            false,
            match verdict {
                ContainerVerdict::MoovTooBig => Some("moovTooBig".into()),
                _ => None,
            },
        );
    }

    let patches = planned_patches(path, &verdict);
    let merged = patches.iter().any(|p| p.kind == "mdatSpan");
    // 旧列只存 elst 遮蔽偏移：让老版本程序也能还原这一半。
    let elst_offsets: Vec<u64> = patches
        .iter()
        .filter(|p| p.kind == "elstMask")
        .map(|p| p.offset)
        .collect();

    if patches.is_empty() {
        // 没有该动的地方。是「本来就健康」还是「早就修好了」，看台账和形态。
        let ledger = container_repairs::get(conn, &path_str).ok().flatten();
        if ledger.is_some() {
            return outcome(
                path_str,
                "alreadyRepaired",
                hidden_ms,
                table_ms,
                elst_ms,
                elst_offsets,
                merged,
                None,
            );
        }
        return match verdict {
            // 形态是遮蔽态却没有账：可能是别的程序干的，绝不能给还原入口。
            ContainerVerdict::Masked { .. } => outcome(
                path_str,
                "maskedNoLedger",
                hidden_ms,
                table_ms,
                elst_ms,
                verdict.revert_targets(),
                false,
                None,
            ),
            _ => outcome(
                path_str,
                "healthy",
                0,
                table_ms,
                elst_ms,
                Vec::new(),
                false,
                None,
            ),
        };
    }

    if dry_run {
        return outcome(
            path_str,
            "needsRepair",
            hidden_ms,
            table_ms,
            elst_ms,
            patches.iter().map(|p| p.offset).collect(),
            merged,
            None,
        );
    }

    match mp4_editlist::apply_patches(path, &patches) {
        Ok(0) => outcome(
            path_str,
            "failed",
            hidden_ms,
            table_ms,
            elst_ms,
            patches.iter().map(|p| p.offset).collect(),
            merged,
            Some("nothingWritten".into()),
        ),
        Ok(_) => {
            // ⚠️ 台账必须**累加**而不是覆盖：两类病灶是不同版本、不同轮次陆续发现的，
            // 而每轮的 `planned_patches()` 只看得到「现在还剩什么没修」。真机实测就踩到了——
            // 上一版程序修完 edit list 记了账，这一版只规划出 mdat 一笔，UPSERT 一覆盖，
            // elst 那 8 个字节改前的值就再也找不回来，`revert` 只能还原一半。
            // 同一偏移上**旧账优先**：它存的才是文件原本的值。
            let prev = container_repairs::get(conn, &path_str).ok().flatten();
            let mut ledger_patches: Vec<BytePatch> = Vec::new();
            if let Some(p) = &prev {
                if p.patches.is_empty() {
                    // 老库时代的行：只有 elst 偏移，按 elst 语义补成补丁
                    ledger_patches.extend(mp4_editlist::mask_patches(&p.offsets));
                } else {
                    ledger_patches.extend(p.patches.clone());
                }
            }
            for np in &patches {
                if !ledger_patches.iter().any(|e| e.offset == np.offset) {
                    ledger_patches.push(np.clone());
                }
            }
            let ledger_offsets: Vec<u64> = ledger_patches
                .iter()
                .filter(|p| p.kind == "elstMask")
                .map(|p| p.offset)
                .collect();
            let entry = ContainerRepair {
                path: path_str.clone(),
                offsets: ledger_offsets,
                patches: ledger_patches,
                hidden_ms,
                table_ms,
                elst_ms,
                repaired_at: chrono::Utc::now().timestamp(),
                origin: origin.into(),
            };
            // 台账写失败不能把已经改掉的字节回滚掉（文件此时已经是修好的状态），
            // 但必须报出来 —— 没账就没法还原。
            let ledger_err = container_repairs::record(conn, &entry)
                .err()
                .map(|e| format!("{e}（已改 {} 处，但台账未写入，无法还原）", patches.len()));
            outcome(
                path_str,
                if ledger_err.is_none() { "repaired" } else { "maskedNoLedger" },
                hidden_ms,
                table_ms,
                elst_ms,
                elst_offsets,
                merged,
                ledger_err,
            )
        }
        Err(e) => outcome(
            path_str,
            "failed",
            hidden_ms,
            table_ms,
            elst_ms,
            patches.iter().map(|p| p.offset).collect(),
            merged,
            Some(e.to_string()),
        ),
    }
}

/// 按台账把某文件逐字节还原。没有台账就**拒绝**还原（不猜偏移写用户文件）。
pub fn revert_file(conn: &Connection, path: &Path) -> RepairOutcome {
    let path_str = path.to_string_lossy().into_owned();
    let fail = |e: String, l: Option<&ContainerRepair>| match l {
        Some(l) => outcome(
            path_str.clone(),
            "failed",
            l.hidden_ms,
            l.table_ms,
            l.elst_ms,
            l.offsets.clone(),
            l.patches.iter().any(|p| p.kind == "mdatSpan"),
            Some(e),
        ),
        None => outcome(path_str.clone(), "failed", 0, 0, 0, Vec::new(), false, Some(e)),
    };

    let ledger = match container_repairs::get(conn, &path_str) {
        Ok(Some(l)) => l,
        Ok(None) => return fail("noLedger".into(), None),
        Err(e) => return fail(e.to_string(), None),
    };

    // 新行按完整补丁账还原；只有旧行（没 patches 列时代写的）才退回 elst 语义。
    let patches: Vec<BytePatch> = if ledger.patches.is_empty() {
        mp4_editlist::mask_patches(&ledger.offsets)
    } else {
        ledger.patches.clone()
    };

    match mp4_editlist::revert_patches(path, &patches) {
        Ok(_) => {
            // 还原成功了，账就可以销；销账失败只记日志级别的问题，不改状态。
            let _ = container_repairs::remove(conn, &path_str);
            outcome(
                path_str,
                "repaired",
                ledger.hidden_ms,
                ledger.table_ms,
                ledger.elst_ms,
                ledger.offsets,
                patches.iter().any(|p| p.kind == "mdatSpan"),
                None,
            )
        }
        Err(e) => fail(e.to_string(), Some(&ledger)),
    }
}

/// 只读地拿一份时长摘要（扫描器在不修文件时也能判断该存哪个时长）。
pub fn durations_of(path: &Path) -> Option<ContainerDurations> {
    let v = mp4_editlist::inspect(path);
    if matches!(v, ContainerVerdict::NotApplicable | ContainerVerdict::MoovTooBig) {
        return None;
    }
    Some(ContainerDurations {
        table_ms: min_table_ms(&v),
        elst_ms: min_playable_ms(&v),
    })
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;
    use rusqlite::Connection;

    fn bx(tag: &[u8; 4], payload_len: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((8 + payload_len) as u32).to_be_bytes());
        v.extend_from_slice(tag);
        v.resize(8 + payload_len, 0xAB);
        v
    }

    /// 带 mvhd、但**没有 trak** 的最小 moov：edit list 自然判成健康（没有可修的轨），
    /// 于是这一条只考察 `mdat` 那一笔。
    ///
    /// ⚠️ 没有 moov 的文件会整轮判成 `notApplicable` —— 那是**门禁**（看不懂就不许写），
    /// 不是被测行为，所以夹具必须带 moov。
    fn moov_with_mvhd() -> Vec<u8> {
        let mut p = vec![0u8; 4]; // version + flags
        p.extend_from_slice(&0u32.to_be_bytes()); // creation
        p.extend_from_slice(&0u32.to_be_bytes()); // modification
        p.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        p.extend_from_slice(&60_000u32.to_be_bytes()); // duration = 60 s
        p.extend_from_slice(&[0u8; 8]); // 补齐到 len ≥ 24
        box_of(b"moov", &box_of(b"mvhd", &p))
    }

    fn box_of(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
        v.extend_from_slice(tag);
        v.extend_from_slice(payload);
        v
    }

    /// `mdat` 碎片很多、但 edit list 完全正常的文件：必须只下 mdat 这一笔。
    #[test]
    fn repairs_mdat_only_when_edit_list_is_fine() {
        let dir = std::env::temp_dir().join(format!("aurora-orch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("mdatonly.mp4");
        let mut file = bx(b"ftyp", 24);
        file.extend_from_slice(&moov_with_mvhd());
        for _ in 0..200 {
            file.extend_from_slice(&bx(b"mdat", 512));
        }
        std::fs::write(&p, &file).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        container_repairs::create_table(&conn).unwrap();

        let pre = preview_file(&conn, &p);
        assert_eq!(pre.status, "needsRepair", "预览不该写盘但要说该修");
        assert!(pre.merged, "这一类的确是 mdat 合并");
        assert_eq!(std::fs::read(&p).unwrap(), file, "预览必须一字节都没动");

        let r = repair_file(&conn, &p, "desktop");
        assert_eq!(r.status, "repaired", "{r:?}");
        assert!(r.merged);
        let after = std::fs::read(&p).unwrap();
        assert_eq!(after.len(), file.len(), "体积不变");
        // 只改第一个 mdat 的 4 字节长度字段，它之后的每一个字节都必须原样
        let first_mdat = 8 + 24 + moov_with_mvhd().len();
        assert_ne!(&after[first_mdat..first_mdat + 4], &file[first_mdat..first_mdat + 4], "长度字段确实被改写");
        assert_eq!(&after[first_mdat + 4..], &file[first_mdat + 4..], "数据区一字节没动");

        // 再扫一遍：不该再下补丁，且状态要看得见「已经修过」
        let again = repair_file(&conn, &p, "desktop");
        assert_eq!(again.status, "alreadyRepaired", "{again:?} 幂等");
        assert!(mp4_mdat::plan(&p).is_none(), "合并后不该再产出补丁");

        // 还原：逐字节回到合并前
        let rev = revert_file(&conn, &p);
        assert_eq!(rev.status, "repaired", "{rev:?}");
        assert_eq!(std::fs::read(&p).unwrap(), file, "还原必须逐字节等价");
        let _ = std::fs::remove_file(&p);
    }

    /// 没有 ftyp 的非 MP4 族文件：一律不动，连预览都不报 needsRepair。
    #[test]
    fn never_touches_non_mp4() {
        let dir = std::env::temp_dir().join(format!("aurora-orch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("junk.bin");
        let junk = vec![0u8; 4096];
        std::fs::write(&p, &junk).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        container_repairs::create_table(&conn).unwrap();
        assert_eq!(preview_file(&conn, &p).status, "notApplicable");
        assert_eq!(repair_file(&conn, &p, "desktop").status, "notApplicable");
        assert_eq!(std::fs::read(&p).unwrap(), junk);
        let _ = std::fs::remove_file(&p);
    }

    /// 还原只认台账：没有账的文件必须拒绝，且一个字节的写操作都不发生。
    #[test]
    fn revert_refuses_without_ledger_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("aurora-orch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("noledger.mp4");
        let mut file = bx(b"ftyp", 24);
        for _ in 0..200 {
            file.extend_from_slice(&bx(b"mdat", 256));
        }
        std::fs::write(&p, &file).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        container_repairs::create_table(&conn).unwrap();
        let r = revert_file(&conn, &p);
        assert_eq!(r.status, "failed");
        assert_eq!(r.error.as_deref(), Some("noLedger"), "没账就是不许还原");
        assert_eq!(std::fs::read(&p).unwrap(), file, "拒绝还原时不能已经动了字节");
        let _ = std::fs::remove_file(&p);
    }
}
