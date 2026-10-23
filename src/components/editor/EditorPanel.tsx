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
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Trash2,
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
  createLayerId,
  duplicateLayer,
  layerOpacity,
  layersTopDown,
  layerBlend,
  removeLayer,
  reorderLayers,
  setLayerBlend,
  setLayerOpacity,
  setLayerVisible,
} from './layerModel';
import { BLEND_MODES, BlendMode, blendModeLabel, normalizeBlendMode } from './blendModes';
import { ensureLayerPreview } from './layerProxy';
import { composeMatrix } from './layerTransform';

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
  /** 选中图层（只改选区，不算改动，不置 dirty） */
  onSelectLayer?: (id: string) => void;
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

/** 图层面板的操作按钮（现在都在列表**上方**）。 */
const ToolButton: React.FC<{
  icon: LucideIcon;
  title: string;
  label?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}> = ({ icon: Icon, title, label, onClick, disabled, danger }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
    className={[
      'h-7 flex-1 flex items-center justify-center gap-1 rounded border text-[11px] transition-colors',
      disabled
        ? 'border-neutral-200 dark:border-neutral-700 text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
        : danger
          ? 'border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400'
          : 'border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700',
    ].join(' ')}
  >
    <Icon size={12} />
    {label}
  </button>
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
 */
const LayerRow: React.FC<{
  layer: EditorLayer;
  active: boolean;
  adjustFilter?: string;
  dragging: boolean;
  dropHint: DropPosition | null;
  onSelect: () => void;
  onToggleVisible: () => void;
  onRename: (name: string) => void;
  onBlendChange: (mode: BlendMode) => void;
  onOpacityChange: (value: number) => void;
  onOpenOpacityEditor: (anchor: HTMLElement) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}> = ({
  layer,
  active,
  adjustFilter,
  dragging,
  dropHint,
  onSelect,
  onToggleVisible,
  onRename,
  onBlendChange,
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
  const blend = layerBlend(layer);

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
      onClick={onSelect}
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
      title={`${layer.name}（拖拽可调整顺序）`}
      className={[
        'relative flex items-center gap-1.5 px-1 py-1 rounded border cursor-pointer select-none',
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

      <div
        className={[
          'w-8 h-8 shrink-0 rounded-sm overflow-hidden flex items-center justify-center',
          'bg-neutral-200 dark:bg-neutral-700',
          layer.visible ? '' : 'opacity-40',
        ].join(' ')}
      >
        {thumb ? (
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
      </div>

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

      {/*
        混合模式（自定义下拉，见 `BlendSelect`）：名字与 CSS `mix-blend-mode` 同名，
        预览与导出共用这一个字符串。展开后**悬停滚轮直接换档**、画布实时预览。
      */}
      <BlendSelect value={blend} onChange={onBlendChange} />

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
  onSelectLayer,
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

  // ---- 全览图：整份文档的合成（PS 的 Navigator 语义） ----
  //
  // 走 `editor_render_document`：Rust 按**导出同一条路**（含调色/不透明度、跳过隐藏层）
  // 合成后降到 ≤2048。防抖 300ms——拖图层/拖滑杆时图层引用狂变，不能每帧合成一次。
  //
  // 依赖里用 `layers` 的**引用**而不是内容签名：App 里换选区是 `{...doc, activeLayerId}`，
  // layers 引用不变 ⇒ 换选区不重渲；改图层（可见性/顺序/几何/调色）才会换引用。
  const [overviewUrl, setOverviewUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const all = layers ?? [];
    const renderable = all.filter(l => l.source && l.visible);
    if (!width || !height || renderable.length === 0) {
      setOverviewUrl(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<DocumentRender>('editor_render_document', {
        doc: {
          canvas: { width, height, background: background ?? 'transparent' },
          layers: renderable.map(l => ({
            path: l.source,
            matrix: composeMatrix(l.box, { width: l.naturalWidth, height: l.naturalHeight }),
            adjust: l.adjust ?? null,
            opacity: layerOpacity(l),
          })),
        },
      })
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

  const list = useMemo(() => layersTopDown(layers ?? []), [layers]);
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

  // ---- 其余图层操作（都作用于活动图层） ----
  const handleToggleVisible = (layer: EditorLayer) => {
    emit({ layers: setLayerVisible(layers ?? [], layer.id, !layer.visible), activeLayerId });
  };

  const handleDelete = () => {
    if (!active) return;
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

      {/* 颜色 */}
      <Section title="颜色" defaultOpen={false}>
        <div className="flex items-center gap-2">
          <div className="relative w-8 h-8">
            <div
              className="absolute left-0 top-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500 bg-black"
              title="前景色"
            />
            <div
              className="absolute right-0 bottom-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500 bg-white"
              title="背景色"
            />
          </div>
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-tight">
            前景 #000000
            <br />
            背景 #FFFFFF
          </div>
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
          色板与吸管结果在 Phase 2 接入。
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
        {/* 操作条在**列表上方**（用户 2026-10-24 验收意见）。排序没有按钮了，直接拖卡片；
            「新建空白图层」的灰按钮也撤了——空白层要等画笔，留着只是噪音。 */}
        <div className="flex items-center gap-1">
          <ToolButton icon={Copy} title="复制图层" label="复制" onClick={handleDuplicate} disabled={!active} />
          <ToolButton
            icon={Trash2}
            title="删除图层（Delete）"
            label="删除"
            onClick={handleDelete}
            disabled={!active}
            danger
          />
        </div>

        {list.length === 0 ? (
          <div className="flex items-center gap-2 px-1.5 py-2 rounded border border-dashed border-neutral-300 dark:border-neutral-600 text-[11px] text-neutral-400">
            <ImageIcon size={12} /> 空文档，还没有图层
          </div>
        ) : (
          // 列表自己滚：十个图层不该把整个面板撑到看不见全览图
          <div className="max-h-56 overflow-y-auto space-y-0.5 -mx-1 px-1 pb-1">
            {list.map(layer => (
              <LayerRow
                key={layer.id}
                layer={layer}
                active={active?.id === layer.id}
                adjustFilter={adjustFilter}
                dragging={draggingId === layer.id}
                dropHint={
                  draggingId && dropTarget?.id === layer.id && draggingId !== layer.id
                    ? dropTarget.position
                    : null
                }
                onSelect={() => onSelectLayer?.(layer.id)}
                onToggleVisible={() => handleToggleVisible(layer)}
                onRename={name => handleRename(layer, name)}
                onBlendChange={mode => setBlend(layer.id, mode)}
                onOpacityChange={value => setOpacity(layer.id, value)}
                onOpenOpacityEditor={anchor => openOpacityEditor(layer, anchor)}
                onDragStart={e => {
                  // 眼睛 / 不透明度数值 / 改名输入框都不该拖整行
                  if ((e.target as HTMLElement).closest('[data-no-drag]')) {
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

        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          拖拽卡片可调整上下顺序；点右侧百分比可输入数值，按住左右拖可快速调节；选中图层后按{' '}
          <kbd className="px-1 rounded border border-neutral-300 dark:border-neutral-600 text-[9px]">
            Delete
          </kbd>{' '}
          删除。导入图层请点文档栏的「图片 +」图标；新建空白图层要等画笔/填充；混合模式展开后悬停滚轮可直接换档。
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
