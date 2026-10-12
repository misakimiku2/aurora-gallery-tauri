//! 视频元数据读取（视频 P1，设计方案 §6 / §10.5）。
//!
//! 用 revelo（BSD-2-Clause，纯 Rust、零 `unsafe`、零原生依赖，MediaInfoLib 的
//! clean-room 移植，覆盖 180+ 容器/编码）读取视频容器的 duration / width / height /
//! frame_rate / rotation。mmap 只读元数据区，多 GB 文件也只 fault in 元数据页。
//!
//! 放在 src-tauri（谁用谁引）：core 侧只需要原始数值类型，不需要 revelo 的类型。
//! 刻意不启用 `exiftool-tables` feature —— 那会把 GPL/Artistic 的表拖进来。

use std::path::Path;

/// 视频容器元数据。
///
/// **width / height 是「编码尺寸」，不按 rotation 交换**（设计方案 §6）：remux/转码决策
/// 需要编码尺寸，布局 ratio 需要的显示尺寸由调用方拿 rotation 派生。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_ms: Option<i64>,
    pub frame_rate: Option<f64>,
    pub rotation: Option<i64>,
}

/// 读取单个视频文件的容器元数据；解析失败（或不是视频）返回 `None`，不 panic。
pub fn read_video_metadata(path: &Path) -> Option<VideoMetadata> {
    let path_str = path.to_str()?;
    let meta = revelo::Metadata::from_file(path_str)?;

    let mut vm = VideoMetadata::default();

    // revelo 的流值是 (字段名, 字符串值)，字段名沿用 MediaInfo 口径。
    // 键做归一化（小写 + 去空格/下划线/连字符）后匹配，尽量稳健地吃下别名。
    //
    // 先 General 再 Video：General 的 `Duration` 是**全片时长**（容器级，含音轨），
    // 优先采用；Video 流的 `Duration` 只是视频轨时长。字段已存在时不覆盖，
    // 因此 Video 只补 General 缺失的项（width/height/frame rate/rotation 基本都在 Video）。
    for (key, value) in meta.general() {
        apply_field(&mut vm, &normalize_key(key), value);
    }
    for (key, value) in meta.video() {
        apply_field(&mut vm, &normalize_key(key), value);
    }

    Some(vm)
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 把单条 (归一化键, 字符串值) 应用到元数据结构。
fn apply_field(vm: &mut VideoMetadata, key: &str, value: &str) {
    match key {
        "width" => {
            if let Some(v) = parse_u32(value) {
                if vm.width == 0 {
                    vm.width = v;
                }
            }
        }
        "height" => {
            if let Some(v) = parse_u32(value) {
                if vm.height == 0 {
                    vm.height = v;
                }
            }
        }
        "framerate" | "frameratefps" | "fps" => {
            if vm.frame_rate.is_none() {
                if let Some(v) = parse_f64(value) {
                    vm.frame_rate = Some(v);
                }
            }
        }
        "rotation" => {
            if vm.rotation.is_none() {
                if let Some(v) = parse_i64(value) {
                    vm.rotation = Some(v.rem_euclid(360));
                }
            }
        }
        "duration" | "durationms" => {
            if vm.duration_ms.is_none() {
                vm.duration_ms = parse_duration_ms(value);
            }
        }
        _ => {}
    }
}

/// 解析整数字段：容忍前导/尾部空白与小数（截断）。
fn parse_u32(value: &str) -> Option<u32> {
    parse_f64(value).map(|v| v.round() as u32)
}

fn parse_i64(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if let Ok(v) = trimmed.parse::<i64>() {
        return Some(v);
    }
    parse_f64(trimmed).map(|v| v.round() as i64)
}

fn parse_f64(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if let Ok(v) = trimmed.parse::<f64>() {
        return Some(v);
    }
    // 去掉单位后缀（如 "30.000 FPS"），取第一个数字 token。
    let token: String = trimmed
        .trim_start_matches(|c: char| !c.is_ascii_digit() && c != '-' && c != '.')
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    token.parse::<f64>().ok()
}

/// 把 revelo 的时长字符串解析成毫秒。
///
/// revelo 是 MediaInfoLib 的移植，Duration 通常以毫秒整数给出；这里同时兼容
/// "1234"（毫秒）、"12.34"（秒，含小数点时按秒）、"1 h 2 min 3 s" 一类描述串。
fn parse_duration_ms(value: &str) -> Option<i64> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    // 纯数字（整数）→ 毫秒
    if let Ok(ms) = v.parse::<i64>() {
        return Some(ms);
    }
    // 纯小数 → 秒
    if let Ok(secs) = v.parse::<f64>() {
        return Some((secs * 1000.0).round() as i64);
    }
    // "1 h 2 min 3 s" / "2 min 3.5 s" 形态：累加各 token。
    let mut total_ms: f64 = 0.0;
    let mut num: Option<f64> = None;
    let mut matched = false;
    for token in v.split_whitespace() {
        if let Ok(n) = token.parse::<f64>() {
            num = Some(n);
            continue;
        }
        if let Some(n) = num.take() {
            let unit = token.to_lowercase();
            let ms = if unit.starts_with('h') {
                n * 3_600_000.0
            } else if unit.starts_with("min") || unit.starts_with('m') {
                n * 60_000.0
            } else if unit.starts_with('s') {
                n * 1000.0
            } else {
                continue;
            };
            total_ms += ms;
            matched = true;
        }
    }
    if matched {
        Some(total_ms.round() as i64)
    } else {
        // 兜底：抽第一个数字，按毫秒处理。
        parse_f64(v).map(|n| n.round() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 视频 P1 实测（设计方案 §10.5）：读取本仓 `log/` 下的 4 个手机拍摄样本，
    /// 打印 duration / width / height / fps / rotation。样本不存在时优雅跳过。
    ///
    /// `cargo test` 的工作目录是 crate 根（src-tauri/），样本在仓库根的 `log/`，
    /// 故相对路径为 `../log/...`。
    #[test]
    fn reads_sample_videos() {
        let samples = [
            "../log/SVID_20261006_212831_1.mp4",
            "../log/SVID_20261006_213438_1.mp4",
            "../log/SVID_20261007_002550_1.mp4",
            "../log/SVID_20261007_030932_1.mp4",
        ];

        let mut checked = 0;
        for s in samples {
            let path = Path::new(s);
            if !path.exists() {
                eprintln!("[skip] 样本不存在: {}", s);
                continue;
            }
            checked += 1;
            // 先 dump 全部原始键值，便于核对 revelo 的字段名（首轮排查用）。
            if let Some(meta) = revelo::Metadata::from_file(s) {
                println!("==== {} ====", s);
                for (k, v) in meta.general() {
                    println!("  [general] {} = {}", k, v);
                }
                for (k, v) in meta.video() {
                    println!("  [video]   {} = {}", k, v);
                }
            }
            match read_video_metadata(path) {
                Some(vm) => println!(
                    "=> {} : {}x{} duration_ms={:?} fps={:?} rotation={:?}",
                    s, vm.width, vm.height, vm.duration_ms, vm.frame_rate, vm.rotation
                ),
                None => println!("=> {} : 解析失败（None）", s),
            }
        }
        if checked == 0 {
            eprintln!("[skip] 4 个样本均不存在，跳过实测");
        }
    }
}
