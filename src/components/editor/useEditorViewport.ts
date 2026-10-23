/**
 * 编辑器的视口：平移、缩放、适应窗口、抓手拖拽，以及与全览图（Navigator）的联动。
 *
 * 交互口径照 Photoshop（用户拍板，与看图软件相反）：
 * - 滚轮 = 上下滚动画布；Shift+滚轮 = 左右滚动
 * - **Ctrl/⌘ + 滚轮 = 缩放**（Alt+滚轮同样缩放，PS 两种都认）
 * - 空格按住 = 临时抓手（按键状态在 `useEditorKeyboard`，这里消费）
 * - 缩放工具：单击放大、Alt+单击缩小
 *
 * 视口尺寸还会同步到 `editorViewStore`（全览图用它算视口框），全览图发来的
 * 导航请求（把某点移到视口中央）也在这里落地。
 *
 * 搬出 ImageEditor（2026-10-24 防膨胀批次 B，见进度文档 §7）。
 */
import {
  Dispatch,
  RefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { EditorCanvas, EditorToolId } from '../../types';
import { computeFitTransform, Transform, zoomAtPoint } from '../comparer/viewport';
import {
  clearEditorView,
  peekPanRequest,
  setEditorView,
  subscribeEditorView,
} from './editorViewStore';

const FIT_PADDING = 60;
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;
/** 滚轮缩放的每格倍率（PS 的一格约 1.1 倍，手感比 1.25 细腻） */
export const WHEEL_ZOOM_STEP = 1.1;
/** 缩放工具单击的倍率 */
export const CLICK_ZOOM_STEP = 1.25;

export function useEditorViewport(opts: { tabId: string; canvas: EditorCanvas | undefined }) {
  const { tabId, canvas } = opts;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const hasFittedRef = useRef(false);
  const draggingRef = useRef<
    { startX: number; startY: number; originX: number; originY: number } | null
  >(null);
  const lastPanNonceRef = useRef(0);

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || !canvas) return;
    const rect = el.getBoundingClientRect();
    const next = computeFitTransform(
      rect.width,
      rect.height,
      { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height },
      FIT_PADDING,
      1, // 不放大：小图按 100% 显示
    );
    if (next) setTransform(next);
  }, [canvas]);

  const zoomAtCenter = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTransform(prev =>
      zoomAtPoint(prev, rect.width / 2, rect.height / 2, factor, MIN_SCALE, MAX_SCALE),
    );
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

  // 画布尺寸变了（裁剪 / 旋转）要重新适应窗口
  useEffect(() => {
    hasFittedRef.current = false;
  }, [canvas?.width, canvas?.height]);

  useEffect(() => {
    if (canvas && !hasFittedRef.current) {
      hasFittedRef.current = true;
      fitToView();
    }
  }, [canvas, fitToView]);

  // ---- 视口尺寸 → 共享给全览图 ----
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
    if (!canvas) return;
    setEditorView(tabId, {
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
      containerWidth: containerSize.w,
      containerHeight: containerSize.h,
      imgWidth: canvas.width,
      imgHeight: canvas.height,
    });
  }, [tabId, canvas, transform, containerSize]);

  useEffect(() => () => clearEditorView(tabId), [tabId]);

  // ---- 全览图发来的导航请求：把指定点移到视口中央 ----
  const panRequest = useSyncExternalStore(subscribeEditorView, () => peekPanRequest(tabId));
  useEffect(() => {
    if (!panRequest || panRequest.nonce === lastPanNonceRef.current) return;
    lastPanNonceRef.current = panRequest.nonce;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTransform(prev => ({
      ...prev,
      x: rect.width / 2 - panRequest.imgX * prev.scale,
      y: rect.height / 2 - panRequest.imgY * prev.scale,
    }));
  }, [panRequest]);

  // ---- 滚轮：PS 口径（滚轮平移，带修饰键才缩放）----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        setTransform(prev =>
          zoomAtPoint(prev, e.clientX - rect.left, e.clientY - rect.top, factor, MIN_SCALE, MAX_SCALE),
        );
        return;
      }
      if (e.shiftKey) {
        setTransform(prev => ({ ...prev, x: prev.x - e.deltaY }));
        return;
      }
      setTransform(prev => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * 画布 onMouseDown 的**视口部分**：缩放工具单击、抓手拖拽。
   * 返回 true 表示这颗按键已被视口消费，调用方不用再管；
   * 移动工具的图层命中测试留在 ImageEditor（它操作的是文档，不是视口）。
   */
  const handleViewportMouseDown = useCallback(
    (
      e: React.MouseEvent,
      effectiveTool: EditorToolId | null,
      altHeldRef: RefObject<boolean>,
    ): boolean => {
      if (e.button !== 0) return true; // 非左键：两边都不处理

      if (effectiveTool === 'zoom') {
        const el = containerRef.current;
        if (!el) return true;
        const rect = el.getBoundingClientRect();
        const factor = altHeldRef.current ? 1 / CLICK_ZOOM_STEP : CLICK_ZOOM_STEP;
        setTransform(prev =>
          zoomAtPoint(prev, e.clientX - rect.left, e.clientY - rect.top, factor, MIN_SCALE, MAX_SCALE),
        );
        return true;
      }

      if (effectiveTool !== 'hand') return false;

      // 只有抓手平移视图。移动工具留给自由变形——它该移的是**图层**，不是视口。
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
      return true;
    },
    [transform],
  );

  return {
    containerRef,
    transform,
    setTransform: setTransform as Dispatch<SetStateAction<Transform>>,
    containerSize,
    fitToView,
    zoomAtCenter,
    zoomTo,
    draggingRef,
    handleViewportMouseDown,
  };
}
