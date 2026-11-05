/**
 * 导出为对话框纯函数(上游 crates/ui-egui/src/export_dialog.rs 的 TS 移植):
 * 尺寸数学(resize_from_scale/resize_from_side/export_pixels)、记忆值校验
 * (valid_setting,记忆种子与越界防线共用同一真值表)、字节人性化。
 * 桥层(editor/src/export_dialog.rs)持有同款 Rust 实现——标签写的就是要导出的
 * 真实尺寸,两侧公式逐行对齐,单测钉死。
 */

/** 上游 FORMATS(export_preset_cmds)。 */
export const EXPORT_FORMATS = ['png', 'jpg', 'webp', 'tif', 'tga', 'ico'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 上游 RESAMPLE(export_preset_cmds;PS 中文命名,用户照 PS 心智验收)。 */
export const RESAMPLE_OPTIONS = [
  { value: 'bicubicAutomatic', label: '两次立方(自动)' },
  { value: 'bicubic', label: '两次立方' },
  { value: 'bicubicSmoother', label: '两次立方(较平滑)' },
  { value: 'bicubicSharper', label: '两次立方(较锐利)' },
  { value: 'bilinear', label: '两次线性' },
  { value: 'nearest', label: '邻近(硬边缘)' },
] as const;

export const DEFAULT_RESAMPLE = 'bicubicAutomatic';

/** 上游 MAX_PX(image.imageSize 每边上限)。 */
export const MAX_PX = 300_000;

/** 导出设置(桥层 f 参数的 TS 形态;与上游 ExportPresetSettings 同键名)。 */
export interface ExportSettingsJson {
  format: string;
  quality: number;
  lossless: boolean;
  transparency: boolean;
  metadata: string;
  profile: string;
  embedProfile: boolean;
  tgaBits: string;
  sizing: 'scale' | 'pixels';
  scale: number;
  width: number;
  height: number;
  lockAspect: boolean;
  resample: string;
}

/** 上游 SETTINGS(记忆的 14 键;path/源尺寸/图层不记)。 */
export const EXPORT_SETTING_KEYS = [
  'format', 'quality', 'lossless', 'transparency', 'scale', 'resample', 'metadata', 'tgaBits',
  'sizing', 'width', 'height', 'lockAspect', 'profile', 'embedProfile',
] as const;

/** 上游 valid_setting:记忆种子的唯一真值表(手改的偏好文件非法值回落默认)。 */
export function validSetting(key: string, v: unknown): boolean {
  const num = (lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const oneOf = (options: string[]) => typeof v === 'string' && options.includes(v);
  switch (key) {
    case 'format':
      return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
    case 'quality':
      return num(1, 100);
    case 'scale':
      return num(1, 1000);
    case 'width':
    case 'height':
      return num(1, MAX_PX);
    case 'lossless':
    case 'transparency':
    case 'lockAspect':
    case 'embedProfile':
      return typeof v === 'boolean';
    case 'resample':
      return typeof v === 'string' && RESAMPLE_OPTIONS.some((r) => r.value === v);
    case 'metadata':
      return oneOf(['none', 'exif', 'all']);
    case 'tgaBits':
      return oneOf(['auto', '24', '32']);
    case 'sizing':
      return oneOf(['scale', 'pixels']);
    case 'profile':
      return oneOf(['document', 'srgb']);
    default:
      return false;
  }
}

/** 上游 scaled_size:逐边独立 round,永不低于 1。 */
export function scaledSize(w: number, h: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function finitePx(v: number): number | null {
  if (!Number.isFinite(v) || v < 1 || v > MAX_PX) return null;
  return Math.round(v);
}

/** 编辑 Scale 后的目标尺寸(1..1000;越界返回 null=输入非法)。 */
export function resizeFromScale(srcW: number, srcH: number, scale: number): { width: number; height: number; scale: number } | null {
  if (!Number.isFinite(scale) || scale < 1 || scale > 1000) return null;
  const { width, height } = scaledSize(Math.max(1, srcW), Math.max(1, srcH), scale / 100);
  if (width > MAX_PX || height > MAX_PX) return null;
  return { width, height, scale };
}

/** 编辑 W/H 一侧后的目标尺寸;lock 时另一边按源纵横比(上游 resize_from_side)。 */
export function resizeFromSide(
  srcW: number,
  srcH: number,
  width: number,
  height: number,
  lock: boolean,
  editedWidth: boolean,
): { width: number; height: number; scale: number } | null {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  let w: number | null;
  let h: number | null;
  if (editedWidth) {
    w = finitePx(width);
    if (w == null) return null;
    h = lock ? finitePx((sh * w) / sw) : finitePx(height);
    if (h == null) return null;
    return { width: w, height: h, scale: (w / sw) * 100 };
  }
  h = finitePx(height);
  if (h == null) return null;
  w = lock ? finitePx((sw * h) / sh) : finitePx(width);
  if (w == null) return null;
  return { width: w, height: h, scale: (h / sh) * 100 };
}

/** 上游 export_pixels(标签与导出共用;max_side=预览代理先压长边再 round)。 */
export function exportPixels(
  srcW: number,
  srcH: number,
  f: { sizing: 'scale' | 'pixels'; scale: number; width?: number; height?: number },
  maxSide?: number,
): { w: number; h: number } | null {
  const explicit = f.sizing === 'pixels' && f.width != null && f.height != null ? { w: f.width, h: f.height } : null;
  if (explicit) {
    const w = finitePx(explicit.w);
    const h = finitePx(explicit.h);
    if (w == null || h == null) return null;
    if (maxSide) {
      const long = Math.max(w, h);
      if (long > maxSide && long > 0) {
        const s = maxSide / long;
        const r = scaledSize(w, h, s);
        return { w: r.width, h: r.height };
      }
    }
    return { w, h };
  }
  let scale = f.scale / 100;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (maxSide) {
    const long = Math.max(srcW, srcH) * scale;
    if (long > maxSide) scale *= maxSide / long;
  }
  const r = scaledSize(srcW, srcH, scale);
  return { w: r.width, h: r.height };
}

/** 字节人性化(标签 "{FMT}  ≈ {size}" 的大小段)。 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
