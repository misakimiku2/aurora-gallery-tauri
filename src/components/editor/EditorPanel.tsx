/**
 * 编辑态右侧面板组（UI 设计 §4，PS 式）。
 *
 * 顺序按用户 2026-10-22 的验收意见重排：**全览图置顶、图层沉底**。
 * 这与 PS 的默认面板栈一致——Navigator 在最上，Layers 在最下，中间是属性类面板。
 *
 * 容器复用现有右面板（`RightPanel` 的 20rem 抽屉），内容在编辑态换成这一套；
 * 浏览态仍是 `MetadataPanel`。**不做选项卡**（UI 设计 §4.2 推荐）。
 *
 * ## 图层面板的三次迭代（改这块之前先看）
 *
 * - 2026-10-24 初版：列表 / 选中 / 眼睛 / 复制 / 上移下移 / 删除 / 双击改名。
 * - 2026-10-24 二版：加不透明度，滑杆放在列表**上方**（PS 口径）。
 * - 2026-10-24 三版（**当前**，用户验收后的意见）：
 *   ① 去掉上移/下移按钮，改成**拖拽卡片**排序（`reorderLayers`）；
 *   ② 去掉顶部的不透明度滑杆，改成**行内百分比**：点一下弹小输入框，
 *      按住左右拖 = 快速擦调（`SCRUB_PX_PER_PERCENT`）；
 *   ③ 操作按钮移到列表**上方**，选中图层后按 `Delete` 删除。
 *   ④ 全览图从"活动图层那一层"换成**整份文档的合成**（PS 的 Navigator 语义）：
 *      走 `editor_render_document`（Rust 全分辨率合成 → ≤2048 JPEG），文档图层一变
 *      就防抖重渲。不透明度输入弹窗因此改用 **portal** 挂到 body——右面板容器带着
 *      `transform` + `overflow-hidden`，fixed 定位的弹窗会被它当Containing Block 裁掉
 *      （用户实测"点了百分比没弹窗"就是这个）。
 *
 * ## 列表顺序
 *
 * 文档里的 `layers` 是**自底向上**（下标 0 最先画），面板是**自顶向下**。
 * 反转只在 `layerModel.layersTopDown` 做一次；拖放时"上面/下面"的换算只在
 * `layerModel.reorderLayers` 做一次。谁在别处又算一遍，"上移"就会变成"下移"。
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeftRight,
  Brush,
  ChevronDown,
  ChevronRight,
  Contrast,
  Copy,
  CornerDownRight,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderPlus,
  Grid2x2,
  Image as ImageIcon,
  Link,
  Lock,
  Move,
  Plus,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EditorCanvas, EditorLayer } from '../../types';
import { EditorNavigator } from './EditorNavigator';
import { Adjustments, isZeroAdjustments, ZERO_ADJUSTMENTS } from './colorMatrix';
import { getEditorView, requestPanTo, subscribeEditorView } from './editorViewStore';
import { useEditorThumbnail } from './useEditorThumbnail';
import { peekPreview, subscribePreview } from './editorPreviewCache';
import {
  buildLayerPreviewKey,
  createIdentityBox,
  createLayerId,
  duplicateLayer,
  layerOpacity,
  layersTopDown,
  layerBlend,
  layerLocks,
  removeLayer,
  reorderLayers,
  setLayerBlend,
  setLayerLock,
  setLayerOpacity,
  setLayerVisible,
} from './layerModel';
import {
  createGroup,
  deleteGroupWithMembers,
  isGroupRow,
  setGroupCollapsed,
  ungroup,
} from './layerGroups';
import { BLEND_MODES, BlendMode, blendModeLabel, normalizeBlendMode } from './blendModes';
import { ensureLayerPreview } from './layerProxy';
import { buildRenderGroups } from './renderPayload';
import { useEditorMask } from './useEditorMask';
import { canClipLayer, toggleClipped } from './layerClipping';
import { toggleMaskDisabled, toggleMaskLink } from './layerModel';
import {
  getEditorColors,
  resetEditorColors,
  setForeground,
  setBackground,
  subscribeEditorColors,
  swapEditorColors,
} from './editorColorStore';
import { bakeCanvasToPath, allocatePaintPath, blankCanvas, enqueueBake, flushPaintBakes } from './brushBake';
import { rememberPaintBuffer } from './paintBuffers';

/** `editor_render_document` 的返回（camelCase 由 Rust 侧 serde 重命名） */
interface DocumentRender {
  previewWidth: number;
  previewHeight: number;
  dataUrl: string;
}

interface EditorPanelProps {
  /** 当前 Tab id：用于订阅该 Tab 的视口状态 */
  tabId: string;
  documentName: string;
  /** 画布尺寸与背景（全览图合成要用；面板只拿参数，字节全在 Rust 进程里） */
  width: number;
  height: number;
  background?: EditorCanvas['background'];
  /** 图层数组（**自底向上**，与文档一致） */
  layers?: EditorLayer[];
  activeLayerId?: string;
  /** 选中对象落在图层本体还是蒙版上（PS 点缩略图切换的那个状态） */
  activeTarget?: 'image' | 'mask';
  /** 选中图层（只改选区，不算改动，不置 dirty） */
  onSelectLayer?: (id: string) => void;
  /** 点缩略图：选层并指定 target（图层/蒙版）——同样只改选区，不置 dirty */
  onSelectTarget?: (layerId: string, target: 'image' | 'mask') => void;
  /** 改动图层（可见性 / 顺序 / 复制 / 删除 / 改名 / 不透明度） */
  onLayersChange?: (next: { layers: EditorLayer[]; activeLayerId?: string }) => void;
  /** 活动图层的调色参数（-100..100） */
  adjust?: Adjustments;
  onAdjustChange: (next: Adjustments) => void;
}

/** 拖放落点（**显示口径**：above = 盖住目标层那一侧） */
type DropPosition = 'above' | 'below';

/** 横向擦调灵敏度：每移动这么多像素改 1%。2px 在 320px 面板里大约是"一屏 150%" */
const SCRUB_PX_PER_PERCENT = 2;

/** 弹窗宽度（固定值：位置要提前算，不能等渲染完再量） */
const POPOVER_WIDTH = 168;

const Section: React.FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  hint?: string;
}> = ({ title, defaultOpen = true, children, hint }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-200 dark:border-neutral-700">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full h-8 flex items-center gap-1 px-3 text-[11px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 select-none"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
        {hint && <span className="ml-auto text-[10px] font-normal text-neutral-400">{hint}</span>}
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-[11px]">
    <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
    <span className="tabular-nums text-neutral-700 dark:text-neutral-200">{value}</span>
  </div>
);

const Slider: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  onReset: () => void;
}> = ({ label, value, onChange, onReset }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      {/* 双击标签归零：PS 也是这个交互 */}
      <span
        className="text-neutral-500 dark:text-neutral-400 cursor-pointer select-none"
        onDoubleClick={onReset}
        title="双击归零"
      >
        {label}
      </span>
      <span className="tabular-nums text-neutral-700 dark:text-neutral-200 w-8 text-right">
        {value}
      </span>
    </div>
    <input
      type="range"
      min={-100}
      max={100}
      step={1}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="w-full accent-blue-600"
    />
  </div>
);


/**
 * 行内不透明度数值，两种手势：
 *
 * - **点一下**（按下抬起之间几乎没移动）→ 弹小弹窗
 * - **按住左右拖** → 连续擦调
 *
 * 用 Pointer Events + `setPointerCapture` 而不是 mouse 事件：捕获之后即使指针移出
 * 这个 9 个字宽的小方块，拖动也不会断——这是"快速调节"能用的前提。
 *
 * `data-no-drag` 是给父级 HTML5 拖拽的标记：不标的话，按住数值左右拖会**变成拖图层**。
 */
const OpacityScrub: React.FC<{
  value: number;
  onChange: (value: number) => void;
  onOpenEditor: (anchor: HTMLElement) => void;
}> = ({ value, onChange, onOpenEditor }) => {
  const dragRef = useRef<{ startX: number; startValue: number; moved: boolean } | null>(null);

  return (
    <span
      role="button"
      tabIndex={-1}
      data-no-drag
      title="点一下输入，按住左右拖可快速调节"
      className="shrink-0 w-9 text-right text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500 cursor-ew-resize select-none touch-none rounded px-0.5 hover:bg-neutral-200/70 dark:hover:bg-neutral-600/60 hover:text-neutral-600 dark:hover:text-neutral-300"
      onPointerDown={e => {
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startValue: value, moved: false };
      }}
      onPointerMove={e => {
        const s = dragRef.current;
        if (!s) return;
        const dx = e.clientX - s.startX;
        if (!s.moved && Math.abs(dx) < 3) return; // 手抖不算拖
        s.moved = true;
        onChange(Math.round(s.startValue + dx / SCRUB_PX_PER_PERCENT));
      }}
      onPointerUp={e => {
        const s = dragRef.current;
        dragRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        // 没拖动 = 一次点击 ⇒ 开输入弹窗
        if (s && !s.moved) onOpenEditor(e.currentTarget);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      {value}%
    </span>
  );
};

/**
 * 不透明度弹窗：**只有一条滑杆 + 一个百分比数字**，没有标签、没有说明文字。
 *
 * 点数字 → 变成输入框（Enter/blur 提交、Esc 取消）；拖滑杆 → 连续改。
 * 用 `type="text"` + `inputMode="numeric"` 而不是 `type="number"`：后者会自带
 * 上下微调按钮，而这里不想要（用户明确要求）。
 *
 * 定位：`fixed`，并且**portal 到 body**——右面板容器带 `transform` + `overflow-hidden`，
 * 面板里的 fixed 后代会被它当定位基准并裁掉（表现就是"点了没弹窗"，见 §6 第 17 条）。
 */
const OpacityPopover: React.FC<{
  value: number;
  top: number;
  left: number;
  onChange: (value: number) => void;
  onClose: () => void;
}> = ({ value, top, left, onChange, onClose }) => {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点到外面 / 列表滚动就关。
  // - mousedown 用 **capture**：面板里别的 handler 会 stopPropagation，冒泡阶段收不到；
  // - scroll 用 capture 是为了连内层列表的滚动一起接住——弹窗是 fixed 定位，
  //   列表一滚它就会飘在错误的位置上，不如关掉重开。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const commit = () => {
    const raw = draft.trim();
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) onChange(Math.min(100, Math.max(0, Math.round(n))));
    setEditing(false);
    onClose();
  };

  return (
    <div
      ref={boxRef}
      style={{ position: 'fixed', top, left, width: POPOVER_WIDTH }}
      className="z-50 flex items-center gap-1.5 rounded-md border border-neutral-200 dark:border-neutral-600 bg-panel px-2 py-1.5 shadow-lg"
    >
      {/* 滑杆只负责给数：钳位交给 `setLayerOpacity` 里的 `layerOpacity()`，这一处不重复算 */}
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={e => onChange(Math.round(Number(e.target.value) || 0))}
        className="min-w-0 flex-1 accent-blue-600"
        title="拖动调节"
      />

      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={e => {
            const raw = e.target.value.replace(/[^\d]/g, '').slice(0, 3);
            setDraft(raw);
            const n = Number(raw);
            if (raw !== '' && Number.isFinite(n)) onChange(Math.min(100, Math.max(0, Math.round(n))));
          }}
          onBlur={commit}
          onKeyDown={e => {
            e.stopPropagation(); // 别让 Delete 之类的编辑快捷键漏到底下的画布
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setEditing(false);
              onClose();
            }
          }}
          onFocus={e => e.currentTarget.select()}
          className="w-9 h-6 px-1 rounded text-[11px] tabular-nums text-right border border-blue-400 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 outline-none"
        />
      ) : (
        <button
          type="button"
          title="点击输入"
          onClick={() => {
            setDraft(String(value));
            setEditing(true);
          }}
          className="shrink-0 w-9 text-right text-[11px] tabular-nums text-neutral-600 dark:text-neutral-300 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {value}%
        </button>
      )}
    </div>
  );
};

/**
 * 面板图标按钮：图层面板里**所有**图标按钮的统一外观（顶部四格锁、底部复制/删除
 * 都用它，用户 2026-10-24 验收反馈"样式不协调"后统一）。
 *
 * - `on` = 开关已开（蓝底，锁定格用）；
 * - `grayed` = 格子暂无意义照 PS 画出来但禁用（锁透明像素等画笔）；
 * - `danger` = 悬停变红（删除）。
 */
const PanelIconButton: React.FC<{
  icon: LucideIcon;
  title: string;
  on?: boolean;
  onClick: () => void;
  disabled?: boolean;
  grayed?: boolean;
  danger?: boolean;
}> = ({ icon: Icon, title, on, onClick, disabled, grayed, danger }) => {
  const off = disabled || grayed;
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      disabled={off}
      onClick={onClick}
      className={[
        'h-7 flex-1 flex items-center justify-center rounded border transition-colors',
        grayed || disabled
          ? 'border-neutral-200 dark:border-neutral-700 text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
          : on
            ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400'
            : danger
              ? 'border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400'
              : 'border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700',
      ].join(' ')}
    >
      <Icon size={12} />
    </button>
  );
};

/**
 * 混合模式下拉（图层行内那颗）。
 *
 * 不用原生 `<select>`：它展开的列表是系统级弹窗，页面拿不到滚轮事件——而
 * 「悬停弹窗滚轮换档、画布实时变」正是这里要给的 PS 式试法。所以自制弹窗：
 *
 * - **悬停按钮本体（不点开）滚轮 = 直接切档**（用户 2026-10-24 追加）；
 * - 点按钮展开；12 项**全铺开、不内部滚动**——滚轮整颗留给"切档"，不留给滚列表；
 * - **悬停弹窗滚轮 = 上一档/下一档（循环 wrap），立即提交**：连续滚就是连续试效果；
 * - 点击项提交并收起；点外面 / Esc / 面板滚动 → 收起（滚动关掉是因为弹窗是
 *   fixed，列表一滚它就飘在错的位置上，同不透明度弹窗的处理）。
 *
 * 滚轮每换一档都是一次真实的 `setLayerBlend`（进撤销栈）——和 PS 一样，每次变更
 * 是一步撤销，不做时间合并（滚轮是有意的一格格操作，不是拖滑杆那种连发）。
 *
 * portal 到 body + fixed：右面板容器带 transform + overflow-hidden，面板内的
 * fixed 后代会被它当定位基准并裁掉（见文件末尾不透明度弹窗的同款注释）。
 */
const BLEND_POP_WIDTH = 144; // 装得下最长的 4 字中文名（正片叠底/颜色减淡…）
const BLEND_ITEM_HEIGHT = 22;

const BlendSelect: React.FC<{
  value: BlendMode;
  onChange: (mode: BlendMode) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const popHeight = BLEND_MODES.length * BLEND_ITEM_HEIGHT + 8;

  // 滚轮切一档（循环 wrap）。按钮与弹窗两处共用：down = 下一档，up = 上一档。
  const spin = (di: number) => {
    const i = BLEND_MODES.findIndex(m => m.id === normalizeBlendMode(value));
    const next = BLEND_MODES[(i + di + BLEND_MODES.length) % BLEND_MODES.length];
    onChange(next.id);
  };

  const openAt = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 向下放不下就向上；横向贴屏幕右缘时往里收（右面板贴边，必须防）
    let top = rect.bottom + 4;
    if (top + popHeight > window.innerHeight) top = Math.max(4, rect.top - popHeight - 4);
    let left = rect.left;
    if (left + BLEND_POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - 8 - BLEND_POP_WIDTH;
    setPos({ top, left });
    setOpen(true);
  };

  // **按钮本体也接滚轮**（用户 2026-10-24 追加）：鼠标悬停在下拉框上（不点开）直接滚
  // = 切档，与弹窗内滚轮同一套逻辑。passive 必须显式 false——React 的 onWheel 是
  // 被动的，preventDefault 会被吞，滚动会穿透到图层面板把列表滚走。悬停在按钮上
  // 滚动是有意切档，此时不让面板滚是正确语义（想滚面板把鼠标移开按钮即可）。
  useEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      spin(e.deltaY > 0 ? 1 : -1);
    };
    btn.addEventListener('wheel', onWheel, { passive: false });
    return () => btn.removeEventListener('wheel', onWheel);
    // 依赖与 spin 的闭包对齐：value 变了重挂一次，拿到最新档位
  }, [value, onChange]);

  // 弹窗内的滚轮：悬停弹窗才触发（点开后的连续试档）。
  // passive 必须显式 false，理由同上。
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      spin(e.deltaY > 0 ? 1 : -1);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 按钮也算"内部"：否则点按钮收起时，mousedown 先关、click 再开 = 关不掉
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // capture 阶段截掉：别让 Esc 漏到画布（裁剪态的 Esc 是取消裁剪）
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
      }
    };
    pop?.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      pop?.removeEventListener('wheel', onWheel);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, value, onChange]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-no-drag
        onClick={e => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openAt();
        }}
        title={`混合模式：${blendModeLabel(value)}；悬停滚轮直接换档，点击展开全部`}
        className="shrink-0 w-[4.75rem] h-6 px-1 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 cursor-pointer outline-none flex items-center justify-between gap-0.5"
      >
        <span className="truncate">{blendModeLabel(value)}</span>
        <span aria-hidden className="text-[8px] leading-none text-neutral-400 dark:text-neutral-500">
          ▼
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: BLEND_POP_WIDTH }}
            className="z-50 rounded-md border border-neutral-200 dark:border-neutral-600 bg-panel shadow-lg py-1"
          >
            {BLEND_MODES.map(m => {
              const active = m.id === normalizeBlendMode(value);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className={[
                    'w-full text-left px-2 text-[11px] cursor-pointer',
                    // 高度写死，别拿常量拼 Tailwind 类——编译期扫不到动态类名
                    'h-[22px] leading-[22px]',
                    active
                      ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium'
                      : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700',
                  ].join(' ')}
                >
                  {m.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
};

/**
 * 一行图层。
 *
 * 缩略图按图层各自的代理图算（`ensureLayerPreview` 排队生成，未就绪时显示图标占位）。
 * **调色滤镜只套在活动行上**：那张 SVG 滤镜的矩阵来自活动图层，套到别的行上会让
 * 非活动层的缩略图显示错误的颜色。
 *
 * ## 选中对象（PS 的图层/蒙版切换，2026-10-24 第二轮）
 *
 * 点**图层缩略图** = 选中图层本体（target=image）；点**蒙版缩略图** = 选中蒙版
 * （target=mask，变换/删除作用到蒙版上）。两缩略图之间是**链条**（链接/解链蒙版）。
 * 行内其余位置的点击仍是"选中图层"（target=image）。
 *
 * **Alt+点行** = 切换这层的**剪贴蒙版**（PS 是 Alt+点两行之间的分割线，这里放宽到
 * 整行——被剪贴的行左侧带折线箭头标记）。
 */
const LayerRow: React.FC<{
  layer: EditorLayer;
  active: boolean;
  /** 选中对象落在图层还是蒙版（仅活动行有意义） */
  activeTarget: 'image' | 'mask';
  adjustFilter?: string;
  dragging: boolean;
  dropHint: DropPosition | null;
  /** 组成员缩进；组行本身不缩进 */
  indent?: boolean;
  /** 组行：缩略图位置显示文件夹 + 折叠箭头（成员可能藏在折叠里） */
  isGroup?: boolean;
  /** 按住 Alt 悬停：这行可剪贴/已剪贴 → alias 光标（行 class 里的 cursor-pointer 被它覆盖） */
  clipCursor?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onSelect: () => void;
  /** 点缩略图：选层并指定 target（图层本体 / 蒙版） */
  onSelectTarget: (target: 'image' | 'mask') => void;
  /** 链接/解链蒙版（链条按钮） */
  onToggleMaskLink: () => void;
  /** Shift+点蒙版缩略图：停用/启用蒙版（PS 同款） */
  onToggleMaskDisabled: () => void;
  /** Alt+点行：切换剪贴蒙版 */
  onToggleClip: () => void;
  onToggleVisible: () => void;
  onRename: (name: string) => void;
  onOpacityChange: (value: number) => void;
  onOpenOpacityEditor: (anchor: HTMLElement) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}> = ({
  layer,
  active,
  activeTarget,
  adjustFilter,
  dragging,
  dropHint,
  indent,
  isGroup,
  clipCursor,
  collapsed,
  onToggleCollapse,
  onSelect,
  onSelectTarget,
  onToggleMaskLink,
  onToggleMaskDisabled,
  onToggleClip,
  onToggleVisible,
  onRename,
  onOpacityChange,
  onOpenOpacityEditor,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layer.name);
  const opacity = layerOpacity(layer);
  const mask = layer.mask;
  // 选中框落点：PS 是给"被点的那个缩略图"描白边；无蒙版的层永远在图层缩略图上
  const imageThumbSelected = active && (!mask || activeTarget === 'image');
  const maskThumbSelected = active && !!mask && activeTarget === 'mask';

  const preview = useSyncExternalStore(subscribePreview, () =>
    peekPreview(buildLayerPreviewKey(layer) ?? ''),
  );
  const thumb = useEditorThumbnail(preview?.dataUrl, 96);

  // 每层的代理图按需生成（内部有并发闸与去重，重复调用是空操作）
  useEffect(() => {
    ensureLayerPreview(layer);
    // 只关心"内容变了"：拖动/旋转/调色都不该让缩略图重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.source, layer.naturalWidth, layer.naturalHeight]);

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== layer.name) onRename(next);
    else setDraft(layer.name);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!editing}
      onClick={e => {
        // Alt+点行 = 切换剪贴蒙版（PS 的 Alt+点分割线，这里放宽到整行）。
        // 缩略图/眼睛/链条这些子按钮自己 stopPropagation，不会走到这。
        if (e.altKey) {
          e.stopPropagation();
          onToggleClip();
          return;
        }
        onSelect();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      // 按住 Alt 时的剪贴提示光标（alias = "这里 Alt+点有意义"）；内联 style 覆盖
      // class 里的 cursor-pointer，松开 Alt 后回到 undefined = 恢复原光标
      style={clipCursor ? { cursor: 'alias' } : undefined}
      title={
        clipCursor
          ? `${layer.name}（Alt+点击 = ${layer.clipped ? '取消' : '建立'}剪贴蒙版）`
          : `${layer.name}（拖拽可调整顺序；Alt+点击 = 切换剪贴蒙版）`
      }
      className={[
        'relative flex items-center gap-1.5 px-1 py-1 rounded border cursor-pointer select-none',
        indent ? 'ml-5' : '',
        layer.clipped ? 'ml-2' : '',
        active
          ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800'
          : 'border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-700',
        dragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      {/* 拖放落点指示线：贴在行的上/下边缘 */}
      {dropHint && (
        <span
          className={`pointer-events-none absolute inset-x-0 h-0.5 rounded bg-blue-500 ${
            dropHint === 'above' ? '-top-[2px]' : '-bottom-[2px]'
          }`}
        />
      )}

      {/* 剪贴蒙版标记：PS 的左侧折线箭头（这层裁进下面的基础层） */}
      {layer.clipped && (
        <span className="shrink-0 -ml-0.5 text-blue-500 dark:text-blue-400" title="剪贴蒙版：只显示在下方基础层有像素处（Alt+点击可取消）">
          <CornerDownRight size={10} aria-hidden />
        </span>
      )}

      <button
        type="button"
        data-no-drag
        title={layer.visible ? '隐藏图层' : '显示图层'}
        aria-label={layer.visible ? '隐藏图层' : '显示图层'}
        onClick={e => {
          // 别让眼睛按钮顺带触发选中：PS 里点眼睛只切可见性，不改变当前图层
          e.stopPropagation();
          onToggleVisible();
        }}
        className="shrink-0 p-0.5 text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>

      {/* 图层缩略图：点击 = 选中图层本体（变换/删除作用到图层）。
          组行没有"本体"，点缩略图 = 切折叠（原来就是这个交互，只是外面套了按钮）。 */}
      <button
        type="button"
        data-no-drag
        title={isGroup ? (collapsed ? '展开组' : '折叠组') : '图层缩略图（点击选中图层本体）'}
        onClick={e => {
          e.stopPropagation();
          if (isGroup) onToggleCollapse?.();
          else onSelectTarget('image');
        }}
        className={[
          // 组行**不带缩略图底板**（用户 2026-10-24：去掉矩形背景只留图标），
          // 选中态交给整行高亮——透明底上再画白圈会像个悬空的空框
          isGroup
            ? 'w-8 h-8 shrink-0 flex items-center justify-center'
            : 'w-8 h-8 shrink-0 rounded-sm overflow-hidden flex items-center justify-center bg-neutral-200 dark:bg-neutral-700',
          layer.visible ? '' : 'opacity-40',
          // 选中对象的白边框（PS 同款）：活动行的"被点中那个缩略图"描边（组行除外）
          imageThumbSelected && !isGroup
            ? 'ring-2 ring-white ring-offset-0 outline outline-1 outline-blue-500'
            : '',
        ].join(' ')}
      >
        {isGroup ? (
          <span className="w-full h-full flex items-center justify-center gap-0.5 text-neutral-600 dark:text-neutral-300">
            {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
            <Folder size={12} />
          </span>
        ) : thumb ? (
          <img
            src={thumb.src}
            alt=""
            className="w-full h-full object-contain"
            style={{ filter: active ? adjustFilter : undefined }}
            draggable={false}
          />
        ) : (
          <ImageIcon size={12} className="text-neutral-400" />
        )}
      </button>

      {/*
        链条（链接/解链蒙版，PS 缩略图之间那个）与蒙版缩略图：
        无蒙版时都不占位（UI 设计 §4）。
      */}
      {!isGroup && mask && (
        <>
          <button
            type="button"
            data-no-drag
            title={
              mask.box
                ? '重新链接蒙版（蒙版回到跟图层同框同变换）｜当前已解链：拖动图层时蒙版留在原地'
                : '解链蒙版（变换不再联动）｜解链后拖图层不动蒙版、拖蒙版不动图层；点击瞬间画面不变是正常的（蒙版拿图层当前框拷贝起步）'
            }
            onClick={e => {
              e.stopPropagation();
              onToggleMaskLink();
            }}
            // 已解链 = 蓝色高亮：链条不是"蒙版开关"（蒙版永远生效，PS 同款），
            // 唯一的状态反馈就是这个图标翻转，10px 灰图标用户根本看不见（2026-10-24 反馈）
            className={[
              'shrink-0 p-0',
              mask.box
                ? 'text-blue-500 dark:text-blue-400'
                : 'text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200',
            ].join(' ')}
          >
            {mask.box ? <Unlink size={11} /> : <Link size={11} />}
          </button>
          <button
            type="button"
            data-no-drag
            title="蒙版缩略图：点击选中蒙版（白 = 显示 / 黑 = 隐藏）；Shift+点击 = 停用/启用蒙版"
            onClick={e => {
              e.stopPropagation();
              // Shift+点 = 停用/启用（PS 同款红叉）；普通点 = 选中蒙版
              if (e.shiftKey) {
                onToggleMaskDisabled();
                return;
              }
              onSelectTarget('mask');
            }}
            className={[
              'relative w-5 h-8 shrink-0 rounded-sm overflow-hidden border border-neutral-300 dark:border-neutral-600',
              layer.visible ? '' : 'opacity-40',
              maskThumbSelected ? 'ring-2 ring-white ring-offset-0 outline outline-1 outline-blue-500' : '',
            ].join(' ')}
            style={{
              backgroundImage: 'repeating-conic-gradient(#d0d0d0 0% 25%, #ffffff 0% 50%)',
              backgroundSize: '8px 8px',
            }}
          >
            <img
              src={convertFileSrc(mask.source)}
              alt=""
              className="w-full h-full object-cover"
              style={{ filter: 'grayscale(1)' }}
              draggable={false}
            />
            {/* 停用标记：PS 的红叉（蒙版数据还在，再 Shift+点恢复） */}
            {mask.disabled && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <X size={12} strokeWidth={3} className="text-red-500" aria-label="蒙版已停用" />
              </span>
            )}
          </button>
        </>
      )}

      {editing ? (
        <input
          autoFocus
          data-no-drag
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onFocus={e => e.currentTarget.select()}
          onClick={e => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              setDraft(layer.name);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 h-5 px-1 text-[11px] rounded border border-blue-400 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 outline-none"
        />
      ) : (
        <span
          onDoubleClick={e => {
            e.stopPropagation();
            setDraft(layer.name);
            setEditing(true);
          }}
          title="双击改名"
          className={[
            'flex-1 min-w-0 truncate text-[11px]',
            layer.visible
              ? 'text-neutral-700 dark:text-neutral-200'
              : 'text-neutral-400 dark:text-neutral-500 line-through',
          ].join(' ')}
        >
          {layer.name}
        </span>
      )}
      {(layer.lockPixel || layer.lockPosition) && (
        <span
          title={layer.lockPosition ? '已锁定位置' : '已锁定像素'}
          className="shrink-0 flex text-neutral-400 dark:text-neutral-500"
        >
          <Lock size={9} aria-hidden />
        </span>
      )}

      {/*
        混合模式下拉已移到面板顶部、作用于活动图层（用户 2026-10-24：不需要每行一个）。
        行内只保留不透明度数值（点/拖）。
      */}
      <OpacityScrub value={opacity} onChange={onOpacityChange} onOpenEditor={onOpenOpacityEditor} />
    </div>
  );
};

export const EditorPanel: React.FC<EditorPanelProps> = ({
  tabId,
  documentName,
  width,
  height,
  background,
  layers,
  activeLayerId,
  activeTarget,
  onSelectLayer,
  onSelectTarget,
  onLayersChange,
  adjust,
  onAdjustChange,
}) => {
  const adj = adjust ?? ZERO_ADJUSTMENTS;
  const hasAdjust = !isZeroAdjustments(adj);
  /** 与 ImageEditor 里定义的那个 SVG 滤镜同 id（跨子树引用同一份 filter 定义） */
  const adjustFilter = hasAdjust ? `url(#aurora-editor-adjust-${tabId})` : undefined;

  // 全览图的视口框需要编辑器画布的 scale/x/y —— 从共享 store 拿（rAF 节流）
  const view = useSyncExternalStore(subscribeEditorView, () => getEditorView(tabId));

  // 前/背景色（会话级 store，与选项条/画笔共用；D/X 快捷键在 useEditorKeyboard）
  const editorColors = useSyncExternalStore(subscribeEditorColors, getEditorColors);

  // ---- 全览图：整份文档的合成（PS 的 Navigator 语义） ----
  //
  // 走 `editor_render_document`：Rust 按**导出同一条路**（含调色/不透明度/蒙版、跳过
  // 隐藏层与被关掉的组）合成后降到 ≤2048。防抖 300ms——拖图层/拖滑杆时图层引用狂变，
  // 不能每帧合成一次。
  //
  // 载荷与导出**同一份构造**（`buildRenderGroups`）：编组落地后 Rust 的 DocumentRequest
  // 要的是 `groups` 分段，这里一度还在发旧的 `layers` 平铺形状——反序列化直接报
  // "missing field groups"，又被下面的 catch 吞掉，全览图静默失效（2026-10-24 修）。
  //
  // 依赖里用 `layers` 的**引用**而不是内容签名：App 里换选区是 `{...doc, activeLayerId}`，
  // layers 引用不变 ⇒ 换选区不重渲；改图层（可见性/顺序/几何/调色）才会换引用。
  const [overviewUrl, setOverviewUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const groups = buildRenderGroups(layers ?? []);
    if (!width || !height || groups.length === 0) {
      setOverviewUrl(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      // 全览在 Rust 读文件合成——先等画笔的后台烘焙落盘，否则概览落后于画面
      flushPaintBakes()
        .then(() =>
          invoke<DocumentRender>('editor_render_document', {
            doc: {
              canvas: { width, height, background: background ?? 'transparent' },
              groups,
            },
          }),
        )
        .then(res => {
          if (!cancelled) setOverviewUrl(res.dataUrl);
        })
        .catch(() => {
          /* 概览失败不打扰编辑：保留上一张，面板行缩略图仍然可用 */
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [layers, width, height, background]);

  // 全览图用较长边的缩略（320 足够 20rem 面板宽度）
  const navigatorThumb = useEditorThumbnail(overviewUrl, 320);

  /**
   * 面板显示结构（自顶向下）：组行先出现、成员缩进随后，折叠时成员不渲染。
   * 与自底向上数组的分段（`splitSegments`）是同一件事的两个方向。
   */
  const list = useMemo(() => {
    const down = layersTopDown(layers ?? []);
    const out: { layer: EditorLayer; indent: boolean; isGroup: boolean }[] = [];
    for (let i = 0; i < down.length; i += 1) {
      const l = down[i];
      if (isGroupRow(l)) {
        out.push({ layer: l, indent: false, isGroup: true });
        // 成员段跳过（折叠不显示；展开时以缩进行插入）
        let k = i + 1;
        while (k < down.length && down[k].groupId === l.id) {
          if (!l.collapsed) out.push({ layer: down[k], indent: true, isGroup: false });
          k += 1;
        }
        i = k - 1;
      } else {
        out.push({ layer: l, indent: false, isGroup: false });
      }
    }
    return out;
  }, [layers]);
  /** 活动图层：`activeLayerId` 指向的层；指向已删的层时退回顶层（与 `resolveActiveLayer` 同义） */
  const active = useMemo(() => {
    const all = layers ?? [];
    return all.find(l => l.id === activeLayerId) ?? all[all.length - 1];
  }, [layers, activeLayerId]);

  // ---- 拖拽排序 ----
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);

  const clearDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const emit = (next: { layers: EditorLayer[]; activeLayerId?: string }) => {
    if (!onLayersChange) return;
    if (next.layers === (layers ?? [])) return; // 没变化（放回原位等）就别置 dirty
    onLayersChange(next);
  };

  const handleDrop = () => {
    if (!draggingId || !dropTarget || draggingId === dropTarget.id) {
      clearDrag();
      return;
    }
    const next = reorderLayers(layers ?? [], draggingId, dropTarget.id, dropTarget.position);
    emit({ layers: next, activeLayerId });
    clearDrag();
  };

  // ---- 不透明度输入弹窗 ----
  const [opacityEditor, setOpacityEditor] = useState<{
    layerId: string;
    value: number;
    top: number;
    left: number;
  } | null>(null);

  const openOpacityEditor = (layer: EditorLayer, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    // 右对齐到数值，再夹进视口：面板贴着窗口右缘，不夹的话弹窗会有一半在屏幕外
    const left = Math.min(
      Math.max(8, rect.right - POPOVER_WIDTH),
      Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
    );
    setOpacityEditor({
      layerId: layer.id,
      value: layerOpacity(layer),
      top: Math.min(rect.bottom + 6, window.innerHeight - 76),
      left,
    });
  };

  const setOpacity = (layerId: string, value: number) => {
    emit({ layers: setLayerOpacity(layers ?? [], layerId, value), activeLayerId });
  };

  const setBlend = (layerId: string, mode: BlendMode) => {
    emit({ layers: setLayerBlend(layers ?? [], layerId, mode), activeLayerId });
  };

  const setLock = (
    layerId: string,
    kind: 'transparent' | 'pixel' | 'position',
    on: boolean,
  ) => {
    emit({ layers: setLayerLock(layers ?? [], layerId, kind, on), activeLayerId });
  };

  // ---- 蒙版（useEditorMask）：添加 = 选一张图片（白 = 显示 / 黑 = 隐藏），
  //      删除 = 摘掉（可撤销）。组行不支持蒙版（组蒙版等嵌套组那批）。
  //      添加/删除后把选中对象切到蒙版（PS：刚建的蒙版处于选中态）。 ----
  const { addMask, removeMask, busy: maskBusy } = useEditorMask(
    active,
    layers ?? [],
    activeLayerId,
    emit,
    (layerId, target) => onSelectTarget?.(layerId, target),
  );
  const canAddMask = !!active && !isGroupRow(active) && !!active.source && !maskBusy;

  /** 链接/解链蒙版（行内链条；解链给蒙版一份图层框拷贝起步）。 */
  const handleToggleMaskLink = (layerId: string) => {
    emit({ layers: toggleMaskLink(layers ?? [], layerId), activeLayerId });
  };

  /** Shift+点蒙版缩略图：停用/启用蒙版（红叉；停用 = 不参与合成但数据保留）。 */
  const handleToggleMaskDisabled = (layerId: string) => {
    emit({ layers: toggleMaskDisabled(layers ?? [], layerId), activeLayerId });
  };

  /**
   * 新建空白图层（画笔轮，2026-10-25 起即时路径）：预分配烘焙路径、把空白画布
   * 登记进缓冲注册表（画面立刻由 canvas 直染），PNG 文件由后台烘焙补上。
   */
  const handleCreateBlankLayer = async () => {
    if (!width || !height) return;
    try {
      const path = await allocatePaintPath();
      const canvas = blankCanvas(width, height);
      rememberPaintBuffer(path, canvas);
      enqueueBake(() => bakeCanvasToPath(canvas, path));
      const id = createLayerId();
      const blank: EditorLayer = {
        id,
        name: `图层 ${(layers ?? []).length + 1}`,
        source: path,
        naturalWidth: width,
        naturalHeight: height,
        box: createIdentityBox(width, height),
        visible: true,
      };
      // 自底向上数组：顶层 = 末尾（组行若在末尾也照常压在其上，平层段）
      emit({ layers: [...(layers ?? []), blank], activeLayerId: id });
    } catch (e) {
      console.warn('新建空白图层失败', e);
    }
  };

  /** Alt+点行：切换剪贴蒙版（不可剪贴时 toggleClipped 原样返回、不置 dirty）。 */
  const handleToggleClip = (layerId: string) => {
    emit({ layers: toggleClipped(layers ?? [], layerId), activeLayerId });
  };

  // Alt 按住态（悬停指示用）：可剪贴/已剪贴的行在按住 Alt 时换 `alias` 光标——
  // 剪贴的入口是 Alt+点行，没有独立按钮，光标是"这行现在能 Alt+点"的唯一提示
  // （用户 2026-10-24 反馈"光标还是手指，看不出有这功能"）。blur 兜底：Alt+Tab
  // 切走会漏掉 keyup，不清就永远卡在 alias。
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const setTo = (held: boolean) => (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(held);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', setTo(true));
    window.addEventListener('keyup', setTo(false));
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', setTo(true));
      window.removeEventListener('keyup', setTo(false));
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ---- 其余图层操作（都作用于活动图层） ----
  const handleToggleVisible = (layer: EditorLayer) => {
    emit({ layers: setLayerVisible(layers ?? [], layer.id, !layer.visible), activeLayerId });
  };

  const handleDelete = () => {
    if (!active) return;
    // **有蒙版先删蒙版**（用户口径 2026-10-24：只留一个删除按钮，蒙版优先，
    // 不看选中对象在哪）——removeMask 里会把选中对象切回图层本体
    if (!isGroupRow(active) && active.mask) {
      removeMask();
      return;
    }
    // 活动层是**组行** → 删组连带成员（PS 的"组和内容"）；普通层照旧单删
    if (isGroupRow(active)) {
      emit({ layers: deleteGroupWithMembers(layers ?? [], active.id), activeLayerId: undefined });
      return;
    }
    const r = removeLayer(layers ?? [], active.id, activeLayerId);
    if (r.layers === (layers ?? [])) return;
    emit(r);
  };

  const handleDuplicate = () => {
    if (!active) return;
    const r = duplicateLayer(layers ?? [], active.id, createLayerId());
    if (!r.newLayerId) return;
    // 复制出来的层成为活动层（PS：Ctrl+J 之后编辑的是副本）
    emit({ layers: r.layers, activeLayerId: r.newLayerId });
  };

  const handleRename = (layer: EditorLayer, name: string) => {
    emit({
      layers: (layers ?? []).map(l => (l.id === layer.id ? { ...l, name } : l)),
      activeLayerId,
    });
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto bg-panel">
      {/* 全览（PS 的 Navigator，置顶） */}
      <Section title="全览">
        <EditorNavigator
          thumb={navigatorThumb}
          // 用**画布**尺寸而不是缩略图尺寸：编辑器的视口状态（scale/x/y）也是按画布算的，
          // 两边口径不一致时，全览图里的视口框会按错误比例画出来
          imgWidth={width}
          imgHeight={height}
          view={view}
          onNavigate={(x, y) => requestPanTo(tabId, x, y)}
          // 不叠 adjustFilter：合成图已经把每层的调色烤进去了
        />
      </Section>

      {/* 属性 · 调整 */}
      <Section title="属性 · 调整">
        <Row label="文档" value={documentName.length > 16 ? `${documentName.slice(0, 16)}…` : documentName} />
        <Row label="画布" value={`${width} × ${height}`} />
        <div className="pt-1 space-y-2">
          <Slider
            label="亮度"
            value={adj.brightness}
            onChange={v => onAdjustChange({ ...adj, brightness: v })}
            onReset={() => onAdjustChange({ ...adj, brightness: 0 })}
          />
          <Slider
            label="对比度"
            value={adj.contrast}
            onChange={v => onAdjustChange({ ...adj, contrast: v })}
            onReset={() => onAdjustChange({ ...adj, contrast: 0 })}
          />
          <Slider
            label="饱和度"
            value={adj.saturation}
            onChange={v => onAdjustChange({ ...adj, saturation: v })}
            onReset={() => onAdjustChange({ ...adj, saturation: 0 })}
          />
          <Slider
            label="色温"
            value={adj.temperature}
            onChange={v => onAdjustChange({ ...adj, temperature: v })}
            onReset={() => onAdjustChange({ ...adj, temperature: 0 })}
          />
        </div>
        {hasAdjust && (
          <button
            type="button"
            onClick={() => onAdjustChange(ZERO_ADJUSTMENTS)}
            className="w-full h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            重置全部调整
          </button>
        )}
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          实时预览由显卡完成（拖动零延迟）；导出时 Rust 按同一套颜色矩阵重算，
          所见即所得。双击滑杆标签可单项归零。
        </p>
      </Section>

      {/* 颜色（2026-10-24 画笔轮起为真控件：前/背景色是会话级 store，订阅在组件顶部） */}
      <Section title="颜色">
        <div className="flex items-center gap-2">
          {/* 前景色（画笔画它；蒙版上画它的亮度）：label 包住透明 color input */}
          <label className="relative w-8 h-8 cursor-pointer" title="前景色（画笔画它；蒙版上画它的亮度）">
            <span
              className="absolute left-0 top-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500"
              style={{ backgroundColor: editorColors.foreground }}
            />
            <input
              type="color"
              value={editorColors.foreground}
              onChange={e => setForeground(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
          <label className="relative w-8 h-8 cursor-pointer" title="背景色（橡皮在蒙版上画它的亮度）">
            <span
              className="absolute right-0 bottom-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500"
              style={{ backgroundColor: editorColors.background }}
            />
            <input
              type="color"
              value={editorColors.background}
              onChange={e => setBackground(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
          <button
            type="button"
            title="交换前景/背景（X）"
            onClick={swapEditorColors}
            className="p-1 rounded text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <ArrowLeftRight size={12} />
          </button>
          <button
            type="button"
            title="复位为黑/白（D）"
            onClick={resetEditorColors}
            className="px-1.5 h-6 rounded text-[10px] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            复位
          </button>
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          前景 {editorColors.foreground} · 背景 {editorColors.background}
          ——画笔用前景色，橡皮在蒙版上画背景色的亮度；D 复位黑白 · X 交换。
          色板与吸管（I）后续接入。
        </p>
      </Section>

      {/* 文字（仅选中文字图层时出现，Phase 2） */}
      <Section title="文字" defaultOpen={false} hint="选中文字图层后可用">
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          字体、字号、行距、描边、阴影——随文字工具一起在 Phase 2 接入。
        </p>
      </Section>

      {/* 图层（用户要求沉到最下；与 PS 的默认面板栈一致） */}
      <Section title="图层" hint={`${list.length} 个`}>
        {/* 混合模式：作用于**活动图层**，放面板顶部（PS 同款；用户 2026-10-24
            要求从每行的卡片里移上来）。交互不变：点开全铺、悬停滚轮直接换档、
            画布实时变。无活动层时整块灰掉。 */}
        <div className={`flex items-center gap-2 ${active ? '' : 'pointer-events-none opacity-50'}`}>
          <span className="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400 select-none">
            混合模式
          </span>
          <BlendSelect
            value={active ? layerBlend(active) : 'normal'}
            onChange={mode => {
              if (active) setBlend(active.id, mode);
            }}
          />
        </div>

        {/* 顶部 = 锁定四格（PS 的锁在面板顶部）；**复制/删除在面板底部右侧**（PS 同款，
            用户 2026-10-24）。排序没有按钮了，直接拖卡片；「新建空白图层」的灰按钮也撤了
            ——空白层要等画笔，留着只是噪音。
            锁定四格照 PS（作用**选中层**）：锁透明像素要等画笔/填充才有意义，灰显占位。
            锁像素/锁位置的交互拦在 ImageEditor：锁位置 = 拖不动；锁像素/锁位置 = Ctrl+T
            进不去。锁开关不进撤销栈（PS 一致）。 */}
        <div className="flex items-center gap-1">
          <PanelIconButton
            icon={Grid2x2}
            title="锁定透明像素（画笔只画进已有像素；橡皮禁用）"
            on={!!active && layerLocks(active).transparent}
            disabled={!active}
            onClick={() => active && setLock(active.id, 'transparent', !layerLocks(active).transparent)}
          />
          <PanelIconButton
            icon={FolderPlus}
            title="编组（把选中图层打包成组）"
            on={false}
            disabled={!active || isGroupRow(active)}
            onClick={() => {
              if (!active || isGroupRow(active)) return;
              const ids = activeLayerId
                ? [activeLayerId]
                : active
                  ? [active.id]
                  : [];
              emit({ layers: createGroup(layers ?? [], ids), activeLayerId: undefined });
            }}
          />
          <PanelIconButton
            icon={FolderMinus}
            title={active && isGroupRow(active) ? '取消编组（保留成员）' : '取消编组（选中组或组内图层）'}
            on={false}
            disabled={!active || (!isGroupRow(active) && !active.groupId)}
            onClick={() => {
              if (!active) return;
              const gid = isGroupRow(active) ? active.id : active.groupId;
              if (!gid) return;
              emit({
                layers: ungroup(layers ?? [], gid),
                activeLayerId: undefined,
              });
            }}
          />
          <PanelIconButton
            icon={Brush}
            title="锁定像素（禁自由变换；等画笔接入后也归这格管）"
            on={!!active && layerLocks(active).pixel}
            disabled={!active}
            onClick={() => active && setLock(active.id, 'pixel', !layerLocks(active).pixel)}
          />
          <PanelIconButton
            icon={Move}
            title="锁定位置（禁移动与变换）"
            on={!!active && layerLocks(active).position}
            disabled={!active}
            onClick={() => active && setLock(active.id, 'position', !layerLocks(active).position)}
          />
          <PanelIconButton
            icon={Lock}
            title={active && layerLocks(active).pixel && layerLocks(active).position ? '全部解锁' : '锁定全部'}
            on={!!active && layerLocks(active).pixel && layerLocks(active).position}
            disabled={!active}
            onClick={() => {
              if (!active) return;
              const allOn = layerLocks(active).pixel && layerLocks(active).position;
              setLock(active.id, 'pixel', !allOn);
              setLock(active.id, 'position', !allOn);
            }}
          />
        </div>

        {list.length === 0 ? (
          <div className="flex items-center gap-2 px-1.5 py-2 rounded border border-dashed border-neutral-300 dark:border-neutral-600 text-[11px] text-neutral-400">
            <ImageIcon size={12} /> 空文档，还没有图层
          </div>
        ) : (
          // 列表自己滚：十个图层不该把整个面板撑到看不见全览图
          <div className="max-h-56 overflow-y-auto space-y-0.5 -mx-1 px-1 pb-1">
            {list.map(({ layer, indent, isGroup: isGrp }) => (
              <LayerRow
                key={layer.id}
                layer={layer}
                indent={indent}
                isGroup={isGrp}
                clipCursor={
                  !isGrp && altHeld && (layer.clipped === true || canClipLayer(layers ?? [], layer.id))
                }
                collapsed={layer.collapsed === true}
                onToggleCollapse={() =>
                  // 折叠是纯 UI 态，不进撤销签名，但要真的写回文档（这里原来只算不发）
                  emit({
                    layers: setGroupCollapsed(layers ?? [], layer.id, layer.collapsed !== true),
                    activeLayerId,
                  })
                }
                active={active?.id === layer.id}
                activeTarget={activeTarget === 'mask' ? 'mask' : 'image'}
                adjustFilter={adjustFilter}
                dragging={draggingId === layer.id}
                dropHint={
                  draggingId && dropTarget?.id === layer.id && draggingId !== layer.id
                    ? dropTarget.position
                    : null
                }
                onSelect={() => onSelectLayer?.(layer.id)}
                onSelectTarget={target => {
                  // 点缩略图 = 选层 + 指定 target；行高亮/撤销栈都不受影响（选区不算改动）
                  onSelectTarget?.(layer.id, target);
                }}
                onToggleMaskLink={() => handleToggleMaskLink(layer.id)}
                onToggleMaskDisabled={() => handleToggleMaskDisabled(layer.id)}
                onToggleClip={() => handleToggleClip(layer.id)}
                onToggleVisible={() => handleToggleVisible(layer)}
                onRename={name => handleRename(layer, name)}
                onOpacityChange={value => setOpacity(layer.id, value)}
                onOpenOpacityEditor={anchor => openOpacityEditor(layer, anchor)}
                onDragStart={e => {
                  // 眼睛 / 不透明度数值 / 改名输入框都不该拖整行
                  if ((e.target as HTMLElement).closest('[data-no-drag]')) {
                    e.preventDefault();
                    return;
                  }
                  // 组行 / 组成员禁拖：跨组拖拽会破坏连续段（v1 待办，见进度文档），
                  // 折叠状态下拖动更会把"看不见的成员"甩出组外
                  if (isGrp || layer.groupId) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', layer.id);
                  setDraggingId(layer.id);
                }}
                onDragOver={e => {
                  if (!draggingId || draggingId === layer.id) return;
                  e.preventDefault(); // 不 preventDefault 浏览器不给 drop
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const position: DropPosition =
                    e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                  if (dropTarget?.id !== layer.id || dropTarget.position !== position) {
                    setDropTarget({ id: layer.id, position });
                  }
                }}
                onDrop={e => {
                  e.preventDefault();
                  handleDrop();
                }}
                onDragEnd={clearDrag}
              />
            ))}
          </div>
        )}

        {/* 底部按钮排（PS 的图层面板底部同款）：左侧 新建空白图层 + 添加蒙版，
            右侧复制/删除。**没有单独的"删蒙版"按钮**——删除蒙版优先走右下角那个
            删除：有蒙版时点它先删蒙版，再点才删图层。w-8 容器约束 PanelIconButton
            的 flex-1——按钮固定 32px 宽。 */}
        <div className="flex items-center gap-1 mt-2">
          <div className="w-8 flex">
            <PanelIconButton
              icon={Plus}
              title="新建空白图层（画布大小，可直接作画）"
              onClick={() => void handleCreateBlankLayer()}
              disabled={!width || !height}
            />
          </div>
          <div className="w-8 flex">
            <PanelIconButton
              icon={Contrast}
              title={
                active?.mask
                  ? '更换图层蒙版（选另一张图片）'
                  : '添加图层蒙版（选一张图片：白 = 显示 / 黑 = 隐藏）'
              }
              onClick={() => void addMask()}
              disabled={!canAddMask}
            />
          </div>
          <div className="flex-1" />
          <div className="w-8 flex">
            <PanelIconButton icon={Copy} title="复制图层" onClick={handleDuplicate} disabled={!active} />
          </div>
          <div className="w-8 flex">
            <PanelIconButton
              icon={Trash2}
              title={active?.mask ? '删除图层蒙版（再点一次删图层）' : '删除图层（Delete）'}
              onClick={handleDelete}
              disabled={!active}
              danger
            />
          </div>
        </div>

        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          拖拽卡片可调整上下顺序；点右侧百分比可输入数值，按住左右拖可快速调节。删除
          （右下角按钮 / <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-600 text-[9px]">Delete</kbd>
          ）：图层带蒙版时先删蒙版，再按一次才删图层。蒙版：点缩略图切换选中图层/蒙版，
          <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-600 text-[9px]">Shift+点</kbd>{' '}
          蒙版缩略图 = 停用/启用（红叉），链条可解链（各自独立移动），作画要等画笔。
          混合模式在面板顶部，作用于选中图层（悬停滚轮换档）。剪贴蒙版：选上层后{' '}
          <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-600 text-[9px]">Alt+点击</kbd>{' '}
          该行（按住 Alt 时行会换光标）或{' '}
          <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-600 text-[9px]">Ctrl+Alt+G</kbd>
          ——上层只显示在下方基础层有像素处。
        </p>
      </Section>

      {/* 不透明度输入弹窗：**portal 到 body**。右面板容器有 transform（滑入动画）+
          overflow-hidden，fixed 定位的后代会被它当作定位基准并裁掉——这就是
          "点百分比没弹窗"的原因（用户实测）。挂到 body 才真正浮在最上层。 */}
      {opacityEditor &&
        createPortal(
          <OpacityPopover
          value={opacityEditor.value}
          top={opacityEditor.top}
          left={opacityEditor.left}
          onChange={v => {
            // 弹窗里改了值：本地副本跟上，免得弹窗自己显示旧数字
            setOpacityEditor(prev => (prev ? { ...prev, value: v } : prev));
            setOpacity(opacityEditor.layerId, v);
          }}
          onClose={() => setOpacityEditor(null)}
            />,
            document.body,
          )}
    </div>
  );
};
