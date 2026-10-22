/**
 * 图片编辑器（C11 Phase 1）。
 *
 * 布局照 UI 设计 §2：
 *
 * ```
 * ┌────┬──────────────────────────────────────────┐
 * │工具│ 文档栏（文件名 / 尺寸 / 缩放 / 关闭）      │
 * │栏  ├──────────────────────────────────────────┤
 * │    │ 工具选项条                                 │
 * │    ├──────────────────────────────────────────┤
 * │    │ 画布                                       │
 * │    ├──────────────────────────────────────────┤
 * │    │ 状态栏（代理倍率 / 画布尺寸 / 分辨率警告）  │
 * └────┴──────────────────────────────────────────┘
 * ```
 * 右侧的「图层 / 属性 / 颜色」面板由 `RightPanel` 在编辑态切换进来（容器复用）。
 *
 * ## 交互口径：照 Photoshop
 *
 * 用户明确要求「跟 Photoshop 完全一样的操作方式」，所以**滚轮不是缩放**：
 * - 滚轮 = 上下滚动画布；Shift+滚轮 = 左右滚动
 * - **Ctrl/⌘ + 滚轮 = 缩放**（Alt+滚轮同样缩放，PS 两种都认）
 * - 空格按住 = 临时抓手（松开回到原工具）
 * - 缩放工具：单击放大、Alt+单击缩小
 *
 * 这与看图软件（滚轮即缩放）相反，是刻意的。UI 设计 §8.2 同时要求编辑态下
 * 查看器/视频的键位全部失效——本组件自管键盘监听，天然隔离。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { computeFitTransform, Transform, zoomAtPoint } from '../comparer/viewport';
import { isTextEditingTarget } from '../../utils/keyboardTarget';
import type { EditorToolId } from '../../types';
import { EditorToolbar } from './EditorToolbar';
import { EditorOptionsBar } from './EditorOptionsBar';
import { EditorStatusBar } from './EditorStatusBar';
import { EDITOR_SHORTCUT_KEYS } from './editorTools';
import { clearEditorView, setEditorView } from './editorViewStore';
import {
  EditorPreviewMeta,
  peekPreview,
  putPreview,
  subscribePreview,
  takePreview,
} from './editorPreviewCache';

interface ImageEditorProps {
  /** 当前 Tab id：用于按 Tab 缓存编辑器状态 */
  tabId: string;
  /** 源文件绝对路径；null 表示尚未打开文档 */
  sourcePath: string | null;
  /** Tab 标题用的文档名 */
  documentName: string;
  tool: EditorToolId;
  onToolChange: (tool: EditorToolId) => void;
  /**
   * 是否为当前激活的 Tab。
   *
   * 多个编辑器标签会同时挂载（非激活的用 `hidden` 藏起来，但**没有卸载**），
   * 而键盘监听挂在 window 上 —— 不做这个判断，按一次 `V` 会让所有编辑器一起切工具。
   */
  isActive: boolean;
}

const FIT_PADDING = 60;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** 滚轮缩放的每格倍率（PS 的一格约 1.1 倍，手感比 1.25 细腻） */
const WHEEL_ZOOM_STEP = 1.1;
/** 缩放工具单击的倍率 */
const CLICK_ZOOM_STEP = 1.25;

export const ImageEditor: React.FC<ImageEditorProps> = ({
  tabId,
  sourcePath,
  documentName,
  tool,
  onToolChange,
  isActive,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<EditorPreviewMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const hasFittedRef = useRef(false);
  const draggingRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // 空格/Alt 的实时状态要能被事件处理器读到（闭包会捕获旧值），用 ref 同步一份
  const spaceHeldRef = useRef(false);
  const altHeldRef = useRef(false);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // ---- 加载代理图 ----
  useEffect(() => {
    if (!sourcePath) {
      setPreview(null);
      setError(null);
      return;
    }

    const cached = takePreview(sourcePath);
    if (cached) {
      setPreview(cached);
      setError(null);
      setLoading(false);
      hasFittedRef.current = false;
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    hasFittedRef.current = false;

    invoke<EditorPreviewMeta>('editor_load_preview', { path: sourcePath })
      .then(result => {
        if (cancelled) return;
        putPreview(sourcePath, result);
        setPreview(result);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // 缓存被外部刷新时（例如保存回写后 invalidate）跟着更新
  const cachedMeta = useSyncExternalStore(
    subscribePreview,
    () => (sourcePath ? peekPreview(sourcePath) : undefined),
  );
  useEffect(() => {
    if (!cachedMeta) return;
    setPreview(prev => (prev === cachedMeta ? prev : cachedMeta));
  }, [cachedMeta]);

  // ---- 视图 ----
  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || !preview) return;
    const rect = el.getBoundingClientRect();
    const next = computeFitTransform(
      rect.width,
      rect.height,
      { minX: 0, minY: 0, maxX: preview.previewWidth, maxY: preview.previewHeight },
      FIT_PADDING,
      1, // 不放大：小图按 100% 显示
    );
    if (next) setTransform(next);
  }, [preview]);

  const zoomAtCenter = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTransform(prev => zoomAtPoint(prev, rect.width / 2, rect.height / 2, factor, MIN_SCALE, MAX_SCALE));
  }, []);

  const zoomTo = useCallback((target: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTransform(prev => {
      const factor = target / prev.scale;
      return zoomAtPoint(prev, rect.width / 2, rect.height / 2, factor, MIN_SCALE, MAX_SCALE);
    });
  }, []);

  useEffect(() => {
    if (preview && !hasFittedRef.current) {
      hasFittedRef.current = true;
      fitToView();
    }
  }, [preview, fitToView]);

  // ---- 视口尺寸 → 共享给全览图（RightPanel 树里的 Navigator 要画视口框）----
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!preview) return;
    setEditorView(tabId, {
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
      containerWidth: containerSize.w,
      containerHeight: containerSize.h,
      imgWidth: preview.previewWidth,
      imgHeight: preview.previewHeight,
    });
  }, [tabId, preview, transform, containerSize]);

  useEffect(() => () => clearEditorView(tabId), [tabId]);

  // ---- 滚轮：PS 口径（滚轮平移，带修饰键才缩放）----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      // Ctrl/⌘ 或 Alt + 滚轮 = 缩放，以光标为中心
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        setTransform(prev =>
          zoomAtPoint(prev, e.clientX - rect.left, e.clientY - rect.top, factor, MIN_SCALE, MAX_SCALE),
        );
        return;
      }

      // Shift + 滚轮 = 横向滚动（PS 行为）
      if (e.shiftKey) {
        setTransform(prev => ({ ...prev, x: prev.x - e.deltaY }));
        return;
      }

      // 无修饰键 = 滚动画布。deltaX 一并吃掉：触控板的横向手势也归这里
      setTransform(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- 键盘：工具切换 + 空格抓手 ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 只有激活的编辑器标签才吃键盘（多个编辑器会同时挂载）
      if (!isActiveRef.current) return;
      // 输入框/可编辑区域内不抢键（UI 设计 §8.2 的让路规则）
      if (isTextEditingTarget(e.target)) return;

      if (e.code === 'Space') {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        // 必须挡住默认行为：否则按钮获得焦点后空格会触发点击
        e.preventDefault();
        return;
      }
      if (e.key === 'Alt') {
        altHeldRef.current = true;
        setAltHeld(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+0 / Ctrl+1 等后续再接

      const next = EDITOR_SHORTCUT_KEYS[e.key.toLowerCase()];
      if (next) {
        onToolChange(next);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
      if (e.key === 'Alt') {
        altHeldRef.current = false;
        setAltHeld(false);
      }
    };
    // 窗口失焦时复位：否则「按住空格切走」会永久卡在抓手
    const onBlur = () => {
      spaceHeldRef.current = false;
      altHeldRef.current = false;
      setSpaceHeld(false);
      setAltHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onToolChange]);

  // ---- 鼠标：按工具分派 ----
  const effectiveTool: EditorToolId = spaceHeld ? 'hand' : tool;

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;

    // 缩放工具：单击放大，Alt+单击缩小（PS 行为）
    if (effectiveTool === 'zoom') {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const factor = altHeldRef.current ? 1 / CLICK_ZOOM_STEP : CLICK_ZOOM_STEP;
      setTransform(prev =>
        zoomAtPoint(prev, e.clientX - rect.left, e.clientY - rect.top, factor, MIN_SCALE, MAX_SCALE),
      );
      return;
    }

    // 抓手 / 移动：拖动平移。裁剪与未接入工具暂不响应拖动
    if (effectiveTool !== 'hand' && effectiveTool !== 'move') return;

    draggingRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    const onMove = (ev: MouseEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      setTransform(prev => ({
        ...prev,
        x: d.originX + (ev.clientX - d.startX),
        y: d.originY + (ev.clientY - d.startY),
      }));
    };
    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const cursor = spaceHeld
    ? draggingRef.current
      ? 'grabbing'
      : 'grab'
    : effectiveTool === 'zoom'
      ? altHeld
        ? 'zoom-out'
        : 'zoom-in'
      : effectiveTool === 'crop'
        ? 'crosshair'
        : effectiveTool === 'hand'
          ? 'grab'
          : 'default';

  return (
    <div className="w-full h-full flex overflow-hidden bg-neutral-100 dark:bg-neutral-900">
      <EditorToolbar activeTool={tool} onSelect={onToolChange} disabled={!sourcePath} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* 文档栏 */}
        <div className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none">
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate max-w-[38%]">
            {documentName}
          </span>
          {preview && (
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400 shrink-0 tabular-nums">
              {preview.width}×{preview.height}
              {preview.previewWidth !== preview.width && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  代理 {preview.previewWidth}×{preview.previewHeight}
                </span>
              )}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => zoomAtCenter(1 / CLICK_ZOOM_STEP)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="缩小"
          >
            <ZoomOut size={15} />
          </button>
          <span className="text-[11px] tabular-nums text-neutral-600 dark:text-neutral-300 w-11 text-center">
            {Math.round(transform.scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => zoomAtCenter(CLICK_ZOOM_STEP)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="放大"
          >
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
            onClick={fitToView}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            // 与画布工具栏的「查看全部」同一个图标、同一个语义
            title="查看全部"
          >
            <Scan size={15} />
          </button>
        </div>

        {/* 工具选项条 */}
        <EditorOptionsBar tool={tool} scale={transform.scale} onZoomTo={zoomTo} onFit={fitToView} />

        {/* 画布 */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          style={{ cursor }}
          onMouseDown={onMouseDown}
          onDoubleClick={fitToView}
        >
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-500 pointer-events-none">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">正在生成代理图…</span>
            </div>
          )}

          {error && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center pointer-events-none">
              <AlertTriangle size={22} className="text-amber-500" />
              <span className="text-sm text-neutral-700 dark:text-neutral-200">无法打开这张图</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400 break-all max-w-lg">{error}</span>
            </div>
          )}

          {preview && !error && (
            <img
              src={preview.dataUrl}
              alt={documentName}
              draggable={false}
              className="absolute left-0 top-0 origin-top-left select-none"
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                // 放大超过 100% 用像素化：让「已经超出代理分辨率」一眼可见
                imageRendering: transform.scale > 1 ? 'pixelated' : 'auto',
                width: preview.previewWidth,
                height: preview.previewHeight,
                // Tailwind preflight 给所有 img 设了 `max-width:100%; height:auto`。
                // 这里宽度/高度是布局尺寸，必须把 max-* 顶回去，否则宽被容器压小、
                // 高不变 —— 3440×1440 的图会被压成近正方形。
                maxWidth: 'none',
                maxHeight: 'none',
              }}
            />
          )}
        </div>

        {/* 状态栏 */}
        <EditorStatusBar
          tool={tool}
          scale={transform.scale}
          width={preview?.width ?? 0}
          height={preview?.height ?? 0}
          previewWidth={preview?.previewWidth ?? 0}
          previewHeight={preview?.previewHeight ?? 0}
          spaceHeld={spaceHeld}
        />
      </div>
    </div>
  );
};
