/**
 * 工具栏(左侧竖排):工具组按钮 + 前/背景色芯片。
 * 工具组子形态(photocraft 上游口径):同组共享一个槽位与快捷键,组内最近使用的
 * 形态显示为图标;**右键/长按工具图标**弹出子形态菜单(选框组=矩形/椭圆,
 * 套索组=自由/多边形),双击=组内循环。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, RotateCcw } from 'lucide-react';
import type { EditorTool } from './editorTypes';
import { EditorIcon, type EditorIconName } from './editorIcons';
import { getSession, setOptions, setTool, subscribeSession, runCommand } from './editorStore';
import { nextLassoTool, nextMarqueeShape } from './toolLogic';

/** 选框组子形态(M 键组内循环,PS 口径四形态;图标=上游 assets/icons 同名)。 */
const MARQUEE_SHAPES: { shape: 'rect' | 'ellipse' | 'row' | 'column'; label: string; icon: EditorIconName }[] = [
  { shape: 'rect', label: '矩形选框 (M)', icon: 'square-dashed' },
  { shape: 'ellipse', label: '椭圆选框 (M)', icon: 'ellipse-dashed' },
  { shape: 'row', label: '单行选框 (M)', icon: 'marquee-row' },
  { shape: 'column', label: '单列选框 (M)', icon: 'marquee-column' },
];

/** 套索组子工具(L 键组内循环)。 */
const LASSO_TOOLS: { tool: EditorTool; label: string; icon: EditorIconName }[] = [
  { tool: 'lasso', label: '套索 (L)', icon: 'lasso' },
  { tool: 'polygonLasso', label: '多边形套索 (L)', icon: 'pentagon' },
  { tool: 'magneticLasso', label: '磁性套索 (L)', icon: 'lasso-magnetic' },
];

const GROUPS: { tool: EditorTool; label: string; icon: EditorIconName }[] = [
  { tool: 'move', label: '移动 (V)', icon: 'move' },
  { tool: 'crop', label: '裁剪 (C)', icon: 'crop' },
  { tool: 'eyedropper', label: '吸管 (I)', icon: 'pipette' },
  { tool: 'brush', label: '画笔 (B)', icon: 'brush' },
  { tool: 'eraser', label: '橡皮擦 (E)', icon: 'eraser' },
  { tool: 'gradient', label: '渐变 (G)', icon: 'gradient' },
  { tool: 'bucket', label: '油漆桶 (K)', icon: 'paint-bucket' },
  { tool: 'blur', label: '模糊 (R)', icon: 'droplet' },
  { tool: 'sharpen', label: '锐化 (U)', icon: 'triangle' },
  { tool: 'smudge', label: '涂抹 (S)', icon: 'pointer' },
  { tool: 'hand', label: '抓手 (H)', icon: 'hand' },
  { tool: 'zoom', label: '缩放 (Z)', icon: 'zoom-in' },
];

const rgbaCss = (c: number[] | undefined): string => {
  if (!c || c.length < 3) return '#000000';
  const [r, g, b] = c;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
};

export const EditorToolbar: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  /** 子形态弹层(屏幕坐标 + 归属组;fixed 定位,不被工具栏 overflow 裁剪/被画布盖住)。 */
  const [menu, setMenu] = useState<{ kind: 'marquee' | 'lasso'; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 长按弹层(上游 0.35s 口径):计时器 + "本次长按已开弹层"标记(抑制定击的选工具)。 */
  const pressTimer = useRef<number | null>(null);
  const pressPosRef = useRef({ x: 0, y: 0 });
  const pressOpenedRef = useRef(false);

  // 点菜单外关闭子形态弹层
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  if (!s) return null;

  const onKey = (which: 'swap' | 'reset') => {
    void runCommand(tabId, which === 'swap' ? 'tools.swapColors' : 'tools.defaultColors', {}).catch(console.error);
  };

  const marqueeShape = s.options.marqueeShape;
  const marqueeIcon = MARQUEE_SHAPES.find((m) => m.shape === marqueeShape)?.icon ?? 'square-dashed';
  const shapeLabel = MARQUEE_SHAPES.find((m) => m.shape === marqueeShape)?.label ?? '矩形选框 (M)';
  const pickMarquee = (shape: 'rect' | 'ellipse' | 'row' | 'column') => {
    setOptions(tabId, { marqueeShape: shape });
    setTool(tabId, 'marquee');
    setMenu(null);
  };
  const lassoActive = LASSO_TOOLS.find((t) => t.tool === s.tool) ?? LASSO_TOOLS[0];
  const pickLasso = (tool: EditorTool) => {
    setTool(tabId, tool);
    setMenu(null);
  };
  /** 长按 0.35s 开弹层(上游 panels.rs 口径);短按仍走 onClick 选工具。 */
  const startPress = (kind: 'marquee' | 'lasso') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pressPosRef.current = { x: r.right + 4, y: r.top };
    pressOpenedRef.current = false;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      pressOpenedRef.current = true;
      setMenu({ kind, ...pressPosRef.current });
    }, 350);
  };
  const endPress = () => {
    if (pressTimer.current != null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  /** 组槽位公共 props:长按/右键弹层 + 双击循环 + 短按选中(长按刚开弹层时抑制)。 */
  const groupSlot = (kind: 'marquee' | 'lasso', title: string, onDoubleClick: () => void, onShortClick: () => void) => ({
    title: `${title} — 右键/长按切换形态`,
    onClick: () => {
      if (pressOpenedRef.current) {
        pressOpenedRef.current = false;
        return;
      }
      onShortClick();
    },
    onPointerDown: startPress(kind),
    onPointerUp: endPress,
    onPointerLeave: endPress,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      endPress();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ kind, x: r.right + 4, y: r.top });
    },
    onDoubleClick,
  });

  return (
    <div className="w-11 shrink-0 flex flex-col items-center gap-0.5 py-1.5 bg-panel border-r border-black/10 dark:border-white/10 select-none overflow-y-auto">
      <button
        key="marquee"
        {...groupSlot(
          'marquee',
          shapeLabel,
          () => setOptions(tabId, { marqueeShape: nextMarqueeShape(marqueeShape) }),
          () => setTool(tabId, 'marquee'),
        )}
        className={`w-9 h-9 shrink-0 rounded flex items-center justify-center transition-colors ${
          s.tool === 'marquee'
            ? 'bg-sky-600 text-white'
            : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        <EditorIcon name={marqueeIcon} />
      </button>
      {menu?.kind === 'marquee' && (
        <div ref={menuRef} className="fixed z-[80] w-36 py-0.5 rounded-md shadow-lg bg-surface border border-black/10 dark:border-white/15" style={{ left: menu.x, top: menu.y }}>
          {MARQUEE_SHAPES.map(({ shape, label, icon }) => (
            <button
              key={shape}
              onClick={() => pickMarquee(shape)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left rounded-sm ${
                marqueeShape === shape
                  ? 'text-sky-700 dark:text-sky-300'
                  : 'text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <EditorIcon name={icon} size={15} />
              {label}
            </button>
          ))}
        </div>
      )}
      <button
        key="lasso"
        {...groupSlot(
          'lasso',
          lassoActive.label,
          () => setTool(tabId, nextLassoTool(s.tool)),
          () => setTool(tabId, lassoActive.tool),
        )}
        className={`w-9 h-9 shrink-0 rounded flex items-center justify-center transition-colors ${
          lassoActive.tool === s.tool
            ? 'bg-sky-600 text-white'
            : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        <EditorIcon name={lassoActive.icon} />
      </button>
      {menu?.kind === 'lasso' && (
        <div ref={menuRef} className="fixed z-[80] w-36 py-0.5 rounded-md shadow-lg bg-surface border border-black/10 dark:border-white/15" style={{ left: menu.x, top: menu.y }}>
          {LASSO_TOOLS.map(({ tool, label, icon }) => (
            <button
              key={tool}
              onClick={() => pickLasso(tool)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left rounded-sm ${
                tool === s.tool
                  ? 'text-sky-700 dark:text-sky-300'
                  : 'text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
              }`}
            >
              <EditorIcon name={icon} size={15} />
              {label}
            </button>
          ))}
        </div>
      )}
      {GROUPS.map(({ tool, label, icon }) => (
        <button
          key={tool}
          title={label}
          onClick={() => setTool(tabId, tool)}
          className={`w-9 h-9 shrink-0 rounded flex items-center justify-center transition-colors ${
            s.tool === tool
              ? 'bg-sky-600 text-white'
              : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100'
          }`}
        >
          <EditorIcon name={icon} />
        </button>
      ))}
      <div className="mt-2 relative w-10 h-10 shrink-0">
        <button
          title="背景色"
          className="absolute right-0 bottom-0 w-[26px] h-[26px] rounded-sm border border-black/30 dark:border-neutral-500"
          style={{ background: rgbaCss(s.state?.background) }}
        />
        <button
          title="前景色"
          className="absolute left-0 top-0 w-[26px] h-[26px] rounded-sm border border-black/40 dark:border-neutral-300 z-10"
          style={{ background: rgbaCss(s.state?.foreground) }}
        />
      </div>
      <div className="flex gap-1 mt-1 shrink-0">
        <button title="切换前/背景色 (X)" onClick={() => onKey('swap')} className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 p-0.5">
          <ArrowLeftRight size={13} />
        </button>
        <button title="默认前/背景色 (D)" onClick={() => onKey('reset')} className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 p-0.5">
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
};
