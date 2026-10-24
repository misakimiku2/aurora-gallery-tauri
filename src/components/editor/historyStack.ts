/**
 * 撤销栈的**纯函数面**（2026-10-26 画笔架构轮）：文档快照 + 像素补丁混合栈。
 *
 * ## 为什么要有像素补丁这一种条目
 *
 * v2.5 的栈只有"文档参数快照"一种条目——画笔时代它靠"每笔换一个文件路径"让签名
 * 变化来进栈，路径指向没落盘的文件时撤销就是"整图消失"。现在像素活在位图仓里，
 * 文档签名在笔画前后**根本不变**，所以画笔的撤销步以 `paint` 条目直接入栈：
 * 只存**脏矩形**的改动前/后两块像素（一笔通常几十 KB～几 MB，不是整层 96MB）。
 *
 * ## 语义（PS 口径）
 *
 * - 一笔 = 一步撤销（`paint` 条目不合并——700ms 合并窗口只属于"拖调色滑杆"那类
 *   连续参数变化）；
 * - `doc` 条目照旧存引用快照（参数不存像素，`useEditorHistory` 文件头的老口径）；
 * - 两类条目按发生顺序混排，撤销/重做逐条走，天然处理"画一笔 → 移动图层 →
 *   再撤销"这类交错；
 * - `paint` 条目数有上限（默认 40，PS 默认 20 步历史的同类取舍）：超限时丢**最老**
 *   的补丁条目（只能少撤销几步，不许无上限吃内存）。
 */
import type { EditorCanvas, EditorLayer } from '../../types';

/** 一笔的像素补丁：脏矩形 + 改动前后两块像素（目标缓冲坐标）。 */
export interface PaintPatch {
  /** 位图键（`layerBitmaps.layerKey` / `maskKey`） */
  key: string;
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

export type HistoryEntry =
  | { kind: 'doc'; canvas?: EditorCanvas; layers?: EditorLayer[]; at: number }
  | { kind: 'paint'; patch: PaintPatch };

export interface HistoryState {
  stack: HistoryEntry[];
  /** 指向"当前状态"所在的条目（-1 = 还没建栈） */
  index: number;
  /** 栈顶 doc 条目的入栈时刻——700ms 合并窗口的判据 */
  lastDocAt: number;
}

export const PAINT_ENTRY_LIMIT = 40;

export function initialHistoryState(snap: { canvas?: EditorCanvas; layers?: EditorLayer[] }): HistoryState {
  return { stack: [{ kind: 'doc', ...snap, at: 0 }], index: 0, lastDocAt: 0 };
}

/**
 * 压入一个 doc 条目。`merge = true` 时替换栈顶（调色滑杆的连续变化合成一步），
 * 否则截断 redo 尾巴后追加。追加后统一做补丁条目数上限裁剪。
 */
export function pushDocEntry(
  state: HistoryState,
  snap: { canvas?: EditorCanvas; layers?: EditorLayer[] },
  merge: boolean,
): HistoryState {
  const at = Date.now();
  const head = state.stack.slice(0, merge ? state.index : state.index + 1);
  head.push({ kind: 'doc', ...snap, at });
  return capPaintEntries({ stack: head, index: head.length - 1, lastDocAt: at });
}

/** 压入一个像素补丁条目（一笔 = 一步；截断 redo 尾巴）。 */
export function pushPaintEntry(state: HistoryState, patch: PaintPatch): HistoryState {
  const head = state.stack.slice(0, state.index + 1);
  head.push({ kind: 'paint', patch });
  return capPaintEntries({ ...state, stack: head, index: head.length - 1 });
}

/**
 * 补丁条目超上限时从**栈底**丢最老的（doc 条目不动——它们是引用快照，几乎不占内存，
 * 还是撤销链的骨架）。丢掉的条目若在当前 index 之下，index 随之左移（= 少撤销几步）。
 */
function capPaintEntries(state: HistoryState): HistoryState {
  let stack = state.stack;
  let index = state.index;
  let paintCount = stack.filter(en => en.kind === 'paint').length;
  while (paintCount > PAINT_ENTRY_LIMIT) {
    const i = stack.findIndex(en => en.kind === 'paint');
    if (i < 0) break;
    if (i <= index) index -= 1;
    stack = [...stack.slice(0, i), ...stack.slice(i + 1)];
    paintCount -= 1;
  }
  return { ...state, stack, index };
}

export function canUndo(state: HistoryState): boolean {
  return state.index > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.index >= 0 && state.index < state.stack.length - 1;
}

/** 撤销一步要应用的条目（= 当前状态条目）；越界返回 undefined。 */
export function entryToUndo(state: HistoryState): HistoryEntry | undefined {
  return state.stack[state.index];
}

/** doc 条目的形状（`docSnapshotBelow` 的返回类型）。 */
export type HistoryDocEntry = { kind: 'doc'; canvas?: EditorCanvas; layers?: EditorLayer[]; at: number };

/**
 * **doc 条目撤销要恢复的快照**：index 之下最近的 doc 条目。
 *
 * doc 快照存的是"变更后"的状态，所以撤销 doc 步不能应用 stack[index]（那是当前
 * 状态，等于无效按键），要应用**下方的上一个 doc 快照**——中间隔着的 paint 条目
 * 不回退（它们的笔迹已经在这份像素里，doc 撤销只管参数）。paint 条目自带
 * before/after，撤销 = 应用 stack[index].patch.before，两者语义不同。
 * stack[0] 恒为 doc（建栈快照），理论上必命中；空栈防御性返回 undefined。
 */
export function docSnapshotBelow(state: HistoryState): HistoryDocEntry | undefined {
  for (let i = state.index - 1; i >= 0; i -= 1) {
    const en = state.stack[i];
    if (en.kind === 'doc') return en;
  }
  return undefined;
}

/** 重做一步要应用的条目；越界返回 undefined。 */
export function entryToRedo(state: HistoryState): HistoryEntry | undefined {
  return state.stack[state.index + 1];
}

/** 应用后的新 index（undo 减一、redo 加一——纯位移，条目本体不重算）。 */
export function stepped(state: HistoryState, dir: -1 | 1): HistoryState {
  const index = state.index + dir;
  if (index < 0 || index >= state.stack.length) return state;
  return { ...state, index };
}
