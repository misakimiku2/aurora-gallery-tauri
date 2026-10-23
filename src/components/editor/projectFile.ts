/**
 * `.aurora` 工程文件的**前端纯函数**：文档 ↔ IPC 载荷的映射与路径小工具。
 *
 * 只做形状转换与校验，不碰 I/O、不碰 React——真正的读写全在 Rust
 * （`core/src/editor_project.rs` + `editor_commands.rs` 的 `editor_save_project` /
 * `editor_open_project`）。这样这一层可以用 vitest 锁住往返，不必起一个 Tauri。
 *
 * ## 为什么载荷里存定界框而不是矩阵
 *
 * 导出时的仿射矩阵是 `composeMatrix(box, natural)` 的**派生物**。文档要能再编辑，
 * 就必须存"框 + 自然尺寸"这层语义；存矩阵等于把语义烧死，将来改缩放/旋转就没法
 * 从矩阵反推回框。所以两端都只在**导出**那一刻算矩阵。
 */
import type { EditorCanvas, EditorDocument, EditorLayer, LayerBox } from '../../types';
import { normalizeBlendMode } from './blendModes';
import { EDITOR_DOC_VERSION, layerBlend, layerLocks, layerOpacity } from './layerModel';

export type EditorAdjust = NonNullable<EditorLayer['adjust']>;

/** `editor_save_project` 的请求体（camelCase 与 Rust 侧 serde 对齐）。 */
export interface ProjectSavePayload {
  name: string;
  canvas: EditorCanvas;
  layers: ProjectLayerPayload[];
  activeLayerId: string | null;
}

export interface ProjectLayerPayload {
  id: string;
  name: string;
  source: string;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
  /** 不透明度百分比（0..=100）；100 = 完全不透明 */
  opacity: number;
  /** 混合模式（kebab-case，与 CSS `mix-blend-mode` 同名） */
  blend: string;
  /** 锁像素 / 锁位置（false = 未锁；显式写出，读工程时一眼能看懂） */
  lock_pixel: boolean;
  lock_position: boolean;
  /** Rust 侧字段叫 `frame`，JSON 键是 `box`（`box` 在 Rust 里是保留字） */
  box: LayerBox;
  adjust: EditorAdjust | null;
}

/** `editor_open_project` 的返回。 */
export interface OpenedProjectPayload {
  name: string;
  canvas: { width: number; height: number; background: string };
  layers: Array<{
    id: string;
    name: string;
    source: string | null;
    naturalWidth: number;
    naturalHeight: number;
    visible: boolean;
    /** 老工程没有这个字段时会缺省（Rust 侧 serde default = 100） */
    opacity?: number;
    /** 老工程没有这个字段时会缺省（Rust 侧 serde default = normal） */
    blend?: string;
    /** 老工程缺这两字段时按 false（未锁） */
    lock_pixel?: boolean;
    lock_position?: boolean;
    box: LayerBox;
    adjust: EditorAdjust | null;
  }>;
  activeLayerId: string | null;
  /** `reference` = 从参考模式（画布）的会话文件打开，items 已被映射成图层 */
  source: 'editor' | 'reference';
  warnings: string[];
}

/** `.aurora` 扩展名判定。保存时用它决定"直接覆盖"还是"弹另存为"。 */
export function isProjectPath(path: string | undefined): boolean {
  return !!path && /\.aurora$/i.test(path);
}

function splitPath(path: string): { dir: string; sep: string; base: string } {
  const sepIdx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const sep = sepIdx >= 0 ? path[sepIdx] : '\\';
  const dir = sepIdx >= 0 ? path.slice(0, sepIdx) : '';
  const base = sepIdx >= 0 ? path.slice(sepIdx + 1) : path;
  return { dir, sep, base };
}

/** 工程文件名（去掉扩展名，`Tab` 标题用它）。 */
export function projectDisplayName(path: string): string {
  const raw = splitPath(path).base;
  const stripped = raw.replace(/\.aurora$/i, '');
  return stripped || '未命名';
}

/**
 * "保存"对话框的默认路径：与来源图同目录、同名换 `.aurora` 扩展名。
 *
 * 新建的空白文档没有 `path`，此时返回空串——对话框会落在系统上次用过的目录，
 * 比硬编一个"文档"目录更像用户预期。
 */
export function defaultProjectPath(doc: EditorDocument): string {
  if (!doc.path) return '';
  const { dir, sep, base } = splitPath(doc.path);
  const stem = base.replace(/\.[^.]+$/, '') || '未命名';
  return dir ? `${dir}${sep}${stem}.aurora` : `${stem}.aurora`;
}

/** 字节数 → 人类可读（保存/导出的提示条用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * 文档 → 保存请求。
 *
 * 没有画布就**报错而不是存一个 0×0 的文档**：那份文件打开时必然失败，而且用户
 * 会以为"存成功了"。没有源图的图层（理论上不存在）丢掉，否则 Rust 会为它写一个
 * 空 `imageFileName`，读侧只能丢弃并警告。
 */
export function buildSavePayload(doc: EditorDocument): ProjectSavePayload {
  const canvas = doc.canvas;
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
    throw new Error('画布尺寸无效，无法保存（请先打开图片或新建文档）');
  }
  const layers = (doc.layers ?? []).filter(l => !!l.source);
  const activeLayerId = doc.activeLayerId && layers.some(l => l.id === doc.activeLayerId)
    ? doc.activeLayerId
    : null;

  return {
    name: doc.name,
    canvas: {
      width: Math.round(canvas.width),
      height: Math.round(canvas.height),
      background: canvas.background,
    },
    layers: layers.map(l => ({
      id: l.id,
      name: l.name,
      source: l.source as string,
      naturalWidth: l.naturalWidth,
      naturalHeight: l.naturalHeight,
      visible: l.visible,
      // 显式写出来（而不是省掉）：Rust 侧缺省虽然也是 100/normal，但存进去的数要能一眼看懂
      opacity: layerOpacity(l),
      blend: layerBlend(l),
      lock_pixel: layerLocks(l).pixel,
      lock_position: layerLocks(l).position,
      box: l.box,
      adjust: l.adjust ?? null,
    })),
    activeLayerId,
  };
}

const BACKGROUNDS: EditorCanvas['background'][] = ['transparent', 'white', 'black'];

function normalizeCanvas(raw: OpenedProjectPayload['canvas']): EditorCanvas {
  const width = Math.max(1, Math.round(Number(raw?.width) || 0));
  const height = Math.max(1, Math.round(Number(raw?.height) || 0));
  const background = BACKGROUNDS.includes(raw?.background as EditorCanvas['background'])
    ? (raw.background as EditorCanvas['background'])
    : 'transparent';
  return { width, height, background };
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBox(raw: Partial<LayerBox> | undefined): LayerBox {
  return {
    x: finiteOr(raw?.x, 0),
    y: finiteOr(raw?.y, 0),
    w: finiteOr(raw?.w, 0),
    h: finiteOr(raw?.h, 0),
    rotation: finiteOr(raw?.rotation, 0),
    flipH: !!raw?.flipH,
    flipV: !!raw?.flipV,
    skewX: finiteOr(raw?.skewX, 0),
    skewY: finiteOr(raw?.skewY, 0),
  };
}

function normalizeAdjust(raw: EditorAdjust | null | undefined): EditorAdjust | undefined {
  if (!raw) return undefined;
  const adjust = {
    brightness: finiteOr(raw.brightness, 0),
    contrast: finiteOr(raw.contrast, 0),
    saturation: finiteOr(raw.saturation, 0),
    temperature: finiteOr(raw.temperature, 0),
  };
  // 四个 0（等于没调色）不落成"有一个全 0 的 adjust 对象"，保持文档干净
  return Object.values(adjust).some(v => v !== 0) ? adjust : undefined;
}

/**
 * 读回不透明度：缺失 / ≥100 一律折成 `undefined`（文档保持干净，与 `setLayerOpacity`
 * 回到 100 时删字段同一口径），其余钳到 0..99。
 */
function normalizeOpacity(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const v = Math.min(100, Math.max(0, Math.round(n)));
  return v >= 100 ? undefined : v;
}

/**
 * 打开结果 → 文档。
 *
 * `archivePath` 必须由调用方给：它是"这份文档存到哪儿"，Rust 只返回内容。
 * 返回值一律 `dirty: false`——刚从磁盘读出来的东西没有未保存改动。
 */
export function projectPayloadToDocument(
  payload: OpenedProjectPayload,
  archivePath: string,
): EditorDocument {
  const layers: EditorLayer[] = (payload.layers ?? [])
    .filter(l => !!l.source)
    .map((l, index) => ({
      id: l.id || `layer-${index}`,
      kind: 'image' as const,
      source: l.source as string,
      naturalWidth: Math.max(1, Math.round(finiteOr(l.naturalWidth, 1))),
      naturalHeight: Math.max(1, Math.round(finiteOr(l.naturalHeight, 1))),
      box: normalizeBox(l.box),
      adjust: normalizeAdjust(l.adjust),
      visible: l.visible !== false,
      opacity: normalizeOpacity(l.opacity),
      // 正常模式不落字段（与 `setLayerBlend` 回到 normal 时删字段同一口径）
      blend: normalizeBlendMode(l.blend) === 'normal' ? undefined : normalizeBlendMode(l.blend),
      // 锁只在 true 时落字段（文档保持干净；undefined 经 layerLocks() 读回 false）
      // 注意：EditorLayer 的字段是 camelCase，payload 侧才是 snake_case
      lockPixel: l.lock_pixel === true ? true : undefined,
      lockPosition: l.lock_position === true ? true : undefined,
      name: l.name || `图层 ${index + 1}`,
    }));

  const activeLayerId =
    payload.activeLayerId && layers.some(l => l.id === payload.activeLayerId)
      ? payload.activeLayerId
      : layers[layers.length - 1]?.id;

  return {
    path: archivePath,
    name: payload.name?.trim() || projectDisplayName(archivePath),
    dirty: false,
    version: EDITOR_DOC_VERSION,
    canvas: normalizeCanvas(payload.canvas),
    layers,
    activeLayerId,
  };
}
