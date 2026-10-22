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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  FileOutput,
  FlipHorizontal2,
  FlipVertical2,
  Loader2,
  RotateCcw,
  RotateCw,
  Scan,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { computeFitTransform, Transform, zoomAtPoint } from '../comparer/viewport';
import { isTextEditingTarget } from '../../utils/keyboardTarget';
import type { EditorToolId, EditorTransform } from '../../types';
import { EditorToolbar } from './EditorToolbar';
import { EditorOptionsBar } from './EditorOptionsBar';
import { EditorStatusBar } from './EditorStatusBar';
import { CropOverlay, CropArea } from './CropOverlay';
import { flipCropRect, rotateCropRect } from './cropGeometry';
import { buildAdjustMatrix, isZeroAdjustments, toFeColorMatrixValues } from './colorMatrix';
import { EDITOR_SHORTCUT_KEYS } from './editorTools';
import { clearEditorView, peekPanRequest, setEditorView, subscribeEditorView } from './editorViewStore';
import {
  buildPreviewKey,
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
  /** 已应用的几何变换（裁剪 / 旋转 / 翻转）；字段缺省 = 未设置 */
  docTransform?: EditorTransform;
  /** 变换变化后回报；调用方负责写进 TabState.editorDocument 并置 dirty */
  onDocTransformChange: (next: EditorTransform) => void;
  /**
   * 导出成功后回调：调用方应重扫导出的目标文件夹，让新文件进库并出现在网格里。
   *
   * 返回 Promise 时编辑器会等它完成再更新提示文案 —— 用户能亲眼看到
   * 「画廊已刷新」，而不是猜刷新有没有发生。
   *
   * 不在这里直接调 `scan_file`：单文件扫描只返回节点、**不写数据库**，
   * 网格的数据源是 `state.files`（来自扫描 + 库），单插一个节点会和库对不上。
   * 走文件夹重扫是项目里已经验证过的路径。
   */
  onFileCreated?: (targetPath: string) => void | Promise<void>;
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
  docTransform,
  onDocTransformChange,
  onFileCreated,
}) => {
  // 拆成原始值：对象每次渲染都是新引用，直接进依赖数组会让 effect 反复触发
  const docCrop = docTransform?.crop;
  const docRotation = docTransform?.rotation ?? 0;
  const docFlipH = docTransform?.flipH ?? false;
  const docFlipV = docTransform?.flipV ?? false;
  const docAdjust = docTransform?.adjust;

  // ---- 调色预览 ----
  // 预览走浏览器原生 SVG feColorMatrix（GPU，拖动零延迟），导出走 Rust 逐像素。
  // 两端用同一套矩阵公式（见 colorMatrix.ts 顶部注释），矩阵值由单测锁死。
  const adjustFilterId = `aurora-editor-adjust-${tabId}`;
  const hasAdjust = !isZeroAdjustments(docAdjust);
  const adjustValues = useMemo(
    () => toFeColorMatrixValues(buildAdjustMatrix(docAdjust)),
    [docAdjust],
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<EditorPreviewMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  /** 裁剪框（当前文档坐标，源图单位）。null = 不在裁剪态 */
  const [cropRect, setCropRect] = useState<CropArea | null>(null);
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
  // 缓存键含全部几何变换：同一文件的「裁过/没裁过」「转过/没转过」是不同的图。
  const cacheKey = sourcePath
    ? buildPreviewKey(sourcePath, {
        crop: docCrop,
        rotation: docRotation,
        flipH: docFlipH,
        flipV: docFlipV,
      })
    : null;

  useEffect(() => {
    if (!sourcePath || !cacheKey) {
      setPreview(null);
      setError(null);
      return;
    }

    const cached = takePreview(cacheKey);
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

    // cacheKey 已经涵盖全部变换字段，所以依赖里不必再放对象
    // （每次都新建对象会让依赖恒变，导致无谓的重新加载）
    const hasTransform = Boolean(docCrop || docRotation || docFlipH || docFlipV);
    const request = hasTransform
      ? invoke<EditorPreviewMeta>('editor_render_preview', {
          path: sourcePath,
          crop: docCrop ?? null,
          rotation: docRotation,
          flipH: docFlipH,
          flipV: docFlipV,
        })
      : invoke<EditorPreviewMeta>('editor_load_preview', { path: sourcePath });

    request
      .then(result => {
        if (cancelled) return;
        putPreview(cacheKey, result);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, sourcePath]);

  // 缓存被外部刷新时（例如保存回写后 invalidate）跟着更新
  const cachedMeta = useSyncExternalStore(
    subscribePreview,
    () => (cacheKey ? peekPreview(cacheKey) : undefined),
  );
  useEffect(() => {
    if (!cachedMeta) return;
    setPreview(prev => (prev === cachedMeta ? prev : cachedMeta));
  }, [cachedMeta]);

  // ---- 裁剪 ----
  // 进入裁剪工具时框复位为整图（PS 里点裁剪工具显示的就是整图框）
  useEffect(() => {
    if (tool !== 'crop' || !preview) {
      setCropRect(null);
      return;
    }
    setCropRect({ x: 0, y: 0, w: preview.width, h: preview.height });
  }, [tool, preview]);

  /** 裁剪宽高比（w/h）；null = 自由裁剪 */
  const [cropRatio, setCropRatio] = useState<number | null>(null);

  // 切换比例：把现有框就地调成该比例（以当前框中心为锚，尽量保住已有大小）。
  // 不重新生成整图框——用户已经摆好的位置不该因为点了个比例就跳走。
  const handleCropRatioChange = useCallback(
    (ratio: number | null) => {
      setCropRatio(ratio);
      if (!ratio) return;
      setCropRect(prev => {
        if (!prev || !preview || preview.height === 0) return prev;
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        let w = prev.w;
        let h = w / ratio;
        if (h > preview.height) {
          h = preview.height;
          w = h * ratio;
        }
        if (w > preview.width) {
          w = preview.width;
          h = w / ratio;
        }
        const x = Math.min(Math.max(cx - w / 2, 0), Math.max(0, preview.width - w));
        const y = Math.min(Math.max(cy - h / 2, 0), Math.max(0, preview.height - h));
        return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      });
    },
    [preview],
  );

  const commitCrop = useCallback(() => {
    if (!cropRect || !preview) return;
    const w = Math.round(cropRect.w);
    const h = Math.round(cropRect.h);
    if (w < 1 || h < 1) return;
    // 框的坐标是相对**当前文档**的，要叠到已有裁剪的原点才能得到绝对坐标。
    // 后端永远只对原图处理一次，所以连裁多刀不会累积重编码损失。
    onDocTransformChange({
      crop: {
        x: Math.round((docCrop?.x ?? 0) + cropRect.x),
        y: Math.round((docCrop?.y ?? 0) + cropRect.y),
        w,
        h,
      },
      rotation: docRotation,
      flipH: docFlipH,
      flipV: docFlipV,
      // 几何变换不能顺手把调色丢掉——用户调完色再裁一刀不该回到原色
      adjust: docAdjust,
    });
    onToolChange('move');
  }, [
    cropRect,
    preview,
    docCrop,
    docRotation,
    docFlipH,
    docFlipV,
    onDocTransformChange,
    onToolChange,
    docAdjust,
  ]);

  const cancelCrop = useCallback(() => {
    onToolChange('move');
  }, [onToolChange]);

  // ---- 旋转 / 翻转 ----
  // crop 是「当前可见坐标系」里的矩形，旋转后坐标系跟着转，所以矩形必须一起换算，
  // 否则用户会发现自己裁的那块区域在旋转之后变成了画面里别的地方。
  // 换算用的 currentWidth/Height 是 **frame**（裁剪之前的画框），不是 preview 尺寸。
  const handleRotate = useCallback(
    (clockwise: boolean) => {
      if (!preview) return;
      const nextCrop = docCrop
        ? rotateCropRect(docCrop, preview.frameWidth, preview.frameHeight, clockwise)
        : undefined;
      const nextRotation = (((docRotation + (clockwise ? 90 : 270)) % 360) + 360) % 360;
      onDocTransformChange({
        crop: nextCrop,
        rotation: nextRotation,
        flipH: docFlipH,
        flipV: docFlipV,
        adjust: docAdjust,
      });
    },
    [preview, docCrop, docRotation, docFlipH, docFlipV, docAdjust, onDocTransformChange],
  );

  const handleFlip = useCallback(
    (horizontal: boolean) => {
      if (!preview) return;
      const nextCrop = docCrop
        ? flipCropRect(docCrop, preview.frameWidth, preview.frameHeight, horizontal, !horizontal)
        : undefined;
      onDocTransformChange({
        crop: nextCrop,
        rotation: docRotation,
        flipH: horizontal ? !docFlipH : docFlipH,
        flipV: horizontal ? docFlipV : !docFlipV,
        adjust: docAdjust,
      });
    },
    [preview, docCrop, docRotation, docFlipH, docFlipV, docAdjust, onDocTransformChange],
  );

  // 键盘监听只依赖 onToolChange，不跟着 cropRect 每次变化重绑 → 用 ref 取最新实现
  const commitCropRef = useRef(commitCrop);
  commitCropRef.current = commitCrop;
  const cancelCropRef = useRef(cancelCrop);
  cancelCropRef.current = cancelCrop;

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

  // ---- 全览图发来的导航请求：把指定点移到视口中央 ----
  const panRequest = useSyncExternalStore(subscribeEditorView, () => peekPanRequest(tabId));
  const lastPanNonceRef = useRef(0);
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

  /** 导出状态（按钮旁的即时反馈，不弹窗） */
  const [exportState, setExportState] = useState<{
    status: 'idle' | 'working' | 'done' | 'error';
    text?: string;
  }>({ status: 'idle' });

  // ---- 导出成品 ----
  // 与「保存 .aurora 工程文件」是两件事：这个只出图，不可再编辑。
  const handleExport = useCallback(async () => {
    if (!sourcePath) return;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      // 默认落在原文件旁边，命名 `<原名>_编辑.<ext>`，不动原图
      const sepIdx = Math.max(sourcePath.lastIndexOf('\\'), sourcePath.lastIndexOf('/'));
      const sep = sepIdx >= 0 ? sourcePath[sepIdx] : '\\';
      const dir = sepIdx >= 0 ? sourcePath.slice(0, sepIdx) : '';
      const base = sourcePath.slice(sepIdx + 1).replace(/\.[^.]+$/, '');

      const target = await save({
        filters: [
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
          { name: 'WebP（无损）', extensions: ['webp'] },
        ],
        defaultPath: `${dir}${sep}${base}_编辑.png`,
      });
      if (!target) return; // 用户取消

      setExportState({ status: 'working' });
      const res = await invoke<{ path: string; width: number; height: number; bytes: number }>(
        'editor_export_image',
        {
          path: sourcePath,
          crop: docCrop ?? null,
          targetPath: target,
          // 与预览严格同一套变换，否则会「看到转过的、导出没转的」
          rotation: docRotation,
          flipH: docFlipH,
          flipV: docFlipV,
          adjust: docAdjust ?? null,
        },
      );
      // 让画廊立刻能看见这张新图（否则退出编辑器后网格里没有它）。
      // 等它完成再改文案：刷新失败/还在跑时不会谎报"已刷新"。
      try {
        await onFileCreated?.(target);
        setExportState({
          status: 'done',
          text: `已导出 ${res.width}×${res.height}（${Math.round(res.bytes / 1024)} KB）· 画廊已刷新`,
        });
      } catch (refreshErr) {
        setExportState({
          status: 'done',
          text: `已导出 ${res.width}×${res.height}（${Math.round(res.bytes / 1024)} KB）· 刷新失败，请手动刷新`,
        });
        console.error('[editor] 导出后刷新画廊失败', refreshErr);
      }
      setTimeout(() => setExportState({ status: 'idle' }), 5000);
    } catch (e) {
      setExportState({ status: 'error', text: String(e) });
      setTimeout(() => setExportState({ status: 'idle' }), 6000);
    }
  }, [sourcePath, docCrop, docRotation, docFlipH, docFlipV, docAdjust, onFileCreated]);

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

      // 裁剪：Enter 确认 / Esc 取消（PS 行为）
      if (toolRef.current === 'crop') {
        if (e.key === 'Enter') {
          commitCropRef.current();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          cancelCropRef.current();
          e.preventDefault();
          return;
        }
      }

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

    // 只有抓手平移视图。**移动工具不平移**——它该移的是图层内容，
    // 而 Phase 1 只有单张背景层、铺满画布，没有可移的东西。
    // PS 里这种情况背景层是锁定的，拖动无效果；做成"退化成抓手"反而让人分不清
    // 两个工具的区别（用户实测反馈「移动工具跟抓手一样」）。
    if (effectiveTool !== 'hand') return;

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
      {/*
        调色滤镜定义。`colorInterpolationFilters="sRGB"` 不能省：SVG 默认在
        linearRGB 空间做矩阵运算，而 Rust 侧是直接在 sRGB 字节上算的 —— 不显式指定
        会让对比度/饱和度的观感与导出结果明显不同（尤其暗部）。
      */}
      <svg className="absolute w-0 h-0 pointer-events-none" aria-hidden="true">
        <filter id={adjustFilterId} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={adjustValues} />
        </filter>
      </svg>

      <EditorToolbar
        // 按住空格时抓手临时接管：工具栏上抓手高亮（PS 行为），但 Tab 记录的工具不变
        activeTool={spaceHeld ? 'hand' : tool}
        onSelect={onToolChange}
        disabled={!sourcePath}
      />

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
          {exportState.status === 'done' && (
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0">
              {exportState.text}
            </span>
          )}
          {exportState.status === 'error' && (
            <span
              className="text-[11px] text-red-500 shrink-0 max-w-[22rem] truncate"
              title={exportState.text}
            >
              {exportState.text}
            </span>
          )}
          <div className="flex-1" />
          {/* 旋转 / 翻转：与裁剪同属几何变换，都只改文档状态，导出时由 Rust 在
              原图上一次性套用（不会因为连点几次而累积重编码损失） */}
          <button
            type="button"
            onClick={() => handleRotate(false)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="逆时针旋转 90°"
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleRotate(true)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="顺时针旋转 90°"
          >
            <RotateCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFlip(true)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="水平翻转"
          >
            <FlipHorizontal2 size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFlip(false)}
            disabled={!preview}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="垂直翻转"
          >
            <FlipVertical2 size={15} />
          </button>
          <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
          <button
            type="button"
            onClick={handleExport}
            disabled={!preview || exportState.status === 'working'}
            className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
            title="导出为图片（PNG / JPEG / WebP）"
          >
            {exportState.status === 'working' ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              // FileOutput 而不是 Download：这是「把文档导出成图片」，不是从网上下载
              <FileOutput size={15} />
            )}
          </button>
          <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
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
        <EditorOptionsBar
          // 与工具栏一致：空格按住时切到抓手（PS 里选项条也会跟着变）
          tool={spaceHeld ? 'hand' : tool}
          scale={transform.scale}
          onZoomTo={zoomTo}
          onFit={fitToView}
          cropRect={cropRect}
          onCropCommit={commitCrop}
          onCropCancel={cancelCrop}
          cropRatio={cropRatio}
          docAspect={preview && preview.height > 0 ? preview.width / preview.height : undefined}
          onCropRatioChange={handleCropRatioChange}
        />

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
                // 调色预览：SVG feColorMatrix，参数全 0 时不出滤镜层
                filter: hasAdjust ? `url(#${adjustFilterId})` : undefined,
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
          {preview && !error && tool === 'crop' && (
            <CropOverlay
              docWidth={preview.width}
              docHeight={preview.height}
              // 代理图 / 源图 的比例：裁剪框以源图坐标为准，显示时按它投影到屏幕
              proxyScale={preview.width > 0 ? preview.previewWidth / preview.width : 1}
              transform={transform}
              rect={cropRect}
              aspectRatio={cropRatio}
              onChange={setCropRect}
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
