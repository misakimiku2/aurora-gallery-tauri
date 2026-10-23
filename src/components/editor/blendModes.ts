/**
 * 图层混合模式（与 Rust `imaging::blend` 同一套名字）。
 *
 * ## 为什么名字用英文 kebab-case
 *
 * 因为 CSS 的 `mix-blend-mode` 正好叫这些名字（`multiply` / `color-dodge`…）。
 * 预览直接把它交给 CSS，导出时原样交给 Rust——**两端不再各翻译一次**，
 * 这是调色那套"公式写两份再靠单测锁死"的对立面：能只写一份就只写一份。
 *
 * ## 只做可分离的 12 档
 *
 * PS 还有色相 / 饱和度 / 颜色 / 明度四档，它们要把像素转到 HSL 再算，
 * 公式是另一套，CSS 虽然也有同名实现，但 Rust 侧得另写，所以先不上。
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion';

export interface BlendModeDef {
  id: BlendMode;
  /** PS 中文界面里的名字 */
  label: string;
}

/** 顺序照 PS 的下拉：从上到下、由"压暗"到"提亮"再到"反差" */
export const BLEND_MODES: BlendModeDef[] = [
  { id: 'normal', label: '正常' },
  { id: 'darken', label: '变暗' },
  { id: 'multiply', label: '正片叠底' },
  { id: 'color-burn', label: '颜色加深' },
  { id: 'lighten', label: '变亮' },
  { id: 'screen', label: '滤色' },
  { id: 'color-dodge', label: '颜色减淡' },
  { id: 'overlay', label: '叠加' },
  { id: 'soft-light', label: '柔光' },
  { id: 'hard-light', label: '强光' },
  { id: 'difference', label: '差值' },
  { id: 'exclusion', label: '排除' },
];

const IDS = new Set(BLEND_MODES.map(m => m.id));

/** 脏数据/旧工程里的未知名字一律落 `normal`（与 Rust 的 `BlendMode::parse` 同口径）。 */
export function normalizeBlendMode(raw: unknown): BlendMode {
  return typeof raw === 'string' && IDS.has(raw as BlendMode) ? (raw as BlendMode) : 'normal';
}

/** 面板下拉上显示的名字。 */
export function blendModeLabel(mode: BlendMode): string {
  return BLEND_MODES.find(m => m.id === mode)?.label ?? '正常';
}
