/**
 * 渐变预设库(photocraft engine/src/presets/gradients.rs builtin() 移植):10 组 59 个内置预设。
 * stops 支持 "foreground"/"background" 活引用——paint.gradient 提交时原样下发,由引擎按
 * 当前前景/背景色解析(上游同语义,改前景色后下一笔即用新色);透明度以 0..100 的
 * "transparency" 随参数下发,合并数学(apply_opacity 区间加密采样)在引擎内完成。
 * resolve/applyOpacity 的 TS 移植仅供色板预览与渐变映射取色,两处都不是提交路径。
 */

export type PresetStopColor = 'foreground' | 'background' | [number, number, number];

export interface GradientPreset {
  name: string;
  /** 颜色停靠点 (location 0..1, 颜色),按位置有序。 */
  stops: Array<[number, PresetStopColor]>;
  /** 透明度停靠点 (location, opacity 0..1);空 = 不透明。 */
  opacity: Array<[number, number]>;
}

export interface GradientGroup {
  name: string;
  presets: GradientPreset[];
}

/** 默认预设(前景→背景;与引擎 paint.gradient 无 stops 时的缺省一致)。 */
export const DEFAULT_GRADIENT_PRESET = 'Foreground to Background';

/** "#rrggbb" → 0..1 RGB(引擎 hex() 同款;非法输入按 0 处理)。 */
export function hex01(hex: string): [number, number, number] {
  const s = hex.replace(/^#/, '');
  const b = (i: number) => {
    const v = Number.parseInt(s.slice(i, i + 2), 16);
    return Number.isFinite(v) ? v / 255 : 0;
  };
  return [b(0), b(2), b(4)];
}

/** 0..1 RGB → "#rrggbb"(引擎 hex_of 同款)。 */
export function hexOf01(c: [number, number, number]): string {
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[c[0], c[1], c[2]].map((v) => q(v).toString(16).padStart(2, '0')).join('')}`;
}

/** 均匀分布颜色(引擎 GradientPreset::new 同款;位置 = i/(n-1))。 */
export function presetFromColors(name: string, colors: string[]): GradientPreset {
  const n = Math.max(colors.length, 2) - 1;
  return { name, stops: colors.map((c, i) => [i / n, hex01(c)] as [number, PresetStopColor]), opacity: [] };
}

const fam = (prefix: string, sets: string[][]): GradientPreset[] =>
  sets.map((c, i) => presetFromColors(`${prefix} ${String(i + 1).padStart(2, '0')}`, c));

/** 内置预设(数据与上游 builtin() 逐项一致;色值为上游自绘,非 PS 资产)。 */
export const GRADIENT_GROUPS: GradientGroup[] = [
  {
    name: 'Basics',
    presets: [
      { name: DEFAULT_GRADIENT_PRESET, stops: [[0, 'foreground'], [1, 'background']], opacity: [] },
      { name: 'Foreground to Transparent', stops: [[0, 'foreground'], [1, 'foreground']], opacity: [[0, 1], [1, 0]] },
      presetFromColors('Black, White', ['#000000', '#ffffff']),
    ],
  },
  {
    name: 'Blues',
    presets: fam('Blue', [
      ['#0b3d91', '#4fa3e0'],
      ['#1c2a5a', '#3f6fd8', '#a8d4ff'],
      ['#00b4d8', '#03045e'],
      ['#5ec8f2', '#e6f6ff'],
      ['#253b80', '#20b2aa'],
      ['#89c2ff', '#1d4ed8', '#0a1a40'],
    ]),
  },
  {
    name: 'Purples',
    presets: fam('Purple', [
      ['#3c096c', '#c77dff'],
      ['#5a189a', '#e0aaff'],
      ['#240046', '#7b2cbf', '#f3d9ff'],
      ['#9d4edd', '#4361ee'],
      ['#6a0572', '#ab83a1'],
      ['#2d0b59', '#ff6fd8'],
    ]),
  },
  {
    name: 'Pinks',
    presets: fam('Pink', [
      ['#ff4d8d', '#ffd1e1'],
      ['#c9184a', '#ff8fab'],
      ['#ff70a6', '#ffd670'],
      ['#8e2c5a', '#f7a1c4', '#fff0f5'],
      ['#ff5fa2', '#a855f7'],
      ['#ffc2d6', '#ff2e63'],
    ]),
  },
  {
    name: 'Reds',
    presets: fam('Red', [
      ['#7f0000', '#ff3b30'],
      ['#d00000', '#ffba08'],
      ['#370617', '#9d0208', '#f48c06'],
      ['#e5383b', '#f5f3f4'],
      ['#a4161a', '#0b090a'],
      ['#ff595e', '#ffca3a'],
    ]),
  },
  {
    name: 'Oranges',
    presets: fam('Orange', [
      ['#ff6d00', '#ffd60a'],
      ['#e85d04', '#ffba08'],
      ['#9c3d0b', '#ff9e40', '#fff1d6'],
      ['#ff7b00', '#ff0054'],
      ['#fb8500', '#023047'],
      ['#ffb703', '#fb5607'],
    ]),
  },
  {
    name: 'Greens',
    presets: fam('Green', [
      ['#004b23', '#70e000'],
      ['#2d6a4f', '#b7e4c7'],
      ['#1b4332', '#40916c', '#d8f3dc'],
      ['#38b000', '#ccff33'],
      ['#0b6e4f', '#08a0a8'],
      ['#606c38', '#dda15e'],
    ]),
  },
  {
    name: 'Browns',
    presets: fam('Brown', [
      ['#3e2412', '#a47148'],
      ['#6f4518', '#e6ccb2'],
      ['#2b1708', '#7f5539', '#ddb892'],
      ['#8b5e34', '#ffd8a8'],
      ['#582f0e', '#b6ad90'],
      ['#4a3728', '#c08552', '#f3e9dc'],
    ]),
  },
  {
    name: 'Grays',
    presets: fam('Gray', [
      ['#212529', '#f8f9fa'],
      ['#495057', '#dee2e6'],
      ['#000000', '#6c757d', '#ffffff'],
      ['#343a40', '#adb5bd', '#343a40'],
      ['#8d99ae', '#2b2d42'],
      ['#e9ecef', '#ced4da', '#868e96'],
    ]),
  },
  {
    name: 'Rainbows',
    presets: (() => {
      const rainbow = presetFromColors(
        'Rainbow',
        ['#ec1313', '#ec6d13', '#ecc813', '#b6ec13', '#5bec13', '#13ec25', '#13ec80', '#13ecda', '#13a4ec', '#1349ec', '#3713ec', '#9213ec', '#ec13ec'],
      );
      return [
        rainbow,
        presetFromColors(
          'Pastel Rainbow',
          ['#f4afaf', '#f4cbaf', '#f4e8af', '#e2f4af', '#c6f4af', '#aff4b4', '#aff4d1', '#aff4ee', '#afddf4', '#afc0f4', '#baaff4', '#d7aff4', '#f4aff4'],
        ),
        presetFromColors(
          'Neon Rainbow',
          ['#ff0000', '#ff6a00', '#ffd400', '#bfff00', '#55ff00', '#00ff15', '#00ff80', '#00ffea', '#00aaff', '#0040ff', '#2a00ff', '#9500ff', '#ff00ff'],
        ),
        presetFromColors('Oil Slick', ['#0b0f1a', '#1b2a4a', '#0f6f6f', '#1fae8a', '#5ac8a8', '#7a5cff', '#b13bd6', '#e04a8f', '#f2a65a', '#3a2a6b', '#0b0f1a']),
        { name: 'Rainbow Fade', stops: rainbow.stops, opacity: [[0, 0], [0.125, 1], [0.875, 1], [1, 0]] },
      ];
    })(),
  },
];

/** 按名字查预设(选项条/下拉回显用;查不到回 null)。 */
export function findPreset(name: string): GradientPreset | null {
  for (const g of GRADIENT_GROUPS) {
    const p = g.presets.find((q) => q.name === name);
    if (p) return p;
  }
  return null;
}

/** 深拷贝(编辑面板改副本,不动共享预设表;rgb 元组拷贝防别名)。 */
export function clonePreset(p: GradientPreset): GradientPreset {
  return {
    name: p.name,
    stops: p.stops.map(([t, c]) => [t, Array.isArray(c) ? ([...c] as [number, number, number]) : c] as [number, PresetStopColor]),
    opacity: p.opacity.map(([t, a]) => [t, a] as [number, number]),
  };
}

/** 默认当前渐变(前景→背景的独立副本;ToolOptions 初始化用)。 */
export function defaultGradient(): GradientPreset {
  return clonePreset(findPreset(DEFAULT_GRADIENT_PRESET)!);
}

/**
 * 把 (location,·) 停靠点移到 location(钳 0..1、round 0.001、保持数组按位置有序),
 * 返回移动后的新下标(跨位重排选中跟随,同 gradientStops.moveMapStop 口径);原地修改。
 */
export function moveStopAt<T>(stops: Array<[number, T]>, index: number, location: number): number | null {
  const s = stops[index];
  if (!s) return null;
  stops[index] = [Math.round(Math.min(1, Math.max(0, location)) * 1000) / 1000, s[1]];
  const at = stops[index][0];
  let rank = 0;
  stops.forEach((q, i) => {
    if (i !== index && (q[0] < at || (q[0] === at && i < index))) rank++;
  });
  stops.sort((a, b) => a[0] - b[0]);
  return rank;
}

/** 最宽间隙的中点([location,·] 停靠点;少于两点取 0.5)——Add Stop 落位。 */
export function stopGapMid(stops: Array<[number, unknown]>): number {
  if (stops.length < 2) return 0.5;
  const sorted = [...stops].sort((a, b) => a[0] - b[0]);
  let best = 0.5;
  let bestW = -1;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i][0] - sorted[i - 1][0];
    if (w > bestW) {
      bestW = w;
      best = (sorted[i - 1][0] + sorted[i][0]) / 2;
    }
  }
  return Math.round(best * 1000) / 1000;
}

// ---------------------------------------------------------------- 预览用解析(引擎同款数学)

type Rgba = [number, number, number, number];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp4 = (a: Rgba, b: Rgba, t: number): Rgba =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];

/** 分段线性取值(引擎 sample():两端外恒值;t 落在段末含端点)。 */
function sample<T>(stops: Array<[number, T]>, t: number, mix: (a: T, b: T, u: number) => T): T | null {
  const first = stops[0];
  if (!first) return null;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const [t0, a] = stops[i - 1];
    const [t1, b] = stops[i];
    if (t <= t1) {
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return mix(a, b, u);
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * 引擎 apply_opacity 移植:透明度停靠点乘进 alpha;颜色与透明度都在变的区间 4 分加密采样,
 * 分段线性插值经这些加密点与逐像素乘积保持一致(CSS 预览贴同样本点即得同曲线)。
 */
export function applyOpacityStops(cs: Array<[number, Rgba]>, opacity: Array<[number, number]>): Array<[number, Rgba]> {
  const os = opacity.map(([t, a]) => [clamp01(t), clamp01(a)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (os.length === 0 || os.every((o) => Math.abs(o[1] - 1) < 1e-6)) return cs;
  const ts: number[] = [...cs.map((s) => s[0]), ...os.map((s) => s[0]), 0, 1].sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const t of ts) {
    if (uniq.length === 0 || Math.abs(uniq[uniq.length - 1] - t) >= 1e-6) uniq.push(t);
  }
  const samples: number[] = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    for (let k = 0; k < 4; k++) samples.push(uniq[i] + ((uniq[i + 1] - uniq[i]) * k) / 4);
  }
  samples.push(1);
  const scalarMix = (a: number, b: number, u: number) => a + (b - a) * u;
  return samples.map((t) => {
    const c = sample(cs, t, lerp4) ?? [0, 0, 0, 0];
    const o = sample(os, t, scalarMix) ?? 1;
    return [t, [c[0], c[1], c[2], c[3] * o]] as [number, Rgba];
  });
}

/** 预设 → RGBA 停靠点(引擎 resolve():活引用按当前前景/背景解析,alpha 先置 1 再乘透明度)。 */
export function resolvePreset(
  p: GradientPreset,
  fg: number[] | undefined | null,
  bg: number[] | undefined | null,
): Array<[number, Rgba]> {
  const rgb01 = (a: number[] | undefined | null): Rgba => [a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0, 1];
  const of = (c: PresetStopColor): Rgba => {
    if (c === 'foreground') return rgb01(fg);
    if (c === 'background') return rgb01(bg);
    return [c[0], c[1], c[2], 1];
  };
  const cs = p.stops.map(([t, c]) => [clamp01(t), of(c)] as [number, Rgba]).sort((a, b) => a[0] - b[0]);
  if (cs.length === 0) return applyOpacityStops([[0, rgb01(fg)], [1, rgb01(bg)]], p.opacity);
  return applyOpacityStops(cs, p.opacity);
}

/** 预设 → 提交参数(引擎 from_params/to_json 同构):活引用原样下发,透明度转 0..100。 */
export function presetPaintParams(p: GradientPreset): {
  stops: Array<[number, string]>;
  transparency?: Array<[number, number]>;
} {
  const color = (c: PresetStopColor): string =>
    c === 'foreground' || c === 'background' ? c : hexOf01(c);
  const stops = p.stops.map(([t, c]) => [Math.round(clamp01(t) * 1000) / 1000, color(c)] as [number, string]);
  if (p.opacity.length === 0) return { stops };
  const transparency = p.opacity.map(([t, a]) => [Math.round(clamp01(t) * 1000) / 1000, Math.round(clamp01(a) * 100)] as [number, number]);
  return { stops, transparency };
}

/**
 * 渐变映射用停靠点:活引用解析为当前前景/背景 hex,alpha 丢弃(上游 adjust_editors 同口径:
 * 映射无透明度;透明度只影响 alpha 不影响 RGB 插值,原始颜色停靠点即完整 RGB 曲线)。
 */
export function presetMapStops(
  p: GradientPreset,
  fg: number[] | undefined | null,
  bg: number[] | undefined | null,
): Array<{ at: number; color: string }> {
  const of = (c: PresetStopColor): string => {
    if (c === 'foreground') return hexOf01([fg?.[0] ?? 0, fg?.[1] ?? 0, fg?.[2] ?? 0]);
    if (c === 'background') return hexOf01([bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0]);
    return hexOf01(c);
  };
  return p.stops
    .map(([t, c]) => ({ at: Math.round(clamp01(t) * 1000) / 1000, color: of(c) }))
    .sort((a, b) => a.at - b.at);
}

/** 预设解析后在 t 处的 RGBA(活引用已解析、透明度已乘进 alpha)——编辑面板取色/取 alpha 用。 */
export function sampleResolved(
  p: GradientPreset,
  fg: number[] | undefined | null,
  bg: number[] | undefined | null,
  t: number,
): [number, number, number, number] {
  return sample(resolvePreset(p, fg, bg), clamp01(t), lerp4) ?? [0, 0, 0, 1];
}

/** 预设 → CSS linear-gradient(加密采样点直接当停靠点,分段线性与引擎采样曲线一致)。 */
export function presetCss(p: GradientPreset, fg: number[] | undefined | null, bg: number[] | undefined | null): string {
  const parts = resolvePreset(p, fg, bg).map(([t, c]) => {
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    return `rgba(${q(c[0])}, ${q(c[1])}, ${q(c[2])}, ${Math.min(1, Math.max(0, c[3])).toFixed(4)}) ${(t * 100).toFixed(3)}%`;
  });
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
