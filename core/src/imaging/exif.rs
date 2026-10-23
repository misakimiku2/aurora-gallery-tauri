//! EXIF 方向（Orientation，tag 0x0112）的读取。
//!
//! ## 为什么非要读它
//!
//! 浏览器对 `<img>` 默认 `image-orientation: from-image`（Chrome 81+ 起），会**自动**
//! 按 EXIF 把照片转正；而 `core::imaging::decode_file` 拿到的是**存储方向**的原始像素。
//! 两边不一致时表现为「屏幕上正的、导出躺的」——所见非所得，是编辑器最不能忍的错误。
//!
//! 对策不是让哪边"偷偷转"，而是：图层 `<img>` 显式 `imageOrientation: 'none'`（禁止
//! 浏览器自动转），由这里读出方向，**一次性折进图层的 `rotation` / `flip`**（设计稿
//! §5.1 的同一个哲学：低频一次算完，不留第二个真源）。
//!
//! ## 为什么不引 `exif` crate
//!
//! 只需要 IFD0 里的一个 SHORT 字段，而 `exif` crate 会带进一整套 TIFF 结构体与
//! tag 表（Phase 0 刻意少引依赖）。这里手写解析：JPEG 的 APP1、PNG 的 `eXIf`、
//! TIFF 三种容器，共约 150 行，只认 tag 0x0112。
//!
//! 读不到、格式不认识、值不在 1..=8 —— 一律返回 `1`（不转）。这是安全的默认：
//! 绝大多数图没有 EXIF 或方向就是 1。
//!
//! WebP 的 `EXIF` chunk 暂不解析（本项目库里极少见，且方向异常时会「不转」而非「转错」）。

use std::io::Read;

/// APP1 段最大 64KB，读 256KB 足够覆盖 SOI 之后的任何元数据排列。
const HEAD_BYTES: u64 = 256 * 1024;

/// 读文件头这么多字节；失败返回空。
fn read_head(path: &str) -> Vec<u8> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut buf = Vec::new();
    let _ = file.take(HEAD_BYTES).read_to_end(&mut buf);
    buf
}

/// 读取图片的 EXIF 方向（1..=8）。读不到返回 1。
pub fn read_orientation(path: &str) -> u8 {
    parse_orientation(&read_head(path)).unwrap_or(1)
}

pub(super) fn parse_orientation(bytes: &[u8]) -> Option<u8> {
    if bytes.len() < 8 {
        return None;
    }
    // JPEG：SOI 之后扫段，找 APP1 里的 "Exif\0\0"
    if bytes[0] == 0xFF && bytes[1] == 0xD8 {
        return parse_jpeg(bytes);
    }
    // PNG：找 eXIf chunk
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return parse_png(bytes);
    }
    // TIFF：头就在文件开头
    parse_tiff(bytes, 0)
}

fn parse_jpeg(b: &[u8]) -> Option<u8> {
    let mut i = 2usize;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        // 填充字节与无长度的标记（SOI / TEM / RSTn）
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        // 到扫描数据就没有元数据了
        if marker == 0xDA {
            return None;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        let seg_start = i + 4;
        let seg_end = (i + 2 + len).min(b.len());
        if seg_start > seg_end {
            return None;
        }
        let seg = &b[seg_start..seg_end];
        if marker == 0xE1 && seg.starts_with(b"Exif\0\0") {
            return parse_tiff(seg, 6);
        }
        i += 2 + len;
    }
    None
}

fn parse_png(b: &[u8]) -> Option<u8> {
    let mut i = 8usize;
    while i + 8 <= b.len() {
        let len = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let ty = &b[i + 4..i + 8];
        let data_start = i + 8;
        let data_end = data_start.checked_add(len)?;
        if data_end > b.len() {
            return None;
        }
        if ty == b"eXIf" {
            return parse_tiff(&b[data_start..data_end], 0);
        }
        // chunk = len(4) + type(4) + data + crc(4)
        i = data_end + 4;
    }
    None
}

/// 解析 TIFF 结构里的 IFD0，取 tag 0x0112。
///
/// `base` 是 TIFF 头在 `b` 里的偏移（JPEG 的 APP1 前面有 `Exif\0\0` 六个字节）。
fn parse_tiff(b: &[u8], base: usize) -> Option<u8> {
    let t = b.get(base..)?;
    if t.len() < 8 {
        return None;
    }
    let little = match &t[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u16> {
        let s = t.get(o..o + 2)?;
        Some(if little {
            u16::from_le_bytes([s[0], s[1]])
        } else {
            u16::from_be_bytes([s[0], s[1]])
        })
    };
    let u32_at = |o: usize| -> Option<u32> {
        let s = t.get(o..o + 4)?;
        Some(if little {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        })
    };

    if u16_at(2)? != 0x002A {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;

    for k in 0..count {
        let entry = ifd + 2 + k * 12;
        let tag = u16_at(entry)?;
        if tag != 0x0112 {
            continue;
        }
        // 未校验 type/count，直接取 4 字节值字段的前 2 字节（规范里方向是 SHORT(3) × 1）
        let value = u16_at(entry + 8)?;
        return if (1..=8).contains(&value) { Some(value as u8) } else { None };
    }
    None
}
