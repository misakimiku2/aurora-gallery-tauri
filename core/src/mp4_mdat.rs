//! MP4 顶层 `mdat` 碎片的原位合并（2026-10-19）。
//!
//! ## 要解决的问题：秒开，不是能不能播
//!
//! 插件从 X.com 下载的这批 mp4 里，媒体数据被切成**几千个顶层 `mdat` box**实测
//! `WULT9djF0u2kAk9B.mp4` = 2783 个（每个 0.2–0.5 MiB，约 3 秒画面），一路排到文件尾。
//! Chromium 的渐进式 mp4 解析器是**沿顶层 box 链一路走**的：每走一步就要发一发
//! Range 请求去读那 8 字节的 box 头。于是打开这只片子时它把整只文件读了一遍才起播。
//!
//! 台架实测（`range-harness/`，Chromium + 支持 Range 的本地 HTTP，逐字节复刻 asset
//! 协议 1,000,000 字节静默截断）：
//!
//! | 源 | 到 `loadeddata` | 请求数 | 服务端吐出 |
//! |---|---|---|---|
//! | 原文件 | **5406 ms** | 679 | 570.94 MiB（文件才 536 MiB） |
//! | 本模块合并后（差 4 字节） | **154 ms** | 5 | 4.77 MiB |
//! | `ffmpeg -c copy` 整只重封 | 176 ms | 5 | 4.77 MiB |
//! | 正常封装的对照组（1 个 mdat） | 143 ms | 8 | 6.31 MiB |
//!
//! 也就是说**这 4 个字节做到了整只重封装才能做到的事**，而且不搬一个字节的数据。
//! 其他播放器秒开是因为它们的解封装器直接按 `stco` 跳读，根本不走顶层 box 链 ——
//! 这就是「电影和电视 / PotPlayer / MX 都正常，只有我们转好几秒」的全部原因。
//!
//! ## 为什么只改 4 个字节就够
//!
//! 这批文件的 `mdat` 碎片**首尾相接地排到 EOF**。所以把**第一个** `mdat` 的长度字段
//! 改成「整段碎片的总长」，在顶层 box 链上它们就变成了一个 `mdat`；后面 2782 个 box 头
//! 一个字节都没动，只是从「box 头」变成了大 `mdat` 的**payload**。而采样访问一律按
//! `stco` 里的**绝对文件偏移**进行，那些偏移一个都没变 —— 所以画面数据完全不受影响。
//!
//! 实测验证（同一只片子）：
//! - `ffmpeg -i ... -map 0 -c copy -f null -` 仍然解出 **125,110 帧 / 01:09:34.57 /
//!   video:481618KiB audio:65228KiB**，与合并前逐字节口径一致；
//! - `<video>` 冷跳到 2295 / 3000 / 4100 / 100 秒，四发全部出帧，延迟与合并前同级
//!   （189 / 16 / 45 / 42 ms）。
//!
//! ## 门禁：宁可漏修
//!
//! 这一步改的是「播放器怎么数 box」，不是修坏数据，所以只在**完全确定无害**时才动手：
//! 1. 顶层第一个 box 必须是 `ftyp`（不认就不是我们能处理的 MP4 族）；
//! 2. 顶层链必须**一路走到底不出可信度问题**（尺寸不可信、越界、超出遍历上限一律放弃），
//!    半途不可信就绝不写 —— 因为我们要往某个 box 头上写长度，写错一次就是破坏文件；
//! 3. 只合并**延伸到文件尾**的那一段碎片：尾巴上若还挂着别的顶层 box（`moov`/`mfra`/…），
//!    扩长前一个 `mdat` 会把它吞进 payload，那是不允许的行为改变；
//! 4. 碎片数必须 ≥ [`MIN_MDAT_RUN`]（正常封装是 1 个，见模块内 sweep 的库内分布）；
//! 5. 第一个 box 必须是 8 字节头（非 `largesize`）、且原长度字段是普通值（非 0/1）；
//! 6. 合并后的总长必须仍落在 u32 可表达范围内 —— 需要 64 位长度就放弃，因为换 16 字节头
//!    会把后面所有数据整体推移，那就不是原位修了。
//!
//! 改的 4 字节旧值记进 `db::container_repairs` 台账，还原就是把旧值写回去 —— 那些
//! 碎片 box 头一直原样躺在文件里，写回长度字段的**瞬间**原始结构就完整复现。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::mp4_editlist::{tag_at, u32_at, u64_at, BytePatch};

/// 顶层链最多走这么多步。超过就当作不可信直接放弃（正常文件个位数，实测坏样本 2783）。
const MAX_TOP_BOXES: u32 = 200_000;

/// 少于这么多条连续 `mdat` 就不动手。
///
/// **阈值是量出来的，不是拍的**。`E:\下载备份`（546 只）实测分布：
/// `count>1` 的有 376 只，p10=5 / p25=8 / p50=21 / p75=108 / p90=448 / max=5961。
/// 拿这些真实文件在 asset 协议口径（1,000,000 字节静默截断）下逐只量「点开到能播」：
///
/// | 碎片数 | 5 | 12 | 21 | 40 | 73 | 108 | 197 | 448 | 900 | 1395 | 2750 | 5961 |
/// |---|---|---|---|---|---|---|---|---|---|---|---|---|
/// | 就绪 ms | 37 | 63 | 107 | 70 | 210 | 204 | 513 | 1062 | 3336 | 3384 | 12767 | 15040 |
///
/// 拐点在 64 附近：40 条以内都还 <110 ms（跟正常封装一个量级），73 条起就进入
/// 用户看得见、且随文件变大急剧恶化的区间。**低于 64 不动手**：那些文件本来就快，
/// 为省几十毫秒去写用户的原文件不值。
pub const MIN_MDAT_RUN: u64 = 64;

/// 一段首尾相接、同类型的顶层 box。
#[derive(Debug, Clone, Copy)]
pub struct TopRun {
    pub tag: [u8; 4],
    /// 段起始 = 第一个 box 的头部起始（也就是它 4 字节长度字段的位置）
    pub start: u64,
    /// 段结束（不含）
    pub end: u64,
    pub count: u64,
    /// 第一个 box 头长度（8 = 常规，16 = largesize）
    pub first_hdr: usize,
    /// 第一个 box 的 32 位长度字段原值（`first_hdr==16` 时无意义）
    pub first_size_field: u32,
}

/// 走一遍顶层 box 链。
///
/// 返回 `None` = 「这条路我没能可信地走到底 / 不像 MP4」，调用方据此**放弃改动**；
/// 返回 `Some(runs)` 里只装 `mdat` 段（其余类型对本模块无用）。
pub fn runs(path: &Path) -> Option<Vec<TopRun>> {
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size < 16 {
        return None;
    }

    let mut pos: u64 = 0;
    let mut runs: Vec<TopRun> = Vec::new();
    let mut cur: Option<TopRun> = None;
    let mut guard = 0u32;
    let mut idx = 0u32;

    while pos + 8 <= size {
        guard += 1;
        if guard > MAX_TOP_BOXES {
            // 走到上限还没到底：这片我们看不懂，绝不据此写长度。
            return None;
        }
        let mut hdr = [0u8; 16];
        f.seek(SeekFrom::Start(pos)).ok()?;
        let n = f.read(&mut hdr).ok()?;
        if n < 8 {
            return None;
        }
        let mut bsize = u32_at(&hdr, 0)? as u64;
        let mut bhdr = 8usize;
        let size_field = u32_at(&hdr, 0)?;
        if bsize == 1 {
            if n < 16 {
                return None;
            }
            bsize = u64_at(&hdr, 8)?;
            bhdr = 16;
        } else if bsize == 0 {
            bsize = size - pos;
        }
        let tag = tag_at(&hdr, 4)?;
        if bsize < bhdr as u64 || pos + bsize > size {
            return None;
        }
        // 认 MP4 族：顶层第一个 box 必须是 ftyp。
        if idx == 0 && tag != *b"ftyp" {
            return None;
        }
        idx += 1;

        if tag == *b"mdat" {
            match &mut cur {
                // 首尾相接才并入同一段（按 size 走时正常封装本来就相接，有 padding 会断）
                Some(r) if r.end == pos => {
                    r.end = pos + bsize;
                    r.count += 1;
                }
                _ => {
                    if let Some(prev) = cur.take() {
                        runs.push(prev);
                    }
                    cur = Some(TopRun {
                        tag,
                        start: pos,
                        end: pos + bsize,
                        count: 1,
                        first_hdr: bhdr,
                        first_size_field: size_field,
                    });
                }
            }
        } else if let Some(prev) = cur.take() {
            runs.push(prev);
        }
        pos += bsize;
    }
    if let Some(prev) = cur.take() {
        runs.push(prev);
    }
    Some(runs)
}

/// 该文件要不要合并、以及合并要写的那 4 个字节。返回 `None` = 不动手。
///
/// 幂等：合并成功后顶层只剩 1 个 `mdat`，`count < MIN_MDAT_RUN` → 再扫一遍不会再产出补丁。
pub fn plan(path: &Path) -> Option<BytePatch> {
    let size = std::fs::metadata(path).ok()?.len();
    let run = runs(path)?
        .into_iter()
        .filter(|r| r.count >= MIN_MDAT_RUN)
        // 只处理排到文件尾的那一段：吞掉尾巴上别的 box 是不可接受的行为改变
        .filter(|r| r.end == size)
        // 必须是 8 字节头 + 普通长度字段（0 = 到文件尾、1 = largesize，两者都不能就地改写）
        .filter(|r| r.first_hdr == 8 && r.first_size_field >= 8 && r.first_size_field != 1)
        .max_by_key(|r| r.count)?;

    let span = run.end.checked_sub(run.start)?;
    // u32 表达不了就得换 16 字节头，那会推移全部数据 —— 不是原位修，放弃。
    if span < 8 || span > u32::MAX as u64 - 8 {
        return None;
    }
    Some(BytePatch {
        offset: run.start,
        expect: run.first_size_field.to_be_bytes(),
        write: (span as u32).to_be_bytes(),
        kind: "mdatSpan",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn bx(tag: &[u8; 4], payload_len: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((8 + payload_len) as u32).to_be_bytes());
        v.extend_from_slice(tag);
        v.resize(8 + payload_len, 0xAB);
        v
    }

    fn tmp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-mdat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// 拼一只「ftyp + 若干连续 mdat」的文件，mdat 数量可控。
    fn fragmented(n: u64, chunk: usize) -> Vec<u8> {
        let mut file = bx(b"ftyp", 24);
        for _ in 0..n {
            file.extend_from_slice(&bx(b"mdat", chunk));
        }
        file
    }

    #[test]
    fn counts_a_run_of_contiguous_mdats() {
        let p = tmp("run.bin", &fragmented(3, 64));
        let r = runs(&p).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].count, 3);
        assert_eq!(r[0].end, std::fs::metadata(&p).unwrap().len());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn single_mdat_is_not_a_repair_target() {
        // 正常封装：1 个 mdat，绝不该产出补丁
        let p = tmp("one.bin", &fragmented(1, 4096));
        assert!(plan(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn run_below_threshold_is_spared() {
        let p = tmp("below.bin", &fragmented(MIN_MDAT_RUN - 1, 32));
        assert!(plan(&p).is_none(), "碎片数没到阈值就不该动手");
        let _ = std::fs::remove_file(&p);
    }

    /// 钉死门禁 3：碎片后面还挂着别的顶层 box 时**不合并**（否则会把尾巴吞掉）。
    #[test]
    fn run_not_ending_at_eof_is_spared() {
        let mut file = bx(b"ftyp", 24);
        for _ in 0..(MIN_MDAT_RUN + 8) {
            file.extend_from_slice(&bx(b"mdat", 32));
        }
        file.extend_from_slice(&bx(b"mfra", 32)); // 尾巴上还有个顶层 box
        let p = tmp("tail.bin", &file);
        assert!(plan(&p).is_none(), "碎片段没延伸到 EOF 就不能扩长，那会吞掉尾巴上的 box");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn refuses_when_first_box_is_not_ftyp() {
        let mut file = bx(b"mdat", 32);
        for _ in 0..200 {
            file.extend_from_slice(&bx(b"mdat", 32));
        }
        let p = tmp("nofTyp.bin", &file);
        assert!(runs(&p).is_none(), "顶层第一个 box 不是 ftyp 就不该认这片");
        assert!(plan(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }

    /// 尺寸字段不可信（越界）时必须整段放弃，而不是猜一个偏移去写长度。
    #[test]
    fn distrusts_broken_box_sizes() {
        let mut file = bx(b"ftyp", 24);
        file.extend_from_slice(&bx(b"mdat", 64));
        // 伪造一个长度超过文件尾的 box
        let mut bogus = [0u8; 8];
        bogus[0..4].copy_from_slice(&(999_999_999u32).to_be_bytes());
        bogus[4..8].copy_from_slice(b"mdat");
        file.extend_from_slice(&bogus);
        let p = tmp("bogus.bin", &file);
        assert!(runs(&p).is_none());
        assert!(plan(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }

    /// 端到端：改 4 字节 → 顶层链塌成 1 个 mdat → 数据一字节没动 → 写回旧值即完全还原。
    #[test]
    fn merge_is_four_bytes_data_intact_and_reversible() {
        let original = fragmented(MIN_MDAT_RUN + 40, 4096);
        let p = tmp("e2e.bin", &original);
        let patch = plan(&p).expect("碎片段应产出合并补丁");
        assert_eq!(patch.kind, "mdatSpan");
        assert_eq!(patch.offset, 8 + 24, "写的就是第一个 mdat 的长度字段");

        crate::mp4_editlist::apply_patches(&p, &[patch.clone()]).unwrap();
        let merged = std::fs::read(&p).unwrap();
        assert_eq!(merged.len(), original.len(), "体积必须一字节不变");
        // 数据区（第一个 mdat 的 payload 起点往后）一个字节都没被改
        assert_eq!(&merged[patch.offset as usize + 8..], &original[patch.offset as usize + 8..]);
        // 顶层链现在只剩 1 个 mdat
        let r = runs(&p).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].count, 1, "碎片塌成一个 box，这才是播放器不再走链的原因");
        // 幂等：不再有补丁
        assert!(plan(&p).is_none(), "合并过一遍就不该再产出补丁");

        crate::mp4_editlist::revert_patches(&p, &[patch]).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), original, "写回旧长度字段即逐字节还原");
        let _ = std::fs::remove_file(&p);
    }

    /// 写之前必须核对当前 4 字节确实是我们当初认定的那个值。
    #[test]
    fn apply_refuses_when_current_bytes_are_not_what_we_expected() {
        let p = tmp("expect.bin", &fragmented(MIN_MDAT_RUN + 4, 64));
        let mut patch = plan(&p).unwrap();
        patch.expect = [0xDE, 0xAD, 0xBE, 0xEF];
        assert_eq!(crate::mp4_editlist::apply_patches(&p, &[patch]).unwrap(), 0, "对不上就不写");
        let _ = std::fs::remove_file(&p);
    }

    /// 真库分布统计（`#[ignore]`，开发机按环境变量手动跑）。
    ///
    /// 存在的理由：`MIN_MDAT_RUN` 不能拍脑袋。这条把库里的顶层 `mdat` 段分布打出来，
    /// 用来确认「正常文件」和「下载件」之间有没有灰区 —— 有灰区就得改判据。
    #[test]
    #[ignore = "需要本机媒体库；用 AURORA_MDAT_SWEEP 指定目录手动跑"]
    fn sweep_mdat_runs() {
        let root = match std::env::var("AURORA_MDAT_SWEEP") {
            Ok(r) => r,
            Err(_) => {
                eprintln!("AURORA_MDAT_SWEEP 未设置，跳过");
                return;
            }
        };
        let mut files = Vec::new();
        collect(&Path::new(&root), 0, &mut files);
        let mut hist: Vec<(u64, u64, String)> = Vec::new(); // count, spanMiB, name
        let mut untrusted = 0usize;
        for f in &files {
            match runs(f) {
                Some(rs) => {
                    let best = rs
                        .into_iter()
                        .filter(|r| r.end == std::fs::metadata(f).map(|m| m.len()).unwrap_or(0))
                        .max_by_key(|r| r.count);
                    if let Some(b) = best {
                        hist.push((b.count, (b.end - b.start) / 1048576, f.display().to_string()));
                    }
                }
                None => untrusted += 1,
            }
        }
        hist.sort_by_key(|h| std::cmp::Reverse(h.0));
        for (c, mib, name) in hist.iter().take(40) {
            println!("MDATRUN count={c:>6} span={mib:>5}MiB :: {name}");
        }
        let over = hist.iter().filter(|h| h.0 >= MIN_MDAT_RUN).count();
        let nonzero = hist.iter().filter(|h| h.0 > 1).count();
        println!(
            "\nSUMMARY files={} measured={} unparseable={} run>1={} run>= {MIN_MDAT_RUN}={} max={} median-ish={}",
            files.len(),
            hist.len(),
            untrusted,
            nonzero,
            over,
            hist.first().map(|h| h.0).unwrap_or(0),
            hist.get(hist.len() / 2).map(|h| h.0).unwrap_or(0),
        );
    }

    fn collect(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        if depth > 8 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with('$') || name == "node_modules" {
                continue;
            }
            if p.is_dir() {
                collect(&p, depth + 1, out);
            } else {
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
                    out.push(p);
                }
            }
        }
    }
}
