//! `.aurora` 编辑文档（自包含 ZIP）——**存与开**。
//!
//! 设计依据：`docs/图片编辑与封面合成-设计方案.md` §4.4（文档格式）。
//!
//! ## 为什么写侧在 Rust
//!
//! 参考模式那边的写侧（`src/components/comparer/session-io.ts` 的
//! `serializeSessionToZip`）是把每个图层用 `read_file_as_base64` 拉进 WebView，`atob`
//! 展开成字节再交给 JSZip。§4.4 已定死编辑器的写侧不复用这条：全分辨率字节过一次
//! IPC + base64（多 1/3 体积）会直接顶穿 §1.2 的 200–400MB 常驻目标。这里全程在
//! 进程内流式搬运，字节不进 WebView。
//!
//! 读侧同理：解压出的图层图落到**系统临时目录**，前端拿路径继续走 `convertFileSrc`，
//! 于是显示的仍是原文件管线（放大到 100% 看到真像素），而不是 blob URL。
//!
//! ## 容器布局（与参考模式同一个 `.aurora`）
//!
//! ```text
//! <document>.aurora                ZIP
//!   manifest.json                  version / kind / createdAt / sessionName / canvas
//!   layout.json                    layers[]（编辑器）或 items[]（参考模式）
//!   images/<md5>.<ext>             图层源图，内容寻址
//! ```
//!
//! **`images/` 里是源文件的原始字节，不是重编码结果。** 两条理由：
//!
//! 1. v2 的图层从不烘焙像素（调色是渲染期属性、变换是仿射矩阵），所以"原字节"就是
//!    "无损"。设计稿 §4.5 的"保存时不重编码未改动的层"在今天是**全部图层**。
//! 2. JPEG 解码成 RGBA 再按 WebP lossless 存，体积通常反而涨 5–8 倍（无损编码一张
//!    已经过 DCT 的照片是负优化）。原样搬运顺带把 **EXIF 方向**也保住了——重编码会
//!    丢掉它，而图层的定界框是按方向折算过的。
//!
//! §4.5 的"存储分辨率上限 = 画布 × 2"因此**尚未生效**（见进度文档的未完成表）：
//! 它必须按源格式分流（PNG 转 WebP lossless 省一半，JPEG 转了就涨），且要配一档
//! 保存选项 UI，不是一句 `resize` 能收口的。
//!
//! ## 去重
//!
//! 按**内容 md5** 去重，且文件名就是 md5 —— 于是"同一张底图导入两次"只存一份，
//! 而且读侧天然内容寻址：解压目录里同名文件已存在且大小一致就跳过，重开文档不再
//! 重写一遍几十 MB。
//!
//! ## 与参考模式的互操作
//!
//! 读侧两种 `layout.json` 都认：编辑器的 `layers[]`，以及参考模式的 `items[]`
//! （`x/y/width/height/rotation` 直接映射成定界框）。设计稿 §4.4 承诺"画布保存的
//! 会话文件可直接在编辑器中打开，无需转换"，这就是那一句的落地。写侧只写 `layers[]`
//! ——参考模式有自己的保存路径，不归这里管。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use crate::imaging::BlendMode;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// 文档扩展名（与参考模式共用）。
pub const PROJECT_EXTENSION: &str = "aurora";
/// 写入 `manifest.json` 的格式版本。与参考模式同一串（`session-io.ts` 也写 `2.0`）。
pub const PROJECT_VERSION: &str = "2.0";
/// `manifest.kind`：编辑器文档。参考模式的文件没有这个字段（空串）。
pub const PROJECT_KIND_EDITOR: &str = "editor";

const MANIFEST_NAME: &str = "manifest.json";
const LAYOUT_NAME: &str = "layout.json";
const IMAGES_DIR: &str = "images";

/// 解压总量上限——防"压缩炸弹"（一个 1MB 的包解出 100GB 会把磁盘写满）。
///
/// 8 GiB 远高于真实文档量级（§4.5 估算四层封面约 50–110 MB），只用来挡恶意/损坏包。
const MAX_EXTRACTED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 流式搬运的缓冲区大小。1 MiB 在机械盘与 NVMe 上都是"够大且不占内存"的折中。
const COPY_BUFFER: usize = 1 << 20;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("读写失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("压缩包损坏: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("不是有效的 .aurora 文档: {0}")]
    Invalid(String),
    #[error("图层源文件读取失败({path}): {msg}")]
    Source { path: String, msg: String },
}

// ============================================================================
// 持久化结构（JSON）。字段名一律 camelCase —— 前端 `types.ts` 的 `LayerBox` 等
// 用它，Rust 侧 `frame` 因 `box` 是保留字而改名，靠 `rename` 对齐。
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvas {
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_background")]
    pub background: String,
}

fn default_background() -> String {
    "transparent".to_string()
}

impl ProjectCanvas {
    pub fn new(width: u32, height: u32, background: impl Into<String>) -> Self {
        Self { width, height, background: background.into() }
    }

    pub fn is_valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

/// 图层定界框。语义与前端 `LayerBox` 逐字段一致：`w/h` 是**未旋转**的内容尺寸。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBox {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub skew_x: f64,
    #[serde(default)]
    pub skew_y: f64,
}

/// 调色参数（-100..=100，0 = 不变）。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAdjust {
    #[serde(default)]
    pub brightness: f32,
    #[serde(default)]
    pub contrast: f32,
    #[serde(default)]
    pub saturation: f32,
    #[serde(default)]
    pub temperature: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    #[serde(default = "default_version")]
    pub version: String,
    /// `"editor"`；参考模式写出的文件没有此字段，反序列化成空串。
    #[serde(default)]
    pub kind: String,
    /// Unix 毫秒。参考模式写的就是毫秒（`Date.now()`）。
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub session_name: String,
    /// 画布尺寸。参考模式不写这个字段（它的画布由 items 的包围盒推出来）。
    #[serde(default)]
    pub canvas: Option<ProjectCanvas>,
}

fn default_version() -> String {
    PROJECT_VERSION.to_string()
}

/// 一个图层在文档里的持久化形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayer {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// `images/` 下的文件名；空串 = 这一层没有源图（会被读侧跳过）。
    #[serde(default)]
    pub image_file_name: String,
    #[serde(default)]
    pub natural_width: u32,
    #[serde(default)]
    pub natural_height: u32,
    #[serde(default = "default_true")]
    pub visible: bool,
    /// 混合模式。**缺省 `normal`**：老工程没有这个字段，读出来必须是"正常"。
    #[serde(default)]
    pub blend: BlendMode,
    /// 锁像素 / 锁位置。**缺省 false**：老工程没有这两个字段，读出来必须是"未锁"。
    #[serde(default)]
    pub lock_pixel: bool,
    #[serde(default)]
    pub lock_position: bool,
    /// 条目类型：`"layer"`（普通，缺省）/ `"group"`（**组行**——不是像素，没有 source）。
    /// 老工程缺字段按 layer 读。
    #[serde(default)]
    pub layer_kind: String,
    /// 成员层的组行 id（组行自身为 None）
    #[serde(default)]
    pub group_id: Option<String>,
    /// 不透明度百分比（0..=100）。**缺省 100**：昨天的工程文件里没有这个字段，
    /// 读出来必须是"完全不透明"，不能把老文档读成透明的。
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    /// JSON 键名是 `box`：`box` 在 Rust 里是保留字。
    #[serde(default, rename = "box")]
    pub frame: ProjectBox,
    #[serde(default)]
    pub adjust: Option<ProjectAdjust>,
    /// 原始来源路径，**仅供追溯**：读侧一律用解压出的那份字节，不碰这个路径。
    /// 用户把文档发给别人时它指向一个对方没有的文件——那是预期内的，不要拿它去读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

fn default_true() -> bool {
    true
}

/// 老工程（2026-10-23 及之前存的）没有 `opacity` 字段，按"完全不透明"读。
fn default_opacity() -> u8 {
    100
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayout {
    #[serde(default)]
    pub layers: Vec<ProjectLayer>,
    /// 参考模式（画布）写出的是 `items[]`，只有几何与文件名。
    #[serde(default)]
    pub items: Vec<ReferenceItem>,
    #[serde(default)]
    pub active_layer_id: Option<String>,
}

/// 参考模式的图元。只为"能打开画布会话"而存在，不参与写出。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub image_file_name: String,
}

// ============================================================================
// 写侧
// ============================================================================

/// 待保存的图层（前端传来的**最终**状态：定界框 + 调色，不含矩阵）。
///
/// 刻意不收仿射六参：文档要存的是**可再编辑的语义参数**，矩阵是导出时的派生物
/// （`composeMatrix(box, natural)`）。存矩阵等于把"框"这一层语义丢掉，将来改缩放
/// 就没法从矩阵反推回去。
#[derive(Debug, Clone)]
pub struct SaveLayer {
    pub id: String,
    pub name: String,
    /// 源文件绝对路径
    pub source: String,
    pub natural_width: u32,
    pub natural_height: u32,
    pub visible: bool,
    /// 不透明度百分比（0..=100）
    pub opacity: u8,
    /// 混合模式
    pub blend: BlendMode,
    pub lock_pixel: bool,
    pub lock_position: bool,
    pub layer_kind: String,
    pub group_id: Option<String>,
    pub frame: ProjectBox,
    pub adjust: Option<ProjectAdjust>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub path: String,
    /// 落盘后的文档字节数
    pub bytes: u64,
    pub layer_count: usize,
    /// `images/` 里的文件数（去重后）
    pub image_count: usize,
    /// 被去重省掉的字节数
    pub deduped_bytes: u64,
}

struct Digest {
    md5: String,
    len: u64,
}

fn digest_file(path: &Path) -> Result<Digest, ProjectError> {
    let mut file = File::open(path).map_err(|e| ProjectError::Source {
        path: path.display().to_string(),
        msg: e.to_string(),
    })?;
    let mut ctx = md5::Context::new();
    let mut buf = vec![0u8; COPY_BUFFER];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.consume(&buf[..n]);
        len += n as u64;
    }
    Ok(Digest { md5: format!("{:x}", ctx.compute()), len })
}

/// 从源路径取扩展名，只保留 ASCII 字母数字（它要进 ZIP 文件名）。
fn extension_of(path: &str) -> String {
    let raw = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let cleaned: String = raw.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if cleaned.is_empty() {
        "bin".to_string()
    } else {
        cleaned
    }
}

fn copy_file_into_zip(
    zip: &mut ZipWriter<BufWriter<File>>,
    path: &Path,
    entry: &str,
    options: SimpleFileOptions,
) -> Result<u64, ProjectError> {
    let mut src = File::open(path).map_err(|e| ProjectError::Source {
        path: path.display().to_string(),
        msg: e.to_string(),
    })?;
    zip.start_file(entry, options)?;
    let mut buf = vec![0u8; COPY_BUFFER];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        zip.write_all(&buf[..n])?;
        total += n as u64;
    }
    Ok(total)
}

/// 保存一份编辑文档。
///
/// 写盘顺序：先写 `<target>.tmp`，写完 `sync_all` 再改名覆盖目标。中途崩溃/断电时
/// 旧文档仍然是完整的（改名是原子的），而不会留下一个半截的 ZIP。
pub fn save_project(
    target: &Path,
    name: &str,
    canvas: &ProjectCanvas,
    layers: &[SaveLayer],
    active_layer_id: Option<&str>,
) -> Result<SaveReport, ProjectError> {
    if !canvas.is_valid() {
        return Err(ProjectError::Invalid(format!(
            "画布尺寸无效: {}×{}",
            canvas.width, canvas.height
        )));
    }
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(dir) = parent {
        fs::create_dir_all(dir)?;
    }

    // ---- 1. 逐个唯一源文件算内容哈希（流式，不整体读进内存）----
    let mut digests: HashMap<&str, Digest> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    for layer in layers {
        if layer.source.is_empty() || digests.contains_key(layer.source.as_str()) {
            continue;
        }
        let digest = digest_file(Path::new(&layer.source))?;
        order.push(layer.source.as_str());
        digests.insert(layer.source.as_str(), digest);
    }

    // ---- 2. 内容寻址命名 + 跨路径去重 ----
    //
    // `image_file_name` 存**裸文件名**（`<md5>.<ext>`），ZIP 里落在 `images/` 下——
    // 与参考模式同一约定（那边 `extractZipImage` 就是拼 `images/${imageFileName}`）。
    // 两套写法各存各的，读侧就得双份兼容，不如写的时候统一。
    let mut by_digest: HashMap<String, String> = HashMap::new();
    let mut to_write: Vec<(String, PathBuf)> = Vec::new(); // (裸文件名, 源路径)
    let mut deduped_bytes = 0u64;
    for source in &order {
        let digest = &digests[*source];
        if by_digest.contains_key(&digest.md5) {
            deduped_bytes += digest.len;
            continue;
        }
        let file_name = format!("{}.{}", digest.md5, extension_of(source));
        by_digest.insert(digest.md5.clone(), file_name.clone());
        to_write.push((file_name, PathBuf::from(source)));
    }

    // ---- 3. 组 layout ----
    let persisted: Vec<ProjectLayer> = layers
        .iter()
        .map(|l| ProjectLayer {
            id: l.id.clone(),
            name: l.name.clone(),
            image_file_name: digests
                .get(l.source.as_str())
                .and_then(|d| by_digest.get(&d.md5).cloned())
                .unwrap_or_default(),
            natural_width: l.natural_width,
            natural_height: l.natural_height,
            visible: l.visible,
            opacity: l.opacity,
            blend: l.blend,
            lock_pixel: l.lock_pixel,
            lock_position: l.lock_position,
            layer_kind: l.layer_kind.clone(),
            group_id: l.group_id.clone(),
            frame: l.frame,
            adjust: l.adjust,
            source_path: if l.source.is_empty() { None } else { Some(l.source.clone()) },
        })
        .collect();

    let manifest = ProjectManifest {
        version: PROJECT_VERSION.to_string(),
        kind: PROJECT_KIND_EDITOR.to_string(),
        created_at: now_millis(),
        session_name: name.to_string(),
        canvas: Some(canvas.clone()),
    };
    let layout = ProjectLayout {
        layers: persisted,
        items: Vec::new(),
        active_layer_id: active_layer_id.map(|s| s.to_string()),
    };

    // ---- 4. 写 ZIP ----
    let tmp = tmp_sibling(target);
    let result = (|| -> Result<(), ProjectError> {
        let file = File::create(&tmp)?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        // JSON 走 deflate（几百字节省一半不心疼），图片原样存（已压缩，再 deflate 只是烧 CPU）
        let json_options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let image_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);

        zip.start_file(MANIFEST_NAME, json_options)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| {
            ProjectError::Invalid(format!("manifest 序列化失败: {e}"))
        })?)?;

        zip.start_file(LAYOUT_NAME, json_options)?;
        zip.write_all(
            &serde_json::to_vec_pretty(&layout)
                .map_err(|e| ProjectError::Invalid(format!("layout 序列化失败: {e}")))?,
        )?;

        for (file_name, source) in &to_write {
            let entry = format!("{}/{}", IMAGES_DIR, file_name);
            copy_file_into_zip(&mut zip, source, &entry, image_options)?;
        }

        let writer = zip.finish()?;
        let file = writer.into_inner().map_err(|e| ProjectError::Io(e.into_error()))?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = fs::remove_file(&tmp); // 别把半截临时文件留在用户目录里
        return Err(err);
    }

    replace_file(&tmp, target)?;

    Ok(SaveReport {
        path: target.display().to_string(),
        bytes: fs::metadata(target).map(|m| m.len()).unwrap_or(0),
        layer_count: layers.len(),
        image_count: to_write.len(),
        deduped_bytes,
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn tmp_sibling(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    match target.parent() {
        Some(dir) => dir.join(name),
        None => PathBuf::from(name),
    }
}

/// 原子替换。Windows 上 `rename` **不覆盖已存在的目标**（返回 17），所以先删再改名。
///
/// 删除与改名之间理论上有一个极短的窗口；但正常路径（目标已存在）是"删旧→改名"，
/// 而失败路径不会动旧文件——比直接 `File::create(target)` 覆写安全得多。
fn replace_file(tmp: &Path, target: &Path) -> Result<(), ProjectError> {
    match fs::rename(tmp, target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            fs::remove_file(target)?;
            fs::rename(tmp, target).map_err(ProjectError::from)
        }
        Err(e) => Err(ProjectError::from(e)),
    }
}

// ============================================================================
// 读侧
// ============================================================================

/// 文档来自哪种写法。前端可以用它提示"这是从画布打开的参考会话，已转成图层"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectSource {
    Editor,
    Reference,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedLayer {
    pub id: String,
    pub name: String,
    /// 解压出的图片路径；`None` = 这一层没有源图（读侧已跳过，理论上不会出现）
    pub source: Option<String>,
    pub natural_width: u32,
    pub natural_height: u32,
    pub visible: bool,
    /// 不透明度百分比（0..=100）；老工程缺这个字段时按 100 返回
    pub opacity: u8,
    /// 混合模式（kebab-case 字符串，与 CSS `mix-blend-mode` 同名）
    pub blend: BlendMode,
    /// 锁像素 / 锁位置（老工程缺字段时按 false 返回）
    pub lock_pixel: bool,
    pub lock_position: bool,
    /// 条目类型（"layer" / "group"），老工程缺字段按 layer
    pub layer_kind: String,
    pub group_id: Option<String>,
    /// JSON 键名同样是 `box`（前端读 `EditorLayer.box`）；Rust 里 `box` 是保留字
    #[serde(rename = "box")]
    pub frame: ProjectBox,
    pub adjust: Option<ProjectAdjust>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub name: String,
    pub canvas: ProjectCanvas,
    pub layers: Vec<OpenedLayer>,
    pub active_layer_id: Option<String>,
    pub source: ProjectSource,
    /// 非致命问题（跳过某层、尺寸对不上……）。前端可以照原样显示或忽略。
    pub warnings: Vec<String>,
}

/// 打开一份 `.aurora` 文档并把图层图解到 `extract_dir`。
///
/// `extract_dir` 由调用方给（`src-tauri` 用系统临时目录）。命名是**内容寻址**的
/// （`images/<md5>.<ext>`），所以同一张图在多个文档间只落一份，重开时大小一致就跳过。
pub fn open_project(archive: &Path, extract_dir: &Path) -> Result<OpenedProject, ProjectError> {
    let file = File::open(archive).map_err(|e| ProjectError::Source {
        path: archive.display().to_string(),
        msg: e.to_string(),
    })?;
    let mut zip = ZipArchive::new(BufReader::new(file))?;

    let manifest: ProjectManifest = read_json(&mut zip, MANIFEST_NAME)?;
    let layout: ProjectLayout = read_json(&mut zip, LAYOUT_NAME)?;

    let is_reference = layout.layers.is_empty() && !layout.items.is_empty();
    let mut warnings: Vec<String> = Vec::new();

    // 画布：编辑器写在自己 manifest 里；参考模式没有，按 items 包围盒推
    let canvas = match (manifest.canvas.clone(), is_reference) {
        (Some(c), _) if c.is_valid() => c,
        (Some(c), _) => {
            warnings.push(format!("文档里的画布尺寸无效（{}×{}），已按内容重算", c.width, c.height));
            canvas_from_items(&layout.items)
        }
        (None, _) => canvas_from_items(&layout.items),
    };
    if !canvas.is_valid() {
        return Err(ProjectError::Invalid("文档没有可用的画布尺寸".to_string()));
    }

    fs::create_dir_all(extract_dir)?;
    let mut extracted: HashMap<String, PathBuf> = HashMap::new();
    let mut budget = MAX_EXTRACTED_BYTES;

    // 统一成"待构造"的中间形态：两种来源（layers / items）先归一，再一起解压
    let planned: Vec<PlannedLayer> = if is_reference {
        layout
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| PlannedLayer {
                id: if item.id.is_empty() { format!("layer-ref-{i}") } else { item.id.clone() },
                name: format!("图层 {}", i + 1),
                image_file_name: item.image_file_name.clone(),
                natural_width: 0,
                natural_height: 0,
                visible: true,
                opacity: 100,
                blend: BlendMode::Normal,
                lock_pixel: false,
                lock_position: false,
                layer_kind: "layer".to_string(),
                group_id: None,
                frame: ProjectBox {
                    x: item.x,
                    y: item.y,
                    w: item.width,
                    h: item.height,
                    rotation: item.rotation,
                    ..ProjectBox::default()
                },
                adjust: None,
            })
            .collect()
    } else {
        layout
            .layers
            .iter()
            .map(|l| PlannedLayer {
                id: l.id.clone(),
                name: l.name.clone(),
                image_file_name: l.image_file_name.clone(),
                natural_width: l.natural_width,
                natural_height: l.natural_height,
                visible: l.visible,
                opacity: l.opacity,
                blend: l.blend,
                lock_pixel: l.lock_pixel,
                lock_position: l.lock_position,
                layer_kind: l.layer_kind.clone(),
                group_id: l.group_id.clone(),
                frame: l.frame,
                adjust: l.adjust,
            })
            .collect()
    };

    let mut layers = Vec::with_capacity(planned.len());
    for planned in planned {
        if planned.image_file_name.is_empty() {
            warnings.push(format!("图层「{}」没有图像文件，已跳过", planned.name));
            continue;
        }
        let out_path = match extract_entry(
            &mut zip,
            &planned.image_file_name,
            extract_dir,
            &mut extracted,
            &mut budget,
        ) {
            Ok(p) => p,
            Err(err) => {
                warnings.push(format!("图层「{}」解压失败（{err}），已跳过", planned.name));
                continue;
            }
        };

        // 实际尺寸以**解压出的文件**为准：定界框就是针对这批字节摆的。
        let (file_w, file_h) = image::image_dimensions(&out_path).unwrap_or((0, 0));
        let (width, height) = if file_w > 0 && file_h > 0 {
            if planned.natural_width > 0
                && (planned.natural_width != file_w || planned.natural_height != file_h)
            {
                warnings.push(format!(
                    "图层「{}」记录的尺寸 {}×{} 与图不符（{}×{}），已按图修正",
                    planned.name, planned.natural_width, planned.natural_height, file_w, file_h
                ));
            }
            (file_w, file_h)
        } else {
            (planned.natural_width, planned.natural_height)
        };
        if width == 0 || height == 0 {
            warnings.push(format!("图层「{}」无法读出尺寸，已跳过", planned.name));
            continue;
        }

        layers.push(OpenedLayer {
            id: planned.id,
            name: if planned.name.is_empty() {
                base_name(&out_path)
            } else {
                planned.name
            },
            source: Some(out_path.display().to_string()),
            natural_width: width,
            natural_height: height,
            visible: planned.visible,
            opacity: planned.opacity,
            blend: planned.blend,
            lock_pixel: planned.lock_pixel,
            lock_position: planned.lock_position,
            layer_kind: planned.layer_kind,
            group_id: planned.group_id,
            frame: planned.frame,
            adjust: planned.adjust,
        });
    }

    let name = if manifest.session_name.trim().is_empty() {
        archive
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string()
    } else {
        manifest.session_name
    };

    Ok(OpenedProject {
        name,
        canvas,
        layers,
        active_layer_id: layout.active_layer_id,
        source: if is_reference { ProjectSource::Reference } else { ProjectSource::Editor },
        warnings,
    })
}

struct PlannedLayer {
    id: String,
    name: String,
    image_file_name: String,
    natural_width: u32,
    natural_height: u32,
    visible: bool,
    opacity: u8,
    blend: BlendMode,
    lock_pixel: bool,
    lock_position: bool,
    layer_kind: String,
    group_id: Option<String>,
    frame: ProjectBox,
    adjust: Option<ProjectAdjust>,
}

/// 参考模式的 items 没有画布，按包围盒推（向上取整，至少 1px）。
fn canvas_from_items(items: &[ReferenceItem]) -> ProjectCanvas {
    let mut width = 0f64;
    let mut height = 0f64;
    for item in items {
        width = width.max(item.x + item.width);
        height = height.max(item.y + item.height);
    }
    ProjectCanvas::new(
        width.max(0.0).round() as u32,
        height.max(0.0).round() as u32,
        default_background(),
    )
}

fn read_json<T: DeserializeOwned, R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    entry: &str,
) -> Result<T, ProjectError> {
    let mut file = zip
        .by_name(entry)
        .map_err(|_| ProjectError::Invalid(format!("缺少 {entry}")))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    serde_json::from_slice(&buf)
        .map_err(|e| ProjectError::Invalid(format!("{entry} 解析失败: {e}")))
}

fn base_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("图层")
        .to_string()
}

/// 把 ZIP 内的条目名收敛成一个**安全的文件名**。
///
/// 这是解压路径上唯一的攻击面：恶意文档可以用 `../../evil.exe` 把文件写到解压目录之外
/// （zip-slip）。所以路径分隔符替换掉、非 ASCII 字符剔掉，且**只取文件名不建子目录**；
/// 若因此丢了信息（中文名、带子目录），补一个短哈希避免两张图撞名。
fn safe_entry_name(raw: &str) -> Result<String, ProjectError> {
    let flat = raw.replace('/', "_").replace('\\', "_");
    let cleaned: String = flat
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    // 至少要有一个字母数字：否则 `..` / `___` / 空串这些"没有名字的名字"会落到
    // 上级目录或变成纯占位符
    if !cleaned.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(ProjectError::Invalid(format!("压缩包内的文件名不合法: {raw}")));
    }
    if cleaned == flat {
        return Ok(cleaned);
    }
    let tag = format!("{:x}", md5::compute(flat.as_bytes()));
    Ok(match cleaned.rfind('.') {
        Some(i) if i > 0 => format!("{}-{}.{}", &cleaned[..i], &tag[..8], &cleaned[i + 1..]),
        _ => format!("{}-{}", cleaned, &tag[..8]),
    })
}

/// 图层文件在 ZIP 里的实际路径。
///
/// 编辑器与参考模式都把 `imageFileName` 存成**裸文件名**、文件放在 `images/` 下；
/// 这里仍保留"也认带目录的写法"的兜底——万一以后有人存了完整路径，不至于打不开。
fn resolve_entry_name<R: Read + Seek>(zip: &mut ZipArchive<R>, image_file_name: &str) -> Option<String> {
    let with_dir = format!("{}/{}", IMAGES_DIR, image_file_name);
    if zip.by_name(&with_dir).is_ok() {
        return Some(with_dir);
    }
    if zip.by_name(image_file_name).is_ok() {
        return Some(image_file_name.to_string());
    }
    None
}

fn extract_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    image_file_name: &str,
    extract_dir: &Path,
    cache: &mut HashMap<String, PathBuf>,
    budget: &mut u64,
) -> Result<PathBuf, ProjectError> {
    let entry_name = resolve_entry_name(zip, image_file_name)
        .ok_or_else(|| ProjectError::Invalid(format!("缺少图层文件 {image_file_name}")))?;
    let file_name = safe_entry_name(image_file_name)?;
    if let Some(hit) = cache.get(&file_name) {
        return Ok(hit.clone());
    }
    let out_path = extract_dir.join(&file_name);

    let mut entry = zip
        .by_name(&entry_name)
        .map_err(|_| ProjectError::Invalid(format!("缺少图层文件 {entry_name}")))?;
    let declared = entry.size();

    // 内容寻址：同名且大小一致 ⇒ 上一份文档已经解过同一份字节，直接复用
    if declared > 0 {
        if let Ok(meta) = fs::metadata(&out_path) {
            if meta.len() == declared {
                cache.insert(file_name, out_path.clone());
                return Ok(out_path);
            }
        }
    }

    if declared > *budget {
        return Err(ProjectError::Invalid(format!(
            "解压总量超限（> {} GiB），已中止",
            MAX_EXTRACTED_BYTES / 1024 / 1024 / 1024
        )));
    }

    let tmp = out_path.with_extension("part");
    let mut out = BufWriter::new(File::create(&tmp)?);
    // 不信任条目头里声明的大小：按实际写入量记账，超出预算就中止
    let mut written = 0u64;
    let mut buf = vec![0u8; COPY_BUFFER];
    loop {
        let n = entry.read(&mut buf)?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > *budget {
            drop(out);
            let _ = fs::remove_file(&tmp);
            return Err(ProjectError::Invalid(format!(
                "解压总量超限（> {} GiB），已中止",
                MAX_EXTRACTED_BYTES / 1024 / 1024 / 1024
            )));
        }
        out.write_all(&buf[..n])?;
    }
    out.into_inner().map_err(|e| ProjectError::Io(e.into_error()))?.sync_all()?;
    replace_file(&tmp, &out_path)?;
    *budget = budget.saturating_sub(written);

    cache.insert(file_name, out_path.clone());
    Ok(out_path)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个独立目录，避免互相踩；不依赖任何外部素材。
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aurora-editor-project-{tag}-{}-{:?}",
            now_millis(),
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_png(dir: &Path, name: &str, w: u32, h: u32, tint: u8) -> PathBuf {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, tint, 255])
        });
        let path = dir.join(name);
        img.save(&path).unwrap();
        path
    }

    fn box_of(x: f64, y: f64, w: f64, h: f64) -> ProjectBox {
        ProjectBox { x, y, w, h, rotation: 90.0, flip_h: true, flip_v: false, skew_x: 0.0, skew_y: 0.0 }
    }

    #[test]
    fn save_then_open_round_trips_geometry_and_adjust() {
        let dir = scratch("roundtrip");
        let a = write_png(&dir, "a.png", 40, 20, 10);
        let b = write_png(&dir, "b.png", 32, 32, 200);
        let target = dir.join("doc.aurora");
        let canvas = ProjectCanvas::new(200, 100, "white");

        let layers = vec![
            SaveLayer {
                id: "l1".into(),
                name: "底图".into(),
                source: a.display().to_string(),
                natural_width: 40,
                natural_height: 20,
                visible: true,
                opacity: 55,
                blend: BlendMode::Normal,
                lock_pixel: false,
                lock_position: false,
                layer_kind: "layer".to_string(),
                group_id: None,
                frame: box_of(1.5, 2.25, 40.0, 20.0),
                adjust: Some(ProjectAdjust { brightness: 12.0, contrast: -8.0, saturation: 30.0, temperature: 5.0 }),
            },
            SaveLayer {
                id: "l2".into(),
                name: "遮挡".into(),
                source: b.display().to_string(),
                natural_width: 32,
                natural_height: 32,
                visible: false,
                opacity: 100,
                blend: BlendMode::Normal,
                lock_pixel: false,
                lock_position: false,
                layer_kind: "layer".to_string(),
                group_id: None,
                frame: ProjectBox::default(),
                adjust: None,
            },
        ];

        let report = save_project(&target, "封面", &canvas, &layers, Some("l2")).unwrap();
        assert_eq!(report.layer_count, 2);
        assert_eq!(report.image_count, 2);
        assert!(report.bytes > 0);

        let opened = open_project(&target, &dir.join("out")).unwrap();
        assert_eq!(opened.name, "封面");
        assert_eq!(opened.source, ProjectSource::Editor);
        assert_eq!(opened.canvas.width, 200);
        assert_eq!(opened.canvas.height, 100);
        assert_eq!(opened.canvas.background, "white");
        assert_eq!(opened.active_layer_id.as_deref(), Some("l2"));
        assert!(opened.warnings.is_empty(), "不该有警告: {:?}", opened.warnings);
        assert_eq!(opened.layers.len(), 2);

        let first = &opened.layers[0];
        assert_eq!(first.id, "l1");
        assert_eq!(first.name, "底图");
        assert_eq!(first.frame, box_of(1.5, 2.25, 40.0, 20.0));
        assert_eq!(first.adjust.unwrap().contrast, -8.0);
        // 不透明度是图层属性，必须原样往返（缺省 100 的走 serde default）
        assert_eq!(first.opacity, 55);
        assert_eq!(opened.layers[1].opacity, 100);
        assert_eq!((first.natural_width, first.natural_height), (40, 20));
        // 解压出的字节必须与源文件**逐字节相同**（原样搬运，不重编码）
        let original = fs::read(&a).unwrap();
        let extracted = fs::read(first.source.as_ref().unwrap()).unwrap();
        assert_eq!(original, extracted);
        assert!(!opened.layers[1].visible);
    }

    #[test]
    fn identical_bytes_are_stored_once() {
        let dir = scratch("dedupe");
        let a = write_png(&dir, "a.png", 16, 16, 3);
        // 同一份内容换个路径（模拟"同一张底图导入两次"）
        let copy = dir.join("copy.png");
        fs::copy(&a, &copy).unwrap();

        let canvas = ProjectCanvas::new(16, 16, "transparent");
        let layer = |id: &str, path: &Path| SaveLayer {
            id: id.into(),
            name: id.into(),
            source: path.display().to_string(),
            natural_width: 16,
            natural_height: 16,
            visible: true,
            opacity: 100,
            blend: BlendMode::Normal,
            lock_pixel: false,
            lock_position: false,
            layer_kind: "layer".to_string(),
            group_id: None,
            frame: ProjectBox::default(),
            adjust: None,
        };
        let layers = vec![layer("l1", &a), layer("l2", &copy)];

        let report = save_project(&dir.join("d.aurora"), "去重", &canvas, &layers, None).unwrap();
        assert_eq!(report.layer_count, 2);
        assert_eq!(report.image_count, 1, "同内容应只存一份");
        assert!(report.deduped_bytes > 0);

        let opened = open_project(&dir.join("d.aurora"), &dir.join("out")).unwrap();
        assert_eq!(opened.layers.len(), 2);
        assert_eq!(
            opened.layers[0].source, opened.layers[1].source,
            "两层应指向同一份解压文件"
        );
    }

    #[test]
    fn empty_document_round_trips() {
        let dir = scratch("empty");
        let target = dir.join("blank.aurora");
        let canvas = ProjectCanvas::new(1920, 1080, "transparent");
        let report = save_project(&target, "未命名-1", &canvas, &[], None).unwrap();
        assert_eq!(report.image_count, 0);

        let opened = open_project(&target, &dir.join("out")).unwrap();
        assert_eq!(opened.layers.len(), 0);
        assert_eq!(opened.canvas.width, 1920);
        assert_eq!(opened.name, "未命名-1");
    }

    #[test]
    fn save_rejects_zero_canvas() {
        let dir = scratch("zerocanvas");
        let err = save_project(
            &dir.join("x.aurora"),
            "x",
            &ProjectCanvas::new(0, 100, "transparent"),
            &[],
            None,
        );
        assert!(matches!(err, Err(ProjectError::Invalid(_))));
    }

    #[test]
    fn open_rejects_zip_without_manifest() {
        let dir = scratch("nomanifest");
        let target = dir.join("bad.aurora");
        {
            let file = File::create(&target).unwrap();
            let mut zip = ZipWriter::new(BufWriter::new(file));
            zip.start_file("readme.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        let err = open_project(&target, &dir.join("out"));
        assert!(matches!(err, Err(ProjectError::Invalid(msg)) if msg.contains("manifest.json")));
    }

    #[test]
    fn safe_entry_name_blocks_zip_slip() {
        assert_eq!(safe_entry_name("images/abc.png").unwrap(), "images_abc.png");
        assert!(safe_entry_name("..").is_err());
        assert!(safe_entry_name("///").is_err());
        // 中文名保留可读部分并挂短哈希（不同中文名不会撞）
        let a = safe_entry_name("images/图层一.png").unwrap();
        let b = safe_entry_name("images/图层二.png").unwrap();
        assert_ne!(a, b);
        assert!(a.ends_with(".png"));
        assert!(!a.contains('/') && !a.contains('\\'));
    }

    #[test]
    fn reference_session_items_are_opened_as_layers() {
        let dir = scratch("reference");
        let png = write_png(&dir, "shot.png", 24, 12, 99);
        let target = dir.join("session.aurora");
        {
            let bytes = fs::read(&png).unwrap();
            let file = File::create(&target).unwrap();
            let mut zip = ZipWriter::new(BufWriter::new(file));
            zip.start_file(MANIFEST_NAME, SimpleFileOptions::default()).unwrap();
            zip.write_all(
                r#"{"version":"2.0","createdAt":1700000000000,"sessionName":"参考会话"}"#.as_bytes(),
            )
            .unwrap();
            zip.start_file(LAYOUT_NAME, SimpleFileOptions::default()).unwrap();
            zip.write_all(
                r#"{"items":[{"id":"i1","path":"C:/x/shot.png","x":10,"y":20,"width":24,"height":12,"rotation":45,"imageFileName":"img_0.png"}],"annotations":[],"zOrder":["i1"]}"#
                    .as_bytes(),
            )
            .unwrap();
            zip.start_file("images/img_0.png", SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
            zip.finish().unwrap();
        }

        let opened = open_project(&target, &dir.join("out")).unwrap();
        assert_eq!(opened.source, ProjectSource::Reference);
        assert_eq!(opened.layers.len(), 1);
        let layer = &opened.layers[0];
        assert_eq!(layer.frame.x, 10.0);
        assert_eq!(layer.frame.rotation, 45.0);
        assert_eq!((layer.natural_width, layer.natural_height), (24, 12));
        // 参考模式不写 canvas ⇒ 按包围盒推：(10+24) × (20+12)
        assert_eq!((opened.canvas.width, opened.canvas.height), (34, 32));
    }

    #[test]
    fn reextract_reuses_existing_files() {        let dir = scratch("reextract");
        let png = write_png(&dir, "a.png", 8, 8, 7);
        let canvas = ProjectCanvas::new(8, 8, "transparent");
        let layers = vec![SaveLayer {
            id: "l1".into(),
            name: "一层".into(),
            source: png.display().to_string(),
            natural_width: 8,
            natural_height: 8,
            visible: true,
            opacity: 100,
            blend: BlendMode::Normal,
            lock_pixel: false,
            lock_position: false,
            layer_kind: "layer".to_string(),
            group_id: None,
            frame: ProjectBox::default(),
            adjust: None,
        }];
        let target = dir.join("r.aurora");
        save_project(&target, "r", &canvas, &layers, None).unwrap();

        let out = dir.join("out");
        let first = open_project(&target, &out).unwrap();
        let stamp = fs::metadata(first.layers[0].source.as_ref().unwrap())
            .unwrap()
            .modified()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = open_project(&target, &out).unwrap();
        let stamp2 = fs::metadata(second.layers[0].source.as_ref().unwrap())
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(first.layers[0].source, second.layers[0].source);
        assert_eq!(stamp, stamp2, "同名同大小应跳过解压，不重写文件");
    }

    #[test]
    fn saving_twice_over_the_same_path_replaces_it() {
        let dir = scratch("resave");
        let png = write_png(&dir, "a.png", 8, 8, 5);
        let target = dir.join("s.aurora");
        let canvas = ProjectCanvas::new(8, 8, "transparent");
        let layers = |w: f64| {
            vec![SaveLayer {
                id: "l1".into(),
                name: "层".into(),
                source: png.display().to_string(),
                natural_width: 8,
                natural_height: 8,
                visible: true,
                opacity: 100,
                blend: BlendMode::Normal,
                lock_pixel: false,
                lock_position: false,
                layer_kind: "layer".to_string(),
                group_id: None,
                frame: box_of(0.0, 0.0, w, w),
                adjust: None,
            }]
        };

        save_project(&target, "v1", &canvas, &layers(8.0), None).unwrap();
        // Windows 上 rename 不覆盖已存在文件，这一步专测 replace_file 的"先删后改名"
        let report = save_project(&target, "v2", &canvas, &layers(6.0), None).unwrap();
        assert!(report.bytes > 0);

        let opened = open_project(&target, &dir.join("out")).unwrap();
        assert_eq!(opened.name, "v2", "第二次保存必须真的覆盖掉第一次");
        assert_eq!(opened.layers[0].frame.w, 6.0);
        // 临时文件不能留在用户目录里
        assert!(!dir.join("s.aurora.tmp").exists());
    }

    /// JSON 键名是**跨语言契约**：前端读 `EditorLayer.box` / `imageFileName`，
    /// Rust 侧因 `box` 是保留字改叫 `frame`，漏一个 `rename` 就是"打开后图层全挤在
    /// 左上角、尺寸 0×0"这种最难查的静默错误（本次实现时当场漏过一次）。
    #[test]
    fn json_keys_match_frontend_contract() {
        let dir = scratch("keys");
        let png = write_png(&dir, "a.png", 4, 4, 1);
        let canvas = ProjectCanvas::new(8, 8, "white");
        let layers = vec![SaveLayer {
            id: "l1".into(),
            name: "层".into(),
            source: png.display().to_string(),
            natural_width: 4,
            natural_height: 4,
            visible: true,
            opacity: 100,
            blend: BlendMode::Normal,
            lock_pixel: false,
            lock_position: false,
            layer_kind: "layer".to_string(),
            group_id: None,
            frame: box_of(1.0, 2.0, 4.0, 4.0),
            adjust: None,
        }];
        let target = dir.join("k.aurora");
        save_project(&target, "k", &canvas, &layers, Some("l1")).unwrap();

        let mut zip = ZipArchive::new(BufReader::new(File::open(&target).unwrap())).unwrap();
        let mut text = String::new();
        zip.by_name(LAYOUT_NAME)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(text.contains("\"box\""), "layout 应写 box 键: {text}");
        assert!(!text.contains("\"frame\""), "不应出现 frame 键: {text}");
        // `imageFileName` 存裸文件名（与参考模式同一约定），ZIP 内部才带 `images/`
        assert!(text.contains("\"imageFileName\": \""));
        assert!(!text.contains("\"images/"), "imageFileName 不该带目录: {text}");

        let opened = open_project(&target, &dir.join("out")).unwrap();
        let json = serde_json::to_string(&opened).unwrap();
        assert!(json.contains("\"box\""), "打开结果应含 box: {json}");
        assert!(!json.contains("\"frame\""), "打开结果不该含 frame: {json}");
    }
}
