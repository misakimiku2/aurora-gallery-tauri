//! MP4 edit list 健全性检测与原位修复（2026-10-19）。
//!
//! 插件从 X.com 下载的一批 mp4 带一条**与采样表互相矛盾的 edit list**：`elst` 只声明
//! 全片的一小段，而 `mdhd`/`stts` 描述全片。尊重 edit list 的播放引擎（Chromium
//! `<video>`、Android MediaExtractor/ExoPlayer）会把可播区间截到 `elst` 的值，后半片
//! 成为不可达的暗数据；Windows Media Foundation 压根不听 edit list —— 这就是
//! 「别的播放器都正常，只有我们不行」的全部原因。
//!
//! 同一文件的实测（562,353,184 B）：
//! - `mdhd`/`stts` 口径 4174.47 s；`elst` 口径 591.85 s；
//! - Media Foundation 报 4174.47 s；ffprobe 与 Chromium `<video>.duration` 报 591.85 s；
//! - 把 `elst` 原位遮蔽后，ffprobe 与 Chromium 双双改报 4174.57 s，原先定格的
//!   `-ss 592 / 1043 / 3548` 全部恢复出帧。
//!
//! 修法刻意选**字节级原位遮蔽**而非转封装：只把 `elst` box 的 4 字节**类型标识**改成
//! `free`，box 长度字段与 payload 一字不动。于是不改文件体积、不搬画面数据、不需要
//! ffmpeg（安卓侧没有 ffmpeg），且天然可逆 —— 把 4 字节写回 `elst` 即完全还原。
//!
//! ## 门禁
//! 本模块会写用户的原始媒体文件，所以宁可漏修也不能误伤。合法封装里 edit list 是有
//! 意义的：常见形态是 2 条（首条 `media_time=-1` 做 B 帧 CTS 对齐）或多条非零
//! `media_time`（真实时间平移）。库里实测确实存在这两种。因此只认唯一能证明
//! 「不携带任何剪辑信息、纯粹把时长写小」的形态，四个条件缺一不可：
//! 恰好 1 条 entry、`media_time == 0`、`rate == 1.0`、且声明时长显著短于采样表时长。

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// moov 体积上限：超过则放弃整体读入，防御畸形/超大元数据吃满内存。
/// 实测坏样本 moov = 2,360,755 B。
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;

/// `elst` 与采样表时长的最小差距（秒）。低于此值当作收尾/取整误差，不动手。
const MIN_HIDDEN_SECS: f64 = 5.0;
/// 覆盖率上限：`elst` 声明时长 / 采样表时长 只有**低于**此比例才认定被截断。
/// 实测坏样本比值 0.14～0.85，库里合法样本比值 ≈ 1.0，中间留有巨大安全余量。
const MAX_LYING_COVERAGE: f64 = 0.9;
/// `elst.media_time` 可容忍的绝对上限（秒）。超过即视为真实的起播点语义编辑，不动。
/// 取 1.0 s：实测坏样本的对齐平移是 0.030 s（B 帧 CTS 对齐），而语义级平移是秒/分级。
const MAX_MEDIA_OFFSET_SECS: f64 = 1.0;

/// `elst` 内单条 entry（时长已按 mvhd timescale 归一为秒）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ElstEntry {
    pub segment_secs: f64,
    /// 原始有符号值：`-1` / `0` / 正数各自都有合法含义。
    pub media_time: i64,
    /// `media_time` 按**本轨 mdhd timescale** 折算的秒数（elst 的 media_time 用媒体时基，
    /// 不是 mvhd 时基）。实测坏样本视频轨 `media_time=46100 / ts=1536000 = 0.030 s`，
    /// 属亚秒级对齐；而真「从片中间起播」的语义编辑会是大值。
    pub media_offset_secs: f64,
    pub rate: f64,
}

/// 单条 trak 的诊断结果。
#[derive(Debug, Clone)]
pub struct TrackDiag {
    /// handler type：`vide` / `soun` / …
    pub handler: String,
    /// `mdhd` 口径的轨时长（秒）——视为「文件里真实装着多少内容」。
    pub table_secs: f64,
    /// `elst` 各条 `segment_duration` 之和（秒）——播放器认的呈现时长。
    pub elst_secs: f64,
    pub entries: Vec<ElstEntry>,
    /// `elst` 类型字段（4 字节）在文件中的绝对偏移；该轨无 edit list 时为 `None`。
    pub elst_type_abs: Option<u64>,
    /// 已被本模块遮蔽过的偏移：`edts` 里类型为 `free`、但 payload 仍能按 `elst` 解析出来。
    ///
    /// 有这个字段才能**无状态还原** —— 遮蔽后 `elst` 的名字已经没了，若不识别残留的
    /// `free`，就必须把偏移额外存进数据库；而本模块的 payload 一字未动，
    /// 直接把它读回来即可还原，两端都不必依赖库表。
    pub masked_type_abs: Option<u64>,
}

impl TrackDiag {
    /// 是否属于「只是时长写错、不含真实剪辑」的 edit list。
    ///
    /// 判据是**覆盖率** = `elst` 各条 `segment_duration` 之和 / 采样表时长。
    /// 用「求和」而不是「取第一条」是吃过亏的：库里合法的 B 帧对齐形态是 **2 条**、
    /// 首条是时长近乎 0 的空编辑（`media_time=-1`），只读第一条会把覆盖率算成 0，
    /// 从而把 8 个好文件误判成坏（实测 `BT-159.mp4` 等，ffprobe 反证其时长完整）。
    ///
    /// 三条附加约束缺一不可（宁可漏修，不可误伤）：
    /// 1. 每条 `rate == 1.0` —— 变速呈现是真语义，不能丢；
    /// 2. 每条 `|media_offset_secs| <= MAX_MEDIA_OFFSET_SECS` —— 只容忍亚秒级对齐平移；
    ///    指向片中间的大偏移是真「起播点」编辑，绝不动手；
    /// 3. 截断量 ≥ `MIN_HIDDEN_SECS` 且覆盖率 < `MAX_LYING_COVERAGE` —— 避开收尾取整误差。
    ///
    /// 为什么不能「保留 media_time、只把 segment_duration 改对」：`elst` v0 的
    /// `segment_duration` 是 **u32**，长片全片时长折算后必然溢出 —— 实测坏值
    /// 4,256,094,207 紧贴 u32 上限 4,294,967,295，而真值需要 12.8e9。**这个溢出就是
    /// 本批文件坏掉的成因**，也因此遮蔽（而不是改数值）是唯一可行的原位修法。
    pub fn is_lying(&self) -> bool {
        if self.entries.is_empty() || self.table_secs <= 0.0 || self.elst_secs <= 0.0 {
            return false;
        }
        if self
            .entries
            .iter()
            .any(|e| (e.rate - 1.0).abs() > 1e-6 || e.media_offset_secs.abs() > MAX_MEDIA_OFFSET_SECS)
        {
            return false;
        }
        let hidden = self.table_secs - self.elst_secs;
        let coverage = self.elst_secs / self.table_secs;
        hidden >= MIN_HIDDEN_SECS && coverage < MAX_LYING_COVERAGE
    }
}

/// 文件级容器诊断结论。
#[derive(Debug, Clone)]
pub enum ContainerVerdict {
    /// 不是能安全处理的 MP4 族容器 / 元数据读不出来 —— 不猜测、不动手。
    NotApplicable,
    /// 有 moov 但过大，放弃。
    MoovTooBig,
    /// edit list 都在合法形态范围内（或根本没有 edit list）。
    Healthy,
    /// 至少一条轨带着**仍然存活**的撒谎 `elst` → 可修。
    Lying { tracks: Vec<TrackDiag> },
    /// 撒谎的 edit list 已被遮蔽过（`edts` 里是 `free`，payload 原样留着）
    /// → 文件已处于修好的状态。
    ///
    /// 单独成态而不是并入 `Healthy`：让「已修过」在日志/界面里看得见。
    /// ⚠️ 但**还原不能靠这个状态的偏移**：`free` 是我们写的还是别人家 padding，
    /// 只能靠长度启发式去猜。还原一律走 `db::container_repairs` 台账里记下的偏移。
    Masked { tracks: Vec<TrackDiag> },
}

impl ContainerVerdict {
    fn tracks(&self) -> &[TrackDiag] {
        match self {
            ContainerVerdict::Lying { tracks } | ContainerVerdict::Masked { tracks } => tracks,
            _ => &[],
        }
    }

    /// 需要遮蔽的 `elst` 类型字段绝对偏移。
    pub fn repair_targets(&self) -> Vec<u64> {
        self.tracks()
            .iter()
            .filter(|t| t.is_lying())
            .filter_map(|t| t.elst_type_abs)
            .collect()
    }

    /// 需要还原的偏移（当前类型字段是 `free`、payload 仍按 `elst` 解得开）。
    pub fn revert_targets(&self) -> Vec<u64> {
        self.tracks()
            .iter()
            .filter(|t| t.is_lying())
            .filter_map(|t| t.masked_type_abs)
            .collect()
    }

    /// 被藏（或曾被藏）的秒数，取所有撒谎轨里的最大值。
    pub fn hidden_secs(&self) -> f64 {
        self.tracks()
            .iter()
            .filter(|t| t.is_lying())
            .map(|t| (t.table_secs - t.elst_secs).max(0.0))
            .fold(0.0f64, f64::max)
    }
}

// ---------------------------------------------------------------- box 读取原语

pub(crate) fn i16_at(b: &[u8], o: usize) -> Option<i16> {
    b.get(o..o + 2).map(|s| i16::from_be_bytes([s[0], s[1]]))
}
pub(crate) fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn i32_at(b: &[u8], o: usize) -> Option<i32> {
    b.get(o..o + 4).map(|s| i32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
pub(crate) fn u64_at(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 8)
        .map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}
fn i64_at(b: &[u8], o: usize) -> Option<i64> {
    b.get(o..o + 8)
        .map(|s| i64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}
pub(crate) fn tag_at(b: &[u8], o: usize) -> Option<[u8; 4]> {
    b.get(o..o + 4).map(|s| [s[0], s[1], s[2], s[3]])
}
const fn t(name: &[u8; 4]) -> [u8; 4] {
    *name
}

/// moov 内部已定位的一个 box（偏移都相对 moov 内容缓冲）。
#[derive(Debug, Clone, Copy)]
struct BoxRef {
    tag: [u8; 4],
    /// box 头起始
    start: usize,
    /// 内容起始
    content: usize,
    /// 内容长度
    len: usize,
}

/// 在 `buf[from..to]` 内按 ISO-BMFF box 树逐层遍历。
///
/// 容错口径：任何一处尺寸不可信（`size < header`、越界、`size==0/1` 解析失败）就
/// **停止**而不是继续猜——宁可少诊断，不可把某个随机位置当成 `elst` 去写。
fn children(buf: &[u8], from: usize, to: usize) -> Vec<BoxRef> {
    let mut out = Vec::new();
    let mut q = from;
    while q + 8 <= to {
        let Some(size32) = u32_at(buf, q) else { break };
        let Some(tag) = tag_at(buf, q + 4) else { break };
        let mut size = size32 as u64;
        let mut hdr = 8usize;
        if size32 == 1 {
            let Some(big) = u64_at(buf, q + 8) else { break };
            size = big;
            hdr = 16;
        } else if size32 == 0 {
            size = (to - q) as u64;
        }
        if size < hdr as u64 || q + size as usize > to {
            break;
        }
        let content = q + hdr;
        out.push(BoxRef {
            tag,
            start: q,
            content,
            len: q + size as usize - content,
        });
        q += size as usize;
    }
    out
}

fn find<'a>(bs: &'a [BoxRef], name: &[u8; 4]) -> Option<&'a BoxRef> {
    bs.iter().find(|b| b.tag == t(name))
}

/// 解析 `elst` 内容。`segment_duration` 按 mvhd 时基归一，`media_time` 按本轨 mdhd 时基归一。
fn parse_elst(
    c: &[u8],
    movie_timescale: f64,
    media_timescale: f64,
) -> Option<Vec<ElstEntry>> {
    if c.len() < 8 || movie_timescale <= 0.0 || media_timescale <= 0.0 {
        return None;
    }
    let version = c[0];
    let n = u32_at(c, 4)? as usize;
    // 正常轨道只有 1–2 条；超过这个量级说明我们其实落在了一段随机字节上，放弃。
    if n == 0 || n > 16 {
        return None;
    }
    // 严格校验长度：内容必须正好是 8 + n × entry 大小。
    // 这一条是为「把 free 认回 elst」服务的 —— 只有长度严丝合缝才敢据此决定写哪 4 个字节。
    let per = if version == 0 { 12 } else { 24 };
    if version > 1 || c.len() != 8 + n * per {
        return None;
    }
    let mut entries = Vec::with_capacity(n);
    let mut q = 8usize;
    for _ in 0..n {
        if version == 0 {
            if q + 12 > c.len() {
                return None;
            }
            let seg = u32_at(c, q)?;
            let media = i32_at(c, q + 4)?;
            let rate_int = i16_at(c, q + 8)?;
            let rate_frac = i16_at(c, q + 10)?;
            entries.push(ElstEntry {
                segment_secs: seg as f64 / movie_timescale,
                media_time: media as i64,
                media_offset_secs: media as f64 / media_timescale,
                rate: rate_int as f64 + rate_frac as f64 / 65536.0,
            });
            q += 12;
        } else {
            // v1: segment_duration(8) media_time(8) reserved(4) rate_int(2) rate_frac(2)
            if q + 24 > c.len() {
                return None;
            }
            let seg = u64_at(c, q)?;
            let media = i64_at(c, q + 8)?;
            let rate_int = i16_at(c, q + 20)?;
            let rate_frac = i16_at(c, q + 22)?;
            entries.push(ElstEntry {
                segment_secs: seg as f64 / movie_timescale,
                media_time: media,
                media_offset_secs: media as f64 / media_timescale,
                rate: rate_int as f64 + rate_frac as f64 / 65536.0,
            });
            q += 24;
        }
    }
    Some(entries)
}

/// 只读容器元数据来诊断 edit list；**不写任何字节**。
pub fn inspect(path: &Path) -> ContainerVerdict {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return ContainerVerdict::NotApplicable,
    };
    let size = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return ContainerVerdict::NotApplicable,
    };
    if size < 16 {
        return ContainerVerdict::NotApplicable;
    }

    // 1) 扫顶层 box 找 moov。moov 可能在文件尾部（非 faststart），而 `mdat` 自带合法
    //    size 字段、按尺寸跳过即可，所以这里**不能**一见 mdat 就停 —— 停了就永远找不到
    //    尾部 moov。真正该停的是尺寸不可信（见下面的 break 条件）。
    let mut pos: u64 = 0;
    let mut moov: Option<(u64, u64, usize)> = None;
    let mut saw_ftyp = false;
    let mut guard = 0u32;
    while pos + 8 <= size && guard < 100_000 {
        guard += 1;
        let mut hdr = [0u8; 16];
        if f.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let n = match f.read(&mut hdr) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n < 8 {
            break;
        }
        let mut bsize = u32_at(&hdr, 0).unwrap_or(0) as u64;
        let mut bhdr = 8usize;
        if bsize == 1 {
            if n < 16 {
                break;
            }
            bsize = u64_at(&hdr, 8).unwrap_or(0);
            bhdr = 16;
        } else if bsize == 0 {
            bsize = size - pos;
        }
        let tag = tag_at(&hdr, 4).unwrap_or(*b"????");
        if bsize < bhdr as u64 {
            break;
        }
        if tag == t(b"ftyp") {
            saw_ftyp = true;
        } else if tag == t(b"moov") {
            moov = Some((pos, bsize, bhdr));
            break;
        }
        pos += bsize;
    }
    if !saw_ftyp {
        return ContainerVerdict::NotApplicable;
    }
    let Some((moov_pos, moov_size, moov_hdr)) = moov else {
        return ContainerVerdict::NotApplicable;
    };
    if moov_size > MAX_MOOV_BYTES {
        return ContainerVerdict::MoovTooBig;
    }

    // 2) 读入整块 moov 内容。
    let content_len = moov_size as usize - moov_hdr;
    let mut buf = vec![0u8; content_len];
    let moov_abs = moov_pos + moov_hdr as u64;
    if f.seek(SeekFrom::Start(moov_abs)).is_err() || f.read_exact(&mut buf).is_err() {
        return ContainerVerdict::NotApplicable;
    }

    let l1 = children(&buf, 0, buf.len());
    let Some(mvhd) = find(&l1, b"mvhd") else {
        return ContainerVerdict::NotApplicable;
    };
    let Some(mv) = buf.get(mvhd.content..mvhd.content + mvhd.len) else {
        return ContainerVerdict::NotApplicable;
    };
    if mv.len() < 24 {
        return ContainerVerdict::NotApplicable;
    }
    let movie_timescale = if mv[0] == 0 {
        u32_at(mv, 12).unwrap_or(0) as f64
    } else {
        u32_at(mv, 20).unwrap_or(0) as f64
    };
    if movie_timescale <= 0.0 {
        return ContainerVerdict::NotApplicable;
    }

    let mut diags = Vec::new();
    for trak in l1.iter().filter(|b| b.tag == t(b"trak")) {
        let Some(tbuf) = buf.get(trak.content..trak.content + trak.len) else {
            continue;
        };
        let _ = tbuf;
        let l2 = children(&buf, trak.content, trak.content + trak.len);
        let Some(mdia) = find(&l2, b"mdia") else { continue };
        let l3 = children(&buf, mdia.content, mdia.content + mdia.len);
        let handler = find(&l3, b"hdlr")
            .and_then(|b| buf.get(b.content + 8..b.content + 12))
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        let Some(mdhd) = find(&l3, b"mdhd") else { continue };
        let Some(md) = buf.get(mdhd.content..mdhd.content + mdhd.len) else {
            continue;
        };
        if md.len() < 24 {
            continue;
        }
        let (ts, du) = if md[0] == 0 {
            (
                u32_at(md, 12).unwrap_or(0) as f64,
                u32_at(md, 16).unwrap_or(0) as f64,
            )
        } else {
            (
                u32_at(md, 20).unwrap_or(0) as f64,
                u64_at(md, 24).unwrap_or(0) as f64,
            )
        };
        if ts <= 0.0 {
            continue;
        }
        let table_secs = du / ts;

        let mut entries = Vec::new();
        let mut elst_type_abs = None;
        let mut masked_type_abs = None;
        if let Some(edts) = find(&l2, b"edts") {
            let l4 = children(&buf, edts.content, edts.content + edts.len);
            for b in &l4 {
                let Some(c) = buf.get(b.content..b.content + b.len) else { continue };
                let Some(parsed) = parse_elst(c, movie_timescale, ts) else { continue };
                if b.tag == t(b"elst") {
                    entries = parsed;
                    elst_type_abs = Some(moov_abs + b.start as u64 + 4);
                    break;
                }
                // `edts` 里出现「能按 elst 严丝合缝解开」的 `free` —— 只可能是本模块
                // 遮蔽过的痕迹（长度校验见 `parse_elst`，随机填充撞上的概率极低）。
                // ⚠️ 这个推断只用于**只读分类**（让「已修过」可见、避免重复修）；
                //    真正的还原一律走修复台账里记下的偏移，不靠这里猜——
                //    万一把别人家的 padding `free` 判成残留并写回 `elst`，就是凭空造出
                //    一个非法 box，把好文件弄坏。
                if b.tag == t(b"free") {
                    entries = parsed;
                    masked_type_abs = Some(moov_abs + b.start as u64 + 4);
                    break;
                }
            }
        }
        let elst_secs = entries.iter().map(|e| e.segment_secs).sum();
        diags.push(TrackDiag {
            handler,
            table_secs,
            elst_secs,
            entries,
            elst_type_abs,
            masked_type_abs,
        });
    }

    let any_lying = diags.iter().any(TrackDiag::is_lying);
    if any_lying && diags.iter().any(|d| d.is_lying() && d.elst_type_abs.is_some()) {
        ContainerVerdict::Lying { tracks: diags }
    } else if any_lying {
        ContainerVerdict::Masked { tracks: diags }
    } else {
        ContainerVerdict::Healthy
    }
}

/// 一处**原位 4 字节**改动：只有当前值等于 `expect` 时才写 `write`。
///
/// 容器修复的全部写动作都收敛成这一个类型 —— 台账存它、还原用它、
/// 两端（桌面 `src-tauri` 与安卓 FFI）看到的都是同一份语义。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytePatch {
    pub offset: u64,
    /// 写之前必须核对的当前值。对不上就跳过，这是「绝不误伤」的最后一道闸。
    pub expect: [u8; 4],
    pub write: [u8; 4],
    /// 形态名，进台账/日志用：`elstMask` / `mdatSpan`。
    pub kind: &'static str,
}

/// 把「需要遮蔽的 `elst` 偏移」翻译成补丁。
pub fn mask_patches(offsets: &[u64]) -> Vec<BytePatch> {
    offsets
        .iter()
        .map(|&offset| BytePatch {
            offset,
            expect: *b"elst",
            write: *b"free",
            kind: "elstMask",
        })
        .collect()
}

/// 把指定偏移处**当前确实是 `elst`** 的 4 字节改成 `free`（体积不变、payload 不动）。
///
/// 幂等：已修过的文件再跑一遍返回 0，不做任何写。
pub fn apply_mask(path: &Path, offsets: &[u64]) -> std::io::Result<usize> {
    apply_patches(path, &mask_patches(offsets))
}

/// 还原：把之前遮蔽成 `free` 的 4 字节写回 `elst`。
///
/// 不需要备份原值 —— 我们只动过类型标识，`elst` 的 payload 一直原样躺在文件里。
pub fn revert_mask(path: &Path, offsets: &[u64]) -> std::io::Result<usize> {
    revert_patches(path, &mask_patches(offsets))
}

/// 按补丁写盘，返回**真正改动**的处数（对不上 `expect` 的一律跳过，不报错）。
///
/// 句柄必须**同时**开读写：先 `read_exact` 核对当前 4 字节，再写。只开 `write(true)`
/// 会得到只写句柄，读操作在 Windows 上直接返回 ERROR_ACCESS_DENIED（实测 os error 5），
/// 表现是「判定为坏、写了 0 处、文件没动」。
pub fn apply_patches(path: &Path, patches: &[BytePatch]) -> std::io::Result<usize> {
    if patches.is_empty() {
        return Ok(0);
    }
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    let mut done = 0usize;
    for p in patches {
        let mut cur = [0u8; 4];
        f.seek(SeekFrom::Start(p.offset))?;
        f.read_exact(&mut cur)?;
        if cur != p.expect {
            continue;
        }
        f.seek(SeekFrom::Start(p.offset))?;
        f.write_all(&p.write)?;
        done += 1;
    }
    f.flush()?;
    f.sync_all()?;
    Ok(done)
}

/// 还原一批补丁：把 `expect`/`write` 对调再写回去。
///
/// 与 [`apply_patches`] 一样带核对 —— 只有当前值确实是当年写进去的那个值才回滚，
/// 文件被别人改过（或压根没被我们改过）时不动手。
pub fn revert_patches(path: &Path, patches: &[BytePatch]) -> std::io::Result<usize> {
    let inv: Vec<BytePatch> = patches
        .iter()
        .map(|p| BytePatch {
            offset: p.offset,
            expect: p.write,
            write: p.expect,
            kind: p.kind,
        })
        .collect();
    apply_patches(path, &inv)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 box 构造器：32 位尺寸，够用。
    fn bx(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(8 + payload.len());
        v.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
        v.extend_from_slice(tag);
        v.extend_from_slice(payload);
        v
    }
    fn be32(x: u32) -> Vec<u8> {
        x.to_be_bytes().to_vec()
    }
    fn be16(x: u16) -> Vec<u8> {
        x.to_be_bytes().to_vec()
    }

    /// mvhd v0：ver/flags(4) creation(4) modification(4) timescale(4) duration(4) + 尾巴
    fn mvhd(timescale: u32, duration: u32) -> Vec<u8> {
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&be32(0));
        p.extend_from_slice(&be32(0));
        p.extend_from_slice(&be32(timescale));
        p.extend_from_slice(&be32(duration));
        p.extend_from_slice(&vec![0u8; 4 + 2 + 2 + 8 + 36 + 24 + 4]);
        bx(b"mvhd", &p)
    }

    /// mdhd v0：ver/flags(4) creation(4) modification(4) timescale(4) duration(4) lang(2) pre(2)
    fn mdhd(timescale: u32, duration: u32) -> Vec<u8> {
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&be32(0));
        p.extend_from_slice(&be32(0));
        p.extend_from_slice(&be32(timescale));
        p.extend_from_slice(&be32(duration));
        p.extend_from_slice(&[0u8; 4]);
        bx(b"mdhd", &p)
    }

    fn hdlr(handler: &[u8; 4]) -> Vec<u8> {
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&be32(0));
        p.extend_from_slice(handler);
        p.extend_from_slice(&[0u8; 12 + 1]);
        bx(b"hdlr", &p)
    }

    /// elst v0，显式给 (segment, media_time) 列表
    fn elst(entries: &[(u32, i32)]) -> Vec<u8> {
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&be32(entries.len() as u32));
        for (seg, mt) in entries {
            p.extend_from_slice(&be32(*seg));
            p.extend_from_slice(&(*mt as i32).to_be_bytes());
            p.extend_from_slice(&be16(1)); // rate integer
            p.extend_from_slice(&be16(0)); // rate fraction
        }
        bx(b"elst", &p)
    }

    /// 组装 ftyp + moov{mvhd, trak{tkhd, mdia{mdhd,hdlr,minf}, edts{elst}}}
    fn container(movie_ts: u32, movie_dur: u32, track_ts: u32, track_dur: u32, edits: &[(u32, i32)]) -> Vec<u8> {
        let minf = bx(b"minf", &[]);
        let mut mdia_inner = Vec::new();
        mdia_inner.extend_from_slice(&mdhd(track_ts, track_dur));
        mdia_inner.extend_from_slice(&hdlr(b"vide"));
        mdia_inner.extend_from_slice(&minf);
        let mut edts_inner = Vec::new();
        edts_inner.extend_from_slice(&elst(edits));
        let mut trak_inner = Vec::new();
        trak_inner.extend_from_slice(&bx(b"tkhd", &vec![0u8; 84]));
        trak_inner.extend_from_slice(&bx(b"mdia", &mdia_inner));
        trak_inner.extend_from_slice(&bx(b"edts", &edts_inner));
        let mut moov_inner = Vec::new();
        moov_inner.extend_from_slice(&mvhd(movie_ts, movie_dur));
        moov_inner.extend_from_slice(&bx(b"trak", &trak_inner));

        let mut file = Vec::new();
        file.extend_from_slice(&bx(b"ftyp", b"isom"));
        file.extend_from_slice(&bx(b"moov", &moov_inner));
        file
    }

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aurora-elst-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    // ---- 门禁判定：绝不能误伤合法 edit list ----

    #[test]
    fn two_entry_bframe_alignment_is_not_lying() {
        let d = TrackDiag {
            handler: "vide".into(),
            table_secs: 60.0,
            elst_secs: 60.0,
            entries: vec![
                ElstEntry { segment_secs: 0.033, media_time: -1, media_offset_secs: -0.001, rate: 1.0 },
                ElstEntry { segment_secs: 59.967, media_time: 0, media_offset_secs: 0.0, rate: 1.0 },
            ],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!d.is_lying(), "2 条 edit list（B 帧 CTS 对齐）绝不能被判定为坏");
    }

    #[test]
    fn single_entry_nonzero_media_time_is_not_lying() {
        let d = TrackDiag {
            handler: "vide".into(),
            table_secs: 8363.0,
            elst_secs: 2770.9,
            entries: vec![ElstEntry { segment_secs: 2770.9, media_time: 46100, media_offset_secs: 46.1, rate: 1.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!d.is_lying(), "非零 media_time 是真时间平移，必须放过");
    }

    #[test]
    fn non_unity_rate_is_not_lying() {
        let d = TrackDiag {
            handler: "vide".into(),
            table_secs: 100.0,
            elst_secs: 50.0,
            entries: vec![ElstEntry { segment_secs: 50.0, media_time: 0, media_offset_secs: 0.0, rate: 2.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!d.is_lying());
    }

    #[test]
    fn rounding_level_gap_is_not_lying() {
        let d = TrackDiag {
            handler: "vide".into(),
            table_secs: 60.0,
            elst_secs: 59.9,
            entries: vec![ElstEntry { segment_secs: 59.9, media_time: 0, media_offset_secs: 0.0, rate: 1.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!d.is_lying());
    }

    /// 真实坏样本的数值形状
    #[test]
    fn wult_shape_is_lying() {
        let d = TrackDiag {
            handler: "vide".into(),
            table_secs: 4174.470999,
            elst_secs: 591.7857,
            entries: vec![ElstEntry { segment_secs: 591.7857, media_time: 0, media_offset_secs: 0.0, rate: 1.0 }],
            elst_type_abs: Some(1_559_435), masked_type_abs: None,
        };
        assert!(d.is_lying());
    }

    /// 边界语义钉死，防止将来调阈值时静默放宽
    #[test]
    fn thresholds_are_pinned() {
        let caught = TrackDiag {
            handler: "vide".into(),
            table_secs: 60.0,
            elst_secs: 53.9,
            entries: vec![ElstEntry { segment_secs: 53.9, media_time: 0, media_offset_secs: 0.0, rate: 1.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(caught.is_lying(), "coverage 0.898 / hidden 6.1s 应判坏");
        let spared = TrackDiag {
            handler: "vide".into(),
            table_secs: 60.0,
            elst_secs: 56.0,
            entries: vec![ElstEntry { segment_secs: 56.0, media_time: 0, media_offset_secs: 0.0, rate: 1.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!spared.is_lying(), "coverage 0.933 应放过");
        let too_small = TrackDiag {
            handler: "vide".into(),
            table_secs: 100.0,
            elst_secs: 96.0,
            entries: vec![ElstEntry { segment_secs: 96.0, media_time: 0, media_offset_secs: 0.0, rate: 1.0 }],
            elst_type_abs: Some(0), masked_type_abs: None,
        };
        assert!(!too_small.is_lying(), "hidden 4s < 5s 应放过");
    }

    // ---- 端到端：检测、定位、遮蔽、幂等、还原 ----

    #[test]
    fn detects_lying_edit_list_and_reports_hidden_seconds() {
        // movie ts=1_000_000；轨 ts=1000, dur=4_174_471 → table=4174.471s
        // elst 单条 media_time=0, seg=591_785_700 → 591.7857s
        let bytes = container(1_000_000, 4_174_471_000, 1000, 4_174_471, &[(591_785_700, 0)]);
        let p = write_tmp("lying.bin", &bytes);
        let v = inspect(&p);
        let targets = v.repair_targets();
        assert!(matches!(v, ContainerVerdict::Lying { .. }), "应判 Lying，实际 {v:?}");
        assert_eq!(targets.len(), 1);
        assert!(v.hidden_secs() > 3500.0 && v.hidden_secs() < 3600.0, "藏了约 59.7 分钟，实际 {}", v.hidden_secs());

        let raw = std::fs::read(&p).unwrap();
        assert_eq!(&raw[targets[0] as usize..targets[0] as usize + 4], b"elst");

        assert_eq!(apply_mask(&p, &targets).unwrap(), 1);
        let masked = std::fs::read(&p).unwrap();
        assert_eq!(masked.len(), raw.len(), "体积必须一字节不变");
        assert_eq!(&masked[targets[0] as usize..targets[0] as usize + 4], b"free");
        assert_eq!(&masked[targets[0] as usize + 4..], &raw[targets[0] as usize + 4..], "payload 必须原样保留");

        // 修完之后不该再可修；状态应报成 Masked（而不是谎称 Healthy）
        let after = inspect(&p);
        assert!(
            matches!(after, ContainerVerdict::Masked { .. }),
            "已修过的文件应判 Masked，实际 {after:?}"
        );
        assert!(after.repair_targets().is_empty(), "已修过的文件不该再有修复目标");
        assert_eq!(apply_mask(&p, &targets).unwrap(), 0, "幂等：不该重复写");

        // 还原后逐字节等价
        assert_eq!(revert_mask(&p, &targets).unwrap(), 1);
        assert_eq!(std::fs::read(&p).unwrap(), raw, "还原必须逐字节等价");
        assert!(matches!(inspect(&p), ContainerVerdict::Lying { .. }), "还原后应重新判为可修");
        let _ = std::fs::remove_file(&p);
    }

    /// 一条可指定 handler / 自己 timescale / 自己 edit list 的 trak。
    fn trak_of(handler: &[u8; 4], track_ts: u32, track_dur: u32, edits: &[(u32, i32)]) -> Vec<u8> {
        let mut mdia_inner = Vec::new();
        mdia_inner.extend_from_slice(&mdhd(track_ts, track_dur));
        mdia_inner.extend_from_slice(&hdlr(handler));
        mdia_inner.extend_from_slice(&bx(b"minf", &[]));
        let mut trak_inner = Vec::new();
        trak_inner.extend_from_slice(&bx(b"tkhd", &vec![0u8; 84]));
        trak_inner.extend_from_slice(&bx(b"mdia", &mdia_inner));
        trak_inner.extend_from_slice(&bx(b"edts", &elst(edits)));
        bx(b"trak", &trak_inner)
    }

    fn container_of(movie_ts: u32, movie_dur: u32, traks: &[Vec<u8>]) -> Vec<u8> {
        let mut moov_inner = Vec::new();
        moov_inner.extend_from_slice(&mvhd(movie_ts, movie_dur));
        for t in traks {
            moov_inner.extend_from_slice(t);
        }
        let mut file = Vec::new();
        file.extend_from_slice(&bx(b"ftyp", b"isom"));
        file.extend_from_slice(&bx(b"moov", &moov_inner));
        file
    }

    /// 钉死一个真实踩过的坑：双轨都坏时必须**两条都修**。
    ///
    /// 真库里有一个文件（Python 第三方裁定 dump 出来的原始字节）长这样：
    /// - `vide`：`media_time=46100 / ts=1536000 = 0.030 s`（亚秒级对齐），seg 只覆盖 1/3；
    /// - `soun`：`media_time=0`，seg 同样只覆盖 1/3。
    ///
    /// 早期门禁要求 `media_time == 0`，于是只抓到音轨 —— **只把音轨时间轴放开、视频轨仍
    /// 截断**，会把文件修成两条轨时长不一致的半成品，比原来更糟。这里按比例缩到 u32
    /// 可容纳的数值，复现同一形态（视频轨带 0.030 s 平移、音轨为 0）。
    #[test]
    fn both_tracks_are_repaired_when_both_are_truncated() {
        // movie ts=1_000_000 → seg 2_770_890_000 = 2770.89 s；轨 ts=1000 → 8363.30 s
        // 覆盖率 0.331（< 0.9），hidden 5592 s（> 5 s），media_time 30/1000 = 0.030 s
        let bytes = container_of(
            1_000_000,
            9_999_999,
            &[
                trak_of(b"vide", 1000, 8_363_300, &[(2_770_890_000, 30)]),
                trak_of(b"soun", 1000, 8_363_460, &[(2_771_050_000, 0)]),
            ],
        );
        let p = write_tmp("twotrack.bin", &bytes);
        let v = inspect(&p);
        let targets = v.repair_targets();
        assert_eq!(
            targets.len(),
            2,
            "视频轨与音轨都要修，只修一条会留下时间轴不一致的半成品；实际 {v:?}"
        );
        let raw = std::fs::read(&p).unwrap();
        for off in &targets {
            assert_eq!(&raw[*off as usize..*off as usize + 4], b"elst");
        }
        assert_eq!(apply_mask(&p, &targets).unwrap(), 2);
        assert!(inspect(&p).repair_targets().is_empty());
        assert_eq!(revert_mask(&p, &targets).unwrap(), 2);
        assert_eq!(std::fs::read(&p).unwrap(), raw);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn legit_two_entry_container_has_no_repair_target() {
        // movie ts=1000：轨 60s；elst 两条 (0.033s,-1) + (59.967s,0) → 合计 60s
        let bytes = container(1000, 60_000, 1000, 60_000, &[(33, -1), (59_967, 0)]);
        let p = write_tmp("ok2.bin", &bytes);
        let v = inspect(&p);
        assert!(v.repair_targets().is_empty(), "合法 2 条不该有修复目标：{:?} ({v:?})", v.repair_targets());
        assert!(matches!(v, ContainerVerdict::Healthy));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn legit_single_full_length_container_has_no_repair_target() {
        let bytes = container(1000, 60_000, 1000, 60_000, &[(60_000, 0)]);
        let p = write_tmp("ok1.bin", &bytes);
        assert!(inspect(&p).repair_targets().is_empty());
        let _ = std::fs::remove_file(&p);
    }

    /// 没有 ftyp（如裸 m4v 片段 / 非 MP4）时必须拒绝动手，而不是乱猜偏移。
    #[test]
    fn refuses_when_no_ftyp() {
        let mut junk = vec![0u8; 4096];
        for i in 0..junk.len() {
            junk[i] = (i % 251) as u8;
        }
        let p = write_tmp("junk.bin", &junk);
        assert!(matches!(inspect(&p), ContainerVerdict::NotApplicable));
        assert!(inspect(&p).repair_targets().is_empty());
        let _ = std::fs::remove_file(&p);
    }

    /// moov 在尾部（非 faststart）也要能找到。
    #[test]
    fn finds_moov_after_leading_free_boxes() {
        let mut file = Vec::new();
        file.extend_from_slice(&bx(b"ftyp", b"isom"));
        file.extend_from_slice(&bx(b"free", &vec![0u8; 1024]));
        let mut moov_inner = Vec::new();
        moov_inner.extend_from_slice(&mvhd(1000, 60_000));
        let mut trak_inner = Vec::new();
        trak_inner.extend_from_slice(&bx(b"tkhd", &vec![0u8; 84]));
        let mut mdia_inner = Vec::new();
        mdia_inner.extend_from_slice(&mdhd(1000, 60_000));
        mdia_inner.extend_from_slice(&hdlr(b"vide"));
        trak_inner.extend_from_slice(&bx(b"mdia", &mdia_inner));
        trak_inner.extend_from_slice(&bx(b"edts", &elst(&[(3_600, 0)])));
        moov_inner.extend_from_slice(&bx(b"trak", &trak_inner));
        file.extend_from_slice(&bx(b"mdat", &vec![0u8; 2048]));
        file.extend_from_slice(&bx(b"moov", &moov_inner));

        let p = write_tmp("tailmoov.bin", &file);
        let v = inspect(&p);
        let targets = v.repair_targets();
        assert!(matches!(v, ContainerVerdict::Lying { .. }), "尾部 moov 也要抓到，实际 {v:?}");
        assert_eq!(targets.len(), 1);
        let raw = std::fs::read(&p).unwrap();
        assert_eq!(&raw[targets[0] as usize..targets[0] as usize + 4], b"elst");
        let _ = std::fs::remove_file(&p);
    }

    /// 真实库对账（`#[ignore]`，只在开发机上按环境变量手动跑）。
    ///
    /// 存在的意义：合成字节是我自己按规范拼的，**不能证明**真文件上也判得对。
    /// 这条拿 ffprobe 的基准答案（`format.duration` vs `-ignore_editlist 1`）做交叉
    /// 核对，专门验证两件事：真坏文件一个不漏（召回）、合法 edit list 一个不碰（精度）——
    /// 后者是本模块唯一的不可逆风险。
    ///
    /// 跑法：`AURORA_ELST_SWEEP=<目录> cargo test --lib mp4_editlist -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机媒体库；用 AURORA_ELST_SWEEP 指定目录手动跑"]
    fn sweep_real_library() {
        let root = match std::env::var("AURORA_ELST_SWEEP") {
            Ok(r) => r,
            Err(_) => {
                eprintln!("AURORA_ELST_SWEEP 未设置，跳过");
                return;
            }
        };
        let mut files = Vec::new();
        collect_videos(std::path::Path::new(&root), 0, &mut files);
        let (mut lying, mut masked, mut healthy, mut na, mut too_big) =
            (0usize, 0usize, 0usize, 0usize, 0usize);
        for f in &files {
            match inspect(f) {
                ContainerVerdict::Lying { tracks } => {
                    lying += 1;
                    let t = tracks.iter().find(|t| t.is_lying()).unwrap();
                    println!(
                        "LYING {:>7.1}min 被藏 (表={:.2}s elst={:.2}s) {} 处 elst :: {:?}",
                        t.table_secs / 60.0,
                        t.table_secs,
                        t.elst_secs,
                        tracks.iter().filter(|x| x.is_lying()).count(),
                        f.file_name().unwrap_or_default()
                    );
                }
                ContainerVerdict::Masked { .. } => masked += 1,
                ContainerVerdict::Healthy => healthy += 1,
                ContainerVerdict::MoovTooBig => too_big += 1,
                ContainerVerdict::NotApplicable => na += 1,
            }
        }
        println!(
            "\nSUMMARY files={} lying={} masked={} healthy={} notApplicable={} moovTooBig={}",
            files.len(),
            lying,
            masked,
            healthy,
            na,
            too_big
        );
    }

    fn collect_videos(dir: &Path, depth: u32, out: &mut Vec<std::path::PathBuf>) {
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
                collect_videos(&p, depth + 1, out);
            } else {
                let ext = p.extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
                    out.push(p);
                }
            }
        }
    }
}
