/**
 * 媒体扩展名表 —— 前端统一真源
 *
 * ⚠️ 与 `core/src/file_types.rs` 保持同步（视频 P1，设计方案 §2.7 口径 C）：
 * - `SUPPORTED_IMAGE_EXTENSIONS` ↔ Rust `file_types::SUPPORTED_IMAGE_EXTENSIONS`
 * - `SUPPORTED_VIDEO_EXTENSIONS` ↔ Rust `file_types::SUPPORTED_VIDEO_EXTENSIONS`（P1 新增）
 *
 * 改这里必须同时改 Rust 侧，同一条口径现在被四处共用：core 白名单、Rust LAN 的
 * `is_image_file` / `is_video_file`（已改为直接调 core）、以及本文件。Phase 0 之前
 * LAN 侧还各带一份硬编码副本，缺 `jfif`/`ico`/`svg`；`.tif` 也是「白名单不认、
 * MIME 认」挂了很久。两边都已在 2026-10-22 收口。
 *
 * 历史遗留：全仓曾散落六套互不一致的扩展名表（types.ts / ImageThumbnail.tsx /
 * drag.ts / Rust LAN …），导致"某处能进、某处不能"。此处收敛为唯一真源，
 * 前端各处一律引用本模块，不再各自维护扩展名清单。
 */

/** 图片扩展名（与 Rust `file_types::SUPPORTED_EXTENSIONS` 对齐） */
export const SUPPORTED_IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'svg', 'avif', 'jxl',
];

/** 视频扩展名（与 Rust `file_types::SUPPORTED_VIDEO_EXTENSIONS` 对齐，12 种） */
export const SUPPORTED_VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts',
];

export const IMAGE_EXTENSION_SET = new Set(SUPPORTED_IMAGE_EXTENSIONS);
export const VIDEO_EXTENSION_SET = new Set(SUPPORTED_VIDEO_EXTENSIONS);

/** 取路径扩展名（小写、不含点）。无扩展名返回空串 */
export const getLowerExtension = (filePath?: string | null): string => {
  if (!filePath) return '';
  const name = filePath.split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * 是否视频文件。
 * 优先看 mime format（`video/xxx`，LAN 侧下发），否则按扩展名判定。
 */
export const isVideoFile = (filePath?: string | null, format?: string): boolean => {
  if (format && format.startsWith('video/')) return true;
  return VIDEO_EXTENSION_SET.has(getLowerExtension(filePath));
};

/**
 * Chromium / WebView2 原生可解码的容器子集 —— 视频 P1.5-A（前端抽帧）与 P2（播放）的共同边界。
 *
 * **依据（2026-10-16 更正）**：chromium.org/audio-video 的官方容器清单 =
 * `MP4 / Ogg / WebM / WAV / Matroska / HLS` —— **MKV（Matroska）是原生可播的**，
 * 而 **AVI 不在清单里**（Chromium 的 ffmpeg 构建不含 AVI 解复用器）。
 * 指挥官实机佐证：上一会话「MKV 点开直接播放、AVI 播不了」，与本表修正后的结论一致。
 * ⚠️ 旧表把 mkv 列为不可播（源于设计方案 §3.3 的误判，已就地更正），
 *    导致 P2 首版对 MKV 也做了转封装 —— 白占磁盘、白等一次（现已改回直播）。
 *
 * 注意：**容器可解 ≠ 一定播得了** —— MKV 里装 HEVC/VC-1/FLAC 等仍可能失败，
 * 所以播放侧还有一层「直播失败 → 自动转封装」的兜底（ImageViewer）。
 *
 * ⚠️ 不要凭猜改这张表：加容器前先在 WebView 里实际播一遍（或查 chromium.org 清单）。
 */
export const WEB_DECODABLE_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];

/** 其余容器：Chromium 解不了 → 走后端 ffmpeg 抽帧（P1.5-B）/ 转封装（P2） */
export const FFMPEG_ONLY_VIDEO_EXTENSIONS = SUPPORTED_VIDEO_EXTENSIONS.filter(
  (ext) => !WEB_DECODABLE_VIDEO_EXTENSIONS.includes(ext)
);

const WEB_DECODABLE_VIDEO_SET = new Set(WEB_DECODABLE_VIDEO_EXTENSIONS);

/** `video/*` MIME → 扩展名（与 Rust `file_types::mime_for_extension` 对齐） */
const VIDEO_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/x-ms-wmv': 'wmv',
  'video/x-flv': 'flv',
  'video/mpeg': 'mpg',
  'video/3gpp': '3gp',
  'video/mp2t': 'ts',
};

/** 由 `video/*` MIME 反解扩展名；未知返回空串 */
export const videoExtensionFromMime = (format?: string): string =>
  (format && VIDEO_MIME_TO_EXT[format]) || '';

/**
 * 该视频是否可由前端直接用 <video> 解码抽帧（P1.5-A）。
 * 优先扩展名，扩展名缺失时（LAN 下发、`fileMeta.format` 场景）回落到 MIME。
 */
export const isWebDecodableVideo = (filePath?: string | null, format?: string): boolean => {
  const ext = getLowerExtension(filePath);
  if (ext) return WEB_DECODABLE_VIDEO_SET.has(ext);
  return WEB_DECODABLE_VIDEO_SET.has(videoExtensionFromMime(format));
};

/**
 * 格式化视频时长：mm:ss；超过 1 小时用 h:mm:ss。无值返回空串（调用方据此隐藏角标）。
 * 视频 P1（UI 设计 §5.2 网格卡片时长角标）。
 */
export const formatVideoDuration = (durationMs?: number | null): string => {
  if (!durationMs || durationMs <= 0 || !Number.isFinite(durationMs)) return '';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
};

/** 码率格式化（bps → `"4.5 Mbps"` / `"523 kbps"`）。拿不到 / 非法值返回空串（调用方显示 '---'）。 */
export const formatBitRate = (bps?: number | null): string => {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.max(1, Math.round(bps / 1000))} kbps`;
};
