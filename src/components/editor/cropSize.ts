/**
 * 裁剪 W × H × 分辨率模式(上游 crates/ui-egui/src/crop_size.rs 移植,#2443 PS 口径):
 * 长度字段带单位("4 in"/"10 cm"/"1024 px";裸数字沿用字段单位,空字段=px),分辨率字段
 * px/in 或 px/cm。画框/调把手期间按 W:H 保持比例;提交(image.crop)把裁剪区重采样到
 * 精确 W×H px 并写入分辨率,一步完成。物理长度按所填分辨率换算,未填用文档自身 ppi。
 * 单测钉死解析/换算/提交参数。
 */

/** `crop_ratio` key of the W x H x Resolution mode. */
export const WHR = 'whr';
/** Dropdown key of Front Image (applied at once, never kept in `crop_ratio`). */
export const FRONT = 'front';
export const PX_PER_IN = 'px/in';
export const PX_PER_CM = 'px/cm';
/** A length/resolution field's number cap (well past any canvas or ppi limit). */
const MAX_FIELD = 1e9;

/** 上游 PRESETS:Photoshop 内置尺寸预设(key, label, W, H, 分辨率 px/in)。 */
export const WHR_PRESETS = [
  { key: 'preset:4x5in', label: '4 x 5 in 300 ppi', w: '4 in', h: '5 in', res: '300' },
  { key: 'preset:8.5x11in', label: '8.5 x 11 in 300 ppi', w: '8.5 in', h: '11 in', res: '300' },
  { key: 'preset:1024x768px', label: '1024 x 768 px 92 ppi', w: '1024 px', h: '768 px', res: '92' },
  { key: 'preset:1280x800px', label: '1280 x 800 px 113 ppi', w: '1280 px', h: '800 px', res: '113' },
  { key: 'preset:1366x768px', label: '1366 x 768 px 135 ppi', w: '1366 px', h: '768 px', res: '135' },
  { key: 'preset:4x6in', label: '4 x 6 in 300 ppi', w: '4 in', h: '6 in', res: '300' },
  { key: 'preset:5x7in', label: '5 x 7 in 300 ppi', w: '5 in', h: '7 in', res: '300' },
  { key: 'preset:8x10in', label: '8 x 10 in 300 ppi', w: '8 in', h: '10 in', res: '300' },
] as const;

/** W×H 模式的比例 key:模式本体或某个尺寸预设。 */
export function isWhrKey(key: string): boolean {
  return key === WHR || key.startsWith('preset:');
}

type Unit = 'px' | 'in' | 'cm' | 'mm';

/** 长度单位换算 px(v, ppi;上游 Unit::to_px 的 px/in/cm/mm 子集)。 */
function toPx(v: number, u: Unit, dpi: number): number {
  if (u === 'px') return v;
  if (u === 'in') return v * dpi;
  if (u === 'cm') return (v / 2.54) * dpi;
  return (v / 25.4) * dpi;
}

/** 长度单位后缀解析("in"/"inches"/"cm"/"mm"/"px"/空);无后缀回退 fallback。 */
function unitOf(suffix: string, fallback: Unit): Unit | null {
  const s = suffix.trim().toLowerCase().replace(/^"|"/g, '');
  if (s === '') return fallback;
  if (s === 'px' || s === 'pixel' || s === 'pixels') return 'px';
  if (s === 'in' || s === 'inch' || s === 'inches') return 'in';
  if (s === 'cm' || s === 'centimeter' || s === 'centimeters') return 'cm';
  if (s === 'mm' || s === 'millimeter' || s === 'millimeters') return 'mm';
  return null;
}

/** 数值解析:"10,5"→10.5(上游 parse_num 的逗号口径);其余交给 Number。 */
function parseNum(text: string): number | null {
  const v = Number(text.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

/** A typed length: a positive number and an optional unit ("4 in", "4in", "10,5 cm", "1024").
 * A bare number takes `fallback`. `null` for anything else (empty, zero, negative, unknown unit). */
export function parseLength(text: string, fallback: Unit): { v: number; unit: Unit } | null {
  const t = text.trim();
  if (t === '' || t.length > 64) return null;
  const split = [...t].findIndex((c) => /[a-zA-Z"]/.test(c));
  const num = (split === -1 ? t : t.slice(0, split)).trim();
  const suffix = split === -1 ? '' : t.slice(split).trim();
  const v = parseNum(num);
  if (v == null) return null;
  const unit = unitOf(suffix, fallback);
  if (unit == null) return null;
  return v > 0 && v <= MAX_FIELD ? { v, unit } : null;
}

/** The unit a stored field value is in (pixels when it has none). */
function fieldUnit(stored: string): Unit {
  return parseLength(stored, 'px')?.unit ?? 'px';
}

/** "4 in", "1024 px": the number (up to its unit's decimals) and the unit. */
export function formatLength(v: number, unit: Unit): string {
  const decimals = unit === 'in' ? 2 : unit === 'px' ? 0 : 3;
  let n = v.toFixed(Math.max(decimals, 2));
  if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '');
  return `${n} ${unit}`;
}

/** What a length field keeps once typed: the normalised length, empty for an empty field, and
 * the previous value for something that isn't a length. */
export function normalizeLength(typed: string, previous: string): string {
  if (typed.trim() === '') return '';
  const p = parseLength(typed, fieldUnit(previous));
  if (!p) return previous;
  const text = formatLength(p.v, p.unit);
  return parseLength(text, p.unit) ? text : previous;
}

/** What the resolution field keeps once typed: a positive number, empty, or the previous value. */
export function normalizeResolution(typed: string, previous: string): string {
  if (typed.trim() === '') return '';
  const v = parseNum(typed.trim());
  if (v == null || v <= 0 || v > MAX_FIELD) return previous;
  return String(Math.round(v * 100) / 100);
}

/** W×H 模式的字段集合(ToolOptions 的裁剪相关键子集)。 */
export interface WhrFields {
  cropRatio: string;
  cropWidth: string;
  cropHeight: string;
  cropResolution: string;
  cropResolutionUnit: string;
}

/** The resolution field in pixels per inch, `null` when empty or not a positive number. */
export function resolutionPpi(o: Pick<WhrFields, 'cropResolution' | 'cropResolutionUnit'>): number | null {
  const v = parseNum(o.cropResolution.trim());
  if (v == null || v <= 0 || v > MAX_FIELD) return null;
  return o.cropResolutionUnit === PX_PER_CM ? v * 2.54 : v;
}

/** W x H x Resolution's target: the size in px the crop is resampled to (unrounded) and the
 * resolution it sets, when the mode is on and both W and H hold lengths. Physical lengths convert
 * at the typed resolution, or at `docDpi` when there is none. */
export function whrTarget(o: WhrFields, docDpi: number): { w: number; h: number; res: number | null } | null {
  if (o.cropRatio !== WHR) return null;
  const res = resolutionPpi(o);
  const dpi = res ?? docDpi;
  const w = parseLength(o.cropWidth, 'px');
  const h = parseLength(o.cropHeight, 'px');
  if (!w || !h) return null;
  const pxW = toPx(w.v, w.unit, dpi);
  const pxH = toPx(h.v, h.unit, dpi);
  if (!(pxW > 0 && Number.isFinite(pxW)) || !(pxH > 0 && Number.isFinite(pxH))) return null;
  return { w: pxW, h: pxH, res };
}

/** The ratio W x H x Resolution holds while the frame is drawn or resized (width / height). */
export function whrRatio(o: WhrFields, docDpi: number): number | null {
  const t = whrTarget(o, docDpi);
  if (!t) return null;
  const k = t.w / t.h;
  return Number.isFinite(k) && k > 0 ? k : null;
}

/** `image.crop` 的 target 提交参数:W/H 全填=round 后的 targetWidth/targetHeight;
 * 分辨率非空=resolution(单独填分辨率也生效:仅改文档 ppi,不重采样)。 */
export function whrCommitParams(o: WhrFields, docDpi: number): { targetWidth?: number; targetHeight?: number; resolution?: number } {
  const out: { targetWidth?: number; targetHeight?: number; resolution?: number } = {};
  const t = whrTarget(o, docDpi);
  if (t) {
    out.targetWidth = Math.max(1, Math.round(t.w));
    out.targetHeight = Math.max(1, Math.round(t.h));
  }
  const res = resolutionPpi(o);
  if (res != null) out.resolution = Math.round(res * 100) / 100;
  return out;
}

/** 尺寸预设的 W/H/res 字段值(选项条点击预设时回填)。 */
export function whrPresetFields(key: string): { w: string; h: string; res: string } | null {
  return WHR_PRESETS.find((p) => p.key === key) ?? null;
}
