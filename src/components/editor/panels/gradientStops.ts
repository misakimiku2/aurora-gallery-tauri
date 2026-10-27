/**
 * 渐变映射停靠点纯函数(photocraft adjust_editors.rs 1276-1334 移植)。
 * 停靠点 = [location 0..1, "#rrggbb"];映射无透明度,只有颜色停靠点(上游口径)。
 */

export type GradStop = { at: number; color: string };

/** 引擎参数 stops → 停靠点(兼容 [loc,"#hex"];不足两个回退黑白两端)。 */
export function stopsFromParams(v: unknown): GradStop[] {
  const s: GradStop[] = Array.isArray(v)
    ? v
        .map((q): GradStop | null => {
          if (Array.isArray(q) && Number.isFinite(q[0]) && typeof q[1] === 'string') {
            return { at: Math.min(1, Math.max(0, q[0])), color: hexOf(q[1]) };
          }
          return null;
        })
        .filter((q): q is GradStop => q !== null)
    : [];
  return s.length < 2 ? [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] : s;
}

/** 停靠点 → 引擎参数(location round 0.001、按位置排序)。 */
export function stopsToParams(stops: GradStop[]): Array<[number, string]> {
  return [...stops]
    .sort((a, b) => a.at - b.at)
    .map((s) => [Math.round(s.at * 1000) / 1000, s.color] as [number, string]);
}

function hexOf(c: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(c);
  return m ? `#${m[1].toLowerCase()}` : '#000000';
}

/** 位置 `t` 处的渐变插值色(两端外恒值)。 */
export function sampleStops(stops: GradStop[], t: number): string {
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return '#000000';
  if (t <= sorted[0].at) return sorted[0].color;
  for (let i = 1; i < sorted.length; i++) {
    if (t <= sorted[i].at) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const k = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
      return mixHex(a.color, b.color, k);
    }
  }
  return sorted[sorted.length - 1].color;
}

export function mixHex(a: string, b: string, k: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function parseHex(c: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 移动停靠点到 `location`(钳 0..1、round 0.001),保持数组按位置有序,
 * 返回移动后该点的新下标(跨越其他停靠点时选中跟随,含同位停靠点)。
 */
export function moveMapStop(stops: GradStop[], index: number, location: number): number | null {
  const s = stops[index];
  if (!s) return null;
  s.at = Math.round(Math.min(1, Math.max(0, location)) * 1000) / 1000;
  const at = s.at;
  let rank = 0;
  stops.forEach((q, i) => {
    if (i !== index && (q.at < at || (q.at === at && i < index))) rank++;
  });
  stops.sort((a, b) => a.at - b.at);
  return rank;
}

/** 最宽间隙的中点(Add Stop 位置);无间隙取 0.5。 */
export function widestGapMid(stops: GradStop[]): number {
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  let best = 0.5;
  let bestW = -1;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i].at - sorted[i - 1].at;
    if (w > bestW) {
      bestW = w;
      best = (sorted[i - 1].at + sorted[i].at) / 2;
    }
  }
  return best;
}
