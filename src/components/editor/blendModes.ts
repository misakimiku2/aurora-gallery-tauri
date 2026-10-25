/**
 * 图层混合模式（与 Rust `imaging::blend` 同一套名字）。
 *
 * ## 为什么名字用英文 kebab-case
 *
 * 因为 CSS 的 `mix-blend-mode` 正好叫这些名字（`multiply` / `color-dodge`…）。
 * 预览直接把它交给 CSS，导出时原样交给 Rust——**两端不再各翻译一次**，
 * 这是调色那套"公式写两份再靠单测锁死"的对立面：能只写一份就只写一份。
 *
 * ## 16 档（2026-10-26 二轮补齐非可分离四档）
 *
 * 色相 / 饱和度 / 颜色 / 明度是非可分离的（RGB 整组运算），Rust 导出侧的公式照
 * **PhotoCraft `photocraft-color`**（MIT OR Apache-2.0，PS 口径的 Rust 复刻）移植，
 * 与 CSS `mix-blend-mode` 用同一套 W3C 公式——预览端依旧零成本（CSS 原生支持），
 * 两端一致性依旧靠"同一份字符串 + 两份单测锁"。
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
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

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
  // 非可分离四档在 PS 下拉的最末尾
  { id: 'hue', label: '色相' },
  { id: 'saturation', label: '饱和度' },
  { id: 'color', label: '颜色' },
  { id: 'luminosity', label: '明度' },
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
