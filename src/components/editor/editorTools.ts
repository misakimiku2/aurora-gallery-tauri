/**
 * 编辑器工具栏定义（C11）。
 *
 * 键位与工具集合照 Photoshop（用户 2026-10-16 拍板 D3：键位照 PS，且可自定义），
 * 分批放行见 UI 设计 §3。
 *
 * **未接入的工具照样显示、照样可选中**：PS 的心智是"工具就摆在那儿，我还没用到"，
 * 藏起来反而让人以为产品缺功能。它们的图标灰一档、title 标注「尚未接入」，
 * 选中后顶部选项条会明说该工具还没接——不假装能用。
 */
import {
  Brush,
  Crop,
  Eraser,
  Hand,
  Move,
  PaintBucket,
  PenTool,
  Pipette,
  Scaling,
  Square,
  Type,
  ZoomIn,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EditorToolId } from '../../types';

export interface EditorToolDef {
  id: EditorToolId;
  label: string;
  /** PS 默认快捷键（UI 设计 §8.3 是待核清单，实施时以实测为准） */
  shortcut: string;
  icon: LucideIcon;
  /** 是否已接真实行为。false = 骨架占位（可选中，但只有选项条文案会变） */
  available: boolean;
  /** 在这枚工具之前画一条分隔线（PS 工具箱的语义分组） */
  dividerBefore?: boolean;
}

export const EDITOR_TOOLS: EditorToolDef[] = [
  { id: 'move', label: '移动', shortcut: 'V', icon: Move, available: true },
  { id: 'transform', label: '自由变换', shortcut: 'Ctrl+T', icon: Scaling, available: true },
  { id: 'crop', label: '裁剪', shortcut: 'C', icon: Crop, available: true, dividerBefore: true },
  { id: 'hand', label: '抓手', shortcut: 'H', icon: Hand, available: true, dividerBefore: true },
  { id: 'zoom', label: '缩放', shortcut: 'Z', icon: ZoomIn, available: true },
  { id: 'eyedropper', label: '吸管', shortcut: 'I', icon: Pipette, available: false, dividerBefore: true },
  { id: 'brush', label: '画笔', shortcut: 'B', icon: Brush, available: false },
  { id: 'eraser', label: '橡皮', shortcut: 'E', icon: Eraser, available: false },
  { id: 'fill', label: '填充', shortcut: 'G', icon: PaintBucket, available: false },
  { id: 'text', label: '文字', shortcut: 'T', icon: Type, available: false },
  { id: 'pen', label: '钢笔', shortcut: 'P', icon: PenTool, available: false, dividerBefore: true },
  { id: 'shape', label: '形状', shortcut: 'U', icon: Square, available: false },
];

/** 取工具定义；未知/未设按 PS 默认工具「移动」处理。 */
export const getEditorTool = (id?: EditorToolId | null): EditorToolDef =>
  EDITOR_TOOLS.find(t => t.id === (id ?? 'move')) ?? EDITOR_TOOLS[0];

// 工具光标表（EDITOR_TOOL_CURSORS）已删除：全仓从未引用过它，而光标实际由
// ImageEditor 里那段 cursor 计算按 hand / zoom / crop 现算。留着只会让人以为改这里
// 能改光标。要统一光标，改 ImageEditor。

/**
 * 移动工具的「自动选择」（PS 选项条上那个下拉）。
 *
 * - `none`：**不改**选中层，只能拖当前选中的那层，换层走图层面板。
 *   PS 出厂默认是这一档——图层多了之后，自动选择会让人"点一下就换了层"。
 * - `layer`：点谁选谁（顶层优先）。
 *
 * PS 还有一档 `组`，但我们还没有编组，所以类型里也不留这个枚举值。
 */
export type AutoSelectMode = 'none' | 'layer';

/** 快捷键 → 工具（UI 设计 §8.3 的键位表）。 */
export const EDITOR_SHORTCUT_KEYS: Record<string, EditorToolId> = {
  v: 'move',
  c: 'crop',
  h: 'hand',
  z: 'zoom',
  i: 'eyedropper',
  b: 'brush',
  e: 'eraser',
  g: 'fill',
  t: 'text',
  p: 'pen',
  u: 'shape',
};
