/**
 * 媒体扩展名表 —— 前端统一真源
 *
 * ⚠️ 与 `core/src/file_types.rs` 保持同步（视频 P1，设计方案 §2.7 口径 C）：
 * - `SUPPORTED_IMAGE_EXTENSIONS` ↔ Rust `file_types::SUPPORTED_EXTENSIONS`
 * - `SUPPORTED_VIDEO_EXTENSIONS` ↔ Rust `file_types::SUPPORTED_VIDEO_EXTENSIONS`（P1 新增）
 *
 * 历史遗留：全仓曾散落六套互不一致的扩展名表（types.ts / ImageThumbnail.tsx /
 * drag.ts / Rust LAN …），导致"某处能进、某处不能"。此处收敛为唯一真源，
 * 前端各处一律引用本模块，不再各自维护扩展名清单。
 */

/** 图片扩展名（与 Rust `file_types::SUPPORTED_EXTENSIONS` 对齐） */
export const SUPPORTED_IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'avif', 'jxl',
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
