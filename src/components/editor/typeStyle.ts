/**
 * 文字样式纯逻辑(二期 二-7,上游 type_tool.rs 字符面板/选项条 移植)。
 * 读(type.info runs[].style)与写(type.setStyle 参数)键名不同:读回是 Rust 字段名
 * (size_pt/leading_pt/faux_bold…),写入是 camelCase 键(size/tracking/fauxBold…)。
 * 尺寸按层变换缩放显示(PS 口径:12pt 层放大 200% 显示 24pt,编辑发 metricsAsShown)。
 */

/** type.info runs[].style 的读回形态(Rust serde 字段名;Color 是引擎结构体对象)。 */
export interface CharStyleJson {
  font_family: string;
  font_style: string;
  postscript_name?: string | null;
  weight: number;
  italic: boolean;
  size_pt: number;
  color: { mode?: string; c: number[]; alpha: number };
  tracking: number;
  leading_pt: number | null;
  baseline_shift_pt: number;
  horizontal_scale: number;
  vertical_scale: number;
  underline: boolean;
  strikethrough: boolean;
  faux_bold: boolean;
  faux_italic: boolean;
  kerning: string;
  kern: number;
  caps: string;
  baseline: string;
  ligatures: boolean;
  discretionary_ligatures: boolean;
}

/** type.info paragraphs[].style 的读回形态。 */
export interface ParaStyleJson {
  align: string;
  first_line_indent_pt: number;
  start_indent_pt: number;
  end_indent_pt: number;
  space_before_pt: number;
  space_after_pt: number;
  auto_leading: number;
  direction: string;
  hyphenate: boolean;
}

/** type.fonts {family} 返回的 face。 */
export interface FaceInfoJson {
  family: string;
  style: string;
  postscriptName: string;
  weight: number;
  italic: boolean;
  /** 变量轴 [tag, min, default, max]。 */
  axes: [string, number, number, number][];
}

// -------------------------------------------------------------------------------------------
// 字重/样式名(上游 weight_name/style_names/style_label)
// -------------------------------------------------------------------------------------------

/** 数字字重段位名(上游 weight_name)。 */
export function weightName(w: number): string {
  const r = Math.round(w);
  if (r <= 150) return 'Thin';
  if (r <= 250) return 'ExtraLight';
  if (r <= 350) return 'Light';
  if (r <= 450) return 'Regular';
  if (r <= 550) return 'Medium';
  if (r <= 650) return 'SemiBold';
  if (r <= 750) return 'Bold';
  if (r <= 850) return 'ExtraBold';
  return 'Black';
}

/** 样式名:某族 faces 的实际 OpenType 子名+变量轴 wght 覆盖的标准权重,轻→重去重(上游 style_names)。 */
export function styleNames(faces: FaceInfoJson[]): string[] {
  const label = (weight: number, italic: boolean): [number, boolean, string] => {
    const w = weightName(weight);
    const name = w === 'Regular' && italic ? 'Italic' : italic ? `${w} Italic` : w;
    return [Math.round(weight), italic, name];
  };
  const v: [number, boolean, string][] = faces.map((f) => [Math.round(f.weight), f.italic, f.style]);
  for (const f of faces) {
    const axis = f.axes.find((a) => a[0] === 'wght');
    if (axis) {
      for (let w = 100; w <= 900; w += 100) {
        if (w >= axis[1] && w <= axis[3]) v.push(label(w, f.italic));
      }
    }
  }
  v.sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]));
  const names: string[] = [];
  for (const [, , name] of v) {
    if (!names.includes(name)) names.push(name);
  }
  return names.length ? names : ['Regular'];
}

/** 下拉标签(本地化;词按空格分词映射,未知词原样——上游 style_label 的 fontWeight 语境)。 */
const STYLE_WORD_ZH: Record<string, string> = {
  Thin: '极细', ExtraLight: '特细', Light: '细体', Regular: '常规', Medium: '中等',
  SemiBold: '半粗体', Bold: '粗体', ExtraBold: '特粗', Black: '黑体', Italic: '斜体',
  DemiBold: '半粗体', Heavy: '黑体', Condensed: '窄体', Extended: '宽体', Oblique: '斜体',
};

export function styleLabel(style: string): string {
  return style.split(' ').map((w) => STYLE_WORD_ZH[w] ?? w).join(' ');
}

/** 样式回显(上游 selected_style):按 PostScript 名找到实际 face 的子名;否则 font_style 或按斜体。 */
export function selectedStyleName(c: CharStyleJson, faces: FaceInfoJson[]): string {
  if (c.postscript_name) {
    const face = faces.find((f) => f.postscriptName === c.postscript_name);
    if (face) return face.style;
  }
  return c.font_style || (c.italic ? 'Italic' : 'Regular');
}

// -------------------------------------------------------------------------------------------
// 显示值(上游 shown_scale/styles_at/kerning_label/type_unit)
// -------------------------------------------------------------------------------------------

/** 层变换缩放 = sqrt(|det|)(上游 shown_scale);退化回落 1。 */
export function shownScale(transform: number[] | undefined): number {
  if (!transform || transform.length < 4) return 1;
  const k = Math.sqrt(Math.abs(transform[0] * transform[3] - transform[1] * transform[2]));
  return Number.isFinite(k) && k > 1e-3 ? k : 1;
}

/**
 * 目标样式:选区起点所在 run 的样式(无选区=首 run;上游 styles_at 的 pick)。
 * `runs` 来自 type.info(字符区间 [start,end) 排升序)。
 */
export function styleAt(runs: { start: number; end: number; style: CharStyleJson }[], at: number): CharStyleJson | null {
  if (!runs.length) return null;
  for (const r of runs) {
    if (at >= r.start && at < r.end) return r.style;
  }
  return runs[runs.length - 1].style;
}

/** 段落样式同款(选区起点所在段落,否则最后一段)。 */
export function paraAt(paras: { start: number; end: number; style: ParaStyleJson }[], at: number): ParaStyleJson | null {
  if (!paras.length) return null;
  for (const p of paras) {
    if (at >= p.start && at < p.end) return p.style;
  }
  return paras[paras.length - 1].style;
}

/** 行高显示值:手动 leading_pt,否则字号 × 自动行距倍数(上游 leading 显示公式)。 */
export function leadingShown(c: CharStyleJson, para: ParaStyleJson | null, scale: number): number {
  return (c.leading_pt ?? c.size_pt * Math.max(para?.auto_leading ?? 1.2, 0.01)) * scale;
}

/** 字距显示:折叠 caret 显示前一对(上游 kerning_at);否则样式里的 kerning。 */
export function kerningAt(
  c: CharStyleJson,
  collapsedCaret: number | null,
  runs: { start: number; end: number; style: CharStyleJson }[],
): { mode: string; kern: number } {
  if (collapsedCaret != null && collapsedCaret > 0) {
    const s = styleAt(runs, collapsedCaret - 1);
    if (s) return { mode: s.kerning, kern: s.kern };
  }
  return { mode: c.kerning, kern: c.kern };
}

/** 字距标签:手动值非 0=数字;Metrics/Optical/Off(上游 kerning_label)。 */
export function kerningLabel({ mode, kern }: { mode: string; kern: number }): string {
  if (kern !== 0 && Number.isFinite(kern)) return String(Math.round(kern));
  if (/^optical$/i.test(mode)) return 'Optical';
  if (/^metrics$/i.test(mode)) return 'Metrics';
  return '0';
}

/** 解析键入的字距:Metrics/Optical(任意大小写)或 -1000..10000 数字;否则 null。 */
export function parseKerning(s: string): string | number | null {
  const t = s.trim();
  const l = t.toLowerCase();
  if (l === 'metrics') return 'metrics';
  if (l === 'optical') return 'optical';
  const n = Number(t);
  if (t !== '' && Number.isFinite(n) && n >= -1000 && n <= 10000) return Math.round(n);
  return null;
}

/** 抗锯齿选项表(引擎 type.antiAlias.* 全量;上游 aa 下拉同序;value=命令键)。 */
export const AA_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'sharp', label: '锐利' },
  { value: 'crisp', label: '明晰' },
  { value: 'strong', label: '浑厚' },
  { value: 'smooth', label: '平滑' },
  { value: 'windowsLcd', label: 'Windows LCD' },
  { value: 'windows', label: 'Windows' },
];

/** 引擎 AntiAlias 枚举名(读回)→ 命令键(写入;上游 aa_name 逆向)。 */
export function aaKey(name: string): string {
  switch (name) {
    case 'None': return 'none';
    case 'Sharp': return 'sharp';
    case 'Crisp': return 'crisp';
    case 'Strong': return 'strong';
    case 'Smooth': return 'smooth';
    case 'WindowsLcd': return 'windowsLcd';
    case 'Windows': return 'windows';
    default: return 'sharp';
  }
}

// -------------------------------------------------------------------------------------------
// 颜色/伪样式/对齐
// -------------------------------------------------------------------------------------------

/** 引擎 Color 读回 → css hex(Rgb 模式取 c[0..3];其余近似按 c 前三分量)。 */
export function styleColorHex(color: CharStyleJson['color']): string {
  const c = color?.c ?? [0, 0, 0];
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[q(c[0]), q(c[1]), q(c[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 对齐七态的标签(选项条三态+字符页签段落区七态;justify 需段落框)。 */
export const ALIGN_ITEMS: { key: string; label: string }[] = [
  { key: 'left', label: '左对齐' },
  { key: 'center', label: '居中对齐' },
  { key: 'right', label: '右对齐' },
  { key: 'justifyLeft', label: '最后一行左对齐' },
  { key: 'justifyCenter', label: '最后一行居中' },
  { key: 'justifyRight', label: '最后一行右对齐' },
  { key: 'justifyAll', label: '全部对齐' },
];

/** 伪样式切换的写参数(上游 toggles 表:开→关/关→开)。 */
export function fauxToggleProps(c: CharStyleJson): { label: string; on: boolean; props: Record<string, unknown> }[] {
  const caps = c.caps;
  return [
    { label: '仿粗体', on: c.faux_bold, props: { fauxBold: !c.faux_bold } },
    { label: '仿斜体', on: c.faux_italic, props: { fauxItalic: !c.faux_italic } },
    { label: '全部大写', on: caps === 'AllCaps', props: { caps: caps === 'AllCaps' ? 'normal' : 'allCaps' } },
    { label: '小型大写', on: caps === 'SmallCaps', props: { caps: caps === 'SmallCaps' ? 'normal' : 'smallCaps' } },
    { label: '下划线', on: c.underline, props: { underline: !c.underline } },
    { label: '删除线', on: c.strikethrough, props: { strikethrough: !c.strikethrough } },
  ];
}

/** 会话中 ⇧⌘ 字符样式切换(上游 CharToggle):K=全部大写 U=下划线 B=仿粗 I=仿斜 /=删除线。 */
export const CHAR_TOGGLE_KEYS: Record<string, { label: string; read: (c: CharStyleJson) => boolean; write: (on: boolean) => Record<string, unknown> }> = {
  k: { label: '全部大写', read: (c) => c.caps === 'AllCaps', write: (on) => ({ caps: on ? 'all' : 'normal' }) },
  u: { label: '下划线', read: (c) => c.underline, write: (on) => ({ underline: on }) },
  b: { label: '仿粗体', read: (c) => c.faux_bold, write: (on) => ({ fauxBold: on }) },
  i: { label: '仿斜体', read: (c) => c.faux_italic, write: (on) => ({ fauxItalic: on }) },
  '/': { label: '删除线', read: (c) => c.strikethrough, write: (on) => ({ strikethrough: on }) },
};

/** 变量轴滑杆轴集:与样式斜体匹配的 face 的轴(缺=任意 face),去重(上游 slider_axes)。 */
export function sliderAxes(faces: FaceInfoJson[], italic: boolean): [string, number, number, number][] {
  const pick = (want: boolean | null): [string, number, number, number][] => {
    const out: [string, number, number, number][] = [];
    for (const f of faces) {
      if (want != null && f.italic !== want) continue;
      for (const a of f.axes) {
        if (a[0] === 'opsz' || !Number.isFinite(a[1]) || !Number.isFinite(a[3]) || a[1] >= a[3]) continue;
        if (!out.some((b) => b[0] === a[0])) out.push(a);
      }
    }
    return out;
  };
  const v = pick(italic);
  return v.length ? v : pick(null);
}

/** 轴当前值:样式的 variations 值,否则 wght=字重/ital=斜体取 max/其余=默认,钳轴范围(上游 axis_value)。 */
export function axisValue(c: CharStyleJson, axis: [string, number, number, number], variations: Record<string, number>): number {
  const [tag, min, def, max] = axis;
  const v = variations[tag] ?? (tag === 'wght' ? c.weight : tag === 'ital' && c.italic ? max : def);
  const d = Math.min(max, Math.max(min, def));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

/** 轴标签(注册轴中文名,其余原样;上游 axis_label)。 */
export function axisLabel(tag: string): string {
  switch (tag) {
    case 'wght': return '字重';
    case 'wdth': return '宽度';
    case 'slnt': return '倾斜';
    case 'ital': return '斜体';
    default: return tag;
  }
}

/** 最近字体上限(上游 prefs Recent Fonts 默认)。 */
export const RECENT_FONTS_MAX = 10;

/** 记最近字体:重挑移到队首,0 上限=清空(上游 note_recent_font 口径)。 */
export function noteRecentFont(list: string[], family: string, max = RECENT_FONTS_MAX): string[] {
  if (max <= 0) return [];
  return [family, ...list.filter((f) => f !== family)].slice(0, max);
}
