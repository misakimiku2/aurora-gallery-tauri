/**
 * 色阶编辑器几何/自动计算(photocraft adjust_editors.rs 668-697 移植)。
 * 电平一律 0..255;gamma 0.01..9.99。
 */

/** gamma 手柄位置:映射到 50% 灰的输入电平。 */
export function gammaPos(black: number, white: number, gamma: number): number {
  return black + (white - black) * Math.pow(0.5, gamma);
}

/** 由手柄 x 位置反解 gamma(钳 0.01..9.99)。 */
export function gammaFromPos(black: number, white: number, x: number): number {
  const t = Math.min(0.99, Math.max(0.01, (x - black) / Math.max(1, white - black)));
  return Math.min(9.99, Math.max(0.01, Math.log(t) / Math.log(0.5)));
}

/** Photoshop Auto:两端各裁 0.1% 的黑白场;空直方图回 (253, 255)。 */
export function autoLevels(h: ArrayLike<number>): [number, number] {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[i] ?? 0;
  const clip = Math.floor(total / 1000);
  let acc = 0;
  let lo = 0;
  while (lo < 253 && acc + (h[lo] ?? 0) <= clip) {
    acc += h[lo] ?? 0;
    lo++;
  }
  acc = 0;
  let hi = 255;
  while (hi > lo + 2 && acc + (h[hi] ?? 0) <= clip) {
    acc += h[hi] ?? 0;
    hi--;
  }
  return [lo, hi];
}

/** 候选手柄中离 `x` 最近者的下标(上游"按最近者抓取",非命中半径)。 */
export function nearestHandle(xs: number[], x: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  xs.forEach((v, i) => {
    const d = Math.abs(v - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** 色阶通道参数读取(复合键平铺/单通道键嵌套对象,上游 read_levels)。 */
export function readLevels(v: Record<string, unknown>, key: string): [number, number, number, number, number] {
  const o = key === '' ? v : (v[key] as Record<string, unknown> | undefined);
  const g = (k: string, d: number) => {
    const x = o?.[k];
    return typeof x === 'number' && Number.isFinite(x) ? x : d;
  };
  return [g('inBlack', 0), g('gamma', 1), g('inWhite', 255), g('outBlack', 0), g('outWhite', 255)];
}

/** 色阶通道参数写出:复合平铺 5 键,单通道整键替换嵌套对象(上游 write_levels;电平取整、gamma 2 位)。 */
export function writeLevels(params: Record<string, unknown>, key: string, l: readonly number[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    inBlack: Math.round(l[0]),
    gamma: Math.round(l[1] * 100) / 100,
    inWhite: Math.round(l[2]),
    outBlack: Math.round(l[3]),
    outWhite: Math.round(l[4]),
  };
  if (key === '') return { ...params, ...obj };
  return { ...params, [key]: obj };
}

/** 通道色(levels/curves 的直方图、手柄、渐变条;上游 tone.rs channel_color)。 */
export function channelColor(key: string): string {
  switch (key) {
    case 'red': return 'rgb(235,80,80)';
    case 'green': return 'rgb(80,205,95)';
    case 'blue': return 'rgb(90,140,255)';
    default: return ''; // 复合由调用方按主题给灰
  }
}
