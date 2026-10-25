/**
 * 工具栏(左侧竖排):工具组按钮 + 前/背景色芯片。
 * 工具组子形态(photocraft 上游口径):同组共享一个槽位与快捷键,组内最近使用的
 * 形态显示为图标;**右键工具图标**弹出子形态菜单(选框组=矩形/椭圆)。
 * 长按弹层、更多组(套索族/模糊族)随 M2 后续切片接入。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Move, BoxSelect, CircleDashed, Lasso, Crop, Pipette, Brush, Eraser, Blend, PaintBucket,
  Droplet, Sparkles, Fingerprint, Hand, ZoomIn, ArrowLeftRight, RotateCcw, MoveHorizontal, MoveVertical,
} from 'lucide-react';
import type { EditorTool } from './editorTypes';
import { getSession, setOptions, setTool, subscribeSession, runCommand } from './editorStore';
import { nextMarqueeShape } from './toolLogic';

/** 选框组子形态(M 键组内循环,PS 口径四形态)。 */
const MARQUEE_SHAPES: { shape: 'rect' | 'ellipse' | 'row' | 'column'; label: string; icon: React.ReactNode }[] = [
  { shape: 'rect', label: '矩形选框 (M)', icon: <BoxSelect size={17} /> },
  { shape: 'ellipse', label: '椭圆选框 (M)', icon: <CircleDashed size={17} /> },
  { shape: 'row', label: '单行选框 (M)', icon: <MoveHorizontal size={17} /> },
  { shape: 'column', label: '单列选框 (M)', icon: <MoveVertical size={17} /> },
];

const GROUPS: { tool: EditorTool; label: string; icon: React.ReactNode }[] = [
  { tool: 'move', label: '移动 (V)', icon: <Move size={17} /> },
  { tool: 'lasso', label: '套索 (L)', icon: <Lasso size={17} /> },
  { tool: 'crop', label: '裁剪 (C)', icon: <Crop size={17} /> },
  { tool: 'eyedropper', label: '吸管 (I)', icon: <Pipette size={17} /> },
  { tool: 'brush', label: '画笔 (B)', icon: <Brush size={17} /> },
  { tool: 'eraser', label: '橡皮擦 (E)', icon: <Eraser size={17} /> },
  { tool: 'gradient', label: '渐变 (G)', icon: <Blend size={17} /> },
  { tool: 'bucket', label: '油漆桶 (K)', icon: <PaintBucket size={17} /> },
  { tool: 'blur', label: '模糊 (R)', icon: <Droplet size={17} /> },
  { tool: 'sharpen', label: '锐化 (U)', icon: <Sparkles size={17} /> },
  { tool: 'smudge', label: '涂抹 (S)', icon: <Fingerprint size={17} /> },
  { tool: 'hand', label: '抓手 (H)', icon: <Hand size={17} /> },
  { tool: 'zoom', label: '缩放 (Z)', icon: <ZoomIn size={17} /> },
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
  /** 子形态弹层位置(屏幕坐标;fixed 定位,不被工具栏 overflow 裁剪/被画布盖住)。 */
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 长按弹层(上游 0.35s 口径):计时器 + "本次长按已开弹层"标记(抑制定击的选工具)。 */
  const pressTimer = useRef<number | null>(null);
  const pressPosRef = useRef({ x: 0, y: 0 });
  const pressOpenedRef = useRef(false);

  // 点菜单外关闭子形态弹层
  useEffect(() => {
    if (!menuPos) return undefined;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuPos(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuPos]);

  if (!s) return null;

  const onKey = (which: 'swap' | 'reset') => {
    void runCommand(tabId, which === 'swap' ? 'tools.swapColors' : 'tools.defaultColors', {}).catch(console.error);
  };

  const marqueeShape = s.options.marqueeShape;
  const marqueeIcon = MARQUEE_SHAPES.find((m) => m.shape === marqueeShape)?.icon ?? <BoxSelect size={17} />;
  const shapeLabel = MARQUEE_SHAPES.find((m) => m.shape === marqueeShape)?.label ?? '矩形选框 (M)';
  const pickMarquee = (shape: 'rect' | 'ellipse' | 'row' | 'column') => {
    setOptions(tabId, { marqueeShape: shape });
    setTool(tabId, 'marquee');
    setMenuPos(null);
  };
  /** 长按 0.35s 开弹层(上游 panels.rs 口径);短按仍走 onClick 选工具。 */
  const startMarqueePress = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pressPosRef.current = { x: r.right + 4, y: r.top };
    pressOpenedRef.current = false;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      pressOpenedRef.current = true;
      setMenuPos(pressPosRef.current);
    }, 350);
  };
  const endMarqueePress = () => {
    if (pressTimer.current != null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <div className="w-11 shrink-0 flex flex-col items-center gap-0.5 py-1.5 bg-panel border-r border-black/10 dark:border-white/10 select-none overflow-y-auto">
      <button
        key="marquee"
        title={`${shapeLabel} — 右键/长按切换形状`}
        onClick={() => {
          // 长按刚开的弹层,这次释放不重复选工具
          if (pressOpenedRef.current) {
            pressOpenedRef.current = false;
            return;
          }
          setTool(tabId, 'marquee');
        }}
        onPointerDown={startMarqueePress}
        onPointerUp={endMarqueePress}
        onPointerLeave={endMarqueePress}
        onContextMenu={(e) => {
          e.preventDefault();
          endMarqueePress();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenuPos({ x: r.right + 4, y: r.top });
        }}
        onDoubleClick={() => {
          // 双击=循环到下一形态(长按弹层之外的快速切换)
          setOptions(tabId, { marqueeShape: nextMarqueeShape(marqueeShape) });
        }}
        className={`w-9 h-9 shrink-0 rounded flex items-center justify-center transition-colors ${
          s.tool === 'marquee'
            ? 'bg-sky-600 text-white'
            : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {marqueeIcon}
      </button>
      {menuPos && (
        <div ref={menuRef} className="fixed z-[80] w-36 py-0.5 rounded-md shadow-lg bg-surface border border-black/10 dark:border-white/15" style={{ left: menuPos.x, top: menuPos.y }}>
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
              {icon}
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
          {icon}
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
