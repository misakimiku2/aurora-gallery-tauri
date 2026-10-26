/**
 * 调整层元数据(photocraft 引擎 adjust.rs/adjust_params.rs 口径,照上游移植别自创):
 * 16 种 kind(上游 panels.rs adjustments_grid 顺序)、PS 中文版标签、
 * 照片滤镜 20 预设(引擎 PHOTO_FILTERS)、颜色查找 8 内置(引擎 cms lutfile BUILTIN)、
 * 参数补丁的纯函数合并(引擎 layer.setAdjustment 是给出键合并、不给的重置/保留)。
 */

/** 调整层 kind 清单(顺序=上游 adjustments_grid;图标在组件里映射 lucide)。 */
export const ADJUSTMENT_KINDS: { kind: string; label: string }[] = [
  { kind: 'brightnessContrast', label: '亮度/对比度' },
  { kind: 'levels', label: '色阶' },
  { kind: 'curves', label: '曲线' },
  { kind: 'exposure', label: '曝光度' },
  { kind: 'vibrance', label: '自然饱和度' },
  { kind: 'hueSaturation', label: '色相/饱和度' },
  { kind: 'colorBalance', label: '色彩平衡' },
  { kind: 'blackWhite', label: '黑白' },
  { kind: 'photoFilter', label: '照片滤镜' },
  { kind: 'channelMixer', label: '通道混合器' },
  { kind: 'invert', label: '反相' },
  { kind: 'posterize', label: '色调分离' },
  { kind: 'threshold', label: '阈值' },
  { kind: 'gradientMap', label: '渐变映射' },
  { kind: 'selectiveColor', label: '可选颜色' },
  { kind: 'colorLookup', label: '颜色查找' },
];

/** kind → 中文标签(属性面板标题等)。 */
export const ADJUST_LABEL_ZH: Record<string, string> = Object.fromEntries(
  ADJUSTMENT_KINDS.map((k) => [k.kind, k.label]),
);

/** 本切片有参数编辑器的 kind;levels/curves/gradientMap(直方图/曲线点/渐变停靠点)下一切片。 */
export const EDITOR_READY_KINDS: ReadonlySet<string> = new Set([
  'brightnessContrast', 'exposure', 'vibrance', 'hueSaturation', 'colorBalance', 'blackWhite',
  'photoFilter', 'channelMixer', 'invert', 'posterize', 'threshold', 'selectiveColor', 'colorLookup',
]);

/** 色相/饱和度 六色范围(引擎 HUE_RANGES)。 */
export const HUE_RANGES: { key: string; label: string }[] = [
  { key: 'reds', label: '红色' },
  { key: 'yellows', label: '黄色' },
  { key: 'greens', label: '绿色' },
  { key: 'cyans', label: '青色' },
  { key: 'blues', label: '蓝色' },
  { key: 'magentas', label: '洋红' },
];

/** 可选颜色 9 范围(引擎 adjust_cmds RANGES)。 */
export const SELECTIVE_RANGES: { key: string; label: string }[] = [
  { key: 'reds', label: '红色' },
  { key: 'yellows', label: '黄色' },
  { key: 'greens', label: '绿色' },
  { key: 'cyans', label: '青色' },
  { key: 'blues', label: '蓝色' },
  { key: 'magentas', label: '洋红' },
  { key: 'whites', label: '白色' },
  { key: 'neutrals', label: '中性色' },
  { key: 'blacks', label: '黑色' },
];

/** 黑白默认权重(引擎 BW_DEFAULTS)。 */
export const BW_DEFAULTS = [40, 60, 40, 60, 20, 80];

/** 照片滤镜预设(引擎 PHOTO_FILTERS:id, PS 中文名, 颜色)。 */
export const PHOTO_FILTERS: { id: string; label: string; color: string }[] = [
  { id: 'warming85', label: '加温滤镜 (85)', color: '#ec8a00' },
  { id: 'warmingLBA', label: '加温滤镜 (LBA)', color: '#fa9600' },
  { id: 'warming81', label: '加温滤镜 (81)', color: '#ebb113' },
  { id: 'cooling80', label: '冷却滤镜 (80)', color: '#006dff' },
  { id: 'coolingLBB', label: '冷却滤镜 (LBB)', color: '#005dff' },
  { id: 'cooling82', label: '冷却滤镜 (82)', color: '#00b5ff' },
  { id: 'red', label: '红', color: '#ea1a1a' },
  { id: 'orange', label: '橙', color: '#f38417' },
  { id: 'yellow', label: '黄', color: '#f9e31c' },
  { id: 'green', label: '绿', color: '#19c919' },
  { id: 'cyan', label: '青', color: '#1dcbea' },
  { id: 'blue', label: '蓝', color: '#1d35ea' },
  { id: 'violet', label: '紫', color: '#9b1dea' },
  { id: 'magenta', label: '洋红', color: '#e318e3' },
  { id: 'sepia', label: '深褐', color: '#ac7a33' },
  { id: 'deepRed', label: '深红', color: '#ff0000' },
  { id: 'deepBlue', label: '深蓝', color: '#0022cd' },
  { id: 'deepEmerald', label: '深绿宝石', color: '#008c00' },
  { id: 'deepYellow', label: '深黄', color: '#ffd500' },
  { id: 'underwater', label: '水下', color: '#00c2b1' },
];

/** 当前颜色匹配的照片滤镜预设 id(照片滤镜下拉的回显;自定义颜色则无)。 */
export function photoFilterPresetFor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  return PHOTO_FILTERS.find((f) => f.color.toLowerCase() === color.toLowerCase())?.id ?? null;
}

/** 颜色查找内置 LUT(引擎 cms lutfile BUILTIN)。 */
export const COLOR_LOOKUP_BUILTINS: { id: string; label: string }[] = [
  { id: 'warm', label: '暖调滤镜' },
  { id: 'cool', label: '冷调滤镜' },
  { id: 'tealOrange', label: '青橙对比' },
  { id: 'bleachBypass', label: '漂白旁路' },
  { id: 'fadedFilm', label: '褪色胶片' },
  { id: 'dayForNight', label: '日景转夜景' },
  { id: 'monoContrast', label: '黑白高对比' },
  { id: 'crossProcess', label: '交叉冲印' },
];

/**
 * 参数补丁合并(纯函数):引擎 layer.setAdjustment 对给出的键做合并(嵌套范围对象
 * 也是整个键替换),这里在前端把"改数组某一位/范围某字段"展开成引擎接受的整键替换,
 * 并本地预演合并结果供控件回显。patch 键只能是顶层 kind 参数键。
 */
export function applyAdjustPatch(
  params: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...params, ...patch };
}

/** 改数组参数的某一位(如 colorBalance 的 midtones[1]):返回替换后的完整数组。 */
export function withArrayIndex(arr: unknown, index: number, value: number): number[] {
  const base = Array.isArray(arr) ? arr.map((v) => (typeof v === 'number' ? v : 0)) : [0, 0, 0, 0].slice(0, Math.max(index + 1, 3));
  const next = [...base];
  next[index] = value;
  return next;
}

/** 改色相/饱和度范围对象的一个字段(引擎该键整体替换,必须带全量)。 */
export function withRangeField(
  range: unknown,
  field: 'hue' | 'saturation' | 'lightness',
  value: number,
): Record<string, unknown> {
  const base = (range && typeof range === 'object' ? range : {}) as Record<string, unknown>;
  return {
    hue: typeof base.hue === 'number' ? base.hue : 0,
    saturation: typeof base.saturation === 'number' ? base.saturation : 0,
    lightness: typeof base.lightness === 'number' ? base.lightness : 0,
    ...(Array.isArray(base.range) ? { range: base.range } : {}),
    [field]: value,
  };
}

/** 数值参数读取(缺省给 fallback;引擎 to_params 总是给数,防御外部数据)。 */
export function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 布尔参数读取。 */
export function bool(params: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}
