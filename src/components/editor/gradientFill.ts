/**
 * 活动渐变填充图层的信息缓存:选中 kind="Fill" 的图层时经 gradient.fill.get 读回
 * (Solid/Pattern 等非渐变填充会报错 → 视为非渐变),按 docId:layerId:revision 缓存,
 * revision 前移(任何提交/撤销)自然过期。画布 widget 与属性页共用。
 */
import { runCommand } from './editorStore';

export interface GradientFillInfo {
  layer: number;
  style: string;
  angle: number;
  scale: number;
  offset: [number, number];
  reverse: boolean;
  dither: boolean;
  align: boolean;
  from: [number, number];
  to: [number, number];
  stops: Array<[number, string]>;
  transparency: Array<[number, number]>;
  midpoints: number[];
}

interface Cache {
  docId: number;
  layerId: number;
  revision: number;
  fill: GradientFillInfo | null;
}

let cache: Cache | null = null;

/** 同步读缓存(选项条 Live 同步判定用;未命中返回 null,不发起请求)。 */
export function peekGradientFill(docId: number | null, layerId: number | null, revision: number): GradientFillInfo | null {
  return cache && cache.docId === docId && cache.layerId === layerId && cache.revision === revision ? cache.fill : null;
}

/** 拉取活动图层的渐变信息(带缓存;非渐变填充/失败 → null)。 */
export async function fetchGradientFill(tabId: string, docId: number, layerId: number, revision: number): Promise<GradientFillInfo | null> {
  if (cache && cache.docId === docId && cache.layerId === layerId && cache.revision === revision) return cache.fill;
  try {
    const r = (await runCommand(tabId, 'gradient.fill.get', { layer: layerId })) as GradientFillInfo | null;
    cache = { docId, layerId, revision, fill: r ?? null };
  } catch {
    cache = { docId, layerId, revision, fill: null };
  }
  return cache.fill;
}
