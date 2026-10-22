/**
 * 图片编辑器画布（C11 Phase 1 最小闭环）。
 *
 * 这一版只做「打开一张图 → 看得见 → 能平移缩放」，不含任何编辑能力。它的价值是
 * 把「Tab 编辑态 → Rust 代理图 → 视图变换」这条骨架跑通，后面加裁剪/调色/文字时
 * 只需要往这条骨架上挂，不必再动管线。
 *
 * 三条既定口径：
 * - **像素不进 WebView**（设计方案 §3.1）：这里拿到的只是 ≤2048px 的代理图，
 *   全分辨率源图始终留在 Rust 侧。所以画布放到 100% 以上会糊——这是设计如此，
 *   状态栏要如实显示「当前看到的是代理」。
 * - **视口复用 comparer**（UI 设计 §2 / §10 L1 桌子层）：`Transform` / `zoomAtPoint` /
 *   `computeFitTransform` 直接跨目录引用，不搬文件、不重写一套。
 * - **与参考模式互斥**：本组件只在 `viewMode === 'editor'` 时挂载，参考模式由
 *   `isCompareMode` 单独门控，两者不会同时在屏上。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { computeFitTransform, Transform, zoomAtPoint } from '../comparer/viewport';

/** 与 `src-tauri/src/editor_commands.rs::EditorPreview` 对应（serde camelCase）。 */
interface EditorPreview {
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  dataUrl: string;
}

interface ImageEditorProps {
  /** 源文件绝对路径；null 表示尚未打开文档（后续「新建空白画布」走这条路） */
  sourcePath: string | null;
  /** Tab 标题用的文档名 */
  documentName: string;
  onClose: () => void;
}

/** 适应窗口时画布四周留白（CSS px），与 comparer 默认值保持一致。 */
const FIT_PADDING = 60;

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;

export const ImageEditor: React.FC<ImageEditorProps> = ({
  sourcePath,
  documentName,
  onClose,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  /** 首次拿到代理图或容器尺寸后自动适应窗口一次；之后不再抢用户的缩放。 */
  const hasFittedRef = useRef(false);
  const draggingRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // ---- 加载代理图 ----
  useEffect(() => {
    if (!sourcePath) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    hasFittedRef.current = false;

    invoke<EditorPreview>('editor_load_preview', { path: sourcePath })
      .then(result => {
        if (cancelled) return;
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

  // ---- 适应窗口 ----
  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || !preview) return;
    const rect = el.getBoundingClientRect();
    const next = computeFitTransform(
      rect.width,
      rect.height,
      { minX: 0, minY: 0, maxX: preview.previewWidth, maxY: preview.previewHeight },
      FIT_PADDING,
      1 // 不放大：小图按 100% 显示，避免「打开就变糊」的错觉
    );
    if (next) setTransform(next);
  }, [preview]);

  useEffect(() => {
    if (preview && !hasFittedRef.current) {
      hasFittedRef.current = true;
      fitToView();
    }
  }, [preview, fitToView]);

  // 容器尺寸变化：仅在还没手动操作过时跟随（编辑到一半拖窗口不该重置视图）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!hasFittedRef.current) fitToView();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToView]);

  // ---- 滚轮缩放（以光标为中心）----
  // 用原生监听而不是 React onWheel：React 的 wheel 监听是 passive 的，
  // preventDefault 会被忽略，导致缩放时整页跟着滚。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setTransform(prev =>
        zoomAtPoint(prev, e.clientX - rect.left, e.clientY - rect.top, factor, MIN_SCALE, MAX_SCALE)
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- 拖拽平移 ----
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
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

  const zoomBy = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTransform(prev =>
      zoomAtPoint(prev, rect.width / 2, rect.height / 2, factor, MIN_SCALE, MAX_SCALE)
    );
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-neutral-100 dark:bg-neutral-900">
      {/* 文档栏：Phase 1 只放只读信息 + 视图操作，保存/导出等在下一步接 */}
      <div className="h-10 shrink-0 flex items-center gap-3 px-3 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate max-w-[40%]">
          {documentName}
        </span>
        {preview && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
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
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={!preview}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-300 w-12 text-center">
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={!preview}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="放大"
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          onClick={fitToView}
          disabled={!preview}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="适应窗口"
        >
          <Maximize2 size={16} />
        </button>
        <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-1" />
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title="关闭编辑器"
        >
          <X size={16} />
        </button>
      </div>

      {/* 画布区 */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
        onDoubleClick={fitToView}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-500">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">正在生成代理图…</span>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <AlertTriangle size={22} className="text-amber-500" />
            <span className="text-sm text-neutral-700 dark:text-neutral-200">无法打开这张图</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400 break-all max-w-lg">
              {error}
            </span>
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
              // 代理图被放大时（scale > 1）用像素化而非模糊插值：让用户一眼看出
              // 「已经超出代理分辨率」，与状态栏的分辨率警告是一回事。
              imageRendering: transform.scale > 1 ? 'pixelated' : 'auto',
              width: preview.previewWidth,
              height: preview.previewHeight,
            }}
          />
        )}
      </div>
    </div>
  );
};
